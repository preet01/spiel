/* Kokoro Reader — Popup controller */

const $ = id => document.getElementById(id);

// ── DOM refs ──────────────────────────────────────────────────────────────────
const statusDot     = $('status-dot');
const statusLabel   = $('status-label');
const voiceSelect   = $('voice-select');
const speedChips    = $('speed-chips');
const cardIdle      = $('card-idle');
const cardSetup     = $('card-setup');
const setupCmd      = $('setup-cmd');
const btnCopyCmd    = $('btn-copy-cmd');
const cardError     = $('card-error');
const errorMsg      = $('error-msg');
const ctrlIdle      = $('controls-idle');
const ctrlPlaying   = $('controls-playing');
const ctrlLoading   = $('controls-loading');
const btnPlay       = $('btn-play');
const btnPause      = $('btn-pause');
const btnStop       = $('btn-stop');
const btnPrev       = $('btn-prev');
const btnNext       = $('btn-next');

// ── SVG icons ─────────────────────────────────────────────────────────────────
const PLAY_SVG  = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
const PAUSE_SVG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;

// One formatter everywhere: 1 → "1×", 1.5 → "1.5×", 1.25 → "1.25×"
const fmtSpeed = s => `${parseFloat(parseFloat(s).toFixed(2))}×`;

const SPEED_PRESETS = [0.75, 1, 1.25, 1.5, 2, 2.5, 3];
let curSpeed = 1.0;

function buildSpeedChips() {
  speedChips.innerHTML = '';
  for (const sp of SPEED_PRESETS) {
    const b = document.createElement('button');
    b.className = 'chip' + (Math.abs(sp - curSpeed) < 0.01 ? ' active' : '');
    b.textContent = fmtSpeed(sp);
    b.addEventListener('click', () => {
      curSpeed = sp;
      speedChips.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      b.classList.add('active');
      chrome.storage.sync.set({ speed: sp });
      chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', speed: sp });
    });
    speedChips.appendChild(b);
  }
}

// (Playing-card metadata — title/preview/progress/time-left — was removed from the
// popup: the floating in-page player already shows all of it; duplication confused.)

// ── Local state ───────────────────────────────────────────────────────────────
let lastStatus = 'idle';
let pollInterval = null;

// ── Init ──────────────────────────────────────────────────────────────────────
(async function init() {
  // Load saved preferences
  const saved = await chrome.storage.sync.get({ voice: 'af_heart', speed: 1.0 });
  // A saved voice outside the curated 4 stays usable as an extra option.
  if (![...voiceSelect.options].some(o => o.value === saved.voice)) {
    const suffix = String(saved.voice).split('_')[1] || saved.voice;
    const o = document.createElement('option');
    o.value = saved.voice;
    o.textContent = suffix.charAt(0).toUpperCase() + suffix.slice(1) + ' — current voice';
    voiceSelect.appendChild(o);
  }
  voiceSelect.value = saved.voice;
  curSpeed = parseFloat(saved.speed) || 1.0;
  buildSpeedChips();

  // Start polling
  pollStatus();
  pollInterval = setInterval(pollStatus, 600);

})();

// ── Status polling ────────────────────────────────────────────────────────────
async function pollStatus() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    if (res?.state) applyState(res.state);
  } catch {
    // SW might not be ready yet
  }
}

