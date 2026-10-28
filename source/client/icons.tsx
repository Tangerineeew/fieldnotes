export type IconName = 'folder' | 'folder-plus' | 'note' | 'note-plus' | 'library' | 'refresh' | 'search' | 'sort' | 'check'
  | 'trash' | 'edit' | 'settings' | 'close' | 'chevron-left' | 'chevron-right' | 'chevron-down' | 'sidebar' | 'share' | 'comment'
  | 'snapshot' | 'reopen' | 'history' | 'outline' | 'import' | 'copy' | 'open';

// Line icons on a 24px grid, each one path, so the editor's menu and the PDF frame, which build their DOM by hand, draw the
// same icon as the React interface. Circles and rounded boxes are written as arcs for that reason.
export const ICON_PATHS: Record<IconName, string> = {
  folder: 'M3.5 6.5h5l1.7 2h10.3v9.8a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7z M3.5 6.5V5.7A1.7 1.7 0 0 1 5.2 4h4l1.5 2h6.1',
  'folder-plus': 'M3.5 6.5h5l1.7 2h10.3v9.8a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7z'
    + ' M3.5 6.5V5.7A1.7 1.7 0 0 1 5.2 4h4l1.5 2h6.1M16 12v5M13.5 14.5h5',
  note: 'M7 3.5h7l4 4v13H7z M14 3.5v4h4M9.5 12h6M9.5 15.5h6',
  'note-plus': 'M7 3.5h7l4 4v13H7z M14 3.5v4h4M12.5 11v6M9.5 14h6',
  library: 'M4 5.5h16v13H4z M7 8.5h10M7 11.5h10M7 14.5h6',
  refresh: 'M19 8a7 7 0 1 0 1 6 M19 4v4h-4',
  sort: 'M7.5 5v14M4.5 16l3 3 3-3M16.5 19V5M13.5 8l3-3 3 3',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  search: 'M17.1 10.8a6.3 6.3 0 1 1-12.6 0a6.3 6.3 0 1 1 12.6 0z M16 16l4 4',
  trash: 'M5 7h14M10 4h4l1 3H9zM7 7l.8 13h8.4L17 7M10 10v6M14 10v6',
  edit: 'm4 16.5-.8 4.3 4.3-.8L19 8.5a2.1 2.1 0 0 0-3-3z M14.5 7l2.5 2.5',
  settings: 'M15 12a3 3 0 1 1-6 0a3 3 0 1 1 6 0z M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.8 1.8-.1-.1a1.7 1.7 0 0 0-1.9-.3'
    + ' 1.7 1.7 0 0 0-1 1.5v.1h-2.6v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1-1.8-1.8.1-.1A1.7 1.7 0 0 0 8 15'
    + 'a1.7 1.7 0 0 0-1.5-1H6v-2.6h.1A1.7 1.7 0 0 0 8 10a1.7 1.7 0 0 0-.3-1.9l-.1-.1 1.8-1.8.1.1a1.7 1.7 0 0 0 1.9.3'
    + ' 1.7 1.7 0 0 0 1-1.5V5h2.6v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1 1.8 1.8-.1.1a1.7 1.7 0 0 0-.3 1.9'
    + ' 1.7 1.7 0 0 0 1.5 1h.1V14h-.1a1.7 1.7 0 0 0-1.5 1Z',
  close: 'm6 6 12 12M18 6 6 18',
  reopen: 'M5 12a7 7 0 1 0 2.05-4.95 M5 4.5v3.5h3.5',
  copy: 'M10.5 8.5h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z'
    + ' M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5',
  import: 'M12 4v10M8 10.5l4 4 4-4M5 15.5v2.5A1.5 1.5 0 0 0 6.5 19.5h11a1.5 1.5 0 0 0 1.5-1.5v-2.5',
  open: 'M13.5 4.5h6v6M19.5 4.5 11 13 M17.5 13.5v4.5a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V8A1.5 1.5 0 0 1 6 6.5h4.5',
  outline: 'M4.5 6.5h15M8.5 11.5h11M8.5 16.5h11M4.5 11.5h.01M4.5 16.5h.01',
  history: 'M4.5 12a7.5 7.5 0 1 0 2.2-5.3 M4.5 4.5v3.5H8M12 8v4.3l2.8 1.7',
  comment: 'M5.5 5h13A1.5 1.5 0 0 1 20 6.5v8a1.5 1.5 0 0 1-1.5 1.5H11l-4.5 3.5V16h-1A1.5 1.5 0 0 1 4 14.5v-8A1.5 1.5 0 0 1 5.5 5z',
  snapshot: 'M4 8.5A1.5 1.5 0 0 1 5.5 7h2L9 5h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z'
    + ' M15.2 13a3.2 3.2 0 1 1-6.4 0a3.2 3.2 0 1 1 6.4 0z',
  'chevron-left': 'm15 5-7 7 7 7',
  'chevron-right': 'm9 5 7 7-7 7',
  'chevron-down': 'm6 9 6 6 6-6',
  sidebar: 'M6 4.5h12a2.5 2.5 0 0 1 2.5 2.5v10a2.5 2.5 0 0 1-2.5 2.5H6a2.5 2.5 0 0 1-2.5-2.5V7A2.5 2.5 0 0 1 6 4.5z M9.5 4.5v15',
  share: 'M12 8.5a3 3 0 1 1-6 0a3 3 0 1 1 6 0z M3.5 19a5.5 5.5 0 0 1 11 0M16 5.8a3 3 0 0 1 0 5.4M17.5 14.2a5.5 5.5 0 0 1 3 4.8',
};

export function Icon({ name }: { name: IconName }) {
  return <svg className="fn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"
    strokeLinejoin="round" aria-hidden="true"><path d={ICON_PATHS[name]} /></svg>;
}

// The same kind of icon for code that builds its DOM by hand; its stroke comes from the class's CSS.
export function iconElement(doc: Document, path: string, className = 'fn-icon') {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', className);
  const shape = doc.createElementNS(svg.namespaceURI, 'path'); shape.setAttribute('d', path); svg.append(shape);
  return svg;
}
