import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  HEADING_LINK, IMAGE_ERROR, embedSourcesInMarkdown, imageSourcesInMarkdown, isNoteId, referenceSourcesInMarkdown, renderMarkdownInto,
  outlineOf, plainHeading, revealHeading, type ImageSources, type LinkText, type ReferenceLink, type ReferenceLinks
} from './markdown';
import { attachmentFiles, uploadAttachment } from './images';
import { setPdfText } from './pdf';
import { TREK_PREFIX, setTrekText, trekPath, trekSourcesInMarkdown, type TrekObject } from './trek-objects';
import { assetBatch, maxContentChars, maxImageBytes, maxPdfBytes, maxTitleChars } from '../shared/limits.json';
import { createLiveEditor, type LinkTarget, type TripPdf } from './live-editor';
import { CollabEditor, FloatingNotice } from './collab-editor';
import type { CollabSession } from './collab';
import { IconPicker, NoteIcon, firstGrapheme } from './note-icon';
import type { Extension } from '@codemirror/state';
import { PropertyList, PropertySection, type Property } from './properties';
import { WritingStats } from './writing-stats';
import { translate, type Translate } from './i18n';
import { RequestError, whenIdle, withErrors, withParts, type Invoke } from './api';
import { Avatar, CollaboratorEditor, personName, useCollaborators, type Collaborator, type Person } from './collaborators';
import { Icon, type IconName } from './icons';
import { HistoryView, type Version } from './history';
import { Outline, OutlinePanel } from './outline';
import { entriesOf, importNotes } from './importer';
import { copyText, noteMarkdown } from './exporter';
import { Palette, type PaletteCommand, type PaletteNote } from './palette';
import { DeletedColumn, type DeletedNote } from './trash';
import { ContextMenu, FinderColumns, FinderMini, finderIndex, type ContextMenuItem, type FinderTarget, type MenuPoint
} from './finder';
import {
  CommentPanel, QuoteButton, clearQuotes, paintQuotes, threadAt, threadsOf, type Anchor, type Comment
} from './comments';
import { isPhone, prefersReducedMotion } from './media';
import { moveInMenu, useDismiss } from './popover';
import './fonts.css';
import './style.css';

type Context = { tripId: string | null; locale: string; userId: number };
type TripCreateIntent = { tripId: number; tripFolderId: string | null; title: string };
type Note = {
  id: string; title: string; content: string; icon?: string | null; properties?: Property[]; version: number;
  created_at?: string; updated_at: string; owner_id?: number; visibility?: 'private' | 'public'; folder_id?: string | null;
  can_edit?: boolean; mode?: 'live' | 'snapshot'; day_id?: number | null; unavailable?: boolean; can_snapshot?: boolean;
  snippet?: string | null
};
type Backlink = { id: string; title: string; icon?: string | null; snippet: string; can_link?: boolean };
type ReferenceTarget = { reference: string; id?: string; title?: string; content?: string; unavailable?: boolean };
// Readers of the edited note who could not open one of its links, and what the editor may do about it (see linkAccess).
type LinkGap = { target: { id: string; title: string }; can_share: boolean; public: boolean;
  people: { user: Person; grantable: boolean }[]; trips: { id: number; title: string }[]; hidden_trips: number };
// What `[[` suggests, and how a link the menu inserts makes itself known before the server is asked.
type NoteLinks = { search: (query: string, headings?: boolean) => Promise<LinkTarget[]>; onLinked: (target: LinkTarget) => void };
type Folder = {
  id: string; owner_id: number; parent_id: string | null; name: string; icon?: string | null; visibility: 'private' | 'public';
  role: 'editor' | 'viewer'; public_path: boolean; can_manage: boolean; created_at?: string; updated_at?: string
};
type Trip = { id: number; title: string };
type Day = { id: number; title?: string; date?: string; day_number?: number };
type LinkedTrip = { id: number; title: string; mode?: 'live' | 'snapshot'; day_id?: number | null };
type Draft = {
  title: string; content: string; icon: string | null; properties: Property[]; visibility: 'private' | 'public'; folder_id: string | null
};
type Sorting = { key: 'name' | 'updated' | 'created'; order: 'asc' | 'desc' };
// A question the page asks before acting, answered in its own window; `before` is where focus returns.
type ConfirmOptions = { title: string; message: string; confirmLabel: string; danger?: boolean };
type ConfirmRequest = ConfirmOptions & { resolve: (answer: boolean) => void; before: HTMLElement | null };
// What is being dragged, and the folder it sits in now.
type Drag = { kind: 'note' | 'folder'; id: string; from: string | null };
interface Bridge {
  context: Context | null;
  onContext(cb: (ctx: Context) => void): () => void;
  invoke<T>(path: string, options?: { method: string; body: unknown }): Promise<T>;
  navigate(path: string): void;
  openExternal(url: string): void;
  session?: {
    get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void>; remove(key: string): Promise<void>
  };
}
declare global { interface Window { trek: Bridge } }
const trek = window.trek;
const COMMENT_POLL_MS = 30_000;
const empty: Draft = { title: '', content: '', icon: null, properties: [], visibility: 'private', folder_id: null };
const invoke = withErrors(withParts((path, options) => trek.invoke(path, options)), () => trek.context?.locale);
const post = <T,>(path: string, body: unknown) => invoke<T>(path, { method: 'POST', body });
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const draftOf = (note: Note): Draft => ({
  title: note.title, content: note.content, icon: note.icon || null, properties: note.properties || [],
  visibility: note.visibility || 'private', folder_id: note.folder_id || null
});
const SORT_KEY = 'fieldnotes:sort';
const DRAWERS_KEY = 'fieldnotes:drawers';
// The library's column view holds every note at once instead of paging.
const LIBRARY_LIMIT = 500;
// Below 860px the note browser is a sheet over the note.
const NARROW = '(max-width: 860px)';
// Room for the note browser and a trip's side panels at once: 310px + 350px beside a note of at least 600px, inside 24px margins.
const ROOM_FOR_BOTH = '(min-width: 1320px)';
const narrowScreen = () => Boolean(window.matchMedia?.(NARROW).matches);
const roomForBoth = () => Boolean(window.matchMedia?.(ROOM_FOR_BOTH).matches);
// Whether the note browser was left open, remembered per browser; as a sheet it starts closed and is not remembered.
function storedDrawers(): { tree: boolean } {
  if (narrowScreen()) return { tree: false };
  try { return { tree: true, ...JSON.parse(window.localStorage.getItem(DRAWERS_KEY) || '{}') }; } catch { return { tree: true }; }
}
// What the page keeps for a resolved link: its note, or that this reader cannot open it.
const referenceLink = (entry: ReferenceTarget): ReferenceLink | null => entry.unavailable ? { unavailable: true }
  : entry.id && entry.title !== undefined
    ? { id: entry.id, title: entry.title, ...(typeof entry.content === 'string' ? { content: entry.content } : {}) } : null;
// A link's newer answer replaces the older one, except that an answer without text keeps the text an embed already brought.
const mergeLinks = (current: ReferenceLinks, next: ReferenceLinks) => ({ ...current, ...Object.fromEntries(Object.entries(next)
  .map(([reference, link]) => [reference, link.unavailable || link.content !== undefined || current[reference]?.unavailable
    ? link : { ...link, content: current[reference]?.content }])) }) as ReferenceLinks;
const linksOf = (entries: (ReferenceTarget | null)[]) => Object.fromEntries(entries.flatMap((entry) => {
  const link = entry && referenceLink(entry);
  return link ? [[entry.reference, link]] : [];
})) as ReferenceLinks;
// Finder-style short date: time for today, month and day this year, full date otherwise.
function shortDate(value: string | undefined, locale: string | undefined, today: string) {
  if (!value) return '';
  const date = new Date(value); const now = new Date();
  if (Number.isNaN(date.getTime())) return '';
  if (date.toDateString() === now.toDateString())
    return `${today} ${new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date)}`;
  return new Intl.DateTimeFormat(
    locale, date.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { dateStyle: 'medium' }
  ).format(date);
}
const collatorFor = (locale?: string) => new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
function storedSorting(): Sorting {
  try {
    const value = JSON.parse(window.localStorage.getItem(SORT_KEY) || 'null');
    if (['name', 'updated', 'created'].includes(value?.key) && ['asc', 'desc'].includes(value?.order)) return value;
  } catch { /* a convenience; the default order serves */ }
  return { key: 'updated', order: 'desc' };
}
// Mirrors the server-side note order, so a trip's notes, sorted here, list as the library's do.
function sortItems<T extends { id: string; created_at?: string; updated_at?: string }>(
  items: T[], name: (item: T) => string, { key, order }: Sorting, collator: Intl.Collator
) {
  const date = (item: T) => (key === 'created' ? item.created_at : undefined) || item.updated_at || '';
  const compare = key === 'name' ? (a: T, b: T) => collator.compare(name(a), name(b)) : (a: T, b: T) => date(a).localeCompare(date(b));
  return [...items].sort((a, b) => (order === 'asc' ? 1 : -1) * compare(a, b) || a.id.localeCompare(b.id));
}
// The private library's folders: those outside the public library, and the public ones above them or above a private note, so
// each path stays whole.
function privateFolders(folders: Folder[], notes: Note[]) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const kept = new Set<string>();
  const keep = (folderId: string | null | undefined) => {
    for (let current = folderId ? byId.get(folderId) : undefined; current && !kept.has(current.id);
      current = current.parent_id ? byId.get(current.parent_id) : undefined) kept.add(current.id);
  };
  folders.forEach((folder) => { if (!folder.public_path) keep(folder.id); });
  notes.forEach((item) => keep(item.folder_id));
  return folders.filter((folder) => kept.has(folder.id));
}

