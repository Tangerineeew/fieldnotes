import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { moveInMenu, useDismiss } from './popover';
import type { Translate } from './i18n';
import { maxPropertyNameChars, maxPropertyTextChars, propertyColors } from '../shared/limits.json';


export type PropertyType = 'text' | 'number' | 'date' | 'select' | 'multi_select' | 'checkbox' | 'url' | 'checklist' | 'last_edited';
export type PropertyOption = { id: string; name: string; color: number };
export type ChecklistItem = { text: string; done: boolean };
export type Property = { id: string; name: string; type: PropertyType; value: unknown; options?: PropertyOption[] };

const TYPES: PropertyType[] = ['text', 'number', 'date', 'select', 'multi_select', 'checkbox', 'url', 'checklist', 'last_edited'];
export const newId = () => Math.random().toString(36).slice(2, 10);
const initialValue: Record<PropertyType, unknown> = {
  text: '', number: null, date: null, select: null, multi_select: [], checkbox: false, url: '', checklist: [], last_edited: null,
};
const typeLabel = (type: PropertyType, t: Translate) => ({
  text: t('Text', '文本'), number: t('Number', '数字'), date: t('Date', '日期'), select: t('Select', '单选'),
  multi_select: t('Multi-select', '多选'), checkbox: t('Checkbox', '复选框'), url: t('URL', '链接'),
  checklist: t('Checklist', '清单'), last_edited: t('Last edited', '最后编辑'),
})[type];
export const checklistOf = (property: Property) => (Array.isArray(property.value) ? property.value : []) as ChecklistItem[];
export const selectedOf = (property: Property) =>
  (property.type === 'select' ? [property.value] : Array.isArray(property.value) ? property.value : []) as string[];

function TypeIcon({ type }: { type: PropertyType }) {
  if (type === 'text') return <span className="fn-prop-glyph" aria-hidden="true">Aa</span>;
  if (type === 'number') return <span className="fn-prop-glyph" aria-hidden="true">123</span>;
  const paths: Record<string, React.ReactNode> = {
    date: <><rect x="4" y="5.5" width="16" height="14" rx="2" /><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" /></>,
    select: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" /></>,
    multi_select: <><path d="M9 7h11M9 12h11M9 17h11" /><circle cx="4.8" cy="7" r=".9" />
      <circle cx="4.8" cy="12" r=".9" /><circle cx="4.8" cy="17" r=".9" /></>,
    checkbox: <><rect x="4.5" y="4.5" width="15" height="15" rx="3" /><path d="m8.5 12.2 2.4 2.4 4.6-5" /></>,
    url: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
    checklist: <><rect x="3.5" y="4.5" width="6" height="6" rx="1.5" /><path d="m5 7.6 1.2 1.2 2-2.2M13 7.5h7.5" />
      <rect x="3.5" y="13.5" width="6" height="6" rx="1.5" /><path d="M13 16.5h7.5" /></>,
    last_edited: <><circle cx="12" cy="12" r="8" /><path d="M12 7.5V12l3 2" /></>,
  };
  return <svg className="fn-prop-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[type]}</svg>;
}

function Chip({ option }: { option: PropertyOption }) {
  return <span className={`fn-prop-chip fn-prop-color-${option.color % propertyColors}`}>{option.name}</span>;
}

function Progress({ items }: { items: ChecklistItem[] }) {
  const percent = items.length ? Math.round(items.filter((item) => item.done).length / items.length * 100) : 0;
  return <span className="fn-prop-progress"><span className="fn-prop-progress-bar"
    aria-hidden="true"><span style={{ transform: `translateX(${percent - 100}%)` }} /></span><span>{percent}%</span></span>;
}

export function PropertyList({ properties, updatedAt, locale, t, onOpenUrl }: {
  properties: Property[]; updatedAt?: string; locale?: string; t: Translate; onOpenUrl: (url: string) => void;
}) {
  const empty = <span className="fn-prop-empty">{t('Empty', '空')}</span>;
  const display = (property: Property) => {
    const { value } = property;
    switch (property.type) {
      case 'text': return value ? String(value) : empty;
      case 'number': return typeof value === 'number' ? value.toLocaleString(locale) : empty;
      case 'date': return value ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(`${value}T00:00:00`)) : empty;
      case 'select': case 'multi_select': {
        const chosen = (property.options || []).filter((option) => selectedOf(property).includes(option.id));
        return chosen.length ? <span className="fn-prop-chips">{chosen.map((option) =>
          <Chip key={option.id} option={option} />)}</span> : empty;
      }
      // Disabled native checkboxes render grey in every theme, so the read view draws its own mark.
      case 'checkbox': return <span className={`fn-prop-mark${value === true ? ' is-checked' : ''}`} role="img"
        aria-label={value === true ? t('Checked', '已勾选') : t('Unchecked', '未勾选')}>
        {value === true && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="m6.5 12.5 3.6 3.6 7.4-8" /></svg>}</span>;
      case 'url': return value ? <button type="button" className="fn-prop-link"
        onClick={() => onOpenUrl(String(value))}>{String(value).replace(/^https?:\/\//, '')}</button> : empty;
      case 'checklist': {
        const items = checklistOf(property);
        return items.length ? <span className="fn-prop-checklist"><Progress items={items} />
          <ul>{items.map((item, index) =>
            <li key={index} className={item.done ? 'is-done' : undefined}>{item.text}</li>)}</ul></span> : empty;
      }
      case 'last_edited': return updatedAt ?
        new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(updatedAt)) : empty;
    }
  };
  return <dl className="fn-props">{properties.map((property) => <div className="fn-prop-row" key={property.id}>
    <dt><TypeIcon type={property.type} /><span>{property.name}</span></dt><dd>{display(property)}</dd>
  </div>)}</dl>;
}

