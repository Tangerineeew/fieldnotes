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


// Who can access one note or folder: current members with staged role edits, plus people picked to be added.
export function useCollaborators() {
  const [items, setItems] = useState<Collaborator[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Role>>({});
  const [candidates, setCandidates] = useState<Person[]>([]);
  const [candidateRoles, setCandidateRoles] = useState<Record<string, Role>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const changes = items.filter((item) => drafts[String(item.user_id)] && drafts[String(item.user_id)] !== item.role)
    .map((item) => ({ user_id: item.user_id, role: drafts[String(item.user_id)] }));
  return {
    items, drafts, setDrafts, candidates, candidateRoles, setCandidateRoles, selected, setSelected, changes,
    additions: () => selected.map((userId) => ({ user_id: Number(userId), role: candidateRoles[userId] || 'editor' })),
    // `null` clears everything, for viewers who may not manage access.
    show(result: { collaborators: Collaborator[]; candidates: Person[] } | null) {
      setItems(result?.collaborators || []); setCandidates(result?.candidates || []);
      setDrafts(Object.fromEntries((result?.collaborators || []).map((item) => [String(item.user_id), item.role])));
      setCandidateRoles(Object.fromEntries((result?.candidates || []).map((person) => [String(person.id), 'editor' as Role])));
    },
  };
}
export type Collaborators = ReturnType<typeof useCollaborators>;


// Member list with staged roles, one bulk save, and a picker to add people; `addLabel` adds the modal's heading.
export function CollaboratorEditor({ state, busy, t, removeLabel, addLabel, onAdd, onRemove, onSave }: {
  state: Collaborators; busy: boolean; t: Translate; removeLabel: React.ReactNode; addLabel?: string;
  onAdd: () => void; onRemove: (userId: number) => void; onSave: () => void;
}) {
  const roleOptions =
    <><option value="editor">{t('Editor', '编辑者')}</option><option value="viewer">{t('Viewer', '查看者')}</option></>;
  const pending = state.changes.length;
  return <>
    {state.items.length > 0 && <ul className="fn-collaborator-list">{state.items.map((item) => <li key={item.user_id}>
      <span>{personName(item.user)}</span>
      <select className="trek-select" value={state.drafts[String(item.user_id)] || item.role}
        onChange={(event) =>
          state.setDrafts((current) => ({ ...current, [String(item.user_id)]: event.target.value as Role }))}>{roleOptions}</select>
      <button type="button" className="trek-btn trek-btn--ghost" aria-label={t('Remove', '移除')}
        onClick={() => onRemove(item.user_id)}>{removeLabel}</button>
    </li>)}</ul>}
    {state.items.length > 0 && <div className="fn-collaborator-bulk-actions">
      <span className="trek-muted">{pending ? t('Unsaved changes: {count}', '{count} 项未保存更改', { count: pending })
        : t('Edit roles, then save once.', '修改角色后一次保存。')}</span>
      <button type="button" className="trek-btn trek-btn--secondary" disabled={busy || !pending}
        onClick={onSave}>{t('Save changes', '保存更改')}</button>
    </div>}
    <form className={addLabel ? 'fn-collaborator-form fn-modal-add-form' : 'fn-collaborator-form'}
      onSubmit={(event) => { event.preventDefault(); onAdd(); }}>
      {addLabel && <div className="fn-modal-add-label">{addLabel}</div>}
      <PersonRolePicker label={t('Choose people', '选择成员')}
        people={state.candidates.filter((person) => !state.items.some((item) => item.user_id === person.id))}
        selected={state.selected} roles={state.candidateRoles} onChange={state.setSelected} t={t}
        onRoleChange={(id, role) => state.setCandidateRoles((current) => ({ ...current, [id]: role }))} />
      <small className="trek-muted fn-person-hint">
        {t('Only people who share a trip with you are listed.', '仅列出与你同行的成员。')}
      </small>
      <button className="trek-btn trek-btn--secondary" disabled={!state.selected.length}>{t('Add selected', '添加选中成员')}</button>
    </form>
  </>;
}


function PersonRolePicker({ label, people, selected, roles, onChange, onRoleChange, t }: {
  label: string; people: Person[]; selected: string[]; roles: Record<string, Role>;
  onChange: (value: string[]) => void; onRoleChange: (id: string, role: Role) => void; t: Translate;
}) {
  return <div className="fn-person-picker" role="group" aria-label={label}>
    {people.length ? people.map((person) => {
      const value = String(person.id); const checked = selected.includes(value);
      return <div className="fn-person-role-row" key={person.id}>
        <label className="fn-person-option"><input type="checkbox" checked={checked}
          onChange={(event) => onChange(event.target.checked ? [...selected, value]
            : selected.filter((item) => item !== value))} /><span>{personName(person)}</span></label>
        <select className="trek-select fn-person-role-select" aria-label={`${personName(person)} role`} value={roles[value] || 'editor'}
          onChange={(event) => onRoleChange(value, event.target.value as Role)}>
          <option value="editor">{t('Editor', '编辑者')}</option><option value="viewer">{t('Viewer', '查看者')}</option>
        </select>
      </div>;
    }) : <span className="trek-muted fn-person-empty">{t('No people available', '暂无可选成员')}</span>}
  </div>;
}
