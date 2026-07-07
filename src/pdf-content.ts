// Spiel PDF extractor — injected on demand into PDF tabs only.
//
// Chrome renders PDFs inside a plugin whose text the DOM can't reach, so we fetch
// the PDF's own bytes (same-origin — no extra host permission) and parse them
// locally with pdf.js. Nothing leaves the machine, consistent with Spiel's privacy
// promise. This bundle is large (pdf.js ~1 MB) so it is NEVER part of content.js;
// background.ts injects it via chrome.scripting.executeScript only when a PDF is
// actually being read.

import * as pdfjsLib from 'pdfjs-dist';
import { splitIntoSentences } from './shared/sentences';

const log = (...a: any[]) => console.log('[Spiel:PDF]', ...a);
const err = (...a: any[]) => console.error('[Spiel:PDF]', ...a);

// The ESM pdf.js build spins up a module worker from this URL. The worker file is
// shipped as a web-accessible resource (see manifest.json) so the page context can
// load it from the extension origin.
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.mjs');

// pdf.js gives text as positioned fragments with no guaranteed spaces. Join fragments,
// re-join words hyphenated across line breaks, and collapse whitespace into clean prose.
function cleanupPdfText(raw: string): string {
  return raw
    .replace(/([A-Za-z])-\s*\n\s*([a-z])/g, '$1$2') // de-hyphenate line-broken words
    .replace(/\s*\n\s*/g, ' ')                        // newlines → spaces
    .replace(/[ \t ]+/g, ' ')                    // collapse runs of spaces
    .replace(/\s+([.,;:!?])/g, '$1')                  // no space before punctuation
    .trim();
}

async function extractPdf(): Promise<{ title: string; sentences: string[]; totalWords: number }> {
  log('Fetching PDF bytes from', location.href);
  const res = await fetch(location.href);
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const data = await res.arrayBuffer();

  const pdf = await pdfjsLib.getDocument({
    data,
    // Keep it lean and offline: no external cmaps/fonts fetched, no eval.
    isEvalSupported: false,
    disableFontFace: true,
  }).promise;

  log('PDF opened,', pdf.numPages, 'pages');
  let text = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    // Insert a space between fragments; pdf.js flags real line breaks with hasEOL.
    let pageText = '';
    for (const item of content.items as any[]) {
      if (typeof item.str !== 'string') continue;
      pageText += item.str;
      pageText += item.hasEOL ? '\n' : ' ';
    }
    text += pageText + '\n';
  }

  const clean = cleanupPdfText(text);
  const sentences = splitIntoSentences(clean);

  let title = 'PDF';
  try {
    const meta: any = await pdf.getMetadata();
    title = (meta?.info?.Title && String(meta.info.Title).trim()) || document.title || 'PDF';
  } catch { title = document.title || 'PDF'; }

  log(`Extracted ${sentences.length} sentences from ${pdf.numPages} pages`);
  return { title, sentences, totalWords: clean ? clean.split(/\s+/).length : 0 };
}

// Injected possibly more than once across plays — register the listener only once.
if (!(window as any).__spielPdfReady) {
  (window as any).__spielPdfReady = true;
  chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
    if (msg?.type !== 'EXTRACT_PDF') return;
    extractPdf()
      .then((r) => {
        if (!r.sentences.length) sendResponse({ error: 'pdf-empty' });
        else sendResponse(r);
      })
      .catch((e) => { err('PDF extraction failed:', e); sendResponse({ error: 'pdf-parse', message: String(e?.message || e) }); });
    return true; // async response
  });
  log('PDF extractor ready');
}
