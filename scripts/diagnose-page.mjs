// Diagnose highlight matching on a REAL page: loads the URL in an automated Chrome
// with the extension, extracts the article, aligns every sentence against the page
// word index, and prints exactly which sentences fail and where the match broke.
// Usage: node scripts/diagnose-page.mjs <url>
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';

const URL_ARG = process.argv[2];
if (!URL_ARG) { console.error('usage: node scripts/diagnose-page.mjs <url>'); process.exit(2); }
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

const userDir = mkdtempSync(path.join(os.tmpdir(), 'spiel-diag-'));
const ctx = await chromium.launchPersistentContext(userDir, {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
});
try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 });
  const extId = new URL(sw.url()).host;

  const page = await ctx.newPage();
  await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500); // let lazy content settle

  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup/index.html`);
  await popup.waitForTimeout(300);
  await page.bringToFront();
  await popup.waitForTimeout(300);

  const [tab] = await popup.evaluate(() => chrome.tabs.query({ active: true, currentWindow: true }));
  const article = await popup.evaluate(async (tabId) => {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' }).catch(() => {});
    return chrome.tabs.sendMessage(tabId, { type: 'GET_ARTICLE' });
  }, tab.id);
  if (!article?.sentences?.length) { console.error('extraction failed:', JSON.stringify(article).slice(0, 200)); process.exit(1); }
  console.log(`Extracted: "${article.title}" — ${article.sentences.length} sentences, ${article.totalWords} words`);

  const diag = await popup.evaluate(async ({ tabId, sentences }) =>
    chrome.tabs.sendMessage(tabId, { type: 'DEBUG_MATCH', sentences }), { tabId: tab.id, sentences: article.sentences });

  const fails = diag.report.filter(r => !r.matched);
  console.log(`\nPage word index: ${diag.totalWords} words`);
  console.log(`Aligned: ${diag.report.length - fails.length}/${diag.report.length} sentences (${((1 - fails.length / diag.report.length) * 100).toFixed(1)}%)\n`);
  for (const f of fails.slice(0, 25)) {
    console.log(`✗ #${f.i} matched ${f.bestK}/${f.len} words — broke at page:"${f.failA}" vs spoken:"${f.failB}"`);
    console.log(`   "${f.text}"`);
  }
  if (fails.length > 25) console.log(`… and ${fails.length - 25} more`);
} finally {
  await ctx.close().catch(() => {});
  rmSync(userDir, { recursive: true, force: true });
}
