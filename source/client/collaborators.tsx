import React, { useState } from 'react';
import type { Translate } from './i18n';
import { firstGrapheme } from './note-icon';


export type Role = 'editor' | 'viewer';
export type Person = { id: number; username?: string; display_name?: string | null; color?: string };
export type Collaborator = { user_id: number; role: Role; user: Person };

export const personName = (person: Person) => person.display_name || person.username || `#${person.id}`;

// A person's initial on their colour. TREK's avatar images need a signed-in request and same-origin access, and
// neither the sandboxed page nor the plugin server has that, so photos cannot be shown here.
export function Avatar({ name, color, className = '' }: { name: string; color?: string; className?: string }) {
  return <span className={`fn-avatar ${className}`} style={{ '--peer': color || 'var(--accent)' } as React.CSSProperties} title={name}
    aria-hidden="true">{firstGrapheme(name).toUpperCase()}</span>;
}


// Who can access one note or folder: one list of everyone who has access and every trip companion who could, each with a
// staged choice of role, saved together. "No access" both declines and removes.
export type Choice = Role | 'none';
export function useCollaborators() {
  const [items, setItems] = useState<Collaborator[]>([]);
  const [candidates, setCandidates] = useState<Person[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Choice>>({});
  const current = (userId: number): Choice => items.find((item) => item.user_id === userId)?.role || 'none';
  const people = [...items.map((item) => item.user), ...candidates.filter((person) => !items.some((item) => item.user_id === person.id))];
  const changes = people.filter((person) => (drafts[String(person.id)] ?? current(person.id)) !== current(person.id))
    .map((person) => ({ user_id: person.id, role: drafts[String(person.id)] }));
  return {
    people, current, drafts, setDrafts, changes,
    // `null` clears everything, for viewers who may not manage access.
    show(result: { collaborators: Collaborator[]; candidates: Person[] } | null) {
      setItems((result?.collaborators || []).map((item) => ({ ...item, user: { ...item.user, id: item.user_id } })));
      setCandidates(result?.candidates || []); setDrafts({});
    },
  };
}
export type Collaborators = ReturnType<typeof useCollaborators>;


export function CollaboratorEditor({ state, busy, t, onSave }: {
  state: Collaborators; busy: boolean; t: Translate; onSave: () => void;
}) {
  const pending = state.changes.length;
  if (!state.people.length) return <p className="trek-muted fn-person-empty">{t('No people available', '暂无可选成员')}</p>;
  return <>
    <ul className="fn-collaborator-list">{state.people.map((person) => {
      const value = state.drafts[String(person.id)] ?? state.current(person.id);
      return <li key={person.id} className={value === 'none' ? 'is-none' : undefined}>
        <Avatar name={personName(person)} color={person.color} />
        <span>{personName(person)}</span>
        {/* TREK's kit moves the <select> into a wrapper, so it gets a parent of its own. */}
        <div><select className="trek-select" aria-label={t('Access for {name}', '{name}的权限', { name: personName(person) })} value={value}
          onChange={(event) => state.setDrafts((drafts) => ({ ...drafts, [String(person.id)]: event.target.value as Choice }))}>
          <option value="none">{t('No access', '无权限')}</option>
          <option value="viewer">{t('Viewer', '查看者')}</option>
          <option value="editor">{t('Editor', '编辑者')}</option>
        </select></div>
      </li>;
    })}</ul>
    <div className="fn-collaborator-bulk-actions">
      <span className="trek-muted">{pending ? t('Unsaved changes: {count}', '{count} 项未保存更改', { count: pending })
        : t('Only people who share a trip with you are listed.', '仅列出与你同行的成员。')}</span>
      <button type="button" className="trek-btn trek-btn--secondary" disabled={busy || !pending}
        onClick={onSave}>{t('Save changes', '保存更改')}</button>
    </div>
  </>;
}
