/**
 * WCAG AA/AAA Contrast Checker — Figma plugin main thread.
 * Resolves solid fills (including variable bindings) from the selection
 * and posts resolved RGB + token/style labels to the UI.
 */

type ContrastRGB = { r: number; g: number; b: number };

type ColorSource = {
  rgb: ContrastRGB;
  /** Variable name when paint is bound; otherwise null. */
  token: string | null;
  /** Paint style name when fillStyleId is set; otherwise null. */
  style: string | null;
  /** Designer-facing origin, e.g. layer name. */
  from: string;
};

type SelectionPayload = {
  type: 'selection';
  foreground: ColorSource | null;
  background: ColorSource | null;
  fontSize: number | null;
  fontWeight: number | null;
  isLargeText: boolean | null;
  nodeName: string | null;
  message: string;
};

type UiToPluginMessage =
  | { type: 'request-selection' }
  | { type: 'close' }
  | { type: 'resize'; width: number; height: number }
  | { type: 'apply-color'; role: 'foreground' | 'background'; color: ContrastRGB }
  | { type: 'apply-colors'; foreground: ContrastRGB; background: ContrastRGB };

type ColorTargets = {
  foregroundId: string | null;
  backgroundId: string | null;
};

const UI_WIDTH = 360;
const UI_HEIGHT = 700;
const CANVAS_WHITE: ContrastRGB = { r: 1, g: 1, b: 1 };

/** Ignore stale async selection resolves when the user clicks quickly. */
let selectionEpoch = 0;

/** Nodes that FG/BG pickers write back into (updated on each selection analyze). */
let colorTargets: ColorTargets = { foregroundId: null, backgroundId: null };

figma.showUI(__html__, { width: UI_WIDTH, height: UI_HEIGHT, themeColors: true });

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function compositeOver(fg: ContrastRGB, alpha: number, bg: ContrastRGB): ContrastRGB {
  const a = clamp01(alpha);
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
  };
}

function topSolidPaint(paints: ReadonlyArray<Paint> | PluginAPI['mixed']): SolidPaint | null {
  if (paints === figma.mixed || !Array.isArray(paints)) return null;
  for (let i = paints.length - 1; i >= 0; i--) {
    const paint = paints[i];
    if (paint.visible === false) continue;
    if (paint.type !== 'SOLID') continue;
    if ((paint.opacity ?? 1) <= 0) continue;
    return paint;
  }
  return null;
}

function getNodeFills(node: SceneNode): ReadonlyArray<Paint> | PluginAPI['mixed'] | null {
  if (!('fills' in node)) return null;
  return (node as GeometryMixin).fills;
}

function getNodeOpacity(node: BaseNode): number {
  if ('opacity' in node) return clamp01((node as BlendMixin).opacity);
  return 1;
}

/** Effective opacity of `node` including ancestor BlendMixin opacities (stops at PAGE). */
function effectiveOpacity(node: SceneNode): number {
  let opacity = 1;
  let current: BaseNode | null = node;
  while (current && current.type !== 'PAGE' && current.type !== 'DOCUMENT') {
    opacity *= getNodeOpacity(current);
    if (opacity <= 0) return 0;
    current = current.parent;
  }
  return clamp01(opacity);
}

async function resolvePaintToken(paint: SolidPaint): Promise<string | null> {
  const alias = paint.boundVariables?.color;
  if (!alias) return null;
  try {
    const variable = await figma.variables.getVariableByIdAsync(alias.id);
    return variable ? variable.name : null;
  } catch {
    return null;
  }
}

async function resolveFillStyleName(node: SceneNode): Promise<string | null> {
  if (!('fillStyleId' in node)) return null;
  const styleId = (node as GeometryMixin).fillStyleId;
  if (!styleId || styleId === figma.mixed || styleId === '') return null;
  try {
    const style = await figma.getStyleByIdAsync(styleId);
    return style ? style.name : null;
  } catch {
    return null;
  }
}

type StackLayer = {
  paint: SolidPaint;
  /** Combined paint.opacity * node.opacity for this layer only (not ancestors). */
  alpha: number;
  from: string;
};

type BackgroundResolve = ColorSource & { nodeId: string | null };

/**
 * Collect solid fills from parents (nearest → farthest), stopping early at a fully opaque layer.
 * Then composite farthest → nearest over the canvas.
 */
