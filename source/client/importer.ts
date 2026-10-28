import { unzipSync } from 'fflate';
import {
  maxContentChars, maxProperties, maxPropertyNameChars, maxPropertyOptions, maxPropertyTextChars, maxTitleChars, propertyColors
} from '../shared/limits.json';
import { REFERENCE_PATTERN, headingLabel } from './markdown';
import { newId, type Property } from './properties';
import { RequestError } from './api';


// Brings in an Obsidian vault or any Markdown: a folder, a ZIP or loose .md files. Folders become folders under a new one named
// after the import, front matter becomes properties, `[[links]]` and `![[embeds]]` point at the imported notes by id, and images
// and PDFs the notes use are uploaded with them.
export type ImportEntry = { path: string; blob: Blob };
// `folder` fails with a 409 RequestError when its parent already has a folder by that name.
export type ImportApi = {
  folder: (name: string, parentId: string | null) => Promise<string>;
  note: (fields: { title: string; folder_id: string; properties: Property[] }) => Promise<{ id: string; version: number }>;
  write: (note: { id: string; version: number; title: string }, content: string) => Promise<void>;
  upload: (file: File) => Promise<string>;
  progress: (done: number, total: number) => void;
};
export type ImportResult = { notes: number; skipped: string[] };

const NOTE = /\.(md|markdown)$/i;
const ATTACHMENT = /\.(png|jpe?g|gif|webp|avif|pdf)$/i;
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', pdf: 'application/pdf' };
const hidden = (path: string) => path.split('/').some((part) => part.startsWith('.') || part === '__MACOSX');
const base = (path: string) => path.split('/').at(-1)!;
const stem = (path: string) => base(path).replace(/\.[^.]+$/, '');
const dir = (path: string) => path.split('/').slice(0, -1).join('/');
// A link as the editor writes it, with the `!` that makes it an embed, if any.
const LINK = new RegExp(`(!?)${REFERENCE_PATTERN.source}`, 'g');

// The files to import, paths relative to what was chosen, and a name for the folder they go into.
export async function entriesOf(files: File[]): Promise<{ name: string; entries: ImportEntry[] }> {
  let entries: ImportEntry[]; let name = '';
  if (files.length === 1 && /\.zip$/i.test(files[0].name)) {
    const unzipped = unzipSync(new Uint8Array(await files[0].arrayBuffer()));
    entries = Object.entries(unzipped).filter(([path]) => !path.endsWith('/'))
      .map(([path, bytes]) => ({ path, blob: new Blob([bytes as Uint8Array<ArrayBuffer>]) }));
    name = stem(files[0].name);
  } else entries = files.map((file) => ({ path: file.webkitRelativePath || file.name, blob: file }));
  entries = entries.filter((entry) => !hidden(entry.path));
  // A single top folder, as a chosen vault or most ZIPs have, names the import and is not repeated inside it.
  const tops = new Set(entries.map((entry) => entry.path.split('/')[0]));
  if (tops.size === 1 && entries.every((entry) => entry.path.includes('/'))) {
    name = [...tops][0];
    entries = entries.map((entry) => ({ ...entry, path: entry.path.slice(name.length + 1) }));
  }
  return { name: name || 'Imported notes', entries };
}

