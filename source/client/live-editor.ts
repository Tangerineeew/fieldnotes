import { EditorSelection, EditorState, Facet, StateEffect, StateField, Transaction, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, keymap, placeholder, type Command, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { LanguageSupport, ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown';
import type { SyntaxNode } from '@lezer/common';
import { CALLOUT_LINE, HEADING_LINK, IMAGE_ERROR, REFERENCE_PATTERN, headingLabel, headingLineOf, headingsIn, isNoteId, linkLabel,
  noteHref, renderMarkdownInto, splitTarget, type ImageSources, type LinkText, type ReferenceLinks } from './markdown';
import { attachmentFiles } from './images';
import { isPdf, pdfView } from './pdf';
import { editorMenu, type MenuItem, type MenuSection, type MenuSource } from './editor-menu';
import { TREK_PREFIX, cardLines, isTrekTarget, trekChipHtml, trekRef, type TrekObject } from './trek-objects';
import { maxContentBytes, maxContentChars } from '../shared/limits.json';
import type { Translate } from './i18n';


// Typora/MarkText-style live preview: the Markdown text is the only source of truth. Syntax marks are
// decorations that stay visible (dimmed) around the caret and are hidden everywhere else.
export type Assets = { imageSources: ImageSources; references: ReferenceLinks; text?: LinkText };
// `restricted`: some readers of the note being edited could not open this one. `headings` come only when asked for.
export type LinkTarget = { id: string; title: string; icon?: string | null; path?: string; restricted?: boolean; headings?: string[] };
export type TripPdf = { source: string; name: string; size: number };
// `collab` replaces local history with the shared document's own sync and undo manager.
// `onImageFiles` receives pasted or dropped images and PDFs, and `onPickImage` asks for one (`pdf` for a PDF); the caller uploads
// and calls `insertImage`. `tripPdfs` lists PDFs of the trip whose snapshot is being edited, and `onTripPdf` inserts one.
// `searchNotes` lists what `[[` may link to; `onLinked` hears each link the menu inserts, so it shows its title at once.
// `tripObjects` lists the places, bookings, days and stays of that trip, which `[[` also offers as cards; `onTrekObject` hears
// each card inserted.
export type LiveEditorOptions = { onChange: (markdown: string) => void; onOpenLink: (href: string) => void;
  onImageFiles?: (files: File[]) => void; searchNotes?: (query: string, headings?: boolean) => Promise<LinkTarget[]>;
  onLinked?: (target: LinkTarget) => void; tripPdfs?: () => TripPdf[]; onTripPdf?: (pdf: TripPdf) => void;
  tripObjects?: () => TrekObject[]; onTrekObject?: (card: TrekObject) => void;
  onPickImage?: (pdf?: boolean) => void; t: Translate; labelledBy?: string; collab?: Extension[] };

export const setAssets = StateEffect.define<Assets>();
// How widgets that swallow their own clicks (embedded notes) follow a link on Mod-click.
const linkOpener = Facet.define<(href: string) => void, ((href: string) => void) | null>({ combine: (values) => values[0] ?? null });
const setFocus = StateEffect.define<boolean>();
const HEADING = /^ATXHeading([1-6])$/;
const INLINE_STYLES: Record<string, [string, string]> = {
  StrongEmphasis: ['fn-md-strong', 'EmphasisMark'], Emphasis: ['fn-md-em', 'EmphasisMark'],
  Strikethrough: ['fn-md-del', 'StrikethroughMark'], InlineCode: ['fn-md-code', 'CodeMark'],
};

const assetsField = StateField.define<Assets>({
  create: () => ({ imageSources: {}, references: {} }),
  update: (value, tr) => tr.effects.reduce((current, effect) => effect.is(setAssets) ? effect.value : current, value),
});
const focusField = StateField.define<boolean>({
  create: () => false,
  update: (value, tr) => tr.effects.reduce((current, effect) => effect.is(setFocus) ? effect.value : current, value),
});


class ImageWidget extends WidgetType {
  constructor(readonly src: string | undefined, readonly alt: string) { super(); }

  eq(other: ImageWidget) { return other.src === this.src && other.alt === this.alt; }

  toDOM() {
    // Only resolved data URLs are rendered; the raw source is never requested from the editor.
    if (isPdf(this.src)) {
      const frame = pdfView(this.src!, this.alt || 'PDF'); frame.classList.add('fn-md-pdf');
      return frame;
    }
    if (this.src && /^data:image\//.test(this.src)) {
      const image = document.createElement('img');
      image.className = 'fn-md-image'; image.src = this.src; image.alt = this.alt;
      return image;
    }
    const chip = document.createElement('span');
    const failure = this.src?.startsWith(IMAGE_ERROR) ? this.src.slice(IMAGE_ERROR.length) : '';
    chip.className = failure ? 'fn-md-image-pending fn-md-image-error' : 'fn-md-image-pending';
    chip.textContent = failure ? `${this.alt || 'image'} · ${failure}` : this.alt || 'image';
    return chip;
  }
}


// An id link, or one with its own label, reads as just that text until the caret enters it. `pending` links are still being
// resolved; `locked` ones the reader cannot open, shown without the stored title.
class WikilinkWidget extends WidgetType {
  constructor(readonly text: string, readonly state: 'resolved' | 'pending' | 'locked', readonly hint = '') { super(); }

  eq(other: WikilinkWidget) { return other.text === this.text && other.state === this.state && other.hint === this.hint; }

  toDOM() {
    const link = document.createElement('span');
    link.className = `fn-md-link fn-md-wikilink${this.state === 'resolved' ? '' : ` fn-md-wikilink--${this.state}`}`;
    link.textContent = this.text;
    if (this.hint) link.title = this.hint;
    return link;
  }
}


// A trip item in running text, as the tag it reads as; its card opens on the rendered page, not while writing.
class TrekChipWidget extends WidgetType {
  constructor(readonly html: string) { super(); }

  eq(other: TrekChipWidget) { return other.html === this.html; }

  toDOM() {
    const range = document.createRange();
    const fragment = range.createContextualFragment(this.html);
    const chip = fragment.firstElementChild as HTMLElement;
    chip.removeAttribute('role'); chip.removeAttribute('tabindex');
    return chip;
  }
}


class BulletWidget extends WidgetType {
  eq() { return true; }

  toDOM() {
    const bullet = document.createElement('span');
    bullet.className = 'fn-md-bullet'; bullet.textContent = '•';
    return bullet;
  }
}


class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean) { super(); }

  eq(other: TaskWidget) { return other.checked === this.checked; }

  toDOM(view: EditorView) {
    const box = document.createElement('input');
    box.type = 'checkbox'; box.className = 'fn-md-task'; box.checked = this.checked;
    box.addEventListener('mousedown', (event) => {
      event.preventDefault();
      const pos = view.posAtDOM(box);
      view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: this.checked ? ' ' : 'x' } });
    });
    return box;
  }
}