function App() {
  const [context, setContext] = useState<Context | null>(trek.context);
  const owns = (item: Note) => Number(item.owner_id) === Number(context?.userId);
  const t: Translate = (en, zh, vars) => translate(en, context?.locale, zh, vars);
  const collator = useMemo(() => collatorFor(context?.locale), [context?.locale]);
  const tripId = context?.tripId ? Number(context.tripId) : null;
  const [notes, setNotes] = useState<Note[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderIcon, setNewFolderIcon] = useState('');
  const [newFolderIconTouched, setNewFolderIconTouched] = useState(false);
  const folderMembers = useCollaborators();
  const [note, setNote] = useState<Note | null>(null);
  const [draft, setDraft] = useState<Draft>(empty);
  const [editing, setEditing] = useState(false);
  const [publicMode, setPublicMode] = useState(false);
  // What is made in a library belongs to it: new notes and folders, and imports, take its visibility.
  const scope = publicMode ? 'public' : 'private';
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  // A new question replaces one still open, which counts as cancelled, so nothing waits on an answer that cannot come.
  const confirm = (options: ConfirmOptions) => new Promise<boolean>((resolve) => setConfirmRequest((open) => {
    open?.resolve(false); return { ...options, resolve, before: document.activeElement as HTMLElement | null };
  }));
  function answerConfirm(answer: boolean) {
    if (!confirmRequest) return;
    confirmRequest.before?.focus(); confirmRequest.resolve(answer); setConfirmRequest(null);
  }
  // Recently deleted: whether its column is open, the owner's deleted notes, the one read for the preview, and a row's open menu.
  const [binOpen, setBinOpen] = useState(false);
  const [deletedNotes, setDeletedNotes] = useState<DeletedNote[]>([]);
  const [deletedRead, setDeletedRead] = useState<(Note & DeletedNote) | null>(null);
  const [deletedMenu, setDeletedMenu] = useState<{ note: DeletedNote; at: MenuPoint } | null>(null);
  const [sortOpen, setSortOpen] = useState(false);
  const sortRoot = useRef<HTMLDivElement>(null);
  const sortButton = useRef<HTMLButtonElement>(null);
  const [finderMenu, setFinderMenu] = useState<{ target: FinderTarget<Folder, Note>; at: MenuPoint } | null>(null);
  const [permissionFolderId, setPermissionFolderId] = useState<string | null>(null);
  const [dragged, setDragged] = useState<Drag | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [landedKey, setLandedKey] = useState<string | null>(null);
  const [sorting, setSorting] = useState<Sorting>(storedSorting);
  const [imageSources, setImageSources] = useState<ImageSources>({});
  const [referenceLinks, setReferenceLinks] = useState<ReferenceLinks>({});
  const noteMembers = useCollaborators();
  const [linkedTrips, setLinkedTrips] = useState<LinkedTrip[]>([]);
  const [busy, setBusy] = useState(false);
  const [suppressBusyStatus, setSuppressBusyStatus] = useState(false);
  // Until the first list arrives an empty list means "not loaded", not "nothing here".
  const [ready, setReady] = useState(false);
  const lock = useRef(false);
  const uploadQueue = useRef(Promise.resolve());
  const requestedImages = useRef(new Set<string>());
  const hydrateTimer = useRef<number | undefined>(undefined);
  const requestedReferences = useRef(new Set<string>());
  const referenceTimer = useRef<number | undefined>(undefined);
  // The heading a followed link points at, revealed once the note it opens has rendered.
  const pendingHeading = useRef('');
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [mentions, setMentions] = useState<Backlink[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewRead, setPreviewRead] = useState<Note | null>(null);
  const previewing = useRef<string | null>(null);
  // The query whose results the column view shows instead of folders; null while browsing.
  const [results, setResults] = useState<string | null>(null);
  const [drawers, setDrawers] = useState(storedDrawers);
  const [shareOpen, setShareOpen] = useState(false);
  const shareDialog = useRef<HTMLElement>(null);
  const shareTrigger = useRef<HTMLElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  // The quick switcher, opened on notes ('') or on commands ('>'); null while closed.
  const [palette, setPalette] = useState<'' | '>' | null>(null);
  // Where an import lands, while its file or folder picker is open.
  const importTarget = useRef<string | null>(null);
  const importFiles = useRef<HTMLInputElement>(null);
  const importFolder = useRef<HTMLInputElement>(null);
  const historyDialog = useRef<HTMLElement>(null);
  const historyTrigger = useRef<HTMLElement>(null);
  // On a trip page the side panels mirror the note browser across the note; without room for both, one gives way to the other.
  const toggleDrawer = (name: 'tree') => {
    const next = { ...drawers, [name]: !drawers[name] };
    setDrawers(next);
    if (next.tree && !roomForBoth()) { setCommentsOpen(false); setOutlineOpen(false); }
    if (narrowScreen()) return;
    try { window.localStorage.setItem(DRAWERS_KEY, JSON.stringify(next)); } catch { /* a convenience; the toggle still works */ }
  };
  const [linkGaps, setLinkGaps] = useState<LinkGap[]>([]);
  const [dismissedGaps, setDismissedGaps] = useState<string[]>([]);
  const [grantGap, setGrantGap] = useState<LinkGap | null>(null);
  const grantDialog = useRef<HTMLElement>(null);
  // A trip's live reference whose original the trip can no longer see.
  const unavailableTitle = t('Reference unavailable', '引用已不可用');
  const unavailableHint = t('The author removed the note or left this trip. Saved snapshots are unaffected.',
    '原文已被删除，或作者已离开这次旅行。已保存的快照不受影响。');
  const linkText: LinkText = { unavailable: t('Note you can’t open', '无法查看的笔记'),
    hint: t('You don’t have access to this note, or it was deleted.', '你没有查看这篇笔记的权限，或它已被删除。'),
    missingHeading: t('This heading is no longer in the note.', '这篇笔记里已经没有这个小标题了。'),
    callouts: { note: t('Note', '备注'), tip: t('Tip', '小贴士'), success: t('Done', '完成'), warning: t('Warning', '注意'),
      danger: t('Danger', '危险') } };
  setPdfText({ onePage: t('1 page', '1 页'), previous: t('Previous page', '上一页'), next: t('Next page', '下一页'),
    all: t('Show all pages', '查看全部页面'), close: t('Close', '关闭'), failed: t('This PDF could not be opened.', '无法打开这个 PDF。') });
  // A followed link runs like any other action, so a failure shows.
  const follow = (id: string, heading?: string) => void run(() => openReference(id, heading));
  setTrekText(t, context?.locale, (href) => openHref(href, follow));
  // PDFs of the trip whose snapshot is being edited, offered in the slash menu, and its places, bookings, days and stays.
  const [tripPdfs, setTripPdfs] = useState<TripPdf[]>([]);
  const [tripObjects, setTripObjects] = useState<TrekObject[]>([]);
  const [error, setError] = useState('');
  // Messages float at the bottom for a moment instead of taking a line of the page, so nothing shifts as they come and go.
  const [notice, setNotice] = useState<{ text: string; at: number } | null>(null);
  const setStatus = (text: string) => { if (text) setNotice({ text, at: Date.now() }); };
  const [slow, setSlow] = useState(false);
  const [collabTrouble, setCollabTrouble] = useState('');
  const collab = useRef<CollabSession | null>(null);
  const [query, setQuery] = useState('');
  const [contentMotion, setContentMotion] = useState<'forward' | 'backward' | 'neutral'>('neutral');
  const [trips, setTrips] = useState<Trip[]>([]);
  const [target, setTarget] = useState('');
  const [days, setDays] = useState<Day[]>([]);
  const [dayId, setDayId] = useState('');
  const [mode, setMode] = useState('live');
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentsOpen, setCommentsOpen] = useState(false);
  // On a trip with room beside the note, the outline docks above the comments instead of opening as a popover.
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [wide, setWide] = useState(() => !narrowScreen());
  const sidesOpen = useRef(false);
  sidesOpen.current = commentsOpen || outlineOpen;
  useEffect(() => {
    const narrow = window.matchMedia?.(NARROW); const both = window.matchMedia?.(ROOM_FOR_BOTH);
    const change = () => setWide(!narrow.matches);
    // A window that shrinks below room for both sides keeps the side panels open and folds the note browser away.
    const fold = () => { if (!both.matches && sidesOpen.current) setDrawers((current) => ({ ...current, tree: false })); };
    narrow?.addEventListener?.('change', change); both?.addEventListener?.('change', fold);
    return () => { narrow?.removeEventListener?.('change', change); both?.removeEventListener?.('change', fold); };
  }, []);
  // A side panel that opens without room for both folds the note browser away.
  const sidePanel = (set: (open: boolean) => void) => (open: boolean) => {
    set(open);
    if (open && !roomForBoth()) setDrawers((current) => ({ ...current, tree: false }));
  };
  const toggleComments = sidePanel(setCommentsOpen);
  const closeComments = () => { setCommentsOpen(false); setActiveThread(null); };
  const toggleOutline = sidePanel(setOutlineOpen);
  const [pendingQuote, setPendingQuote] = useState<Anchor | null>(null);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [locatedThreads, setLocatedThreads] = useState<Set<string>>(new Set());
  const [renderedAt, setRenderedAt] = useState(0);
  const noteArticle = useRef<HTMLElement | null>(null);
  const quoteRanges = useRef(new Map<string, Range>());
  const [tripTitle, setTripTitle] = useState('');
  const [canEditTrip, setCanEditTrip] = useState(false);
  const [createTripId, setCreateTripId] = useState<number | null>(null);
  const [createTripFolderId, setCreateTripFolderId] = useState<string | null>(null);
  const [createTripTitle, setCreateTripTitle] = useState('');
  const titleInput = useRef<HTMLInputElement>(null);
  // Notes and snapshots save as they are typed; only a new note's form holds unsaved text, and it is born in the open folder, so only
  // what was typed counts as a change.
  const dirty = editing && !note && JSON.stringify({ ...draft, folder_id: empty.folder_id }) !== JSON.stringify(empty);
  const latestRequest = useRef(0);
  const permissionModal = useRef<HTMLElement>(null);
  const permissionTrigger = useRef<HTMLElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const closeFolderPermissionsRef = useRef<() => Promise<void>>(async () => {});
  const [folderAccess, setFolderAccess] = useState<{ folderId: string; people: Collaborator[] } | null>(null);
  // A folder you own previews who can open it, fetched again once its permissions window closes.
  useEffect(() => {
    const folder = folders.find((item) => item.id === selectedFolderId);
    if (!folder?.can_manage || tripId || note || editing || permissionFolderId) return;
    let alive = true;
    post<{ collaborators: Collaborator[] }>('/folder', { action: 'collaborators', folder_id: folder.id })
      .then((result) => { if (alive) setFolderAccess({ folderId: folder.id, people: result?.collaborators ?? [] }); }).catch(() => {});
    return () => { alive = false; };
  }, [selectedFolderId, folders, tripId, note, editing, permissionFolderId]);

  useEffect(() => trek.onContext(setContext), []);
  // A quick action says nothing; only one still running after a moment says it is working.
  useEffect(() => {
    if (!busy || suppressBusyStatus) { setSlow(false); return; }
    const timer = window.setTimeout(() => setSlow(true), 600);
    return () => window.clearTimeout(timer);
  }, [busy, suppressBusyStatus]);
  useEffect(() => { document.documentElement.lang = context?.locale || 'en'; }, [context?.locale]);
  useEffect(() => { if (editing) titleInput.current?.focus(); }, [editing]);
  useEffect(() => {
    if ((!note && !editing) || !isPhone()) return;
    const behavior = prefersReducedMotion() ? 'auto' : 'smooth';
    window.requestAnimationFrame(() => {
      workspaceRef.current?.focus({ preventScroll: true });
      workspaceRef.current?.scrollIntoView({ block: 'start', behavior });
    });
  }, [note?.id, editing]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // Quoted passages are re-found whenever the note re-renders or its discussion changes.
  useEffect(() => {
    if (!tripId || !note || editing) { clearQuotes(); quoteRanges.current = new Map(); return; }
    quoteRanges.current = paintQuotes(noteArticle.current, threadsOf(comments), activeThread);
    const found = new Set(quoteRanges.current.keys());
    setLocatedThreads((current) => current.size === found.size && [...found].every((id) => current.has(id)) ? current : found);
  }, [tripId, note, editing, comments, activeThread, renderedAt]);
  useEffect(() => clearQuotes, []);
  // Others' comments arrive by polling while the note is on screen.
  useEffect(() => {
    if (!tripId || !note || note.unavailable) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || lock.current) return;
      void post<Comment[]>('/trip', { action: 'comments', trip_id: tripId, note_id: note.id }).then(setComments).catch(() => {});
    }, COMMENT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [tripId, note?.id, note?.unavailable]);

  async function run(fn: () => Promise<unknown>, options: { silent?: boolean } = {}) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setSuppressBusyStatus(Boolean(options.silent)); setError(''); setStatus('');
    try { await fn(); }
    catch (error) { setError(messageOf(error)); }
    finally { lock.current = false; setBusy(false); setSuppressBusyStatus(false); }
  }
  async function discard() {
    // Live editing saves as it goes: leaving the note flushes its last keystrokes and, if it changed, says so.
    const session = collab.current;
    if (session) {
      collab.current = null;
      const edited = session.edited;
      await session.stop();
      if (edited) { setStatus(t('All changes saved', '已自动保存')); await load(); }
    }
    if (!dirty && !permissionDirty) return true;
    const message = dirty && permissionDirty
      ? t('Discard unsaved note and permission changes?', '放弃尚未保存的笔记和权限修改？')
      : permissionDirty ? t('Discard unsaved permission changes?', '放弃尚未保存的权限修改？')
        : t('Discard unsaved changes?', '放弃尚未保存的修改？');
    return confirm({ title: t('Unsaved changes', '未保存的修改'), message, confirmLabel: t('Discard', '放弃'), danger: true });
  }
  async function loadFolders() {
    const result = tripId
      ? await post<Folder[]>('/trip', { action: 'folders', trip_id: tripId })
      : await invoke<Folder[]>('/folders');
    setFolders(Array.isArray(result) ? result : []);
  }
  async function load(search = query, publicScope = publicMode, order = sorting): Promise<Note[]> {
    const seq = ++latestRequest.current;
    if (tripId) {
      // Like the library, a trip page holds every note it shares and groups them by folder itself.
      const [result] = await Promise.all([
        post<{ trip: Trip; notes: Note[] }>('/trip', { action: 'list', trip_id: tripId, q: search.trim() || undefined }), loadDeleted()]);
      if (seq !== latestRequest.current) return [];
      setNotes(result.notes); setTripTitle(result.trip.title); setResults(search.trim() ? search.trim() : null);
      return result.notes;
    }
    const route = publicScope ? '/public' : '/notes';
    const sortQuery = `&sort=${order.key}&order=${order.order}&locale=${encodeURIComponent(context?.locale || 'en')}`;
    // Folders are browsed on the page, so the library asks for every note and groups them itself; the private library also
    // learns whether Recently deleted holds anything.
    const [result] = await Promise.all([invoke<{ notes: Note[] }>(
      `${route}?q=${encodeURIComponent(search)}&limit=${LIBRARY_LIMIT}${sortQuery}`
    ), loadDeleted(publicScope)]);
    if (seq !== latestRequest.current) return [];
    // The library lists notes without their text, which a preview or an opened note reads whole.
    const listed = result.notes.map((item) => ({ ...item, content: '' }));
    setNotes(listed); setResults(search.trim() ? search.trim() : null);
    return listed;
  }
  async function loadCollaborators(item: Note) {
    if (tripId || !owns(item)) { noteMembers.show(null); return; }
    noteMembers.show(await invoke<{ collaborators: Collaborator[]; candidates: Person[] }>(
      `/collaborators?note_id=${encodeURIComponent(item.id)}`
    ));
  }
  async function loadLinkedTrips(item: Note) {
    if (tripId || !owns(item)) { setLinkedTrips([]); return; }
    const result = await post<LinkedTrip[]>('/trip', { action: 'links', note_id: item.id });
    setLinkedTrips(Array.isArray(result) ? result : []);
  }

  // A trip page reaches Fieldnotes only through the companion's /trip route, so its links resolve there, among the trip's notes.
  // An embedded note also brings its text.
  async function resolveReference(reference: string, viewTripId: number | null, embed = false) {
    try {
      return viewTripId ? await post<ReferenceTarget>('/trip', { action: 'reference', trip_id: viewTripId, ref: reference, embed })
        : await invoke<ReferenceTarget>(`/reference?ref=${encodeURIComponent(reference)}${embed ? '&embed=1' : ''}`);
    } catch { return null; }
  }
  // A snapshot's cards for its trip's places, bookings, days and stays, read fresh each time it opens; each reference once.
  // Library notes never reach a trip's items, so their references stay plain names.
  async function hydrateTrek(content: string, viewTripId: number | null, item: Note | null) {
    if (!viewTripId || item?.mode !== 'snapshot') return;
    const refs = trekSourcesInMarkdown(content).filter((ref) => !requestedReferences.current.has(`${TREK_PREFIX}${ref}`));
    if (!refs.length) return;
    refs.forEach((ref) => requestedReferences.current.add(`${TREK_PREFIX}${ref}`));
    try {
      const { objects } = await post<{ objects: TrekObject[] }>('/trip', { action: 'objects', trip_id: viewTripId, refs });
      const found = new Map(objects.map((card) => [card.ref, card]));
      setReferenceLinks((current) => ({ ...current,
        ...Object.fromEntries(refs.map((ref) => [`${TREK_PREFIX}${ref}`, { trek: found.get(ref) ?? null }])) }));
    } catch { refs.forEach((ref) => requestedReferences.current.delete(`${TREK_PREFIX}${ref}`)); }
  }
  // Embedded notes show their own links and images, so those resolve as well, once.
  async function hydrateEmbedded(links: ReferenceLinks, viewTripId: number | null) {
    const embedded = Object.values(links).filter((link) => typeof link.content === 'string');
    const nested = [...new Set(embedded.flatMap((link) => referenceSourcesInMarkdown(link.content!)))]
      .filter((reference) => !requestedReferences.current.has(reference));
    nested.forEach((reference) => requestedReferences.current.add(reference));
    const images = embedded.map((link) => [link.id!, imageSourcesInMarkdown(link.content!)
      .filter((source) => !requestedImages.current.has(`${link.id} ${source}`))] as const);
    images.forEach(([noteId, sources]) => sources.forEach((source) => requestedImages.current.add(`${noteId} ${source}`)));
    const [more, pictures] = await Promise.all([Promise.all(nested.map((reference) => resolveReference(reference, viewTripId))),
      Promise.all(images.map(([noteId, sources]) => resolveImages(noteId, viewTripId, sources))).then((lists) => lists.flat())]);
    if (nested.length) setReferenceLinks((current) => mergeLinks(current, linksOf(more)));
    if (pictures.length) setImageSources((current) => ({ ...current, ...Object.fromEntries(pictures) }));
  }
  async function hydrateReferences(item: Note, viewTripId: number | null) {
    const references = referenceSourcesInMarkdown(item.content); const embeds = new Set(embedSourcesInMarkdown(item.content));
    requestedReferences.current = new Set([...references, ...[...embeds].map((reference) => `embed:${reference}`)]);
    if (!references.length) { setReferenceLinks({}); await hydrateTrek(item.content, viewTripId, item); return; }
    const links = linksOf(await Promise.all(references.map((reference) => resolveReference(reference, viewTripId, embeds.has(reference)))));
    setReferenceLinks(links);
    await hydrateTrek(item.content, viewTripId, item);
    if (embeds.size) await hydrateEmbedded(links, viewTripId);
  }
  // Links typed by hand or by a co-editor resolve once typing settles, each target once; a link turned into an embed again
  // with its text.
  function hydrateNewReferences(content: string) {
    window.clearTimeout(referenceTimer.current);
    referenceTimer.current = window.setTimeout(() => {
      void hydrateTrek(content, tripId, note);
      const embeds = new Set(embedSourcesInMarkdown(content));
      for (const reference of referenceSourcesInMarkdown(content)) {
        const embed = embeds.has(reference); const key = embed ? `embed:${reference}` : reference;
        if (requestedReferences.current.has(key)) continue;
        requestedReferences.current.add(key); requestedReferences.current.add(reference);
        void resolveReference(reference, tripId, embed).then((entry) => {
          const links = linksOf([entry]);
          if (!links[reference]) return;
          setReferenceLinks((current) => mergeLinks(current, links));
          if (embed) void hydrateEmbedded(links, tripId);
        });
      }
    }, 800);
  }
  // Links and images still settling belong to the note they were typed in.
  useEffect(() => () => { window.clearTimeout(referenceTimer.current); window.clearTimeout(hydrateTimer.current); }, [note?.id]);
  const noteLinks: NoteLinks = {
    search: async (q, headings = false) => {
      const exclude = note ? { exclude: note.id } : {};
      const result = tripId
        ? await post<{ notes: LinkTarget[] }>('/trip', { action: 'link_targets', trip_id: tripId, q, headings, ...exclude })
        : await invoke<{ notes: LinkTarget[] }>(
          `/link-targets?q=${encodeURIComponent(q)}${note ? `&exclude=${encodeURIComponent(note.id)}` : ''}`
          + (headings ? '&headings=1' : ''));
      return Array.isArray(result?.notes) ? result.notes : [];
    },
    onLinked: (target) => {
      requestedReferences.current.add(target.id);
      setReferenceLinks((current) => mergeLinks(current, { [target.id]: { id: target.id, title: target.title } }));
      if (target.restricted && note && !tripId) void checkLinks(note.id, [target.id]);
    },
  };
  // ⌘O finds a note and ⌘P runs a command, as in Obsidian; Ctrl elsewhere.
  useEffect(() => {
    const open = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key !== 'o' && key !== 'p') return;
      event.preventDefault(); setPalette(key === 'o' ? '' : '>');
    };
    window.addEventListener('keydown', open);
    return () => window.removeEventListener('keydown', open);
  }, []);
  const findNotes = async (q: string) => {
    const result = tripId ? await post<{ notes: PaletteNote[] }>('/trip', { action: 'link_targets', trip_id: tripId, q })
      : await invoke<{ notes: PaletteNote[] }>(`/link-targets?q=${encodeURIComponent(q)}`);
    return Array.isArray(result?.notes) ? result.notes : [];
  };
  // Asks which of the edited note's links some of its readers could not open; with `only`, rechecks just those targets.
  async function checkLinks(noteId: string, targets: string[], only = true) {
    const ids = [...new Set(targets)].slice(0, 20);
    try {
      const result = ids.length ? await invoke<{ links: LinkGap[] }>(
        `/link-access?note_id=${encodeURIComponent(noteId)}&targets=${ids.join(',')}`) : { links: [] };
      const found = Array.isArray(result?.links) ? result.links : [];
      setLinkGaps((current) => [...(only ? current.filter((gap) => !ids.includes(gap.target.id)) : []), ...found]);
    } catch { /* the notice is advice; a failed check leaves the editor as it was */ }
  }
  async function grantLinkAccess(gap: LinkGap, userIds: number[], tripIds: number[]) {
    if (!note) return;
    const result = await post<{ links: LinkGap[] }>('/link-grant',
      { note_id: note.id, target_id: gap.target.id, user_ids: userIds, trip_ids: tripIds });
    setLinkGaps((current) => [...current.filter((item) => item.target.id !== gap.target.id), ...(result.links || [])]);
    setGrantGap(null);
    setStatus(t('Shared “{target}”.', '已共享“{target}”。', { target: gap.target.title }));
  }
  useEffect(() => {
    setLinkGaps([]); setDismissedGaps([]);
    if (editing && note && !tripId && !createTripId) {
      void checkLinks(note.id, referenceSourcesInMarkdown(note.content).filter(isNoteId), false);
    }
  }, [editing, note?.id]);
  async function loadBacklinks(item: Note) {
    type Result = { notes: Backlink[]; mentions?: Backlink[] };
    try {
      const result = tripId ? await post<Result>('/trip', { action: 'backlinks', trip_id: tripId, note_id: item.id })
        : await invoke<Result>(`/backlinks?note_id=${encodeURIComponent(item.id)}`);
      setBacklinks(Array.isArray(result?.notes) ? result.notes : []); setMentions(Array.isArray(result?.mentions) ? result.mentions : []);
    } catch { setBacklinks([]); setMentions([]); }
  }
  // What an earlier version shows besides its text: its images and the links the open note has not resolved yet.
  async function versionAssets(content: string, versionId: string | null): Promise<[ImageSources, ReferenceLinks]> {
    if (!note) return [{}, {}];
    const embeds = new Set(embedSourcesInMarkdown(content));
    const missing = referenceSourcesInMarkdown(content).filter((reference) => !referenceLinks[reference]
      || (embeds.has(reference) && referenceLinks[reference].content === undefined));
    const sources = imageSourcesInMarkdown(content);
    const known = versionId ? [] : sources.filter((source) => imageSources[source]);
    const [images, links] = await Promise.all([
      resolveImages(note.id, tripId, sources.filter((source) => !known.includes(source)), versionId || undefined),
      Promise.all(missing.map((reference) => resolveReference(reference, tripId, embeds.has(reference)))),
    ]);
    return [{ ...Object.fromEntries(known.map((source) => [source, imageSources[source]])), ...Object.fromEntries(images) },
      { ...referenceLinks, ...linksOf(links) }];
  }
  // Restoring is one more change: the text it replaces stays in the history.
  async function restoreVersion(version: Version) {
    if (!note) return;
    const saved = tripId
      ? await post<Note>('/trip', { action: 'snapshot_restore', trip_id: tripId, note_id: note.id, version_id: version.id,
        version: note.version })
      : await post<Note>('/restore', { note_id: note.id, version_id: version.id, version: note.version });
    setHistoryOpen(false); setNote(saved); setDraft(draftOf(saved));
    await hydrateImages(saved, tripId); await hydrateReferences(saved, tripId); await loadBacklinks(saved); await load();
    setStatus(t('Restored the version from {time}.', '已恢复 {time} 的版本。',
      { time: new Intl.DateTimeFormat(context?.locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(version.edited_at)) }));
  }
  // Links every plain mention of the open note's title in another note, then lists it among the linked ones.
  async function linkMentions(source: Backlink) {
    if (!note) return;
    await post('/link-mentions', { note_id: source.id, target_id: note.id });
    await loadBacklinks(note);
    setStatus(t('Linked the mentions in “{note}”.', '已链接“{note}”中的提及。', { note: source.title }));
  }
  // Resolves image sources to data URLs, or to IMAGE_ERROR plus a readable reason, a batch per request so a note full of images
  // stays within what TREK lets a plugin call; a batch refused while Fieldnotes is busy waits and asks again. An image of an
  // earlier version is asked for with that version, as the note itself may no longer show it.
  async function resolveImages(noteId: string, viewTripId: number | null, sources: string[], versionId?: string) {
    type Batch = { images: { source: string; data_url?: string; error?: string; status?: number; template?: string }[];
      rest: string[] };
    const resolved: (readonly [string, string])[] = []; let queue = sources;
    while (queue.length) {
      const batch = queue.slice(0, assetBatch); queue = queue.slice(assetBatch);
      const body = { note_id: noteId, sources: batch, ...(viewTripId ? { trip_id: viewTripId } : {}),
        ...(versionId ? { version_id: versionId } : {}) };
      try {
        const result = await whenIdle(() => viewTripId ? post<Batch>('/trip', { action: 'assets', ...body }) : post<Batch>('/assets', body));
        for (const image of result.images) {
          resolved.push([image.source, image.data_url
            ?? `${IMAGE_ERROR}${imageFailure(new RequestError(image.error || '', image.status || 0, image.template || ''))}`]);
        }
        queue = [...result.rest, ...queue];
      } catch (error) { resolved.push(...batch.map((source) => [source, `${IMAGE_ERROR}${imageFailure(error)}`] as const)); }
    }
    return resolved;
  }
  async function hydrateImages(item: Note, viewTripId: number | null) {
    const sources = imageSourcesInMarkdown(item.content);
    requestedImages.current = new Set(sources.map((source) => `${item.id} ${source}`));
    setImageSources(Object.fromEntries(await resolveImages(item.id, viewTripId, sources)));
  }
  // While co-editing, images others insert arrive as text: fetch each new source once, after typing settles.
  function hydrateNewImages(item: Note, content: string) {
    window.clearTimeout(hydrateTimer.current);
    hydrateTimer.current = window.setTimeout(() => {
      const fresh = imageSourcesInMarkdown(content).filter((source) => !requestedImages.current.has(`${item.id} ${source}`));
      fresh.forEach((source) => requestedImages.current.add(`${item.id} ${source}`));
      if (fresh.length) {
        void resolveImages(item.id, tripId, fresh).then((images) => setImageSources((current) => ({ ...current, ...Object.fromEntries(images) })));
      }
    }, 800);
  }
  function imageFailure(error: unknown) {
    const message = error instanceof RequestError ? error.template : '';
    if (/host is not allowed/i.test(message))
      return t('this site is not allowed — copy the image itself and paste it here', '该网站不在允许列表，请复制图片本身后粘贴');
    if (/was deleted/i.test(message)) return t('the file was deleted', '文件已被删除');
    return t('image could not be loaded', '图片无法加载');
  }
  useEffect(() => {
    if (!editing || !tripId || !note) { setTripPdfs([]); return; }
    let alive = true;
    post<TripPdf[]>('/trip', { action: 'files', trip_id: tripId })
      .then((files) => alive && setTripPdfs(Array.isArray(files) ? files : []), () => {});
    return () => { alive = false; };
  }, [editing, tripId, note?.id]);
  useEffect(() => {
    if (!editing || !tripId || note?.mode !== 'snapshot') { setTripObjects([]); return; }
    let alive = true;
    post<{ objects: TrekObject[] }>('/trip', { action: 'objects', trip_id: tripId })
      .then((result) => alive && setTripObjects(Array.isArray(result?.objects) ? result.objects : []), () => {});
    return () => { alive = false; };
  }, [editing, tripId, note?.id]);
  // A card inserted from the menu shows at once; the menu already holds what it shows.
  function addTrekObject(card: TrekObject) {
    requestedReferences.current.add(`${TREK_PREFIX}${card.ref}`);
    setReferenceLinks((current) => ({ ...current, [`${TREK_PREFIX}${card.ref}`]: { trek: card } }));
  }
  // Trip pages reach Fieldnotes only through the companion's /trip route, which uploads on behalf of snapshot editors.
  const uploader: Invoke = tripId
    ? <T,>(_path: string, options?: { method: string; body: unknown }) =>
      post<T>('/trip', { action: 'upload', trip_id: tripId, ...(options?.body as object) })
    : invoke;
  // A snapshot is co-edited and versioned through the same route: the session's and history's own requests, renamed for it.
  const tripInvoke: Invoke = <T,>(path: string, options?: { method: string; body: unknown }) => {
    const query = new URLSearchParams(path.split('?')[1] || '');
    if (path === '/collab') {
      const { action: op, ...body } = options?.body as Record<string, unknown>;
      return post<T>('/trip', { ...body, action: 'collab', op, trip_id: tripId });
    }
    if (path.startsWith('/history')) {
      return post<T>('/trip', { action: 'snapshot_history', trip_id: tripId, note_id: query.get('note_id') });
    }
    return post<T>('/trip', { action: 'snapshot_version', trip_id: tripId, note_id: query.get('note_id'), version_id: query.get('id') });
  };
  // A trip's PDF is read once to show it while editing; the snapshot keeps a copy of it.
  function addTripPdf(pdf: TripPdf, insert: (markdown: string) => void) {
    uploadQueue.current = uploadQueue.current.then(async () => {
      setError('');
      try {
        const file = await post<{ data_url: string }>('/trip', { action: 'file', trip_id: tripId, source: pdf.source });
        setImageSources((current) => ({ ...current, [pdf.source]: file.data_url }));
        insert(`![${pdf.name.replace(/[[\]\n]/g, ' ')}](${pdf.source})`);
        setStatus(t('PDF added.', '已插入 PDF。'));
      } catch (error) { setError(messageOf(error)); }
    });
  }
  // Uploads queue apart from run(), so an image pasted during a save is never dropped.
  // Files go one at a time, each inserted where the caret is once it is stored.
  function addImages(files: File[], insert: (markdown: string) => void) {
    uploadQueue.current = uploadQueue.current.then(async () => {
      setError('');
      try {
        const isPdf = (file: File) => file.type === 'application/pdf';
        for (const [index, file] of files.entries()) {
          const pdf = isPdf(file);
          const progress = { current: index + 1, total: files.length };
          setStatus(pdf ? t('Uploading PDF {current}/{total}…', '正在上传 PDF {current}/{total}…', progress)
            : t('Uploading image {current}/{total}…', '正在上传图片 {current}/{total}…', progress));
          const image = await uploadAttachment(uploader, file);
          requestedImages.current.add(`${note?.id} ${image.source}`);
          setImageSources((current) => ({ ...current, [image.source]: image.dataUrl }));
          insert(`![${image.alt}](${image.source})`);
        }
        setStatus(files.every(isPdf) ? t('PDF added.', '已插入 PDF。') : t('Image added.', '已插入图片。'));
      } catch (error) {
        const reason = messageOf(error);
        setStatus('');
        setError(reason === 'too-large-pdf' ? t('PDFs must be {size} MB or smaller.', 'PDF 不能超过 {size} MB。',
          { size: maxPdfBytes / 1024 / 1024 })
          : reason === 'too-large' ? t('This image is still over {limit} after compression.', '图片压缩后仍超过 {limit}。',
            { limit: `${maxImageBytes / 1024 / 1024} MB` })
          : reason === 'unsupported' ? t('This image format is not supported.', '不支持这种图片格式。') : reason);
      }
    });
  }
  useEffect(() => {
    if (!context) return;
    setNote(null); setEditing(false); setPublicMode(false); setImageSources({}); noteMembers.show(null);
    folderMembers.show(null); setSelectedFolderId(null); setDays([]); setDayId(''); setReady(false);
    // The skeleton already says "loading", so the status line stays quiet; a failed load still shows its error.
    void run(async () => { try {
      await loadFolders();
      const loadedNotes = await load('', false);
      if (!tripId) {
        setReady(true);
        const [availableTrips, intent] = await Promise.all([
          invoke<Trip[]>('/trips'), post<TripCreateIntent | null>('/trip-intent', { action: 'take' }),
        ]);
        setTrips(availableTrips);
        const targetTrip = intent ? availableTrips.find((item) => Number(item.id) === intent.tripId) : null;
        if (intent && targetTrip) {
          setCreateTripId(intent.tripId); setCreateTripFolderId(intent.tripFolderId); setCreateTripTitle(intent.title || targetTrip.title);
          setDraft(empty); setEditing(true);
        }
      } else {
        try { await post('/trip', { action: 'can_edit', trip_id: tripId }); setCanEditTrip(true); }
        catch { setCanEditTrip(false); }
        setReady(true);
        setDays(await post<Day[]>('/trip', { action: 'days', trip_id: tripId }));
        const pending = await trek.session?.get<{ tripId: number; noteId: string }>('open_trip_note');
        if (pending && Number(pending.tripId) === tripId) {
          await trek.session?.remove('open_trip_note');
          const pendingNote = loadedNotes.find((item) => item.id === pending.noteId);
          if (pendingNote) await choose(pendingNote);
        }
      }
    } finally { setReady(true); } }, { silent: true });
  }, [tripId, context?.userId]);

  async function choose(item: Note) {
    if (!await discard()) return;
    if (!tripId) { setTarget(''); setDayId(''); setDays([]); }
    const next = tripId ? item : await invoke<Note>(`/note?id=${encodeURIComponent(item.id)}`);
    setNote(next); setImageSources({}); setReferenceLinks({}); setDraft(next.unavailable ? empty : draftOf(next)); setEditing(false);
    setContentMotion('neutral');
    setLinkedTrips([]); setComments([]); setPendingQuote(null); setActiveThread(null); setBacklinks([]); setMentions([]);
    if (!next.unavailable) {
      await hydrateImages(next, tripId); await hydrateReferences(next, tripId); await loadBacklinks(next);
      await loadCollaborators(next); await loadLinkedTrips(next); await loadComments(next);
    }
    return next;
  }
  async function loadComments(item: Note) {
    if (!tripId || item.unavailable) { setComments([]); return; }
    setComments(await post<Comment[]>('/trip', { action: 'comments', trip_id: tripId, note_id: item.id }));
  }
  // Comment writes return the note's whole discussion, so the panel always shows what the server holds.
  async function commentRequest(input: Record<string, unknown>) {
    if (!tripId || !note) return false;
    let sent = false;
    await run(async () => {
      setComments(await post<Comment[]>('/trip', { trip_id: tripId, note_id: note.id, ...input })); sent = true;
    }, { silent: true });
    return sent;
  }
  const commentActions = {
    add: async (body: string, anchor: Anchor | null) => {
      const sent = await commentRequest({ action: 'comment_add', body, ...anchor });
      if (sent) setPendingQuote(null);
      return sent;
    },
    reply: (rootId: string, body: string) => commentRequest({ action: 'comment_add', parent_id: rootId, body }),
    edit: (commentId: string, body: string) => commentRequest({ action: 'comment_edit', comment_id: commentId, body }),
    remove: (comment: Comment) => void (async () => {
      const message = comment.parent_id ? t('Delete this reply?', '删除这条回复？')
        : t('Delete this comment and its replies?', '删除这条评论及其全部回复？');
      const title = comment.parent_id ? t('Delete reply', '删除回复') : t('Delete comment', '删除评论');
      if (!await confirm({ title, message, confirmLabel: t('Delete', '删除'), danger: true })) return;
      await commentRequest({ action: 'comment_delete', comment_id: comment.id });
    })(),
    resolve: (commentId: string, resolved: boolean) => {
      if (resolved && activeThread === commentId) setActiveThread(null);
      void commentRequest({ action: 'comment_resolve', comment_id: commentId, resolved });
    },
  };
  function quote(anchor: Anchor) {
    setPendingQuote(anchor); setActiveThread(null); toggleComments(true);
  }
  async function convertToSnapshot(item = note) {
    if (!tripId || !item) return;
    if (!await confirm({
      title: t('Convert to snapshot', '转为快照'), confirmLabel: t('Convert', '转换'),
      message: t('Convert to a snapshot? The trip keeps its own copy, which no longer follows the author’s edits and stays if they leave.',
        '转为快照？这次旅行会保留一份副本，不再同步作者之后的修改，作者删除原文或离开旅行也不受影响。')
    })) return;
    const saved = await post<Note>('/trip', { action: 'snapshot_convert', trip_id: tripId, note_id: item.id });
    if (note?.id === item.id) { setNote(saved); setDraft(draftOf(saved)); }
    await load(); setStatus(t('Converted to a snapshot.', '已转为快照。'));
  }
  async function removeFromTrip(item = note) {
    if (!tripId || !item) return;
    const message = item.mode === 'snapshot'
      ? t('Remove this snapshot from the trip? It stays in Recently deleted for 30 days, with its comments.',
        '从这次旅行中移除这份快照？它会连同评论在“最近删除”中保留 30 天。')
      : t('Remove this reference from the trip? It stays in Recently deleted for 30 days; the original is unchanged.',
        '从这次旅行中移除这条引用？它会在“最近删除”中保留 30 天，原文不受影响。');
    const removal = t('Remove from trip', '从旅行移除');
    if (!await confirm({ title: removal, message, confirmLabel: removal, danger: true })) return;
    await post('/trip', { action: 'unlink', trip_id: tripId, note_id: item.id });
    if (note?.id === item.id) setNote(null);
    if (previewId === item.id) setPreviewId(null);
    await load(); setStatus(t('Moved to Recently deleted.', '已移到“最近删除”。'));
  }
  // With a heading, the note opens scrolled to it; a link into the note already being read just scrolls.
  async function openReference(id: string, heading = '') {
    if (heading && note?.id === id && !editing && noteArticle.current) { revealHeading(noteArticle.current, heading); return; }
    pendingHeading.current = heading;
    if (!tripId) { await choose({ id } as Note); return; }
    // A trip page holds whole notes rather than fetching one by id, and the open folder may not contain the target.
    const { notes: shared } = await post<{ notes: Note[] }>('/trip', { action: 'list', trip_id: tripId });
    const target = shared.find((item) => item.id === id);
    if (target) await choose(target);
  }
  const update = (key: keyof Draft, value: Draft[typeof key]) => setDraft((prev) => ({ ...prev, [key]: value }));
  async function loadFolderCollaborators(folderId: string | null) {
    const folder = folders.find((item) => item.id === folderId);
    if (!folderId || tripId || !folder?.can_manage) { folderMembers.show(null); return; }
    folderMembers.show(await post<{ collaborators: Collaborator[]; candidates: Person[] }>(
      '/folder', { action: 'collaborators', folder_id: folderId }
    ));
  }
  async function selectFolder(folderId: string | null) {
    if (!await discard()) return;
    const depth = (id: string | null) => finder.pathTo(id).length;
    setContentMotion(depth(folderId) < depth(selectedFolderId) ? 'backward' : 'forward');
    setSelectedFolderId(folderId); setNote(null); setImageSources({}); setEditing(false); setPreviewId(null);
    setBinOpen(false);
  }
  // Selecting a note in the column view shows it in the preview column, with its images and links resolved.
  async function previewNote(item: Note) {
    setPreviewId(item.id); setImageSources({}); setReferenceLinks({}); previewing.current = item.id;
    if (item.unavailable) return;
    const read = tripId ? item : await invoke<Note>(`/note?id=${encodeURIComponent(item.id)}`);
    if (previewing.current !== item.id) return;
    setPreviewRead(read); await hydrateImages(read, tripId); await hydrateReferences(read, tripId);
  }
  async function clearSearch() {
    setQuery(''); await load('');
  }
  function resetNewFolder(open: boolean) {
    setNewFolderName(''); setNewFolderIcon(''); setNewFolderIconTouched(false); setNewFolderOpen(open);
  }
  function toggleNewFolder() {
    if (newFolderOpen) resetNewFolder(false); else setNewFolderOpen(true);
  }
  // A trip's folders take the library's actions under a `folder_` prefix, through the trip's own route.
  const folderRequest = (action: string, body: Record<string, unknown>) => tripId
    ? post('/trip', { action: `folder_${action}`, trip_id: tripId, ...body }) : post('/folder', { action, ...body });
  async function createFolder() {
    if (!newFolderName.trim()) return;
    await folderRequest('create', { name: newFolderName.trim(), icon: newFolderIcon.trim() || null, parent_id: selectedFolderId,
      ...(tripId ? {} : { visibility: scope }) });
    resetNewFolder(false); await loadFolders();
  }
  async function moveNoteToFolder(noteId: string, folderId: string | null) {
    await folderRequest('move_note', { note_id: noteId, folder_id: folderId });
    await load(); setStatus(t('Moved to folder.', '已移动到文件夹。'));
  }
  async function openLinkedTrip(trip: LinkedTrip) {
    if (!note || !trek.session) { trek.navigate(`/trips/${trip.id}`); return; }
    await trek.session.set('open_trip_note', { tripId: trip.id, noteId: note.id });
    trek.navigate(`/trips/${trip.id}`);
  }
  async function deleteFolder(folder: Folder) {
    if (!await confirm({
      danger: true, title: t('Delete folder', '删除文件夹'), confirmLabel: t('Delete', '删除'),
      message: t('Delete the folder “{name}”? Only empty folders can be deleted.', '删除文件夹“{name}”？只能删除空文件夹。',
        { name: folder.name })
    })) return;
    await folderRequest('archive', { folder_id: folder.id });
    if (selectedFolderId === folder.id) {
      setSelectedFolderId(null); folderMembers.show(null);
      await load();
    }
    await loadFolders();
  }
  async function updateFolderIcon(icon: string, folder: Folder) {
    if (!folder?.can_manage) return;
    await folderRequest('icon', { folder_id: folder.id, icon: icon.trim() || null });
    await loadFolders();
  }
  const folderSettingsActions = (folder: Folder) => ({
    onIconDraft: (icon: string) => setFolders((items) => items.map((item) => item.id === folder.id ? { ...item, icon } : item)),
    onIcon: (icon: string) => void run(() => updateFolderIcon(icon, folder)),
    onVisibility: (visibility: string) => void run(() => moveToLibrary('folder', folder.id, folder.parent_id,
      visibility as 'private' | 'public')),
  });
  async function openFolderPermissions(folder: Folder) {
    if (tripId || !folder.can_manage) return;
    permissionTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPermissionFolderId(folder.id); await loadFolderCollaborators(folder.id);
  }
  async function moveFolder(folderId: string, parentId: string | null) {
    await folderRequest('move', { folder_id: folderId, parent_id: parentId });
    await loadFolders(); setStatus(t('Folder moved.', '文件夹已移动。'));
  }
  // A new key starts in its natural order, names A to Z and dates newest first; the same key keeps its order.
  async function changeSorting(key: Sorting['key'], order = key === sorting.key ? sorting.order : key === 'name' ? 'asc' : 'desc') {
    const next = { key, order }; setSorting(next); setSortOpen(false); setContentMotion('neutral');
    try { window.localStorage.setItem(SORT_KEY, JSON.stringify(next)); } catch { /* a convenience; the order still applies */ }
    if (!tripId) await load(query, publicMode, next);
  }
  // The other library is fetched first and swapped in whole, so no frame shows one library's notes under the other's name.
  async function switchLibrary(nextPublic: boolean) {
    if (!await discard()) return;
    setContentMotion(nextPublic ? 'forward' : 'backward');
    await load('', nextPublic);
    setPublicMode(nextPublic); setSelectedFolderId(null); setNote(null); setImageSources({}); setEditing(false);
    setQuery(''); setPreviewId(null); setBinOpen(false);
  }
  async function saveFolderRoleChanges() {
    const folderId = permissionFolderId;
    if (!folderId || !folderMembers.changes.length) return;
    await post('/folder', { action: 'bulk_roles', folder_id: folderId, changes: folderMembers.changes });
    await loadFolderCollaborators(folderId); setStatus(t('Permissions updated.', '权限已更新。'));
  }
  async function save() {
    if (createTripId && !note) {
      await post<Note>('/trip-note', {
        trip_id: createTripId, trip_folder_id: createTripFolderId, library_folder_id: draft.folder_id,
        title: draft.title, content: draft.content, icon: draft.icon, properties: draft.properties
      });
      trek.navigate(`/trips/${createTripId}?tab=plugin%3Afieldnotes-trip`);
      return;
    }
    const saved = await post<Note>('/save', {
      id: note?.id, version: note?.version, title: draft.title, content: draft.content, icon: draft.icon,
      properties: draft.properties, visibility: draft.visibility, folder_id: draft.folder_id
    });
    setNote(saved); setDraft(draftOf(saved)); setEditing(false);
    if (!note) await loadCollaborators(saved);
    await hydrateImages(saved, null); await hydrateReferences(saved, null); await load(); setStatus(t('Saved.', '已保存。'));
  }
  async function cancelEditing() {
    if (!await discard()) return;
    if (createTripId) trek.navigate(`/trips/${createTripId}?tab=plugin%3Afieldnotes-trip`);
    else setEditing(false);
  }
  function createForCurrentTrip(folderId = selectedFolderId) {
    if (!tripId) return;
    void run(async () => {
      await post('/trip', { action: 'begin_note', trip_id: tripId, trip_folder_id: folderId });
      trek.navigate('/plugins/fieldnotes');
    });
  }
  async function setDestination(value: string) {
    setTarget(value); setDayId(''); setDays([]);
    if (value) setDays(await post<Day[]>('/trip', { action: 'days', trip_id: Number(value) }));
  }
  async function saveRoleChanges() {
    if (!note || !noteMembers.changes.length) return;
    await post('/collaborator', { action: 'bulk_roles', note_id: note.id, changes: noteMembers.changes });
    await loadCollaborators(note); setStatus(t('Permissions updated.', '权限已更新。'));
  }
  async function removeLinkedTrip(trip: LinkedTrip) {
    if (!note) return;
    if (!await confirm({
      danger: true, title: t('Remove from trip', '从旅行移除'), confirmLabel: t('Remove from trip', '从旅行移除'),
      message: t('Remove “{note}” from {trip}? It stays in the trip’s Recently deleted for 30 days.',
        '从“{trip}”中移除“{note}”？它会在这次旅行的“最近删除”中保留 30 天。', { note: note.title, trip: trip.title })
    })) return;
    await post('/trip', { action: 'unlink', trip_id: trip.id, note_id: note.id, mode: 'live' });
    await loadLinkedTrips(note); setStatus(t('Removed from trip.', '已从旅行中移除。'));
  }
  // The open note goes to the other library, and the page with it, so leaving the note returns to where it now lives.
  async function changeVisibility(visibility: 'private' | 'public') {
    if (!note || !await moveToLibrary('note', note.id, note.folder_id || null, visibility)) return;
    setNote(await invoke<Note>(`/note?id=${encodeURIComponent(note.id)}`));
    const nextPublic = visibility === 'public';
    if (nextPublic === publicMode) await load();
    else { await load('', nextPublic); setPublicMode(nextPublic); setQuery(''); }
  }
  // Moving between the libraries takes what you own inside along; going public also opens the private folders above, which
  // is asked first, since their names then show to everyone.
  async function moveToLibrary(kind: 'note' | 'folder', itemId: string, parentId: string | null, visibility: 'private' | 'public') {
    const above: string[] = [];
    for (let current = visibility === 'public' ? folders.find((item) => item.id === parentId) : undefined; current;
      current = folders.find((item) => item.id === current!.parent_id)) {
      if (current.visibility !== 'public') above.unshift(current.name);
    }
    if (above.length && !await confirm({ title: t('Move to the public library', '移到公开图书馆'), confirmLabel: t('Move', '移动'),
      message: t('The folders above it, {folders}, become public too. Only their names show; what else they hold stays private.',
        '它上层的文件夹“{folders}”也会公开。公开的只有文件夹名称，其中的其他内容仍然保持私人。', { folders: above.join(' › ') }) })) return false;
    if (kind === 'note') await post<Note>('/note-settings', { id: itemId, visibility });
    else await post('/folder', { action: 'visibility', folder_id: itemId, visibility });
    // An open note takes the page to its new library, which changeVisibility loads instead.
    await loadFolders(); if (!note || note.id !== itemId) await load();
    if (previewId === itemId) setPreviewId(null);
    setStatus(visibility === 'public' ? t('Moved to the public library.', '已移到公开图书馆。')
      : t('Moved to the private library.', '已移到私人图书馆。'));
    return true;
  }
  // Sharing opens as a window over the note; closing it with unsaved roles asks first, then drops them.
  function openShare() {
    shareTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setShareOpen(true);
  }
  async function closeShare() {
    if (!await discard()) return;
    setShareOpen(false);
    if (note && noteMembers.changes.length) await loadCollaborators(note);
  }
  async function deleteNote(item: Note) {
    if (!await confirm({
      danger: true, title: t('Delete note', '删除笔记'), confirmLabel: t('Delete', '删除'), message: t(
        'Delete this note? It stays in Recently deleted for 30 days. Live references become unavailable; snapshots remain.',
        '删除这篇笔记？它会在“最近删除”中保留 30 天。实时引用将不可用，旅行快照会保留。')
    })) return;
    await post('/archive', { id: item.id, version: item.version });
    if (note?.id === item.id) setNote(null);
    if (previewId === item.id) setPreviewId(null);
    await load(); setStatus(t('Moved to Recently deleted.', '已移到“最近删除”。'));
  }
  // Each library's Recently deleted holds its owner's notes that would return to it; a trip's holds what its editors removed, and
  // others find it empty.
  async function loadDeleted(publicScope = publicMode) {
    const list = tripId ? await post<DeletedNote[]>('/trip', { action: 'deleted', trip_id: tripId }).catch(() => [])
      : await invoke<DeletedNote[]>(`/deleted?library=${publicScope ? 'public' : 'private'}`);
    setDeletedNotes(Array.isArray(list) ? list.map(deletedTitle) : []);
  }
  const deletedTitle = <T extends DeletedNote>(item: T): T => ({ ...item, title: item.title ?? unavailableTitle });
  async function previewDeleted(item: DeletedNote) {
    setPreviewId(item.id); previewing.current = item.id;
    const read = tripId ? await post<Note & DeletedNote>('/trip', { action: 'deleted', trip_id: tripId, note_id: item.id })
      : await invoke<Note & DeletedNote>(`/deleted?id=${encodeURIComponent(item.id)}`);
    if (previewing.current === item.id) setDeletedRead(deletedTitle(read));
  }
  async function leaveDeleted(item: DeletedNote) {
    if (previewId === item.id) { setPreviewId(null); setDeletedRead(null); }
    await loadDeleted();
  }
  async function openBin() {
    if (!await discard()) return;
    setContentMotion('forward'); setSelectedFolderId(null); setNote(null); setPreviewId(null); setDeletedRead(null); setBinOpen(true);
    await loadDeleted();
  }
  async function recoverNote(item: DeletedNote) {
    if (tripId) await post('/trip', { action: 'deleted_recover', trip_id: tripId, note_id: item.id });
    else await post('/deleted', { action: 'recover', id: item.id });
    await leaveDeleted(item); await load(); setStatus(t('Note recovered.', '笔记已恢复。'));
  }
  async function deletePermanently(item: DeletedNote) {
    if (!await confirm({ danger: true, title: t('Delete permanently', '永久删除'), confirmLabel: t('Delete', '删除'),
      message: t('Delete “{note}” permanently? This can’t be undone.',
      '永久删除“{note}”？此操作无法撤销。', { note: item.title }) })) return;
    if (tripId) await post('/trip', { action: 'deleted_delete', trip_id: tripId, note_id: item.id });
    else await post('/deleted', { action: 'delete', id: item.id });
    await leaveDeleted(item); setStatus(t('Deleted permanently.', '已永久删除。'));
  }
  // What the open page can do, for the command palette; each runs exactly as its button does.
  function paletteCommands(): PaletteCommand[] {
    const library = !tripId; const reading = note && !editing && !note.unavailable;
    const edit = () => startEditing(note!);
    return [
      library && { label: t('New note', '新建笔记'), icon: 'note-plus', run: () => void run(() => startNote(selectedFolderId)) },
      library && { label: t('Import Markdown or ZIP…', '导入 Markdown 或 ZIP…'), icon: 'import',
        run: () => pickImport(selectedFolderId, false) },
      library && { label: t('Import a folder…', '导入文件夹…'), icon: 'import', run: () => pickImport(selectedFolderId, true) },
      tripId && canEditTrip && { label: t('New note for this trip', '为这次旅行新建笔记'), icon: 'note-plus', run: () => createForCurrentTrip() },
      library && reading && note.can_edit && { label: t('Edit', '编辑'), icon: 'edit', run: edit },
      tripId && canEditTrip && reading && note.mode === 'snapshot' && { label: t('Edit snapshot', '编辑快照'), icon: 'edit', run: edit },
      ((library && reading && note.can_edit) || (tripId && canEditTrip && reading && note.mode === 'snapshot'))
        && { label: t('Version history', '版本历史'), icon: 'history', run: () => setHistoryOpen(true) },
      library && reading && { label: t('Sharing', '共享'), icon: 'share', run: openShare },
      tripId && reading && { label: t('Comments', '评论'), icon: 'comment', run: () => toggleComments(true) },
      reading && { label: t('Copy as Markdown', '复制为 Markdown'), icon: 'copy', run: () => void run(() => copyMarkdown(note)) },
      note && !editing && { label: backLabel, icon: 'library', run: () => void run(backToLibrary) },
    ].filter((command): command is PaletteCommand => Boolean(command));
  }
  // Linked notes are named by their current titles, read from the open note's links or asked for.
  async function copyMarkdown(listed: Note) {
    const item = tripId ? listed : note && listed.id === note.id ? note : await invoke<Note>(`/note?id=${encodeURIComponent(listed.id)}`);
    const ids = referenceSourcesInMarkdown(item.content).filter(isNoteId);
    const known = item.id === note?.id ? referenceLinks : {};
    const found = await Promise.all(ids.map(async (target) => [target,
      known[target] ?? await resolveReference(target, tripId)] as const));
    const titles = Object.fromEntries(found.flatMap(([target, link]) =>
      link && !link.unavailable && link.title ? [[target, link.title]] : []));
    if (await copyText(noteMarkdown(item, titles))) setStatus(t('Copied as Markdown.', '已复制为 Markdown。'));
    else setError(t('Couldn’t copy. Select the text and copy it instead.', '无法复制，请选中文字后手动复制。'));
  }
  function pickImport(folderId: string | null, folder: boolean) {
    importTarget.current = folderId; (folder ? importFolder : importFiles).current?.click();
  }
  function importPicked(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []); event.target.value = '';
    if (files.length) void run(() => runImport(files));
  }
  // Notes arrive in a new folder under the chosen one; the notice counts them in, then says what could not come along.
  async function runImport(files: File[]) {
    const { name, entries } = await entriesOf(files);
    if (!entries.some((entry) => /\.(md|markdown)$/i.test(entry.path))) {
      setError(t('No Markdown notes to import.', '没有可导入的 Markdown 笔记。')); return;
    }
    const result = await importNotes(entries, name, importTarget.current, {
      folder: async (folderName, parentId) => (await post<Folder>('/folder', { action: 'create', name: folderName.slice(0, 80),
        parent_id: parentId, visibility: scope })).id,
      note: (fields) => post<Note>('/save', { ...fields, content: '', visibility: scope }),
      write: async (item, content) => { await post<Note>('/save', { id: item.id, version: item.version, title: item.title, content }); },
      upload: async (file) => (await uploadAttachment(invoke, file)).source,
      progress: (done, total) => setStatus(t('Importing… {percent}%', '正在导入… {percent}%', { percent: Math.round(done / total * 100) })),
    });
    await loadFolders(); await load();
    setStatus(result.notes === 1 ? t('Imported 1 note.', '已导入 1 篇笔记。')
      : t('Imported {count} notes.', '已导入 {count} 篇笔记。', { count: result.notes }));
    if (result.skipped.length) setError(t('These could not be imported in full: {files}', '以下内容未能完整导入：{files}',
      { files: result.skipped.join(', ') }));
  }
  async function startNote(folderId: string | null) {
    if (!await discard()) return;
    setNote(null); setDraft({ ...empty, visibility: scope, folder_id: folderId }); setImageSources({}); setEditing(true);
  }
  // Writing hides the comments; a trip's menu offers it only to the trip's editors, the library's to the note's.
  function startEditing(item: Note) {
    setDraft(draftOf(item)); setCommentsOpen(false); setEditing(true);
  }
  async function openToEdit(item: Note) {
    const opened = await choose(item);
    if (opened && !opened.unavailable && (tripId || opened.can_edit)) startEditing(opened);
  }
  async function startFolder(parentId: string | null) {
    await selectFolder(parentId);
    resetNewFolder(true);
  }
  async function backToLibrary() {
    if (!await discard()) return;
    const left = note;
    setNote(null); setImageSources({}); setReferenceLinks({}); setEditing(false); setLinkedTrips([]); noteMembers.show(null);
    setComments([]); setPendingQuote(null); setActiveThread(null);
    // The notes come back on the one just left, selected and previewed where it lives.
    if (left && !left.unavailable) {
      const listed = notes.find((item) => item.id === left.id);
      setSelectedFolderId(listed ? finder.parentOf(listed) : null);
      if (listed) await previewNote(listed);
    }
  }

  // Collaborators may only freeze a private note into a trip; a live reference is the owner's call.
  const canShareLive = !note || owns(note) || note.visibility === 'public';
  const linkMode = canShareLive ? mode : 'snapshot';
  async function link() {
    if (!note || !target) return;
    const message = linkMode === 'live'
      ? t('All trip members will see this note and future edits. Share a live reference?',
        '这次旅行的成员将能阅读这篇笔记及后续修改。确认共享实时引用？')
      : t('A full copy will remain with this trip even if you delete the original or leave. Import a snapshot?',
        '完整副本会保留在这次旅行中，即使你删除原文或离开旅行。确认导入快照？');
    const confirmLabel = linkMode === 'live' ? t('Share', '共享') : t('Import', '导入');
    if (!await confirm({ title: t('Add to trip', '添加到旅行'), message, confirmLabel })) return;
    await post('/link', { note_id: note.id, trip_id: Number(target), day_id: dayId || null, mode: linkMode });
    await loadLinkedTrips(note);
    setStatus(t('Added to trip. With Trip Fieldnotes installed, open it in the trip’s Trip Fieldnotes tab.',
      '已添加到旅行。安装 Trip Fieldnotes 后，可在旅行的 Trip Fieldnotes 标签页打开。'));
  }
  const threads = threadsOf(comments);
  const openThreads = threads.filter((thread) => !thread.root.resolved_at).length;
  const visibleFolders = tripId ? folders : publicMode ? folders.filter((folder) => folder.public_path) : privateFolders(folders, notes);
  const permissionFolder = folders.find((folder) => folder.id === permissionFolderId);
  // Search results keep the server's order, best matches first.
  const listedNotes = tripId && results === null ? sortItems(notes, (item) => item.title || '', sorting, collator) : notes;
  const sortOptions: [Sorting['key'], string][] = [
    ['name', t('Name', '名称')], ['updated', t('Date modified', '修改日期')], ['created', t('Date created', '创建日期')]];
  const orderOptions: [Sorting['order'], string][] = sorting.key === 'name'
    ? [['asc', t('A to Z', 'A → Z')], ['desc', t('Z to A', 'Z → A')]]
    : [['desc', t('Newest first', '最新的在前')], ['asc', t('Oldest first', '最早的在前')]];
  const permissionDirty = folderMembers.changes.length > 0 || noteMembers.changes.length > 0;
  // Folders always list by name above the notes, as Finder keeps them; the chosen sort orders the notes. A note a trip can no longer
  // reach keeps its row, named for what happened to it.
  const finder = finderIndex([...visibleFolders].sort((a, b) => collator.compare(a.name, b.name)),
    listedNotes.map((item) => item.unavailable ? { ...item, title: unavailableTitle } : item));
  const finderPath = finder.pathTo(selectedFolderId);
  // A folder that moved to the other library leaves this one; the nearest folder above it that stays takes the selection.
  useEffect(() => {
    if (!selectedFolderId || finder.folder(selectedFolderId) || !folders.length) return;
    const parentOf = (folderId: string | null) => folders.find((item) => item.id === folderId)?.parent_id || null;
    let nearest = parentOf(selectedFolderId);
    while (nearest && !finder.folder(nearest)) nearest = parentOf(nearest);
    setSelectedFolderId(nearest);
  });
  // Finder's context menus: what a note, a folder, or the empty space of a column can do for this reader.
  function finderMenuItems(target: FinderTarget<Folder, Note>): ContextMenuItem[] {
    const canCreate = (folderId: string | null) => tripId ? canEditTrip
      : !folderId || finder.folder(folderId)?.role === 'editor';
    const creating = (folderId: string | null): ContextMenuItem[] => canCreate(folderId) ? [
      tripId ? { label: t('New note for this trip', '为这次旅行新建笔记'), icon: 'note-plus', onSelect: () => createForCurrentTrip(folderId) }
        : { label: t('New note', '新建笔记'), icon: 'note-plus', onSelect: () => void run(() => startNote(folderId)) },
      { label: t('New folder', '新建文件夹'), icon: 'folder-plus',
        onSelect: () => void run(() => startFolder(folderId), { silent: true }) }] : [];
    // Imports land where the menu was opened, so they live in a column's own menu rather than on every folder.
    const importing = (folderId: string | null): ContextMenuItem[] => canCreate(folderId) && !tripId ? [
      { label: t('Import Markdown or ZIP…', '导入 Markdown 或 ZIP…'), icon: 'import', onSelect: () => pickImport(folderId, false) },
      { label: t('Import a folder…', '导入文件夹…'), icon: 'import', onSelect: () => pickImport(folderId, true) }] : [];
    const tidy = (items: ContextMenuItem[]) => items.filter((item, at) => item !== 'separator' || (at > 0 && at < items.length - 1
      && items[at - 1] !== 'separator'));
    if (target.kind === 'note') {
      const item = target.note;
      const action = (label: string, icon: IconName, act: () => Promise<unknown>, danger = false): ContextMenuItem => ({ label, icon,
        danger, onSelect: () => void run(act) });
      const remove = action(t('Remove from trip', '从旅行移除'), 'trash', () => removeFromTrip(item), true);
      if (item.unavailable) return tripId && canEditTrip ? [remove] : [];
      // A list row doesn't say who else may edit a library note, so only the owner's offer Edit and Sharing here.
      const own = tripId ? canEditTrip ? [
        item.mode === 'snapshot' ? action(t('Edit snapshot', '编辑快照'), 'edit', () => openToEdit(item))
          : item.can_snapshot && action(t('Convert to snapshot', '转为快照'), 'snapshot', () => convertToSnapshot(item)),
        'separator' as const, remove] : []
        : owns(item) ? [action(t('Edit', '编辑'), 'edit', () => openToEdit(item)),
          action(t('Sharing', '共享'), 'share', async () => { if (await choose(item)) openShare(); }), 'separator' as const,
          action(t('Delete note', '删除笔记'), 'trash', () => deleteNote(item), true)] : [];
      return tidy([action(t('Open', '打开'), 'note', () => choose(item)),
        action(t('Copy as Markdown', '复制为 Markdown'), 'copy', () => copyMarkdown(item)),
        'separator', ...own.filter((entry): entry is ContextMenuItem => Boolean(entry))]);
    }
    if (target.kind === 'folder') {
      const folder = target.folder;
      return tidy([
        { label: t('Open', '打开'), icon: 'folder', onSelect: () => void run(() => selectFolder(folder.id), { silent: true }) },
        'separator', ...creating(folder.id),
        ...(folder.can_manage && !tripId ? ['separator' as const,
          { label: t('Permissions', '权限'), icon: 'settings' as const,
            onSelect: () => void run(() => openFolderPermissions(folder)) }] : []),
        ...(folder.can_manage && (!tripId || canEditTrip) ? [...(tripId ? ['separator' as const] : []),
          { label: t('Delete', '删除'), icon: 'trash' as const, danger: true, onSelect: () => void run(() => deleteFolder(folder)) }] : []),
      ]);
    }
    return tidy([...creating(target.parent), 'separator', ...importing(target.parent), 'separator',
      ...sortOptions.map(([key, label]): ContextMenuItem => ({ label, icon: 'check', checked: sorting.key === key,
        onSelect: () => void run(() => changeSorting(key),
          { silent: true }) }))]);
  }
  const folderMemberEditor = () => <CollaboratorEditor state={folderMembers} busy={busy} t={t}
    onSave={() => void run(saveFolderRoleChanges)} />;
  async function closeFolderPermissions() {
    if (await discard()) setPermissionFolderId(null);
  }
  useEffect(() => { closeFolderPermissionsRef.current = closeFolderPermissions; });
  useDismiss(sortOpen, sortRoot, () => setSortOpen(false), sortButton);
  useDialogFocus(permissionModal, permissionFolderId, () => void closeFolderPermissionsRef.current(), permissionTrigger);
  useDialogFocus(grantDialog, grantGap?.target.id, () => setGrantGap(null));
  useDialogFocus(shareDialog, shareOpen && note?.id, () => void run(closeShare, { silent: true }), shareTrigger);
  useDialogFocus(historyDialog, historyOpen && note?.id, () => setHistoryOpen(false), historyTrigger);
  function dragNoteStart(item: Note, event: React.DragEvent<HTMLButtonElement>) {
    if (!(tripId ? canEditTrip : owns(item))) { event.preventDefault(); return; }
    setDragged({ kind: 'note', id: item.id, from: finder.parentOf(item) });
    event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.id);
  }
  const canMoveFolder = (folder: Folder) => folder.can_manage && (!tripId || canEditTrip);
  function dragFolderStart(folder: Folder, event: React.DragEvent<HTMLButtonElement>) {
    if (!canMoveFolder(folder)) { event.preventDefault(); return; }
    setDragged({ kind: 'folder', id: folder.id, from: folder.parent_id || null });
    event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', folder.name);
  }
  function endDrag() { setDragged(null); setDropTarget(null); }
  function isWithin(folderId: string | null, ancestorId: string) {
    const seen = new Set<string>();
    while (folderId && !seen.has(folderId)) {
      if (folderId === ancestorId) return true;
      seen.add(folderId); const current = folderId; folderId = folders.find((item) => item.id === current)?.parent_id || null;
    }
    return false;
  }
  function canDrop(target: Folder | null) {
    if (!dragged || dragged.from === (target?.id || null)) return false;
    if (dragged.kind === 'note') return !target || target.can_manage;
    return !target || (target.role === 'editor' && !isWithin(target.id, dragged.id));
  }
  // Drop target handlers for a folder row, a subfolder card, or `null` for the library root.
  function dropProps(target: Folder | null) {
    const key = target?.id || 'root';
    const over = (event: React.DragEvent<HTMLElement>) => {
      if (!canDrop(target)) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(key);
    };
    return {
      onDragEnter: over, onDragOver: over,
      onDragLeave: (event: React.DragEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget((current) => current === key ? null : current);
      },
      onDrop: (event: React.DragEvent<HTMLElement>) => {
        event.preventDefault();
        const item = dragged; const allowed = canDrop(target); endDrag();
        if (!item || !allowed) return;
        void run(async () => {
          if (item.kind === 'note') await moveNoteToFolder(item.id, target?.id || null);
          else await moveFolder(item.id, target?.id || null);
          setLandedKey(key); window.setTimeout(() => setLandedKey((current) => current === key ? null : current), 650);
        });
      },
    };
  }
  // The other library's tab takes a dragged note or folder there, as its visibility setting does.
  function libraryDropProps(visibility: 'private' | 'public') {
    const key = `library-${visibility}`;
    const allowed = () => Boolean(dragged) && !tripId && visibility !== scope;
    const over = (event: React.DragEvent<HTMLElement>) => {
      if (!allowed()) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(key);
    };
    return {
      onDragEnter: over, onDragOver: over,
      onDragLeave: () => setDropTarget((current) => current === key ? null : current),
      onDrop: (event: React.DragEvent<HTMLElement>) => {
        event.preventDefault();
        const item = dragged; const ok = allowed(); endDrag();
        if (item && ok) void run(() => moveToLibrary(item.kind, item.id, item.from, visibility));
      },
    };
  }
  const dragClass = (key: string) =>
    `${dropTarget === key ? ' is-drop-target' : ''}${landedKey === key ? ' is-landed' : ''}${dragged?.id === key ? ' is-dragging' : ''}`;

  const newFolderForm = <form className="trek-stack fn-folder-form"
    onSubmit={(event) => { event.preventDefault(); void run(createFolder); }}>
    <div className="fn-folder-create-fields">
      <div className="fn-folder-icon-input">
        <label className="fn-visually-hidden" htmlFor="new-folder-icon">{t('Icon', '图标')}</label>
        <input id="new-folder-icon" className="trek-input fn-emoji-input" maxLength={8} aria-label={t('Icon', '图标')}
          aria-describedby="new-folder-icon-help" placeholder="" value={newFolderIcon}
          onChange={(event) => { setNewFolderIconTouched(true); setNewFolderIcon(event.target.value); }} />
        <small id="new-folder-icon-help" className="fn-folder-icon-help trek-muted">
          {t('Supports ≤8 characters and emoji', '支持≤8个字符和 emoji')}</small>
      </div>
      <div>
        <label className="fn-visually-hidden" htmlFor="new-folder-name">{t('Folder name', '文件夹名称')}</label>
        <input id="new-folder-name" className="trek-input" maxLength={80} placeholder={t('Folder name', '文件夹名称')}
          value={newFolderName} onChange={(event) => {
            const value = event.target.value; setNewFolderName(value);
            if (!newFolderIconTouched) { const icon = firstGrapheme(value.trim()); setNewFolderIcon(icon.length <= 8 ? icon : ''); }
          }} />
      </div>
    </div>
    <button className="trek-btn trek-btn--secondary" disabled={!newFolderName.trim()}>{t('Create folder', '创建文件夹')}</button>
  </form>;
  const sortMenu = <div ref={sortRoot} className="fn-sort">
    <button ref={sortButton} type="button" className="trek-btn trek-btn--ghost fn-icon-button fn-sort-button" aria-haspopup="menu"
      aria-expanded={sortOpen} aria-label={t('Sort', '排序')}
      title={`${t('Sort by', '排序方式')}: ${sortOptions.find(([key]) => key === sorting.key)?.[1]}`}
      onClick={() => setSortOpen(!sortOpen)}><Icon name="sort" /></button>
    {sortOpen && <div className="fn-folder-menu fn-sort-menu" role="menu" aria-label={t('Sort by', '排序方式')}
      onKeyDown={(event) => moveInMenu(event, event.currentTarget)}>
      {sortOptions.map(([key, label]) => <button key={key} type="button" role="menuitemradio" aria-checked={sorting.key === key}
        onClick={() => void run(() => changeSorting(key), { silent: true })}><Icon name="check" />{label}</button>)}
      <div className="fn-menu-separator" role="separator" />
      {orderOptions.map(([order, label]) => <button key={order} type="button" role="menuitemradio" aria-checked={sorting.order === order}
        onClick={() => void run(() => changeSorting(sorting.key, order), { silent: true })}><Icon name="check" />{label}</button>)}
    </div>}
  </div>;
  const previewListed = previewId ? notes.find((item) => item.id === previewId) : undefined;
  const previewed = previewListed && previewRead?.id === previewListed.id ? { ...previewListed, ...previewRead } : previewListed;
  // How a trip holds a note: following the original, or as its own copy.
  const noteMode = (mode: 'live' | 'snapshot') => <span className={`trek-chip fn-note-mode fn-note-mode--${mode}`}>
    {mode === 'live' ? t('Live reference', '实时引用') : t('Snapshot', '快照')}</span>;
  const dayLabel = (dayId: number) => {
    const day = days.find((item) => item.id === dayId);
    return day?.day_number ? t('Day {number}', '第 {number} 天', { number: day.day_number }) : day?.date || t('Day', '日程');
  };
  const openFolder = selectedFolderId ? finder.folder(selectedFolderId) : undefined;
  // The folder or note an open Finder menu acts on; a column's own menu has none.
  const menuSubject = finderMenu?.target.kind === 'folder' ? { id: finderMenu.target.folder.id, label: finderMenu.target.folder.name }
    : finderMenu?.target.kind === 'note' ? { id: finderMenu.target.note.id, label: finderMenu.target.note.title } : null;
  // Recently deleted shows while it holds a note, or while it is open: in each library, and on a trip for its editors.
  const binShown = (!tripId || canEditTrip) && (deletedNotes.length > 0 || binOpen);
  // The top of the notes has one name wherever it shows; leaving a note returns to the trip, or to the library it came from.
  const rootLabel = publicMode ? t('Public library', '公开图书馆') : t('All notes', '全部笔记');
  const backLabel = tripId ? tripTitle || rootLabel : publicMode ? rootLabel : t('Library', '图书馆');
  const today = t('Today', '今天');
  const deletedShown = deletedRead && deletedRead.id === previewId ? deletedRead : null;
  const deletedDates = { date: shortDate(deletedShown?.deleted_at, context?.locale, today),
    end: shortDate(deletedShown?.purge_at, context?.locale, today) };
  const deletedPreview = deletedShown ? <article className="fn-preview" aria-label={t('Preview', '预览')}>
    {deletedShown.icon && <NoteIcon icon={deletedShown.icon} className="fn-note-icon--large" />}
    <h2>{deletedShown.title}</h2>
    {deletedShown.mode && noteMode(deletedShown.mode)}
    <p className="fn-preview-meta trek-muted">{tripId
      ? t('Removed {date}. Deleted permanently on {end}.', '移除于 {date}，将于 {end} 永久删除。', deletedDates)
      : t('Deleted {date}. Deleted permanently on {end}.', '删除于 {date}，将于 {end} 永久删除。', deletedDates)}</p>
    <div className="fn-preview-actions">
      <button type="button" className="trek-btn trek-btn--primary" disabled={busy}
        onClick={() => void run(() => recoverNote(deletedShown))}><Icon name="reopen" />{t('Recover', '恢复')}</button>
      <button type="button" className="trek-btn trek-btn--danger" disabled={busy}
        onClick={() => void run(() => deletePermanently(deletedShown))}><Icon name="trash" />{t('Delete permanently', '永久删除')}</button>
    </div>
    {deletedShown.properties?.length ? <PropertyList properties={deletedShown.properties} updatedAt={deletedShown.updated_at}
      locale={context?.locale} t={t} onOpenUrl={(url) => openHref(url, follow)} /> : null}
    <div className="fn-preview-body">
      <Markdown content={deletedShown.content} imageSources={{}} references={{}} linkText={linkText} onReference={() => {}} />
    </div>
  </article> : <div className="fn-preview fn-preview-empty"><p className="trek-muted">{tripId
    ? t('Notes removed from this trip stay here for 30 days, then are deleted permanently.', '从这次旅行移除的笔记会在这里保留 30 天，之后永久删除。')
    : t('Deleted notes stay here for 30 days, then are deleted permanently.', '删除的笔记会在这里保留 30 天，之后永久删除。')}</p></div>;
  const finderToolbar = <div className="fn-finder-toolbar">
    <nav className="fn-finder-path" aria-label={t('Location', '位置')}>
      <button type="button" className="fn-finder-crumb"
        aria-current={!finderPath.length && results === null && !binOpen ? 'location' : undefined}
        onClick={() => void run(async () => { if (results !== null) await clearSearch(); await selectFolder(null); }, { silent: true })}>
        <Icon name="library" />{rootLabel}</button>
      {binOpen && results === null ? <><Icon name="chevron-right" />
        <span className="fn-finder-crumb" aria-current="location">{t('Recently deleted', '最近删除')}</span></>
      : results === null ? finderPath.map((folderId, position) => <React.Fragment key={folderId}>
        <Icon name="chevron-right" />
        <button type="button" className="fn-finder-crumb" aria-current={position === finderPath.length - 1 ? 'location' : undefined}
          onClick={() => void run(() => selectFolder(folderId), { silent: true })}>{finder.folder(folderId)?.name}</button>
      </React.Fragment>) : <><Icon name="chevron-right" />
        <span className="fn-finder-crumb" aria-current="location">
          {t('Results for “{query}”', '“{query}”的搜索结果', { query: results })}</span></>}
    </nav>
    <form className="fn-search fn-finder-search" onSubmit={(event) => { event.preventDefault(); void run(async () => {
      setPreviewId(null); setBinOpen(false); await load(); }); }}>
      <Icon name="search" />
      <input id="search" className="trek-input" maxLength={120} placeholder={t('Search all notes', '搜索全部笔记')}
        aria-label={t('Search title, text or properties', '搜索标题、正文或属性')} value={query} onChange={(event) => setQuery(event.target.value)} />
      {(query || results !== null) && <IconButton label={t('Clear search', '清除搜索')} icon="close" className="fn-search-clear"
        onClick={() => void run(async () => { setPreviewId(null); await clearSearch(); }, { silent: true })} />}
    </form>
    {/* Recently deleted has nothing to sort or create; its notes are recovered or deleted from their own menu. */}
    {!binOpen && sortMenu}
    <IconButton label={t('Refresh', '刷新')} icon="refresh" className="fn-refresh" disabled={busy}
      onClick={() => void run(async () => { await loadFolders(); await load(); })} />
    {!binOpen && (!tripId || canEditTrip) && <div className="fn-new-folder">
      <IconButton label={t('New folder', '新建文件夹')} icon="folder-plus" aria-expanded={newFolderOpen} onClick={toggleNewFolder} />
      {newFolderOpen && <div className="fn-new-folder-popover">{newFolderForm}</div>}
    </div>}
    {/* A new note lands in the open folder when you may write there, otherwise at the top of the library. */}
    {!tripId && !binOpen && <IconButton label={t('New note', '新建笔记')} icon="note-plus" className="fn-new-note"
      disabled={busy} onClick={() => void run(() => startNote(openFolder?.role === 'editor' ? openFolder.id : null))} />}
    {/* A trip's note is written in the library, which keeps its original, and comes back here linked to the open folder. */}
    {tripId && canEditTrip && !binOpen && <IconButton label={t('New note for this trip', '为这次旅行新建笔记')} icon="note-plus"
      className="fn-new-note" disabled={busy} onClick={() => createForCurrentTrip(openFolder?.id ?? null)} />}
    {tripId && <IconButton label={t('Open Fieldnotes library', '打开 Fieldnotes 图书馆')} icon="open"
      onClick={() => trek.navigate('/plugins/fieldnotes')} />}
  </div>;
  const finderPreview = previewed?.unavailable ? <div className="fn-preview">
    <h2>{unavailableTitle}</h2><p className="fn-preview-meta trek-muted">{unavailableHint}</p>
  </div> : previewed ? <article className="fn-preview" aria-label={t('Preview', '预览')}>
    {previewed.icon && <NoteIcon icon={previewed.icon} className="fn-note-icon--large" />}
    <h2>{previewed.title}</h2>
    {previewed.mode && noteMode(previewed.mode)}
    <p className="fn-preview-meta trek-muted">
      {previewed.day_id && <>{dayLabel(previewed.day_id)} · </>}
      {t('Modified', '修改')} {shortDate(previewed.updated_at, context?.locale, today)}
      {previewed.created_at && <> · {t('Created', '创建')} {shortDate(previewed.created_at, context?.locale, today)}</>}
    </p>
    {previewed.properties?.length ? <PropertyList properties={previewed.properties} updatedAt={previewed.updated_at}
      locale={context?.locale} t={t} onOpenUrl={(url) => openHref(url, follow)} /> : null}
    <div className="fn-preview-body">
      <Markdown content={previewed.content} imageSources={imageSources} references={referenceLinks} linkText={linkText}
        onReference={follow} />
    </div>
  </article> : openFolder ? <div className="fn-preview fn-preview-folder">
    <span className="fn-preview-folder-glyph" aria-hidden="true">{openFolder.icon || <Icon name="folder" />}</span>
    <h2>{openFolder.name}</h2>
    {!tripId && <p className="fn-preview-meta trek-muted">
      {openFolder.visibility === 'public' ? t('Public folder', '公有文件夹') : t('Private folder', '私有文件夹')}
      {' · '}{openFolder.can_manage ? t('Owner', '所有者') : openFolder.role === 'editor' ? t('Editor', '编辑者') : t('Viewer', '查看者')}</p>}
    {/* Access is read here and changed from the folder's context menu; a trip's folders are open to everyone on the trip. */}
    {!tripId && <section className="fn-preview-access" aria-labelledby="preview-access-title">
      <h3 id="preview-access-title">{t('People with access', '可访问成员')}</h3>
      <p className="trek-muted fn-preview-access-note">{openFolder.visibility === 'public' && !publicMode
        ? t('Its name shows in the public library; what it holds here stays private.', '它的名称会显示在公开图书馆，这里的内容仍然保持私人。')
        : openFolder.visibility === 'public'
        ? t('Every signed-in member can read it in the public library.', '所有已登录成员都能在公开图书馆里阅读。')
        : t('Only the owner and the people they invite can open it.', '只有所有者和受邀的成员可以打开。')}</p>
      {openFolder.can_manage && folderAccess?.folderId === openFolder.id && (folderAccess.people.length
        ? <ul className="fn-preview-people">{folderAccess.people.map((item) => <li key={item.user_id}>
          <Avatar name={personName({ ...item.user, id: item.user_id })} color={item.user.color} />
          <span>{personName({ ...item.user, id: item.user_id })}</span>
          <span className="trek-muted">{item.role === 'editor' ? t('Editor', '编辑者') : t('Viewer', '查看者')}</span>
        </li>)}</ul>
        : <p className="trek-muted">{t('No one else has access yet.', '还没有其他人可以访问。')}</p>)}
    </section>}
  </div> : <div className="fn-preview fn-preview-empty"><p className="trek-muted">
    {t('Select a note to preview it, and click it again to open.', '选择一篇笔记即可预览，再点一次打开。')}</p></div>;
  const libraryEmpty = <span>{!tripId ? t('Choose a folder or create a note to start building your travel library.',
    '选择一个文件夹，或新建一篇笔记，开始整理旅行知识。') : canEditTrip
    ? t('Create a note here or reuse one from your library.', '可以在这里新建笔记，也可以从图书馆复用已有笔记。')
    : t('No notes have been shared with this trip yet.', '这次旅行还没有共享笔记。')}</span>;
  const noteHeadings = note && !editing && !note.unavailable
    ? outlineOf(note.content).map((heading) => ({ ...heading, text: plainHeading(heading.text) })) : [];
  const jumpTo = (heading: string) => { if (noteArticle.current) revealHeading(noteArticle.current, heading); };
  const sideDocked = Boolean(tripId && note && !note.unavailable && !editing && wide);
  const historyButton = <IconButton label={t('Version history', '版本历史')} icon="history" variant="secondary" aria-haspopup="dialog"
    disabled={busy} onClick={() => {
      historyTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setHistoryOpen(true);
    }} />;
  const workspace = <section ref={workspaceRef} className="trek-card fn-workspace" aria-label={t('Note detail', '笔记详情')} tabIndex={-1}>
    <div className="fn-reader-bar">
      <IconButton label={drawers.tree ? t('Hide notes', '收起笔记列表') : t('Show notes', '展开笔记列表')} icon="sidebar"
        aria-pressed={drawers.tree} onClick={() => toggleDrawer('tree')} />
    </div>
    {note?.unavailable ? <>
      <h2>{unavailableTitle}</h2>
      <p>{unavailableHint}</p>
      {canEditTrip && <button type="button" className="trek-btn trek-btn--danger" disabled={busy}
        onClick={() => void run(() => removeFromTrip())}><Icon name="trash" />{t('Remove from trip', '从旅行移除')}</button>}
    </> : editing && note && !createTripId ? <CollabEditor noteId={note.id} locale={context?.locale}
      invoke={tripId ? tripInvoke : invoke} t={t} sessionRef={collab} onSaved={() => setStatus(t('All changes saved', '已自动保存'))}
      onTrouble={setCollabTrouble}
      connecting={<>
        {note.icon && <div className="fn-note-hero"><NoteIcon icon={note.icon} className="fn-note-icon--hero" /></div>}
        <div className="fn-detail-header"><h2>{note.title}</h2></div>
        <Markdown content={note.content} imageSources={imageSources} references={referenceLinks} linkText={linkText}
          onReference={() => {}} />
      </>}
      renderEditor={(session) => <>
        <MarkdownEditor key={session.doc.clientID} value={session.content.toString()}
          imageSources={imageSources} references={referenceLinks} links={noteLinks} linkText={linkText}
          onChange={(markdown) => {
            hydrateNewImages(note, markdown); hydrateNewReferences(markdown);
            setLinkGaps((current) => current.filter((gap) => markdown.includes(gap.target.id)));
          }}
          onReference={follow} onImageFiles={addImages} t={t}
          tripPdfs={tripId ? tripPdfs : undefined} onTripPdf={addTripPdf} tripObjects={tripObjects} onTrekObject={addTrekObject}
          collab={session.editorExtensions()} />
        {linkGaps.filter((gap) => !dismissedGaps.includes(gap.target.id)).map((gap) => <LinkGapNotice key={gap.target.id}
          gap={gap} locale={context?.locale} t={t} onShare={() => setGrantGap(gap)}
          onDismiss={() => setDismissedGaps((current) => [...current, gap.target.id])} />)}
      </>}
      onDone={() => run(async () => {
        setEditing(false);
        if (tripId) await openReference(note.id); else { await choose({ id: note.id } as Note); await load(); }
      }, { silent: true })} />
    : editing ? <form onSubmit={(event) => { event.preventDefault(); void run(save); }}>
      <fieldset disabled={busy} className="trek-stack fn-writer">
        {createTripId && <div className="fn-trip-create-context">
          <strong>{t('New note for this trip', '为这次旅行新建笔记')}</strong><span className="trek-muted">{createTripTitle}</span>
          <p className="trek-muted">{t('The private original stays in your library and is shared live with this trip.',
            '私人原文会保存在你的图书馆，并以实时引用绑定到这次旅行。')}</p>
        </div>}
        <IconPicker icon={draft.icon} onChange={(icon) => update('icon', icon)} t={t} />
        <label className="fn-visually-hidden" htmlFor="title">{t('Title', '标题')}</label>
        <input id="title" ref={titleInput} className="fn-title-input" value={draft.title} maxLength={maxTitleChars} required
          placeholder={t('Untitled', '无标题')} onChange={(event) => update('title', event.target.value)} />
        <PropertySection properties={draft.properties} onChange={(value) => update('properties', value)} t={t} />
        <label id="content-label" className="fn-visually-hidden" htmlFor="content-editor">Markdown</label>
        <MarkdownEditor value={draft.content} imageSources={imageSources} references={referenceLinks} links={noteLinks}
          linkText={linkText} onChange={(value) => { update('content', value); hydrateNewReferences(value); }}
          onReference={follow} onImageFiles={addImages} t={t} />
        <WritingStats markdown={draft.content} locale={context?.locale} t={t} />
        <textarea id="content" className="fn-editor-source" maxLength={maxContentChars} aria-hidden="true" tabIndex={-1}
          value={draft.content} onChange={(event) => update('content', event.target.value)} />
        <div className="trek-cluster">
          <button className="trek-btn trek-btn--primary">
            {createTripId ? t('Save and add to trip', '保存并添加到旅行') : t('Save note', '保存笔记')}</button>
          <button type="button" className="trek-btn trek-btn--ghost" onClick={() => void run(cancelEditing)}>{t('Cancel', '取消')}</button>
        </div>
      </fieldset>
    </form> : note && <>
      {note.icon && <div className="fn-note-hero"><NoteIcon icon={note.icon} className="fn-note-icon--hero" /></div>}
      <div className="fn-detail-header">
        <h2>{note.title}</h2>
        <div className="fn-note-actions">
          <Outline headings={noteHeadings} onJump={jumpTo} t={t}
            docked={sideDocked ? { open: outlineOpen, onToggle: toggleOutline } : undefined} />
          {tripId && <IconButton label={t('Comments', '评论')} icon="comment" variant="secondary" className="fn-comment-toggle"
            aria-pressed={commentsOpen} onClick={() => toggleComments(!commentsOpen)}>
            {openThreads > 0 && <span className="fn-badge" aria-hidden="true">{openThreads}</span>}
          </IconButton>}
          {tripId && canEditTrip && note.mode === 'live' && note.can_snapshot && <IconButton label={t('Convert to snapshot', '转为快照')}
            icon="snapshot" variant="secondary" disabled={busy} onClick={() => void run(() => convertToSnapshot())} />}
          {tripId && canEditTrip && note.mode === 'snapshot' && <IconButton label={t('Edit snapshot', '编辑快照')} icon="edit"
            variant="secondary" disabled={busy} onClick={() => startEditing(note)} />}
          {tripId && canEditTrip && note.mode === 'snapshot' && historyButton}
          {!tripId && note.can_edit && <IconButton label={t('Edit', '编辑')} icon="edit" variant="secondary"
            disabled={busy} onClick={() => startEditing(note)} />}
          {!tripId && <IconButton label={t('Sharing', '共享')} icon="share" variant="secondary" className="fn-reader-share"
            aria-haspopup="dialog" disabled={busy} onClick={openShare} />}
          {!tripId && note.can_edit && historyButton}
          {!tripId && owns(note) && <IconButton label={t('Delete note', '删除笔记')} icon="trash" variant="danger"
            disabled={busy} onClick={() => void run(() => deleteNote(note))} />}
          {tripId && canEditTrip && <IconButton label={t('Remove from trip', '从旅行移除')} icon="trash" variant="danger"
            disabled={busy} onClick={() => void run(() => removeFromTrip())} />}
        </div>
      </div>
      {note.mode && <div className="trek-cluster">{noteMode(note.mode)}</div>}
      {note.properties?.length ? <PropertyList properties={note.properties} updatedAt={note.updated_at} locale={context?.locale}
        t={t} onOpenUrl={(url) => openHref(url, follow)} /> : null}
      {tripId ? <div className="fn-annotated">
        <Markdown content={note.content} imageSources={imageSources} references={referenceLinks} linkText={linkText}
          onReference={follow} reveal={pendingHeading} articleRef={noteArticle} onRendered={() => setRenderedAt(Date.now())}
          onPoint={(x, y) => {
            const thread = threadAt(quoteRanges.current, x, y);
            if (thread) { setActiveThread(thread); setPendingQuote(null); toggleComments(true); }
          }} />
        <QuoteButton article={noteArticle} label={t('Comment', '评论')} onQuote={quote} />
      </div> : <Markdown content={note.content} imageSources={imageSources} references={referenceLinks} linkText={linkText}
        onReference={follow} reveal={pendingHeading} articleRef={noteArticle} />}
      {backlinks.length + mentions.length > 0 && <Backlinks items={backlinks} mentions={mentions} busy={busy}
        unavailable={linkText.unavailable} onOpen={follow} onLink={(item) => void run(() => linkMentions(item))} t={t} />}
    </>}
  </section>;

  return <main className="fn-shell" data-view={note || editing ? undefined : 'library'}>
    <header className="fn-header">
      <div className="fn-heading">
        <span className="fn-symbol" aria-hidden="true"><i /><i /><i /></span>
        <div className="fn-heading-copy">
          <p className="fn-eyebrow trek-muted">{tripId
            ? tripTitle || <span className="trek-skeleton fn-eyebrow-skeleton" aria-hidden="true" />
            : t('YOUR TRAVEL KNOWLEDGE', '你的旅行知识库')}</p>
          <h1>{tripId ? t('Trip Fieldnotes', 'Trip Fieldnotes') : 'Fieldnotes'}</h1>
          <p className="trek-muted">{tripId ? t('Shared knowledge for this trip.', '为这次旅行整理的共享知识。')
            : t('Write once. Keep it ready for every trip.', '把走过的路，写成下一次出发的底气。')}</p>
        </div>
      </div>
    </header>
    {error && <div className="fn-error" role="alert">{error}</div>}
    {!tripId && !note && !editing && <div className="fn-scope-switcher" role="tablist" aria-label={t('Library scope', '图书馆范围')}
      data-scope={publicMode ? 'public' : 'private'}>
      <span className="fn-scope-indicator" aria-hidden="true" />
      <button type="button" role="tab" aria-selected={!publicMode} className={`fn-scope-tab${dragClass('library-private')}`}
        disabled={busy} {...libraryDropProps('private')}
        onClick={() => void run(() => switchLibrary(false))}>{t('Private library', '私人图书馆')}</button>
      <button type="button" role="tab" aria-selected={publicMode} className={`fn-scope-tab${dragClass('library-public')}`}
        disabled={busy} {...libraryDropProps('public')}
        onClick={() => void run(() => switchLibrary(true))}>{t('Public library', '公开图书馆')}</button>
    </div>}
    {note || editing ? <div className="fn-layout fn-layout-reader" data-tree={drawers.tree || undefined}
      data-side={(sideDocked && (commentsOpen || (outlineOpen && noteHeadings.length >= 2))) || undefined} aria-busy={busy}>
        <div className="fn-reader-column">
          <button type="button" className="trek-btn trek-btn--ghost fn-reader-back" onClick={() => void run(backToLibrary)}>
            <Icon name="chevron-left" />{backLabel}</button>
          {workspace}
        </div>
        {/* Mirrors the trip page's comment panel: it stays mounted so it can animate, and `inert` keeps it out of reach closed. */}
        <aside className="fn-note-browser" aria-label={rootLabel} data-open={drawers.tree || undefined} inert={!drawers.tree}>
          <FinderMini index={finder} currentId={note?.id || null} currentFolder={note ? finder.parentOf(note) : selectedFolderId}
            rootLabel={rootLabel} onOpen={(item) => void run(async () => {
              if (narrowScreen() && drawers.tree) toggleDrawer('tree');
              await choose(item);
            })} t={t} />
        </aside>
        <div className="fn-note-browser-scrim" data-open={drawers.tree || undefined} aria-hidden="true"
          onClick={() => toggleDrawer('tree')} />
        {/* Beside a trip note, the outline sits above the comments and pushes them down as it unfolds. */}
        {tripId && note && !note.unavailable && !editing && <div className="fn-side-panels">
          {wide && <OutlinePanel headings={noteHeadings} open={outlineOpen} onJump={jumpTo} onClose={() => setOutlineOpen(false)} t={t} />}
          <CommentPanel open={commentsOpen} threads={threads} located={locatedThreads}
            pending={pendingQuote} activeId={activeThread} userId={Number(context?.userId)} canModerate={canEditTrip} busy={busy}
            locale={context?.locale} actions={commentActions} t={t}
            onActivate={(threadId) => {
              setActiveThread(threadId);
              quoteRanges.current.get(threadId)?.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }}
            onDropQuote={() => setPendingQuote(null)} onClose={closeComments} />
        </div>}
        {tripId && <div className="fn-comment-scrim" data-open={(note && !editing && commentsOpen) || undefined} aria-hidden="true"
          onClick={closeComments} />}
      </div>
      : <section className="trek-card fn-finder-card" data-motion={contentMotion} aria-busy={busy} aria-label={rootLabel}>
        {finderToolbar}
        {!ready ? <ul className="fn-note-list fn-note-skeleton" aria-hidden="true">
          {[0, 1, 2, 3].map((index) => <li key={index}><span className="trek-skeleton" /><span className="trek-skeleton" /></li>)}
        </ul> : <FinderColumns key={publicMode ? 'public' : 'private'} index={finder} path={finderPath} previewId={previewId}
          results={results === null ? null : notes} query={results ?? undefined} preview={binOpen ? deletedPreview : finderPreview}
          rootLabel={rootLabel}
          empty={libraryEmpty} bin={binShown ? { label: t('Recently deleted', '最近删除'), open: binOpen,
            onOpen: () => void run(openBin, { silent: true }),
            column: <DeletedColumn notes={deletedNotes} position={1} selectedId={previewId} menuId={deletedMenu?.note.id ?? null}
              onSelect={(item) => void run(() => previewDeleted(item), { silent: true })}
              onMenu={(item, at) => setDeletedMenu({ note: item, at })} t={t} /> } : null}
          decor={{ dropProps, dragClass,
            folderDrag: (folder) => ({ draggable: canMoveFolder(folder), onDragStart: (event) => dragFolderStart(folder, event),
              onDragEnd: endDrag }),
            noteDrag: (item) => ({ draggable: tripId ? canEditTrip : owns(item as Note),
              onDragStart: (event) => dragNoteStart(item as Note, event), onDragEnd: endDrag }) }}
          onFolder={(folderId) => void run(() => selectFolder(folderId), { silent: true })}
          onPreview={(item) => void run(() => previewNote(item), { silent: true })}
          menuId={menuSubject?.id ?? null}
          onOpen={(item) => void run(() => choose(item))} onMenu={(target, at) => setFinderMenu({ target, at })} t={t} />}
        {deletedMenu && <ContextMenu at={deletedMenu.at} label={deletedMenu.note.title} onClose={() => setDeletedMenu(null)}
          items={[{ label: t('Recover', '恢复'), icon: 'reopen', onSelect: () => void run(() => recoverNote(deletedMenu.note)) },
            'separator', { label: t('Delete permanently', '永久删除'), icon: 'trash', danger: true,
              onSelect: () => void run(() => deletePermanently(deletedMenu.note)) }]} />}
        {finderMenu && <ContextMenu at={finderMenu.at} items={finderMenuItems(finderMenu.target)} onClose={() => setFinderMenu(null)}
          label={menuSubject?.label ?? rootLabel} />}
      </section>}
    <Presence>{permissionFolder && <Modal dialog={permissionModal} titleId="folder-permission-title"
      eyebrow={t('Folder permissions', '文件夹权限')}
      title={permissionFolder.name} t={t} onClose={() => void closeFolderPermissions()}>
      <div className="fn-modal-folder-settings">
        <FolderSettings folder={permissionFolder} idPrefix="modal-folder" t={t} {...folderSettingsActions(permissionFolder)} />
      </div>
      <section className="fn-modal-section" aria-labelledby="folder-members-title">
        <div className="fn-modal-section-heading">
          <h3 id="folder-members-title">{t('People with access', '可访问成员')}</h3>
          <p className="trek-muted">{t('Choose who can see this folder.', '选择可以查看此文件夹的成员。')}</p>
        </div>
        {folderMemberEditor()}
      </section>
    </Modal>}</Presence>
    <Presence>{historyOpen && note && (tripId ? note.mode === 'snapshot' : note.can_edit) && <Modal dialog={historyDialog}
      titleId="history-title" eyebrow={t('Version history', '版本历史')} title={note.title} className="fn-history-modal" t={t}
      onClose={() => setHistoryOpen(false)}>
      <HistoryView noteId={note.id} current={note} invoke={tripId ? tripInvoke : invoke} locale={context?.locale} t={t} busy={busy}
        onRestore={(version) => void run(() => restoreVersion(version))}
        render={(content, versionId) => <VersionText key={versionId || 'current'} content={content} linkText={linkText}
          load={(text) => versionAssets(text, versionId)} />} />
    </Modal>}</Presence>
    <Presence>{shareOpen && note && !tripId && <Modal dialog={shareDialog} titleId="share-title" eyebrow={t('Sharing', '共享')}
      title={note.title} className="fn-share-modal" t={t} onClose={() => void run(closeShare, { silent: true })}>
      {owns(note) && <section className="fn-modal-section fn-visibility" aria-labelledby="visibility-heading">
        <div className="fn-modal-section-heading"><h3 id="visibility-heading">{t('Visibility', '可见范围')}</h3></div>
        <NativeSelect id="visibility" value={note.visibility || 'private'} aria-describedby="visibility-hint"
          onChange={(event) => void run(() => changeVisibility(event.target.value as 'private' | 'public'))}>
          <option value="private">{t('Private note', '私人笔记')}</option>
          <option value="public">{t('Public note', '公开笔记')}</option>
        </NativeSelect>
        <p id="visibility-hint" className="fn-field-hint">{note.visibility === 'public'
          ? t('Every signed-in member can read it in the public library.', '所有已登录成员都能在公开图书馆里阅读。')
          : t('Only you, collaborators and trips you share it with.', '仅你自己、协作者和你共享到的旅行可见。')}</p>
      </section>}
      {owns(note) && <section className="fn-modal-section fn-collaborators" aria-labelledby="collaborators-heading">
        <div className="fn-modal-section-heading">
          <h3 id="collaborators-heading">{t('Collaborators', '协作者')}</h3>
          <p className="trek-muted">{t('Who can open or edit this note', '可以查看或编辑这篇笔记的成员')}</p>
        </div>
        <CollaboratorEditor state={noteMembers} busy={busy} t={t} onSave={() => void run(saveRoleChanges)} />
      </section>}
      {linkedTrips.length > 0 && <section className="fn-modal-section fn-linked-trips"
        aria-labelledby="linked-trips-heading">
        <div className="fn-modal-section-heading"><h3 id="linked-trips-heading">{t('In trips', '已加入旅行')}</h3></div>
        <ul className="fn-linked-trip-list">{linkedTrips.map((trip) => <li key={trip.id}>
          <button type="button" className="fn-linked-trip-open" title={t('Open in Trip Fieldnotes', '在 Trip Fieldnotes 中打开')}
            onClick={() => void run(() => openLinkedTrip(trip))}><span>{trip.title}</span>
            {trip.mode && noteMode(trip.mode)}<Icon name="chevron-right" /></button>
          {/* A snapshot is the trip's own copy; only the trip's page removes it. */}
          {trip.mode !== 'snapshot' && <button type="button" className="trek-btn trek-btn--ghost"
            aria-label={t('Remove from {trip}', '从{trip}移除', { trip: trip.title })}
            title={t('Remove from {trip}', '从{trip}移除', { trip: trip.title })}
            onClick={() => void run(() => removeLinkedTrip(trip))}><Icon name="trash" /></button>}
        </li>)}</ul>
      </section>}
      <section className="fn-modal-section fn-trip-actions" aria-labelledby="bring-trip-heading">
        <div className="fn-modal-section-heading">
          <h3 id="bring-trip-heading">{t('Bring into a trip', '带入旅行')}</h3>
          <p className="trek-muted">{t('Trip members read it in the trip’s Trip Fieldnotes tab, which needs Trip Fieldnotes installed.',
            '旅行成员在旅行的 Trip Fieldnotes 标签页阅读，需要安装 Trip Fieldnotes。')}</p>
        </div>
        <fieldset disabled={busy} className="trek-stack fn-action-form">
          <label className="trek-label" htmlFor="trip">{t('Trip', '旅行')}</label>
          <NativeSelect id="trip" value={target} onChange={(event) => void run(() => setDestination(event.target.value))}>
            <option value="">{t('Choose a trip', '选择旅行')}</option>
            {trips.map((trip) => <option key={trip.id} value={trip.id}>{trip.title}</option>)}
          </NativeSelect>
          <label className="trek-label" htmlFor="day">{t('Day (optional)', '日程（可选）')}</label>
          <DaySelect days={days} value={dayId} setValue={setDayId} emptyLabel={t('Whole trip', '整趟旅行')} t={t} />
          <label className="trek-label" htmlFor="mode">{t('Sharing mode', '共享方式')}</label>
          <NativeSelect id="mode" value={linkMode} aria-describedby="mode-hint" onChange={(event) => setMode(event.target.value)}>
            {canShareLive && <option value="live">{t('Live reference', '实时引用')}</option>}
            <option value="snapshot">{t('Snapshot', '快照')}</option>
          </NativeSelect>
          <p id="mode-hint" className="fn-field-hint">{linkMode === 'live'
            ? t('Follows the author’s later edits.', '跟随原文的后续修改。')
            : t('Keeps this version as the trip’s own copy.', '保留当前版本，作为这次旅行自己的副本。')}</p>
          <button className="trek-btn trek-btn--primary" disabled={!target} onClick={() => void run(link)}>
            {t('Add to trip', '添加到旅行')}
          </button>
        </fieldset>
      </section>
    </Modal>}</Presence>
    <Presence>{grantGap && <LinkGrantDialog gap={grantGap} dialog={grantDialog} busy={busy} t={t}
      onCancel={() => setGrantGap(null)}
      onGrant={(userIds, tripIds) => void run(() => grantLinkAccess(grantGap, userIds, tripIds))} />}</Presence>
    <input ref={importFiles} type="file" accept=".md,.markdown,.zip" multiple hidden onChange={importPicked} />
    <input ref={importFolder} type="file" multiple hidden {...{ webkitdirectory: '' }} onChange={importPicked} />
    {palette !== null && <Palette start={palette} findNotes={findNotes} commands={paletteCommands()} t={t}
      headings={noteHeadings} onNote={(item) => follow(item.id)} onClose={() => setPalette(null)}
      onHeading={jumpTo} />}
    <Presence>{confirmRequest && <ConfirmDialog request={confirmRequest} t={t} onAnswer={answerConfirm} />}</Presence>
    {/* Waiting on an answer is not work, so "Working…" waits for the question to close. */}
    <FloatingNotice message={notice} working={slow && !confirmRequest ? t('Working…', '处理中…') : ''} trouble={collabTrouble} />
  </main>;
}

