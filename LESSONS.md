# Spiel — Lessons Learned & Error Log

> **Purpose:** every bug that reached a user (or nearly did) is recorded here with its
> root cause and the rule that prevents it. **Before adding any new capability, read the
> Pre-flight Checklist below and skim the Error Log.** After any change, run
> `npm run build` (it verifies dist/) and reload + click-test in Chrome before saying "done."
>
> This exists because the same *class* of mistake kept recurring: a file or permission the
> code needs at runtime wasn't wired into the build/manifest, so the build passed but the
> product broke only when a user clicked something. The checklist turns those into
> build-time failures instead of user-facing ones.

---

## ✅ Pre-flight Checklist — run through this for EVERY new capability

**1. New file that the extension loads at runtime?**
(offscreen doc, injected script, worker, icon, popup asset, anything referenced by a string path)
- [ ] Add an esbuild step (`build:*`) or copy step (`copy:*`) so it lands in `dist/`
- [ ] Add it to `scripts/verify-build.js` REQUIRED list (so a missing file fails the build)
- [ ] If a page/content context must load it from the extension origin → add to `web_accessible_resources` in `manifest.json`

**2. Referencing a file by string path in code?**
(`chrome.offscreen.createDocument({url})`, `chrome.runtime.getURL(...)`, `executeScript({files})`, `new Worker(...)`)
- [ ] Confirm that exact filename exists in `dist/` after build (grep it)
- [ ] The verify script cross-checks this — keep it honest

**3. Which execution context runs the code?** They have DIFFERENT capabilities:
- **Service worker (background.js):** NO DOM, NO `Worker`, NO `AudioContext`, NO `window`. Cross-origin `fetch` needs `host_permissions`.
- **Content script:** has DOM of the host page; `fetch` is same-origin to that page (no host perm needed); isolated world.
- **Offscreen document / popup:** full DOM, `Worker`, `AudioContext`; exempt from autoplay policy. Use this for audio/DOM/worker work the SW can't do.
- [ ] Picked the right context for the API you need?

**4. New permission or host access?**
- [ ] Least-privilege: can a same-origin content-script `fetch` avoid a broad `host_permissions`? (It usually can.)
- [ ] `file:///*` requires the user to enable "Allow access to file URLs" — handle the failure with a clear message, don't just throw
- [ ] Update the README/privacy section if the permission story changes

**5. Bundling a third-party ESM lib (pdf.js, etc.) as IIFE?**
- [ ] It may use `import.meta.url`/dynamic import for workers — set the worker path explicitly (`GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(...)`) and ship the worker file
- [ ] Only load heavy libs where needed (inject on demand), never in the always-on `content.js`

**6. Before declaring done:**
- [ ] `npm run build` passes (including `verify:build`)
- [ ] Reloaded the unpacked extension at `chrome://extensions` (unpacked does NOT auto-reload)
- [ ] **Clear all** old errors in the extension error panel, then re-test the real flow
- [ ] Checked the RIGHT console: background errors → service worker console; audio → offscreen doc console; page → the tab's console

---

## 🗂 Error Log

### E1 — Audio never played: missing `offscreen.html`
- **Symptom:** `OFFSCREEN_PLAY failed: Could not establish connection. Receiving end does not exist.` + `ensureOffscreen note: Error: Page failed to load.` User saw "Audio playback failed."
- **Root cause:** `background.ts` calls `chrome.offscreen.createDocument({ url: 'offscreen.html' })`, but that HTML file **never existed** in source and was **never copied to `dist/`**. The build bundled `offscreen.js` but shipped no page to host it → the offscreen document failed to load → nothing received the play message.
- **Blast radius:** 100% of users installing from source. Audio never worked for anyone.
- **Mistake class:** ⭐ **Referenced-but-not-shipped asset.** A runtime-referenced file was absent from the build, and nothing verified `dist/` completeness.
- **Fix:** created `offscreen.html`; added `copy:offscreen`; added `scripts/verify-build.js` to fail the build if any required file is missing.
- **Rule → Checklist #1, #2, #6.**