class RuleWidget extends WidgetType {
  eq() { return true; }

  toDOM() {
    const rule = document.createElement('span');
    rule.className = 'fn-md-hr';
    return rule;
  }
}


// A table, a callout or an embedded note (`![[note]]` alone on its line), rendered while the caret is elsewhere. A click puts the
// caret there and reveals the source; Mod-click follows a link inside.
class BlockWidget extends WidgetType {
  constructor(readonly source: string, readonly assets: Assets, readonly className: string) { super(); }

  eq(other: BlockWidget) { return other.source === this.source && other.assets === this.assets && other.className === this.className; }

  toDOM(view: EditorView) {
    const wrapper = document.createElement('div');
    wrapper.className = this.className;
    renderMarkdownInto(wrapper, this.source, this.assets.imageSources, this.assets.references, this.assets.text);
    wrapper.addEventListener('mousedown', (event) => {
      event.preventDefault();
      const href = (event.target as HTMLElement).closest('a')?.getAttribute('href');
      if (href && (event.metaKey || event.ctrlKey)) { view.state.facet(linkOpener)?.(href); return; }
      view.dispatch({ selection: { anchor: view.posAtDOM(wrapper) } }); view.focus();
    });
    return wrapper;
  }
}


const hidden = Decoration.replace({});
const bullet = Decoration.replace({ widget: new BulletWidget() });
const rule = Decoration.replace({ widget: new RuleWidget() });
const markClass = (cls: string) => Decoration.mark({ class: cls });
const lineClass = (cls: string) => Decoration.line({ class: cls });

// `embed` marks `![[…]]` standing alone on its line; `from` then includes the `!`.
function wikilinks(state: EditorState) {
  const text = state.doc.toString();
  return [...text.matchAll(REFERENCE_PATTERN)].map((match) => {
    const start = match.index!; const end = start + match[0].length; const line = state.doc.lineAt(start);
    const embed = text[start - 1] === '!' && start - 1 === line.from && !text.slice(end, line.to).trim();
    return { from: embed ? start - 1 : start, to: end, embed, target: match[1].trim(), label: match[2],
      pipe: match[2] === undefined ? -1 : start + 2 + match[1].length };
  });
}
// A same-note heading link is always resolved; any other waits for its note.
const linkState = (assets: Assets, target: string) => {
  const { note } = splitTarget(target);
  return note ? assets.references[note] : { id: '', title: '' };
};

