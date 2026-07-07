import { PlaybackState } from './shared/types';
import { splitIntoSentences } from './shared/sentences';

// Use 127.0.0.1 explicitly — avoids IPv6 resolution issues on macOS
const BASE = 'http://127.0.0.1:8880';
const TTS_ENDPOINT = `${BASE}/v1/audio/speech`;
const CAPTIONED_ENDPOINT = `${BASE}/dev/captioned_speech`;
const SERVER_CHECK_URL = `${BASE}/health`;
const VOICES_ENDPOINT = `${BASE}/v1/audio/voices`;

interface WordTs { word: string; start: number; end: number; }
interface Clip { audio: string; timestamps: WordTs[]; }

// mp3 = small bytes, identical first-byte latency to pcm, decodes via decodeAudioData
const AUDIO_FORMAT = 'mp3';

const DEFAULT_VOICES = ['af_heart', 'af_bella', 'af_nova', 'am_michael', 'bm_george', 'bf_emma'];

const log = (...args: any[]) => console.log('[Spiel:BG]', ...args);
const err = (...args: any[]) => console.error('[Spiel:BG]', ...args);

let state: PlaybackState = {
  status: 'idle',
  article: null,
  currentIndex: 0,
  voice: 'af_heart',
  speed: 1.0,
  serverAvailable: false,
};

// Cache key = `${index}|${voice}|${speed}` so a settings change never serves stale audio.
// Played clips are KEPT (LRU, cap 20 ≈ a few MB) so Previous replays instantly — a fresh
// fetch would queue behind in-flight prefetches on the single-worker server and go
// silent for seconds.
const audioCache = new Map<string, Clip>();
const CACHE_MAX = 20;

function cachePut(key: string, clip: Clip): void {
  audioCache.delete(key); // refresh insertion order
  audioCache.set(key, clip);
  while (audioCache.size > CACHE_MAX) {
    const oldest = audioCache.keys().next().value;
    if (oldest === undefined) break;
    audioCache.delete(oldest);
  }
}
let currentTabId: number | null = null;

// generation: bumped on every start/stop/skip. Any async work captures the value at entry
// and bails if it changed — kills out-of-order audio and double-advance races.
let generation = 0;

// NEVER abort an in-flight TTS request: Kokoro-FastAPI crashes on mid-generation
// cancellation (issue #337) and serializes requests anyway (#358). Cancellation is
// LOGICAL (generation checks) and this single-flight queue keeps at most one request
// on the wire — stale queued jobs are skipped before they're ever sent.
let ttsTail: Promise<unknown> = Promise.resolve();

function queueTts(job: () => Promise<Clip | null>): Promise<Clip | null> {
  const p = ttsTail.then(job, job);
  ttsTail = p.catch(() => {});
  return p;
}

let lastInteraction = 0;   // ms — last time the user did something (for keep-warm)
let lastWarmUp = 0;        // ms — debounce warm-up pings

// clipActive: offscreen holds a current source (possibly suspended by pause).
// pendingAdvance: a clip finished while we were paused; advance on resume.
// Together these make RESUME safe when pause happened during fetch or right at clip end.
let clipActive = false;
let pendingAdvance = false;
let sessionStartT = 0;     // ms — Play click time, for click-to-first-audio timing logs
let swapSeq = 0;           // rapid speed/voice changes: last swap wins, stale swaps discarded

const cacheKey = (index: number, voice: string, speed: number) => `${index}|${voice}|${speed}`;

// ── State persistence across service-worker restarts ─────────────────────────
// While paused there is no message traffic, so Chrome kills this worker after ~30s
// and everything in memory evaporates — Resume then did nothing. Persist the whole
// playback state to storage.session and restore it before handling any message.

const PERSIST_KEY = 'playbackStateV1';

function persistState(): void {
  chrome.storage.session.set({
    [PERSIST_KEY]: { state, currentTabId, generation, clipActive, pendingAdvance },
  }).catch(() => {});
}

async function hasOffscreen(): Promise<boolean> {
  try {
    const ctxs = await (chrome.runtime as any).getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return !!ctxs && ctxs.length > 0;
  } catch { return false; }
}

