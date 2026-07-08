import { Readability } from '@mozilla/readability';
import { splitIntoSentences } from './shared/sentences';

const log = (...args: any[]) => console.log('[Spiel:CS]', ...args);
const err = (...args: any[]) => console.error('[Spiel:CS]', ...args);

// ── DOM roots ──────────────────────────────────────────────────────────────────

let isPaused = false;
let isSelectionMode = false;

let panelHost: HTMLElement | null = null;
let panelShadow: ShadowRoot | null = null;
let panelAbort: AbortController | null = null;  // tears down document-level panel listeners
let selBtnHost: HTMLElement | null = null;
let selBtnShadow: ShadowRoot | null = null;
let selHideTimer: ReturnType<typeof setTimeout> | null = null;

// ── Word index for page highlighting ──────────────────────────────────────────

interface WordRef { w: string; node: Text; s: number; e: number; }
let words: WordRef[] = [];
let highlightCursor = 0;
let wordsBuilt = false;

// ── Word-level highlighting clock ──────────────────────────────────────────────
interface WordTs { word: string; start: number; end: number; }
let curRunIndices: number[] = [];  // indices into words[] for the current sentence, in order
let curTs: WordTs[] = [];          // alphanumeric-only timestamps for the current sentence
let wordRaf: number | null = null;
let clockStart = 0;                // performance.now() anchored to audio start
let pausedAccum = 0;               // total ms spent paused
let pauseStart = 0;
let wordActive = false;
let curDur = 0;                    // actual clip duration (s) — timestamps can undercount

// Panel caption karaoke — word spans shown INSIDE the floating player. This works even when
// the page has no highlightable DOM (PDFs), so PDF reading still gets a follow-along.
let panelWords: HTMLElement[] = [];
let panelActiveWord = -1;

// Summary modal — a designed in-page overlay showing the on-device summary. Playback is
// user-initiated (Listen button); while reading, the karaoke highlights the MODAL text.
let summaryHost: HTMLElement | null = null;
let summaryShadow: ShadowRoot | null = null;
let summaryAbort: AbortController | null = null;
let summarySentSpans: HTMLElement[][] = [];  // word spans per summary sentence
let summaryActiveSent = -1;

// ── Article extraction ─────────────────────────────────────────────────────────

// Site-specific content roots for journals where Readability is unreliable.
const SITE_SELECTORS: Array<[RegExp, string]> = [
  [/sciencedirect\.com/, '#body, .Body, #centerInner, article'],
  [/springer\.com|link\.springer/, 'main .main-content, .c-article-body, article'],
  [/nature\.com/, 'article .c-article-body, div[data-article-body], article'],
  [/ieee\.org/, '.document-main, .article, #article'],
  [/ncbi\.nlm\.nih\.gov/, 'article, .tsec, #mc, .article-details'],
  [/plos\.org/, '.article-text, #artText'],
  [/pubmed\.ncbi/, 'article, .abstract'],
];

// After the extension reloads/updates, THIS copy of the content script is orphaned in
// every open tab: its chrome.* APIs are dead and any use throws "Extension context
// invalidated" (E11). Detect it and go quiet — the new content script takes over.
function extensionAlive(): boolean {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

function cleanText(s: string): string {
  return s.replace(/\[[\d]+\]/g, '').replace(/\s+/g, ' ').trim();
}

// Content skipping: URLs, [reference brackets] and (parentheticals) are ALWAYS removed
// from the spoken text — they read terribly aloud. (These were user toggles once;
// nobody needed that much nuance, so they're now sensible fixed behavior.)
function applySkips(text: string): string {
  return text
    .replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, ' ')
    .replace(/\[[^\]]{0,120}\]/g, ' ')   // [12], [citation needed], [Smith et al.]
    .replace(/\([^()]{0,200}\)/g, ' ')   // non-nested parentheticals only
    .replace(/\s+/g, ' ').trim();
}

function buildResult(title: string, rawText: string) {
  const text = applySkips(cleanText(rawText));
  const sentences = splitIntoSentences(text);
  const totalWords = text.split(/\s+/).filter(Boolean).length;
  log(`Extracted: "${title}" — ${sentences.length} sentences, ${totalWords} words`);
  return { title: title || document.title || 'Article', byline: '', sentences, totalWords };
}

// Readability's .textContent (and any element's textContent) concatenates block
// elements with NO separator — "…of a network.Example:One layer in…" — which breaks
// sentence splitting (no whitespace after the period) AND page highlighting (the glued
// token matches nothing in the word index). Derive text from the article HTML instead,
// inserting explicit breaks at block boundaries; cleanText collapses them to spaces (E8).
function htmlToText(html: string): string {
  const withBreaks = html.replace(
    /<\/?(p|div|li|ul|ol|h[1-6]|br|blockquote|tr|td|th|table|section|article|header|footer|figure|figcaption|pre|dt|dd)\b[^>]*>/gi,
    '\n$&');
  return new DOMParser().parseFromString(withBreaks, 'text/html').body?.textContent || '';
}

function parseDocWithReadability(doc: Document): { title: string; text: string } | null {
  try {
    const article = new Readability(doc).parse();
    if (article && article.textContent && cleanText(article.textContent).length > 250) {
      // Prefer block-aware text from the HTML; fall back to raw textContent.
      const text = (article.content && htmlToText(article.content)) || article.textContent;
      return { title: article.title || '', text };
    }
  } catch (e) { err('Readability error:', e); }
  return null;
}

// arXiv ships clean HTML at arxiv.org/html/<id> (better than the 2-column PDF or the
// abstract-only /abs/ page). Same-origin fetch — needs no extra permission.
async function tryArxivHtml(): Promise<ReturnType<typeof buildResult> | null> {
  if (!/(^|\.)arxiv\.org$/.test(location.hostname)) return null;
  if (location.pathname.includes('/html/')) return null; // already the HTML version
  const m = location.pathname.match(/(\d{4}\.\d{4,5})(v\d+)?/) || location.pathname.match(/([a-z\-]+\/\d{7})/);
  if (!m) return null;
  const id = m[1];
  try {
    log('arXiv detected — fetching HTML version for', id);
    const res = await fetch(`https://arxiv.org/html/${id}`);
    if (!res.ok) { log('arXiv HTML not available, status', res.status); return null; }
    const html = await res.text();
    if (/No HTML for this paper|not available/i.test(html.slice(0, 4000))) return null;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const parsed = parseDocWithReadability(doc);
    if (parsed) return buildResult(parsed.title || document.title, parsed.text);
  } catch (e) { log('arXiv HTML fetch failed:', e); }
  return null;
}

function isPdfPage(): boolean {
  return document.contentType === 'application/pdf'
    || location.href.toLowerCase().endsWith('.pdf')
    || !!document.querySelector('embed[type="application/pdf"], object[type="application/pdf"]');
}

// Extraction is the slow part of Play (Readability on a big page can take >1s), so it
// runs at popup-open time via PREWARM_EXTRACT and Play serves this cache instantly.
// Invalidated on navigation (href), skip-setting changes, and after 5 minutes.
let articleCache: { href: string; opts: string; at: number; data: any } | null = null;