function applyState(state) {
  // Server indicator
  if (state.serverAvailable) {
    statusDot.className = 'status-dot online';
    statusLabel.textContent = 'Voice ready';
  } else {
    statusDot.className = 'status-dot offline';
    statusLabel.textContent = 'Voice not installed';
  }

  const { status, article, currentIndex, errorMessage } = state;
  lastStatus = status;

  // Reading has begun → the floating in-page player is now the single Spiel UI. Close the
  // popup. Errors and first-run setup deliberately do NOT close, so their message stays put.
  if (closeOnPlayback && (status === 'loading' || status === 'playing')) {
    window.close();
    return;
  }

  // First-run onboarding: no engine + nothing playing → show the setup card
  // instead of the idle/error cards. Playback states keep their own cards —
  // /health can briefly fail mid-generation and must not hijack the UI.
  const needsSetup = !state.serverAvailable &&
    (status === 'idle' || status === 'done' || status === 'error');
  cardSetup.classList.toggle('hidden', !needsSetup);
  btnPlay.disabled = needsSetup;
  btnSummarize.disabled = needsSetup; // summary playback needs the voice engine too
  // Summarize stays available even while reading (cached summaries reopen instantly);
  // hidden only during first-run setup and the brief loading state.
  $('summarize-zone').classList.toggle('hidden', needsSetup || status === 'loading');

  // Card visibility
  cardIdle.classList.toggle('hidden', needsSetup || (status !== 'idle' && status !== 'done'));
  cardError.classList.toggle('hidden', needsSetup || status !== 'error');

  // Controls
  ctrlIdle.classList.toggle('hidden', status !== 'idle' && status !== 'done' && status !== 'error');
  ctrlPlaying.classList.toggle('hidden', status !== 'playing' && status !== 'paused');
  ctrlLoading.classList.toggle('hidden', status !== 'loading');

  if (status === 'error') {
    errorMsg.textContent = errorMessage || 'Something went wrong.';
    // Show idle controls too so user can retry
    ctrlIdle.classList.remove('hidden');
    ctrlLoading.classList.add('hidden');
  }

  if (status === 'done') {
    cardIdle.querySelector('.status-hint').innerHTML = '✓ Done reading! Click <strong>Play</strong> to read again.';
  } else {
    cardIdle.querySelector('.status-hint').innerHTML = 'Open any article and click <strong>Play</strong> to start reading.';
  }


  // Pause button label
  if (status === 'paused') {
    btnPause.innerHTML = `${PLAY_SVG} Resume`;
  } else {
    btnPause.innerHTML = `${PAUSE_SVG} Pause`;
  }
}

// ── Setup card: copy the install command ─────────────────────────────────────
const INSTALL_CMD = 'curl -fsSL https://raw.githubusercontent.com/preet01/spiel/main/install.sh | bash';

async function copyInstallCmd() {
  try {
    await navigator.clipboard.writeText(INSTALL_CMD);
    btnCopyCmd.textContent = '✓ Copied — now paste in Terminal';
  } catch {
    // Clipboard can be blocked; the command is still selectable by hand.
    btnCopyCmd.textContent = 'Select the command above and copy it';
  }
  setTimeout(() => { btnCopyCmd.textContent = 'Copy command'; }, 2500);
}
btnCopyCmd.addEventListener('click', copyInstallCmd);
setupCmd.addEventListener('click', copyInstallCmd);

// ── Event handlers ────────────────────────────────────────────────────────────
voiceSelect.addEventListener('change', () => {
  const voice = voiceSelect.value;
  chrome.storage.sync.set({ voice });
  chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', voice });
});


// When the user starts a read, the in-page floating player becomes the live UI — so we
// close this popup to avoid two competing Spiel UIs. We close only once reading actually
// begins (see applyState); if it errors or needs setup, the popup stays open to show why.
let closeOnPlayback = false;
btnPlay.addEventListener('click', () => {
  closeOnPlayback = true;
  chrome.runtime.sendMessage({ type: 'PLAY', voice: voiceSelect.value, speed: curSpeed });
  // Poll sooner than the 600ms tick so the popup snaps shut promptly when reading starts.
  setTimeout(pollStatus, 150);
  setTimeout(pollStatus, 400);
});

// ── Summarize & Listen (Chrome built-in AI — on-device Gemini Nano) ───────────
// The Summarizer API only runs in real document contexts; this popup is the
// recommended one (a popup click also provides the user activation required to
// trigger the one-time model download). Text comes from the background's shared
// extraction (articles AND PDFs); the finished summary plays through the normal
// selection path with the floating player + caption karaoke.