let stateRestored = false;
const stateReady: Promise<void> = (async () => {
  try {
    const saved = (await chrome.storage.session.get(PERSIST_KEY))[PERSIST_KEY];
    if (saved?.state) {
      state = saved.state;
      currentTabId = saved.currentTabId ?? null;
      generation = saved.generation ?? 0;
      clipActive = saved.clipActive ?? false;
      pendingAdvance = saved.pendingAdvance ?? false;
      log('State restored after SW restart:', state.status, 'sentence', state.currentIndex);

      // Chrome also closes the offscreen document ~30s after audio stops (incl. pause).
      // If it's gone, any suspended clip is lost — clear clipActive so RESUME re-fetches
      // the current sentence instead of resuming into the void.
      if (state.status === 'paused' && clipActive && !(await hasOffscreen())) {
        log('Offscreen document was reclaimed while paused — clip lost, will refetch on resume');
        clipActive = false;
      }
      // 'playing'/'loading' with no offscreen doc = playback truly dead; reset to idle.
      if ((state.status === 'playing' || state.status === 'loading') && !(await hasOffscreen())) {
        state.status = 'idle';
        state.article = null;
        state.currentIndex = 0;
      }
    } else {
      // Fresh session: seed saved voice/speed prefs.
      const prefs = await chrome.storage.sync.get({ voice: 'af_heart', speed: 1.0 });
      state.voice = prefs.voice;
      state.speed = prefs.speed;
      log('Prefs loaded:', prefs);
    }
  } catch (e) { err('State restore failed:', e); }
  stateRestored = true;
})();

// ── Offscreen document management ────────────────────────────────────────────

async function ensureOffscreen(): Promise<void> {
  try {
    const existing = await (chrome.runtime as any).getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (existing && existing.length > 0) return;
  } catch {}
  try {
    await (chrome.offscreen as any).createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Playing TTS audio via Kokoro local AI model',
    });
    log('Offscreen document created');
  } catch (e) {
    // A concurrent create can throw "Only a single offscreen document may be created" — fine.
    log('ensureOffscreen note:', e);
  }
}

async function closeOffscreen(): Promise<void> {
  try {
    await (chrome.offscreen as any).closeDocument();
    log('Offscreen document closed');
  } catch {}
}

// ── Content script injection ─────────────────────────────────────────────────

async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
  } catch {
    log('Content script not responding, injecting...');
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    // Poll for readiness instead of a fixed sleep
    for (let i = 0; i < 20; i++) {
      try { await chrome.tabs.sendMessage(tabId, { type: 'PING' }); return; }
      catch { await new Promise(r => setTimeout(r, 50)); }
    }
    log('Content script injected (PING never confirmed)');
  }
}

// ── PDF extraction ────────────────────────────────────────────────────────────
//
// Chrome's PDF viewer renders inside a plugin the DOM can't read. We inject the
// pdf.js-powered extractor (only PDF tabs pay the ~1 MB cost), which fetches the
// PDF's own bytes same-origin and parses the text locally — nothing leaves the Mac.
// Returns { title, sentences, totalWords } or { error: <code> } for a friendly message.
async function extractPdfFromTab(tabId: number, url: string): Promise<any> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['pdf-content.js'] });
  } catch (e) {
    // file:// injection fails when "Allow access to file URLs" is off; also fails on
    // sandboxed viewers we can't script.
    err('PDF extractor injection failed:', e);
    return { error: url.startsWith('file://') ? 'pdf-fileaccess' : 'pdf-inject' };
  }
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_PDF' });
    return res ?? { error: 'pdf-parse' };
  } catch (e) {
    err('PDF extraction message failed:', e);
    return { error: 'pdf-parse' };
  }
}