### E2 — `npx tsc` prompts to install TypeScript (no type safety in the pipeline)
- **Symptom:** README's `npx tsc --noEmit` step asks to install `typescript`.
- **Root cause:** `typescript` isn't a devDependency; the build uses **esbuild, which strips types WITHOUT type-checking**. Type errors can ship silently.
- **Mistake class:** **No type-check gate.** A whole category of bugs (wrong property names, bad message shapes) can't be caught pre-ship.
- **Fix / open item:** treat esbuild success as NOT a correctness guarantee; verify behavior by running the flow. (Optionally add `typescript` devDep + a `typecheck` script.)
- **Rule → Checklist #6** (behavioral verification, not just "it bundled").

### E3 — PDF support: context + bundling traps (caught during design, not shipped)
- **What could have gone wrong:**
  - Running pdf.js in the **service worker** — impossible: SW has no `Worker`/DOM. → Ran extraction in the **content script** instead.
  - Fetching PDF bytes cross-origin from the SW would need broad `host_permissions`. → **Same-origin `fetch` in the content script** needs none.
  - Bundling pdf.js (ESM) as IIFE can break worker auto-resolution (`import.meta.url`). → Set `workerSrc` explicitly + shipped `pdf.worker.min.mjs` as a `web_accessible_resource`.
  - Loading ~1 MB pdf.js in the always-on `content.js` would slow every page. → Built a separate `pdf-content.js`, **injected on demand** only into PDF tabs.
  - `file:///` PDFs need the user's "Allow access to file URLs" toggle. → Detect injection failure and show an exact instruction instead of a raw error.
- **Mistake class:** **Context-capability & permission assumptions.**
- **Rule → Checklist #3, #4, #5.**

### E4 — Highlight ran ahead of audio on rapid Next (desync)
- **Symptom:** clicking Next several times fast → voice cut out but the word highlighter kept moving; sometimes the reverse (highlight froze, voice continued).
- **Root cause:** the content-script word-highlight clock is a **free-running timer** (rAF + `performance.now()`), only reset when the *next* clip's audio starts (`WORD_CLOCK_START`, fired from `AUDIO_STARTED`). On skip, background stops audio instantly (`OFFSCREEN_STOP`) but the new clip needs a fetch — so during that gap the old timer kept animating with no audio. Rapid skips stacked the gaps. The new PDF caption karaoke made it more visible.
- **Mistake class:** **Two clocks, one truth.** A UI animation timed independently of the media it represents will drift whenever the media is interrupted.
- **Fix:** send `HIGHLIGHT_STOP` to the content script the instant the user skips/jumps (alongside `OFFSCREEN_STOP`), freezing the highlight until the next clip's `AUDIO_STARTED` restarts it in lockstep.
- **Rule:** any progress/animation that mirrors playback must be **stopped on the same event that stops playback**, and only restarted by the signal that playback actually resumed — never left to free-run.

### E5 — Speed change caused 3–4s of silence + the highlight vanished
- **Symptom:** changing playback speed (e.g. 3× → 1×) produced 3–4 seconds of no audio, and the word highlight disappeared until sound came back.
- **Root cause:** `UPDATE_SETTINGS` ran a "seamless swap" — it cleared the audio cache and **re-fetched + restarted the current sentence** at the new speed. On the single-worker Kokoro engine that regeneration takes seconds; worse, if the current clip finished mid-fetch, its `AUDIO_ENDED` advanced and kicked off *another* fetch (two serialized fetches). The highlight stopped the moment the old clip was superseded and only restarted once audio returned.
- **Mistake class:** **Interrupting in-flight playback to apply a deferrable change.** Synchronous media regeneration on a single-worker backend sits directly on the interaction path.
- **Fix:** don't touch the currently-playing sentence — apply the new speed from the **next** sentence and prefetch upcoming sentences at the new speed in the background. Current audio + highlight keep running; the change is audible within a sentence and Next stays instant.
- **Rule:** never stop good playback to apply something that can take effect at the next natural boundary; push expensive regeneration to the background, off the click path. (Related: [[E4]] — keep the highlight tied to real playback events.)