// Modal focus: the first control on open, Tab kept inside, Escape to close, and focus handed back to `restore` afterwards.
// `open` is the dialog's subject; the effect reruns when it changes.
function useDialogFocus(dialog: React.RefObject<HTMLElement | null>, open: unknown, onEscape: () => void,
  restore?: React.RefObject<HTMLElement | null>) {
  const escape = useRef(onEscape); escape.current = onEscape;
  useEffect(() => {
    if (!open) return;
    const focusFirst = window.setTimeout(() => dialog.current?.querySelector<HTMLElement>('button, input, select')?.focus(), 0);
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); escape.current(); return; }
      if (event.key !== 'Tab' || !dialog.current) return;
      const focusable = Array.from(dialog.current.querySelectorAll<HTMLElement>('button, input, select'))
        .filter((item) => !item.hasAttribute('disabled'));
      if (!focusable.length) return;
      const next = focusable.indexOf(document.activeElement as HTMLElement) + (event.shiftKey ? -1 : 1);
      if (next < 0 || next >= focusable.length) {
        event.preventDefault(); focusable[(next + focusable.length) % focusable.length].focus();
      }
    };
    window.addEventListener('keydown', close);
    return () => { window.clearTimeout(focusFirst); window.removeEventListener('keydown', close); restore?.current?.focus(); };
  }, [open]);
}