function RemoveButton({ className, label, onClick }: { className: string; label: string; onClick: () => void }) {
  return <button type="button" className={className} aria-label={label} title={label} onClick={onClick}><Icon name="close" /></button>;
}

function OptionPicker({ property, onChange, t }: { property: Property; onChange: (next: Property) => void; t: Translate }) {
  const [draft, setDraft] = useState('');
  const options = property.options || []; const selected = selectedOf(property);
  const choose = (id: string, values = selected) => {
    const on = values.includes(id);
    return property.type === 'select' ? (on ? null : id) : on ? values.filter((item) => item !== id) : [...values, id];
  };
  function add() {
    const name = draft.trim();
    if (!name) return;
    const existing = options.find((option) => option.name.toLowerCase() === name.toLowerCase());
    const option = existing || { id: newId(), name, color: options.length % propertyColors };
    onChange({ ...property, options: existing ? options : [...options, option],
      value: selected.includes(option.id) ? property.value : choose(option.id) });
    setDraft('');
  }
  function remove(id: string) {
    const value = property.type === 'select' ? (property.value === id ? null : property.value) : selected.filter((item) => item !== id);
    onChange({ ...property, options: options.filter((option) => option.id !== id), value });
  }
  return <div className="fn-prop-options">
    {options.map((option) => <span key={option.id} className={`fn-prop-option${selected.includes(option.id) ? ' is-selected' : ''}`}>
      <button type="button" className={`fn-prop-chip fn-prop-color-${option.color % propertyColors}`}
        aria-pressed={selected.includes(option.id)} onClick={() => onChange({ ...property, value: choose(option.id) })}>{option.name}</button>
      <RemoveButton className="fn-prop-option-remove" label={t('Remove option {name}', '删除选项{name}', { name: option.name })}
        onClick={() => remove(option.id)} />
    </span>)}
    <input className="trek-input fn-prop-option-input" maxLength={maxPropertyNameChars} value={draft}
      placeholder={t('Type an option, then press Enter', '输入选项，按回车添加')}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} onBlur={add} />
  </div>;
}

function ChecklistEditor({ property, onChange, t }: { property: Property; onChange: (next: Property) => void; t: Translate }) {
  const items = checklistOf(property);
  const set = (next: ChecklistItem[]) => onChange({ ...property, value: next });
  return <div className="fn-prop-checklist-editor">
    {items.length > 0 && <Progress items={items} />}
    {items.map((item, index) => <div className="fn-prop-checklist-row" key={index}>
      <input type="checkbox" checked={item.done} aria-label={item.text}
        onChange={(event) => set(items.map((entry, i) => i === index ? { ...entry, done: event.target.checked } : entry))} />
      <input className="trek-input" maxLength={200} value={item.text}
        onChange={(event) => set(items.map((entry, i) => i === index ? { ...entry, text: event.target.value } : entry))} />
      <RemoveButton className="fn-prop-option-remove" label={t('Remove item', '删除项目')}
        onClick={() => set(items.filter((_entry, i) => i !== index))} />
    </div>)}
    <button type="button" className="trek-btn trek-btn--ghost fn-prop-add-item" disabled={items.length >= 50}
      onClick={() => set([...items, { text: '', done: false }])}>{t('+ Add item', '+ 添加项目')}</button>
  </div>;
}

