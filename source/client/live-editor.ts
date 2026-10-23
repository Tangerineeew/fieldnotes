import { EditorSelection, EditorState, StateEffect, StateField, Transaction, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, keymap, placeholder, type Command, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { LanguageSupport, ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown';
import type { SyntaxNode } from '@lezer/common';
import { IMAGE_ERROR, renderMarkdownInto, type ImageSources, type ReferenceLinks } from './markdown';
import { imageFiles } from './images';
import { editorMenu, type MenuItem, type MenuSource } from './editor-menu';
import { maxContentBytes, maxContentChars } from '../shared/limits.json';
import type { Translate } from './i18n';


// Typora/MarkText-style live preview: the Markdown text is the only source of truth. Syntax marks are
// decorations that stay visible (dimmed) around the caret and are hidden everywhere else.
export type Assets = { imageSources: ImageSources; references: ReferenceLinks };
// `collab` replaces local history with the shared document's own sync and undo manager.
// `onImageFiles` receives pasted or dropped images and `onPickImage` asks for a file; the caller uploads and calls `insertImage`.
export type LiveEditorOptions = { onChange: (markdown: string) => void; onOpenLink: (href: string) => void;
  onImageFiles?: (files: File[]) => void;
  onPickImage?: () => void; t?: Translate; labelledBy?: string; collab?: Extension[] };

export const setAssets = StateEffect.define<Assets>();
const setFocus = StateEffect.define<boolean>();
const WIKILINK = /\[\[([^\]\n]+)\]\]/g;
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


class TableWidget extends WidgetType {
  constructor(readonly source: string, readonly assets: Assets) { super(); }

  eq(other: TableWidget) { return other.source === this.source && other.assets === this.assets; }

  toDOM(view: EditorView) {
    const wrapper = document.createElement('div');
    wrapper.className = 'fn-md-table';
    renderMarkdownInto(wrapper, this.source, this.assets.imageSources, this.assets.references);
    // Clicking a rendered table reveals its source for editing.
    wrapper.addEventListener('mousedown', (event) => {
      event.preventDefault();
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

function wikilinks(state: EditorState) {
  return [...state.doc.toString().matchAll(WIKILINK)].map((match) =>
    ({ from: match.index!, to: match.index! + match[0].length, title: match[1].trim() }));
}

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
  for (const link of links) {
    const active = touches(link.from, link.to);
    syntaxMark(link.from, link.from + 2, active); syntaxMark(link.to - 2, link.to, active);
    ranges.push(markClass('fn-md-link fn-md-wikilink').range(link.from + 2, link.to - 2));
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
      case 'Blockquote':
        addLines(from, to, 'fn-md-quote');
        return;
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
        ranges.push(Decoration.replace({ widget: new TableWidget(state.sliceDoc(start, end), assets), block: true }).range(start, end));
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
const BLOCK_MARKER = /^(?:#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|>\s?|\d+\.\s+)/;
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

function menuSource(options: LiveEditorOptions): MenuSource {
  const t: Translate = (en, zh, vars) => options.t?.(en, zh, vars) ?? en;
  const run = (command: Command) => (view: EditorView) => { command(view); };
  const clipboard = (command: 'cut' | 'copy') => (view: EditorView) => { view.dom.ownerDocument.execCommand(command); };
  const image: MenuItem[] = options.onPickImage ? [{ label: t('Image', '图片'),
    description: t('Upload from this device', '从设备上传，压缩后保存'), hint: '⌘⇧I',
    icon: 'image', keywords: 'image picture photo upload tupian 图片 照片 上传', run: () => options.onPickImage!() }] : [];
  const divider: MenuItem = { label: t('Divider', '分割线'),
    description: t('Separate sections visually', '在段落之间加一条分隔线'), hint: '---', icon: 'divider',
    keywords: 'divider rule hr fengexian 分割线 分隔线', run: (view) => insertBlock(view, '---') };
  const blocks = (): MenuItem[] => [
    { label: t('Text', '正文'), description: t('Plain paragraph', '普通段落'), icon: 'T',
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
  ];
  return {
    slash: () => [
      ...(image.length ? [{ label: t('Media', '媒体'), items: image }] : []),
      { label: t('Basic blocks', '基础块'), items: [...blocks(), divider] },
    ],
    context: (view) => {
      const selected = !view.state.selection.main.empty;
      return [
        { layout: 'icons', label: t('Format', '格式'), items: [
          { label: t('Bold', '加粗'), hint: '⌘B', icon: 'B', run: run(toggleInline('**')) },
          { label: t('Italic', '斜体'), hint: '⌘I', icon: 'I', run: run(toggleInline('*')) },
          { label: t('Strikethrough', '删除线'), hint: '⌘⇧X', icon: 'S', run: run(toggleInline('~~')) },
          { label: t('Inline code', '行内代码'), hint: '⌘E', icon: 'code', run: run(toggleInline('`')) },
          { label: t('Link', '链接'), hint: '⌘K', icon: 'link', run: run(insertLink) },
        ] },
        { label: t('Insert', '插入'), items: [...image, divider] },
        { layout: 'icons', label: t('Turn into', '转换为'), items: blocks() },
        { items: [
          { label: t('Cut', '剪切'), hint: '⌘X', icon: 'cut', disabled: !selected, run: clipboard('cut') },
          { label: t('Copy', '复制'), hint: '⌘C', icon: 'copy', disabled: !selected, run: clipboard('copy') },
          // Scripts in the sandboxed frame cannot read the clipboard, so paste stays on the keyboard.
          { label: t('Paste', '粘贴'), hint: '⌘V', icon: 'paste', disabled: true },
        ] },
      ];
    },
    text: () => ({ empty: t('No matching blocks', '没有匹配的块'),
      footer: t('↑↓ to choose · ↵ to insert · esc to close', '↑↓ 选择 · ↵ 插入 · esc 关闭') }),
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
    const target = state.field(assetsField).references[wiki.title];
    return target ? `fieldnotes://note/${target.id}` : null;
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
  const tooLong = length > maxContentChars || (length * 3 > maxContentBytes && encoder.encode(tr.newDoc.toString()).length > maxContentBytes);
  return tooLong ? [] : tr;
});

export function createLiveEditor(parent: HTMLElement, doc: string, options: LiveEditorOptions) {
  const external = StateEffect.define<null>();
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, extensions: [
      options.collab || [history(), keymap.of(historyKeymap)], new LanguageSupport(markdownLanguage), EditorView.lineWrapping,
        assetsField, focusField, previewField, contentLimit,
      editorMenu(menuSource(options)),
      placeholder(options.t?.('Type / for blocks and images, or paste and drop images here',
        '输入 / 插入图片和块，也可直接粘贴或拖入图片') ?? ''),
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
        event.preventDefault(); options.onOpenLink(href);
        return true;
      }, paste(event) {
        const files = imageFiles(event.clipboardData?.files);
        if (!files.length || !options.onImageFiles) return false;
        event.preventDefault(); options.onImageFiles(files);
        return true;
      }, drop(event, target) {
        const files = imageFiles(event.dataTransfer?.files);
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

