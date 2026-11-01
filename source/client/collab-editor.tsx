import React, { useEffect, useReducer, useRef, useState } from 'react';
import { CollabSession, propertiesOf, replaceText, setProperties, type CollabStatus } from './collab';
import { PropertySection } from './properties';
import { WritingStats } from './writing-stats';
import { IconPicker } from './note-icon';
import type { Translate } from './i18n';
import type { Invoke } from './api';
import { maxTitleChars } from '../shared/limits.json';


type Props = {
  noteId: string; locale?: string; invoke: Invoke; t: Translate; renderEditor: (session: CollabSession) => React.ReactNode;
  // The page holds the live session so leaving the note can flush it first; saves and trouble go to the page's notice.
  sessionRef: React.MutableRefObject<CollabSession | null>; onSaved: () => void; onTrouble: (text: string) => void;
  onDone: () => Promise<void>;
  // Shown while joining, so the page keeps the note's shape instead of collapsing to one line and growing back.
  connecting?: React.ReactNode;
};

// Counts follow the shared text on their own, so typing re-renders only the status line.
function LiveStats({ session, locale, t }: { session: CollabSession; locale?: string; t: Translate }) {
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  useEffect(() => { session.content.observe(refresh); return () => session.content.unobserve(refresh); }, [session]);
  return <WritingStats markdown={session.content.toString()} locale={locale} t={t} />;
}

// One floating line at the bottom centre: a lasting problem, else a slow action, else the latest message for 3s. A message that
// offers an action (Undo) stays 8s and pauses while the pointer or focus is on it, so no one has to race it. It keeps its last
// words while fading out, so the text never vanishes before the pill does.
export type Notice = { text: string; at: number; action?: { label: string; run: () => void } };
export function FloatingNotice({ message, working, trouble }: { message: Notice | null; working: string; trouble: string }) {
  const [recent, setRecent] = useState<Notice | null>(null);
  const [held, setHeld] = useState(false);
  useEffect(() => { if (message) setRecent(message); }, [message]);
  useEffect(() => {
    if (!recent || held) return;
    const timer = window.setTimeout(() => setRecent(null), recent.action ? 8000 : 3000);
    return () => window.clearTimeout(timer);
  }, [recent, held]);
  const shown: Pick<Notice, 'text' | 'action'> | null = trouble ? { text: trouble } : working ? { text: working } : recent;
  const last = useRef<Pick<Notice, 'text' | 'action'>>({ text: '' });
  if (shown) last.current = shown;
  const { text, action } = shown || last.current;
  const hold = { onPointerEnter: () => setHeld(true), onPointerLeave: () => setHeld(false),
    onFocus: () => setHeld(true), onBlur: () => setHeld(false) };
  return <div className={`fn-toast${trouble ? ' is-trouble' : ''}`} role={trouble ? 'alert' : 'status'} data-show={shown ? true : undefined}
    data-action={action && shown ? true : undefined} {...hold}>
    <span>{text}</span>
    {action && <button type="button" className="fn-toast-action" tabIndex={shown ? 0 : -1}
      onClick={() => { setRecent(null); setHeld(false); action.run(); }}>{action.label}</button>}
  </div>;
}

export function CollabEditor({ noteId, locale, invoke, t, renderEditor, sessionRef, onSaved, onTrouble, onDone, connecting }: Props) {
  const [session, setSession] = useState<CollabSession | null>(null);
  const [failure, setFailure] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [, refresh] = useReducer((count: number) => count + 1, 0);

  useEffect(() => {
    let alive = true;
    setSession(null); setFailure('');
    const next = new CollabSession(noteId, invoke, refresh, (message) => alive && setFailure(message));
    next.title.observe(refresh); next.properties.observeDeep(refresh); next.meta.observe(refresh);
    next.start().then(() => { if (alive) { sessionRef.current = next; setSession(next); } }).catch((error) =>
      alive && setFailure(error instanceof Error ? error.message : String(error)));
    const warn = (event: BeforeUnloadEvent) => { if (next.unsaved) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => {
      alive = false; window.removeEventListener('beforeunload', warn);
      if (sessionRef.current === next) sessionRef.current = null;
      void next.stop();
    };
  }, [noteId, attempt]);

  // Saving is quiet: the page's notice floats up once a save lands, and a lost connection stays on screen until it is back.
  const status = session?.status;
  const previous = useRef<CollabStatus | undefined>(undefined);
  useEffect(() => {
    if (previous.current === 'saving' && status === 'synced') onSaved();
    previous.current = status;
  }, [status]);
  const trouble = status === 'offline' ? t('Offline — retrying…', '离线，正在重试…') : status === 'failed' ? t('Not saved', '未保存') : '';
  useEffect(() => { onTrouble(trouble); }, [trouble]);
  useEffect(() => () => onTrouble(''), []);
  if (failure) {
    return <div className="fn-collab-failure" role="alert"><p>{t('Live editing stopped: ', '实时编辑已停止：')}{failure}</p>
      <p className="trek-muted">{t('Changes made after this point were not saved. Rejoin to continue from the latest version.',
        '此后的改动未能保存。重新加入会从最新版本继续。')}</p>
      <div className="trek-cluster"><button type="button" className="trek-btn trek-btn--primary"
        onClick={() => setAttempt((count) => count + 1)}>{t('Rejoin', '重新加入')}</button>
        <button type="button" className="trek-btn trek-btn--ghost"
          onClick={() => void onDone()}>{t('Close Editor', '关闭编辑器')}</button></div></div>;
  }
  if (!session) return <div className="fn-collab-connecting" aria-busy="true">{connecting}
    <p className={connecting ? 'fn-visually-hidden' : 'trek-muted'} role="status">{t('Connecting…', '连接中…')}</p></div>;

  // Collaborators show up as named cursors in the text itself, so the editor carries no presence bar. There is no "Done":
  // every change is already saved, and going back to the library or on to another note flushes the last keystrokes.
  return <div className="trek-stack fn-collab fn-writer">
    <IconPicker icon={session.meta.get('icon') ?? null} t={t}
      onChange={(icon) => session.doc.transact(() => { if (icon) session.meta.set('icon', icon); else session.meta.delete('icon'); })} />
    <label className="fn-visually-hidden" htmlFor="title">{t('Title', '标题')}</label>
    <input id="title" className="fn-title-input" maxLength={maxTitleChars} placeholder={t('Untitled', '无标题')}
      value={session.title.toString()} onChange={(event) => replaceText(session.title, event.target.value)} />
    <PropertySection properties={propertiesOf(session)} onChange={(next) => setProperties(session, next)} t={t} />
    <label id="content-label" className="fn-visually-hidden" htmlFor="content-editor">Markdown</label>
    {renderEditor(session)}
    <LiveStats session={session} locale={locale} t={t} />
  </div>;
}
