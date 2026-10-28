import React, { useEffect, useRef, useState } from 'react';
import type { Translate } from './i18n';
import { Avatar, personName, type Person } from './collaborators';
import { Icon, type IconName } from './icons';
import { maxCommentChars, maxQuoteChars, quoteContextChars } from '../shared/limits.json';


export type Comment = {
  id: string; parent_id: string | null; author_id: number; author?: Person; body: string; quote: string | null;
  prefix: string | null; suffix: string | null; created_at: string; updated_at: string; resolved_at: string | null
};
export type Anchor = { quote: string; prefix: string; suffix: string };
export type Thread = { root: Comment; replies: Comment[] };


export const threadsOf = (comments: Comment[]): Thread[] => comments.filter((comment) => !comment.parent_id)
  .map((root) => ({ root, replies: comments.filter((comment) => comment.parent_id === root.id) }));

// The rendered note as one string, with each text node's start offset, so quotes and DOM ranges map onto each other.
function textNodes(root: HTMLElement) {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: { node: Text; start: number }[] = []; let text = '';
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    nodes.push({ node, start: text.length }); text += node.data;
  }
  return { nodes, text };
}

// What the reader selected, plus the characters around it that tell repeated passages apart.
function anchorOf(root: HTMLElement, range: Range): Anchor | null {
  if (range.collapsed || !root.contains(range.commonAncestorContainer)) return null;
  const quote = range.toString().trim();
  if (!quote) return null;
  const before = root.ownerDocument.createRange(); before.selectNodeContents(root); before.setEnd(range.startContainer, range.startOffset);
  const after = root.ownerDocument.createRange(); after.selectNodeContents(root); after.setStart(range.endContainer, range.endOffset);
  return { quote: quote.slice(0, maxQuoteChars), prefix: before.toString().slice(-quoteContextChars),
    suffix: after.toString().slice(0, quoteContextChars) };
}

// The occurrence of the quote whose surroundings match best, or -1 once the text no longer contains it.
function locate(text: string, anchor: Anchor) {
  const shared = (a: string, b: string, fromEnd: boolean) => {
    let n = 0;
    while (n < a.length && n < b.length && (fromEnd ? a[a.length - 1 - n] === b[b.length - 1 - n] : a[n] === b[n])) n += 1;
    return n;
  };
  let best = -1; let bestScore = -1;
  for (let at = text.indexOf(anchor.quote); at >= 0; at = text.indexOf(anchor.quote, at + 1)) {
    const score = shared(text.slice(Math.max(0, at - anchor.prefix.length), at), anchor.prefix, true)
      + shared(text.slice(at + anchor.quote.length), anchor.suffix, false);
    if (score > bestScore) { best = at; bestScore = score; }
  }
  return best;
}

function rangeAt(root: HTMLElement, nodes: { node: Text; start: number }[], start: number, end: number) {
  const point = (offset: number) => {
    let found = nodes[0];
    for (const item of nodes) { if (item.start <= offset) found = item; else break; }
    return [found.node, Math.min(offset - found.start, found.node.length)] as const;
  };
  const range = root.ownerDocument.createRange();
  range.setStart(...point(start)); range.setEnd(...point(end));
  return range;
}

