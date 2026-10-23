import React, { useEffect, useRef, useState } from 'react';
import type { Translate } from './i18n';


export type PropertyType = 'text' | 'number' | 'date' | 'select' | 'multi_select' | 'checkbox' | 'url' | 'checklist' | 'last_edited';
export type PropertyOption = { id: string; name: string; color: number };
export type ChecklistItem = { text: string; done: boolean };
export type Property = { id: string; name: string; type: PropertyType; value: unknown; options?: PropertyOption[] };

const COLORS = 8;
const TYPES: PropertyType[] = ['text', 'number', 'date', 'select', 'multi_select', 'checkbox', 'url', 'checklist', 'last_edited'];
const newId = () => Math.random().toString(36).slice(2, 10);
const initialValue: Record<PropertyType, unknown> = {
  text: '', number: null, date: null, select: null, multi_select: [], checkbox: false, url: '', checklist: [], last_edited: null,
};
const typeLabel = (type: PropertyType, t: Translate) => ({
  text: t('Text', '文本'), number: t('Number', '数字'), date: t('Date', '日期'), select: t('Select', '单选'),
  multi_select: t('Multi-select', '多选'), checkbox: t('Checkbox', '复选框'), url: t('URL', '链接'),
  checklist: t('Checklist', '清单'), last_edited: t('Last edited', '最后编辑'),
})[type];
const checklistOf = (property: Property) => (Array.isArray(property.value) ? property.value : []) as ChecklistItem[];
const selectedOf = (property: Property) =>
  (property.type === 'select' ? [property.value] : Array.isArray(property.value) ? property.value : []) as string[];

// Chosen select/multi-select option names, used as the note's labels in lists.
export const selectedLabels = (properties: Property[] = []) =>
  properties.flatMap((property) => property.type === 'select' || property.type === 'multi_select'
  ? (property.options || []).filter((option) => selectedOf(property).includes(option.id)).map((option) => option.name) : []);

function TypeIcon({ type }: { type: PropertyType }) {
  if (type === 'text') return <span className="fn-prop-glyph" aria-hidden="true">Aa</span>;
  if (type === 'number') return <span className="fn-prop-glyph" aria-hidden="true">123</span>;
  const paths: Record<string, React.ReactNode> = {
    date: <><rect x="4" y="5.5" width="16" height="14" rx="2" /><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" /></>,
    select: <><circle cx="12" cy="12" r="8" /><path d="m9 11 3 3 3-3" /></>,
    multi_select: <><path d="M9 7h11M9 12h11M9 17h11" /><circle cx="4.8" cy="7" r=".9" />
      <circle cx="4.8" cy="12" r=".9" /><circle cx="4.8" cy="17" r=".9" /></>,
    checkbox: <><rect x="4.5" y="4.5" width="15" height="15" rx="3" /><path d="m8.5 12.2 2.4 2.4 4.6-5" /></>,
    url: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
    checklist: <><circle cx="12" cy="12" r="8" /><path d="m8.8 12.2 2.2 2.2 4.4-4.6" /></>,
    last_edited: <><circle cx="12" cy="12" r="8" /><path d="M12 7.5V12l3 2" /></>,
  };
  return <svg className="fn-prop-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[type]}</svg>;
}

function Chip({ option }: { option: PropertyOption }) {
  return <span className={`fn-prop-chip fn-prop-color-${option.color % COLORS}`}>{option.name}</span>;
}

function Progress({ items }: { items: ChecklistItem[] }) {
  const percent = items.length ? Math.round(items.filter((item) => item.done).length / items.length * 100) : 0;
  return <span className="fn-prop-progress"><span className="fn-prop-progress-bar"
    aria-hidden="true"><span style={{ width: `${percent}%` }} /></span><span>{percent}%</span></span>;
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
    const option = existing || { id: newId(), name, color: options.length % COLORS };
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
      <button type="button" className={`fn-prop-chip fn-prop-color-${option.color % COLORS}`} aria-pressed={selected.includes(option.id)}
        onClick={() => onChange({ ...property, value: choose(option.id) })}>{option.name}</button>
      <button type="button" className="fn-prop-option-remove" aria-label={t('Remove option {name}', '删除选项{name}', { name: option.name })}
        onClick={() => remove(option.id)}>×</button>
    </span>)}
    <input className="trek-input fn-prop-option-input" maxLength={40} value={draft} placeholder={t('Add option', '添加选项')}
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
      <button type="button" className="fn-prop-option-remove" aria-label={t('Remove item', '删除项目')}
        onClick={() => set(items.filter((_entry, i) => i !== index))}>×</button>
    </div>)}
    <button type="button" className="trek-btn trek-btn--ghost fn-prop-add-item" disabled={items.length >= 50}
      onClick={() => set([...items, { text: '', done: false }])}>{t('+ Add item', '+ 添加项目')}</button>
  </div>;
}

