import type { Translate } from './i18n';

export type Visibility = 'private' | 'public';
export type FolderOption = { id: string; label: string };


// Visibility and folder pickers shared by the draft editor and the live co-editing panel. Each select sits in its own div:
// TREK's kit moves the <select> into a wrapper, so React must never remove or insert next to the select itself.
export function VisibilityField({ value, onChange, t }: { value: Visibility; onChange: (value: Visibility) => void; t: Translate }) {
  return <>
    <label className="trek-label" htmlFor="visibility">{t('Visibility', '可见范围')}</label>
    <div><select id="visibility" className="trek-select" value={value} onChange={(event) => onChange(event.target.value as Visibility)}>
      <option value="private">{t('Private — only me and explicit trip shares',
        '私人 · 仅自己和明确共享的旅程可见')}</option>
      <option value="public">{t('Public — readable by all signed-in users', '公开 · 所有已登录用户可阅读')}</option>
    </select></div>
  </>;
}


export function FolderField({ value, folders, onChange, t }: { value: string | null; folders: FolderOption[];
  onChange: (value: string | null) => void; t: Translate }) {
  return <>
    <label className="trek-label" htmlFor="folder">{t('Folder', '文件夹')}</label>
    <div><select id="folder" className="trek-select" value={value || ''} onChange={(event) => onChange(event.target.value || null)}>
      <option value="">{t('All notes', '全部笔记')}</option>
      {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.label}</option>)}
    </select></div>
  </>;
}