const btnSummarize = $('btn-summarize');
const sumStatus    = $('sum-status');
const sumBar       = $('sum-bar');
const sumBarFill   = $('sum-bar-fill');
const sumLabel     = $('sum-label');

let summarizing = false;
let sumAbort = null;

const SUM_IDLE_HTML = btnSummarize.innerHTML;

function sumUi(label, { progress = null, error = false, indeterminate = false } = {}) {
  sumStatus.classList.remove('hidden');
  sumStatus.classList.toggle('error', error);
  sumBar.classList.toggle('indeterminate', indeterminate && progress == null);
  if (progress != null) sumBarFill.style.width = `${Math.round(progress * 100)}%`;
  sumLabel.textContent = label;
}

function sumReset(keepErrorMs = 0) {
  summarizing = false;
  sumAbort = null;
  btnSummarize.innerHTML = SUM_IDLE_HTML;
  const hide = () => { sumStatus.classList.add('hidden'); sumStatus.classList.remove('error'); sumBar.classList.remove('indeterminate'); sumBarFill.style.width = '0%'; };
  if (keepErrorMs > 0) setTimeout(hide, keepErrorMs); else hide();
}

// Extract the page's readable text directly from the popup: content script for
// articles, pdf-content.js for PDFs. Mirrors background's extractArticleForTab but
// with zero relay hops. Returns {ok, title, sentences, text} or {error}.
// Make sure content.js answers in the tab (injecting it if needed). Used by extraction
// and by the summary-modal handoff (PDF tabs only get pdf-content.js during extraction).
async function ensureContentScriptInTab(tabId) {
  try { await chrome.tabs.sendMessage(tabId, { type: 'PING' }); return true; } catch {}
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }); } catch { return false; }
  for (let i = 0; i < 20; i++) {
    try { await chrome.tabs.sendMessage(tabId, { type: 'PING' }); return true; }
    catch { await new Promise(r => setTimeout(r, 50)); }
  }
  return false;
}

async function popupExtractArticle(tab) {
  const tabId = tab.id;
  const url = (tab.url || '').toLowerCase();

  const ensureCS = () => ensureContentScriptInTab(tabId);

  const pdfExtract = async () => {
    try { await chrome.scripting.executeScript({ target: { tabId }, files: ['pdf-content.js'] }); }
    catch {
      return { error: url.startsWith('file://')
        ? 'To read local PDFs, enable "Allow access to file URLs" for Spiel at chrome://extensions, then retry.'
        : 'Chrome won’t let Spiel read this PDF viewer. Try downloading the PDF and opening the file.' };
    }
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_PDF' });
      if (!r || r.error) {
        return { error: r?.error === 'pdf-empty'
          ? 'This looks like a scanned PDF with no selectable text.'
          : 'Could not read this PDF. It may be protected or corrupted.' };
      }
      return r;
    } catch { return { error: 'Could not read this PDF. Try reloading the tab.' }; }
  };

  let data;
  if (url.endsWith('.pdf')) {
    data = await pdfExtract();
  } else {
    if (!(await ensureCS())) return { error: 'Cannot access this page. Chrome system pages cannot be read.' };
    data = await chrome.tabs.sendMessage(tabId, { type: 'GET_ARTICLE' }).catch(() => null);
    if (data?.error === 'pdf') data = await pdfExtract(); // PDF served without a .pdf URL
    if (!data) return { error: 'Could not read this page. Try reloading it.' };
  }
  if (data.error) return { error: typeof data.error === 'string' && data.error.length > 20 ? data.error : 'Could not read this page.' };
  if (!data.sentences?.length) return { error: 'No readable text found on this page.' };
  return { ok: true, title: data.title || tab.title || 'Article', sentences: data.sentences, text: data.sentences.join(' ') };
}

