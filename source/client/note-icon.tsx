import { useEffect, useRef, useState } from 'react';
import type { Translate } from './i18n';


const SUGGESTED = ['📝', '💡', '📍', '🗺️', '🧳', '✈️', '🚃', '🚄', '🚌', '🚕', '⛴️', '🏨',
  '🍜', '🍣', '☕', '🗾', '🏯', '⛩️', '🗻', '🌸', '🎫', '💴', '🛂', '📶'];
const IMAGE_SIZE = 128;
const MAX_ICON_CHARS = 150000;
const isImage = (icon: string) => icon.startsWith('data:image/');
// The first user-perceived character, so a flag or ZWJ emoji is never cut in half.
export const firstGrapheme = (text: string) => new Intl.Segmenter().segment(text)[Symbol.iterator]().next().value?.segment ?? '';

export function NoteIcon({ icon, className = '' }: { icon?: string | null; className?: string }) {
  if (!icon) return null;
  return isImage(icon) ? <img className={`fn-note-icon fn-note-icon--image ${className}`} src={icon} alt="" aria-hidden="true" />
    : <span className={`fn-note-icon ${className}`} aria-hidden="true">{icon}</span>;
}

// Center-crops to a square and re-encodes small, so an uploaded photo stays well under the server's 100 KB limit.
async function iconFromFile(file: File): Promise<string> {
  const source = await new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file); const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unsupported')); };
    image.src = url;
  });
  for (const [size, quality] of [[IMAGE_SIZE, 0.86], [96, 0.75], [64, 0.7]] as const) {
    const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
    const side = Math.min(source.naturalWidth, source.naturalHeight);
    canvas.getContext('2d')!.drawImage(source, (source.naturalWidth - side) / 2, (source.naturalHeight - side) / 2,
      side, side, 0, 0, size, size);
    const encoded = canvas.toDataURL('image/webp', quality);
    const icon = encoded.startsWith('data:image/webp') ? encoded : canvas.toDataURL('image/jpeg', quality);
    if (icon.length <= MAX_ICON_CHARS) return icon;
  }
  throw new Error('too-large');
}

export function IconPicker({ icon, onChange, t }: { icon: string | null; onChange: (icon: string | null) => void; t: Translate }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const [problem, setProblem] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [open]);
  const choose = (next: string | null) => { onChange(next); setOpen(false); setCustom(''); setProblem(''); };
  async function upload(chosen: File | undefined) {
    if (!chosen) return;
    try { choose(await iconFromFile(chosen)); } catch (error) {
      setProblem(error instanceof Error && error.message === 'too-large' ? t('Image is too large to use as an icon.', '图片太大，无法用作图标。')
        : t('Unsupported image.', '不支持这种图片。'));
    }
    if (file.current) file.current.value = '';
  }
  return <div className="fn-icon-picker" ref={root}>
    <button type="button" className={`fn-icon-picker-trigger${icon ? ' has-icon' : ''}`}
      aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      {icon ? <NoteIcon icon={icon} className="fn-note-icon--large" />
        : <span className="fn-icon-picker-placeholder">{t('+ Add icon', '+ 添加图标')}</span>}
    </button>
    {open && <div className="fn-icon-picker-panel" role="dialog" aria-label={t('Note icon', '笔记图标')}>
      <div className="fn-icon-picker-grid">{SUGGESTED.map((emoji) =>
        <button key={emoji} type="button" aria-label={emoji} onClick={() => choose(emoji)}>{emoji}</button>)}</div>
      <form className="fn-icon-picker-custom" onSubmit={(event) => {
        event.preventDefault();
        // Mirrors the server rule, so a rejected icon never reaches a live co-editing session.
        if (/[<>]/.test(custom)) setProblem(t('Icons cannot contain < or >.', '图标不能包含 < 或 >。'));
        else if (custom.trim()) choose(custom.trim());
      }}>
        <input className="trek-input" maxLength={16} value={custom} placeholder={t('Any emoji', '任意 emoji')}
          aria-label={t('Custom emoji', '自定义 emoji')} onChange={(event) => setCustom(event.target.value)} />
        <button className="trek-btn trek-btn--secondary" disabled={!custom.trim()}>{t('Use', '使用')}</button>
      </form>
      <div className="trek-cluster fn-icon-picker-actions">
        <button type="button" className="trek-btn trek-btn--ghost"
          onClick={() => file.current?.click()}>{t('Upload image', '上传图片')}</button>
        {icon && <button type="button" className="trek-btn trek-btn--ghost" onClick={() => choose(null)}>{t('Remove', '移除')}</button>}
      </div>
      <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif"
        hidden onChange={(event) => void upload(event.target.files?.[0])} />
      {problem && <p className="fn-icon-picker-problem" role="alert">{problem}</p>}
    </div>}
  </div>;
}