async function extractArticleCached() {
  const opts = 'fixed'; // skips are no longer configurable — cache key kept for shape
  if (articleCache && articleCache.href === location.href && articleCache.opts === opts
      && Date.now() - articleCache.at < 300000) {
    log('Article served from prewarm cache');
    return articleCache.data;
  }
  const t = performance.now();
  const data = await extractArticle();
  log(`Extraction took ${Math.round(performance.now() - t)}ms`);
  articleCache = { href: location.href, opts, at: Date.now(), data };
  return data;
}

async function extractArticle() {
  log('Extracting article...');

  if (isPdfPage()) {
    log('PDF detected — not supported');
    return { error: 'pdf', sentences: [], title: 'PDF', totalWords: 0 };
  }

  // 1. arXiv → prefer the clean HTML version
  const arxiv = await tryArxivHtml();
  if (arxiv) return arxiv;

  // 2. Known journal site selectors
  for (const [host, sel] of SITE_SELECTORS) {
    if (!host.test(location.hostname)) continue;
    const el = document.querySelector(sel) as HTMLElement | null;
    // innerText (not textContent): the element is rendered, so innerText yields real
    // line breaks at block boundaries instead of gluing paragraphs together (E8).
    const txt = cleanText(el?.innerText || '');
    if (txt.length > 400) { log('Used site selector for', location.hostname); return buildResult(document.title, txt); }
  }

  // 3. Readability on the live document
  const r = parseDocWithReadability(document.cloneNode(true) as Document);
  if (r) return buildResult(r.title, r.text);

  // 4. Last resort: visible body text
  const body = cleanText(document.body?.innerText || '');
  if (body.length > 250) { log('Fell back to body.innerText'); return buildResult(document.title, body); }

  log('No readable content found');
  return null;
}

// ── Page highlighting (CSS Custom Highlight API, word-token based) ──────────────
//
// We match by WORDS rather than raw character offsets. The spoken sentence text is
// heavily normalized (whitespace collapsed, [1] footnotes stripped) so it never matches
// the raw DOM character-for-character. Tokenizing both sides into normalized words and
// matching word runs is robust to whitespace, footnote markers, and HTML entities.

function findArticleElement(): Element {
  return document.querySelector(
    'article, [role="main"], main, .post-content, .article-body, .entry-content, .post-body, #content article'
  ) || document.body;
}

const normWord = (s: string) => s.toLowerCase().replace(/[^a-z0-9À-ɏ]/g, '');

function buildWordIndex() {
  const root = findArticleElement();
  words = [];
  highlightCursor = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const tag = (n.parentElement?.tagName || '').toLowerCase();
      if (['script', 'style', 'noscript', 'nav', 'header', 'footer'].includes(tag)) {
        return NodeFilter.FILTER_REJECT;
      }
      if (!n.textContent || !n.textContent.trim()) return NodeFilter.FILTER_REJECT;
      // Skip our own injected UI
      if ((n.parentElement as HTMLElement)?.closest?.('#spiel-panel-host, #spiel-sel-host')) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node: Text | null;
  while ((node = walker.nextNode() as Text)) {
    const t = node.textContent || '';
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) {
      const nw = normWord(m[0]);
      if (nw) words.push({ w: nw, node, s: m.index, e: m.index + m[0].length });
    }
  }
  wordsBuilt = true;
  log(`Word index built: ${words.length} words`);
}

// The default 13%-alpha pink is invisible on dark sites — check the page's real
// background and use a stronger, brighter highlight there.
function pageIsDark(): boolean {
  for (const el of [document.body, document.documentElement]) {
    const bg = el && getComputedStyle(el).backgroundColor;
    const m = bg?.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (!m) continue;
    if (m[4] !== undefined && parseFloat(m[4]) === 0) continue; // transparent — look further up
    const lum = 0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3];
    return lum < 128;
  }
  return false; // no opaque background found — browsers default to white
}

function injectHighlightCSS() {
  if (document.getElementById('spiel-highlight-style')) return;
  const dark = pageIsDark();
  const reading = dark ? 'rgba(255, 110, 130, 0.28)' : 'rgba(255, 56, 92, 0.13)';
  const word    = dark ? 'rgba(255, 110, 130, 0.55)' : 'rgba(255, 56, 92, 0.42)';
  const style = document.createElement('style');
  style.id = 'spiel-highlight-style';
  style.textContent = `
    ::highlight(spiel-reading) {
      background-color: ${reading};
      color: inherit;
      border-radius: 2px;
    }
    ::highlight(spiel-word) {
      background-color: ${word};
      color: inherit;
      border-radius: 2px;
    }
  `;
  document.head.appendChild(style);
}

// Scan for a contiguous run of words matching the target sequence starting at `from`,
// tolerating up to 2 stray tokens (footnote numbers, stray symbols).
function scanWordRun(target: string[], from: number): { start: number; end: number; indices: number[] } | null {
  const n = words.length;
  const t = target.length;
  if (!t) return null;
  for (let i = Math.max(0, from); i < n; i++) {
    if (words[i].w !== target[0] && !words[i].w.startsWith(target[0])) continue;
    const indices = [i];
    let k = 1, j = i + 1, skips = 0;
    while (k < t && j < n) {
      const a = words[j].w, b = target[k];
      if (a === b || a.startsWith(b) || b.startsWith(a)) { indices.push(j); k++; j++; }
      // Stray budget scales with sentence length: extraction legitimately skips DOM
      // words the page still has (headings between paragraphs, footnote markers,
      // skip-filtered [refs]/URLs). A flat cap of 2 failed real articles (E12).
      else { skips++; j++; if (skips > Math.min(12, Math.max(3, Math.floor(t / 4)))) break; }
    }
    if (k === t) return { start: i, end: j - 1, indices };
  }
  return null;
}

// Searches forward from the last match first (sentences arrive in document order).
function findWordRun(target: string[]): { start: number; end: number; indices: number[] } | null {
  return scanWordRun(target, highlightCursor) || scanWordRun(target, 0);
}

// ── Sentence → DOM alignment (click-to-jump + time-left) ───────────────────────

let articleSentences: string[] = [];
let sentenceWordCounts: number[] = [];
let sentenceRuns: Array<{ start: number; end: number } | null> = [];
let curSpeed = 1.0;

const WPM_BASE = 175; // Kokoro af_* voices measure ~175 wpm at 1×

function setArticleSentences(sentences: string[]): void {
  articleSentences = sentences || [];
  sentenceWordCounts = articleSentences.map(s => s.split(/\s+/).filter(Boolean).length);
  sentenceRuns = [];
}

// Align every sentence to a word run once, walking forward through the document.
// Gives O(1) clicked-word → sentence lookup.
function buildSentenceRuns(): void {
  sentenceRuns = [];
  let cursor = 0;
  for (const s of articleSentences) {
    const target = s.split(/\s+/).map(normWord).filter(Boolean);
    const run = target.length ? (scanWordRun(target, cursor) || scanWordRun(target, 0)) : null;
    sentenceRuns.push(run ? { start: run.start, end: run.end } : null);
    if (run) cursor = run.end + 1;
  }
  log(`Sentence runs built: ${sentenceRuns.filter(Boolean).length}/${articleSentences.length} aligned`);
}

