import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { isPdf, pdfView } from './pdf';
import {
  escapeHtml, isTrekTarget, mountTrekChips, trekCardHtml, trekChipHtml, trekGroupHtml, trekRef, type TrekObject
} from './trek-objects';

export type ImageSources = Record<string, string>;
// A resolved link, or one the reader cannot open; a target missing from the map has not been resolved yet.
// `content` comes with a note that is embedded (`![[note]]`), so the page can show it in place.
// A trip item (`trek:place/12`) carries its card instead, or null once the trip no longer has it.
export type ReferenceLink = { id: string; title: string; content?: string; unavailable?: false }
  | { id?: undefined; title?: undefined; content?: undefined; unavailable: true }
  | { id?: undefined; title?: undefined; content?: undefined; unavailable?: undefined; trek: TrekObject | null };
export type ReferenceLinks = Record<string, ReferenceLink>;
// How a link the reader cannot open reads: one wording for "no access" and "deleted", so it never confirms the note exists.
// `callouts` names a callout written without a title, by its kind.
export type LinkText = { unavailable: string; hint: string; missingHeading?: string; callouts?: Partial<Record<CalloutKind, string>> };
const LINK_TEXT: LinkText = { unavailable: 'Note you can’t open', hint: 'You don’t have access to this note, or it was deleted.',
  missingHeading: 'This heading is no longer in the note.' };
const UNAVAILABLE_LINK = '#fieldnotes-unavailable';
// A link to a heading of the note it sits in; the page scrolls instead of opening anything.
export const HEADING_LINK = '#fieldnotes-heading:';

const IMAGE_PATTERN = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/g;
const PLACEHOLDER_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
// An image source that failed to resolve maps to this prefix plus a readable reason instead of a data URL.
export const IMAGE_ERROR = 'error:';
// `[[target]]` or `[[target|label]]`; the editor writes a note id as the target, so a renamed note keeps its links.
// The target may end in `#heading`, and an empty note before it means the note the link sits in.
export const REFERENCE_PATTERN = /\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g;
// `![[target]]` alone on its line shows that note, or one section of it, in place.
const EMBED_PATTERN = /^!\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\][ \t]*$/gm;
export const isNoteId = (target: string) => /^[0-9a-f-]{36}$/i.test(target);
export function splitTarget(target: string) {
  const at = target.indexOf('#');
  return at < 0 ? { note: target.trim(), heading: '' } : { note: target.slice(0, at).trim(), heading: target.slice(at + 1).trim() };
}
// What a link shows: an id link always shows the note's current title, a hand-typed one its label or what was typed.
const referenceLabel = (target: string, label: string | undefined, current?: string) =>
  (isNoteId(target) ? current || label?.trim() : label?.trim() || current) || target.split('/').at(-1) || target;
// Adds the heading after the title, unless the label already says it: a hand-written label, or the one stored with an id link.
export function linkLabel(target: string, label: string | undefined, current?: string) {
  const { note, heading } = splitTarget(target);
  if (!note) return label?.trim() || heading;
  const base = referenceLabel(note, label, current);
  return (isNoteId(note) ? current : !label?.trim()) ? headingLabel(base, heading) : base;
}
// How a heading link names its section after the note's title, in the label the editor stores and in what a link shows.
export const headingLabel = (title: string, heading: string) => heading ? `${title} › ${heading}` : title;
// Obsidian's callouts: `> [!tip] Title` turns a quote into a tinted box, and `+` or `-` after the type makes it fold, open or
// closed. Obsidian's many types share five looks here; an unknown type reads as a note.
export type CalloutKind = 'note' | 'tip' | 'success' | 'warning' | 'danger';
const CALLOUT_KINDS: Record<string, CalloutKind> = Object.fromEntries(Object.entries({
  note: 'note info abstract summary tldr todo example quote cite question help faq', tip: 'tip hint important',
  success: 'success check done', warning: 'warning caution attention', danger: 'danger error failure fail missing bug',
}).flatMap(([kind, types]) => types.split(' ').map((type) => [type, kind as CalloutKind])));
const CALLOUT_TITLES: Record<CalloutKind, string> = { note: 'Note', tip: 'Tip', success: 'Done', warning: 'Warning', danger: 'Danger' };
export const CALLOUT_LINE = /^\s*>\s*\[![\w-]+\]/;
const CALLOUT = /<blockquote>\n?<p>\[!([\w-]+)\]([+-]?)[ \t]*([^\n]*?)(?:\n|(<\/p>))/g;
function callouts(html: string, text: LinkText) {
  return html.replace(CALLOUT, (_match, type: string, fold: string, title: string, closed?: string) => {
    const kind = CALLOUT_KINDS[type.toLowerCase()] || 'note';
    const name = title.trim() || escapeHtml(text.callouts?.[kind] || CALLOUT_TITLES[kind]);
    return `<blockquote data-callout="${kind}"${fold ? ` data-fold="${fold === '-' ? 'closed' : 'open'}"` : ''}>`
      + `<p data-callout-title="">${name}</p>${closed ? '' : '<p>'}`;
  });
}