// Split sentence array into chunks of ≤ maxChars, breaking only at sentence boundaries.
function chunkSentences(sentences, maxChars) {
  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && cur.length + s.length + 1 > maxChars) { chunks.push(cur); cur = s; }
    else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// Does `text` fit in this summarizer's input window? Uses the real token APIs when
// present; falls back to a conservative char heuristic on builds without them.
async function fitsQuota(s, text) {
  try {
    if (typeof s.measureInputUsage === 'function' && typeof s.inputQuota === 'number') {
      return (await s.measureInputUsage(text)) <= s.inputQuota;
    }
  } catch { /* fall through to heuristic */ }
  return text.length <= 12000; // ~3k tokens — safely inside Nano's window
}

btnSummarize.addEventListener('click', async () => {
  // Second click while running = cancel (spam-safe: one in-flight run, ever).
  if (summarizing) { sumAbort?.abort(); return; }
  summarizing = true;
  sumAbort = new AbortController();
  const signal = sumAbort.signal;
  btnSummarize.innerHTML = 'Cancel';

  try {
    // Resolve the tab first: a cached summary needs no AI at all.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw { ui: 'Could not find the active tab — click into the page once and retry.' };

    // A stale PAUSED session from an earlier read makes the popup show Resume/Stop,
    // which reads as nonsense next to "I just summarized". Clear it (never interrupt
    // audio that is actively playing, though).
    if (lastStatus === 'paused') chrome.runtime.sendMessage({ type: 'STOP' }).catch(() => {});

    // Summaries are retained per URL for the browser session — re-showing is instant.
    const cacheKey = 'spielSummary:' + (tab.url || tab.id);
    const cached = (await chrome.storage.session.get(cacheKey))[cacheKey];
    if (cached?.summary) {
      sumUi('Summary ready (saved) — showing on the page', { progress: 1 });
      await ensureContentScriptInTab(tab.id);
      await chrome.tabs.sendMessage(tab.id, { type: 'SHOW_SUMMARY', title: cached.title || '', summary: cached.summary });
      summarizing = false; sumAbort = null;
      setTimeout(() => window.close(), 400);
      return;
    }

    if (!('Summarizer' in self)) {
      throw { ui: 'Needs Chrome 138+ with built-in AI. Update Chrome and try again.' };
    }
    const avail = await Summarizer.availability();
    if (!avail || avail === 'unavailable') {
      throw { ui: 'On-device AI isn’t available here (needs macOS 13+, ~22 GB free disk).' };
    }

    // Start create() NOW, directly off the click — a first-time model download needs
    // the user activation to still be transiently active, so it must not wait behind
    // extraction. The two run in parallel.
    const needsDownload = avail !== 'available';
    sumUi(needsDownload ? 'Downloading on-device AI (one-time)…' : 'Reading the page…', { indeterminate: !needsDownload });
    // outputLanguage is REQUIRED in newer Chrome (150+ rejects without it; supported:
    // de/en/es/fr/ja). Spiel's voices are English, so the summary is always English.
    const summarizerPromise = Summarizer.create({
      type: 'tldr', format: 'plain-text', length: 'long',
      outputLanguage: 'en',
      signal,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          sumUi(`Downloading on-device AI (one-time)… ${Math.round(e.loaded * 100)}%`, { progress: e.loaded });
        });
      },
    });

    // Mark the create() promise handled so an early rejection (e.g. NotAllowedError)
    // can't fire an unhandled-rejection while we're still reading the page —
    // the real handling happens at the `await summarizerPromise` below.
    summarizerPromise.catch(() => {});

    // Extract DIRECTLY from this popup — no background relay. The popup is a full
    // extension page (same chrome.scripting/tabs access), and the old popup→background→
    // content-script→back relay dropped its response in MV3 ("no response from the
    // reader"). Point-to-point messaging has no relay to drop (E9).
    const page = await popupExtractArticle(tab);
    if (signal.aborted) throw { name: 'AbortError' };
    if (!page?.ok) throw { ui: page?.error || 'Could not read this page. Try reloading it.' };
    if ((page.text?.split(/\s+/).length ?? 0) < 60) {
      throw { ui: 'Not enough text on this page to summarize.' };
    }

    const s = await summarizerPromise;
    try {
      let input = page.text;

      if (!(await fitsQuota(s, input))) {
        // Map-reduce: key-points per sentence-boundary chunk, then summarize the points.
        const kp = await Summarizer.create({ type: 'key-points', format: 'plain-text', length: 'short', outputLanguage: 'en', signal });
        try {
          let sentences = page.sentences;
          for (let round = 0; round < 2 && !(await fitsQuota(s, input)); round++) {
            const chunks = chunkSentences(sentences, 3000);
            const points = [];
            for (let i = 0; i < chunks.length; i++) {
              if (signal.aborted) throw { name: 'AbortError' };
              sumUi(`Summarizing… ${i + 1}/${chunks.length}`, { progress: (i + 1) / (chunks.length + 1) });
              points.push(await kp.summarize(chunks[i]));
            }
            input = points.join('\n');
            sentences = points; // if STILL over quota, round 2 key-points the points
          }
        } finally { kp.destroy?.(); }
        // Backstop: hard-trim to fit rather than erroring on pathological documents.
        while (!(await fitsQuota(s, input)) && input.length > 4000) {
          input = input.slice(0, Math.floor(input.length * 0.7));
        }
      }

      sumUi('Summarizing…', { indeterminate: true });
      const summary = await s.summarize(input, { context: `A summary of "${page.title}", to be read aloud.` });
      if (signal.aborted) throw { name: 'AbortError' };
      if (!summary?.trim()) throw { ui: 'The summarizer returned nothing — try again.' };

      // Retain the summary for this URL (session-scoped) — re-summarizing the same
      // page later is instant and free.
      chrome.storage.session.set({ [cacheKey]: { title: page.title, summary: summary.trim(), at: Date.now() } }).catch(() => {});

      // Hand off to the in-page summary modal — NO autoplay. The user reads it and
      // presses Listen there when they want it spoken (the modal drives the karaoke).
      await ensureContentScriptInTab(tab.id); // PDF tabs may not have content.js yet
      await chrome.tabs.sendMessage(tab.id, { type: 'SHOW_SUMMARY', title: page.title, summary: summary.trim() });
      sumUi('Summary ready — showing on the page', { progress: 1 });
      setTimeout(() => window.close(), 500); // the modal is the UI now
    } finally { s.destroy?.(); }
  } catch (e) {
    if (e?.name === 'AbortError') { sumReset(); return; } // user cancelled — quiet reset
    const name = e?.name || '';
    const ui = e?.ui
      || (name === 'NotAllowedError' ? 'On-device AI is blocked on this device (managed Chrome?).'
        : name === 'QuotaExceededError' ? 'This page is too large for the on-device summarizer.'
        : name === 'NotReadableError' ? 'The AI model download was interrupted — try again.'
        : name === 'NotSupportedError' ? 'This page’s language isn’t supported by the on-device summarizer yet.'
        : 'Could not summarize this page. Try again.');
    // Log something greppable — a bare thrown object prints as [object Object].
    console.error('[Spiel:popup] summarize failed:', e?.ui || `${name}: ${e?.message || ''}`, e);
    sumUi(ui, { error: true });
    summarizing = false;
    sumAbort = null;
    btnSummarize.innerHTML = SUM_IDLE_HTML;
    setTimeout(() => { if (!summarizing) sumReset(); }, 6000);
  }
});

btnPause.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: lastStatus === 'paused' ? 'RESUME' : 'PAUSE' });
});

btnStop.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP' });
});

btnPrev.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'SKIP_PREV' });
});

btnNext.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'SKIP_NEXT' });
});

// Listen for live status updates pushed from SW
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATUS_UPDATE' && msg.state) {
    applyState(msg.state);
  }
});