// Diagnostic twin of scanWordRun (used by DEBUG_MATCH / scripts/diagnose-page.mjs):
// same algorithm, but on failure reports the best attempt and the exact token pair
// where matching broke — so real-page failures are debuggable instead of mysterious.
function debugScan(target: string[], from: number): { matched: boolean; k: number; failA?: string; failB?: string } {
  const n = words.length;
  let best = { k: 0, failA: '', failB: '' };
  for (let i = Math.max(0, from); i < n; i++) {
    if (words[i].w !== target[0] && !words[i].w.startsWith(target[0])) continue;
    let k = 1, j = i + 1, skips = 0, failA = '', failB = '';
    const budget = Math.min(12, Math.max(3, Math.floor(target.length / 4))); // keep in sync with scanWordRun
    while (k < target.length && j < n) {
      const a = words[j].w, b = target[k];
      if (a === b || a.startsWith(b) || b.startsWith(a)) { k++; j++; }
      else { skips++; j++; if (skips > budget) { failA = a; failB = b; break; } }
    }
    if (k === target.length) return { matched: true, k };
    if (k > best.k) best = { k, failA, failB };
  }
  return { matched: false, ...best };
}

function sentenceIndexForWord(wordIdx: number): number {
  for (let i = 0; i < sentenceRuns.length; i++) {
    const r = sentenceRuns[i];
    if (r && wordIdx >= r.start && wordIdx <= r.end) return i;
  }
  return -1;
}

function timeLeftLabel(fromIndex: number): string {
  if (!sentenceWordCounts.length) return '';
  let remaining = 0;
  for (let i = fromIndex; i < sentenceWordCounts.length; i++) remaining += sentenceWordCounts[i];
  const mins = remaining / (WPM_BASE * (curSpeed || 1));
  if (mins < 1) return '<1 min';
  return `~${Math.round(mins)} min`;
}

