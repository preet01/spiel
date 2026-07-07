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

---

## How to add a new entry
When a bug is found: add `E<n>` with **Symptom → Root cause → Mistake class → Fix → Rule**. If it reveals a new recurring class, add a checklist item so it can never be a surprise twice.
