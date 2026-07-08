// Spiel e2e smoke test — launches a real Chrome with dist/ loaded and verifies the
// core flows WITHOUT a human: content script injection, article extraction (the
// popup's direct path), the full TTS playback pipeline against the local engine,
// and zero uncaught extension errors. Run: node scripts/e2e-smoke.mjs
//
// Uses a scratch profile: the on-device Summarizer model isn't present there, so
// summarization is only availability-probed, not executed.
import { chromium } from 'playwright';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const results = [];
const ok = (name, detail = '') => { results.push({ name, pass: true, detail }); console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); };
const bad = (name, detail = '') => { results.push({ name, pass: false, detail }); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); };

// ── Test article served over real http (content scripts need http/https) ──
const ARTICLE = `<!doctype html><title>Spiel E2E Article</title><body>
  <article>
    <h1>The Dynamo and the Computer</h1>
    ${Array.from({ length: 12 }, (_, i) =>
      `<p>Paragraph ${i + 1}: The diffusion of general purpose technologies follows a protracted course. Several decades elapsed before factory reorganization unlocked the dynamo's full potential, a pattern with striking relevance to modern computing infrastructure today.</p>`).join('\n')}
  </article></body>`;
const server = http.createServer((_, res) => { res.setHeader('content-type', 'text/html'); res.end(ARTICLE); });
await new Promise(r => server.listen(8931, '127.0.0.1', r));

const userDir = mkdtempSync(path.join(os.tmpdir(), 'spiel-e2e-'));
const ctx = await chromium.launchPersistentContext(userDir, {
  channel: 'chromium', // full build — its new-headless supports MV3 extensions (headless shell does not)
  headless: true,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
});

const errors = [];
ctx.on('page', p => {
  p.on('pageerror', e => errors.push(`pageerror(${p.url().slice(0, 60)}): ${e.message}`));
  p.on('console', m => { if (m.type() === 'error' && /Spiel|spiel/.test(m.text())) errors.push(`console(${p.url().slice(0, 40)}): ${m.text().slice(0, 160)}`); });
});

try {
  // 1. Extension service worker up?
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 });
  const extId = new URL(sw.url()).host;
  ok('extension loaded', `id ${extId}`);

  // 2. Article tab + content script alive
  const article = await ctx.newPage();
  await article.goto('http://127.0.0.1:8931/', { waitUntil: 'domcontentloaded' });
  await article.waitForTimeout(600);

  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup/index.html`, { waitUntil: 'domcontentloaded' });
  await popup.waitForTimeout(400);

  // Spiel has no "tabs" permission (privacy), so query by ACTIVE tab — exactly what
  // the real popup does. Bring the article to front first; the popup tab keeps running.
  await article.bringToFront();
  await popup.waitForTimeout(300);
  const articleTab = await popup.evaluate(async () => {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    return t ? { id: t.id, url: t.url || '', title: t.title || '' } : null;
  });
  if (!articleTab) throw new Error('article tab not found from extension context');

  const ping = await popup.evaluate(async (tabId) => {
    try { return await chrome.tabs.sendMessage(tabId, { type: 'PING' }); } catch (e) { return { err: String(e) }; }
  }, articleTab.id);
  ping?.ok ? ok('content script responds to PING') : bad('content script PING', JSON.stringify(ping));

  // 3. THE PATH THAT FAILED FOR THE USER: popup's direct extraction
  const extract = await popup.evaluate(async (tab) => {
    try { return await popupExtractArticle(tab); } catch (e) { return { error: 'threw: ' + String(e) }; }
  }, articleTab);
  if (extract?.ok && extract.sentences?.length >= 5 && !/\w\.\w/.test(extract.sentences[1] || ''))
    ok('popupExtractArticle', `${extract.sentences.length} sentences, title "${extract.title}"`);
  else bad('popupExtractArticle', JSON.stringify(extract).slice(0, 200));

  // 4. Summarizer API surface (model won't be in this scratch profile — probe only)
  const sum = await popup.evaluate(async () => {
    if (!('Summarizer' in self)) return 'API absent';
    try { return String(await Summarizer.availability()); } catch (e) { return 'availability threw: ' + String(e); }
  });
  ok('Summarizer availability probe', sum);

  // 5. Full audio pipeline vs the LIVE local engine (fetch → offscreen → playing)
  const engineUp = await popup.evaluate(async () => {
    try { const r = await fetch('http://127.0.0.1:8880/health'); return r.ok; } catch { return false; }
  });
  if (!engineUp) {
    bad('voice engine reachable', 'skip playback test');
  } else {
    ok('voice engine reachable');
    await popup.evaluate(() => chrome.runtime.sendMessage({
      type: 'PLAY_SELECTION',
      text: 'Spiel automated smoke test. The playback pipeline works end to end.',
    }));
    let status = 'unknown';
    for (let i = 0; i < 30; i++) {
      await popup.waitForTimeout(500);
      const st = await popup.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'GET_STATUS' }))?.state);
      status = st?.status || 'no-state';
      if (status === 'playing' || status === 'done' || status === 'error') break;
    }
    (status === 'playing' || status === 'done')
      ? ok('audio pipeline (fetch→offscreen→play)', `status: ${status}`)
      : bad('audio pipeline', `status: ${status}`);
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP' })).catch(() => {});
  }

  // 6. Summary modal: SHOW_SUMMARY renders in-page, Listen starts playback
  const SUM_TEXT = 'This is the automated summary. It has three sentences for the karaoke. The modal must highlight them.';
  await popup.evaluate(async ({ tabId, text }) => {
    await chrome.tabs.sendMessage(tabId, { type: 'SHOW_SUMMARY', title: 'E2E', summary: text });
  }, { tabId: articleTab.id, text: SUM_TEXT });
  await article.waitForTimeout(400);
  const modal = await article.evaluate(() => {
    const host = document.getElementById('spiel-summary-host');
    const sh = host?.shadowRoot;
    return {
      exists: !!host,
      sentences: sh ? sh.querySelectorAll('.body .s').length : 0,
      words: sh ? sh.querySelectorAll('.body .w').length : 0,
      hasListen: !!sh?.getElementById('spiel-sum-listen'),
    };
  });
  (modal.exists && modal.sentences === 3 && modal.hasListen)
    ? ok('summary modal renders', `${modal.sentences} sentences, ${modal.words} word spans`)
    : bad('summary modal', JSON.stringify(modal));

  if (engineUp && modal.hasListen) {
    await article.evaluate(() => {
      (document.getElementById('spiel-summary-host').shadowRoot.getElementById('spiel-sum-listen')).click();
    });
    let status = 'unknown', activeSent = 0;
    for (let i = 0; i < 30; i++) {
      await popup.waitForTimeout(500);
      const st = await popup.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'GET_STATUS' }))?.state);
      status = st?.status || 'no-state';
      activeSent = await article.evaluate(() =>
        document.getElementById('spiel-summary-host')?.shadowRoot?.querySelectorAll('.body .s.active').length ?? 0);
      if ((status === 'playing' && activeSent > 0) || status === 'done' || status === 'error') break;
    }
    (status === 'playing' || status === 'done') && activeSent > 0
      ? ok('modal Listen → playback + karaoke on modal', `status ${status}, active sentence highlighted`)
      : bad('modal Listen flow', `status ${status}, activeSent ${activeSent}`);
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP' })).catch(() => {});
  }

  // 7. No uncaught Spiel errors anywhere
  const spielErrors = errors.filter(e => !/net::|favicon|ERR_BLOCKED/.test(e));
  spielErrors.length === 0 ? ok('no uncaught extension errors') : bad('uncaught errors', spielErrors.join(' | ').slice(0, 300));
} catch (e) {
  bad('harness', String(e).slice(0, 300));
} finally {
  await ctx.close().catch(() => {});
  server.close();
  rmSync(userDir, { recursive: true, force: true });
}

const failed = results.filter(r => !r.pass);
console.log(`\n${failed.length === 0 ? '✅ SMOKE PASS' : `❌ ${failed.length} FAILURE(S)`} — ${results.length} checks`);
process.exit(failed.length ? 1 : 0);