// Returns true when the sentence was located and highlighted in the page DOM —
// the caller uses this to hide the redundant caption (page highlight is the stage).
function highlightSentenceInPage(sentence: string, timestamps?: WordTs[]): boolean {
  stopWordClock();
  const HL = (CSS as any).highlights;
  if (!HL || !words.length) return false;
  HL.delete('spiel-reading');
  HL.delete('spiel-word');
  curRunIndices = [];
  curTs = [];

  const target = sentence.split(/\s+/).map(normWord).filter(Boolean);
  if (!target.length) return false;

  const match = findWordRun(target);
  if (!match) { log('Highlight: no match for sentence'); return false; }

  try {
    const a = words[match.start];
    const b = words[match.end];
    const range = new Range();
    range.setStart(a.node, a.s);
    range.setEnd(b.node, b.e);
    HL.set('spiel-reading', new (window as any).Highlight(range));
    highlightCursor = match.end + 1;
    curRunIndices = match.indices;

    // Keep only alphanumeric timestamp tokens so they align 1:1 with our word tokens.
    if (timestamps && timestamps.length) {
      curTs = timestamps.filter(t => normWord(t.word));
    }

    // Auto-scroll to keep the spoken text comfortably in view
    const rect = range.getBoundingClientRect();
    const vh = window.innerHeight;
    if (rect.height > 0 && (rect.top < 120 || rect.bottom > vh - 120)) {
      (a.node.parentElement as HTMLElement)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return true;
  } catch (e) {
    log('Highlight error:', e);
    return false;
  }
}

// Highlight the di-th word of the current sentence run.
function highlightRunIndex(di: number) {
  const HL = (CSS as any).highlights;
  if (!HL) return;
  const m = curRunIndices.length;
  if (!m) return;
  const idx = curRunIndices[Math.max(0, Math.min(m - 1, di))];
  const wr = words[idx];
  if (!wr) return;
  try {
    const range = new Range();
    range.setStart(wr.node, wr.s);
    range.setEnd(wr.node, wr.e);
    HL.set('spiel-word', new (window as any).Highlight(range));
  } catch { /* node may have changed; ignore */ }
}

// Highlight the di-th word of the current sentence INSIDE the floating panel caption.
// Independent of page DOM, so it drives the follow-along for PDFs.
function highlightPanelWord(di: number) {
  if (!panelWords.length) return;
  const idx = Math.max(0, Math.min(panelWords.length - 1, di));
  if (idx === panelActiveWord) return;
  if (panelActiveWord >= 0 && panelWords[panelActiveWord]) panelWords[panelActiveWord].classList.remove('active');
  const el = panelWords[idx];
  el.classList.add('active');
  panelActiveWord = idx;
  // Summary modal handles its own sentence-level scrolling; only the caption needs
  // per-word scroll. Never scroll the host page from here.
  if (summaryShadow && summaryActiveSent >= 0) return;
  const cap = panelShadow?.getElementById('spiel-caption') as HTMLElement | null;
  if (cap && cap.scrollHeight > cap.clientHeight) {
    cap.scrollTo({ top: el.offsetTop - cap.clientHeight / 2 + el.offsetHeight / 2, behavior: 'smooth' });
  }
}

// Counts usually match 1:1, but Kokoro expands numbers/abbreviations in its timestamps
// ("$3.5" → "three point five dollars"). When they differ, map proportionally so the
// word highlight stays monotonic and in the right region instead of drifting.
function tsToRunIndex(tsIndex: number): number {
  const m = curRunIndices.length;
  const tn = curTs.length;
  if (tn <= 1 || tn === m) return Math.min(tsIndex, m - 1);
  return Math.round((tsIndex * (m - 1)) / (tn - 1));
}

function wordTick() {
  if (!wordActive) return;
  const elapsed = (performance.now() - clockStart - pausedAccum) / 1000;
  const m = curRunIndices.length;

  // Find the last timestamp whose start time has passed
  let i = -1;
  for (let k = 0; k < curTs.length; k++) {
    if (curTs[k].start <= elapsed) i = k; else break;
  }
  let di = i >= 0 ? tsToRunIndex(i) : -1;

  // Kokoro sometimes returns fewer timestamps than it speaks words — the highlight
  // used to freeze on the last timestamped word while the voice read on. If we're
  // past the last timestamp but the clip is still playing, interpolate the remaining
  // words over the real audio duration.
  const lastTsEnd = curTs.length ? curTs[curTs.length - 1].end : 0;
  if (curDur > 0 && elapsed > lastTsEnd && m > 0) {
    const proj = Math.round((elapsed / curDur) * (m - 1));
    di = Math.max(di, Math.min(m - 1, proj));
  }
  if (di >= 0) highlightRunIndex(di);

  // Panel caption karaoke — mapped by fraction of the sentence, independent of page words
  // (so PDFs get a follow-along highlight even with no page DOM to paint).
  const pn = panelWords.length;
  if (pn > 0) {
    let frac = 0;
    if (curTs.length > 1 && i >= 0) frac = i / (curTs.length - 1);
    if (curDur > 0) frac = Math.max(frac, Math.min(1, elapsed / curDur));
    highlightPanelWord(Math.round(Math.min(1, Math.max(0, frac)) * (pn - 1)));
  }

  const endT = Math.max(lastTsEnd, curDur);
  if (endT > 0 && elapsed > endT + 0.2) { wordActive = false; return; }
  wordRaf = requestAnimationFrame(wordTick);
}

function startWordClock(durationS?: number) {
  // Run if we can drive EITHER the page highlight (articles) or the panel caption (PDFs).
  if (!curTs.length || (!curRunIndices.length && !panelWords.length)) return;
  stopWordClock();
  curDur = durationS && durationS > 0 ? durationS : 0;
  clockStart = performance.now();
  pausedAccum = 0;
  wordActive = true;
  wordRaf = requestAnimationFrame(wordTick);
}

function pauseWordClock() {
  if (!wordActive) return;
  wordActive = false;
  pauseStart = performance.now();
  if (wordRaf != null) { cancelAnimationFrame(wordRaf); wordRaf = null; }
}

function resumeWordClock() {
  if (!curTs.length || wordActive) return;
  if (pauseStart) pausedAccum += performance.now() - pauseStart;
  pauseStart = 0;
  wordActive = true;
  wordRaf = requestAnimationFrame(wordTick);
}

function stopWordClock() {
  wordActive = false;
  pauseStart = 0;
  if (wordRaf != null) { cancelAnimationFrame(wordRaf); wordRaf = null; }
}

function clearHighlight() {
  stopWordClock();
  const HL = (CSS as any).highlights;
  if (HL) { HL.delete('spiel-reading'); HL.delete('spiel-word'); }
  curRunIndices = [];
  curTs = [];
  if (panelActiveWord >= 0 && panelWords[panelActiveWord]) panelWords[panelActiveWord].classList.remove('active');
  panelActiveWord = -1;
}

// ── Panel CSS ──────────────────────────────────────────────────────────────────

const PANEL_CSS = `
:host {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 2147483647;
  font-family: 'Avenir Next', 'SF Pro Text', -apple-system, 'Segoe UI', Roboto, sans-serif;

  --surface:  rgba(255, 255, 255, 0.97);
  --surface2: #f2f2f4;
  --text:     #1b1b1f;
  --muted:    #8a8b93;
  --border:   rgba(0, 0, 0, 0.09);
  --accent:   #FF385C;
}

@media (prefers-color-scheme: dark) {
  :host {
    --surface:  rgba(24, 25, 30, 0.96);
    --surface2: #2c2d34;
    --text:     #f2f2f5;
    --border:   rgba(255, 255, 255, 0.1);
    --accent:   #FF5674;
  }
}

.player {
  width: 296px;
  background: var(--surface);
  backdrop-filter: blur(24px) saturate(160%);
  -webkit-backdrop-filter: blur(24px) saturate(160%);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
  color: var(--text);
  user-select: none;
  overflow: hidden;
  cursor: grab;
}

.player:active { cursor: grabbing; }

.progress { height: 2px; background: var(--surface2); }
.progress-fill { height: 100%; width: 0%; background: var(--accent); transition: width 0.4s ease; }

/* Reading caption — the current sentence, with the spoken word highlighted (karaoke).
   Works for articles AND PDFs, and is the follow-along view when the page can't be scrolled. */
.caption {
  padding: 13px 15px 4px;
  max-height: 96px;
  overflow-y: auto;
  font-size: 14.5px;
  line-height: 1.58;
  letter-spacing: 0.005em;
  color: var(--text);
  scrollbar-width: thin;
  scrollbar-color: var(--surface2) transparent;
}
.caption:empty { display: none; }
.caption .w {
  border-radius: 4px;
  padding: 0 1.5px;
  transition: background 0.1s ease, color 0.1s ease;
}
.caption .w.active { background: var(--accent); color: #fff; }

.row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 10px 12px;
}

.icon-btn {
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.15s, color 0.15s;
}

.icon-btn:hover { background: var(--surface2); color: var(--text); }
.icon-btn svg { width: 18px; height: 18px; fill: currentColor; }

.play-btn { width: 40px; height: 40px; background: var(--accent); color: #fff; }
.play-btn:hover { background: var(--accent); color: #fff; filter: brightness(0.93); }
.play-btn svg { width: 20px; height: 20px; }

.meta {
  margin-left: auto;
  display: flex;
  gap: 4px;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  padding: 0 4px;
}

#spiel-timeleft:not(:empty)::before { content: '·'; margin-right: 4px; }

.settings {
  display: none;
  flex-direction: column;
  gap: 10px;
  border-top: 1px solid var(--border);
  padding: 12px;
}

.player.open .settings { display: flex; }
.player.open #spiel-settings { color: var(--accent); }

.set-row { display: flex; align-items: center; gap: 8px; }

.set-label {
  width: 44px;
  flex-shrink: 0;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}

.voice-select {
  flex: 1;
  background: var(--surface2);
  border: none;
  border-radius: 8px;
  padding: 7px 26px 7px 10px;
  font-size: 12.5px;
  color: var(--text);
  font-family: inherit;
  cursor: pointer;
  outline: none;
  appearance: none;
  -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='%238a8b93'%3E%3Cpath d='M7 10l5 5 5-5z'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 8px center;
}

.chips { flex: 1; display: flex; flex-wrap: wrap; gap: 4px; }

.chip {
  border: none;
  background: var(--surface2);
  color: var(--muted);
  border-radius: 999px;
  padding: 5px 8px;
  font-size: 10.5px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.chip:hover { color: var(--text); }
.chip.active { background: var(--accent); color: #fff; }
`;

// ── Selection button CSS ───────────────────────────────────────────────────────

const SEL_CSS = `
:host {
  position: fixed;
  z-index: 2147483646;
  font-family: 'Avenir Next', 'SF Pro Text', -apple-system, 'Segoe UI', sans-serif;
}
.sel-btn {
  background: white;
  border: none;
  border-radius: 20px;
  padding: 6px 12px;
  font-size: 13px;
  font-weight: 600;
  color: #FF385C;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15), 0 1px 4px rgba(0, 0, 0, 0.08);
  white-space: nowrap;
  transition: transform 0.1s, box-shadow 0.1s;
  font-family: 'Avenir Next', 'SF Pro Text', -apple-system, 'Segoe UI', sans-serif;
  display: flex;
  align-items: center;
  gap: 6px;
}
.sel-btn:hover {
  transform: scale(1.04);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
}
.sel-btn svg { width: 13px; height: 13px; fill: #FF385C; }
@media (prefers-color-scheme: dark) {
  .sel-btn { background: #26272e; color: #ff6e82; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5); }
  .sel-btn svg { fill: #ff6e82; }
}
@keyframes spin { to { transform: rotate(360deg); } }
`;

// ── Selection button ───────────────────────────────────────────────────────────

let pendingSelText = '';

const SEL_BTN_IDLE_HTML = `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg> Play selection`;

function showSelectionButton(text: string, x: number, y: number): void {
  pendingSelText = text;

  if (!selBtnHost) {
    selBtnHost = document.createElement('div');
    selBtnHost.id = 'spiel-sel-host';
    document.body.appendChild(selBtnHost);
    selBtnShadow = selBtnHost.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = SEL_CSS;

    const btn = document.createElement('button');
    btn.className = 'sel-btn';
    btn.innerHTML = SEL_BTN_IDLE_HTML;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!pendingSelText) return;
      log('Play selection clicked:', pendingSelText.slice(0, 60));
      // Show brief loading state before hiding
      btn.innerHTML = `<svg viewBox="0 0 24 24" style="animation:spin 1s linear infinite"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg> Loading...`;
      btn.style.opacity = '0.7';
      btn.style.pointerEvents = 'none';
      chrome.runtime.sendMessage({ type: 'PLAY_SELECTION', text: pendingSelText });
      // Hide after short delay so user sees feedback
      setTimeout(hideSelectionButton, 800);
    });

    selBtnShadow.appendChild(style);
    selBtnShadow.appendChild(btn);
  }

  // The button is REUSED across selections — reset it, or the "Loading…" state from a
  // previous click sticks forever (dead spinner on every selection after the first).
  const existingBtn = selBtnShadow!.querySelector('.sel-btn') as HTMLButtonElement | null;
  if (existingBtn) {
    existingBtn.innerHTML = SEL_BTN_IDLE_HTML;
    existingBtn.style.opacity = '';
    existingBtn.style.pointerEvents = '';
  }

  const vw = window.innerWidth;
  const W = 160;
  const left = Math.min(Math.max(x - W / 2, 8), vw - W - 8);
  const top  = Math.max(y - 52, 8);

  selBtnHost.style.cssText = `position:fixed;left:${left}px;top:${top}px;display:block;`;
  if (selHideTimer) clearTimeout(selHideTimer);
  selHideTimer = setTimeout(hideSelectionButton, 8000);
}