function ValueEditor({ property, onChange, t }: { property: Property; onChange: (next: Property) => void; t: Translate }) {
  const set = (value: unknown) => onChange({ ...property, value });
  const label = { 'aria-label': property.name };
  switch (property.type) {
    case 'text': return <input className="trek-input" maxLength={2000} value={String(property.value ?? '')}
      onChange={(event) => set(event.target.value)} {...label} />;
    case 'number': return <input className="trek-input" type="number" value={typeof property.value === 'number' ? property.value : ''}
      onChange={(event) => set(event.target.value === '' ? null : Number(event.target.value))} {...label} />;
    case 'date': return <input className="trek-input" type="date" value={String(property.value ?? '')}
      onChange={(event) => set(event.target.value || null)} {...label} />;
    case 'checkbox': return <input type="checkbox" className="fn-prop-check" checked={property.value === true}
      onChange={(event) => set(event.target.checked)} {...label} />;
    case 'url': return <input className="trek-input" type="url" maxLength={2000} placeholder="https://" value={String(property.value ?? '')}
      onChange={(event) => set(event.target.value)} {...label} />;
    case 'select': case 'multi_select': return <OptionPicker property={property} onChange={onChange} t={t} />;
    case 'checklist': return <ChecklistEditor property={property} onChange={onChange} t={t} />;
    case 'last_edited': return <span className="fn-prop-empty">{t('Updated automatically', '自动更新')}</span>;
  }
}

export function PropertyEditor({ properties, onChange, t }: { properties: Property[];
  onChange: (next: Property[]) => void; t: Translate }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) setMenuOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menuOpen]);
  const replace = (index: number, next: Property) => onChange(properties.map((property, i) => i === index ? next : property));
  function add(type: PropertyType) {
    setMenuOpen(false);
    onChange([...properties, { id: newId(), name: typeLabel(type, t), type, value: initialValue[type],
      ...(type === 'select' || type === 'multi_select' ? { options: [] } : {}) }]);
  }
  return <div className="fn-prop-editor">
    {properties.map((property, index) => <div className="fn-prop-edit-row" key={property.id}>
      <span className="fn-prop-edit-type" title={typeLabel(property.type, t)}><TypeIcon type={property.type} /></span>
      <input className="trek-input fn-prop-name" maxLength={40} value={property.name} aria-label={t('Property name', '属性名称')}
        onChange={(event) => replace(index, { ...property, name: event.target.value })} />
      <div className="fn-prop-value"><ValueEditor property={property} onChange={(next) => replace(index, next)} t={t} /></div>
      <button type="button" className="fn-prop-remove" aria-label={t('Remove {name}', '删除{name}', { name: property.name })}
        onClick={() => onChange(properties.filter((_item, i) => i !== index))}>×</button>
    </div>)}
    <div className="fn-prop-add" ref={menu}>
      <button type="button" className="trek-btn trek-btn--ghost" aria-haspopup="menu" aria-expanded={menuOpen}
        disabled={properties.length >= 30} onClick={() => setMenuOpen((open) => !open)}>{t('+ Add property', '+ 添加属性')}</button>
      {menuOpen && <div className="fn-folder-menu fn-prop-menu" role="menu">{TYPES.map((type) =>
        <button key={type} type="button" role="menuitem" onClick={() => add(type)}>
        <TypeIcon type={type} />{typeLabel(type, t)}</button>)}</div>}
    </div>
  </div>;
}