function buildDecorations(state: EditorState): DecorationSet {
  const focused = state.field(focusField); const assets = state.field(assetsField);
  const tree = ensureSyntaxTree(state, state.doc.length, 200) || syntaxTree(state);
  const ranges: Range<Decoration>[] = [];
  const touches = (from: number, to: number) => focused && state.selection.ranges.some((range) => range.from <= to && range.to >= from);
  const lineOf = (pos: number) => state.doc.lineAt(pos);
  const onActiveLine = (pos: number) => { const line = lineOf(pos); return touches(line.from, line.to); };
  const addLines = (from: number, to: number, cls: string) => {
    for (let n = lineOf(from).number; n <= lineOf(to).number; n += 1) ranges.push(lineClass(cls).range(state.doc.line(n).from));
  };
  // A mark is either dimmed (active) or hidden together with the single space that follows it.
  const syntaxMark = (from: number, to: number, active: boolean, withSpace = false) => {
    if (active) ranges.push(markClass('fn-md-mark').range(from, to));
    else ranges.push(hidden.range(from, withSpace && state.sliceDoc(to, to + 1) === ' ' ? to + 1 : to));
  };
  const children = (node: SyntaxNode, name: string) => {
    const found: SyntaxNode[] = [];
    for (let child = node.firstChild; child; child = child.nextSibling) if (child.name === name) found.push(child);
    return found;
  };

  const links = wikilinks(state);
  const embedBlock = (from: number, to: number) =>
    Decoration.replace({ widget: new BlockWidget(state.sliceDoc(from, to), assets, 'fn-md-embed'), block: true }).range(from, to);
  // Trip items on adjacent lines render as their one box until the caret enters any of them; then each line is its own again.
  const trekLines = new Set(links.filter((link) => link.embed && isTrekTarget(link.target)).map((link) => lineOf(link.from).number));
  const grouped = new Set<number>();
  for (const first of [...trekLines].sort((a, b) => a - b)) {
    if (grouped.has(first) || trekLines.has(first - 1)) continue;
    let last = first;
    while (trekLines.has(last + 1)) last += 1;
    const from = state.doc.line(first).from; const to = state.doc.line(last).to;
    if (last === first || touches(from, to)) continue;
    ranges.push(embedBlock(from, to));
    for (let line = first; line <= last; line += 1) grouped.add(line);
  }
  for (const link of links) {
    if (link.embed && grouped.has(lineOf(link.from).number)) continue;
    const active = touches(link.from, link.to); const resolved = linkState(assets, link.target);
    const note = splitTarget(link.target).note;
    if (link.embed && !onActiveLine(link.from)) {
      const line = lineOf(link.from); ranges.push(embedBlock(line.from, line.to));
      continue;
    }
    const start = link.embed ? link.from + 1 : link.from;
    if (!active && (link.pipe >= 0 || isNoteId(note) || !note)) {
      const trek = resolved && 'trek' in resolved ? resolved.trek : undefined;
      const widget = isTrekTarget(note) ? new TrekChipWidget(trekChipHtml(trekRef(note), link.label, trek))
        : resolved?.unavailable && isNoteId(note) && assets.text
        ? new WikilinkWidget(`🔒 ${assets.text.unavailable}`, 'locked', assets.text.hint)
        : new WikilinkWidget(linkLabel(link.target, link.label, resolved?.title),
          resolved && !resolved.unavailable ? 'resolved' : 'pending');
      ranges.push(Decoration.replace({ widget }).range(start, link.to)); continue;
    }
    // While editing, the target before `|` dims like the brackets, and the label reads as the link.
    syntaxMark(link.from, link.pipe >= 0 ? link.pipe + 1 : start + 2, active); syntaxMark(link.to - 2, link.to, active);
    ranges.push(markClass('fn-md-link fn-md-wikilink').range(link.pipe >= 0 ? link.pipe + 1 : start + 2, link.to - 2));
  }
  const inWikilink = (from: number, to: number) => links.some((link) => from >= link.from && to <= link.to);

  tree.iterate({ enter: ({ name, node, from, to }) => {
    const heading = HEADING.exec(name);
    if (heading) {
      ranges.push(lineClass(`fn-md-h fn-md-h${heading[1]}`).range(lineOf(from).from));
      for (const mark of children(node, 'HeaderMark')) syntaxMark(mark.from, mark.to, onActiveLine(from), true);
      return;
    }
    if (INLINE_STYLES[name]) {
      const [cls, markName] = INLINE_STYLES[name]; const active = touches(from, to);
      ranges.push(markClass(cls).range(from, to));
      for (const mark of children(node, markName)) syntaxMark(mark.from, mark.to, active);
      return name !== 'InlineCode';
    }
    switch (name) {
      case 'Link': case 'Autolink': {
        if (inWikilink(from, to)) return false;
        const active = touches(from, to); const marks = children(node, 'LinkMark');
        const url = node.getChild('URL');
        if (name === 'Autolink' || marks.length < 2) {
          ranges.push(markClass('fn-md-link').range(from, to));
          marks.forEach((mark) => syntaxMark(mark.from, mark.to, active)); return false; }
        ranges.push(markClass('fn-md-link').range(marks[0].to, marks[1].from));
        syntaxMark(marks[0].from, marks[0].to, active); syntaxMark(marks[1].from, to, active);
        if (active && url) ranges.push(markClass('fn-md-url').range(url.from, url.to));
        return false;
      }
      case 'Image': {
        const url = node.getChild('URL'); const marks = children(node, 'LinkMark');
        const alt = marks.length > 1 ? state.sliceDoc(marks[0].to, marks[1].from) : '';
        const widget = new ImageWidget(url ? assets.imageSources[state.sliceDoc(url.from, url.to)] : undefined, alt);
        if (touches(from, to)) {
          ranges.push(markClass('fn-md-mark').range(from, to), Decoration.widget({ widget, side: 1 }).range(to));
        } else ranges.push(Decoration.replace({ widget }).range(from, to));
        return false;
      }
      case 'Blockquote': {
        const start = lineOf(from).from; const end = lineOf(to).to;
        if (CALLOUT_LINE.test(state.sliceDoc(start, lineOf(from).to)) && !touches(start, end)) {
          ranges.push(Decoration.replace({ widget: new BlockWidget(state.sliceDoc(start, end), assets, 'fn-md-callout'), block: true })
            .range(start, end));
          return false;
        }
        addLines(from, to, 'fn-md-quote');
        return;
      }
      case 'QuoteMark':
        syntaxMark(from, to, onActiveLine(from), true);
        return;
      case 'ListMark': {
        if (node.parent?.parent?.name === 'OrderedList') { ranges.push(markClass('fn-md-list-number').range(from, to)); return; }
        const active = touches(from, to + 1);
        // A task item shows only its checkbox; a plain item swaps `-` for a bullet.
        if (node.parent?.getChild('Task')) syntaxMark(from, to, active, true);
        else if (!active) ranges.push(bullet.range(from, to));
        return;
      }
      case 'TaskMarker':
        if (touches(from, to)) ranges.push(markClass('fn-md-mark').range(from, to));
        else ranges.push(Decoration.replace({ widget: new TaskWidget(/x/i.test(state.sliceDoc(from, to))) }).range(from, to));
        return;
      case 'FencedCode': case 'CodeBlock': {
        const active = touches(from, to);
        addLines(from, to, 'fn-md-codeblock');
        ranges.push(lineClass('fn-md-codeblock-first').range(lineOf(from).from), lineClass('fn-md-codeblock-last').range(lineOf(to).from));
        for (const mark of children(node, 'CodeMark')) syntaxMark(mark.from, mark.to, active);
        const info = node.getChild('CodeInfo');
        if (info) ranges.push(markClass('fn-md-code-info').range(info.from, info.to));
        return false;
      }
      case 'HorizontalRule':
        if (!onActiveLine(from)) ranges.push(rule.range(from, to));
        return false;
      case 'Table': {
        const start = lineOf(from).from; const end = lineOf(to).to;
        if (touches(start, end)) { addLines(from, to, 'fn-md-table-source'); return false; }
        ranges.push(Decoration.replace({ widget: new BlockWidget(state.sliceDoc(start, end), assets, 'fn-md-table'), block: true })
          .range(start, end));
        return false;
      }
      case 'HTMLBlock': case 'HTMLTag': case 'CommentBlock':
        ranges.push(markClass('fn-md-mark').range(from, to));
        return false;
    }
  } });
  return Decoration.set(ranges, true);
}