function hideSelectionButton(): void {
  if (selHideTimer) { clearTimeout(selHideTimer); selHideTimer = null; }
  if (selBtnHost) selBtnHost.style.display = 'none';
  pendingSelText = '';
}

// ── Floating panel ─────────────────────────────────────────────────────────────

const fmtSpeed = (s: number) => `${parseFloat(s.toFixed(2))}×`;

// Exactly 4 curated voices, named like people (DESIGN.md). The name is the Kokoro
// voice's own suffix so logs stay traceable; the raw ID is never shown.
const VOICES: Array<{ id: string; label: string }> = [
  { id: 'af_heart',   label: 'Heart — American female · warm' },
  { id: 'af_bella',   label: 'Bella — American female · expressive' },
  { id: 'am_michael', label: 'Michael — American male · deep' },
  { id: 'bf_emma',    label: 'Emma — British female · calm' },
];

const SPEED_PRESETS = [0.75, 1, 1.25, 1.5, 2, 2.5, 3];

const PLAY_ICON  = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';

function buildVoiceSelect(select: HTMLSelectElement, selected: string): void {
  select.innerHTML = '';
  const list = [...VOICES];
  if (!list.some(v => v.id === selected)) {
    // A previously-saved voice outside the curated 4 stays usable.
    const suffix = selected.split('_')[1] || selected;
    list.push({ id: selected, label: suffix.charAt(0).toUpperCase() + suffix.slice(1) + ' — current voice' });
  }
  for (const v of list) {
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = v.label;
    select.appendChild(o);
  }
  select.value = selected;
}

function buildSpeedChips(container: HTMLElement, current: number, onPick: (s: number) => void): void {
  container.innerHTML = '';
  for (const sp of SPEED_PRESETS) {
    const b = document.createElement('button');
    b.className = 'chip' + (Math.abs(sp - current) < 0.01 ? ' active' : '');
    b.textContent = fmtSpeed(sp);
    b.addEventListener('click', () => {
      container.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      b.classList.add('active');
      onPick(sp);
    });
    container.appendChild(b);
  }
}