### E6 — Rapid pause/resume spam could wedge playback (stale resume)
- **Symptom:** clicking pause/resume quickly could leave audio playing while the UI said "paused" — and the Pause button then did nothing (state already 'paused'), wedging playback until Resume→Pause.
- **Root cause:** RESUME's async path awaited `hasOffscreen()` and then sent `OFFSCREEN_RESUME` **without re-checking state** — a Pause that landed during the await was overridden by the stale resume. Check-then-act across an `await`.
- **Mistake class:** **State checked before an await, acted on after.** Every `await` is a preemption point where the user may have changed the world.
- **Fix:** re-verify `state.status === 'playing'` after the await, bail with a log if superseded.
- **Rule:** after ANY `await` in a user-interaction path, re-validate the state you're about to act on (generation counter or status check) before doing anything externally visible.

### Found-safe in the same review (patterns worth keeping)
- `queueTts` cannot wedge: `.then(job, job)` + tail `.catch` — a rejected job never breaks the chain.
- `audioCache` is LRU-capped (20 clips) — no unbounded memory growth on long articles.
- Sentence splitter is bounded: 1 MB input → 24k sentences ≤350 chars in ~30 ms; empty/symbol/10k-char-token inputs all safe (stress-tested).
- Tab close / navigation stops playback; SW-restart state persistence with offscreen-reclaim detection.
- Hardening added: `fetchClip` 90s watchdog (hang → error card, never infinite silence); empty-selection guard (no panel flash).