const previewField = StateField.define<DecorationSet>({
  create: buildDecorations,
  update(value, tr: Transaction) {
    const rebuild = tr.docChanged || tr.selection || tr.effects.some((effect) => effect.is(setAssets) || effect.is(setFocus))
      || syntaxTree(tr.startState) !== syntaxTree(tr.state);
    return rebuild ? buildDecorations(tr.state) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});


function toggleInline(marker: string): Command {
  return (view) => {
    const { state } = view; const n = marker.length;
    view.dispatch(state.changeByRange((range) => {
      const wrapped = state.sliceDoc(range.from - n, range.from) === marker && state.sliceDoc(range.to, range.to + n) === marker;
      // `*` must not strip one star of an enclosing `**`.
      const insideBold = marker === '*' && state.sliceDoc(range.from - 2, range.from) === '**'
        && state.sliceDoc(range.from - 3, range.from) !== '***';
      if (wrapped && !insideBold) {
        return { changes: [{ from: range.from - n, to: range.from }, { from: range.to, to: range.to + n }],
          range: EditorSelection.range(range.from - n, range.to - n) };
      }
      return { changes: [{ from: range.from, insert: marker }, { from: range.to, insert: marker }],
        range: EditorSelection.range(range.from + n, range.to + n) };
    }));
    return true;
  };
}

// Turns each selected line into one block type, replacing any other block marker; applying the same type again clears it.
const BLOCK_MARKER = /^(?:#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|>\s?\[![\w-]+\][+-]?\s*|>\s?|\d+\.\s+)/;
function setBlock(prefix: string): Command {
  return (view) => {
    const { state } = view; const changes = []; const seen = new Set<number>();
    for (const range of state.selection.ranges) {
      for (let n = state.doc.lineAt(range.from).number; n <= state.doc.lineAt(range.to).number; n += 1) {
        if (seen.has(n)) continue;
        seen.add(n); const line = state.doc.line(n); const current = BLOCK_MARKER.exec(line.text)?.[0] || '';
        changes.push({ from: line.from, to: line.from + current.length, insert: current === prefix ? '' : prefix });
      }
    }
    view.dispatch({ changes });
    return true;
  };
}

// Inserts block-level Markdown on its own line at the caret, replacing any selection.
function insertBlock(view: EditorView, markdown: string) {
  const { from, to } = view.state.selection.main;
  const insert = `${from > view.state.doc.lineAt(from).from ? '\n' : ''}${markdown}\n`;
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, scrollIntoView: true });
}