function createPanel(title: string, voice: string, speed: number, isSelection: boolean): void {
  if (panelHost) removePanel();

  panelHost = document.createElement('div');
  panelHost.id = 'spiel-panel-host';
  panelHost.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:2147483647;';
  document.body.appendChild(panelHost);
  panelShadow = panelHost.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = PANEL_CSS;

  const panel = document.createElement('div');
  panel.id = 'spiel-panel';
  panel.className = 'player';
  // Selection playback carries its own display title ("Selection" or "Summary").
  panel.title = isSelection ? `Spiel — reading ${(title || 'selection').toLowerCase()}` : `Spiel — ${title}`;
  panel.innerHTML = `
    <div class="progress"><div class="progress-fill" id="spiel-progress"></div></div>
    <div class="caption" id="spiel-caption"></div>
    <div class="row">
      <button class="icon-btn" id="spiel-prev" title="Previous sentence">
        <svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>
      </button>
      <button class="icon-btn play-btn" id="spiel-playpause" title="Pause">${PAUSE_ICON}</button>
      <button class="icon-btn" id="spiel-next" title="Next sentence">
        <svg viewBox="0 0 24 24"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/></svg>
      </button>
      <div class="meta"><span id="spiel-progress-label">–/–</span><span id="spiel-timeleft"></span></div>
      <button class="icon-btn" id="spiel-settings" title="Voice & speed">
        <svg viewBox="0 0 24 24"><path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"/></svg>
      </button>
      <button class="icon-btn" id="spiel-close" title="Close">
        <svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
    </div>
    <div class="settings">
      <div class="set-row">
        <span class="set-label">Voice</span>
        <select class="voice-select" id="spiel-voice"></select>
      </div>
      <div class="set-row">
        <span class="set-label">Speed</span>
        <div class="chips" id="spiel-speeds"></div>
      </div>
    </div>
  `;

  panelShadow.appendChild(style);
  panelShadow.appendChild(panel);

  const voiceSel = panelShadow.getElementById('spiel-voice') as HTMLSelectElement;
  buildVoiceSelect(voiceSel, voice);
  buildSpeedChips(panelShadow.getElementById('spiel-speeds') as HTMLElement, speed, (sp) => {
    curSpeed = sp;
    chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', speed: sp });
    chrome.storage.sync.set({ speed: sp });
  });

  // All document-level listeners share this signal so removePanel() can unbind them.
  panelAbort = new AbortController();
  const sig = panelAbort.signal;

  // ── Drag — the whole card, except interactive elements ──
  let isDragging = false;
  let dragStartX = 0, dragStartY = 0, hostStartX = 0, hostStartY = 0;

  panel.addEventListener('mousedown', (e: Event) => {
    const me = e as MouseEvent;
    if ((me.target as Element).closest('button, select, .chip')) return;
    isDragging = true;
    const rect = panelHost!.getBoundingClientRect();
    dragStartX = me.clientX;
    dragStartY = me.clientY;
    hostStartX = rect.left;
    hostStartY = rect.top;
    panelHost!.style.left   = rect.left + 'px';
    panelHost!.style.top    = rect.top + 'px';
    panelHost!.style.right  = 'auto';
    panelHost!.style.bottom = 'auto';
    me.preventDefault();
  }, { signal: sig });

  document.addEventListener('mousemove', (e: MouseEvent) => {
    if (!isDragging || !panelHost) return;
    const newX = Math.max(0, Math.min(window.innerWidth - 300, hostStartX + e.clientX - dragStartX));
    const newY = Math.max(0, Math.min(window.innerHeight - 60, hostStartY + e.clientY - dragStartY));
    panelHost.style.left = newX + 'px';
    panelHost.style.top  = newY + 'px';
  }, { signal: sig });

  document.addEventListener('mouseup', () => { isDragging = false; }, { signal: sig });

  // ── Click-to-listen-from-here ──
  // Click a word in the article and playback jumps to its sentence. Skipped for
  // interactive elements, active text selections, and our own UI.
  // Double-click is an EXPLICIT "read from here": a double-click selects the word
  // under the cursor, which used to trip the active-selection guard and silently
  // eat the jump — so dblclick bypasses that guard and clears its own selection.
  const jumpFromPoint = (e: MouseEvent, fromDblclick: boolean): void => {
    if (!extensionAlive()) return; // orphaned after reload (E11)
    if (isSelectionMode || !wordsBuilt || !sentenceRuns.length) return;
    const tgt = e.target as HTMLElement;
    if (!tgt || tgt.closest?.('#spiel-panel-host, #spiel-sel-host')) return;
    if (tgt.closest?.('a, button, input, textarea, select, [contenteditable], video, audio')) return;
    // Respect real user selections on single click only — dblclick made its own.
    if (!fromDblclick && (window.getSelection()?.toString().trim().length ?? 0) > 0) return;

    const caret = (document as any).caretRangeFromPoint?.(e.clientX, e.clientY);
    const node = caret?.startContainer;
    if (!node || node.nodeType !== Node.TEXT_NODE || !tgt.contains(node)) return;

    const offset = caret.startOffset;
    let wordIdx = -1;
    for (let i = 0; i < words.length; i++) {
      if (words[i].node === node && offset >= words[i].s && offset <= words[i].e) { wordIdx = i; break; }
      if (words[i].node === node && wordIdx === -1) wordIdx = i; // same node fallback: first word in it
    }
    if (wordIdx < 0) return;
    const sIdx = sentenceIndexForWord(wordIdx);
    if (sIdx < 0) return;
    if (fromDblclick) {
      // The word-selection was a side effect of the double-click, not intent —
      // clear it so the "Play selection" pill doesn't fight the jump.
      window.getSelection()?.removeAllRanges();
      hideSelectionButton();
    }
    log('Click-to-jump → sentence', sIdx, fromDblclick ? '(dblclick)' : '');
    chrome.runtime.sendMessage({ type: 'JUMP_TO', index: sIdx });
  };

  document.addEventListener('click', (e: MouseEvent) => jumpFromPoint(e, false), { signal: sig });
  document.addEventListener('dblclick', (e: MouseEvent) => jumpFromPoint(e, true), { signal: sig });

  // ── Keyboard shortcuts (active only while the panel is open) ──
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (!extensionAlive()) return; // orphaned after reload (E11)
    if (!panelHost) return;
    const tgt = e.target as HTMLElement;
    const editable = tgt && (tgt.isContentEditable ||
      /^(input|textarea|select)$/i.test(tgt.tagName));
    if (editable) return;
    if (e.code === 'Space') {
      e.preventDefault();
      chrome.runtime.sendMessage({ type: isPaused ? 'RESUME' : 'PAUSE' });
    } else if (e.code === 'ArrowRight' && e.shiftKey) {
      e.preventDefault();
      chrome.runtime.sendMessage({ type: 'SKIP_NEXT' });
    } else if (e.code === 'ArrowLeft' && e.shiftKey) {
      e.preventDefault();
      chrome.runtime.sendMessage({ type: 'SKIP_PREV' });
    }
  }, { signal: sig });

  // ── Controls ──
  panelShadow.getElementById('spiel-close')!.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'STOP' });
  });

  panelShadow.getElementById('spiel-settings')!.addEventListener('click', () => {
    panel.classList.toggle('open');
  });

  panelShadow.getElementById('spiel-playpause')!.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: isPaused ? 'RESUME' : 'PAUSE' });
  });

  panelShadow.getElementById('spiel-prev')!.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'SKIP_PREV' });
  });

  panelShadow.getElementById('spiel-next')!.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'SKIP_NEXT' });
  });

  voiceSel.addEventListener('change', () => {
    chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', voice: voiceSel.value });
    chrome.storage.sync.set({ voice: voiceSel.value });
  });

  log('Panel created');
}

// Render the current sentence into the caption as individual word spans we can highlight.
function renderPanelSentence(sentence: string): void {
  const cap = panelShadow?.getElementById('spiel-caption') as HTMLElement | null;
  panelWords = [];
  panelActiveWord = -1;
  if (!cap) return;
  cap.textContent = '';
  for (const part of (sentence || '').split(/(\s+)/)) {
    if (!part) continue;
    if (/^\s+$/.test(part)) { cap.appendChild(document.createTextNode(' ')); continue; }
    const span = document.createElement('span');
    span.className = 'w';
    span.textContent = part;
    cap.appendChild(span);
    panelWords.push(span);
  }
  cap.scrollTop = 0;
}

function updatePanel(sentence: string, index: number, total: number, timestamps?: WordTs[], pageMatched = false): void {
  if (!panelShadow) return;
  const fill = panelShadow.getElementById('spiel-progress') as HTMLElement;
  const lbl  = panelShadow.getElementById('spiel-progress-label');
  const tl   = panelShadow.getElementById('spiel-timeleft');
  const pp   = panelShadow.getElementById('spiel-playpause');
  if (fill) fill.style.width = `${((index + 1) / total) * 100}%`;
  if (lbl)  lbl.textContent  = `${index + 1}/${total}`;
  if (tl)   tl.textContent   = timeLeftLabel(index);
  if (pp)   { pp.innerHTML = PAUSE_ICON; (pp as HTMLElement).title = 'Pause'; }
  isPaused = false;

  // Karaoke stage, in priority order: the page itself (article highlight landed →
  // caption would be a duplicate), the summary modal, else the caption (PDFs,
  // selections, and sentences the page matcher can't find — the E8 fallback).
  const cap = panelShadow.getElementById('spiel-caption') as HTMLElement | null;
  if (pageMatched) {
    if (cap) cap.textContent = '';
    panelWords = []; panelActiveWord = -1;
  } else if (isSelectionMode && focusSummarySentence(index)) {
    if (cap) cap.textContent = ''; // modal is the stage; don't duplicate below it
  } else {
    renderPanelSentence(sentence);
  }
  // Timing seed: highlightSentenceInPage already set curTs when the page matched.
  if (!pageMatched) curTs = (timestamps || []).filter(t => normWord(t.word));
}

function setPanelPaused(paused: boolean): void {
  isPaused = paused;
  if (!panelShadow) return;
  const pp = panelShadow.getElementById('spiel-playpause');
  if (pp) {
    pp.innerHTML = paused ? PLAY_ICON : PAUSE_ICON;
    (pp as HTMLElement).title = paused ? 'Play' : 'Pause';
  }
}