type HighlightRegistry = { set(name: string, value: unknown): void; delete(name: string): void };
const highlights = () => (globalThis.CSS as unknown as { highlights?: HighlightRegistry } | undefined)?.highlights;
const HighlightClass = () => (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;

// Marks quoted passages through the CSS Custom Highlight API, which never touches the rendered note's DOM.
// Returns where each open thread's quote is, so clicks can find their thread and lost quotes can be flagged.
export function paintQuotes(root: HTMLElement | null, threads: Thread[], activeId: string | null) {
  const ranges = new Map<string, Range>();
  if (root) {
    const { nodes, text } = textNodes(root);
    for (const { root: comment } of threads) {
      if (!comment.quote || comment.resolved_at || !nodes.length) continue;
      const at = locate(text, { quote: comment.quote, prefix: comment.prefix || '', suffix: comment.suffix || '' });
      if (at >= 0) ranges.set(comment.id, rangeAt(root, nodes, at, at + comment.quote.length));
    }
  }
  const registry = highlights(); const Highlight = HighlightClass();
  if (registry && Highlight) {
    registry.set('fn-comment', new Highlight(...[...ranges].filter(([id]) => id !== activeId).map(([, range]) => range)));
    const active = activeId ? ranges.get(activeId) : undefined;
    if (active) registry.set('fn-comment-active', new Highlight(active)); else registry.delete('fn-comment-active');
  }
  return ranges;
}

export function clearQuotes() {
  highlights()?.delete('fn-comment'); highlights()?.delete('fn-comment-active');
}

export function threadAt(ranges: Map<string, Range>, x: number, y: number) {
  for (const [id, range] of ranges) {
    const inside = (rect: DOMRect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    if (Array.from(range.getClientRects()).some(inside)) return id;
  }
  return null;
}

// A small "Comment" button that follows a selection inside the note.
export function QuoteButton({ article, label, onQuote }: {
  article: React.RefObject<HTMLElement | null>; label: string; onQuote: (anchor: Anchor) => void
}) {
  const [place, setPlace] = useState<{ top: number; left: number; anchor: Anchor } | null>(null);
  useEffect(() => {
    const update = () => {
      const root = article.current; const selection = root?.ownerDocument.getSelection();
      const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
      const anchor = root && range ? anchorOf(root, range) : null;
      const host = root?.parentElement;
      if (!root || !range || !anchor || !host) { setPlace(null); return; }
      const box = range.getBoundingClientRect(); const frame = host.getBoundingClientRect();
      setPlace({ top: box.bottom - frame.top + 6, left: Math.max(0, box.left - frame.left), anchor });
    };
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, [article]);
  if (!place) return null;
  return <button type="button" className="trek-btn trek-btn--secondary fn-quote-button" style={{ top: place.top, left: place.left }}
    onMouseDown={(event) => event.preventDefault()}
    onClick={() => { onQuote(place.anchor); document.getSelection()?.removeAllRanges(); setPlace(null); }}>{label}</button>;
}

function Composer({ placeholder, submitLabel, initial = '', autoFocus, busy, onSubmit, onCancel, t }: {
  placeholder: string; submitLabel: string; initial?: string; autoFocus?: boolean; busy: boolean;
  onSubmit: (body: string) => Promise<boolean>; onCancel?: () => void; t: Translate
}) {
  const [body, setBody] = useState(initial);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (autoFocus) field.current?.focus(); }, [autoFocus]);
  const submit = async () => { if (body.trim() && await onSubmit(body.trim())) setBody(''); };
  return <form className="fn-comment-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <textarea ref={field} className="trek-textarea" rows={2} maxLength={maxCommentChars} placeholder={placeholder}
      aria-label={placeholder}
      value={body} onChange={(event) => setBody(event.target.value)} onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); }
        if (event.key === 'Escape' && onCancel) { event.preventDefault(); onCancel(); }
      }} />
    <div className="fn-comment-composer-actions">
      {onCancel && <button type="button" className="trek-btn trek-btn--ghost" onClick={onCancel}>{t('Cancel', '取消')}</button>}
      <button className="trek-btn trek-btn--primary" disabled={busy || !body.trim()}>{submitLabel}</button>
    </div>
  </form>;
}

type Actions = {
  add: (body: string, anchor: Anchor | null) => Promise<boolean>; reply: (rootId: string, body: string) => Promise<boolean>;
  edit: (id: string, body: string) => Promise<boolean>; remove: (comment: Comment) => void; resolve: (id: string, resolved: boolean) => void
};

function ToolButton({ icon, label, busy, onClick, className = '' }: {
  icon: IconName; label: string; busy: boolean; onClick: () => void; className?: string
}) {
  return <button type="button" className={`fn-comment-tool ${className}`} aria-label={label} title={label} disabled={busy}
    onClick={onClick}><Icon name={icon} /></button>;
}

function CommentItem({ comment, userId, canModerate, busy, locale, actions, t }: {
  comment: Comment; userId: number; canModerate: boolean; busy: boolean; locale?: string; actions: Actions; t: Translate
}) {
  const [editing, setEditing] = useState(false);
  const own = comment.author_id === userId;
  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(comment.created_at));
  return <li className="fn-comment">
    <div className="fn-comment-meta">
      <Avatar className="fn-comment-avatar" name={comment.author ? personName(comment.author) : `#${comment.author_id}`}
        color={comment.author?.color} />
      <strong>{comment.author ? personName(comment.author) : `#${comment.author_id}`}</strong>
      <time className="trek-muted" dateTime={comment.created_at}>{when}</time>
      {comment.updated_at !== comment.created_at && <span className="trek-muted">{t('Edited', '已编辑')}</span>}
      {!editing && (own || canModerate) && <span className="fn-comment-tools">
        {own && <ToolButton icon="edit" label={t('Edit', '编辑')} busy={busy} onClick={() => setEditing(true)} />}
        <ToolButton icon="trash" label={t('Delete', '删除')} busy={busy} onClick={() => actions.remove(comment)} className="is-danger" />
      </span>}
    </div>
    {editing
      ? <Composer initial={comment.body} placeholder={t('Edit comment', '编辑评论')} submitLabel={t('Save', '保存')} autoFocus busy={busy} t={t}
        onCancel={() => setEditing(false)}
        onSubmit={async (body) => { const saved = await actions.edit(comment.id, body); if (saved) setEditing(false); return saved; }} />
      : <p className="fn-comment-body">{comment.body}</p>}
  </li>;
}