async function resolveBackground(node: SceneNode): Promise<BackgroundResolve> {
  const layers: Array<StackLayer & { nodeId: string }> = [];
  let current: BaseNode | null = node.parent;

  while (current && current.type !== 'PAGE' && current.type !== 'DOCUMENT') {
    if ('fills' in current) {
      const paint = topSolidPaint((current as GeometryMixin).fills);
      if (paint) {
        const alpha = clamp01((paint.opacity ?? 1) * getNodeOpacity(current));
        if (alpha > 0) {
          layers.push({ paint, alpha, from: current.name, nodeId: current.id });
          if (alpha >= 1) break;
        }
      }
    }
    current = current.parent;
  }

  let rgb = CANVAS_WHITE;
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    rgb = compositeOver(layer.paint.color, layer.alpha, rgb);
  }

  if (layers.length === 0) {
    return { rgb, token: null, style: null, from: 'canvas', nodeId: null };
  }

  const nearest = layers[0];
  const token = await resolvePaintToken(nearest.paint);
  const nearestNode = await figma.getNodeByIdAsync(nearest.nodeId);
  const style =
    nearestNode && 'fills' in nearestNode
      ? await resolveFillStyleName(nearestNode as SceneNode)
      : null;

  const composited = nearest.alpha < 1 || layers.length > 1;
  return {
    rgb,
    token,
    style,
    from: composited ? `${nearest.from} (composited)` : nearest.from,
    nodeId: nearest.nodeId,
  };
}

/** Replace topmost solid fill (keeps other paints). Detaches fill style / variable binding. */
async function applySolidFill(node: SceneNode, rgb: ContrastRGB): Promise<boolean> {
  if (!('fills' in node)) return false;

  const geometry = node as MinimalFillsMixin & GeometryMixin;

  if (geometry.fillStyleId && geometry.fillStyleId !== figma.mixed) {
    await geometry.setFillStyleIdAsync('');
  }

  const paints: Paint[] =
    geometry.fills === figma.mixed ? [] : geometry.fills.map((paint) => ({ ...paint }));

  let solidIndex = -1;
  for (let i = paints.length - 1; i >= 0; i--) {
    const paint = paints[i];
    if (paint.visible === false) continue;
    if (paint.type !== 'SOLID') continue;
    solidIndex = i;
    break;
  }

  const previousOpacity =
    solidIndex >= 0 && paints[solidIndex].type === 'SOLID'
      ? (paints[solidIndex].opacity ?? 1)
      : 1;

  const nextSolid: SolidPaint = {
    type: 'SOLID',
    color: { r: rgb.r, g: rgb.g, b: rgb.b },
    opacity: previousOpacity,
    visible: true,
  };

  if (solidIndex >= 0) paints[solidIndex] = nextSolid;
  else paints.push(nextSolid);

  // Prefer async setter when available (pattern fills / dynamic-page-safe path).
  if ('setFillsAsync' in geometry && typeof geometry.setFillsAsync === 'function') {
    await geometry.setFillsAsync(paints);
  } else {
    geometry.fills = paints;
  }
  return true;
}

async function applyColorToTarget(
  role: 'foreground' | 'background',
  color: ContrastRGB,
): Promise<void> {
  const targetId = role === 'foreground' ? colorTargets.foregroundId : colorTargets.backgroundId;
  if (!targetId) {
    figma.notify(
      role === 'foreground'
        ? 'Select a layer to apply the foreground color.'
        : 'No writable background layer (canvas only). Select a filled frame or a second layer.',
    );
    return;
  }

  const node = await figma.getNodeByIdAsync(targetId);
  if (!node || node.type === 'DOCUMENT' || node.type === 'PAGE') {
    figma.notify('Target layer is gone. Reselect and try again.');
    return;
  }

  const ok = await applySolidFill(node as SceneNode, color);
  if (!ok) {
    figma.notify(`Cannot set fill on “${node.name}”.`);
  }
}

async function resolveForeground(node: SceneNode, background: ContrastRGB): Promise<ColorSource | null> {
  const fills = getNodeFills(node);
  if (!fills) return null;
  const paint = topSolidPaint(fills);
  if (!paint) return null;

  const nodeAlpha = effectiveOpacity(node);
  const paintAlpha = clamp01((paint.opacity ?? 1) * nodeAlpha);
  const rgb = compositeOver(paint.color, paintAlpha, background);
  const token = await resolvePaintToken(paint);
  const style = await resolveFillStyleName(node);

  return {
    rgb,
    token,
    style,
    from: node.name,
  };
}

function inferFontWeight(styleName: string): number {
  const style = styleName.toLowerCase();
  if (style.includes('black') || style.includes('heavy')) return 900;
  if (style.includes('extra bold') || style.includes('extrabold')) return 800;
  if (style.includes('semi bold') || style.includes('semibold') || style.includes('demi')) return 600;
  if (style.includes('bold')) return 700;
  if (style.includes('medium')) return 500;
  if (style.includes('light')) return 300;
  if (style.includes('thin') || style.includes('hairline')) return 100;
  return 400;
}