function pdfErrorMessage(code: string, _url: string): string {
  switch (code) {
    case 'pdf-fileaccess':
      return 'To read PDFs on your Mac, enable "Allow access to file URLs" for Spiel at chrome://extensions, then press Play again.';
    case 'pdf-empty':
      return 'This looks like a scanned PDF with no selectable text — there’s nothing to read aloud.';
    case 'pdf-inject':
      return 'Chrome won’t let extensions read this PDF viewer. Try downloading the PDF and opening the file directly.';
    default:
      return 'Could not read this PDF. It may be password-protected or corrupted.';
  }
}

// ── Server health + warm-up ───────────────────────────────────────────────────

let consecutiveFailures = 0;
let lastServerCheck = 0;   // ms — throttle: popup polls every 600ms, don't hit /health each time

async function checkServer(force = false): Promise<boolean> {
  const now = Date.now();
  if (!force && now - lastServerCheck < 2500) return state.serverAvailable;
  lastServerCheck = now;
  try {
    const res = await fetch(SERVER_CHECK_URL, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      consecutiveFailures = 0;
      state.serverAvailable = true;
      return true;
    }
    throw new Error(`status ${res.status}`);
  } catch (e) {
    // The single-worker server can be briefly unresponsive while generating audio.
    // Require 2 consecutive failures before declaring it offline, so the status light
    // doesn't flicker during normal playback.
    consecutiveFailures++;
    if (consecutiveFailures >= 2) state.serverAvailable = false;
    return state.serverAvailable;
  }
}

// Keep the Kokoro model hot. The first request after startup/idle is 2-13s slower because
// the model pages back in; a tiny request keeps it resident. Debounced to once / 15s.
async function warmUp(): Promise<void> {
  const now = Date.now();
  if (now - lastWarmUp < 15000) return;
  lastWarmUp = now;
  try {
    const res = await fetch(TTS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'kokoro', input: 'a', voice: state.voice, response_format: AUDIO_FORMAT, stream: true }),
    });
    await res.arrayBuffer().catch(() => {});
    log('Warm-up ping done');
  } catch { /* server may be down; ignore */ }
}

// Popup open = strong intent to Play within a second or two. Do ALL the expensive
// work now — extraction (slowest), offscreen doc, model warm-up — so the actual
// Play click only has to fetch one short audio chunk.
let lastPrewarm = 0;
async function prewarmActiveTab(): Promise<void> {
  const now = Date.now();
  if (now - lastPrewarm < 5000) return;
  lastPrewarm = now;
  ensureOffscreen();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    await ensureContentScript(tab.id);
    chrome.tabs.sendMessage(tab.id, { type: 'PREWARM_EXTRACT' }).catch(() => {});
  } catch { /* restricted page etc. — Play will surface the real error */ }
}

// ── TTS fetch ─────────────────────────────────────────────────────────────────

// Fetch audio + word-level timestamps in one call (captioned_speech). Timestamps drive
// the Speechify-style word highlighting in the content script.
async function fetchClip(text: string, voice: string, speed: number): Promise<Clip> {
  let lastErr: any;
  // Retry once on transient failure (server momentarily busy under load).
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(CAPTIONED_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'kokoro', input: text, voice, speed,
          response_format: AUDIO_FORMAT, stream: false, return_timestamps: true,
        }),
      });
      if (!response.ok) throw new Error(`TTS HTTP ${response.status}`);
      const data = await response.json();
      const rawTs = Array.isArray(data?.timestamps) ? data.timestamps : [];
      const timestamps: WordTs[] = rawTs.map((t: any) => ({
        word: String(t.word ?? ''),
        start: Number(t.start_time ?? t.start ?? 0),
        end: Number(t.end_time ?? t.end ?? 0),
      }));
      const audio = String(data?.audio ?? '');
      if (!audio) throw new Error('empty audio');
      return { audio, timestamps };
    } catch (e: any) {
      lastErr = e;
      if (attempt === 0) await new Promise(r => setTimeout(r, 250));
    }
  }
  throw lastErr;
}