const setHeading = (level: number) => setBlock(level ? `${'#'.repeat(level)} ` : '');

const insertLink: Command = (view) => {
  const { state } = view;
  view.dispatch(state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to); const insert = `[${text}](https://)`;
    const cursor = range.from + insert.length - 1;
    return { changes: { from: range.from, to: range.to, insert },
      range: text ? EditorSelection.cursor(cursor) : EditorSelection.cursor(range.from + 1) };
  }));
  return true;
};

// The link is written as `[[id|title]]`: the id keeps it working through renames, the title keeps the raw Markdown readable.
// A heading follows the id as `#heading`; with no target note it points into the note being edited.
const linkSafe = (value: string) => value.replace(/[[\]|\s]+/g, ' ').trim();
function insertNoteLink(view: EditorView, target: LinkTarget | null, heading = '') {
  const section = linkSafe(heading).replace(/#/g, ' ').trim();
  const insert = target ? `[[${target.id}${section ? `#${section}` : ''}|${headingLabel(linkSafe(target.title), section)}]]`
    : `[[#${section}]]`;
  const { from, to } = view.state.selection.main;
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: 'input.complete' });
}

// Hand-typed `[[Title]]` links break when their note is renamed; this rewrites the ones that resolve to id links, as one
// ordinary edit, so co-editors receive it and Undo takes it back.
function titleLinks(state: EditorState) {
  const { references } = state.field(assetsField);
  return wikilinks(state).filter((link) => {
    const { note } = splitTarget(link.target);
    return note && !isNoteId(note) && references[note]?.id;
  });
}
function upgradeLinks(view: EditorView) {
  const { references } = view.state.field(assetsField);
  view.dispatch({ changes: titleLinks(view.state).map((link) => {
    const { note, heading } = splitTarget(link.target); const start = link.embed ? link.from + 1 : link.from;
    const label = linkSafe(link.label?.trim() || headingLabel(note.split('/').at(-1)!, heading));
    return { from: start, to: link.to, insert: `[[${references[note].id}${heading ? `#${heading}` : ''}|${label}]]` };
  }), userEvent: 'input.links' });
}

// A trip item's card stands on its own line: typed on an empty line it fills it, typed after text it goes on the next line.
function insertTrekCard(view: EditorView, card: TrekObject) {
  const embed = `![[${TREK_PREFIX}${card.ref}|${linkSafe(cardLines(card).name)}]]`;
  const { head } = view.state.selection.main; const line = view.state.doc.lineAt(head);
  const bang = view.state.sliceDoc(head - 1, head) === '!' ? 1 : 0;
  if (!(view.state.sliceDoc(line.from, head - bang) + view.state.sliceDoc(head, line.to)).trim()) {
    view.dispatch({ changes: { from: line.from, to: line.to, insert: embed }, selection: { anchor: line.from + embed.length },
      userEvent: 'input.complete' });
    return;
  }
  view.dispatch({ changes: [{ from: head - bang, to: head }, { from: line.to, insert: `\n${embed}` }],
    selection: { anchor: line.to - bang + 1 + embed.length }, userEvent: 'input.complete' });
}

// Moves the caret to a heading of this note and scrolls it to the top.
function revealHeadingIn(view: EditorView, heading: string) {
  const index = headingLineOf(view.state.doc.toString(), heading);
  if (index < 0) return;
  const line = view.state.doc.line(index + 1);
  view.dispatch({ selection: { anchor: line.to }, effects: EditorView.scrollIntoView(line.from, { y: 'start' }) });
  view.focus();
}

// After `#` the link menu lists headings: this note's for `[[#`, otherwise those of the notes matching what comes before it.
async function headingItems(options: LiveEditorOptions, view: EditorView, noteQuery: string, headingQuery: string,
  t: Translate): Promise<MenuItem[]> {
  const matches = (heading: string) => heading.toLocaleLowerCase().includes(headingQuery.trim().toLocaleLowerCase());
  if (!noteQuery.trim()) {
    return headingsIn(view.state.doc.toString()).filter(matches).slice(0, 20).map((heading) => ({ label: heading, icon: '#',
      description: t('In this note', '本篇笔记'), run: (target: EditorView) => insertNoteLink(target, null, heading) }));
  }
  const targets = await options.searchNotes!(noteQuery.trim(), true);
  return targets.slice(0, 3).flatMap((note) => (note.headings || []).filter(matches).map((heading): MenuItem => ({
    label: heading, icon: '#', description: note.title,
    run: (target) => { insertNoteLink(target, note, heading); options.onLinked?.(note); } }))).slice(0, 20);
}

function menuSource(options: LiveEditorOptions): MenuSource {
  const { t } = options;
  const run = (command: Command) => (view: EditorView) => { command(view); };
  const clipboard = (command: 'cut' | 'copy') => (view: EditorView) => { view.dom.ownerDocument.execCommand(command); };
  const image: MenuItem[] = options.onPickImage ? [{ label: t('Image', '图片'),
    description: t('Upload from this device', '从设备上传，压缩后保存'), hint: '⌘⇧I',
    icon: 'image', keywords: 'image picture photo upload tupian 图片 照片 上传', run: () => options.onPickImage!() },
  { label: 'PDF', description: t('Upload a PDF to read in place', '上传 PDF，在笔记里直接阅读'), icon: 'pdf',
    keywords: 'pdf document file upload attachment wenjian 文件 文档 附件 上传', run: () => options.onPickImage!(true) }] : [];
  // A snapshot may show the trip's own PDFs, such as tickets and bookings; up to eight show, typing narrows them.
  const tripPdfs = (): MenuItem[] => (options.onTripPdf && options.tripPdfs?.() || []).slice(0, 8).map((pdf) => ({
    label: pdf.name, description: t('PDF in this trip', '这次旅行中的 PDF'), icon: 'pdf',
    keywords: 'pdf trip file booking ticket xingcheng 行程 文件 预订 票', run: () => options.onTripPdf!(pdf) }));
  // The trip's items match on what their card shows, those named by the query first; with nothing typed, the days and stays
  // come first, as the trip runs.
  const tripItems = (query: string): MenuItem[] => {
    const needle = query.trim().toLocaleLowerCase();
    const score = (name: string, rest: string) => !needle ? 0 : name.startsWith(needle) ? 0 : name.includes(needle) ? 1
      : rest.includes(needle) ? 2 : -1;
    return (options.tripObjects?.() || []).map((card) => {
      const lines = cardLines(card);
      return { card, lines, score: score(lines.name.toLocaleLowerCase(), `${lines.facts} ${lines.detail}`.toLocaleLowerCase()) };
    }).filter((item) => item.score >= 0).sort((a, b) => a.score - b.score).slice(0, needle ? 12 : 8).map(({ card, lines }) => ({
      label: lines.name, description: lines.facts, icon: card.kind,
      run: (view: EditorView) => { insertTrekCard(view, card); options.onTrekObject?.(card); } }));
  };
  const tripSection = (query: string): MenuSection[] => {
    const items = tripItems(query);
    return items.length ? [{ label: t('From this trip', '来自这次旅行'), items }] : [];
  };
  const divider: MenuItem = { label: t('Divider', '分割线'),
    description: t('Separate sections visually', '在段落之间加一条分隔线'), hint: '---', icon: 'divider',
    keywords: 'divider rule hr fengexian 分割线 分隔线', run: (view) => insertBlock(view, '---') };
  // Typing `[[` opens the link menu; this entry does the same from the slash menu.
  const typeTrigger = (view: EditorView, trigger: string) => {
    const { head } = view.state.selection.main;
    view.dispatch({ changes: { from: head, insert: trigger }, selection: { anchor: head + trigger.length }, userEvent: 'input.type' });
  };
  // An embed or a trip item's card stands on its own line, so on a line with text its trigger starts a new one after it.
  const typeOnOwnLine = (view: EditorView, trigger: string) => {
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    if (line.text.trim()) view.dispatch({ selection: { anchor: line.to } });
    typeTrigger(view, `${line.text.trim() ? '\n' : ''}${trigger}`);
  };
  const noteLink: MenuItem[] = options.searchNotes ? [{ label: t('Link to note', '链接到笔记'),
    description: t('Point to another note; renaming it keeps the link', '指向另一篇笔记，改名后链接依然有效'), hint: '[[',
    icon: 'note', keywords: 'link note wiki reference lianjie biji 链接 笔记 引用 双链', run: (view) => typeTrigger(view, '[[') },
  { label: t('Embed note', '嵌入笔记'), description: t('Show another note, or one of its sections, here', '在这里显示另一篇笔记或其中一节'),
    hint: '![[', icon: 'embed', keywords: 'embed transclude note qianru 嵌入 笔记 引用', run: (view) => typeOnOwnLine(view, '![[') }] : [];
  const blocks = (): MenuItem[] => [
    { label: t('Text', '文本'), description: t('Plain paragraph', '普通段落'), icon: 'T',
      keywords: 'text paragraph plain zhengwen 正文 段落', run: run(setBlock('')) },
    { label: t('Heading 1', '一级标题'), description: t('Big section heading', '大号章节标题'), hint: '#', icon: 'H1',
      keywords: 'h1 heading title biaoti 标题 一级标题', run: run(setBlock('# ')) },
    { label: t('Heading 2', '二级标题'), description: t('Medium section heading', '中号章节标题'), hint: '##', icon: 'H2',
      keywords: 'h2 heading biaoti 标题 二级标题', run: run(setBlock('## ')) },
    { label: t('Heading 3', '三级标题'), description: t('Small section heading', '小号章节标题'), hint: '###', icon: 'H3',
      keywords: 'h3 heading biaoti 标题 三级标题', run: run(setBlock('### ')) },
    { label: t('To-do list', '待办清单'), description: t('Track tasks with checkboxes', '用复选框跟踪事项'),
      hint: '[ ]', icon: 'todo', keywords: 'todo task checkbox daiban 待办 清单 任务', run: run(setBlock('- [ ] ')) },
    { label: t('Bulleted list', '无序列表'), description: t('A simple bulleted list', '简单的项目符号列表'),
      hint: '-', icon: 'bullet', keywords: 'bullet list liebiao 列表 无序列表', run: run(setBlock('- ')) },
    { label: t('Quote', '引用'), description: t('Capture a quotation', '摘录一段引文'), hint: '>', icon: 'quote',
      keywords: 'quote blockquote yinyong 引用 引文', run: run(setBlock('> ')) },
    { label: t('Callout', '提示块'), description: t('A tinted box for tips and warnings', '用色块标出小贴士和注意事项'), hint: '> [!tip]',
      icon: 'callout', keywords: 'callout tip note warning admonition tishi 提示 小贴士 注意 警告', run: run(setBlock('> [!tip] ')) },
  ];
  // `![[trek:` narrows the link menu to the trip's items, as this entry types it.
  const tripItem = (): MenuItem[] => options.tripObjects?.().length ? [{ label: t('Trip item', '行程内容'),
    description: t('A place, booking, day or stay from this trip', '这次旅行中的地点、预订、日程或住宿'), hint: '![[trek:',
    icon: 'place', keywords: 'trip place booking reservation day stay hotel xingcheng 行程 地点 预订 日程 住宿 酒店',
    run: (view) => typeOnOwnLine(view, `![[${TREK_PREFIX}`) }] : [];
  const fromTrip = (): MenuItem[] => [...tripItem(), ...tripPdfs()];
  return {
    slash: () => [
      ...(image.length ? [{ label: t('Media', '媒体'), items: image }] : []),
      ...(fromTrip().length ? [{ label: t('From this trip', '来自这次旅行'), items: fromTrip() }] : []),
      ...(noteLink.length ? [{ label: t('Links', '链接'), items: noteLink }] : []),
      { label: t('Basic blocks', '基础块'), items: [...blocks(), divider] },
    ],
    links: options.searchNotes && (async (query, view) => {
      if (query.startsWith(TREK_PREFIX)) return tripSection(query.slice(TREK_PREFIX.length));
      if (query.includes('#')) {
        return [{ items: await headingItems(options, view, query.slice(0, query.indexOf('#')), query.slice(query.indexOf('#') + 1), t) }];
      }
      const notes = (await options.searchNotes!(query)).map((target): MenuItem => ({
        label: target.title, icon: target.icon || 'note',
        description: [target.path, target.restricted && t('Some readers can’t open it', '部分读者无法查看')]
          .filter(Boolean).join(' · ') || undefined,
        run: (view) => { insertNoteLink(view, target); options.onLinked?.(target); },
      }));
      return [{ items: notes }, ...(query.trim() ? tripSection(query) : [])];
    }),
    context: (view) => {
      const selected = !view.state.selection.main.empty; const typed = titleLinks(view.state).length;
      return [
        ...(typed ? [{ label: t('Links', '链接'), items: [{ label: t('Keep {count} typed links working after renames',
          '让 {count} 个手打的链接在改名后依然有效', { count: typed }), icon: 'link', run: upgradeLinks }] }] : []),
        { layout: 'icons', label: t('Format', '格式'), items: [
          { label: t('Bold', '加粗'), hint: '⌘B', icon: 'B', run: run(toggleInline('**')) },
          { label: t('Italic', '斜体'), hint: '⌘I', icon: 'I', run: run(toggleInline('*')) },
          { label: t('Strikethrough', '删除线'), hint: '⌘⇧X', icon: 'S', run: run(toggleInline('~~')) },
          { label: t('Inline code', '行内代码'), hint: '⌘E', icon: 'code', run: run(toggleInline('`')) },
          { label: t('Link', '链接'), hint: '⌘K', icon: 'link', run: run(insertLink) },
        ] },
        { label: t('Insert', '插入'), items: [...image, ...noteLink, divider] },
        { layout: 'icons', label: t('Turn into', '转换为'), items: blocks() },
        { items: [
          { label: t('Cut', '剪切'), hint: '⌘X', icon: 'cut', disabled: !selected, run: clipboard('cut') },
          { label: t('Copy', '复制'), hint: '⌘C', icon: 'copy', disabled: !selected, run: clipboard('copy') },
          // Scripts in the sandboxed frame cannot read the clipboard, so paste stays on the keyboard.
          { label: t('Paste', '粘贴'), hint: '⌘V', icon: 'paste', disabled: true },
        ] },
      ];
    },
    text: (kind) => kind === 'link' ? {
      empty: t('No matching notes', '没有匹配的笔记'), loading: t('Searching notes…', '正在查找笔记…'),
      footer: t('↑↓ to choose · ↵ to link · esc to close', '↑↓ 选择 · ↵ 链接 · esc 关闭') }
      : { empty: t('No matching blocks', '没有匹配的块'),
        footer: t('↑↓ to choose · ↵ to insert · esc to close', '↑↓ 选择 · ↵ 插入 · esc 关闭') },
  };
}

const formattingKeymap = [
  { key: 'Mod-b', run: toggleInline('**') }, { key: 'Mod-i', run: toggleInline('*') }, { key: 'Mod-e', run: toggleInline('`') },
  { key: 'Mod-Shift-x', run: toggleInline('~~') }, { key: 'Mod-k', run: insertLink },
  ...[0, 1, 2, 3, 4, 5, 6].map((level) => ({ key: `Mod-${level}`, run: setHeading(level) })),
];

function linkAt(view: EditorView, pos: number) {
  const { state } = view;
  const wiki = wikilinks(state).find((link) => pos >= link.from && pos <= link.to);
  if (wiki) {
    const { note, heading } = splitTarget(wiki.target);
    if (!note) return `${HEADING_LINK}${encodeURIComponent(heading)}`;
    const target = state.field(assetsField).references[note];
    return target?.id ? noteHref(target.id, heading) : null;
  }
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name === 'Link' || node.name === 'Autolink') {
      const url = node.getChild('URL');
      return url ? state.sliceDoc(url.from, url.to) : null;
    }
  }
  return null;
}

