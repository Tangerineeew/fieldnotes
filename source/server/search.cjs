'use strict';

const { UUID } = require('./common.cjs');

// Search finds the notes that hold every word typed, and ranks them: a word in the title counts most, then one in a heading,
// in a property or tag, and last in the text. A note found in its text brings the passage around the first hit.
const SNIPPET_CHARS = 90;
// Words kept before the hit, so it still shows in a narrow column.
const LEAD_CHARS = 12;
const LEADING_ID = new RegExp(`^${UUID}`, 'i');

// The text as a reader sees it, so link targets, image sources and note ids never match.
const readable = (content) => String(content)
  .replace(/!?\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g, (_match, target, label) => label || (LEADING_ID.test(target) ? '' : target))
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '');

function snippetOf(text, term) {
  const at = text.toLocaleLowerCase().indexOf(term);
  if (at < 0) return null;
  const start = Math.max(0, at - LEAD_CHARS); const end = Math.min(text.length, start + SNIPPET_CHARS);
  const passage = text.slice(start, end).replace(/^#+\s+|[*_`~>]|^\s*[-+]\s+(\[[ xX]\]\s+)?/gm, '').replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${passage}${end < text.length ? '…' : ''}`;
}

// Null when the note misses a word; otherwise its score and, for a hit outside the title, a snippet.
function rank(query, note, extra = '') {
  const terms = String(query).toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { score: 0, snippet: null };
  const title = note.title.toLocaleLowerCase(); const body = readable(note.content);
  const lowered = body.toLocaleLowerCase();
  const headings = (lowered.match(/^#{1,6}\s+.*$/gm) || []).join('\n'); const fields = extra.toLocaleLowerCase();
  let score = 0; let snippet = null;
  for (const term of terms) {
    if (title.startsWith(term)) score += 60;
    else if (title.split(/[\s\p{P}]+/u).some((word) => word.startsWith(term))) score += 45;
    else if (title.includes(term)) score += 30;
    else if (headings.includes(term)) score += 15;
    else if (fields.includes(term)) score += 10;
    else if (lowered.includes(term)) score += 5;
    else return null;
    if (!title.includes(term) && !snippet) snippet = snippetOf(body, term);
  }
  const phrase = terms.join(' ');
  if (title === phrase) score += 100;
  else if (terms.length > 1 && title.includes(phrase)) score += 30;
  return { score, snippet };
}

module.exports = { rank };