async function prefetch(index: number): Promise<void> {
  if (!state.article || index < 0 || index >= state.article.sentences.length) return;
  const key = cacheKey(index, state.voice, state.speed);
  if (audioCache.has(key)) return;
  const myGen = generation;
  const sentence = state.article.sentences[index];
  const { voice, speed } = state;
  try {
    const clip = await queueTts(() => {
      // Superseded while waiting in the queue? Skip without ever hitting the server.
      if (myGen !== generation || audioCache.has(key) || voice !== state.voice || speed !== state.speed) {
        return Promise.resolve(null);
      }
      return fetchClip(sentence, voice, speed);
    });
    if (clip) cachePut(key, clip);
  } catch { /* failed — fine, will fetch on demand */ }
}

// ── Playback engine ───────────────────────────────────────────────────────────

async function playNextSentence(): Promise<void> {
  const myGen = generation;
  if (!state.article) return;
  if (state.status === 'paused') return;

  if (state.currentIndex >= state.article.sentences.length) {
    log('Playback complete');
    state.status = 'done';
    broadcastStatus();
    if (currentTabId) chrome.tabs.sendMessage(currentTabId, { type: 'HIDE_PLAYER' }).catch(() => {});
    closeOffscreen().catch(() => {});
    return;
  }

  const index = state.currentIndex;
  const sentence = state.article.sentences[index];
  const total = state.article.sentences.length;
  log(`Sentence ${index + 1}/${total}: "${sentence.slice(0, 60)}"`);
  state.status = 'playing';
  broadcastStatus();

  const key = cacheKey(index, state.voice, state.speed);
  try {
    let clip = audioCache.get(key);
    if (!clip) {
      const tf = Date.now();
      const fetched = await queueTts(() => {
        if (myGen !== generation || index !== state.currentIndex) return Promise.resolve(null);
        return fetchClip(sentence, state.voice, state.speed);
      });
      if (!fetched) { log('Queued fetch skipped (superseded)'); return; }
      clip = fetched;
      log(`TTS fetch for sentence ${index + 1}: ${Date.now() - tf}ms`);
    }

    // Stale? user skipped/stopped/changed settings while we were fetching.
    if (myGen !== generation || index !== state.currentIndex) {
      log('Discarding stale audio for index', index);
      return;
    }

    // User paused while we were fetching. Keep the clip cached and bail —
    // RESUME will call playNextSentence() and pick it up instantly.
    // (cast: TS keeps the 'playing' narrowing from above across the await)
    if ((state.status as PlaybackState['status']) === 'paused') {
      cachePut(key, clip);
      log('Paused during fetch — clip cached, not dispatched');
      return;
    }
    cachePut(key, clip); // keep it — Previous replays from cache instantly

    // Update panel + page highlight (timestamps drive word-level highlighting)
    if (currentTabId) {
      chrome.tabs.sendMessage(currentTabId, {
        type: 'UPDATE_PANEL', sentence, index, total, timestamps: clip.timestamps, speed: state.speed,
      }).catch(() => {});
    }

    // Play in offscreen document (exempt from autoplay policy)
    await ensureOffscreen();
    if (myGen !== generation) return;
    if (index === 0 && sessionStartT) log(`⚡ click-to-first-audio: ${Date.now() - sessionStartT}ms`);
    clipActive = true;
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_PLAY', audioBase64: clip.audio, genId: myGen }).catch((e) => {
      err('OFFSCREEN_PLAY failed:', e);
      state.status = 'error';
      state.errorMessage = 'Audio playback failed. Try reloading the page.';
      broadcastStatus();
      panelShowPlay();
    });

    // Prefetch the NEXT sentences only AFTER the current one is dispatched —
    // otherwise the sentence the user is waiting for sits behind them in the server queue.
    prefetch(index + 1);
    prefetch(index + 2);

  } catch (e: any) {
    // An abort is always intentional (stop/skip/settings change superseded this fetch) —
    // it must never surface as an error, even if the generation check races.
    if (e?.name === 'AbortError') { log('Fetch aborted (superseded) — ignoring'); return; }
    if (myGen !== generation) return;
    err('Audio fetch failed:', e?.name || '', e?.message || String(e));
    // Diagnose: is this a busy/flaky generation, or is the server actually down?
    const serverUp = await checkServer(true).catch(() => false);
    if (myGen !== generation) return;
    state.status = 'error';
    state.errorMessage = serverUp
      ? 'Failed to generate audio. Press play to retry.'
      : 'Spiel server not reachable. Try: launchctl load ~/Library/LaunchAgents/com.harpreet.kokoro.plist';
    broadcastStatus();
    panelShowPlay();
  }
}