// Refuses typing or pasting past the server's content limits, which would otherwise end a co-editing session.
// Only user input is checked; remote collaborators' updates always apply so the shared document never forks.
const encoder = new TextEncoder();
const contentLimit = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.annotation(Transaction.userEvent) === undefined) return tr;
  const { length } = tr.newDoc;
  const tooLong = length > maxContentChars
    || (length * 3 > maxContentBytes && encoder.encode(tr.newDoc.toString()).length > maxContentBytes);
  return tooLong ? [] : tr;
});

export function createLiveEditor(parent: HTMLElement, doc: string, options: LiveEditorOptions) {
  const external = StateEffect.define<null>();
  const follow = (target: EditorView, href: string) => {
    if (href.startsWith(HEADING_LINK)) revealHeadingIn(target, decodeURIComponent(href.slice(HEADING_LINK.length)));
    else options.onOpenLink(href);
  };
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, extensions: [
      options.collab || [history(), keymap.of(historyKeymap)], new LanguageSupport(markdownLanguage), EditorView.lineWrapping,
      assetsField, focusField, previewField, contentLimit, linkOpener.of((href) => follow(view, href)),
      editorMenu(menuSource(options)),
      placeholder(options.t('Type / for blocks and images, or paste and drop images here', '输入 / 插入图片和块，也可直接粘贴或拖入图片')),
      keymap.of([...formattingKeymap,
        ...(options.onPickImage ? [{ key: 'Mod-Shift-i', run: () => { options.onPickImage!(); return true; } }] : []),
        ...markdownKeymap, ...defaultKeymap, indentWithTab]),
      EditorView.focusChangeEffect.of((_state, focusing) => setFocus.of(focusing)),
      EditorView.contentAttributes.of({ 'aria-multiline': 'true',
        ...(options.labelledBy ? { 'aria-labelledby': options.labelledBy } : {}) }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !update.transactions.some((tr) => tr.effects.some((effect) => effect.is(external))))
          options.onChange(update.state.doc.toString());
      }),
      // Mod-click follows a link, as in Typora; a plain click places the caret and reveals the syntax.
      EditorView.domEventHandlers({ mousedown(event, target) {
        if (!(event.metaKey || event.ctrlKey)) return false;
        const pos = target.posAtCoords({ x: event.clientX, y: event.clientY });
        const href = pos === null ? null : linkAt(target, pos);
        if (!href) return false;
        event.preventDefault(); follow(target, href);
        return true;
      }, paste(event) {
        const files = attachmentFiles(event.clipboardData?.files);
        if (!files.length || !options.onImageFiles) return false;
        event.preventDefault(); options.onImageFiles(files);
        return true;
      }, drop(event, target) {
        const files = attachmentFiles(event.dataTransfer?.files);
        if (!files.length || !options.onImageFiles) return false;
        event.preventDefault();
        const pos = target.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos !== null) target.dispatch({ selection: { anchor: pos } });
        options.onImageFiles(files);
        return true;
      } }),
    ] }),
  });
  // Read-only handle for integration tests and console debugging; jsdom cannot type into contenteditable.
  Object.defineProperty(parent, 'liveEditorView', { value: view, configurable: true });
  return {
    view,
    setValue(value: string) {
      if (value !== view.state.doc.toString()) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value },
        effects: external.of(null) });
    },
    setAssets(assets: Assets) { view.dispatch({ effects: setAssets.of(assets) }); },
    insertImage(markdown: string) { insertBlock(view, markdown); view.focus(); },
    destroy() { view.destroy(); },
  };
}

