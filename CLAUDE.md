# Spiel — Contributor & AI Working Rules

Spiel is a Chrome (MV3) extension that reads web pages and PDFs aloud using a local
Kokoro TTS engine at `127.0.0.1:8880`. Everything runs on the user's machine — no cloud.

## ⛔ Before adding ANY new capability — READ THIS FIRST
1. **Open [`LESSONS.md`](LESSONS.md) and run its Pre-flight Checklist.** It records every past
   bug and the rule that prevents it. The recurring failure mode here is *"a file/permission the
   code needs at runtime wasn't wired into the build/manifest, so the build passed but the product
   broke on click."* Do not repeat it.
2. After any change: run `npm run build` (it runs `verify:build`), then **reload the unpacked
   extension** at `chrome://extensions` (unpacked does NOT auto-reload), **Clear all** old errors,
   and re-test the actual flow. Bundling ≠ working.

## When a new bug appears
Add an `E<n>` entry to `LESSONS.md` (Symptom → Root cause → Mistake class → Fix → Rule). If it's a
new *class* of mistake, add a checklist item so it can't surprise us twice.

## Architecture quick map
- `src/background.ts` — service worker: state, TTS fetches, offscreen + PDF orchestration. **No DOM/Worker/AudioContext here.**
- `src/content.ts` — injected on every http/https page: article extraction (Readability), highlighting.
- `src/pdf-content.ts` — pdf.js extractor, **injected on demand into PDF tabs only** (keeps the ~1 MB lib off normal pages).
- `src/offscreen.ts` + `offscreen.html` — the only place audio plays (Web Audio, autoplay-exempt).
- `popup/` — UI. `src/shared/` — sentence splitter + types.
- Build = esbuild bundles + copy steps + `scripts/verify-build.js`. **Every runtime file must be in the verify list.**

## Execution-context capabilities (the #1 source of bugs)
| Context | DOM | Worker | AudioContext | fetch scope |
|---|---|---|---|---|
| background (SW) | ❌ | ❌ | ❌ | cross-origin needs `host_permissions` |
| content script | ✅ (host page) | via extension URL | ✅ | same-origin to host page (free) |
| offscreen / popup | ✅ | ✅ | ✅ | per host_permissions |

Pick the context by the API you need, not by convenience.