function broadcastStatus(): void {
  persistState();
  chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', state }).catch(() => {});
}

// On playback errors the panel must show the Play button (RESUME = retry),
// not a dead Pause button.
function panelShowPlay(): void {
  if (currentTabId) chrome.tabs.sendMessage(currentTabId, { type: 'PAUSE_PANEL' }).catch(() => {});
}

// ── Start / Stop ──────────────────────────────────────────────────────────────

async function startPlayback(voice: string, speed: number, selectionText?: string): Promise<void> {
  const t0 = Date.now();
  sessionStartT = t0;
  log('startPlayback', { voice, speed, isSelection: !!selectionText });
  ensureOffscreen(); // fire early, in parallel with extraction — it's needed before first audio

  // Tear down any previous session cleanly — including audio already sounding.
  // Without OFFSCREEN_STOP the old sentence keeps talking over the new session's
  // loading phase (Play-while-playing, selection-while-playing).
  generation++;
  const myGen = generation;
  audioCache.clear();
  clipActive = false;
  pendingAdvance = false;
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }).catch(() => {});

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) { err('No active tab found'); return; }
  currentTabId = tab.id;
  state.voice = voice;
  state.speed = speed;
  state.status = 'loading';
  state.errorMessage = undefined;
  state.article = null;
  state.currentIndex = 0;
  broadcastStatus();

  warmUp(); // fire-and-forget; debounced

  let articleData: any;

  if (selectionText) {
    const sentences = splitIntoSentences(selectionText);
    log('Selection split into', sentences.length, 'sentences');
    // NO health-check gate here: /health can block ~3s while the single-worker server
    // is mid-generation, which made every selection feel stuck. If the server is truly
    // down, the first clip fetch fails fast and the error path diagnoses it.
    articleData = { title: 'Selection', sentences, totalWords: selectionText.split(/\s+/).length, isSelection: true };
  } else {
    // PDFs by URL: Chrome's viewer hides the text from the DOM, so extract from bytes.
    if (tab.url?.toLowerCase().endsWith('.pdf')) {
      articleData = await extractPdfFromTab(currentTabId, tab.url);
      if (myGen !== generation) return;
      if (articleData?.error) {
        state.status = 'error';
        state.errorMessage = pdfErrorMessage(articleData.error, tab.url);
        broadcastStatus();
        return;
      }
    }

    if (!articleData) {
      try {
        await ensureContentScript(currentTabId);
      } catch (e) {
        err('Cannot inject content script:', e);
        if (myGen === generation) {
          state.status = 'error';
          state.errorMessage = 'Cannot access this page. Chrome system pages cannot be read.';
          broadcastStatus();
        }
        return;
      }

      let articleError: string | null = null;
      checkServer(true); // fire-and-forget: keeps the popup status light honest, never gates playback
      articleData = await chrome.tabs.sendMessage(currentTabId, { type: 'GET_ARTICLE' }).catch((e) => {
        err('GET_ARTICLE failed:', e);
        articleError = 'Could not read this page. Try reloading it.';
        return null;
      });

      if (myGen !== generation) return; // user started something else meanwhile

      if (articleData?.error === 'pdf') {
        // A PDF served without a .pdf URL (detected in-page). Extract from bytes.
        articleData = await extractPdfFromTab(currentTabId, tab.url || '');
        if (myGen !== generation) return;
        if (articleData?.error) {
          state.status = 'error';
          state.errorMessage = pdfErrorMessage(articleData.error, tab.url || '');
          broadcastStatus();
          return;
        }
      } else if (articleError || !articleData?.sentences?.length) {
        state.status = 'error';
        state.errorMessage = articleError || 'No readable text found on this page.';
        broadcastStatus();
        return;
      }
    }
    log('Article:', articleData?.title, `${articleData?.sentences?.length} sentences`, `(extraction+health ${Date.now() - t0}ms)`);
  }

  if (myGen !== generation) return;

  state.article = articleData;
  state.currentIndex = 0;

  chrome.tabs.sendMessage(currentTabId, {
    type: 'SHOW_PLAYER',
    title: articleData.title,
    isSelection: !!selectionText,
    voice: state.voice,
    speed: state.speed,
    // Sentences let the panel align sentence→DOM runs for click-to-jump and compute time left.
    sentences: articleData.sentences,
    totalWords: articleData.totalWords,
  }).catch((e) => err('SHOW_PLAYER failed:', e));

  // Fetch & play sentence 0 FIRST. prefetch of 1/2 happens inside, after dispatch.
  await playNextSentence();
}