function removePanel(): void {
  if (panelAbort) { panelAbort.abort(); panelAbort = null; }
  if (panelHost) { panelHost.remove(); panelHost = null; panelShadow = null; }
  clearHighlight();
  words = [];
  wordsBuilt = false;
  panelWords = [];
  panelActiveWord = -1;
  isSelectionMode = false;
  setArticleSentences([]);
}

// ── Summary modal ──────────────────────────────────────────────────────────────

const SUMMARY_CSS = `
:host { position: fixed; inset: 0; z-index: 2147483647;
  font-family: 'Avenir Next', 'SF Pro Text', -apple-system, 'Segoe UI', Roboto, sans-serif;
  --surface: #ffffff; --text: #1b1b1f; --muted: #8a8b93; --border: rgba(0,0,0,0.09);
  --accent: #FF385C; --scrim: rgba(250, 247, 246, 0.55); --read: rgba(255, 56, 92, 0.10);
}
@media (prefers-color-scheme: dark) {
  :host { --surface: #1d1a1d; --text: #f2f2f5; --muted: #9c938e; --border: rgba(255,255,255,0.1);
          --accent: #FF5674; --scrim: rgba(12, 10, 12, 0.6); --read: rgba(255, 86, 116, 0.14); }
}
.scrim { position: absolute; inset: 0; background: var(--scrim);
  backdrop-filter: blur(7px) saturate(120%); -webkit-backdrop-filter: blur(7px) saturate(120%);
  animation: fade .18s ease; }
@keyframes fade { from { opacity: 0 } to { opacity: 1 } }
.card { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  width: min(660px, calc(100vw - 48px)); max-height: min(78vh, 820px);
  display: flex; flex-direction: column; background: var(--surface); color: var(--text);
  border: 1px solid var(--border); border-radius: 20px;
  box-shadow: 0 24px 80px rgba(0,0,0,.3), 0 2px 8px rgba(0,0,0,.12);
  animation: pop .22s cubic-bezier(.2,.9,.3,1.2); overflow: hidden; }
@keyframes pop { from { opacity: 0; transform: translate(-50%, -47%) scale(.97) } to { opacity: 1; transform: translate(-50%, -50%) scale(1) } }
.head { display: flex; align-items: center; gap: 12px; padding: 18px 20px 14px; border-bottom: 1px solid var(--border); }
.mark { width: 34px; height: 34px; border-radius: 9px; background: var(--accent); flex-shrink: 0;
  display: flex; align-items: flex-end; justify-content: center; gap: 2.5px; padding: 8px 7px; }
.mark i { width: 3.5px; border-radius: 2px; background: #fff; display: block; }
.mark i:nth-child(1){height:36%} .mark i:nth-child(2){height:65%} .mark i:nth-child(3){height:100%}
.mark i:nth-child(4){height:65%} .mark i:nth-child(5){height:36%}
.titles { min-width: 0; }
.kicker { font-size: 11px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--accent); }
.title { font-size: 15px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.x { margin-left: auto; width: 32px; height: 32px; border: none; border-radius: 999px; background: transparent;
  color: var(--muted); font-size: 20px; line-height: 1; cursor: pointer; flex-shrink: 0; }
.x:hover { background: var(--read); color: var(--text); }
.body { padding: 20px 24px 12px; overflow-y: auto; font-size: 16.5px; line-height: 1.78;
  letter-spacing: .003em; scrollbar-width: thin; }
.body .flow { margin: 0; }
.body .s { border-radius: 6px; padding: 1px 3px; transition: background .2s ease;
  -webkit-box-decoration-break: clone; box-decoration-break: clone; }
.body .s.active { background: var(--read); }
.body .w { border-radius: 4px; padding: 0 1px; }
.body .w.active { background: var(--accent); color: #fff; }
.foot { display: flex; align-items: center; gap: 14px; padding: 14px 20px 18px; border-top: 1px solid var(--border); }
.listen { display: inline-flex; align-items: center; gap: 9px; background: var(--accent); color: #fff;
  border: none; border-radius: 12px; padding: 12px 22px; font-size: 15px; font-weight: 650;
  font-family: inherit; cursor: pointer; transition: filter .15s, transform .05s; }
.listen:hover { filter: brightness(.93); } .listen:active { transform: translateY(1px); }
.listen svg { width: 16px; height: 16px; fill: currentColor; }
.hint { font-size: 12.5px; color: var(--muted); }
`;

function removeSummaryModal(): void {
  summaryAbort?.abort(); summaryAbort = null;
  summaryHost?.remove(); summaryHost = null; summaryShadow = null;
  summarySentSpans = []; summaryActiveSent = -1;
  // If the karaoke was pointed at modal spans, detach; the caption re-renders next sentence.
  panelWords = []; panelActiveWord = -1;
  // If the player was docked beneath the modal, send it back to its home corner.
  if (panelHost) panelHost.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:2147483647;';
}

