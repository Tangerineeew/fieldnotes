import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  IMAGE_ERROR, imageSourcesInMarkdown, referenceSourcesInMarkdown, renderMarkdownInto, type ImageSources, type ReferenceLinks
} from './markdown';
import { imageFiles, uploadImage } from './images';
import { maxContentChars, maxImageBytes } from '../shared/limits.json';
import { createLiveEditor } from './live-editor';
import { CollabEditor } from './collab-editor';
import { IconPicker, NoteIcon, firstGrapheme } from './note-icon';
import type { Extension } from '@codemirror/state';
import { PropertyEditor, PropertyList, selectedLabels, type Property } from './properties';
import { translate, type Translate } from './i18n';
import { RequestError, withErrors } from './api';
import { CollaboratorEditor, useCollaborators, type Collaborator, type Person } from './collaborators';
import { FolderField, VisibilityField } from './note-fields';
import './style.css';

type Context = { tripId: string | null; locale: string; userId: number };
type TripCreateIntent = { tripId: number; tripFolderId: string | null; title: string };
type Note = {
  id: string; title: string; content: string; icon?: string | null; properties?: Property[]; version: number;
  created_at?: string; updated_at: string; owner_id?: number; visibility?: 'private' | 'public'; folder_id?: string | null;
  can_edit?: boolean; mode?: 'live' | 'snapshot'; day_id?: number | null; unavailable?: boolean
};
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
type Drag = { kind: 'note' | 'folder'; id: string };
type FolderNode = { folder: Folder; depth: number };
interface Bridge {
  context: Context | null;
  onContext(cb: (ctx: Context) => void): () => void;
  invoke<T>(path: string, options?: { method: string; body: unknown }): Promise<T>;
  confirm(options: { title?: string; message: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }): Promise<boolean>;
  navigate(path: string): void;
  openExternal(url: string): void;
  session?: {
    get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void>; remove(key: string): Promise<void>
  };
}
declare global { interface Window { trek: Bridge } }
const trek = window.trek;
const PAGE_SIZE = 7;
const empty: Draft = { title: '', content: '', icon: null, properties: [], visibility: 'private', folder_id: null };
const invoke = withErrors((path, options) => trek.invoke(path, options), () => trek.context?.locale);
const post = <T,>(path: string, body: unknown) => invoke<T>(path, { method: 'POST', body });
const draftOf = (note: Note): Draft => ({
  title: note.title, content: note.content, icon: note.icon || null, properties: note.properties || [],
  visibility: note.visibility || 'private', folder_id: note.folder_id || null
});
const SORT_KEY = 'fieldnotes:sort';
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
  } catch {
    return { key: 'updated', order: 'desc' };
  }
  return { key: 'updated', order: 'desc' };
}
// Mirrors the server-side note order so client-sorted lists (folders, trip notes) match paginated library pages.
function sortItems<T extends { id: string; created_at?: string; updated_at?: string }>(
  items: T[], name: (item: T) => string, { key, order }: Sorting, collator: Intl.Collator
) {
  const date = (item: T) => (key === 'created' ? item.created_at : undefined) || item.updated_at || '';
  const compare = key === 'name' ? (a: T, b: T) => collator.compare(name(a), name(b)) : (a: T, b: T) => date(a).localeCompare(date(b));
  return [...items].sort((a, b) => (order === 'asc' ? 1 : -1) * compare(a, b) || a.id.localeCompare(b.id));
}
// Depth-first order so every folder follows its parent; folders whose parent is not listed become roots.
function folderTree(items: Folder[], collator: Intl.Collator) {
  const ids = new Set(items.map((folder) => folder.id));
  const children = new Map<string | null, Folder[]>();
  for (const folder of items) {
    const parent = folder.parent_id && ids.has(folder.parent_id) ? folder.parent_id : null;
    children.set(parent, [...(children.get(parent) || []), folder]);
  }
  const nodes: FolderNode[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const folder of (children.get(parent) || []).sort((a, b) => collator.compare(a.name, b.name))) {
      nodes.push({ folder, depth }); walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  return nodes;
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
  const [newFolderVisibility, setNewFolderVisibility] = useState<'private' | 'public'>('private');
  const folderMembers = useCollaborators();
  const [note, setNote] = useState<Note | null>(null);
  const [draft, setDraft] = useState<Draft>(empty);
  const [editing, setEditing] = useState(false);
  const [publicMode, setPublicMode] = useState(false);
  const [folderMenuKey, setFolderMenuKey] = useState<string | null>(null);
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
  const lock = useRef(false);
  const uploadQueue = useRef(Promise.resolve());
  const requestedImages = useRef(new Set<string>());
  const hydrateTimer = useRef<number | undefined>(undefined);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState(false);
  const [contentMotion, setContentMotion] = useState<'forward' | 'backward' | 'neutral'>('neutral');
  const [trips, setTrips] = useState<Trip[]>([]);
  const [target, setTarget] = useState('');
  const [days, setDays] = useState<Day[]>([]);
  const [dayId, setDayId] = useState('');
  const [mode, setMode] = useState('live');
  const [excerpt, setExcerpt] = useState('');
  const [tripTitle, setTripTitle] = useState('');
  const [canEditTrip, setCanEditTrip] = useState(false);
  const [createTripId, setCreateTripId] = useState<number | null>(null);
  const [createTripFolderId, setCreateTripFolderId] = useState<string | null>(null);
  const [createTripTitle, setCreateTripTitle] = useState('');
  const titleInput = useRef<HTMLInputElement>(null);
  // Existing notes save continuously through collaboration; only the new-note form can hold unsaved input.
  const dirty = editing && !note && JSON.stringify(draft) !== JSON.stringify(empty);
  const latestRequest = useRef(0);
  const permissionModal = useRef<HTMLElement>(null);
  const permissionTrigger = useRef<HTMLElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const closeFolderPermissionsRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => trek.onContext(setContext), []);
  useEffect(() => { document.documentElement.lang = context?.locale || 'en'; }, [context?.locale]);
  useEffect(() => { if (editing) titleInput.current?.focus(); }, [editing]);
  useEffect(() => {
    if ((!note && !editing) || !window.matchMedia?.('(max-width: 700px)').matches) return;
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
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

  async function run(fn: () => Promise<void>, options: { silent?: boolean } = {}) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setSuppressBusyStatus(Boolean(options.silent)); setError(''); setStatus('');
    try { await fn(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { lock.current = false; setBusy(false); setSuppressBusyStatus(false); }
  }
  async function discard() {
    if (!dirty && !permissionDirty) return true;
    const message = dirty && permissionDirty
      ? t('Discard unsaved note and permission changes?', '放弃尚未保存的笔记和权限修改？')
      : permissionDirty ? t('Discard unsaved permission changes?', '放弃尚未保存的权限修改？')
        : t('Discard unsaved changes?', '放弃尚未保存的修改？');
    return trek.confirm({ message, danger: true });
  }
  async function loadFolders() {
    const result = tripId
      ? await post<Folder[]>('/trip', { action: 'folders', trip_id: tripId })
      : await invoke<Folder[]>('/folders');
    setFolders(Array.isArray(result) ? result : []);
  }
  async function load(
    search = query, page = offset, publicScope = publicMode, folderScope = selectedFolderId, order = sorting
  ): Promise<Note[]> {
    const seq = ++latestRequest.current;
    if (tripId) {
      const result = await post<{ trip: Trip; notes: Note[] }>('/trip', { action: 'list', trip_id: tripId, folder_id: folderScope });
      if (seq !== latestRequest.current) return [];
      setNotes(result.notes); setTripTitle(result.trip.title); setMore(false); return result.notes;
    }
    const route = publicScope ? '/public' : '/notes';
    const folderQuery = folderScope ? `&folder_id=${encodeURIComponent(folderScope)}` : '';
    const sortQuery = `&sort=${order.key}&order=${order.order}&locale=${encodeURIComponent(context?.locale || 'en')}`;
    const result = await invoke<{ notes: Note[]; has_more: boolean }>(
      `${route}?q=${encodeURIComponent(search)}&offset=${page}${folderQuery}${sortQuery}`
    );
    if (seq !== latestRequest.current) return [];
    setNotes(result.notes); setMore(result.has_more); setOffset(page); return result.notes;
  }
  async function loadCollaborators(item: Note) {
    if (tripId || publicMode || !owns(item)) { noteMembers.show(null); return; }
    noteMembers.show(await invoke<{ collaborators: Collaborator[]; candidates: Person[] }>(
      `/collaborators?note_id=${encodeURIComponent(item.id)}`
    ));
  }
  async function loadLinkedTrips(item: Note) {
    if (tripId || publicMode || !owns(item)) { setLinkedTrips([]); return; }
    const result = await post<LinkedTrip[]>('/trip', { action: 'links', note_id: item.id });
    setLinkedTrips(Array.isArray(result) ? result : []);
  }

  async function hydrateReferences(item: Note, viewTripId: number | null) {
    const references = referenceSourcesInMarkdown(item.content);
    if (!references.length) { setReferenceLinks({}); return; }
    const resolved = await Promise.all(references.map(async (reference) => {
      try {
        const tripQuery = viewTripId ? `&trip_id=${viewTripId}` : '';
        return await invoke<{ reference: string; id: string; title: string }>(
          `/reference?ref=${encodeURIComponent(reference)}${tripQuery}`
        );
      } catch { return null; }
    }));
    setReferenceLinks(Object.fromEntries(resolved
      .filter((entry): entry is { reference: string; id: string; title: string } => Boolean(entry?.id))
      .map((entry) => [entry.reference, entry])));
  }
  // Resolves one image source to a data URL, or to IMAGE_ERROR plus a readable reason.
  async function resolveImage(item: Note, viewTripId: number | null, source: string) {
    try {
      const query = { note_id: item.id, source, ...(viewTripId ? { trip_id: viewTripId } : {}) };
      const result = viewTripId
        ? await post<{ source: string; data_url: string }>('/trip', { action: 'asset', ...query })
        : await invoke<{ source: string; data_url: string }>(
          `/asset?note_id=${encodeURIComponent(item.id)}&source=${encodeURIComponent(source)}`
        );
      return [result.source, result.data_url] as const;
    } catch (error) { return [source, `${IMAGE_ERROR}${imageFailure(error)}`] as const; }
  }
  async function hydrateImages(item: Note, viewTripId: number | null) {
    const sources = imageSourcesInMarkdown(item.content);
    requestedImages.current = new Set(sources.map((source) => `${item.id} ${source}`));
    setImageSources(Object.fromEntries(await Promise.all(sources.map((source) => resolveImage(item, viewTripId, source)))));
  }
  // While co-editing, images others insert arrive as text: fetch each new source once, after typing settles.
  function hydrateNewImages(item: Note, content: string) {
    window.clearTimeout(hydrateTimer.current);
    hydrateTimer.current = window.setTimeout(() => {
      for (const source of imageSourcesInMarkdown(content)) {
        if (requestedImages.current.has(`${item.id} ${source}`)) continue;
        requestedImages.current.add(`${item.id} ${source}`);
        void resolveImage(item, null, source).then(([key, value]) => setImageSources((current) => ({ ...current, [key]: value })));
      }
    }, 800);
  }
  function imageFailure(error: unknown) {
    const message = error instanceof RequestError ? error.template : '';
    if (/host is not allowed/i.test(message))
      return t('this site is not allowed — copy the image itself and paste it here', '该网站不在允许列表，请复制图片本身后粘贴');
    if (/was deleted/i.test(message)) return t('the image was deleted', '图片已被删除');
    return t('image could not be loaded', '图片无法加载');
  }
  // Uploads queue apart from run(), so an image pasted during a save is never dropped.
  // Files go one at a time, each inserted where the caret is once it is stored.
  function addImages(files: File[], insert: (markdown: string) => void) {
    uploadQueue.current = uploadQueue.current.then(async () => {
      setError('');
      try {
        for (const [index, file] of files.entries()) {
          setStatus(t('Uploading image {current}/{total}…', '正在上传图片 {current}/{total}…', { current: index + 1, total: files.length }));
          const image = await uploadImage(invoke, file);
          requestedImages.current.add(`${note?.id} ${image.source}`);
          setImageSources((current) => ({ ...current, [image.source]: image.dataUrl }));
          insert(`![${image.alt}](${image.source})`);
        }
        setStatus(t('Image added.', '已插入图片。'));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const limit = `${maxImageBytes / 1024 / 1024} MB`;
        setStatus('');
        setError(reason === 'too-large' ? t('This image is still over {limit} after compression.', '图片压缩后仍超过 {limit}。', { limit })
          : reason === 'unsupported' ? t('This image format is not supported.', '不支持这种图片格式。') : reason);
      }
    });
  }
  useEffect(() => {
    if (!context) return;
    setNote(null); setEditing(false); setPublicMode(false); setImageSources({}); noteMembers.show(null);
    folderMembers.show(null); setSelectedFolderId(null); setDays([]); setDayId('');
    void run(async () => {
      await loadFolders();
      const loadedNotes = await load('', 0, false, null);
      if (!tripId) {
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
        setDays(await post<Day[]>('/trip', { action: 'days', trip_id: tripId }));
        const pending = await trek.session?.get<{ tripId: number; noteId: string }>('open_trip_note');
        if (pending && Number(pending.tripId) === tripId) {
          await trek.session?.remove('open_trip_note');
          const pendingNote = loadedNotes.find((item) => item.id === pending.noteId);
          if (pendingNote) await choose(pendingNote);
        }
      }
    });
  }, [tripId, context?.userId]);

  async function turnPage(page: number) {
    if (!await discard()) return;
    setContentMotion(page > offset ? 'forward' : 'backward');
    setNote(null); setImageSources({}); setEditing(false); await load(query, page);
  }
  async function choose(item: Note) {
    if (!await discard()) return;
    if (!tripId) { setTarget(''); setDayId(''); setDays([]); }
    const next = tripId ? item : await invoke<Note>(`/note?id=${item.id}`);
    setNote(next); setImageSources({}); setReferenceLinks({}); setDraft(next.unavailable ? empty : draftOf(next)); setEditing(false);
    setLinkedTrips([]);
    if (!next.unavailable) {
      await hydrateImages(next, tripId); await hydrateReferences(next, tripId);
      await loadCollaborators(next); await loadLinkedTrips(next);
    }
    setExcerpt(next.content && `${next.title}\n\n${next.content}`.length <= 500 ? `${next.title}\n\n${next.content}` : next.title || '');
  }
  async function openReference(id: string) {
    await choose({ id } as Note);
  }
  const update = (key: keyof Draft, value: Draft[typeof key]) => setDraft((prev) => ({ ...prev, [key]: value }));
  async function loadFolderCollaborators(folderId: string | null) {
    const folder = folders.find((item) => item.id === folderId);
    if (!folderId || publicMode || tripId || !folder?.can_manage) { folderMembers.show(null); return; }
    folderMembers.show(await post<{ collaborators: Collaborator[]; candidates: Person[] }>(
      '/folder', { action: 'collaborators', folder_id: folderId }
    ));
  }
  async function selectFolder(folderId: string | null) {
    if (!await discard()) return;
    const depth = (id: string | null) => id ? folderDepths.get(id) ?? 0 : -1;
    setContentMotion(depth(folderId) < depth(selectedFolderId) ? 'backward' : 'forward');
    setSelectedFolderId(folderId); setNote(null); setImageSources({}); setEditing(false); setOffset(0);
    await load(query, 0, publicMode, folderId); await loadFolderCollaborators(folderId);
  }
  function toggleNewFolder() {
    const next = !newFolderOpen;
    if (!next) { setNewFolderName(''); setNewFolderIcon(''); setNewFolderIconTouched(false); }
    setNewFolderOpen(next);
  }
  async function createFolder() {
    if (!newFolderName.trim()) return;
    if (tripId) await post('/trip', {
      action: 'folder_create', trip_id: tripId, name: newFolderName.trim(), icon: newFolderIcon.trim() || null, parent_id: selectedFolderId
    });
    else await post('/folder', {
      action: 'create', name: newFolderName.trim(), icon: newFolderIcon.trim() || null, parent_id: selectedFolderId,
      visibility: newFolderVisibility
    });
    setNewFolderName(''); setNewFolderIcon(''); setNewFolderIconTouched(false); setNewFolderOpen(false); await loadFolders();
  }
  async function moveNoteToFolder(noteId: string, folderId: string | null) {
    if (tripId) await post('/trip', { action: 'folder_move', trip_id: tripId, note_id: noteId, folder_id: folderId });
    else await post('/folder', { action: 'move_note', note_id: noteId, folder_id: folderId });
    await load(query, offset, publicMode, selectedFolderId); setStatus(t('Moved to folder.', '已移动到文件夹。'));
  }
  async function openLinkedTrip(trip: LinkedTrip) {
    if (!note || !trek.session) { trek.navigate(`/trips/${trip.id}`); return; }
    await trek.session.set('open_trip_note', { tripId: trip.id, noteId: note.id });
    trek.navigate(`/trips/${trip.id}`);
  }
  async function deleteFolder(folder: Folder) {
    if (!await trek.confirm({
      danger: true, message: t('Delete the folder “{name}”? Only empty folders can be deleted.', '删除文件夹“{name}”？只能删除空文件夹。', { name: folder.name })
    })) return;
    if (tripId) await post('/trip', { action: 'folder_archive', trip_id: tripId, folder_id: folder.id });
    else await post('/folder', { action: 'archive', folder_id: folder.id });
    if (selectedFolderId === folder.id) {
      setSelectedFolderId(null); folderMembers.show(null);
      await load(query, 0, publicMode, null);
    }
    setFolderMenuKey(null); await loadFolders();
  }
  async function updateFolderIcon(icon: string, folder = selectedFolder) {
    if (!folder?.can_manage) return;
    if (tripId) await post('/trip', { action: 'folder_icon', trip_id: tripId, folder_id: folder.id, icon: icon.trim() || null });
    else await post('/folder', { action: 'icon', folder_id: folder.id, icon: icon.trim() || null });
    await loadFolders();
  }
  const folderSettingsActions = (folder: Folder) => ({
    onIconDraft: (icon: string) => setFolders((items) => items.map((item) => item.id === folder.id ? { ...item, icon } : item)),
    onIcon: (icon: string) => void run(() => updateFolderIcon(icon, folder)),
    onVisibility: (visibility: string) => void run(async () => {
      await post('/folder', { action: 'visibility', folder_id: folder.id, visibility }); await loadFolders();
    }),
  });
  async function openFolderPermissions(folder: Folder) {
    if (tripId || !folder.can_manage) return;
    permissionTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFolderMenuKey(null); setPermissionFolderId(folder.id); await loadFolderCollaborators(folder.id);
  }
  async function moveFolder(folderId: string, parentId: string | null) {
    if (tripId) await post('/trip', { action: 'folder_parent', trip_id: tripId, folder_id: folderId, parent_id: parentId });
    else await post('/folder', { action: 'move', folder_id: folderId, parent_id: parentId });
    await loadFolders(); setStatus(t('Folder moved.', '文件夹已移动。'));
  }
  async function changeSorting(key: Sorting['key'], order: Sorting['order']) {
    const next = { key, order }; setSorting(next); setFolderMenuKey(null); setContentMotion('neutral');
    try { window.localStorage.setItem(SORT_KEY, JSON.stringify(next)); }
    catch (error) { console.warn('[Fieldnotes] Could not persist sorting preference.', error); }
    if (!tripId) await load(query, 0, publicMode, selectedFolderId, next);
  }
  async function moveTripNote(folderId: string) {
    if (!tripId || !note || note.unavailable) return;
    await post('/trip', { action: 'folder_move', trip_id: tripId, note_id: note.id, folder_id: folderId || null });
    setNote({ ...note, folder_id: folderId || null });
    await load(query, offset, false, selectedFolderId); setStatus(t('Moved to folder.', '已移动到文件夹。'));
  }
  async function switchLibrary(nextPublic: boolean) {
    if (!await discard()) return;
    setContentMotion(nextPublic ? 'forward' : 'backward');
    setPublicMode(nextPublic); setSelectedFolderId(null); setNote(null); setImageSources({}); setEditing(false); setOffset(0);
    setQuery('');
    await load('', 0, nextPublic, null);
  }
  async function addFolderCollaborator() {
    const folderId = permissionFolderId || selectedFolderId;
    if (!folderId || !folderMembers.selected.length) return;
    await post('/folder', { action: 'bulk_roles', folder_id: folderId, changes: folderMembers.additions() });
    await loadFolderCollaborators(folderId); folderMembers.setSelected([]);
  }
  async function removeFolderCollaborator(userId: number) {
    const folderId = permissionFolderId || selectedFolderId;
    if (!folderId) return;
    await post('/folder', { action: 'remove_collaborator', folder_id: folderId, user_id: userId });
    await loadFolderCollaborators(folderId);
  }
  async function saveFolderRoleChanges() {
    const folderId = permissionFolderId || selectedFolderId;
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
  function createForCurrentTrip() {
    if (!tripId) return;
    void run(async () => {
      await post('/trip', { action: 'begin_note', trip_id: tripId, trip_folder_id: selectedFolderId });
      trek.navigate('/plugins/fieldnotes');
    });
  }
  async function setDestination(value: string) {
    setTarget(value); setDayId(''); setDays([]);
    if (value) setDays(await post<Day[]>('/trip', { action: 'days', trip_id: Number(value) }));
  }
  async function addCollaborator() {
    if (!note || !noteMembers.selected.length) return;
    await post('/collaborator', { action: 'bulk_roles', note_id: note.id, changes: noteMembers.additions() });
    await loadCollaborators(note); noteMembers.setSelected([]);
  }
  async function removeCollaborator(userId: number) {
    if (!note) return;
    await post('/collaborator', { action: 'remove', note_id: note.id, user_id: userId });
    await loadCollaborators(note);
  }
  async function saveRoleChanges() {
    if (!note || !noteMembers.changes.length) return;
    await post('/collaborator', { action: 'bulk_roles', note_id: note.id, changes: noteMembers.changes });
    await loadCollaborators(note); setStatus(t('Permissions updated.', '权限已更新。'));
  }
  async function removeLinkedTrip(trip: LinkedTrip) {
    if (!note) return;
    if (!await trek.confirm({
      danger: true, message: t('Remove “{note}” from {trip}?', '从“{trip}”中移除“{note}”？', { note: note.title, trip: trip.title })
    })) return;
    await post('/trip', { action: 'unlink', trip_id: trip.id, note_id: note.id });
    await loadLinkedTrips(note); setStatus(t('Removed from trip.', '已从旅行中移除。'));
  }
  async function backToLibrary() {
    if (!await discard()) return;
    setNote(null); setImageSources({}); setReferenceLinks({}); setEditing(false); setLinkedTrips([]); noteMembers.show(null);
  }

  // Collaborators may only freeze a private note into a trip; a live reference is the owner's call.
  const canShareLive = !note || owns(note) || note.visibility === 'public';
  const linkMode = canShareLive ? mode : 'snapshot';
  async function link() {
    if (!note || !target) return;
    const message = linkMode === 'live'
      ? t('All trip members will see this note and future edits. Share a live reference?',
        '旅行成员将能阅读这篇笔记及后续修改。确认共享实时引用？')
      : t('A full copy will remain with this trip even if you delete the original or leave. Import a snapshot?',
        '完整副本会保留在旅行中，即使你删除原文或离开旅行。确认导入快照？');
    const confirmLabel = linkMode === 'live' ? t('Share', '共享') : t('Import', '导入');
    if (!await trek.confirm({ message, confirmLabel, danger: false })) return;
    await post('/link', { note_id: note.id, trip_id: Number(target), day_id: dayId || null, mode: linkMode });
    await loadLinkedTrips(note);
    setStatus(t('Added to trip. Open its Fieldnotes tab to read it.', '已添加。可在旅行的 Fieldnotes 标签页阅读。'));
  }
  const folderNodes = folderTree(folders, collator);
  const folderDepths = new Map(folderNodes.map(({ folder, depth }) => [folder.id, depth]));
  const visibleFolders = folders.filter((folder) => !publicMode || folder.public_path);
  const sidebarNodes = folderTree(visibleFolders, collator);
  const visibleIds = new Set(visibleFolders.map((folder) => folder.id));
  const selectedFolder = folders.find((folder) => folder.id === selectedFolderId);
  const permissionFolder = folders.find((folder) => folder.id === permissionFolderId);
  const childFolders = sortItems(
    visibleFolders.filter((folder) =>
      (folder.parent_id && visibleIds.has(folder.parent_id) ? folder.parent_id : null) === selectedFolderId),
    (folder) => folder.name, sorting, collator);
  const listedNotes = tripId ? sortItems(notes, (item) => item.title || '', sorting, collator) : notes;
  const sortOptions: [Sorting['key'], string][] = [
    ['name', t('Name', '名称')], ['updated', t('Date modified', '修改日期')], ['created', t('Date created', '创建日期')]];
  const orderOptions: [Sorting['order'], string][] = sorting.key === 'name'
    ? [['asc', t('A to Z', 'A → Z')], ['desc', t('Z to A', 'Z → A')]]
    : [['desc', t('Newest first', '最新的在前')], ['asc', t('Oldest first', '最早的在前')]];
  const permissionDirty = folderMembers.changes.length > 0 || noteMembers.changes.length > 0;
  const editableFolders = folderNodes.filter(({ folder }) => folder.role === 'editor')
    .map(({ folder, depth }) => ({ id: folder.id, label: `${'— '.repeat(depth)}${folder.name}` }));
  const folderMemberEditor = (addLabel?: string) => <CollaboratorEditor
    state={folderMembers} busy={busy} t={t} removeLabel={t('Remove', '移除')} addLabel={addLabel}
    onAdd={() => void run(addFolderCollaborator)} onRemove={(userId) => void run(() => removeFolderCollaborator(userId))}
    onSave={() => void run(saveFolderRoleChanges)} />;
  async function closeFolderPermissions() {
    if (await discard()) setPermissionFolderId(null);
  }
  useEffect(() => { closeFolderPermissionsRef.current = closeFolderPermissions; });
  useEffect(() => {
    if (!folderMenuKey) return;
    const close = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.fn-folder-menu, .fn-folder-menu-button, .fn-sort-button')) setFolderMenuKey(null);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [folderMenuKey]);
  useEffect(() => {
    if (!permissionFolderId) return;
    const focusFirst = window.setTimeout(() => permissionModal.current?.querySelector<HTMLElement>('button, input, select')?.focus(), 0);
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); void closeFolderPermissionsRef.current(); return; }
      if (event.key !== 'Tab' || !permissionModal.current) return;
      const focusable = Array.from(permissionModal.current.querySelectorAll<HTMLElement>('button, input, select'))
        .filter((item) => !item.hasAttribute('disabled'));
      if (!focusable.length) return;
      const next = focusable.indexOf(document.activeElement as HTMLElement) + (event.shiftKey ? -1 : 1);
      if (next < 0 || next >= focusable.length) {
        event.preventDefault(); focusable[(next + focusable.length) % focusable.length].focus();
      }
    };
    window.addEventListener('keydown', close);
    return () => { window.clearTimeout(focusFirst); window.removeEventListener('keydown', close); permissionTrigger.current?.focus(); };
  }, [permissionFolderId]);
  function folderClick(id: string) {
    setFolderMenuKey(null); void run(() => selectFolder(id));
  }
  function toggleFolderMenu(key: string) {
    setFolderMenuKey((current) => current === key ? null : key);
  }
  function dragNoteStart(item: Note, event: React.DragEvent<HTMLButtonElement>) {
    if (!(tripId || owns(item))) { event.preventDefault(); return; }
    setDragged({ kind: 'note', id: item.id }); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.id);
  }
  const canMoveFolder = (folder: Folder) => !publicMode && folder.can_manage && (!tripId || canEditTrip);
  function dragFolderStart(folder: Folder, event: React.DragEvent<HTMLButtonElement>) {
    if (!canMoveFolder(folder)) { event.preventDefault(); return; }
    setFolderMenuKey(null); setDragged({ kind: 'folder', id: folder.id });
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
    if (!dragged) return false;
    if (dragged.kind === 'note') return !target || (target.can_manage && target.id !== selectedFolderId);
    const source = folders.find((folder) => folder.id === dragged.id);
    if (!source || (source.parent_id || null) === (target?.id || null)) return false;
    return !target || (target.role === 'editor' && !isWithin(target.id, source.id));
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
  const dragClass = (key: string) =>
    `${dropTarget === key ? ' is-drop-target' : ''}${landedKey === key ? ' is-landed' : ''}${dragged?.id === key ? ' is-dragging' : ''}`;
  const folderGlyph = (folder: Folder) => <span className="fn-folder-icon" aria-hidden="true">
    {dropTarget === folder.id ? <Icon name="folder-drop" /> : folder.icon || ''}
  </span>;

  return <main className="fn-shell">
    <header className="fn-header">
      <div className="fn-heading">
        <span className="fn-symbol" aria-hidden="true"><i /><i /><i /></span>
        <div className="fn-heading-copy">
          <p className="fn-eyebrow trek-muted">{tripId ? tripTitle : t('YOUR TRAVEL KNOWLEDGE', '你的旅行知识库')}</p>
          <h1>{tripId ? t('Trip Fieldnotes', 'Trip Fieldnotes') : 'Fieldnotes'}</h1>
          <p className="trek-muted">{tripId ? t('Shared knowledge for this journey.', '为这段旅程整理的共享知识。')
            : t('Write once. Keep it ready for every journey.', '把走过的路，写成下一次出发的底气。')}</p>
        </div>
      </div>
      <div className="trek-cluster fn-header-actions">
        <button className="trek-btn trek-btn--secondary fn-icon-button" aria-label={t('Refresh', '刷新')} title={t('Refresh', '刷新')}
          disabled={busy} onClick={() => void run(async () => {
            if (await discard()) { setNote(null); setImageSources({}); setEditing(false); await load(); }
          })}>
          <Icon name="refresh" /><span className="fn-visually-hidden">{t('Refresh', '刷新')}</span>
        </button>
        {tripId
          ? <>
            {canEditTrip && <button className="trek-btn trek-btn--primary fn-icon-button"
              aria-label={t('New note for this trip', '为此旅行新建笔记')} title={t('New note for this trip', '为此旅行新建笔记')}
              disabled={busy} onClick={createForCurrentTrip}>
              <Icon name="plus" /><span className="fn-visually-hidden">{t('New note for this trip', '为此旅行新建笔记')}</span>
            </button>}
            <button className="trek-btn trek-btn--secondary fn-icon-button fn-tooltip" aria-label={t('Open library', '打开图书馆')}
              title={t('Open library', '打开图书馆')} data-tooltip={t('Open Fieldnotes library', '打开 Fieldnotes 图书馆')}
              onClick={() => trek.navigate('/plugins/fieldnotes')}>
              <Icon name="library" /><span className="fn-visually-hidden">{t('Open library', '打开图书馆')}</span>
            </button>
          </>
          : <button className="trek-btn trek-btn--primary fn-icon-button" aria-label={t('New note', '新建笔记')} title={t('New note', '新建笔记')}
            disabled={busy} onClick={() => void run(async () => {
              if (await discard()) {
                setPublicMode(false); setNote(null); setDraft({ ...empty, folder_id: selectedFolderId });
                setImageSources({}); setEditing(true);
              }
            })}>
            <Icon name="plus" /><span className="fn-visually-hidden">{t('New note', '新建笔记')}</span>
          </button>}
      </div>
    </header>
    {error && <div className="fn-error" role="alert">{error}</div>}
    <p className="fn-status trek-muted" role="status">
      {busy && !suppressBusyStatus
        ? t('Working…', '处理中…')
        : status || (dirty ? t('Unsaved changes — save before leaving.', '尚未保存，请在离开前保存。') : '')}
    </p>
    {!tripId && <div className={`fn-scope-switcher${publicMode ? ' is-public' : ''}`} role="tablist"
      aria-label={t('Library scope', '图书馆范围')}>
      <span className="fn-scope-indicator" aria-hidden="true" />
      <button type="button" role="tab" aria-selected={!publicMode} className="fn-scope-tab" disabled={busy}
        onClick={() => void run(() => switchLibrary(false))}>{t('Private library', '私人图书馆')}</button>
      <button type="button" role="tab" aria-selected={publicMode} className="fn-scope-tab" disabled={busy}
        onClick={() => void run(() => switchLibrary(true))}>{t('Public library', '公开图书馆')}</button>
    </div>}
    <div className={`fn-layout${note || editing ? ' fn-layout-editor' : ''}`} aria-busy={busy}>
      <aside className="trek-card fn-library"
        aria-label={note ? t('Note navigation', '笔记导航') : tripId ? t('Trip folders', '旅行文件夹') : t('Library folders', '图书馆文件夹')}>
        {note && <div className="fn-note-sidebar-header">
          <button type="button" className="trek-btn trek-btn--ghost fn-icon-button" aria-label={t('Back to library', '返回图书馆')}
            title={t('Back to library', '返回图书馆')} onClick={() => void run(backToLibrary)}><Icon name="chevron-left" /></button>
          <h2>{t('Notes', '笔记')}</h2>
        </div>}
        {!note && <section className="fn-folders" aria-labelledby="folders-heading">
          <div className="fn-panel-heading"><h3 id="folders-heading">{t('Folders', '文件夹')}</h3>
            <button type="button" className="trek-btn trek-btn--ghost fn-icon-button"
              aria-label={newFolderOpen ? t('Back to folders', '返回文件夹') : t('New folder', '新建文件夹')}
              title={newFolderOpen ? t('Back to folders', '返回文件夹') : t('New folder', '新建文件夹')} onClick={toggleNewFolder}>
              <Icon name={newFolderOpen ? 'chevron-left' : 'folder-plus'} />
              <span className="fn-visually-hidden">{newFolderOpen ? t('Back to folders', '返回文件夹') : t('New folder', '新建文件夹')}</span>
            </button></div>
          {newFolderOpen && <form className="trek-stack fn-folder-form"
            onSubmit={(event) => { event.preventDefault(); void run(createFolder); }}>
            <div className="fn-folder-create-fields">
              <div className="fn-folder-icon-input">
                <label className="fn-visually-hidden" htmlFor="new-folder-icon">{t('Icon', '图标')}</label>
                <input id="new-folder-icon" className="trek-input fn-emoji-input" maxLength={8} aria-label={t('Icon', '图标')}
                  aria-describedby="new-folder-icon-help" placeholder="" value={newFolderIcon}
                  onChange={(event) => { setNewFolderIconTouched(true); setNewFolderIcon(event.target.value); }} />
                <small id="new-folder-icon-help" className="fn-folder-icon-help trek-muted">
                  {t('Supports ≤8 characters and emoji', '支持≤8个字符和 emoji')}
                </small>
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
            {!tripId && <select className="trek-select" value={newFolderVisibility}
              onChange={(event) => setNewFolderVisibility(event.target.value as 'private' | 'public')}>
              <option value="private">{t('Private folder', '私有文件夹')}</option><option value="public">{t('Public folder', '公有文件夹')}</option>
            </select>}
            <button className="trek-btn trek-btn--secondary" disabled={!newFolderName.trim()}>{t('Create folder', '创建文件夹')}</button>
          </form>}
          <div className="fn-folder-tree">
            <button type="button" className={`trek-row fn-folder-row fn-library-row${dragClass('root')}`}
              aria-current={selectedFolderId === null ? 'true' : undefined} onClick={() => void run(() => selectFolder(null))}
              {...dropProps(null)}>
              <Icon name={dropTarget === 'root' ? 'folder-drop' : 'library'} /><span>{t('All notes', '全部笔记')}</span>
            </button>
            {sidebarNodes.map(({ folder, depth }) => <div key={folder.id} className={`fn-folder-item${dragClass(folder.id)}`}
              style={{ '--folder-depth': depth } as React.CSSProperties} {...dropProps(folder)}>
              <button type="button" className="trek-row fn-folder-row" aria-current={selectedFolderId === folder.id ? 'true' : undefined}
                draggable={canMoveFolder(folder)} onDragStart={(event) => dragFolderStart(folder, event)} onDragEnd={endDrag}
                onClick={() => folderClick(folder.id)}>
                <span className="fn-folder-label">{folderGlyph(folder)}<span>{folder.name}</span></span>
                {!tripId && <span className="trek-muted">{folder.role === 'editor' ? t('Editor', '编辑者') : t('Viewer', '查看者')}</span>}
              </button>
              {folder.can_manage && <button type="button" className="fn-folder-menu-button"
                aria-label={t('Actions for {name}', '{name}操作', { name: folder.name })} title={t('Folder actions', '文件夹操作')}
                onClick={(event) => { event.stopPropagation(); toggleFolderMenu(`tree:${folder.id}`); }}><Icon name="more" /></button>}
              {folder.can_manage && folderMenuKey === `tree:${folder.id}` && <div className="fn-folder-menu" role="menu">
                <button type="button" role="menuitem" onClick={() => void run(() => deleteFolder(folder))}>
                  <Icon name="trash" />{t('Delete', '删除')}
                </button>
                {!tripId && <button type="button" role="menuitem" onClick={() => void run(() => openFolderPermissions(folder))}>
                  <Icon name="settings" />{t('Permissions', '权限')}
                </button>}
              </div>}
            </div>)}
          </div>
        </section>}
        {!note && !tripId && selectedFolder?.can_manage && !publicMode && <section className="fn-collaborators fn-folder-access"
          aria-labelledby="folder-access-heading">
          <div className="fn-detail-header">
            <h3 id="folder-access-heading">{t('Folder access', '文件夹权限')}</h3><span className="trek-muted">{selectedFolder.name}</span>
          </div>
          <div className="fn-folder-settings">
            <FolderSettings folder={selectedFolder} idPrefix="folder" t={t} {...folderSettingsActions(selectedFolder)} />
          </div>
          {folderMemberEditor()}
        </section>}
        {tripId && note && !note.unavailable && <section className="fn-side-section fn-trip-folder-placement"
          aria-labelledby="trip-folder-placement-heading">
          <div className="fn-side-section-heading"><h3 id="trip-folder-placement-heading">{t('Folder', '文件夹')}</h3></div>
          <select className="trek-select" value={note.folder_id || ''}
            onChange={(event) => void run(() => moveTripNote(event.target.value))}>
            <option value="">{t('No folder', '不放入文件夹')}</option>
            {folderNodes.map(({ folder, depth }) => <option key={folder.id} value={folder.id}>
              {'— '.repeat(depth)}{folder.icon} {folder.name}
            </option>)}
          </select>
        </section>}
        {!tripId && !publicMode && note && owns(note)
          && <section className="fn-side-section fn-collaborators" aria-labelledby="collaborators-heading">
          <div className="fn-side-section-heading">
            <h3 id="collaborators-heading">{t('Collaborators', '协作者')}</h3>
            <span className="trek-muted">{t('Who can edit this note', '可以编辑这篇笔记的成员')}</span>
          </div>
          <CollaboratorEditor state={noteMembers} busy={busy} t={t} removeLabel={<Icon name="close" />}
            onAdd={() => void run(addCollaborator)} onRemove={(userId) => void run(() => removeCollaborator(userId))}
            onSave={() => void run(saveRoleChanges)} />
        </section>}
        {!tripId && !publicMode && note && linkedTrips.length > 0 && <section className="fn-side-section fn-linked-trips"
          aria-labelledby="linked-trips-heading">
          <div className="fn-side-section-heading"><h3 id="linked-trips-heading">{t('In trips', '已加入旅行')}</h3></div>
          <ul className="fn-linked-trip-list">{linkedTrips.map((trip) => <li key={trip.id}>
            <button type="button" className="fn-linked-trip-open" title={t('Open in Trip Fieldnotes', '在 Trip Fieldnotes 中打开')}
              onClick={() => void run(() => openLinkedTrip(trip))}><span>{trip.title}</span><Icon name="chevron-right" /></button>
            <button type="button" className="trek-btn trek-btn--ghost" aria-label={t('Remove from {trip}', '从{trip}移除', { trip: trip.title })}
              onClick={() => void run(() => removeLinkedTrip(trip))}><Icon name="close" /></button>
          </li>)}</ul>
        </section>}
        {!tripId && !publicMode && note && <section className="fn-side-section fn-trip-actions" aria-labelledby="bring-trip-heading">
          <div className="fn-side-section-heading">
            <h3 id="bring-trip-heading">{t('Bring into a trip', '带入旅行')}</h3>
            <span className="trek-muted">{t('Share this note with a trip', '将笔记分享给旅行')}</span>
          </div>
          <fieldset disabled={busy} className="trek-stack fn-action-form">
            <label className="trek-label" htmlFor="trip">{t('Trip', '旅行')}</label>
            <select id="trip" data-trek-native className="trek-select" value={target}
              onChange={(event) => void run(() => setDestination(event.target.value))}>
              <option value="">{t('Choose a trip', '选择旅行')}</option>
              {trips.map((trip) => <option key={trip.id} value={trip.id}>{trip.title}</option>)}
            </select>
            <label className="trek-label" htmlFor="day">{t('Day (optional)', '日程（可选）')}</label>
            <DaySelect days={days} value={dayId} setValue={setDayId} emptyLabel={t('Whole trip', '整个旅行')} />
            <label className="trek-label" htmlFor="mode">{t('Sharing mode', '共享方式')}</label>
            <select id="mode" data-trek-native className="trek-select" value={linkMode} onChange={(event) => setMode(event.target.value)}>
              {canShareLive && <option value="live">{t('Live reference — follows edits', '实时引用 · 跟随原文更新')}</option>}
              <option value="snapshot">{t('Snapshot — keeps this version', '独立快照 · 保留当前版本')}</option>
            </select>
            <button className="trek-btn trek-btn--primary" disabled={!target} onClick={() => void run(link)}>
              {t('Add to trip', '添加到旅行')}
            </button>
          </fieldset>
        </section>}
      </aside>
      <section ref={workspaceRef} className="trek-card fn-workspace" aria-label={t('Note detail', '笔记详情')} tabIndex={-1}>
        {(note || editing) && <button type="button" className="trek-btn trek-btn--ghost fn-mobile-back"
          onClick={() => void run(backToLibrary)}>
          <Icon name="chevron-left" />{t('Back to library', '返回图书馆')}
        </button>}
        {!note && !editing ? <div className={`fn-content-browser fn-content-browser--${contentMotion}`}
          key={`${publicMode ? 'public' : 'private'}-${selectedFolderId || 'root'}-${offset}`}>
          <div className="fn-content-toolbar">
            <form className="fn-search" onSubmit={(event) => { event.preventDefault(); void run(async () => {
              if (await discard()) { setNote(null); setEditing(false); await load(query, 0, publicMode, selectedFolderId); }
            }); }}>
              <Icon name="search" />
              <input id="search" className="trek-input" maxLength={120} placeholder={t('Search this location', '搜索当前位置')}
                aria-label={t('Search title, text or properties', '搜索标题、正文或属性')} value={query}
                onChange={(event) => setQuery(event.target.value)} />
              <button className="trek-btn trek-btn--secondary" disabled={busy}>{t('Search', '搜索')}</button>
              <div className="fn-sort">
                <button type="button" className="trek-btn trek-btn--ghost fn-icon-button fn-sort-button" aria-haspopup="menu"
                  aria-expanded={folderMenuKey === 'sort'} aria-label={t('Sort', '排序')}
                  title={`${t('Sort by', '排序方式')}: ${sortOptions.find(([key]) => key === sorting.key)?.[1]}`}
                  onClick={() => toggleFolderMenu('sort')}><Icon name="sort" /></button>
                {folderMenuKey === 'sort' && <div className="fn-folder-menu fn-sort-menu" role="menu" aria-label={t('Sort by', '排序方式')}>
                  {sortOptions.map(([key, label]) => <button key={key} type="button" role="menuitemradio" aria-checked={sorting.key === key}
                    onClick={() => void run(() => changeSorting(key, key === sorting.key ? sorting.order : key === 'name' ? 'asc' : 'desc'),
                      { silent: true })}>
                    <Icon name="check" />{label}
                  </button>)}
                  <div className="fn-menu-separator" role="separator" />
                  {orderOptions.map(([order, label]) => <button key={order} type="button" role="menuitemradio"
                    aria-checked={sorting.order === order}
                    onClick={() => void run(() => changeSorting(sorting.key, order), { silent: true })}>
                    <Icon name="check" />{label}
                  </button>)}
                </div>}
              </div>
            </form>
            {selectedFolder && <>
              <button type="button" className="trek-btn trek-btn--ghost fn-folder-back" aria-label={t('Back to parent folder', '返回上级文件夹')}
                title={t('Back to parent folder', '返回上级文件夹')} onClick={() => void run(() => selectFolder(selectedFolder.parent_id))}>
                <Icon name="chevron-left" />
              </button>
              <span className="fn-content-context"><Icon name="folder" />{selectedFolder.name}</span>
            </>}
          </div>
          {childFolders.length > 0 && <section className="fn-subfolders" aria-label={t('Subfolders', '子文件夹')}>
            {childFolders.map((folder) => <div className={`fn-subfolder-wrap${dragClass(folder.id)}`} key={folder.id}
              {...dropProps(folder)}>
              <button type="button" className="fn-subfolder-row" draggable={canMoveFolder(folder)}
                onDragStart={(event) => dragFolderStart(folder, event)} onDragEnd={endDrag}
                onClick={() => void run(() => selectFolder(folder.id))}>
                {folderGlyph(folder)}<span>{folder.name}</span>
              </button>
              {folder.can_manage && <button type="button" className="fn-folder-menu-button fn-subfolder-menu-button"
                aria-label={t('Actions for {name}', '{name}操作', { name: folder.name })} title={t('Folder actions', '文件夹操作')}
                onClick={(event) => { event.stopPropagation(); toggleFolderMenu(`content:${folder.id}`); }}><Icon name="more" /></button>}
              {folder.can_manage && folderMenuKey === `content:${folder.id}`
                && <div className="fn-folder-menu fn-subfolder-menu" role="menu">
                <button type="button" role="menuitem" onClick={() => void run(() => deleteFolder(folder))}>
                  <Icon name="trash" />{t('Delete', '删除')}
                </button>
                {!tripId && <button type="button" role="menuitem" onClick={() => void run(() => openFolderPermissions(folder))}>
                  <Icon name="settings" />{t('Permissions', '权限')}
                </button>}
              </div>}
            </div>)}
          </section>}
          {notes.length > 0 && <ul className="fn-note-list fn-content-note-list">{listedNotes.map((item) => <li key={item.id}>
            <button className={`trek-row fn-note-row${dragClass(item.id)}`} draggable={Boolean(tripId || owns(item))}
              disabled={busy} onDragStart={(event) => dragNoteStart(item, event)} onDragEnd={endDrag}
              onClick={() => void run(() => choose(item))}>
              <span className="fn-note-row-icon">{item.icon ? <NoteIcon icon={item.icon} /> : <Icon name="note" />}</span>
              <span className="fn-note-row-main">
                <strong>{item.unavailable ? t('Reference unavailable', '引用已不可用') : item.title}</strong>
                <span className="trek-muted">{item.mode ? item.mode === 'live' ? t('Live reference', '实时引用') : t('Snapshot', '独立快照')
                  : item.owner_id && Number(item.owner_id) !== Number(context?.userId) ? t('Shared with me', '与我共享')
                    : item.visibility === 'public' ? t('Public note', '公开笔记')
                      : selectedLabels(item.properties).join(' · ') || t('Private note', '私人笔记')}</span>
                {item.day_id && <span className="trek-muted">
                  {t('Day', '日程')} · {days.find((day) => day.id === item.day_id)?.date || item.day_id}
                </span>}
              </span>
              {!item.unavailable && <span className="fn-note-dates">
                <span className={sorting.key !== 'created' ? 'is-sorted' : undefined}
                  title={item.updated_at && new Date(item.updated_at).toLocaleString(context?.locale)}>
                  {t('Modified', '修改')} {shortDate(item.updated_at, context?.locale, t('Today', '今天'))}</span>
                {item.created_at && <span className={sorting.key === 'created' ? 'is-sorted' : undefined}
                  title={new Date(item.created_at).toLocaleString(context?.locale)}>
                  {t('Created', '创建')} {shortDate(item.created_at, context?.locale, t('Today', '今天'))}</span>}
              </span>}
            </button>
          </li>)}</ul>}
          {!notes.length && (!childFolders.length || Boolean(tripId)) && <div className="fn-empty fn-empty-detail fn-empty-browser">
            <span className="fn-empty-mark" aria-hidden="true">✦</span>
            <h2>
              {selectedFolder && !childFolders.length
                ? t('This folder is empty', '此文件夹为空')
                : tripId
                  ? canEditTrip
                    ? t('Create a note here or reuse one from your library.', '可以在这里新建笔记，也可以从图书馆复用已有笔记。')
                    : t('No notes have been shared with this trip yet.', '这次旅行还没有共享笔记。')
                  : t('A home for the things worth remembering', '让值得记住的旅行经验，有一个归处')}
            </h2>
            <p className="trek-muted">
              {tripId
                ? canEditTrip
                  ? t('New notes keep a private source in your library and stay linked to this trip.', '新笔记会在你的图书馆保留私人原文，并持续绑定到这次旅行。')
                  : t('A trip editor can create or add notes here.', '旅行编辑者可以在这里新建或添加笔记。')
                : t('Choose a folder or create a note to start building your travel library.', '选择一个文件夹，或新建一篇笔记，开始整理旅行知识。')}
            </p>
            {tripId
              ? canEditTrip && <div className="trek-cluster fn-empty-actions">
                <button type="button" className="trek-btn trek-btn--primary" onClick={createForCurrentTrip}>
                  {t('New note for this trip', '为此旅行新建笔记')}
                </button>
                <button type="button" className="trek-btn trek-btn--secondary" onClick={() => trek.navigate('/plugins/fieldnotes')}>
                  {t('Open library', '打开图书馆')}
                </button>
              </div>
              : <button type="button" className="trek-btn trek-btn--primary" onClick={() => void run(async () => {
                if (await discard()) {
                  setNote(null); setDraft({ ...empty, folder_id: selectedFolderId }); setImageSources({}); setEditing(true);
                }
              })}>{t('New note', '新建笔记')}</button>}
          </div>}
          {!tripId && <div className="trek-cluster fn-pagination">
            <button type="button" className="trek-btn trek-btn--ghost fn-icon-button" aria-label={t('Previous page', '上一页')}
              title={t('Previous page', '上一页')} disabled={busy || offset === 0}
              onClick={() => void run(() => turnPage(offset - PAGE_SIZE), { silent: true })}><Icon name="chevron-left" /></button>
            <span className="trek-muted">
              {t('Page {page}', '第 {page} 页', { page: Math.floor(offset / PAGE_SIZE) + 1 })}
            </span>
            <button type="button" className="trek-btn trek-btn--ghost fn-icon-button" aria-label={t('Next page', '下一页')}
              title={t('Next page', '下一页')} disabled={busy || !more}
              onClick={() => void run(() => turnPage(offset + PAGE_SIZE), { silent: true })}><Icon name="chevron-right" /></button>
          </div>}
        </div>
          : note?.unavailable ? <>
            <h2>{t('Reference unavailable', '引用已不可用')}</h2>
            <p>{t('The author removed the note or left this trip. Saved snapshots are unaffected.',
              '原文已被删除，或作者已离开旅行。已保存的快照不受影响。')}</p>
            <button className="trek-btn trek-btn--danger" disabled={busy} onClick={() => void run(async () => {
              if (await trek.confirm({ message: t('Remove this reference?', '移除这条引用？') })) {
                await post('/trip', { action: 'unlink', trip_id: tripId, note_id: note.id }); setNote(null); await load();
              }
            })}>{t('Remove reference', '移除引用')}</button></>
          : <>
            {editing && note && !createTripId ? <CollabEditor noteId={note.id} visibility={note.visibility || 'private'}
              folderId={note.folder_id || null} isOwner={owns(note)} invoke={invoke} t={t}
              folders={editableFolders}
              renderEditor={(session) => <MarkdownEditor key={session.doc.clientID} value={session.content.toString()}
                imageSources={imageSources} references={referenceLinks} onChange={(markdown) => hydrateNewImages(note, markdown)}
                onReference={(id) => void run(() => openReference(id))} onImageFiles={addImages} t={t}
                collab={session.editorExtensions()} />}
              onVisibility={(visibility) => run(async () => { setNote(await post<Note>('/note-settings', { id: note.id, visibility })); })}
              onFolder={(folderId) => run(async () => {
                await moveNoteToFolder(note.id, folderId); setNote({ ...note, folder_id: folderId });
              })}
              onDone={() => run(async () => {
                setEditing(false); await choose({ id: note.id } as Note); await load();
              }, { silent: true })} />
            : editing ? <form onSubmit={(event) => { event.preventDefault(); void run(save); }}>
              <fieldset disabled={busy} className="trek-stack">
                {createTripId && <div className="fn-trip-create-context">
                  <strong>{t('New note for this trip', '为此旅行新建笔记')}</strong><span className="trek-muted">{createTripTitle}</span>
                  <p className="trek-muted">{t('The private original stays in your library and is shared live with this trip.',
                    '私人原文会保存在你的图书馆，并以实时引用绑定到这次旅行。')}</p>
                </div>}
                <IconPicker icon={draft.icon} onChange={(icon) => update('icon', icon)} t={t} />
                <label className="trek-label" htmlFor="title">{t('Title', '标题')}</label>
                <input id="title" ref={titleInput} className="trek-input" value={draft.title} maxLength={160} required
                  onChange={(event) => update('title', event.target.value)} />
                <span className="trek-label">{t('Properties', '属性')}</span>
                <PropertyEditor properties={draft.properties} onChange={(value) => update('properties', value)} t={t} />
                {!createTripId && <VisibilityField value={draft.visibility} onChange={(value) => update('visibility', value)} t={t} />}
                <FolderField value={draft.folder_id} folders={editableFolders} onChange={(value) => update('folder_id', value)} t={t} />
                <label id="content-label" className="trek-label" htmlFor="content-editor">Markdown</label>
                <MarkdownEditor value={draft.content} imageSources={imageSources} references={referenceLinks}
                  onChange={(value) => update('content', value)} onReference={(id) => void run(() => openReference(id))}
                  onImageFiles={addImages} t={t} />
                <textarea id="content" className="fn-editor-source" maxLength={maxContentChars} aria-hidden="true" tabIndex={-1}
                  value={draft.content} onChange={(event) => update('content', event.target.value)} />
                <div className="trek-cluster">
                  <button className="trek-btn trek-btn--primary">
                    {createTripId ? t('Save and add to trip', '保存并添加到旅行') : t('Save note', '保存笔记')}
                  </button>
                  <button type="button" className="trek-btn trek-btn--ghost" onClick={() => void run(cancelEditing)}>
                    {t('Cancel', '取消')}
                  </button>
                </div>
              </fieldset>
            </form> : note && <>
              {note.icon && <div className="fn-note-hero"><NoteIcon icon={note.icon} className="fn-note-icon--hero" /></div>}
              <div className="fn-detail-header">
                <h2>{note.title}</h2>
                <div className="fn-note-actions">
                  {!tripId && !publicMode && note.can_edit && <button className="trek-btn trek-btn--secondary fn-icon-button"
                    aria-label={t('Edit', '编辑')} title={t('Edit', '编辑')} disabled={busy}
                    onClick={() => { setDraft(draftOf(note)); setEditing(true); }}>
                    <Icon name="edit" /><span className="fn-visually-hidden">{t('Edit', '编辑')}</span>
                  </button>}
                  {!tripId && !publicMode && owns(note)
                    && <button className="trek-btn trek-btn--danger fn-icon-button" aria-label={t('Delete note', '删除笔记')}
                      title={t('Delete note', '删除笔记')} disabled={busy} onClick={() => void run(async () => {
                        if (!await trek.confirm({
                          danger: true, message: t('Delete this note? Live references become unavailable; snapshots remain.',
                            '删除这篇笔记？实时引用将不可用，旅行快照会保留。')
                        })) return;
                        await post('/archive', { id: note.id, version: note.version }); setNote(null); await load();
                      })}>
                      <Icon name="trash" /><span className="fn-visually-hidden">{t('Delete note', '删除笔记')}</span>
                    </button>}
                </div>
              </div>
              {note.mode && <div className="trek-cluster">
                <span className={`trek-chip fn-note-mode fn-note-mode--${note.mode}`}>
                  {note.mode === 'live' ? t('Live reference', '实时引用') : t('Snapshot', '独立快照')}
                </span>
              </div>}
              {note.properties?.length
                ? <PropertyList properties={note.properties} updatedAt={note.updated_at} locale={context?.locale} t={t}
                  onOpenUrl={(url) => openHref(url, openReference)} />
                : null}
              <Markdown content={note.content} imageSources={imageSources} references={referenceLinks} onReference={openReference} />
              <hr />
              {tripId && <>
                <h3>{t('Copy an excerpt to the day plan', '复制摘录到原生日程')}</h3>
                <fieldset disabled={busy} className="trek-stack fn-action-form">
                  <label className="trek-label" htmlFor="day">{t('Day', '日程')}</label>
                  <DaySelect days={days} value={dayId} setValue={setDayId} emptyLabel={t('Choose a day', '选择日程')} />
                  <label className="trek-label" htmlFor="excerpt">{t('Excerpt (up to 500 characters)', '摘录（最多 500 字符）')}</label>
                  <textarea id="excerpt" className="trek-textarea" maxLength={500} value={excerpt}
                    onChange={(event) => setExcerpt(event.target.value)} />
                  <p className="trek-muted">
                    {excerpt.length}/500 · {t('Creates a separate day note. Never changes the original.', '创建一条独立日程笔记，不修改原文。')}
                  </p>
                  <button className="trek-btn trek-btn--primary" disabled={!dayId || !excerpt.trim()} onClick={() => void run(async () => {
                    if (!await trek.confirm({ message: t('Create a new day note with this excerpt?', '将这段摘录创建为新的日程笔记？') })) return;
                    await post('/trip', { action: 'excerpt', trip_id: tripId, note_id: note.id, day_id: dayId, text: excerpt });
                    setStatus(t('Copied to the day plan.', '已复制到日程。'));
                  })}>{t('Copy excerpt', '复制摘录')}</button>
                  <button className="trek-btn trek-btn--danger" onClick={() => void run(async () => {
                    if (!await trek.confirm({
                      message: t('Remove from this trip? The original stays in the library.', '从旅行中移除？图书馆中的原文会保留。'), danger: true
                    })) return;
                    await post('/trip', { action: 'unlink', trip_id: tripId, note_id: note.id }); setNote(null); await load();
                  })}>{t('Remove from trip', '从旅行移除')}</button>
                </fieldset>
              </>}
            </>}
          </>}
      </section>
    </div>
    {permissionFolder && <div className="fn-modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) void closeFolderPermissions();
    }}>
      <section ref={permissionModal} className="fn-modal trek-card" role="dialog" aria-modal="true"
        aria-labelledby="folder-permission-title">
        <header className="fn-modal-header">
          <div>
            <h2 id="folder-permission-title">{t('Folder permissions', '文件夹权限')}</h2>
            <p className="fn-modal-folder-name trek-muted">{permissionFolder.name}</p>
          </div>
          <button type="button" className="fn-modal-close" aria-label={t('Close', '关闭')} title={t('Close', '关闭')}
            onClick={() => void closeFolderPermissions()}><Icon name="close" /></button>
        </header>
        <div className="fn-modal-folder-settings">
          <FolderSettings folder={permissionFolder} idPrefix="modal-folder" t={t} {...folderSettingsActions(permissionFolder)} />
        </div>
        <section className="fn-modal-section" aria-labelledby="folder-members-title">
          <div className="fn-modal-section-heading">
            <h3 id="folder-members-title">{t('People with access', '可访问成员')}</h3>
            <p className="trek-muted">{t('Choose who can see this folder.', '选择可以查看此文件夹的成员。')}</p>
          </div>
          {folderMemberEditor(t('Add people', '添加成员'))}
        </section>
      </section>
    </div>}
  </main>;
}

type IconName = 'folder' | 'folder-plus' | 'folder-drop' | 'note' | 'library' | 'plus' | 'refresh' | 'search' | 'sort' | 'check'
  | 'trash' | 'edit' | 'settings' | 'more' | 'close' | 'chevron-left' | 'chevron-right';
function Icon({ name }: { name: IconName }) {
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
    'chevron-left': <path d="m15 5-7 7 7 7" />,
    'chevron-right': <path d="m9 5 7 7-7 7" />,
  };
  return <svg className="fn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"
    strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

// Icon and visibility of one owned folder, shared by the side panel and the permissions dialog.
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
        onChange={(event) => onVisibility(event.target.value)}>
        <option value="private">{t('Private folder', '私有文件夹')}</option><option value="public">{t('Public folder', '公有文件夹')}</option>
      </select>
    </div>
  </>;
}