function ValueEditor({ property, onChange, t }: { property: Property; onChange: (next: Property) => void; t: Translate }) {
  const set = (value: unknown) => onChange({ ...property, value });
  const label = { 'aria-label': property.name };
  switch (property.type) {
    case 'text': return <input className="trek-input" maxLength={maxPropertyTextChars} value={String(property.value ?? '')}
      onChange={(event) => set(event.target.value)} {...label} />;
    case 'number': return <input className="trek-input" type="number" value={typeof property.value === 'number' ? property.value : ''}
      onChange={(event) => set(event.target.value === '' ? null : Number(event.target.value))} {...label} />;
    case 'date': return <input className="trek-input" type="date" value={String(property.value ?? '')}
      onChange={(event) => set(event.target.value || null)} {...label} />;
    case 'checkbox': return <input type="checkbox" className="fn-prop-check" checked={property.value === true}
      onChange={(event) => set(event.target.checked)} {...label} />;
    case 'url': return <input className="trek-input" type="url" maxLength={maxPropertyTextChars} placeholder="https://"
      value={String(property.value ?? '')} onChange={(event) => set(event.target.value)} {...label} />;
    case 'select': case 'multi_select': return <OptionPicker property={property} onChange={onChange} t={t} />;
    case 'checklist': return <ChecklistEditor property={property} onChange={onChange} t={t} />;
    case 'last_edited': return <span className="fn-prop-empty">{t('Updated automatically', '自动更新')}</span>;
  }
}

function PropertyEditor({ properties, onChange, t }: { properties: Property[]; onChange: (next: Property[]) => void; t: Translate }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismiss(menuOpen, menu, () => setMenuOpen(false), trigger);
  // The menu takes focus as it opens, as a context menu does, and gives it back to its button when Tab leaves it.
  useEffect(() => { if (menuOpen) menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus(); }, [menuOpen]);
  const replace = (index: number, next: Property) => onChange(properties.map((property, i) => i === index ? next : property));
  function onMenuKey(event: React.KeyboardEvent<HTMLDivElement>) {
    if (moveInMenu(event, event.currentTarget) || event.key !== 'Tab') return;
    event.preventDefault(); setMenuOpen(false); trigger.current?.focus();
  }
  function add(type: PropertyType) {
    setMenuOpen(false);
    onChange([...properties, { id: newId(), name: typeLabel(type, t), type, value: initialValue[type],
      ...(type === 'select' || type === 'multi_select' ? { options: [] } : {}) }]);
  }
  return <div className="fn-prop-editor">
    {properties.map((property, index) => <div className="fn-prop-edit-row" key={property.id}>
      <span className="fn-prop-edit-type" title={typeLabel(property.type, t)}><TypeIcon type={property.type} /></span>
      <input className="trek-input fn-prop-name" maxLength={maxPropertyNameChars} value={property.name}
        aria-label={t('Property name', '属性名称')}
        onChange={(event) => replace(index, { ...property, name: event.target.value })} />
      <div className="fn-prop-value"><ValueEditor property={property} onChange={(next) => replace(index, next)} t={t} /></div>
      <RemoveButton className="fn-prop-remove" label={t('Remove {name}', '删除{name}', { name: property.name })}
        onClick={() => onChange(properties.filter((_item, i) => i !== index))} />
    </div>)}
    <div className="fn-prop-add" ref={menu}>
      <button ref={trigger} type="button" className="trek-btn trek-btn--ghost" aria-haspopup="menu" aria-expanded={menuOpen}
        disabled={properties.length >= 30} onClick={() => setMenuOpen((open) => !open)}>{t('+ Add property', '+ 添加属性')}</button>
      {menuOpen && <div className="fn-folder-menu fn-prop-menu" role="menu" onKeyDown={onMenuKey}>{TYPES.map((type) =>
        <button key={type} type="button" role="menuitem" onClick={() => add(type)}>
        <TypeIcon type={type} />{typeLabel(type, t)}</button>)}</div>}
    </div>
  </div>;
}


const COLLAPSED_KEY = 'fieldnotes:properties-collapsed';
const storedCollapsed = () => { try { return window.localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; } };

// The properties block of the editor, folded like Obsidian's: a chevron appears beside the heading on hover, and the choice is
// remembered for the next note.
export function PropertySection({ properties, onChange, t }: { properties: Property[]; onChange: (next: Property[]) => void;
  t: Translate }) {
  const [collapsed, setCollapsed] = useState(storedCollapsed);
  // The body clips only while it folds or unfolds, so an open section's menus can still overflow it.
  const [moving, setMoving] = useState(false);
  function toggle() {
    const next = !collapsed; setCollapsed(next); setMoving(true);
    try { window.localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0'); } catch { /* Folding still works for this visit. */ }
  }
  return <section className="fn-prop-section" data-collapsed={collapsed || undefined} data-moving={moving || undefined}>
    <h3 className="fn-prop-section-heading">
      <button type="button" aria-expanded={!collapsed} aria-controls="note-properties" onClick={toggle}>
        <Icon name="chevron-down" /><span>{t('Properties', '属性')}</span>
      </button>
    </h3>
    <div id="note-properties" className="fn-prop-section-body" inert={collapsed}
      onTransitionEnd={(event) => { if (event.target === event.currentTarget) setMoving(false); }}>
      <div><PropertyEditor properties={properties} onChange={onChange} t={t} /></div>
    </div>
  </section>;
}
