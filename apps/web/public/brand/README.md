# Brand assets

The in-app logo is drawn as inline SVG (`src/components/Brand.tsx`) so it stays sharp at
any size, needs no extra request, and can take its colour from the surrounding UI. That
covers the header, the bottom-nav button, empty states and the footer.

## Browser and platform icons

These live in `src/app/` and are picked up by **Next's file convention** — the framework
detects them and emits the `<link>` tags itself:

| File | Purpose |
|---|---|
| `src/app/icon.svg` | browser tab icon, crisp at any zoom |
| `src/app/favicon.ico` | 16/32/48px fallback for clients that ignore SVG favicons |
| `src/app/apple-icon.png` | 180×180 iOS home-screen icon |

**Do not add an `icons` key to `metadata` in `layout.tsx`.** Declaring it *replaces* the
file-convention detection rather than adding to it, which silently removes every icon tag
— the tab then falls back to a blank page glyph with nothing in the markup to explain why.

## Social preview

`og.png` (1200×630) is referenced from `metadata.openGraph` and `metadata.twitter`. Unlike
the icons, `openGraph` does not interfere with icon detection.

## Regenerating

The rasters were produced from the same SVG via headless Chrome, then the `.ico` assembled
with Pillow. Any SVG-to-PNG route works; the only requirements are the sizes above and a
solid (non-transparent) background on the iOS icon, which does not composite alpha.

## Brand values

| Token | Value | Use |
|---|---|---|
| lime | `#9be81c` | primary, UP, focus |
| lime light | `#b4f53f` | hover, highlights |
| lime dark | `#77b512` | gradient shadow side |
| red | `#e33f4d` | DOWN |
| ground | `#050607` | page background |

Wordmark: **PON** in lime, **SHOT** in white, obliqued about 9°, with an arrow lifting off
the end. Tagline: *Predict. Shot. Win.*