function stopPlayback(): void {
  log('stopPlayback');
  generation++;
  clipActive = false;
  pendingAdvance = false;
  state.status = 'idle';
  state.article = null;
  state.currentIndex = 0;
  state.errorMessage = undefined;
  audioCache.clear();
  broadcastStatus();
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }).catch(() => {});
  closeOffscreen().catch(() => {});
  if (currentTabId) chrome.tabs.sendMessage(currentTabId, { type: 'HIDE_PLAYER' }).catch(() => {});
  currentTabId = null;
}

// ── Voices ────────────────────────────────────────────────────────────────────

let voicesCache: string[] | null = null;

async function fetchVoices(): Promise<string[]> {
  if (voicesCache) return voicesCache;
  try {
    const res = await fetch(`${VOICES_ENDPOINT}?legacy=true`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const data = await res.json();
      let list: string[] = [];
      if (Array.isArray(data)) list = data;
      else if (Array.isArray(data?.voices)) {
        list = data.voices.map((v: any) => (typeof v === 'string' ? v : v?.id)).filter(Boolean);
      }
      if (list.length > 0) { log('Voices fetched:', list.length); voicesCache = list; return list; }
    }
  } catch (e) { log('Voices fetch failed, using defaults'); }
  return DEFAULT_VOICES;
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
  // A message may arrive in a freshly-restarted worker before state is restored
  // (e.g. AUDIO_ENDED waking the SW mid-article). Queue it behind the restore.
  if (!stateRestored) {
    stateReady.then(() => handleMessage(message, sender, sendResponse));
    return true; // keep sendResponse alive for the queued handler
  }
  return handleMessage(message, sender, sendResponse);
});