// Obsidian front matter, as far as notes use it: scalars, inline lists and dash lists.
export function frontMatter(text: string): { fields: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { fields: {}, body: text };
  const fields: Record<string, unknown> = {}; let key = '';
  const scalar = (raw: string): unknown => {
    const value = raw.trim().replace(/^(["'])(.*)\1$/, '$2');
    if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
    if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    return value;
  };
  for (const line of match[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && key) {
      fields[key] = [...(Array.isArray(fields[key]) ? fields[key] as unknown[] : []), scalar(item[1])]; continue;
    }
    const pair = /^([^:#\s][^:]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    key = pair[1].trim(); const value = pair[2].trim();
    fields[key] = value.startsWith('[') && value.endsWith(']')
      ? value.slice(1, -1).split(',').map((part) => scalar(part)).filter((part) => part !== '') : value ? scalar(value) : [];
  }
  return { fields, body: text.slice(match[0].length) };
}

const SKIPPED_FIELDS = new Set(['aliases', 'alias', 'cssclasses', 'cssclass', 'position', 'publish']);
// Each front matter field as the closest property: lists as multi-select, then checkbox, number, date, URL and text.
export function propertiesFromFields(fields: Record<string, unknown>): Property[] {
  const kept = Object.entries(fields).filter(([name]) => !SKIPPED_FIELDS.has(name.toLowerCase())).slice(0, maxProperties);
  return kept.flatMap(([raw, value]): Property[] => {
    const name = raw.slice(0, maxPropertyNameChars);
    if (Array.isArray(value)) {
      const options = [...new Set(value.map((item) => String(item).replace(/^#/, '').slice(0, maxPropertyNameChars)).filter(Boolean))]
        .slice(0, maxPropertyOptions).map((option, index) => ({ id: newId(), name: option, color: index % propertyColors }));
      return [{ id: newId(), name, type: 'multi_select', value: options.map((option) => option.id), options }];
    }
    if (typeof value === 'boolean') return [{ id: newId(), name, type: 'checkbox', value }];
    if (typeof value === 'number') return [{ id: newId(), name, type: 'number', value }];
    const text = String(value ?? '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return [{ id: newId(), name, type: 'date', value: text }];
    if (/^https?:\/\/\S+$/i.test(text)) return [{ id: newId(), name, type: 'url', value: text }];
    return text ? [{ id: newId(), name, type: 'text', value: text.slice(0, maxPropertyTextChars) }] : [];
  });
}

export async function importNotes(entries: ImportEntry[], name: string, parentId: string | null, api: ImportApi): Promise<ImportResult> {
  const notes = entries.filter((entry) => NOTE.test(entry.path));
  const files = new Map<string, ImportEntry>();
  for (const entry of entries.filter((item) => ATTACHMENT.test(item.path))) {
    files.set(entry.path.toLowerCase(), entry);
    if (!files.has(base(entry.path).toLowerCase())) files.set(base(entry.path).toLowerCase(), entry);
  }
  const skipped: string[] = [];
  // The import's own folder, renamed if one by that name is already there.
  let root = '';
  for (let attempt = 1; !root; attempt += 1) {
    try { root = await api.folder(attempt === 1 ? name : `${name} ${attempt}`, parentId); } catch (error) {
      if (!(error instanceof RequestError && error.code === 409) || attempt > 20) throw error;
    }
  }
  const folders = new Map<string, string>([['', root]]);
  const folderOf = async (path: string): Promise<string> => {
    if (folders.has(path)) return folders.get(path)!;
    const parent = await folderOf(dir(path));
    const created = await api.folder(base(path), parent); folders.set(path, created);
    return created;
  };
  // First every note, empty, so links between them have ids to point at.
  const created: { entry: ImportEntry; note: { id: string; version: number; title: string }; body: string }[] = [];
  const byName = new Map<string, { id: string; title: string }>();
  let done = 0; const total = notes.length * 2;
  for (const entry of notes) {
    const { fields, body } = frontMatter(await entry.blob.text());
    const title = stem(entry.path).slice(0, maxTitleChars) || 'Untitled';
    try {
      const note = await api.note({ title, folder_id: await folderOf(dir(entry.path)), properties: propertiesFromFields(fields) });
      const record = { id: note.id, title };
      created.push({ entry, note: { ...note, title }, body });
      byName.set(entry.path.replace(NOTE, '').toLowerCase(), record);
      if (!byName.has(title.toLowerCase())) byName.set(title.toLowerCase(), record);
    } catch { skipped.push(entry.path); }
    api.progress(done += 1, total);
  }
  const uploaded = new Map<string, Promise<string | null>>();
  const upload = (entry: ImportEntry) => {
    if (!uploaded.has(entry.path)) {
      const type = MIME[entry.path.split('.').at(-1)!.toLowerCase()];
      uploaded.set(entry.path, api.upload(new File([entry.blob], base(entry.path), { type }))
        .catch(() => { skipped.push(entry.path); return null; }));
    }
    return uploaded.get(entry.path)!;
  };
  const fileFor = (target: string, from: string) => {
    const path = decodeURIComponent(target.trim()).replace(/^\.\//, '');
    return files.get(`${dir(from) ? `${dir(from)}/` : ''}${path}`.toLowerCase()) || files.get(path.toLowerCase())
      || files.get(base(path).toLowerCase());
  };
  // Then their text, with links and files pointing at what was imported.
  for (const { entry, note, body } of created) {
    let content = body;
    const replacements: [string, Promise<string>][] = [];
    content = content.replace(LINK, (match, bang: string, target: string, label?: string) => {
      const [notePath, heading = ''] = target.split('#');
      // A file that is missing or would not upload stays as its name, never as an embed of a note that does not exist.
      if (/\.\w{2,5}$/.test(notePath.trim()) && !NOTE.test(notePath.trim())) {
        const file = ATTACHMENT.test(notePath) ? fileFor(notePath, entry.path) : null;
        if (!file) { skipped.push(`${entry.path} › ${notePath.trim()}`); return base(notePath.trim()); }
        const key = `\uE003${replacements.length}\uE003`;
        replacements.push([key, upload(file).then((source) => source ? `![${base(file.path)}](${source})` : base(file.path))]);
        return key;
      }
      const linked = byName.get(notePath.trim().replace(NOTE, '').toLowerCase()) || byName.get(stem(notePath.trim()).toLowerCase());
      if (!linked) return match;
      const shown = label?.trim() || headingLabel(linked.title, heading.trim());
      return `${bang}[[${linked.id}${heading ? `#${heading.trim()}` : ''}|${shown}]]`;
    });
    content = content.replace(/!\[([^\]]*)\]\((?!https?:|data:|fieldnotes:)<?([^)>\s]+)>?\)/g, (match, alt: string, target: string) => {
      const file = fileFor(target, entry.path);
      if (!file) return match;
      const key = `\uE003${replacements.length}\uE003`;
      replacements.push([key, upload(file).then((source) => source ? `![${alt || stem(file.path)}](${source})` : alt || base(file.path))]);
      return key;
    });
    // A function replacement, so a `$&` or `$1` in a file name stays as written.
    for (const [key, value] of replacements) { const text = await value; content = content.replace(key, () => text); }
    if (content.length > maxContentChars) skipped.push(entry.path);
    else if (content.trim()) { try { await api.write(note, content); } catch { skipped.push(entry.path); } }
    api.progress(done += 1, total);
  }
  return { notes: created.length, skipped };
}
