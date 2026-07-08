// Spiel e2e smoke test — launches a real Chrome with dist/ loaded and verifies the
// core flows WITHOUT a human: content script injection, article extraction, the full
// TTS playback pipeline against the local engine, and zero uncaught extension errors.
// Run: node scripts/e2e-smoke.mjs
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

  // 3. Article extraction via the content script (the same path Play uses; sentence 1
  // must not contain glued tokens like "network.Example" — the E8 regression guard).
  const extract = await popup.evaluate(async (tabId) => {
    try { return await chrome.tabs.sendMessage(tabId, { type: 'GET_ARTICLE' }); }
    catch (e) { return { error: 'threw: ' + String(e) }; }
  }, articleTab.id);
  if (extract?.sentences?.length >= 5 && !/\w\.\w/.test(extract.sentences[1] || ''))
    ok('article extraction', `${extract.sentences.length} sentences, title "${extract.title}"`);
  else bad('article extraction', JSON.stringify(extract).slice(0, 200));

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