function handleMessage(message: any, _sender: any, sendResponse: (r?: any) => void): boolean {
  if (message.type !== 'STATUS_UPDATE') log('Message:', message.type);

  switch (message.type) {
    case 'GET_STATUS':
      lastInteraction = Date.now();
      warmUp();           // popup just opened — get the model hot before the user hits Play (debounced)
      prewarmActiveTab(); // and extract the article + create the offscreen doc NOW (debounced)
      checkServer().then(() => {
        // Auto-clear ONLY server-connectivity errors once the server is back.
        // Content errors ("No readable text on this page") must stay visible —
        // this used to wipe them 600ms after they appeared.
        const isServerError = state.errorMessage?.includes('server not reachable')
          || state.errorMessage?.includes('server running');
        if (state.serverAvailable && state.status === 'error' && isServerError) {
          state.status = 'idle';
          state.errorMessage = undefined;
        }
        sendResponse({ state });
      });
      return true;

    case 'GET_VOICES':
      lastInteraction = Date.now();
      warmUp(); // popup is open → user is about to play; get the model hot now
      fetchVoices().then(voices => sendResponse({ voices }));
      return true;

    case 'WARM_UP':
      warmUp();
      sendResponse({ ok: true });
      return false;

    case 'PLAY':
      lastInteraction = Date.now();
      startPlayback(message.voice || state.voice, message.speed ?? state.speed);
      sendResponse({ ok: true });
      return false;

    case 'PLAY_SELECTION':
      lastInteraction = Date.now();
      startPlayback(message.voice || state.voice, message.speed ?? state.speed, message.text);
      sendResponse({ ok: true });
      return false;

    case 'PAUSE':
      lastInteraction = Date.now();
      // Only playing/loading can be paused — pausing from idle/error/done would wedge the state machine.
      if (state.status !== 'playing' && state.status !== 'loading') { sendResponse({ ok: true }); return false; }
      state.status = 'paused';
      broadcastStatus();
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_PAUSE' }).catch(() => {});
      if (currentTabId) chrome.tabs.sendMessage(currentTabId, { type: 'PAUSE_PANEL' }).catch(() => {});
      sendResponse({ ok: true });
      return false;

    case 'RESUME':
      lastInteraction = Date.now();
      // From error with an article still loaded, Resume = retry the current sentence.
      if (state.status === 'error' && state.article) {
        state.status = 'playing';
        state.errorMessage = undefined;
        broadcastStatus();
        playNextSentence();
        sendResponse({ ok: true });
        return false;
      }
      if (state.status === 'paused') {
        state.status = 'playing';
        broadcastStatus();
        (async () => {
          if (clipActive && await hasOffscreen()) {
            // Resume the SUSPENDED clip mid-sentence. Do NOT call playNextSentence (that restarts it).
            chrome.runtime.sendMessage({ type: 'OFFSCREEN_RESUME' }).catch(() => {});
            if (currentTabId) chrome.tabs.sendMessage(currentTabId, { type: 'RESUME_PANEL' }).catch(() => {});
          } else {
            // No live clip (paused during fetch, clip ended while paused, or Chrome
            // reclaimed the offscreen doc during a long pause) — restart playback.
            clipActive = false;
            if (pendingAdvance) { pendingAdvance = false; state.currentIndex++; }
            playNextSentence();
          }
        })();
      }
      sendResponse({ ok: true });
      return false;

    case 'STOP':
      lastInteraction = Date.now();
      stopPlayback();
      sendResponse({ ok: true });
      return false;

    case 'SKIP_NEXT':
      lastInteraction = Date.now();
      if (state.article && state.currentIndex < state.article.sentences.length - 1) {
        generation++;              // invalidate in-flight fetch + the old clip's AUDIO_ENDED
              clipActive = false;
        pendingAdvance = false;
        state.currentIndex++;
        state.status = 'playing';
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }).catch(() => {});
        playNextSentence();
      }
      sendResponse({ ok: true });
      return false;

    case 'JUMP_TO': {
      lastInteraction = Date.now();
      const idx = message.index;
      if (state.article && typeof idx === 'number' && idx >= 0 && idx < state.article.sentences.length) {
        generation++;
              clipActive = false;
        pendingAdvance = false;
        state.currentIndex = idx;
        state.status = 'playing';
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }).catch(() => {});
        playNextSentence();
      }
      sendResponse({ ok: true });
      return false;
    }

    case 'SKIP_PREV':
      lastInteraction = Date.now();
      if (state.article && state.currentIndex > 0) {
        generation++;
              clipActive = false;
        pendingAdvance = false;
        state.currentIndex--;
        state.status = 'playing';
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }).catch(() => {});
        playNextSentence();
      }
      sendResponse({ ok: true });
      return false;

    case 'AUDIO_STARTED':
      // Offscreen fired source.start() — tell the content script to start its word clock
      // now, so word highlighting is synced to actual audio playback.
      if (message.genId === generation && currentTabId) {
        chrome.tabs.sendMessage(currentTabId, {
          type: 'WORD_CLOCK_START', genId: message.genId, durationS: message.durationS,
        }).catch(() => {});
      }
      return false;

    case 'AUDIO_ENDED':
      // Ignore the ended-event of a clip we already replaced (skip/stop/settings change).
      if (message.genId !== generation) { log('Stale AUDIO_ENDED ignored'); return false; }
      clipActive = false;
      if (state.status === 'playing') {
        state.currentIndex++;
        playNextSentence();
      } else if (state.status === 'paused') {
        // Clip finished in the pause race window — advance on resume, not now.
        pendingAdvance = true;
        persistState();
      }
      return false;

    case 'AUDIO_ERROR':
      // A superseded clip's error must not poison the current session.
      if (message.genId !== generation) { log('Stale AUDIO_ERROR ignored'); return false; }
      err('AUDIO_ERROR from offscreen');
      clipActive = false;
      state.status = 'error';
      state.errorMessage = 'Audio playback failed.';
      broadcastStatus();
      panelShowPlay();
      return false;

    case 'UPDATE_SETTINGS': {
      lastInteraction = Date.now();
      const changed =
        (message.voice && message.voice !== state.voice) ||
        (message.speed != null && message.speed !== state.speed);
      if (message.voice) state.voice = message.voice;
      if (message.speed != null) state.speed = message.speed;
      chrome.storage.sync.set({ voice: state.voice, speed: state.speed });
      if (changed) {
        // Prefetched audio at the old voice/speed is now invalid.
        audioCache.clear();
              if (state.status === 'playing' && state.article) {
          // SEAMLESS apply: keep the old clip playing while the new-speed clip is
          // fetched, then swap. Stopping first put ~0.5s of dead air on every change.
          const idx = state.currentIndex;
          const genAtStart = generation;
          const article = state.article;
          const mySwap = ++swapSeq; // rapid changes: only the LATEST swap may win
          queueTts(() => {
            if (mySwap !== swapSeq || generation !== genAtStart
                || state.currentIndex !== idx || state.status !== 'playing') {
              return Promise.resolve(null); // superseded while queued — never sent
            }
            return fetchClip(article.sentences[idx], state.voice, state.speed);
          })
            .then(async (clip) => {
              if (!clip) return;
              // Only swap if nothing moved on while we fetched.
              if (mySwap !== swapSeq) return; // a newer settings change superseded this one
              if (generation !== genAtStart || state.currentIndex !== idx || state.status !== 'playing') return;
              generation++; // silence the old clip's AUDIO_ENDED
              const myGen = generation;
              await ensureOffscreen();
              if (generation !== myGen) return;
              clipActive = true;
              if (currentTabId) {
                chrome.tabs.sendMessage(currentTabId, {
                  type: 'UPDATE_PANEL', sentence: article.sentences[idx],
                  index: idx, total: article.sentences.length, timestamps: clip.timestamps, speed: state.speed,
                }).catch(() => {});
              }
              chrome.runtime.sendMessage({ type: 'OFFSCREEN_PLAY', audioBase64: clip.audio, genId: myGen }).catch(() => {});
              prefetch(idx + 1);
              prefetch(idx + 2);
              persistState();
            })
            .catch(() => { /* failed — old clip keeps playing at the old speed */ });
        } else if (state.status === 'paused' && state.article) {
          // Invalidate the suspended clip so RESUME re-fetches at the new settings.
          generation++;
          clipActive = false;
          pendingAdvance = false;
          chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }).catch(() => {});
        }
      }
      persistState();
      sendResponse({ ok: true });
      return false;
    }
  }
  return false;
}

// ── Keyboard shortcuts (registered in content script; routed here) ─────────────
// (handled via normal PLAY/PAUSE/etc messages from content.ts)

// ── Service worker keep-alive + keep-warm ──────────────────────────────────────

// Keep the Kokoro model warm PERMANENTLY, not just after recent activity.
// A cold model costs 5-13s on the first Play; a warm one ~0.3s. The ping generates a
// single character — negligible compute on a local server — so always-warm is the
// difference between "instant" and "broken-feeling". Playback itself keeps it warm,
// so skip pings while playing/loading.
// Reading a page that's gone is noise, not a feature: stop when the tab closes
// or navigates to a different page mid-session.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === currentTabId) { log('Tab closed — stopping playback'); stopPlayback(); }
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === currentTabId && changeInfo.status === 'loading'
      && (state.status === 'playing' || state.status === 'paused' || state.status === 'loading')) {
    log('Tab navigated — stopping playback');
    stopPlayback();
  }
});

chrome.alarms.create('keepAlive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'keepAlive') return;
  if (state.status !== 'playing' && state.status !== 'loading') warmUp();
});

log('Background service worker initialized');