function getTextStyle(node: SceneNode): { fontSize: number | null; fontWeight: number | null } {
  if (node.type !== 'TEXT') return { fontSize: null, fontWeight: null };

  const fontSize = node.fontSize === figma.mixed ? null : node.fontSize;
  const fontWeight =
    node.fontName === figma.mixed ? null : inferFontWeight(node.fontName.style);

  return { fontSize, fontWeight };
}

/** WCAG large text ≈ 18pt (~24px) or 14pt bold (~18.66px). Figma sizes are px-like. */
function isLargeText(fontSize: number | null, fontWeight: number | null): boolean | null {
  if (fontSize == null) return null;
  const bold = (fontWeight ?? 400) >= 700;
  return fontSize >= 24 || (bold && fontSize >= 18.66);
}

function formatColorLabel(source: ColorSource): string {
  if (source.token) return `token “${source.token}”`;
  if (source.style) return `style “${source.style}”`;
  return `raw fill from “${source.from}”`;
}

async function analyzeSelection(): Promise<SelectionPayload> {
  const selection = figma.currentPage.selection;

  if (selection.length === 0) {
    colorTargets = { foregroundId: null, backgroundId: null };
    return {
      type: 'selection',
      foreground: null,
      background: null,
      fontSize: null,
      fontWeight: null,
      isLargeText: null,
      nodeName: null,
      message: 'Select a layer to check contrast, or pick colors manually.',
    };
  }

  if (selection.length >= 2) {
    const fgNode = selection[0];
    const bgNode = selection[1];
    const bgPaint = topSolidPaint(getNodeFills(bgNode) ?? []);

    let bgSource: ColorSource;
    let backgroundId: string | null = null;
    if (bgPaint) {
      // Second layer fill composited over that layer's own parent stack.
      const underSecond = await resolveBackground(bgNode);
      const resolved = await resolveForeground(bgNode, underSecond.rgb);
      bgSource = resolved ?? underSecond;
      backgroundId = bgNode.id;
    } else {
      const parentBg = await resolveBackground(fgNode);
      bgSource = parentBg;
      backgroundId = parentBg.nodeId;
    }

    const foreground = await resolveForeground(fgNode, bgSource.rgb);
    colorTargets = {
      foregroundId: 'fills' in fgNode ? fgNode.id : null,
      backgroundId,
    };

    const style = getTextStyle(fgNode);
    const large = isLargeText(style.fontSize, style.fontWeight);

    let message: string;
    if (!foreground) {
      message = 'First layer has no solid fill. Pick a foreground color manually.';
    } else if (!bgPaint) {
      message = `Second layer has no solid fill — used parent background (${formatColorLabel(bgSource)}).`;
    } else {
      message = `FG: ${formatColorLabel(foreground)} · BG: ${formatColorLabel(bgSource)}.`;
    }

    return {
      type: 'selection',
      foreground,
      background: bgSource,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      isLargeText: large,
      nodeName: fgNode.name,
      message,
    };
  }

  const node = selection[0];
  const background = await resolveBackground(node);
  const foreground = await resolveForeground(node, background.rgb);
  colorTargets = {
    foregroundId: 'fills' in node ? node.id : null,
    backgroundId: background.nodeId,
  };

  const style = getTextStyle(node);
  const large = isLargeText(style.fontSize, style.fontWeight);

  let message: string;
  if (!foreground) {
    message = 'Selected layer has no solid fill. Pick a foreground color manually.';
  } else {
    message = `FG: ${formatColorLabel(foreground)} · BG: ${formatColorLabel(background)}.`;
  }

  return {
    type: 'selection',
    foreground,
    background,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    isLargeText: large,
    nodeName: node.name,
    message,
  };
}

async function pushSelection(): Promise<void> {
  const epoch = ++selectionEpoch;
  const payload = await analyzeSelection();
  if (epoch !== selectionEpoch) return;
  figma.ui.postMessage(payload);
}

figma.on('selectionchange', () => {
  void pushSelection();
});
void pushSelection();

figma.ui.onmessage = (msg: UiToPluginMessage) => {
  if (msg.type === 'request-selection') {
    void pushSelection();
    return;
  }

  if (msg.type === 'resize') {
    const width = Math.max(280, Math.min(600, Math.round(msg.width)));
    const height = Math.max(320, Math.min(900, Math.round(msg.height)));
    figma.ui.resize(width, height);
    return;
  }

  if (msg.type === 'apply-color') {
    void applyColorToTarget(msg.role, msg.color);
    return;
  }

  if (msg.type === 'apply-colors') {
    void (async () => {
      await applyColorToTarget('foreground', msg.foreground);
      await applyColorToTarget('background', msg.background);
    })();
    return;
  }

  if (msg.type === 'close') {
    figma.closePlugin();
  }
};