function createSummaryModal(title: string, summary: string): void {
  removeSummaryModal();
  const sentences = splitIntoSentences(summary); // same splitter as playback → indices align

  summaryHost = document.createElement('div');
  summaryHost.id = 'spiel-summary-host';
  document.body.appendChild(summaryHost);
  summaryShadow = summaryHost.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = SUMMARY_CSS;
  summaryShadow.appendChild(style);

  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="head">
      <div class="mark"><i></i><i></i><i></i><i></i><i></i></div>
      <div class="titles"><div class="kicker">Summary</div><div class="title"></div></div>
      <button class="x" title="Close">✕</button>
    </div>
    <div class="body" id="spiel-sum-body"></div>
    <div class="foot">
      <button class="listen" id="spiel-sum-listen">
        <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg> Listen
      </button>
      <span class="hint">Words highlight as it reads · Esc to close</span>
    </div>`;
  (card.querySelector('.title') as HTMLElement).textContent = title || document.title || '';

  // One flowing paragraph; each playback sentence is an inline span. (The splitter cuts
  // the first sentence's opening clause for TTS latency — rendering per-sentence <p>s
  // exposed that as a broken paragraph. Inline spans read as natural prose and keep the
  // sentence indices aligned with playback.)
  const body = card.querySelector('#spiel-sum-body') as HTMLElement;
  const flow = document.createElement('p');
  flow.className = 'flow';
  summarySentSpans = sentences.map((s, i) => {
    const sent = document.createElement('span');
    sent.className = 's';
    const spans: HTMLElement[] = [];
    for (const part of s.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) { sent.appendChild(document.createTextNode(' ')); continue; }
      const w = document.createElement('span');
      w.className = 'w'; w.textContent = part;
      sent.appendChild(w); spans.push(w);
    }
    flow.appendChild(sent);
    if (i < sentences.length - 1) flow.appendChild(document.createTextNode(' '));
    return spans;
  });
  body.appendChild(flow);

  summaryShadow.appendChild(scrim);
  summaryShadow.appendChild(card);

  summaryAbort = new AbortController();
  const sig = summaryAbort.signal;
  (card.querySelector('.x') as HTMLElement).addEventListener('click', removeSummaryModal, { signal: sig });
  scrim.addEventListener('click', removeSummaryModal, { signal: sig });
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); removeSummaryModal(); }
  }, { signal: sig, capture: true });

  const listen = card.querySelector('#spiel-sum-listen') as HTMLButtonElement;
  listen.addEventListener('click', () => {
    if (!extensionAlive()) return;
    chrome.runtime.sendMessage({ type: 'PLAY_SUMMARY', text: summary });
  }, { signal: sig });

  log('Summary modal shown:', sentences.length, 'sentences');
}

// Point the karaoke at the modal's sentence `index`. Returns false if the modal
// isn't showing (caller falls back to the floating-player caption).
function focusSummarySentence(index: number): boolean {
  if (!summaryShadow || !summarySentSpans.length) return false;
  const spans = summarySentSpans[index];
  if (!spans) return false;
  if (summaryActiveSent >= 0) summarySentSpans[summaryActiveSent]?.[0]?.parentElement?.classList.remove('active');
  const p = spans[0]?.parentElement;
  p?.classList.add('active');
  p?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  if (panelActiveWord >= 0 && panelWords[panelActiveWord]) panelWords[panelActiveWord].classList.remove('active');
  panelWords = spans;
  panelActiveWord = -1;
  summaryActiveSent = index;
  return true;
}

// ── Selection detection ────────────────────────────────────────────────────────

document.addEventListener('mouseup', (e: MouseEvent) => {
  setTimeout(() => {
    // Orphaned after an extension reload? Go quiet instead of throwing (E11).
    if (!extensionAlive()) { try { panelHost?.remove(); selBtnHost?.remove(); } catch {} return; }
    // Don't pop up over editors / form fields / our own UI
    const tgt = e.target as HTMLElement;
    if (tgt && (tgt.isContentEditable || /^(input|textarea|select)$/i.test(tgt.tagName)
        || tgt.closest?.('#spiel-panel-host, #spiel-sel-host'))) {
      hideSelectionButton();
      return;
    }
    const text = window.getSelection()?.toString().trim() ?? '';
    if (text.length >= 20) {
      log('Selection detected:', text.slice(0, 60));
      showSelectionButton(text, e.clientX, e.clientY);
    } else {
      hideSelectionButton();
    }
  }, 10);
});

document.addEventListener('mousedown', (e: MouseEvent) => {
  if (!(e.target as Element)?.closest?.('#spiel-sel-host')) hideSelectionButton();
});

// ── Message handler ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
  log('Message:', message.type);

  if (message.type === 'GET_ARTICLE') {
    extractArticleCached().then(sendResponse).catch((e) => { err('extractArticle failed:', e); sendResponse(null); });
    return true; // async response
  }

  if (message.type === 'PREWARM_EXTRACT') {
    // Popup just opened — do the expensive extraction NOW so Play is instant.
    extractArticleCached().catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'SHOW_PLAYER') {
    hideSelectionButton(); // the player replaces the selection pill the moment it exists
    isSelectionMode = !!message.isSelection;
    curSpeed = message.speed || 1.0;
    setArticleSentences(message.sentences || []);
    createPanel(
      message.title || document.title,
      message.voice || 'af_heart',
      message.speed || 1.0,
      isSelectionMode
    );
    if (!isSelectionMode) {
      injectHighlightCSS();
      buildWordIndex();
      buildSentenceRuns();
    }
    // Summary playback with the modal open: ONE consistent control surface — the
    // floating player docks centered beneath the card and the modal's own Listen row
    // hides (it would duplicate the player). Restored on stop/close.
    if (isSelectionMode && summaryShadow && panelHost) {
      panelHost.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:18px;z-index:2147483647;';
      const foot = summaryShadow.querySelector('.foot') as HTMLElement | null;
      if (foot) foot.style.display = 'none';
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'SHOW_SUMMARY') {
    createSummaryModal(message.title || '', message.summary || '');
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'HIDE_PLAYER') {
    removePanel();
    hideSelectionButton();
    // Reading ended — bring the modal's Listen row back for a replay.
    const foot = summaryShadow?.querySelector('.foot') as HTMLElement | null;
    if (foot) foot.style.display = '';
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'UPDATE_PANEL') {
    log('UPDATE_PANEL sentence:', message.index, '/', message.total);
    // Speed may have been changed from the popup — keep panel chips + time-left in sync.
    if (typeof message.speed === 'number' && Math.abs(message.speed - curSpeed) > 0.001) {
      curSpeed = message.speed;
      const chips = panelShadow?.getElementById('spiel-speeds');
      if (chips) {
        chips.querySelectorAll('.chip').forEach(c => {
          c.classList.toggle('active', Math.abs(parseFloat(c.textContent || '0') - curSpeed) < 0.01);
        });
      }
    }
    // Page highlight FIRST — if it lands, the caption is redundant (the page is the
    // stage) and updatePanel hides it. Caption remains the stage for PDFs, selections,
    // and any sentence the page matcher can't find (E8 fallback).
    const pageMatched = !isSelectionMode && wordsBuilt
      ? highlightSentenceInPage(message.sentence, message.timestamps)
      : false;
    updatePanel(message.sentence, message.index, message.total, message.timestamps, pageMatched);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'WORD_CLOCK_START') {
    if (!isSelectionMode) startWordClock(message.durationS);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'PAUSE_PANEL') {
    isPaused = true;
    setPanelPaused(true);
    pauseWordClock();
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'RESUME_PANEL') {
    isPaused = false;
    setPanelPaused(false);
    resumeWordClock();
    sendResponse({ ok: true });
    return false;
  }

  // Sent the instant the user skips/jumps: freeze the highlight so it can't run ahead of
  // audio during the fetch gap. The next sentence's WORD_CLOCK_START restarts it in sync.
  if (message.type === 'HIGHLIGHT_STOP') {
    stopWordClock();
    const HL = (CSS as any).highlights;
    if (HL) HL.delete('spiel-word');
    if (panelActiveWord >= 0 && panelWords[panelActiveWord]) panelWords[panelActiveWord].classList.remove('active');
    panelActiveWord = -1;
    sendResponse({ ok: true });
    return false;
  }

  // Diagnostic: align every provided sentence against the page's word index and
  // report each failure with the token pair where it broke. Read-only; no UI.
  if (message.type === 'DEBUG_MATCH') {
    if (!wordsBuilt) buildWordIndex();
    const report: any[] = [];
    let cursor = 0;
    for (let i = 0; i < (message.sentences || []).length; i++) {
      const s: string = message.sentences[i];
      const target = s.split(/\s+/).map(normWord).filter(Boolean);
      let r = debugScan(target, cursor);
      if (!r.matched && cursor > 0) r = debugScan(target, 0);
      if (r.matched) cursor += 1; // real playback advances its cursor only on success
      report.push({
        i, matched: r.matched, len: target.length, bestK: r.matched ? target.length : r.k,
        failA: r.failA || '', failB: r.failB || '',
        text: s.slice(0, 80),
      });
    }
    sendResponse({ ok: true, totalWords: words.length, report });
    return false;
  }

  if (message.type === 'PING') {
    sendResponse({ ok: true });
    return false;
  }
});

log('Content script ready on:', window.location.hostname);