// Escapes what would end or restyle Markdown link text, so a title such as "A [draft]" renders literally.
const linkText = (value: string) => value.replace(/[\\[\]*_`<>]/g, (char) => `\\${char}`);
const SAFE_URI_REGEXP = /^(?:https?:\/\/|mailto:|fieldnotes:\/\/note\/[0-9a-f-]{36}|\/|#|data:image\/(?:gif|jpeg|png|webp|avif);base64,)/i;
export const noteHref = (id: string, heading: string) => `fieldnotes://note/${id}${heading ? `#${encodeURIComponent(heading)}` : ''}`;

export function imageSourcesInMarkdown(source: string): string[] {
  const sources = new Set<string>();
  for (const match of source.matchAll(IMAGE_PATTERN)) sources.add(match[2]);
  return [...sources];
}

// The notes a text links to or embeds, without headings; a link to a heading of the same note names none, and a trip item no note.
function linkedNotes(source: string, pattern: RegExp): string[] {
  const sources = new Set<string>();
  for (const match of source.matchAll(pattern)) {
    const { note } = splitTarget(match[1]); if (note && !isTrekTarget(note)) sources.add(note);
  }
  return [...sources];
}
export const referenceSourcesInMarkdown = (source: string) => linkedNotes(source, REFERENCE_PATTERN);
export const embedSourcesInMarkdown = (source: string) => linkedNotes(source, EMBED_PATTERN);

// Heading text as a reader sees it: no `#` marks, no inline Markdown, compared without case.
const headingKey = (text: string) => text.replace(/\s+#+\s*$/, '').replace(/[*_`~]/g, '').trim().toLocaleLowerCase();
const HEADING_LINE = /^(#{1,6})\s+(.+)$/;
export type Heading = { level: number; text: string };
// Each heading line outside code blocks, by its index among `lines`.
function* headingLines(lines: string[]) {
  let fenced = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*(```|~~~)/.test(lines[index])) fenced = !fenced;
    const match = !fenced && HEADING_LINE.exec(lines[index]);
    if (match) yield { index, level: match[1].length, text: match[2] };
  }
}
// Headings as written; the outline shows them without their inline Markdown.
export const outlineOf = (content: string): Heading[] => [...headingLines(content.split('\n'))]
  .map(({ level, text }) => ({ level, text: text.replace(/\s+#+\s*$/, '').trim() }));
// The line a heading is on, counted from 0, or -1 when the text has no such heading.
export const headingLineOf = (content: string, heading: string) =>
  [...headingLines(content.split('\n'))].find((found) => sameHeading(found.text, heading))?.index ?? -1;
export const headingsIn = (content: string) => outlineOf(content).map((heading) => heading.text);
// A heading as it reads: links show their text, emphasis and code marks drop away.
export const plainHeading = (text: string) => text
  .replace(/!?\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_match, target: string, label?: string) => label?.trim() || target)
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`~]/g, '').trim();
export const sameHeading = (a: string, b: string) => headingKey(a) === headingKey(b);
// From the heading to the next one of the same or a higher level; null when the note no longer has it.
function sectionOf(content: string, heading: string): string | null {
  const lines = content.split('\n'); let start = -1; let level = 0;
  for (const found of headingLines(lines)) {
    if (start >= 0 && found.level <= level) return lines.slice(start, found.index).join('\n');
    if (start < 0 && sameHeading(found.text, heading)) { start = found.index; level = found.level; }
  }
  return start < 0 ? null : lines.slice(start).join('\n');
}

// A trip item in running text is a tag that opens its card; like a PDF, it waits as a marker until the page is sanitized.
const CHIP_MARK = '\uE004';
const trekOf = (references: ReferenceLinks, target: string) => {
  const link = references[target];
  return link && 'trek' in link ? link.trek : undefined;
};
function materializeReferences(source: string, references: ReferenceLinks, text: LinkText, chips: string[]): string {
  return source.replace(REFERENCE_PATTERN, (match, reference: string, label?: string) => {
    const target = reference.trim(); const { note, heading } = splitTarget(target);
    if (isTrekTarget(target)) {
      chips.push(trekChipHtml(trekRef(target), label, trekOf(references, target)));
      return `${CHIP_MARK}${chips.length - 1}${CHIP_MARK}`;
    }
    if (!note) return `[${linkText(linkLabel(target, label))}](${HEADING_LINK}${encodeURIComponent(heading)})`;
    const link = references[note];
    if (link?.unavailable) {
      // Neither the stored title nor the id: the label was the linked note's title, which this reader may not see.
      return isNoteId(note) ? `[🔒 ${linkText(text.unavailable)}](${UNAVAILABLE_LINK} "${text.hint.replace(/"/g, '\\"')}")` : match;
    }
    if (link?.id) return `[${linkText(linkLabel(target, label, link.title))}](${noteHref(link.id, heading)})`;
    return isNoteId(note) ? '…' : match;
  });
}

// A PDF stands in the text as a private-use marker until the page is sanitized, then as an empty slot that mounting fills.
const PDF_MARK = '\uE002';
function materializeImages(source: string, imageSources: ImageSources, pdfs: string[]): string {
  return source.replace(IMAGE_PATTERN, (_match, alt: string, src: string) => {
    const rendered = imageSources[src] || PLACEHOLDER_IMAGE;
    if (rendered.startsWith(IMAGE_ERROR)) return `*⚠ ${alt || 'image'} · ${rendered.slice(IMAGE_ERROR.length)}*`;
    if (isPdf(rendered)) {
      pdfs.push(`<span class="fn-pdf-slot" data-source="${escapeHtml(src)}" data-name="${escapeHtml(alt || 'PDF')}"></span>`);
      return `${PDF_MARK}${pdfs.length - 1}${PDF_MARK}`;
    }
    return `![${alt}](${rendered} "fieldnotes-source:${encodeURIComponent(src)}")`;
  });
}

// Embedded notes stand in the text as a private-use marker paragraph until the page around them is sanitized, then become
// a frame around their own, separately sanitized, rendering. One level deep: an embed inside an embed reads as a link.
const EMBED_MARK = '\uE001';
function embed(target: string, label: string | undefined, references: ReferenceLinks, imageSources: ImageSources, text: LinkText) {
  if (isTrekTarget(target)) return trekCardHtml(trekRef(target), label, trekOf(references, target));
  const { note, heading } = splitTarget(target); const link = note ? references[note] : undefined;
  if (link?.unavailable) {
    return `<div class="fn-embed fn-embed--locked" title="${escapeHtml(text.hint)}">🔒 ${escapeHtml(text.unavailable)}</div>`;
  }
  if (!link || link.content === undefined) return `<div class="fn-embed fn-embed--pending" aria-busy="true">…</div>`;
  const section = heading ? sectionOf(link.content, heading) : link.content;
  const body = section === null ? `<p class="fn-embed-missing">${escapeHtml(text.missingHeading || LINK_TEXT.missingHeading!)}</p>`
    : renderMarkdown(section, imageSources, references, text, 1);
  // The section's own heading opens the body, so the frame names only the note.
  return `<div class="fn-embed"><a class="fn-embed-title" href="${noteHref(link.id, heading)}">`
    + `${escapeHtml(link.title)}</a><div class="fn-embed-body">${body}</div></div>`;
}

// Trip items on lines next to each other share one box, each keeping its own layout; a blank line between them keeps them apart.
const TREK_EMBED_LINE = /^!\[\[(trek:[^\]|\n]+)(?:\|([^\]\n]*))?\]\][ \t]*$/;
function groupTrekItems(source: string, references: ReferenceLinks, frames: string[]) {
  const lines = source.split('\n'); const kept: string[] = [];
  const item = (line: string) => { const match = TREK_EMBED_LINE.exec(line); return match && isTrekTarget(match[1]) ? match : null; };
  for (let at = 0; at < lines.length;) {
    let end = at;
    while (end < lines.length && item(lines[end])) end += 1;
    if (end - at < 2) { kept.push(lines[at]); at += 1; continue; }
    frames.push(trekGroupHtml(lines.slice(at, end).map((line) => {
      const [, target, label] = item(line)!; return [trekRef(target), label, trekOf(references, target.trim())] as const;
    })));
    kept.push('', `${EMBED_MARK}${frames.length - 1}${EMBED_MARK}`, ''); at = end;
  }
  return kept.join('\n');
}

function renderMarkdown(source: string, imageSources: ImageSources = {}, references: ReferenceLinks = {},
  text: LinkText = LINK_TEXT, depth = 0): string {
  const frames: string[] = []; const pdfs: string[] = []; const chips: string[] = [];
  const stripped = source.replace(/<img\b[^>]*>/gi, '');
  const grouped = depth > 0 ? stripped : groupTrekItems(stripped, references, frames);
  const markdown = grouped.replace(EMBED_PATTERN, (match, target: string, label?: string) => {
    if (depth > 0) return match.slice(1);
    frames.push(embed(target.trim(), label, references, imageSources, text));
    return `\n\n${EMBED_MARK}${frames.length - 1}${EMBED_MARK}\n\n`;
  });
  const html = DOMPurify.sanitize(callouts(marked.parse(materializeImages(materializeReferences(markdown, references, text, chips),
    imageSources, pdfs), { async: false }), text), {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li',
      'blockquote', 'pre', 'code', 'hr', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    ALLOWED_ATTR: ['href', 'title', 'src', 'alt', 'data-callout', 'data-callout-title', 'data-fold'],
    ALLOWED_URI_REGEXP: SAFE_URI_REGEXP,
  });
  // Each marker gives way to what it stands for; an embed's stands as a paragraph of its own.
  const marker = (mark: string) => `${mark}(\\d+)${mark}`;
  const restore = (into: string, pattern: string, items: string[]) => items.length
    ? into.replace(new RegExp(pattern, 'g'), (_match, index) => items[Number(index)]) : into;
  return restore(restore(restore(html, `<p>${marker(EMBED_MARK)}</p>`, frames), marker(PDF_MARK), pdfs), marker(CHIP_MARK), chips);
}

// Mounts sanitized Markdown without innerHTML, so the rendered fragment never runs inline handlers.
export function renderMarkdownInto(element: HTMLElement, source: string, imageSources: ImageSources = {}, references: ReferenceLinks = {},
  text?: LinkText) {
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  element.replaceChildren(range.createContextualFragment(renderMarkdown(source, imageSources, references, text)));
  element.querySelectorAll<HTMLElement>('.fn-pdf-slot')
    .forEach((slot) => slot.replaceWith(pdfView(imageSources[slot.dataset.source!], slot.dataset.name!)));
  mountTrekChips(element, references);
  // A folding callout opens and closes from its title, by pointer or keyboard.
  element.querySelectorAll<HTMLElement>('[data-fold] > [data-callout-title]').forEach((title) => {
    const callout = title.parentElement!;
    const sync = () => title.setAttribute('aria-expanded', String(callout.dataset.fold === 'open'));
    const toggle = () => { callout.dataset.fold = callout.dataset.fold === 'open' ? 'closed' : 'open'; sync(); };
    title.setAttribute('role', 'button'); title.tabIndex = 0; sync();
    title.addEventListener('click', toggle);
    title.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
    });
  });
}

// Scrolls a rendered note to one of its headings and marks it for a moment; false when the note has no such heading.
export function revealHeading(root: HTMLElement, heading: string) {
  const levels = [1, 2, 3, 4, 5, 6].map((level) => `:scope > h${level}`).join(', ');
  const found = Array.from(root.querySelectorAll<HTMLElement>(levels)).find((element) => sameHeading(element.textContent || '', heading));
  if (!found) return false;
  found.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  found.classList.remove('fn-heading-reached'); void found.offsetWidth; found.classList.add('fn-heading-reached');
  return true;
}
