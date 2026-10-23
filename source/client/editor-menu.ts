import { Prec, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from '@codemirror/view';


export type MenuItem = { label: string; description?: string; hint?: string; icon: string;
  keywords?: string; disabled?: boolean; run?: (view: EditorView) => void };
// `icons` sections render as one row of icon buttons (formatting, block type); `list` sections as labelled rows.
export type MenuSection = { label?: string; layout?: 'list' | 'icons'; items: MenuItem[] };
export type MenuSource = {
  context: (view: EditorView) => MenuSection[];
  slash: () => MenuSection[];
  text: () => { empty: string; footer: string };
};
type Kind = 'slash' | 'context';

const SVG = 'http://www.w3.org/2000/svg';
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
  copy: 'M9 9h10v10H9z M5 15V5h10',
  paste: 'M8 5H6v15h12V5h-2 M9 3.5h6v3H9z',
};
const actionable = (item: MenuItem) => Boolean(item.run) && !item.disabled;
// Ranks like Notion: title prefix, then a title word prefix, then a keyword prefix; plain substrings never match.
function rank(item: MenuItem, query: string) {
  const title = item.label.toLowerCase(); const needle = query.toLowerCase();
  if (title.startsWith(needle)) return 0;
  // CJK titles have no word breaks, so a CJK query may match anywhere in the title (标题 → 一级标题).
  if (title.split(/[\s-]+/).some((word) => word.startsWith(needle)) || (/[^\x00-\x7f]/.test(needle) && title.includes(needle))) return 1;
  const keywords = (item.keywords || '').toLowerCase();
  if (keywords.split(/\s+/).some((word) => word.startsWith(needle)) || (/[^\x00-\x7f]/.test(needle) && keywords.includes(needle))) return 2;
  return -1;
}


