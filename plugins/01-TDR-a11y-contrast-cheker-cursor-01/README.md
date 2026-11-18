# A11yContrast

Figma plugin that checks text/UI color contrast against **WCAG 2.1 AA and AAA**.

## Features

- Contrast ratio from foreground + background colors
- AA / AAA pass–fail for normal and large text
- AA check for non-text contrast (WCAG 1.4.11, ≥ 3:1)
- Auto-read colors from selection:
  - **1 layer** → fill as foreground, nearest solid parent fill as background
  - **2 layers** → first = foreground, second = background
- Manual hex / color pickers and swap
- Large-text detection from selected text size/weight
- On AA fail: suggest local color tokens (Similar look / Highest contrast / Same collection)

## Share / install (no build needed)

The repo includes compiled `code.js`, so others can run the plugin without Node.

1. Clone or download this folder: `plugins/01-TDR-a11y-contrast-cheker-cursor-01`
2. Open Figma Desktop
3. **Plugins → Development → Import plugin from manifest…**
4. Select `manifest.json` inside that folder
5. Run **Plugins → Development → A11yContrast**

Or zip the whole plugin folder (must include `manifest.json`, `code.js`, `ui.html`) and send the zip.

## Thresholds

| Level | Normal text | Large text (≥18pt or ≥14pt bold) |
|-------|-------------|-------------------------------|
| AA    | ≥ 4.5:1     | ≥ 3:1                         |
| AAA   | ≥ 7:1       | ≥ 4.5:1                       |

## Develop

```bash
npm install
npm run build
# or: npm run watch
```

After changing `code.ts`, run `npm run build` (or watch) before sharing again so `code.js` stays in sync.

## Formula

Relative luminance and contrast ratio follow [WCAG 2.1](https://www.w3.org/TR/WCAG21/):

`(L1 + 0.05) / (L2 + 0.05)` where L1 is the lighter luminance.