### E7 — Rapid Next: sentence generated TWICE, stacking seconds of silence
- **Symptom:** pressing Next 3–4× quickly → long dead silence; felt like "the voice is lost."
- **Root cause:** on skip, a prefetch of the target sentence was usually already **in flight** on the single-worker engine. `playNextSentence` checked the cache **before** entering the TTS queue, missed, waited behind that very prefetch — then **generated the same sentence again**. Every rapid skip doubled its own latency; skips stacked.
- **Mistake class:** **Stale precondition across a queue wait.** A check done before enqueueing was acted on after the queue ran; the world (cache) had changed.
- **Fix:** re-check the cache **inside** the queued job (prefetch already did this — playback didn't).
- **Rule:** any single-flight/queued job must re-validate its preconditions (cache, generation, index) at **execution** time, not submission time. Same family as E6 (post-await re-check).

### E8 — Highlight randomly stopped for stretches: block-boundary text glue
- **Symptom:** page highlight worked, then silently stopped for certain paragraphs, then resumed. Caption showed the tell: `…of a network.Example:One layer in…`.
- **Root cause:** extraction used `Readability.textContent` / `element.textContent`, which concatenates block elements (`</p><p>`, `<li>`) with **no separator**. The splitter can't split `network.Example` (needs whitespace after the period) → mega-sentence with glued tokens like `network.Example:One` that match **nothing** in the page word index → whole stretch un-highlightable until the next clean sentence.
- **Mistake class:** **Trusting `textContent` for prose.** DOM text extraction must be block-aware; this is a well-known pitfall (innerText vs textContent).
- **Fix:** derive text from Readability's HTML with breaks injected at block boundaries (`htmlToText`); site-selector path switched to `innerText` (rendered elements only); splitter got a de-glue safety net (`.X` → `. X` after abbreviation/decimal protections) for PDF/selection sources.
- **Rule:** never feed `textContent` of multi-block containers into NLP/matching; go through a block-aware conversion, and give downstream parsers a tolerance for glue anyway.

### Also fixed in the same pass (smaller lessons)
- **Double-click read-from-here silently ate the jump:** dblclick selects a word → the "respect active selections" guard rejected it. Intent detection must distinguish a selection the user *made* from one their gesture *side-effected* (`dblclick` handler bypasses the guard and clears its own selection).
- **"Could not read this page" on Summarize was unactionable:** four failure legs shared one error string, and the tab was resolved in the SW (`currentWindow` can misresolve there). Tab now resolved in the popup and every failure leg has a distinct message. **Rule:** distinct failures get distinct user-visible strings — a screenshot should pinpoint the leg.

### E9 — Summarize: "no response from the reader" (relayed response dropped)
- **Symptom:** Summarize failed with the popup's no-response error even though extraction worked (Play on the same page succeeded).
- **Root cause:** the popup asked the **background** for the page text; the background then messaged the **content script** and tried to `sendResponse` back over the original channel after that nested hop. In MV3, holding a `sendResponse` open across a nested `tabs.sendMessage` round-trip is a known-flaky pattern — the relayed response silently never arrived. (Simple async responses like GET_STATUS work; it's the *relay* that drops.)
- **Mistake class:** **Relay across message channels.** Every extra hop is a place a response can die.
- **Fix:** the popup extracts **directly** (`popupExtractArticle`): it's a full extension page with the same `chrome.tabs`/`chrome.scripting` access, so it pings/injects the content script and the PDF extractor itself. Zero relay. The background handler was removed so the pattern can't creep back.
- **Rule:** prefer point-to-point messaging; never respond to channel A by first awaiting a round-trip on channel B. If a relay is truly needed, have the requester poll state instead of holding a response channel open.

### E10 — Summarizer rejected: missing required `outputLanguage` (+ unreadable logs)
- **Symptom:** Summarize failed; console showed `summarize failed: [object Object]` and a separate Chrome warning: *"No output language was specified in a Summarizer API request… specify a supported output language code: [de, en, es, fr, ja]"*.
- **Root cause (2):** (a) Chrome 150 turned `outputLanguage` from optional into effectively required — the API contract tightened between versions; (b) our catch logged the raw thrown object, which prints as `[object Object]`, hiding the reason.
- **Fix:** `outputLanguage: 'en'` on every `Summarizer.create()`; error logging prints `e.ui`/`name: message` before the raw object; `NotSupportedError` mapped to a human message.
- **Rules:** (1) treat browser AI/platform APIs as moving targets — a console *warning* today is a *rejection* next release; set all attestation-type params explicitly. (2) Never `console.error(obj)` a thrown plain object — always log a string form first; diagnosis speed depends on it.

---

## ✅ Software-quality checklist (cross-reference before every release)

**Robustness under interaction spam** — every control (play/pause/next/prev/speed/jump/stop/close) must be safe to hammer 10× fast. Techniques in this codebase: generation counter, single-flight queue, post-await state re-checks, idempotent pause/resume guards.
**Bounded everything** — inputs (sentence length caps), memory (LRU caches), time (fetch watchdogs). Anything unbounded is a future hang or OOM.
**No infinite silent states** — every failure path must land in a visible state with a retry route (error card + Play), never a spinner/silence forever.
**Lifecycle honesty** — assume the SW dies every 30s, the offscreen doc gets reclaimed, tabs close mid-play. Persist and restore; detect and re-acquire.
**Fail at build, not at runtime** — typecheck gate (`npm run typecheck`, in `build`), dist-completeness gate (`verify:build`). A user should never be the first to discover a missing file.
**Single source of truth for sync'd UI** — highlight/caption/progress restart only on real playback events (E4/E5), never on free-running timers.
**Verify behavior, not builds** — after changes: reload extension, Clear all errors, exercise play/pause/next/speed/PDF flows.

---

## How to add a new entry
When a bug is found: add `E<n>` with **Symptom → Root cause → Mistake class → Fix → Rule**. If it reveals a new recurring class, add a checklist item so it can never be a surprise twice.
