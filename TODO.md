# Spiel (formerly Hark, briefly Nardin) — TODO

## V1 (Current)
- [x] Project setup (esbuild, TypeScript, npm)
- [x] Manifest V3 Chrome extension
- [x] Background service worker — TTS fetching, pre-fetch cache, state machine
- [x] Content script — Readability extraction, floating player (Shadow DOM), AudioContext playback
- [x] Popup UI — voice selector, speed slider, play/pause/stop, progress
- [x] Word-by-word highlighting (via /dev/captioned_speech timestamps)
- [x] Icons (16/48/128 PNG)
- [x] Sentence splitter with abbreviation protection
- [x] launchd auto-start for Kokoro server
- [ ] Test on 10+ real sites (news, blogs, Wikipedia, Medium, Substack)
- [ ] Fix any site-specific extraction edge cases

## Code-review fixes (2026-07-03) — all done
- [x] Pause/resume deadlock: pausing during audio generation played audio under a "paused" UI; pausing right as a clip ended made resume a no-op (clipActive + pendingAdvance tracking)
- [x] Stale AUDIO_ERROR from a superseded clip could poison a healthy new session (genId guard)
- [x] ensureOffscreen used non-existent chrome.offscreen.getContexts → chrome.runtime.getContexts
- [x] Popup polling fired a /health request every 600ms → throttled to 2.5s (bypassed on Play)
- [x] Dropped "tabs" permission (was triggering the "read your browsing history" store warning)
- [x] keepAlive alarm 0.4min was below Chrome's 0.5 minimum (silently clamped) → 0.5
- [x] Floating panel hardcoded 6 voice IDs while popup loaded the live list → panel now gets server voices with grouped labels
- [x] Dark mode: popup, floating panel, selection button, and page-highlight colors (page-background luminance detection)
- [x] Speed label formatted 3 different ways → one fmtSpeed everywhere

## V2 — Speechify-parity features (research-ranked)
- [x] **Click-to-listen-from-here** — click any word in the article while playing to jump there (2026-07-03)
- [x] **Time-remaining estimate** — "~X min" at current speed in panel + popup (2026-07-03)
- [x] **Enhanced skipping** — popup toggles: skip URLs (on), [brackets/refs] (on), (parens) (off); applied at extraction (2026-07-03)
- [ ] **Speed range to 4×** (Kokoro supports it; Speechify sells "5×" hard) + optional gradual speed ramp
- [ ] **Keyboard shortcut** (manifest `commands`, e.g. Alt+R) + right-click "Read selection" context menu
- [ ] Friendly voice names + voice preview (play a sample on hover/select)
- [ ] Save-for-later listening queue (local, chrome.storage)
- [ ] PDF support (pdfjs-dist)
- [ ] In-browser kokoro-js WebGPU mode — zero-server install for the public release
- [ ] Firefox support (WXT rewrite)
- [ ] EPUB reader mode

## Open-source release checklist
- [ ] Own git repo + GitHub, Apache 2.0 LICENSE
- [ ] README: "free, open-source alternative to Speechify" (plain text only) + non-affiliation disclaimer: "Spiel is not affiliated with or endorsed by Speechify Inc."
- [ ] THIRD_PARTY notices: Kokoro-82M (Apache 2.0, hexgrad), Mozilla Readability (Apache 2.0), Kokoro-FastAPI (Apache 2.0)
- [ ] Reproduce Kokoro model-card CC BY dataset credits (Koniwa CC BY 3.0, SIWIS CC BY 4.0)
- [ ] Server not-detected onboarding flow (install instructions / one-click script) — required before strangers can use it
- [ ] Chrome Web Store: privacy disclosures ("page text only goes to your own machine"), privacy policy page, single-purpose listing, do NOT put "Speechify" in the title/slug (spam policy + trademark)
- [ ] Declare "No" remote code (localhost audio = data, not code — policy-clean)

## Legal (researched 2026-07-03 — public info, not legal advice)
- Feature cloning (highlighting, speed, floating player): LOW RISK — copyright protects expression, not functionality; word-highlight TTS predates Speechify (Kurzweil, Kindle Immersion Reading)
- Avoid copying: their code, icons, UI artwork, logo, brand styling, pixel-level UI clones
- Trademark: "alternative to Speechify" = nominative fair use, OK in README/marketing; NEVER in product name/title
- Patents US11145288B2 + US12020681B2 are **Google's** (draggable-selector TTS system), not Speechify's; narrow claims (selector + structural inference + movement-intent) — simple click-to-read likely doesn't practice all elements, but claim analysis = lawyer territory if this gets big
- Speechify Inc. appears to hold no TTS/highlighting patents

## Fixes round 2 (2026-07-03, after live testing)
- [x] Renamed app Hark → Spiel (manifest, popup, panel, IDs, logs, highlight names)
- [x] Speed/voice change now applies INSTANTLY — restarts current sentence at new setting (was: next sentence only, felt broken)
- [x] Resume-after-pause survives service-worker death: full playback state persisted to chrome.storage.session, restored before any message is handled; RESUME re-fetches the sentence if Chrome reclaimed the offscreen doc during a long pause
- [x] First-audio latency: keep-warm ping every 1 min unconditionally (was: only within 3 min of activity — model went cold → 5-13s), warm on popup open, offscreen doc + voices fetch parallel with extraction. Measured warm first-chunk fetch: 0.4-0.6s → click-to-audio <1s
- [x] Comma-less long sentences now hard-wrapped at ~300 chars (were sent unchunked)

## Fixes round 3 (2026-07-03, selection flow RCA)
- [x] Selection "Play" button stuck on Loading… forever after first use — button is reused across selections but its spinner state was never reset; now resets on every show + hides the moment the player appears
- [x] Selection start latency: removed serial /health gate (blocked up to 3s while the single-worker server was mid-generation) and the awaited voices fetch (up to 2s, unused since curated voices) from the play path; server-down is diagnosed in the failure path with a retry-able error

## Round 4 (2026-07-03, Kokoro-FastAPI research findings)
- [x] STOP aborting in-flight TTS requests — Kokoro-FastAPI crashes on mid-generation cancellation (issue #337: free(): invalid pointer) and serializes requests anyway (#358). Replaced with logical cancellation (generation checks) + client-side single-flight queue; stale queued jobs are skipped before ever being sent. Likely explains past random "server not reachable" stalls (we were crashing our own server on skip/speed-change).
- [ ] **Streaming playback** (big latency win, roadmap): /dev/captioned_speech supports stream:true → NDJSON chunks with per-chunk word timestamps; use PCM (not mp3 — Mac MediaSource codec issue #270) + Web Audio chunk scheduling for sub-300ms perceived start
- [ ] Server tuning (Harpreet, one-time): set TARGET_MIN_TOKENS=60-100 env in the launchd plist to shrink first-chunk generation; current warm 0.25-0.6s is already near the M-series floor per repo benchmarks
- Server facts (researched): model NEVER unloads (no idle timeout) — cold spikes are macOS paging or queue contention, so the 60s keep-warm synthesis ping is correct; MPS is only partially accelerated (ISTFT + some ops fall back to CPU, issue #277); ONNX backend no longer exists on master