const listOf = (items: string[], locale?: string) => new Intl.ListFormat(locale, { type: 'conjunction' }).format(items);

// Under the editor: who would find a link dead, and the one thing that can fix it, if the editor may do it.
function LinkGapNotice({ gap, locale, t, onShare, onDismiss }: {
  gap: LinkGap; locale?: string; t: Translate; onShare: () => void; onDismiss: () => void
}) {
  const target = gap.target.title;
  const grantable = gap.people.filter((person) => person.grantable);
  const others = gap.people.filter((person) => !person.grantable);
  return <section className="fn-link-gap" role="status">
    <div className="fn-link-gap-body">
      <strong>{t('Not everyone who reads this note can open “{target}”', '并非所有能读这篇笔记的人都能打开“{target}”', { target })}</strong>
      {gap.public && <p>{t('This note is public; “{target}” is not.', '这篇笔记是公开的，“{target}”不是。', { target })}</p>}
      {gap.people.length > 0 && <p>{t('Readers: {names}', '读者：{names}',
        { names: listOf(gap.people.map((person) => personName(person.user)), locale) })}</p>}
      {gap.trips.length > 0 && <p>{t('Trips: {names}', '旅行：{names}', { names: listOf(gap.trips.map((trip) => trip.title), locale) })}</p>}
      {gap.hidden_trips > 0 && <p>{t('Other trips: {count}', '其他旅行：{count}', { count: gap.hidden_trips })}</p>}
      {!gap.can_share && <p className="trek-muted">{t('Only the owner of “{target}” can share it.', '只有“{target}”的所有者可以共享它。',
        { target })}</p>}
      {gap.can_share && others.length > 0 && <p className="trek-muted">{t(
        'Only trip companions can be added here, so these readers need another way in: {names}',
        '这里只能添加旅行同伴，以下读者需要通过其他方式共享：{names}', { names: listOf(others.map((person) => personName(person.user)), locale) })}</p>}
      {gap.can_share && (grantable.length > 0 || gap.trips.length > 0) && <div className="trek-cluster">
        <button type="button" className="trek-btn trek-btn--secondary" onClick={onShare}>{t('Let them view…', '让他们也能查看…')}</button>
      </div>}
    </div>
    <button type="button" className="fn-modal-close fn-link-gap-close" aria-label={t('Close', '关闭')} title={t('Close', '关闭')}
      onClick={onDismiss}><Icon name="close" /></button>
  </section>;
}