// Notion-style side panel: open threads first, resolved ones a tab away, each with its quote, replies and a reply box.
export function CommentPanel({ open, threads, located, pending, activeId, userId, canModerate, busy, locale, actions, onActivate,
  onDropQuote, onClose, t }: {
  open: boolean; threads: Thread[]; located: Set<string>; pending: Anchor | null; activeId: string | null; userId: number;
  canModerate: boolean; busy: boolean; locale?: string; actions: Actions; onActivate: (id: string) => void; onDropQuote: () => void;
  onClose: () => void; t: Translate
}) {
  const [showResolved, setShowResolved] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const panel = useRef<HTMLElement>(null);
  // The thread to scroll to once it is rendered: one on the other tab switches tabs first.
  const [reveal, setReveal] = useState<string | null>(null);
  const unresolved = threads.filter((thread) => !thread.root.resolved_at);
  const resolved = threads.filter((thread) => thread.root.resolved_at);
  const shown = showResolved ? resolved : unresolved;
  useEffect(() => {
    if (!activeId) return;
    const elsewhere = threads.some((thread) => thread.root.id === activeId && Boolean(thread.root.resolved_at) !== showResolved);
    if (elsewhere) setShowResolved(!showResolved);
    setReveal(activeId);
  }, [activeId]);
  useEffect(() => {
    if (!reveal) return;
    panel.current?.querySelector(`[data-thread="${reveal}"]`)?.scrollIntoView({ block: 'nearest' });
    setReveal(null);
  }, [reveal]);
  // Stays mounted while closed so it can animate out; `inert` keeps it out of focus and the accessibility tree meanwhile.
  return <aside ref={panel} className="fn-comment-panel" aria-labelledby="comments-heading" data-open={open || undefined} inert={!open}>
    <div className="fn-comment-panel-header">
      <h3 id="comments-heading">{t('Comments', '评论')}</h3>
      <button type="button" className="trek-btn trek-btn--ghost fn-icon-button" aria-label={t('Close comments', '关闭评论')}
        title={t('Close comments', '关闭评论')} onClick={onClose}><Icon name="close" /></button>
    </div>
    <div className="trek-segmented fn-comment-tabs" role="group" aria-label={t('Comment status', '评论状态')}>
      <button type="button" aria-pressed={!showResolved} onClick={() => setShowResolved(false)}>
        {t('Open · {count}', '进行中 · {count}', { count: unresolved.length })}
      </button>
      <button type="button" aria-pressed={showResolved} onClick={() => setShowResolved(true)}>
        {t('Resolved · {count}', '已解决 · {count}', { count: resolved.length })}
      </button>
    </div>
    {!showResolved && <div className="fn-comment-new">
      {pending && <blockquote className="fn-comment-quote">
        <span>{pending.quote}</span>
        <button type="button" className="fn-text-button" onClick={onDropQuote}>{t('Remove quote', '不引用')}</button>
      </blockquote>}
      <Composer key={pending ? `quote:${pending.quote}` : 'note'} autoFocus={Boolean(pending)} busy={busy} t={t}
        placeholder={pending ? t('Comment on the selected text…', '评论选中的文字…') : t('Comment on this note…', '评论这篇笔记…')}
        submitLabel={t('Comment', '评论')} onSubmit={(body) => actions.add(body, pending)} />
    </div>}
    {shown.length ? <ol className="fn-comment-threads">{shown.map(({ root, replies }) => <li key={root.id} data-thread={root.id}
      className={`fn-comment-thread${root.id === activeId ? ' is-active' : ''}${root.resolved_at ? ' is-resolved' : ''}`}
      onClick={(event) => { if (!(event.target as HTMLElement).closest('button, textarea, a')) onActivate(root.id); }}>
      <div className="fn-comment-thread-head">
        {root.quote ? <blockquote className="fn-comment-quote">
          <span>{root.quote}</span>
          {!root.resolved_at && !located.has(root.id)
            && <small className="trek-muted">{t('The quoted text has changed.', '引用的文字已被修改。')}</small>}
        </blockquote> : <span className="trek-muted fn-comment-scope">{t('Whole note', '整篇笔记')}</span>}
        <ToolButton icon={root.resolved_at ? 'reopen' : 'check'} label={root.resolved_at ? t('Reopen', '重新打开') : t('Resolve', '解决')}
          busy={busy} onClick={() => actions.resolve(root.id, !root.resolved_at)} className="fn-comment-resolve" />
      </div>
      <ul className="fn-comment-list">
        {[root, ...replies].map((comment) => <CommentItem key={comment.id} comment={comment} userId={userId} canModerate={canModerate}
          busy={busy} locale={locale} actions={actions} t={t} />)}
      </ul>
      {!root.resolved_at && replyTo !== root.id && <button type="button" className="fn-comment-reply-field" disabled={busy}
        onClick={() => setReplyTo(root.id)}>{t('Reply…', '回复…')}</button>}
      {replyTo === root.id && <Composer autoFocus busy={busy} t={t} placeholder={t('Reply…', '回复…')} submitLabel={t('Reply', '回复')}
        onCancel={() => setReplyTo(null)}
        onSubmit={async (body) => { const sent = await actions.reply(root.id, body); if (sent) setReplyTo(null); return sent; }} />}
    </li>)}</ol>
      : <p className="trek-muted fn-comment-empty">{showResolved ? t('No resolved comments.', '没有已解决的评论。') : <>
        <span>{t('No comments yet…', '还没有评论…')}</span><span>{t('Select text in the note to comment.', '选中正文即可发表评论哦！')}</span>
      </>}</p>}
  </aside>;
}