function openHref(href: string, onReference: (id: string) => void) {
  if (/^fieldnotes:\/\/note\/[0-9a-f-]{36}$/i.test(href)) onReference(href.slice('fieldnotes://note/'.length));
  else if (/^https?:\/\//i.test(href)) trek.openExternal(new URL(href).href);
}

function MarkdownEditor({ value, imageSources = {}, references = {}, onChange, onReference, onImageFiles, t, collab }: {
  value: string; imageSources?: ImageSources; references?: ReferenceLinks;
  onChange: (value: string) => void; onReference: (id: string) => void;
  onImageFiles: (files: File[], insert: (markdown: string) => void) => void; t: Translate; collab?: Extension[];
}) {
  const host = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const editor = useRef<ReturnType<typeof createLiveEditor> | null>(null);
  const handlers = useRef({ onChange, onReference, onImageFiles, t });
  handlers.current = { onChange, onReference, onImageFiles, t };
  const addFiles = (files: File[]) => handlers.current.onImageFiles(files, (markdown) => editor.current?.insertImage(markdown));
  useEffect(() => {
    editor.current = createLiveEditor(host.current!, value, { labelledBy: 'content-label', collab, onImageFiles: addFiles,
      onPickImage: () => picker.current?.click(), t: (en, zh, vars) => handlers.current.t(en, zh, vars),
      onChange: (markdown) => handlers.current.onChange(markdown), onOpenLink: (href) => openHref(href, handlers.current.onReference) });
    return () => { editor.current?.destroy(); editor.current = null; };
  }, []);
  // In collab mode the shared document owns the text; pushing `value` back would fight remote edits.
  useEffect(() => { if (!collab) editor.current?.setValue(value); }, [value]);
  useEffect(() => { editor.current?.setAssets({ imageSources, references }); }, [imageSources, references]);
  return <>
    <div id="content-editor" ref={host} className="fn-editor-canvas" />
    <input ref={picker} className="fn-image-picker" type="file" accept="image/*" multiple hidden onChange={(event) => {
      const files = imageFiles(event.target.files); event.target.value = '';
      if (files.length) addFiles(files);
    }} />
  </>;
}

function DaySelect({ days, value, setValue, emptyLabel }: {
  days: Day[]; value: string; setValue: (value: string) => void; emptyLabel: string
}) {
  return <select id="day" data-trek-native className="trek-select" value={value} onChange={(event) => setValue(event.target.value)}>
    <option value="">{emptyLabel}</option>
    {days.map((day) => <option key={day.id} value={day.id}>{day.date || `Day ${day.day_number || day.id}`} {day.title}</option>)}
  </select>;
}

function Markdown({ content, imageSources = {}, references = {}, onReference }: {
  content: string; imageSources?: ImageSources; references?: ReferenceLinks; onReference: (id: string) => void
}) {
  const article = useRef<HTMLElement>(null);
  useEffect(() => {
    if (article.current) renderMarkdownInto(article.current, content, imageSources, references);
  }, [content, imageSources, references]);
  return <article ref={article} className="fn-markdown" onClick={(event) => {
    const anchor = (event.target as HTMLElement).closest('a');
    if (!anchor) return;
    event.preventDefault(); openHref(anchor.getAttribute('href') || '', onReference);
  }} />;
}

createRoot(document.getElementById('root')!).render(<App />);
