# Blue Whale Theme — v1 review draft

Original pixel-style blue whale art prepared as a reviewable theme package. This is intentionally stored under `design/`, not `themes/`, so it does not register as a built-in theme or change the app's default theme catalog.

## Preview

Open `preview.html` in a browser, or serve this directory over HTTP for a live preview. The gallery covers:

- All primary desktop states, including the complete sleep sequence
- Idle variations and the three work tiers
- All required mini-mode states plus optional mini-working
- Drag, click, double-click, and annoyed reactions

## Theme validation

From the repository root:

```bash
node design/blue-whale-v1/generate-assets.js
node scripts/validate-theme.js design/blue-whale-v1
```

All animation assets are standalone SVG files with embedded CSS keyframes. The idle SVG keeps `#body-js`, `#eyes-js`, and `#shadow-js` for the project's cursor-tracking renderer. There are no scripts, remote resources, or references to the separately distributed Whale-chan artwork.
