# WCAG Contrast Checker

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

In Figma: **Plugins → Development → Import plugin from manifest…** and select `manifest.json`.

## Formula

Relative luminance and contrast ratio follow [WCAG 2.1](https://www.w3.org/TR/WCAG21/):

`(L1 + 0.05) / (L2 + 0.05)` where L1 is the lighter luminance.
