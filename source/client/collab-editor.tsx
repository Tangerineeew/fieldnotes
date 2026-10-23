import React, { useEffect, useReducer, useState } from 'react';
import { CollabSession, propertiesOf, replaceText, setProperties, type CollabStatus } from './collab';
import { PropertyEditor } from './properties';
import { IconPicker } from './note-icon';
import { Avatar } from './collaborators';
import { FolderField, VisibilityField, type FolderOption, type Visibility } from './note-fields';
import type { Translate } from './i18n';
import type { Invoke } from './api';


type Props = {
  noteId: string; visibility: Visibility; folderId: string | null; isOwner: boolean; folders: FolderOption[]; invoke: Invoke; t: Translate;
  renderEditor: (session: CollabSession) => React.ReactNode;
  onVisibility: (value: Visibility) => Promise<void>; onFolder: (folderId: string | null) => Promise<void>; onDone: () => Promise<void>;
};

export function CollabEditor({ noteId, visibility, folderId, isOwner, folders, invoke, t,
  renderEditor, onVisibility, onFolder, onDone }: Props) {
  const [session, setSession] = useState<CollabSession | null>(null);
  const [failure, setFailure] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [closing, setClosing] = useState(false);
  const [, refresh] = useReducer((count: number) => count + 1, 0);

  useEffect(() => {
    let alive = true;
    setSession(null); setFailure('');
    const next = new CollabSession(noteId, invoke, refresh, (message) => alive && setFailure(message));
    next.title.observe(refresh); next.properties.observeDeep(refresh); next.meta.observe(refresh);
    next.start().then(() => { if (alive) setSession(next); }).catch((error) =>
      alive && setFailure(error instanceof Error ? error.message : String(error)));
    const warn = (event: BeforeUnloadEvent) => { if (next.unsaved) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => { alive = false; window.removeEventListener('beforeunload', warn); void next.stop(); };
  }, [noteId, attempt]);

  async function finish() {
    setClosing(true);
    try { await session?.stop(); await onDone(); } finally { setClosing(false); }
  }

  const statusText: Record<CollabStatus, string> = {
    connecting: t('Connecting…', '连接中…'), synced: t('All changes saved', '已自动保存'),
      saving: t('Saving…', '保存中…'),
    offline: t('Offline — retrying…', '离线，正在重试…'), failed: t('Not saved', '未保存'),
  };
  if (failure) {
    return <div className="fn-collab-failure" role="alert"><p>{t('Live editing stopped: ', '实时编辑已停止：')}{failure}</p>
      <p className="trek-muted">{t('Changes made after this point were not saved. Rejoin to continue from the latest version.',
        '此后的改动未能保存。重新加入会从最新版本继续。')}</p>
      <div className="trek-cluster"><button type="button" className="trek-btn trek-btn--primary"
        onClick={() => setAttempt((count) => count + 1)}>{t('Rejoin', '重新加入')}</button>
        <button type="button" className="trek-btn trek-btn--ghost"
          onClick={() => void onDone()}>{t('Close editor', '关闭编辑器')}</button></div></div>;
  }
  if (!session) return <p className="trek-muted fn-collab-connecting" role="status">{statusText.connecting}</p>;

  return <div className="trek-stack fn-collab">
    <div className="fn-collab-bar">
      <div className="fn-collab-people" aria-label={t('People editing', '正在编辑的成员')}>
        {session.peers.length > 0 && <span className="fn-collab-avatars">{session.peers.map((peer) =>
          <Avatar key={peer.client_id} className="fn-collab-avatar" name={peer.name} color={peer.color} />)}</span>}
        <span className="trek-muted">{session.peers.length
          ? t('Others editing: {count}', '另有 {count} 人在编辑', { count: session.peers.length })
          : t('Only you', '仅你一人')}</span>
      </div>
      <span className={`fn-collab-status fn-collab-status--${session.status}`} role="status">{statusText[session.status]}</span>
    </div>
    <IconPicker icon={session.meta.get('icon') ?? null} t={t}
      onChange={(icon) => session.doc.transact(() => { if (icon) session.meta.set('icon', icon); else session.meta.delete('icon'); })} />
    <label className="trek-label" htmlFor="title">{t('Title', '标题')}</label>
    <input id="title" className="trek-input" maxLength={160} value={session.title.toString()}
      onChange={(event) => replaceText(session.title, event.target.value)} />
    <span className="trek-label">{t('Properties', '属性')}</span>
    <PropertyEditor properties={propertiesOf(session)} onChange={(next) => setProperties(session, next)} t={t} />
    {isOwner && <>
      <VisibilityField value={visibility} onChange={(value) => void onVisibility(value)} t={t} />
      <FolderField value={folderId} folders={folders} onChange={(value) => void onFolder(value)} t={t} />
    </>}
    <label id="content-label" className="trek-label" htmlFor="content-editor">Markdown</label>
    {renderEditor(session)}
    <div className="trek-cluster"><button type="button" className="trek-btn trek-btn--primary" disabled={closing}
      onClick={() => void finish()}>{t('Done', '完成')}</button></div>
  </div>;
}
