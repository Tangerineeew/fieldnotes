import { Prec, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from '@codemirror/view';
import { TREK_ICONS } from './trek-objects';
import { ICON_PATHS, iconElement } from './icons';


export type MenuItem = { label: string; description?: string; hint?: string; icon: string;
  keywords?: string; disabled?: boolean; run?: (view: EditorView) => void };
// `icons` sections render as one row of icon buttons (formatting, block type); `list` sections as labelled rows.
export type MenuSection = { label?: string; layout?: 'list' | 'icons'; items: MenuItem[] };
export type MenuSource = {
  context: (view: EditorView) => MenuSection[];
  slash: () => MenuSection[];
  // What `[[` may link to, in sections; each item inserts its own link in place of the typed `[[query`.
  links?: (query: string, view: EditorView) => Promise<MenuSection[]>;
  text: (kind: Kind) => { empty: string; footer: string; loading?: string };
};
export type Kind = 'slash' | 'context' | 'link';

// Line icons drawn on the same 24px grid and stroke as the rest of Fieldnotes; anything else is shown as a text glyph.
const ICONS: Record<string, string> = {
  image: 'M4.5 5.5h15v13h-15z M4.5 15.5l4-3.5 3.5 3 2.5-2 5 4 M9 10a1.4 1.4 0 1 0 0-.01',
  todo: 'M5 5h14v14H5z M8.5 12.2l2.4 2.4 4.6-5',
  bullet: 'M10 7h9 M10 12h9 M10 17h9 M5.5 7h.01 M5.5 12h.01 M5.5 17h.01',
  quote: 'M6 6v12 M10.5 8h8 M10.5 12h8 M10.5 16h5',
  divider: 'M4 12h16 M8 7h8 M8 17h8',
  code: 'M9 7l-5 5 5 5 M15 7l5 5-5 5',
  link: 'M10 14a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 0 0 5.7 5.7l1-1',
  cut: 'M7 7a2.2 2.2 0 1 0 0-.01 M7 17a2.2 2.2 0 1 0 0-.01 M8.8 8.3L19 17 M8.8 15.7L19 7',
  copy: ICON_PATHS.copy,
  paste: 'M8 5H6v15h12V5h-2 M9 3.5h6v3H9z',
  note: ICON_PATHS.note,
  embed: 'M4.5 5.5h15v13h-15z M8 9.5h8 M8 12.5h8 M8 15.5h5',
  callout: 'M4.5 6.5h15v11h-15z M8 10.5h.01 M11 10.5h5.5 M8 14h8.5',
  pdf: 'M7 3.5h7.5L18 7v13.5H7z M14.5 3.5V7H18 M10.5 17.5v-6h2a1.8 1.8 0 0 1 0 3.6h-2',
  ...TREK_ICONS,
};
const actionable = (item: MenuItem) => Boolean(item.run) && !item.disabled;
// Ranks like Notion: title prefix, then a title word prefix, then a keyword prefix; plain substrings never match.
function rank(item: MenuItem, query: string) {
  const title = item.label.toLowerCase(); const needle = query.toLowerCase();
  // CJK has no word breaks, so a CJK query may match anywhere (标题 → 一级标题).
  const wordStarts = (text: string, breaks: RegExp) => text.split(breaks).some((word) => word.startsWith(needle))
    || (/[^\x00-\x7f]/.test(needle) && text.includes(needle));
  if (title.startsWith(needle)) return 0;
  if (wordStarts(title, /[\s-]+/)) return 1;
  if (wordStarts((item.keywords || '').toLowerCase(), /\s+/)) return 2;
  return -1;
}


function icon(doc: Document, item: MenuItem) {
  const path = ICONS[item.icon];
  if (!path) {
    const glyph = doc.createElement('span'); glyph.className = 'fn-editor-menu-glyph';
    glyph.dataset.glyph = item.icon; glyph.textContent = item.icon;
    return glyph;
  }
  return iconElement(doc, path, 'fn-editor-menu-svg');
}

// Wraps the first case-insensitive match of `query` in <mark> so filtering shows why a row matched.
function highlighted(doc: Document, text: string, query: string) {
  const span = doc.createElement('span'); span.className = 'fn-editor-menu-title';
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) { span.textContent = text; return span; }
  const mark = doc.createElement('mark'); mark.textContent = text.slice(at, at + query.length);
  span.append(text.slice(0, at), mark, text.slice(at + query.length));
  return span;
}


