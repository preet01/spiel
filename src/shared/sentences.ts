const ABBREVIATIONS = [
  'Mr', 'Mrs', 'Ms', 'Dr', 'Prof', 'Sr', 'Jr', 'vs', 'etc', 'al',
  'Fig', 'fig', 'Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug',
  'Sep', 'Oct', 'Nov', 'Dec', 'St', 'Ave', 'Blvd', 'No', 'pp', 'Vol',
  'approx', 'dept', 'est', 'govt', 'intl', 'max', 'min', 'misc',
  'Inc', 'Ltd', 'Co', 'Corp', 'Gen', 'Sen', 'Rep', 'Gov',
  // multi-dot abbreviations handled separately below
];

// Abbreviations whose dots fall mid-token (e.g. "e.g.", "i.e.", "U.S.").
const MULTIDOT = [
  ['e.g.', 'e_g_'], ['i.e.', 'i_e_'], ['a.m.', 'a_m_'], ['p.m.', 'p_m_'],
  ['U.S.A.', 'U_S_A_'], ['U.S.', 'U_S_'], ['U.K.', 'U_K_'], ['Ph.D.', 'Ph_D_'],
  ['D.C.', 'D_C_'],
];

export function splitIntoSentences(text: string): string[] {
  let t = text.replace(/\s+/g, ' ').trim();

  // Protect multi-dot abbreviations
  for (const [from, to] of MULTIDOT) {
    t = t.split(from).join(to);
  }

  // Protect single trailing-dot abbreviations
  ABBREVIATIONS.forEach(abbr => {
    t = t.replace(new RegExp(`\\b${abbr}\\.`, 'g'), `${abbr}__DOT__`);
  });

  // Protect single-letter initials like "J. R. R."
  t = t.replace(/\b([A-Z])\.\s/g, '$1__DOT__ ');

  // Protect decimal numbers like 3.14
  t = t.replace(/(\d)\.(\d)/g, '$1__DEC__$2');

  // De-glue block boundaries that arrived with no whitespace ("network.Example:One") —
  // seen when extraction concatenates block elements. Runs AFTER the protections above,
  // so abbreviations/decimals/initials are exempt. Without the space, the split below
  // can't fire and the glued token breaks page-highlight matching too (E8).
  t = t.replace(/([.!?])(["'""»)\]]?)([A-Z0-9À-Ý])/g, '$1$2 $3');

  // Split on sentence-ending punctuation followed by whitespace + an uppercase/quote/digit start.
  const parts = t.split(/(?<=[.!?])\s+(?=[A-Z"'""""À-ɏ0-9])/);

  // Restore protected patterns
  const restore = (s: string) =>
    s.replace(/__DOT__/g, '.').replace(/__DEC__/g, '.')
     .replace(/([a-zA-Z])_([a-zA-Z])_/g, '$1.$2.')
     .replace(/_/g, '.')
     .trim();

  const sentences = parts.map(restore).filter(s => s.length > 0);

  // Merge tiny fragments into the previous sentence (don't drop them).
  const merged: string[] = [];
  for (const s of sentences) {
    if (merged.length > 0 && s.length < 25 && !/[.!?]$/.test(s)) {
      merged[merged.length - 1] += ' ' + s;
    } else if (merged.length > 0 && s.length < 12) {
      merged[merged.length - 1] += ' ' + s;
    } else {
      merged.push(s);
    }
  }

  // Chunk very long sentences (>350 chars) at comma boundaries for smoother prosody.
  const chunked: string[] = [];
  for (const s of merged) {
    if (s.length <= 350) { chunked.push(s); continue; }
    const parts2 = s.split(/,\s+/);
    let current = '';
    for (const p of parts2) {
      if (current.length + p.length + 2 > 300 && current.length >= 80) {
        chunked.push(current.trim());
        current = p;
      } else {
        current = current ? `${current}, ${p}` : p;
      }
    }
    if (current) chunked.push(current.trim());
  }

  // Comma-less monsters (URLs, run-ons, some translated text) survive the pass above.
  // Hard-wrap anything still >350 chars at a word boundary near 300.
  const bounded: string[] = [];
  for (let s of chunked) {
    while (s.length > 350) {
      let cut = s.lastIndexOf(' ', 300);
      if (cut < 80) cut = 300; // no usable space — cut mid-token rather than not at all
      bounded.push(s.slice(0, cut).trim());
      s = s.slice(cut).trim();
    }
    if (s) bounded.push(s);
  }

  let result = bounded.filter(s => s.trim().length > 0);

  // KEY LATENCY WIN: make the FIRST chunk short so first audio generates in ~0.3s.
  // A short opening clause gets the user hearing audio in well under a second; the rest
  // streams behind it. Only the first chunk is shortened — the body keeps natural prosody.
  if (result.length && result[0].length > 70) {
    const first = result[0];
    const cut = firstClauseCut(first);
    if (cut > 0) {
      result = [first.slice(0, cut).trim(), first.slice(cut).trim(), ...result.slice(1)]
        .filter(s => s.length > 0);
    }
  }

  return result;
}

// Find a good place to cut the opening clause: prefer a comma, else a word boundary,
// keeping the first piece roughly 25-55 chars — the shorter the first chunk, the
// faster the first audio (~linear in generation cost).
function firstClauseCut(s: string): number {
  const comma = s.indexOf(', ', 20);
  if (comma > 20 && comma < 55) return comma + 1;
  const semi = s.indexOf('; ', 20);
  if (semi > 20 && semi < 55) return semi + 1;
  const dash = s.indexOf(' — ', 20);
  if (dash > 20 && dash < 55) return dash + 3;
  const space = s.indexOf(' ', 32);
  if (space > 32 && space < 55) return space;
  return 0;
}
