# Spiel — Design Language

The page is the product; Spiel is a guest on it.

## Principles
1. **Page-first.** The floating player must never compete with the content. No sentence
   preview in the player — the in-page word highlight IS the reading position. Small
   footprint, bottom-right, draggable, dismissible.
2. **Glanceable, not readable.** The player answers three questions in one glance:
   am I playing? where am I? how long is left? Everything else hides behind the gear.
3. **One accent.** Coral `#FF385C` marks exactly: the play/pause action, the active
   speed chip, progress, and the live word highlight. Nothing else is colored.
4. **No mystery controls.** Every setting shows its value (named voices, labeled speed
   chips). Never a bare slider or a raw model ID.
5. **Native of both worlds.** Auto light/dark via `prefers-color-scheme`; highlight
   colors adapt to the page's own background luminance.

## Tokens
| Token | Light | Dark |
|---|---|---|
| surface | rgba(255,255,255,.97) | rgba(24,25,30,.96) |
| surface-2 (inset) | #f2f2f4 | #2c2d34 |
| text | #1b1b1f | #f2f2f5 |
| text-muted | #8a8b93 | #8a8b93 |
| border | rgba(0,0,0,.09) | rgba(255,255,255,.1) |
| accent | #FF385C | #FF5674 (brighter for dark) |

- **Type:** `'Avenir Next', 'SF Pro Text', -apple-system, 'Segoe UI', Roboto, sans-serif`.
  Sizes: 13 (primary), 11.5 (secondary), 10.5 (labels, uppercase +0.06em). Weights: 600
  for actions/brand, 500 body, no 700+ except brand.
- **Spacing:** 4pt grid — 4 / 8 / 12 / 16.
- **Radius:** 999 (pills, chips, round buttons), 14 (player card), 8 (selects).
- **Elevation:** one shadow only: `0 8px 32px rgba(0,0,0,.18)` (player), none inside.
- **Icons:** Material system icons, 24-grid paths, `fill: currentColor`. Play `M8 5v14l11-7z`,
  pause `M6 19h4V5H6v14zm8-14v14h4V5h-4z`, prev `M6 6h2v12H6zm3.5 6 8.5 6V6z`,
  next `M16 6h2v12h-2zM6 18l8.5-6L6 6z`.

## Components
- **Player (content script, Shadow DOM):** compact card ≤300px wide. Hairline progress
  on top; one control row (prev · play/pause · next · "12/74 · ~13 min" · gear · close);
  settings row (voice select + speed chips) collapsed by default.
- **Speed chips:** presets 0.75 / 1 / 1.25 / 1.5 / 2 / 2.5 / 3 — active chip filled accent.
- **Voices:** exactly 4 curated, named like people with plain descriptions
  (e.g. "Heart — American female · warm"). Voice IDs never shown.
- **Popup:** same tokens; status → controls → settings, nothing else.

## Voice naming convention
`<Name> — <accent> <gender> · <one-word character>`; names come from the Kokoro voice's
own suffix (af_heart → Heart) so logs remain traceable.
