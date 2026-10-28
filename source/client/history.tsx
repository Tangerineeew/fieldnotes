import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { NoteIcon } from './note-icon';
import type { Invoke } from './api';
import type { Translate } from './i18n';
import type { Property } from './properties';


type Editor = { id: number; name: string };
type Entry = { id: string; edited_at: string; editors: Editor[]; title: string; icon?: string | null };
type Listing = { current: Omit<Entry, 'id' | 'icon'>; versions: Entry[] };
export type Version = { id: string; edited_at: string; title: string; icon: string | null; properties: Property[]; content: string };

const dayKey = (value: string) => new Date(value).toDateString();

// The body of the version history window: versions grouped by day on one side, the chosen one read on the other. On a phone
// the two take turns. The current text heads the list and cannot be restored; restoring keeps it as a version first.
export function HistoryView({ noteId, current, invoke, locale, t, busy, render, onRestore }: {
  noteId: string; current: { title: string; content: string; icon?: string | null }; invoke: Invoke; locale?: string;
  t: Translate; busy: boolean; render: (content: string, versionId: string | null) => React.ReactNode;
  onRestore: (version: Version) => void;
}) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [failure, setFailure] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const versions = useRef(new Map<string, Version>());
  const [version, setVersion] = useState<Version | null>(null);
  useEffect(() => {
    invoke<Listing>(`/history?note_id=${encodeURIComponent(noteId)}`)
      .then(setListing, (error) => setFailure(String(error?.message || error)));
  }, [noteId]);
  useEffect(() => {
    if (!chosen) { setVersion(null); return; }
    const known = versions.current.get(chosen);
    if (known) { setVersion(known); return; }
    let alive = true; setVersion(null);
    invoke<Version>(`/version?note_id=${encodeURIComponent(noteId)}&id=${encodeURIComponent(chosen)}`).then((found) => {
      versions.current.set(found.id, found); if (alive) setVersion(found);
    }, (error) => alive && setFailure(String(error?.message || error)));
    return () => { alive = false; };
  }, [chosen]);

  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const names = (editors: Editor[]) => {
    const list = editors.map((editor) => editor.name);
    try { return new Intl.ListFormat(locale, { type: 'conjunction' }).format(list); } catch { return list.join(', '); }
  };
  const today = dayKey(new Date().toISOString()); const yesterday = dayKey(new Date(Date.now() - 86400000).toISOString());
  const dayLabel = (value: string) => dayKey(value) === today ? t('Today', '今天')
    : dayKey(value) === yesterday ? t('Yesterday', '昨天') : date.format(new Date(value));
  const groups: { label: string; entries: Entry[] }[] = [];
  for (const entry of listing?.versions || []) {
    const label = dayLabel(entry.edited_at);
    if (groups.at(-1)?.label === label) groups.at(-1)!.entries.push(entry); else groups.push({ label, entries: [entry] });
  }
  const choose = (id: string | null) => { setChosen(id); setReading(true); };
  const shown = chosen ? version : { title: current.title, content: current.content, icon: current.icon ?? null };

  if (failure) return <p className="fn-history-failure" role="alert">{failure}</p>;
  return <div className="fn-history" data-reading={reading || undefined}>
    <nav className="fn-history-list" aria-label={t('Versions', '版本')} aria-busy={!listing}>
      <button type="button" className="fn-history-entry" aria-current={chosen === null || undefined} onClick={() => choose(null)}>
        <strong>{t('Current version', '当前版本')}</strong>
        {listing && <span className="trek-muted">{dayLabel(listing.current.edited_at)} · {time.format(new Date(listing.current.edited_at))}
          {listing.current.editors.length > 0 && ` · ${names(listing.current.editors)}`}</span>}
      </button>
      {groups.map((group) => <section key={group.label} className="fn-history-day" aria-label={group.label}>
        <h3 className="fn-history-day-label">{group.label}</h3>
        {group.entries.map((entry) => <button key={entry.id} type="button" className="fn-history-entry"
          aria-current={chosen === entry.id || undefined} onClick={() => choose(entry.id)}>
          <strong>{time.format(new Date(entry.edited_at))}</strong>
          <span className="trek-muted">
            {[entry.title !== listing!.current.title && entry.title, names(entry.editors)].filter(Boolean).join(' · ')}</span>
        </button>)}
      </section>)}
      {listing && !listing.versions.length && <p className="fn-history-empty trek-muted">
        {t('Earlier versions appear here once editing pauses.', '编辑停下来之后，较早的版本会出现在这里。')}</p>}
      <p className="fn-history-schedule">{t(
        'Kept after 10 quiet minutes or an hour of editing: all from the last day, one a day for a month, one a week for a year.',
        '编辑停下 10 分钟或连续编辑满 1 小时就留下一个版本：最近一天全部保留，一个月内每天留一个，一年内每周留一个。')}</p>
    </nav>
    <article className="fn-history-reader" aria-live="polite" aria-busy={Boolean(chosen && !version)}>
      <div className="fn-history-reader-bar">
        <button type="button" className="fn-history-back" aria-label={t('Versions', '版本')} title={t('Versions', '版本')}
          onClick={() => setReading(false)}><Icon name="chevron-left" /></button>
        <span className="fn-history-when trek-muted">{chosen ? version && `${dayLabel(version.edited_at)} · ${time.format(
          new Date(version.edited_at))}` : t('Current version', '当前版本')}</span>
        {chosen && version && <button type="button" className="trek-btn trek-btn--primary" disabled={busy}
          onClick={() => onRestore(version)}><Icon name="reopen" />{t('Restore this version', '恢复此版本')}</button>}
      </div>
      {shown && <>
        {shown.icon && <NoteIcon icon={shown.icon} className="fn-note-icon--large" />}
        <h2 className="fn-history-title">{shown.title}</h2>
        {render(shown.content, chosen)}
      </>}
    </article>
  </div>;
}