function icon(doc: Document, item: MenuItem) {
  const path = ICONS[item.icon];
  if (!path) {
    const glyph = doc.createElement('span'); glyph.className = 'fn-editor-menu-glyph';
      glyph.dataset.glyph = item.icon; glyph.textContent = item.icon;
    return glyph;
  }
  const svg = doc.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'fn-editor-menu-svg');
  const shape = doc.createElementNS(SVG, 'path'); shape.setAttribute('d', path); svg.append(shape);
  return svg;
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
  slash: number | null = null;
  query = '';

  constructor(readonly view: EditorView, readonly source: MenuSource) {}

  update(update: ViewUpdate) {
    const { state } = update; const head = state.selection.main.head;
    if (this.slash === null) {
      if (!update.docChanged || !update.transactions.some((tr) => tr.isUserEvent('input.type'))
        || state.sliceDoc(head - 1, head) !== '/') return;
      const start = head - 1;
      if (start > state.doc.lineAt(head).from && !/\s/.test(state.sliceDoc(start - 1, start))) return;
      this.slash = start;
      this.view.requestMeasure({ read: (view) => view.coordsAtPos(start), write: (coords) => {
        if (this.slash === start) this.open('slash', this.source.slash(), coords?.left ?? 0, (coords?.bottom ?? 0) + 6,
          coords?.top ?? 0, start);
      } });
      return;
    }
    if (!this.element) return;
    const from = update.changes.mapPos(this.slash);
    const query = state.sliceDoc(from + 1, head);
    // Like Notion, a run of non-matching characters eventually gives up instead of trailing the caret forever.
    if (state.sliceDoc(from, from + 1) !== '/' || head <= from || /\s/.test(query) || query.length > 24
      || state.doc.lineAt(head).number !== state.doc.lineAt(from).number) { this.close(); return; }
    this.slash = from; this.query = query;
    const matches = this.source.slash().flatMap((section) => section.items)
      .map((item, order) => ({ item, order, score: actionable(item) ? rank(item, query) : -1 })).filter(({ score }) => score >= 0)
      .sort((a, b) => a.score - b.score || a.order - b.order).map(({ item }) => item);
    this.render(query ? [{ items: matches }] : this.source.slash());
  }

  open(kind: Kind, sections: MenuSection[], x: number, y: number, above: number, slash: number | null = null) {
    this.close();
    this.index = -1;
    const doc = this.view.dom.ownerDocument;
    this.kind = kind; this.slash = slash; this.query = '';
    this.element = doc.createElement('div');
    this.element.className = `fn-editor-menu fn-editor-menu--${kind}`;
    this.element.setAttribute('role', kind === 'slash' ? 'listbox' : 'menu');
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
    const below = win.innerHeight - y - 8; const flip = height > below && below < 220 && above - 14 > below;
    const fitted = Math.min(height, flip ? above - 14 : Math.max(below, 120));
    this.element.style.maxHeight = `${fitted}px`;
    this.element.style.left = `${Math.max(8, Math.min(x, win.innerWidth - width - 8))}px`;
    this.element.style.top = `${flip ? above - fitted - 6 : y}px`;
    this.element.style.transformOrigin = flip ? 'bottom left' : 'top left';
    if (kind === 'slash') {
      this.view.contentDOM.setAttribute('aria-controls', this.element.id); this.view.contentDOM.setAttribute('aria-expanded', 'true');
    }
  }

  render(sections: MenuSection[]) {
    const element = this.element!; const doc = element.ownerDocument; const { empty, footer } = this.source.text();
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
    if (!this.items.length) nodes.push(Object.assign(doc.createElement('div'), { className: 'fn-editor-menu-empty', textContent: empty }));
    if (this.kind === 'slash')
      nodes.push(Object.assign(doc.createElement('div'), { className: 'fn-editor-menu-footer', textContent: footer }));
    element.replaceChildren(...nodes);
    // Typing filters toward a choice, so the slash menu pre-selects one; a pointer-opened menu waits for hover or arrows.
    this.highlight(this.kind === 'slash' ? this.items.findIndex(actionable) : -1);
  }

  button(item: MenuItem, compact: boolean) {
    const doc = this.element!.ownerDocument; const position = this.items.length;
    const button = doc.createElement('button');
    button.type = 'button'; button.disabled = Boolean(item.disabled); button.id = `${this.element!.id}-${position}`;
    button.setAttribute('role', this.kind === 'slash' ? 'option' : 'menuitem');
    button.className = compact ? 'fn-editor-menu-icon' : 'fn-editor-menu-item';
    if (compact) {
      button.setAttribute('aria-label', item.label); button.title = item.hint ? `${item.label}  ${item.hint}` : item.label;
      button.append(icon(doc, item));
    } else {
      const tile = doc.createElement('span'); tile.className = 'fn-editor-menu-tile'; tile.append(icon(doc, item));
      const text = doc.createElement('span'); text.className = 'fn-editor-menu-text';
      text.append(highlighted(doc, item.label, this.query));
      if (item.description && this.kind === 'slash')
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
    if (this.kind === 'slash') this.view.contentDOM.setAttribute('aria-activedescendant', active.id);
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
    const { view } = this; const slash = this.slash;
    this.close();
    if (slash !== null) view.dispatch({ changes: { from: slash, to: view.state.selection.main.head } });
    item.run!(view); view.focus();
  }

  outside = (event: Event) => { if (!this.element?.contains(event.target as Node)) this.close(); };

  close() {
    this.element?.ownerDocument.removeEventListener('mousedown', this.outside, true);
    for (const name of ['aria-controls', 'aria-expanded', 'aria-activedescendant']) this.view.contentDOM.removeAttribute(name);
    this.element?.remove(); this.element = null; this.slash = null;
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
  return [
    plugin,
    Prec.highest(keymap.of([
      { key: 'ArrowDown', run: whenOpen((menu) => menu.move(1)) }, { key: 'ArrowUp', run: whenOpen((menu) => menu.move(-1)) },
      { key: 'ArrowRight', run: (view) => view.plugin(plugin)?.kind === 'context' && whenOpen((menu) => menu.move(1))(view) },
      { key: 'ArrowLeft', run: (view) => view.plugin(plugin)?.kind === 'context' && whenOpen((menu) => menu.move(-1))(view) },
      { key: 'Enter', run: whenOpen((menu) => menu.choose()) }, { key: 'Tab', run: whenOpen((menu) => menu.choose()) },
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
