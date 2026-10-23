export type IconName = 'folder' | 'folder-plus' | 'folder-drop' | 'note' | 'library' | 'plus' | 'refresh' | 'search' | 'sort' | 'check'
  | 'trash' | 'edit' | 'settings' | 'more' | 'close' | 'chevron-left' | 'chevron-right' | 'comment' | 'snapshot' | 'reopen';
export function Icon({ name }: { name: IconName }) {
  const paths = {
    folder: <><path d="M3.5 6.5h5l1.7 2h10.3v9.8a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7z" />
      <path d="M3.5 6.5V5.7A1.7 1.7 0 0 1 5.2 4h4l1.5 2h6.1" /></>,
    'folder-plus': <><path d="M3.5 6.5h5l1.7 2h10.3v9.8a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7z" />
      <path d="M3.5 6.5V5.7A1.7 1.7 0 0 1 5.2 4h4l1.5 2h6.1M16 12v5M13.5 14.5h5" /></>,
    'folder-drop': <><path d="M3.5 9.5V5.7A1.7 1.7 0 0 1 5.2 4h4l1.5 2h7.6a1.7 1.7 0 0 1 1.7 1.7v1.8" />
      <path d="M2.8 10h18.4l-1.7 8.4a1.7 1.7 0 0 1-1.7 1.4H6.2a1.7 1.7 0 0 1-1.7-1.4z" />
      <g className="fn-drop-arrow"><path d="M12 11.8v5M9.9 14.8l2.1 2.1 2.1-2.1" /></g></>,
    note: <><path d="M7 3.5h7l4 4v13H7z" /><path d="M14 3.5v4h4M9.5 12h6M9.5 15.5h6" /></>,
    library: <><path d="M4 5.5h16v13H4z" /><path d="M7 8.5h10M7 11.5h10M7 14.5h6" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    refresh: <><path d="M19 8a7 7 0 1 0 1 6" /><path d="M19 4v4h-4" /></>,
    sort: <><path d="M7.5 5v14M4.5 16l3 3 3-3M16.5 19V5M13.5 8l3-3 3 3" /></>,
    check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
    search: <><circle cx="10.8" cy="10.8" r="6.3" /><path d="m16 16 4 4" /></>,
    trash: <><path d="M5 7h14M10 4h4l1 3H9zM7 7l.8 13h8.4L17 7M10 10v6M14 10v6" /></>,
    edit: <><path d="m4 16.5-.8 4.3 4.3-.8L19 8.5a2.1 2.1 0 0 0-3-3z" /><path d="m14.5 7 2.5 2.5" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.8 1.8-.1-.1a1.7 1.7 0 0 0-1.9-.3
      1.7 1.7 0 0 0-1 1.5v.1h-2.6v-.1a1.7 1.7 0 0 0-1-1.5
      1.7 1.7 0 0 0-1.9.3l-.1.1-1.8-1.8.1-.1A1.7 1.7 0 0 0 8 15a1.7 1.7 0 0 0-1.5-1H6v-2.6h.1A1.7 1.7 0 0 0 8 10a1.7 1.7 0 0 0-.3-1.9l-.1-.1
      1.8-1.8.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5V5h2.6v.1a1.7 1.7 0 0 0 1 1.5
      1.7 1.7 0 0 0 1.9-.3l.1-.1 1.8 1.8-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.1V14h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>,
    more: <>
      <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
    </>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    reopen: <><path d="M5 12a7 7 0 1 0 2.05-4.95" /><path d="M5 4.5v3.5h3.5" /></>,
    comment: <path d="M5.5 5h13A1.5 1.5 0 0 1 20 6.5v8a1.5 1.5 0 0 1-1.5 1.5H11l-4.5 3.5V16h-1
      A1.5 1.5 0 0 1 4 14.5v-8A1.5 1.5 0 0 1 5.5 5z" />,
    snapshot: <><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2L9 5h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9
      a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" />
      <circle cx="12" cy="13" r="3.2" /></>,
    'chevron-left': <path d="m15 5-7 7 7 7" />,
    'chevron-right': <path d="m9 5 7 7-7 7" />,
  };
  return <svg className="fn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"
    strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