// One floating menu serves both Notion-style entry points: `/` at the start of a word, and right-click.
// Shift + right-click still opens the browser's own menu.
class MenuView {
  element: HTMLElement | null = null;
  kind: Kind = 'context';
  sections: MenuSection[] = [];
  buttons: HTMLButtonElement[] = [];
  items: MenuItem[] = [];
  index = 0;
  // Where the typed trigger (`/` or `[[`) starts while its menu is open.
  trigger: number | null = null;
  query = '';
  searches = 0;
  searchTimer = 0;

  constructor(readonly view: EditorView, readonly source: MenuSource) {}

  update(update: ViewUpdate) {
    const { state } = update; const head = state.selection.main.head;
    if (this.trigger === null) {
      if (!update.docChanged || !update.transactions.some((tr) => tr.isUserEvent('input.type'))) return;
      // `[[trek:` opens the link menu already narrowed to the trip's items.
      const link = this.source.links && /\[\[(?:trek:)?$/.exec(state.sliceDoc(Math.max(0, head - 7), head));
      const kind: Kind | null = link ? 'link' : state.sliceDoc(head - 1, head) === '/' ? 'slash' : null;
      if (!kind) return;
      const start = head - (link ? link[0].length : 1);
      if (kind === 'slash' && start > state.doc.lineAt(head).from && !/\s/.test(state.sliceDoc(start - 1, start))) return;
      this.trigger = start;
      this.view.requestMeasure({ read: (view) => view.coordsAtPos(start), write: (coords) => {
        if (this.trigger !== start) return;
        this.open(kind, kind === 'slash' ? this.source.slash() : [], coords?.left ?? 0, (coords?.bottom ?? 0) + 6, coords?.top ?? 0, start);
        if (kind !== 'link') return;
        this.query = this.view.state.sliceDoc(start + 2, this.view.state.selection.main.head); this.search(this.query);
      } });
      return;
    }
    if (!this.element) return;
    const from = update.changes.mapPos(this.trigger);
    if (this.kind === 'link') {
      const query = state.sliceDoc(from + 2, head);
      // A title may hold spaces, so the link menu stays open until the brackets close, the line ends or the query runs long.
      if (state.sliceDoc(from, from + 2) !== '[[' || head < from + 2 || /[\]\n]/.test(query) || query.length > 80) { this.close(); return; }
      this.trigger = from;
      if (query !== this.query) { this.query = query; this.search(query); }
      return;
    }
    const query = state.sliceDoc(from + 1, head);
    // Like Notion, a run of non-matching characters eventually gives up instead of trailing the caret forever.
    if (state.sliceDoc(from, from + 1) !== '/' || head <= from || /\s/.test(query) || query.length > 24
      || state.doc.lineAt(head).number !== state.doc.lineAt(from).number) { this.close(); return; }
    this.trigger = from; this.query = query;
    const matches = this.source.slash().flatMap((section) => section.items)
      .map((item, order) => ({ item, order, score: actionable(item) ? rank(item, query) : -1 })).filter(({ score }) => score >= 0)
      .sort((a, b) => a.score - b.score || a.order - b.order).map(({ item }) => item);
    this.render(query ? [{ items: matches }] : this.source.slash());
  }

  // Asks for link targets once typing pauses; a slower answer to an older query never replaces a newer one.
  search(query: string) {
    const ticket = ++this.searches; const win = this.view.dom.ownerDocument.defaultView!;
    win.clearTimeout(this.searchTimer);
    if (!this.items.length) this.render([], true);
    this.searchTimer = win.setTimeout(() => {
      this.source.links!(query, this.view).then((sections) => sections, () => []).then((sections) => {
        if (ticket !== this.searches || !this.element || this.kind !== 'link') return;
        this.render(sections.filter((section) => section.items.length));
      });
    }, query ? 120 : 0);
  }

  open(kind: Kind, sections: MenuSection[], x: number, y: number, above: number, trigger: number | null = null) {
    this.close();
    this.index = -1;
    const doc = this.view.dom.ownerDocument;
    this.kind = kind; this.trigger = trigger; this.query = '';
    this.element = doc.createElement('div');
    // The link menu is a slash-style listbox that searches notes instead of filtering blocks.
    this.element.className = `fn-editor-menu fn-editor-menu--${kind === 'link' ? 'slash fn-editor-menu--link' : kind}`;
    this.element.setAttribute('role', kind === 'context' ? 'menu' : 'listbox');
    this.element.id = `fn-editor-menu-${Math.random().toString(36).slice(2)}`;
    doc.body.append(this.element);
    doc.addEventListener('mousedown', this.outside, true);
    this.render(sections);
    // The slash menu prefers opening below the caret, shrinking to fit, and flips only when little room is left below.
    // A context menu instead slides up as a whole, like native menus, so every item stays visible.
    const { width, height } = this.element.getBoundingClientRect(); const win = doc.defaultView!;
    if (kind === 'context') {
      this.element.style.left = `${Math.max(8, Math.min(x, win.innerWidth - width - 8))}px`;
      this.element.style.top = `${Math.max(8, Math.min(y, win.innerHeight - height - 8))}px`;
      return;
    }
    // Link results arrive after opening, so that menu reserves room for a full list rather than its first, empty one.
    const expected = kind === 'link' ? Math.max(height, 320) : height;
    const below = win.innerHeight - y - 8; const flip = expected > below && below < 220 && above - 14 > below;
    this.element.style.maxHeight = `${Math.min(expected, flip ? above - 14 : Math.max(below, 120))}px`;
    this.element.style.left = `${Math.max(8, Math.min(x, win.innerWidth - width - 8))}px`;
    // A flipped menu hangs from just above the caret, so it stays attached however tall its results grow.
    if (flip) this.element.style.bottom = `${win.innerHeight - above + 6}px`; else this.element.style.top = `${y}px`;
    this.element.style.transformOrigin = flip ? 'bottom left' : 'top left';
    this.view.contentDOM.setAttribute('aria-controls', this.element.id); this.view.contentDOM.setAttribute('aria-expanded', 'true');
  }

  render(sections: MenuSection[], loading = false) {
    const element = this.element!; const doc = element.ownerDocument;
    const { empty, footer, loading: searching } = this.source.text(this.kind);
    this.sections = sections; this.buttons = []; this.items = [];
    const nodes: Node[] = [];
    sections.forEach((section, position) => {
      if (position > 0 && this.kind === 'context')
        nodes.push(Object.assign(doc.createElement('div'), { className: 'fn-editor-menu-separator' }));
      if (section.label)
        nodes.push(Object.assign(doc.createElement('div'), { className: 'fn-editor-menu-section', textContent: section.label }));
      const group = doc.createElement('div');
      group.className = section.layout === 'icons' ? 'fn-editor-menu-icons' : 'fn-editor-menu-group'; group.setAttribute('role', 'group');
      if (section.label) group.setAttribute('aria-label', section.label);
      group.append(...section.items.map((item) => this.button(item, section.layout === 'icons')));
      nodes.push(group);
    });
    if (!this.items.length) nodes.push(Object.assign(doc.createElement('div'),
      { className: 'fn-editor-menu-empty', textContent: loading && searching ? searching : empty }));
    if (this.kind !== 'context')
      nodes.push(Object.assign(doc.createElement('div'), { className: 'fn-editor-menu-footer', textContent: footer }));
    element.replaceChildren(...nodes);
    // Typing filters toward a choice, so the slash menu pre-selects one; a pointer-opened menu waits for hover or arrows.
    this.highlight(this.kind !== 'context' ? this.items.findIndex(actionable) : -1);
  }

  button(item: MenuItem, compact: boolean) {
    const doc = this.element!.ownerDocument; const position = this.items.length;
    const button = doc.createElement('button');
    button.type = 'button'; button.disabled = Boolean(item.disabled); button.id = `${this.element!.id}-${position}`;
    button.setAttribute('role', this.kind === 'context' ? 'menuitem' : 'option');
    button.className = compact ? 'fn-editor-menu-icon' : 'fn-editor-menu-item';
    if (compact) {
      button.setAttribute('aria-label', item.label); button.title = item.hint ? `${item.label}  ${item.hint}` : item.label;
      button.append(icon(doc, item));
    } else {
      const tile = doc.createElement('span'); tile.className = 'fn-editor-menu-tile'; tile.append(icon(doc, item));
      const text = doc.createElement('span'); text.className = 'fn-editor-menu-text';
      text.append(highlighted(doc, item.label, this.query));
      if (item.description && this.kind !== 'context')
        text.append(Object.assign(doc.createElement('span'), { className: 'fn-editor-menu-description', textContent: item.description }));
      button.append(tile, text);
      if (item.hint) button.append(Object.assign(doc.createElement('kbd'), { textContent: item.hint }));
    }
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('mousemove', () => { if (actionable(item) && this.index !== position) this.highlight(position); });
    button.addEventListener('click', () => this.choose(position));
    this.buttons.push(button); this.items.push(item);
    return button;
  }

  highlight(position: number) {
    this.buttons[this.index]?.classList.remove('is-active');
    this.index = position;
    const active = this.buttons[position];
    if (!active) { this.view.contentDOM.removeAttribute('aria-activedescendant'); return; }
    active.classList.add('is-active'); active.scrollIntoView?.({ block: 'nearest' });
    if (this.kind !== 'context') this.view.contentDOM.setAttribute('aria-activedescendant', active.id);
  }

  move(step: number) {
    const choices = this.items.map((item, position) => (actionable(item) ? position : -1)).filter((position) => position >= 0);
    if (!choices.length) return;
    const current = choices.indexOf(this.index);
    this.highlight(choices[current < 0 ? (step > 0 ? 0 : choices.length - 1) : (current + step + choices.length) % choices.length]);
  }

  choose(position = this.index) {
    const item = this.items[position];
    if (!item || !actionable(item)) return;
    const { view } = this; const trigger = this.trigger; const kind = this.kind;
    this.close();
    if (trigger !== null) {
      // A link replaces the typed `[[query` and any `]]` already closing it.
      const head = view.state.selection.main.head;
      const to = kind === 'link' && view.state.sliceDoc(head, head + 2) === ']]' ? head + 2 : head;
      view.dispatch({ changes: { from: trigger, to } });
    }
    item.run!(view); view.focus();
  }

  outside = (event: Event) => { if (!this.element?.contains(event.target as Node)) this.close(); };

  close() {
    this.searches += 1; this.view.dom.ownerDocument.defaultView?.clearTimeout(this.searchTimer);
    this.element?.ownerDocument.removeEventListener('mousedown', this.outside, true);
    for (const name of ['aria-controls', 'aria-expanded', 'aria-activedescendant']) this.view.contentDOM.removeAttribute(name);
    this.element?.remove(); this.element = null; this.trigger = null;
  }

  destroy() { this.close(); }
}


export function editorMenu(source: MenuSource): Extension {
  const plugin = ViewPlugin.define((view) => new MenuView(view, source));
  const whenOpen = (fn: (menu: MenuView) => void) => (view: EditorView) => {
    const menu = view.plugin(plugin);
    if (!menu?.element) return false;
    fn(menu); return true;
  };
  // With nothing highlighted (no match), Enter and Tab close the menu and keep their usual meaning.
  const choose = (view: EditorView) => {
    const menu = view.plugin(plugin);
    if (!menu?.element) return false;
    if (menu.index < 0 && menu.kind !== 'context') { menu.close(); return false; }
    menu.choose(); return true;
  };
  return [
    plugin,
    Prec.highest(keymap.of([
      { key: 'ArrowDown', run: whenOpen((menu) => menu.move(1)) }, { key: 'ArrowUp', run: whenOpen((menu) => menu.move(-1)) },
      { key: 'ArrowRight', run: (view) => view.plugin(plugin)?.kind === 'context' && whenOpen((menu) => menu.move(1))(view) },
      { key: 'ArrowLeft', run: (view) => view.plugin(plugin)?.kind === 'context' && whenOpen((menu) => menu.move(-1))(view) },
      { key: 'Enter', run: choose }, { key: 'Tab', run: choose },
      { key: 'Escape', run: whenOpen((menu) => menu.close()) },
    ])),
    EditorView.domEventHandlers({
      contextmenu(event, view) {
        if (event.shiftKey) return false;
        event.preventDefault();
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        const { from, to } = view.state.selection.main;
        if (pos !== null && (pos < from || pos > to)) view.dispatch({ selection: { anchor: pos } });
        view.plugin(plugin)?.open('context', source.context(view), event.clientX, event.clientY, event.clientY);
        return true;
      },
      blur(_event, view) { view.plugin(plugin)?.close(); },
    }),
  ];
}