// Lets the linked note's owner share it with the readers the link would fail, as viewers and as live references in trips,
// every change listed and ticked before anything is shared.
function LinkGrantDialog({ gap, dialog, busy, t, onCancel, onGrant }: {
  gap: LinkGap; dialog: React.RefObject<HTMLElement | null>; busy: boolean; t: Translate;
  onCancel: () => void; onGrant: (userIds: number[], tripIds: number[]) => void
}) {
  const people = gap.people.filter((person) => person.grantable);
  const [users, setUsers] = useState(() => people.map((person) => Number(person.user.id)));
  const [trips, setTrips] = useState(() => gap.trips.map((trip) => trip.id));
  const toggle = (list: number[], value: number) => list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  const target = gap.target.title;
  return <Modal dialog={dialog} titleId="link-grant-title" title={t('Let them view “{target}”', '让他们也能查看“{target}”', { target })}
    t={t} onClose={onCancel}>
    {people.length > 0 && <section className="fn-modal-section fn-grant-section" aria-labelledby="link-grant-people">
      <h3 id="link-grant-people">{t('Readers', '读者')}</h3>
      <ul className="fn-grant-list">{people.map((person) => <li key={person.user.id}><label className="fn-grant-option">
        <input type="checkbox" checked={users.includes(Number(person.user.id))}
          onChange={() => setUsers((current) => toggle(current, Number(person.user.id)))} />
        <span>{personName(person.user)}</span><span className="trek-muted">{t('Becomes a viewer', '设为查看者')}</span>
      </label></li>)}</ul>
    </section>}
    {gap.trips.length > 0 && <section className="fn-modal-section fn-grant-section" aria-labelledby="link-grant-trips">
      <h3 id="link-grant-trips">{t('Trips', '旅行')}</h3>
      <ul className="fn-grant-list">{gap.trips.map((trip) => <li key={trip.id}><label className="fn-grant-option">
        <input type="checkbox" checked={trips.includes(trip.id)} onChange={() => setTrips((current) => toggle(current, trip.id))} />
        <span>{trip.title}</span><span className="trek-muted">{t('Added as a live reference', '以实时引用加入')}</span>
      </label></li>)}</ul>
    </section>}
    <p className="fn-grant-warning">{t(
      'They will see all of “{target}” and every later edit. You can undo this anytime under Collaborators and In trips.',
      '他们将能看到“{target}”的全部内容和之后的所有修改。你随时可以在“协作者”和“已加入旅行”中撤销。', { target })}</p>
    <div className="trek-cluster fn-grant-actions">
      <button type="button" className="trek-btn trek-btn--ghost" onClick={onCancel}>{t('Cancel', '取消')}</button>
      <button type="button" className="trek-btn trek-btn--primary" disabled={busy || (!users.length && !trips.length)}
        onClick={() => onGrant(users, trips)}>{t('Grant access', '授予权限')}</button>
    </div>
  </Modal>;
}

