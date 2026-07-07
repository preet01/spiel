// Post-build sanity check.
//
// The build is a hand-maintained list of copy/bundle steps. If a file that the
// extension loads at runtime isn't produced (e.g. offscreen.html, which caused
// audio playback to fail for everyone until v1.1.1), the build still "succeeds"
// and the breakage only shows up when a user clicks Play. This check closes that
// gap: it fails the build if anything the manifest or code references is missing
// from dist/, so a missing asset can never be shipped again.

const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');

// Every file the loaded extension needs at runtime.
const REQUIRED = [
  'manifest.json',
  'background.js',
  'content.js',
  'offscreen.js',
  'offscreen.html',   // loaded by chrome.offscreen.createDocument — audio playback depends on it
  'pdf-content.js',   // injected into PDF tabs for text extraction
  'pdf.worker.min.mjs', // pdf.js worker — web-accessible resource the extractor loads
  'popup/index.html',
  'popup/popup.js',
  'popup/popup.css',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png',
];

const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(DIST, f)));

if (missing.length > 0) {
  console.error('\n✗ Build verification FAILED — these files are missing from dist/:');
  for (const f of missing) console.error('   • ' + f);
  console.error('\nThe extension will not work correctly. Fix the build steps in package.json.\n');
  process.exit(1);
}

// Cross-check: any offscreen.html referenced in code must be shipped (belt and suspenders).
const bg = fs.readFileSync(path.join(DIST, 'background.js'), 'utf8');
if (bg.includes('offscreen.html') && !fs.existsSync(path.join(DIST, 'offscreen.html'))) {
  console.error('\n✗ background.js references offscreen.html but it is not in dist/.\n');
  process.exit(1);
}

console.log('✓ Build verified — all ' + REQUIRED.length + ' required files present in dist/');