// An icon-only button: its one label is both what a screen reader hears and the tooltip.
function IconButton({ label, icon, variant = 'ghost', className, children, ...rest }: {
  label: string; icon: IconName; variant?: 'ghost' | 'secondary' | 'danger'; className?: string; children?: React.ReactNode;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'aria-label' | 'className' | 'type'>) {
  return <button type="button" className={`trek-btn trek-btn--${variant} fn-icon-button${className ? ` ${className}` : ''}`}
    aria-label={label} title={label} {...rest}><Icon name={icon} />{children}</button>;
}

// Keeps a closed window on screen just long enough to animate out. The wrapper never changes, so the window inside is not
// remounted when it starts leaving, and the leaving copy is inert.
function Presence({ children }: { children: React.ReactNode }) {
  const last = useRef<React.ReactNode>(null);
  const [, settle] = useState(0);
  if (children) last.current = children;
  useEffect(() => {
    if (children || !last.current) return;
    const timer = window.setTimeout(() => { last.current = null; settle((count) => count + 1); }, 160);
    return () => window.clearTimeout(timer);
  }, [Boolean(children)]);
  return <div className="fn-presence" data-leaving={!children && last.current ? true : undefined} inert={!children}>
    {children || last.current}</div>;
}

// Asks before acting, in the plugin's own window rather than the browser's, above any window already open. Escape or a press
// outside cancels; a dangerous action starts on Cancel, so Enter alone never deletes. Keys stop here while it is open, so the
// window beneath does not take them too; once answered it leaves inert and lets them through.
function ConfirmDialog({ request, t, onAnswer }: { request: ConfirmRequest; t: Translate; onAnswer: (answer: boolean) => void }) {
  const dialog = useRef<HTMLElement>(null);
  const pressed = useRef(false);
  useEffect(() => {
    const buttons = () => Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    const focusFirst = window.setTimeout(() => buttons()[request.danger ? 0 : 1]?.focus(), 0);
    const keys = (event: KeyboardEvent) => {
      if (dialog.current?.closest('[inert]')) return;
      event.stopImmediatePropagation();
      if (event.key === 'Escape') { event.preventDefault(); onAnswer(false); return; }
      if (event.key !== 'Tab') return;
      event.preventDefault();
      const all = buttons(); const at = all.indexOf(document.activeElement as HTMLButtonElement);
      all[(at + (event.shiftKey ? -1 : 1) + all.length) % all.length]?.focus();
    };
    window.addEventListener('keydown', keys, true);
    return () => { window.clearTimeout(focusFirst); window.removeEventListener('keydown', keys, true); };
  }, [request]);
  return <div className="fn-modal-backdrop fn-confirm-backdrop" role="presentation"
    onMouseDown={(event) => { pressed.current = event.target === event.currentTarget; }}
    onClick={(event) => { if (pressed.current && event.target === event.currentTarget) onAnswer(false); pressed.current = false; }}>
    <section ref={dialog} className="fn-modal fn-confirm trek-card" role="alertdialog" aria-modal="true"
      aria-labelledby="fn-confirm-title" aria-describedby="fn-confirm-message">
      <h2 id="fn-confirm-title">{request.title}</h2>
      <p id="fn-confirm-message" className="fn-confirm-message">{request.message}</p>
      <div className="fn-confirm-actions">
        <button type="button" className="trek-btn trek-btn--secondary" onClick={() => onAnswer(false)}>{t('Cancel', '取消')}</button>
        <button type="button" className={`trek-btn ${request.danger ? 'trek-btn--danger' : 'trek-btn--primary'}`}
          onClick={() => onAnswer(true)}>{request.confirmLabel}</button>
      </div>
    </section>
  </div>;
}

// A window over the page: the header stays put and the body scrolls inside the rounded card. A press on the backdrop closes it.
function Modal({ dialog, titleId, eyebrow, title, className, t, onClose, children }: {
  dialog: React.RefObject<HTMLElement | null>; titleId: string; eyebrow?: string; title: string; className?: string; t: Translate;
  onClose: () => void; children: React.ReactNode;
}) {
  // Closing waits for the click, so the leaving window's backdrop is gone only after it has taken the whole press; it must also
  // start on the backdrop, so a text selection dragged out of the window does not close it.
  const pressed = useRef(false);
  return <div className="fn-modal-backdrop" role="presentation"
    onMouseDown={(event) => { pressed.current = event.target === event.currentTarget; }}
    onClick={(event) => { if (pressed.current && event.target === event.currentTarget) onClose(); pressed.current = false; }}>
    <section ref={dialog as React.RefObject<HTMLElement>} className={`fn-modal trek-card${className ? ` ${className}` : ''}`} role="dialog"
      aria-modal="true" aria-labelledby={titleId}>
      <header className="fn-modal-header">
        <h2 id={titleId} className={eyebrow ? 'fn-folder-title' : undefined}>
          {eyebrow ? <><span className="fn-eyebrow trek-muted">{eyebrow}</span><span>{title}</span></> : title}
        </h2>
        <button type="button" className="fn-modal-close" aria-label={t('Close', '关闭')} title={t('Close', '关闭')} onClick={onClose}>
          <Icon name="close" /></button>
      </header>
      <div className="fn-modal-body">{children}</div>
    </section>
  </div>;
}

// Icon and visibility of one owned folder, in its permissions dialog.
function FolderSettings({ folder, idPrefix, t, onIconDraft, onIcon, onVisibility }: {
  folder: Folder; idPrefix: string; t: Translate;
  onIconDraft: (icon: string) => void; onIcon: (icon: string) => void; onVisibility: (visibility: string) => void;
}) {
  return <>
    <div className="fn-setting-field">
      <label className="trek-label" htmlFor={`${idPrefix}-icon`}>{t('Icon', '图标')}</label>
      <div className="fn-icon-field">
        <input id={`${idPrefix}-icon`} className="trek-input fn-emoji-input" maxLength={8} value={folder.icon || ''}
          aria-describedby={`${idPrefix}-icon-help`} onBlur={(event) => onIcon(event.target.value)}
          onChange={(event) => onIconDraft(event.target.value)} />
        <small id={`${idPrefix}-icon-help`} className="trek-muted">{t('Supports ≤8 characters and emoji', '支持≤8个字符和 emoji')}</small>
      </div>
    </div>
    <div className="fn-setting-field">
      <label className="trek-label" htmlFor={`${idPrefix}-visibility`}>{t('Visibility', '可见范围')}</label>
      <select id={`${idPrefix}-visibility`} className="trek-select" value={folder.visibility}
        aria-describedby={`${idPrefix}-visibility-hint`} onChange={(event) => onVisibility(event.target.value)}>
        <option value="private">{t('Private folder', '私有文件夹')}</option><option value="public">{t('Public folder', '公有文件夹')}</option>
      </select>
      <small id={`${idPrefix}-visibility-hint`} className="trek-muted">{t('Everything in it that you own moves to that library too.',
        '其中属于你的内容也会一起移到对应的图书馆。')}</small>
    </div>
  </>;
}

// A note link may carry `#heading`; HEADING_LINK points into the note the link sits in.
function openHref(href: string, onReference: (id: string, heading?: string) => void, onHeading?: (heading: string) => void) {
  const note = /^fieldnotes:\/\/note\/([0-9a-f-]{36})(?:#(.*))?$/i.exec(href);
  if (note) onReference(note[1], note[2] ? decodeURIComponent(note[2]) : '');
  else if (href.startsWith(HEADING_LINK)) onHeading?.(decodeURIComponent(href.slice(HEADING_LINK.length)));
  else if (/^https?:\/\//i.test(href)) trek.openExternal(new URL(href).href);
  else if (trekPath(href)) trek.navigate(trekPath(href)!);
}

function MarkdownEditor({ value, imageSources = {}, references = {}, links, linkText, onChange, onReference, onImageFiles, tripPdfs,
  onTripPdf, tripObjects, onTrekObject, t, collab }: {
  value: string; imageSources?: ImageSources; references?: ReferenceLinks; links?: NoteLinks; linkText?: LinkText;
  onChange: (value: string) => void; onReference: (id: string, heading?: string) => void;
  onImageFiles: (files: File[], insert: (markdown: string) => void) => void; tripPdfs?: TripPdf[];
  onTripPdf?: (pdf: TripPdf, insert: (markdown: string) => void) => void; tripObjects?: TrekObject[];
  onTrekObject?: (card: TrekObject) => void; t: Translate; collab?: Extension[];
}) {
  const host = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const editor = useRef<ReturnType<typeof createLiveEditor> | null>(null);
  const handlers = useRef({ onChange, onReference, onImageFiles, t, links, tripPdfs, onTripPdf, tripObjects, onTrekObject });
  handlers.current = { onChange, onReference, onImageFiles, t, links, tripPdfs, onTripPdf, tripObjects, onTrekObject };
  const insert = (markdown: string) => editor.current?.insertImage(markdown);
  const addFiles = (files: File[]) => handlers.current.onImageFiles(files, insert);
  useEffect(() => {
    editor.current = createLiveEditor(host.current!, value, { labelledBy: 'content-label', collab, onImageFiles: addFiles,
      onPickImage: (pdf) => {
        if (!picker.current) return;
        picker.current.accept = pdf ? 'application/pdf' : 'image/*'; picker.current.click();
      },
      tripPdfs: () => handlers.current.tripPdfs || [], onTripPdf: (pdf) => handlers.current.onTripPdf?.(pdf, insert),
      tripObjects: () => handlers.current.tripObjects || [], onTrekObject: (card) => handlers.current.onTrekObject?.(card),
      t: (en, zh, vars) => handlers.current.t(en, zh, vars),
      onChange: (markdown) => handlers.current.onChange(markdown), onOpenLink: (href) => openHref(href, handlers.current.onReference),
      ...(links ? { searchNotes: (query: string, headings?: boolean) => handlers.current.links!.search(query, headings),
        onLinked: (target: LinkTarget) => handlers.current.links!.onLinked(target) } : {}) });
    return () => { editor.current?.destroy(); editor.current = null; };
  }, []);
  // In collab mode the shared document owns the text; pushing `value` back would fight remote edits.
  useEffect(() => { if (!collab) editor.current?.setValue(value); }, [value]);
  useEffect(() => { editor.current?.setAssets({ imageSources, references, text: linkText }); },
    [imageSources, references, linkText?.unavailable]);
  return <>
    <div id="content-editor" ref={host} className="fn-editor-canvas" />
    <input ref={picker} className="fn-image-picker" type="file" accept="image/*" multiple hidden onChange={(event) => {
      const files = attachmentFiles(event.target.files); event.target.value = '';
      if (files.length) addFiles(files);
    }} />
  </>;
}

// The server marks a link the reader cannot open with U+E000; it reads as the same locked label the note itself shows.
const LOCKED_LINK = '\uE000';
// Obsidian's linked mentions: every note that points here, with the line that links, newest first. Below them, folded like
// Obsidian's, the notes that name this one without linking it; one the reader may edit can be linked.
function Backlinks({ items, mentions, busy, unavailable, onOpen, onLink, t }: { items: Backlink[]; mentions: Backlink[];
  busy: boolean; unavailable: string; onOpen: (id: string) => void; onLink: (item: Backlink) => void; t: Translate }) {
  const locked = `🔒 ${unavailable}`;
  const [open, setOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  const entry = (item: Backlink) => <button type="button" className="fn-backlink" onClick={() => onOpen(item.id)}>
    <span className="fn-backlink-title"><NoteIcon icon={item.icon} className="fn-note-icon--inline" />{item.title}</span>
    {item.snippet && <span className="fn-backlink-snippet">{item.snippet.split(LOCKED_LINK).map((part, position) =>
      <React.Fragment key={position}>{position > 0 && <span className="fn-backlink-locked">{locked}</span>}{part}</React.Fragment>)}</span>}
  </button>;
  return <section className="fn-backlinks" aria-labelledby={items.length ? 'fn-backlinks-title' : 'fn-mentions-title'}>
    {items.length > 0 && <>
      <h3 id="fn-backlinks-title" className="fn-backlinks-title">
        {t('Linked mentions', '反向链接')}<span className="fn-backlinks-count">{items.length}</span>
      </h3>
      <ul className="fn-backlinks-list">{items.map((item) => <li key={item.id}>{entry(item)}</li>)}</ul>
    </>}
    {mentions.length > 0 && <div className="fn-mentions" data-collapsed={!open || undefined} data-moving={moving || undefined}>
      <h3 id="fn-mentions-title" className="fn-backlinks-title">
        <button type="button" aria-expanded={open} aria-controls="fn-mentions-list" onClick={() => { setOpen(!open); setMoving(true); }}>
          <Icon name="chevron-down" />{t('Unlinked mentions', '未链接的提及')}<span className="fn-backlinks-count">{mentions.length}</span>
        </button>
      </h3>
      <div id="fn-mentions-list" className="fn-mentions-body" inert={!open}
        onTransitionEnd={(event) => { if (event.target === event.currentTarget) setMoving(false); }}>
        <ul className="fn-backlinks-list">{mentions.map((item) => <li key={item.id} className="fn-mention">
          {entry(item)}
          {item.can_link && <button type="button" className="trek-btn trek-btn--secondary fn-mention-link" disabled={busy}
            title={t('Turn every mention of this note in “{note}” into a link', '把“{note}”中提到这篇笔记的地方都改成链接',
              { note: item.title })} onClick={() => onLink(item)}>{t('Link', '链接')}</button>}
        </li>)}</ul>
      </div>
    </div>}
  </section>;
}

function DaySelect({ days, value, setValue, emptyLabel, t }: {
  days: Day[]; value: string; setValue: (value: string) => void; emptyLabel: string; t: Translate
}) {
  return <NativeSelect id="day" value={value} onChange={(event) => setValue(event.target.value)}>
    <option value="">{emptyLabel}</option>
    {days.map((day) => <option key={day.id} value={day.id}>
      {day.date || t('Day {number}', '第 {number} 天', { number: day.day_number || day.id })} {day.title}</option>)}
  </NativeSelect>;
}

// These selects opt out of the kit's enhanced listbox and keep the native control; this hides the native arrow, which sits
// flush against the rounded border, and draws the kit's caret inside the padding instead.
function NativeSelect(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <div className="fn-native-select"><select data-trek-native {...props} className="trek-select" /><Icon name="chevron-down" /></div>;
}

// One version's text in the history window, with images and links resolved for it alone; its links do not navigate.
function VersionText({ content, linkText, load }: { content: string; linkText: LinkText;
  load: (content: string) => Promise<[ImageSources, ReferenceLinks]> }) {
  const [assets, setAssets] = useState<[ImageSources, ReferenceLinks]>([{}, {}]);
  useEffect(() => {
    let alive = true;
    load(content).then((found) => { if (alive) setAssets(found); }, () => {});
    return () => { alive = false; };
  }, [content]);
  return <Markdown content={content} imageSources={assets[0]} references={assets[1]} linkText={linkText} onReference={() => {}} />;
}

// `onRendered` fires after each render into the article; `onPoint` reports clicks outside links, for quoted passages.
// `reveal` holds a heading to scroll to once it has rendered.
function Markdown({ content, imageSources = {}, references = {}, linkText, onReference, articleRef, onRendered, onPoint, reveal }: {
  content: string; imageSources?: ImageSources; references?: ReferenceLinks; linkText?: LinkText;
  onReference: (id: string, heading?: string) => void; articleRef?: React.MutableRefObject<HTMLElement | null>; onRendered?: () => void;
  onPoint?: (x: number, y: number) => void; reveal?: React.MutableRefObject<string>
}) {
  const article = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!article.current) return;
    renderMarkdownInto(article.current, content, imageSources, references, linkText); onRendered?.();
    if (reveal?.current && revealHeading(article.current, reveal.current)) reveal.current = '';
  }, [content, imageSources, references, linkText?.unavailable]);
  return <article ref={(node) => { article.current = node; if (articleRef) articleRef.current = node; }} className="fn-markdown"
    onClick={(event) => {
      const anchor = (event.target as HTMLElement).closest('a');
      if (!anchor) { if (!document.getSelection()?.toString()) onPoint?.(event.clientX, event.clientY); return; }
      event.preventDefault();
      openHref(anchor.getAttribute('href') || '', onReference, (heading) => article.current && revealHeading(article.current, heading));
    }} />;
}

createRoot(document.getElementById('root')!).render(<App />);
