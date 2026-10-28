import type { Translate } from './i18n';
import type { ReferenceLinks } from './markdown';
import { isPhone } from './media';


// A snapshot shows its trip's places, bookings, days and stays: `[[trek:place/12|Name]]` in running text is a small tag that
// opens a card, and `![[trek:place/12|Name]]` alone on a line is the card itself. Cards keep to what a reader of the note needs
// at a glance (when, where, which train), not everything TREK holds. The label is the name when the item was inserted, so the
// text reads on its own, copies as plain words and still names an item the trip has since removed. Cards are read fresh each
// time a note opens, because plans change; the server sends only what a card shows.
export const TREK_PREFIX = 'trek:';
export type TrekKind = 'place' | 'booking' | 'day' | 'stay';
type DayRef = { number: number | null; date: string | null } | null;
type Endpoint = { name: string; code: string | null; time: string | null; date: string | null; zone: string | null } | null;
type Category = { name: string; icon: string | null; color: string | null } | null;
type Stop = { name: string; time: string | null; icon: string | null; type: string };
type Base = { ref: string; name: string; link: string };
export type TrekObject = Base & (
  | { kind: 'place'; category: Category; day: DayRef; time: string | null; map: string | null }
  | { kind: 'booking'; type: string; status: 'pending' | 'confirmed'; start: string | null; end: string | null; from: Endpoint;
    to: Endpoint; number: string | null; carrier: string | null; seat: string | null; location: string | null; day: DayRef;
    map: string | null }
  | { kind: 'day'; number: number | null; date: string | null; stops: Stop[]; more: number; stay: string | null }
  | { kind: 'stay'; address: string | null; check_in: string | null; check_out: string | null; from: DayRef; to: DayRef;
    map: string | null });

let t: Translate = (en, _zh, vars) => en.replace(/\{(\w+)\}/g, (match, name) => String(vars?.[name] ?? match));
let locale: string | undefined;
let open: (href: string) => void = () => {};
// The page's words and language, and how it follows a card's links (into the trip, or out to a map).
export function setTrekText(translate: Translate, language: string | undefined, follow: (href: string) => void) {
  t = translate; locale = language; open = follow;
}

const REF = /^trek:(place|booking|day|stay)\/(\d{1,12})$/;
export const isTrekTarget = (target: string) => REF.test(target.trim());
export const trekRef = (target: string) => target.trim().slice(TREK_PREFIX.length);
const kindOf = (ref: string) => ref.split('/')[0] as TrekKind;
// A trip item, linked or embedded: its target, then the label it was inserted with.
export const TREK_LINK = /!?\[\[(trek:[^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g;
export function trekSourcesInMarkdown(source: string) {
  return [...new Set([...source.matchAll(TREK_LINK)].map((match) => match[1].trim()).filter(isTrekTarget).map(trekRef))];
}

// Bookings come in many types; a card names the kind of trip leg or reservation, not every one TREK tells apart.
function bookingType(type: string) {
  switch (type) {
    case 'flight': return t('Flight', '航班');
    case 'train': return t('Train', '火车');
    case 'bus': return t('Bus', '巴士');
    case 'car': case 'taxi': return t('Car', '汽车');
    case 'cruise': case 'ferry': return t('Boat', '船');
    case 'bicycle': case 'cable_car': case 'transit': case 'transport_other': return t('Transport', '交通');
    case 'hotel': return t('Hotel', '酒店');
    case 'restaurant': return t('Restaurant', '餐厅');
    case 'event': return t('Event', '活动');
    case 'tour': case 'activity': return t('Tour', '游览');
    default: return t('Booking', '预订');
  }
}
function kindLabel(kind: TrekKind) {
  return { place: t('Place', '地点'), booking: t('Booking', '预订'), day: t('Day', '日程'), stay: t('Stay', '住宿') }[kind];
}
const BOOKING_GLYPHS: Record<string, string> = { flight: '✈️', train: '🚆', bus: '🚌', car: '🚗', taxi: '🚕', bicycle: '🚲',
  cruise: '🛳️', ferry: '⛴️', cable_car: '🚡', transit: '🚇', transport_other: '🚐', restaurant: '🍽️', event: '🎟️', tour: '🧭',
  activity: '🧭', parking: '🅿️' };

// Dates are the trip's own calendar days, shown without a year and never shifted by the reader's time zone.
const calendarDay = (date: string | null | undefined) => (date && /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : '');
function formatDate(date: string | null | undefined, options: Intl.DateTimeFormatOptions) {
  const day = calendarDay(date);
  if (!day) return '';
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
  } catch { return day; }
}
const shortDate = (date: string | null | undefined) => formatDate(date, { month: 'short', day: 'numeric' });
const longDate = (date: string | null | undefined) => formatDate(date, { month: 'short', day: 'numeric', weekday: 'short' });
const timeOf = (value: string | null | undefined) => /T(\d{2}:\d{2})/.exec(value || '')?.[1] || '';
const dayNumber = (day: DayRef) => (day?.number ? t('Day {number}', '第 {number} 天', { number: day.number }) : '');
const dayName = (day: DayRef) => joined([dayNumber(day), shortDate(day?.date)]);
const range = (from: string, to: string) => (from && to && from !== to ? `${from} – ${to}` : from || to);
const joined = (parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(' · ');

// Minutes between two local wall times, each in its own time zone, so a flight across zones is timed by the clock it flew.
function wallClock(date: string, time: string, zone: string | null) {
  const wall = Date.parse(`${date}T${time}:00Z`);
  if (!zone || Number.isNaN(wall)) return wall;
  try {
    const format = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const parts = Object.fromEntries(format.formatToParts(new Date(wall)).map((part) => [part.type, part.value]));
    return wall - (Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`) - wall);
  } catch { return NaN; }
}
function duration(from: Endpoint, to: Endpoint) {
  if (!from?.time || !to?.time || !from.date || !to.date || Boolean(from.zone) !== Boolean(to.zone)) return '';
  const minutes = Math.round((wallClock(to.date, to.time, to.zone) - wallClock(from.date, from.time, from.zone)) / 60000);
  if (!(minutes > 0) || minutes > 7 * 24 * 60) return '';
  const hours = Math.floor(minutes / 60); const rest = minutes % 60;
  return hours ? rest ? t('{hours} h {minutes} min', '{hours} 小时 {minutes} 分', { hours, minutes: rest })
    : t('{hours} h', '{hours} 小时', { hours }) : t('{minutes} min', '{minutes} 分钟', { minutes: rest });
}
function nights(from: DayRef, to: DayRef) {
  const span = calendarDay(from?.date) && calendarDay(to?.date)
    ? Math.round((Date.parse(calendarDay(to?.date)) - Date.parse(calendarDay(from?.date))) / 86400000)
    : (to?.number ?? 0) - (from?.number ?? 0);
  return span > 0 ? span === 1 ? t('1 night', '1 晚') : t('{count} nights', '{count} 晚', { count: span }) : '';
}

// The name and one line of facts, as the menu that inserts an item lists it.
export function cardLines(card: TrekObject): { name: string; facts: string; detail: string } {
  switch (card.kind) {
    case 'place':
      return { name: card.name, facts: joined([kindLabel('place'), card.category?.name, dayName(card.day), card.time]), detail: '' };
    case 'booking': {
      const start = timeOf(card.start) || card.from?.time || ''; const end = timeOf(card.end) || card.to?.time || '';
      return { name: card.name, facts: joined([bookingType(card.type), shortDate(card.start || card.from?.date || card.day?.date),
        range(start, end), card.status === 'pending' && t('Not confirmed', '待确认')]),
      detail: card.from && card.to ? `${card.from.name} → ${card.to.name}` : card.location || '' };
    }
    case 'day':
      // "Day 3" already says what it is; a day without a title is named by it.
      return { name: card.name || dayName(card) || kindLabel('day'), facts: card.name && dayName(card) || kindLabel('day'),
        detail: card.stops.map((stop) => stop.name).join(' → ') };
    case 'stay':
      return { name: card.name, facts: joined([kindLabel('stay'), range(shortDate(card.from?.date) || dayName(card.from),
        shortDate(card.to?.date) || dayName(card.to))]), detail: card.address || '' };
  }
}

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const span = (className: string, text: string | null | undefined) => (text ? `<span class="${className}">${escapeHtml(text)}</span>` : '');
// Line icons on the 24px grid the rest of Fieldnotes draws with.
export const TREK_ICONS: Record<TrekKind | 'flight' | 'train' | 'map', string> = {
  place: 'M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z M12 7.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5',
  booking: 'M4 7.5h16v3a1.8 1.8 0 0 0 0 3.6v3H4v-3a1.8 1.8 0 0 0 0-3.6z M14.5 7.5v10',
  day: 'M5 6h14v14H5z M5 10h14 M9 4v4 M15 4v4 M8.5 13.5h3',
  stay: 'M3.5 18.5v-11 M3.5 14.5h17v4 M20.5 14.5v-2.5a2.5 2.5 0 0 0-2.5-2.5h-7v5 M7 12.2a1.6 1.6 0 1 0 0-.01',
  flight: 'M10.5 13.5 4 11l1.5-1.5 7 1 4-4a1.8 1.8 0 0 1 2.5 2.5l-4 4 1 7L14.5 21.5 12 15l-3 3v2.5L7.5 22 6 18l-4-1.5L3.5 15H6z',
  train: 'M7 4.5h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z M5 11h14 M8.5 14.5h.01 M15.5 14.5h.01'
    + ' M8 17.5 6 20.5 M16 17.5l2 3',
  map: 'M9 5 3.5 7v12L9 17l6 2 5.5-2V5L15 7z M9 5v12 M15 7v12',
};
const iconSvg = (name: keyof typeof TREK_ICONS, className = 'fn-trek-svg') =>
  `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true"><path d="${TREK_ICONS[name]}"/></svg>`;
// A place's own category emoji, else the line icon for what the item is.
function glyph(card: TrekObject) {
  if (card.kind === 'place' && card.category?.icon) return `<span class="fn-trek-glyph">${escapeHtml(card.category.icon)}</span>`;
  if (card.kind === 'booking' && (card.type === 'flight' || card.type === 'train')) return iconSvg(card.type);
  return iconSvg(card.kind);
}
// A calendar leaf: the month above the day of the month, for items that happen on a date.
function leaf(date: string | null | undefined, fallback: string) {
  const day = calendarDay(date);
  return day ? `<span class="fn-trek-leaf"><span class="fn-trek-leaf-month">${escapeHtml(formatDate(day, { month: 'short' }))}</span>`
    + `<span class="fn-trek-leaf-day">${Number(day.slice(8, 10))}</span></span>` : fallback;
}
const status = (card: TrekObject) => (card.kind === 'booking' && card.status === 'pending'
  ? `<span class="fn-trek-status">${escapeHtml(t('Not confirmed', '待确认'))}</span>` : '');
const head = (tile: string, name: string, facts: string, aside = '') => '<span class="fn-trek-head">'
  + `<span class="fn-trek-tile">${tile}</span>`
  + `<span class="fn-trek-text">${span('fn-trek-name', name)}${span('fn-trek-facts', facts)}</span>`
  + `${aside}</span>`;

// Each kind shows what a reader looks for: a place's day and time, a journey's times and ends, a booking's date, a stay's
// nights and check-in, a day's stops in order.
function body(card: TrekObject) {
  switch (card.kind) {
    case 'place':
      return head(glyph(card), card.name, joined([card.category?.name, dayNumber(card.day), longDate(card.day?.date), card.time]));
    case 'booking': {
      const date = card.start || card.from?.date || card.day?.date;
      if (card.from && card.to) {
        const end = (point: NonNullable<Endpoint>, side: 'from' | 'to', fallback: string) =>
          `<span class="fn-trek-end fn-trek-end--${side}">${span('fn-trek-clock', point.time || fallback)}`
          + `${span('fn-trek-code', point.code || point.name)}${point.code ? span('fn-trek-where', point.name) : ''}</span>`;
        const leg = duration(card.from, card.to);
        return head(glyph(card), card.name, joined([bookingType(card.type), card.number, card.carrier, longDate(date)]), status(card))
          + `<span class="fn-trek-route">${end(card.from, 'from', timeOf(card.start))}`
          + `<span class="fn-trek-leg">${span('fn-trek-duration', leg)}</span>${end(card.to, 'to', timeOf(card.end))}</span>`
          + (card.seat ? `<span class="fn-trek-foot">${escapeHtml(t('Seat {seat}', '座位 {seat}', { seat: card.seat }))}</span>` : '');
      }
      return head(leaf(date, glyph(card)), card.name,
        joined([range(timeOf(card.start), timeOf(card.end)), bookingType(card.type), card.number]), status(card))
        + span('fn-trek-foot', card.location);
    }
    case 'stay': {
      const end = (label: string, day: DayRef, time: string | null) => `<span class="fn-trek-stay-end">${span('fn-trek-label', label)}`
        + `${span('fn-trek-clock', time)}${span(time ? 'fn-trek-where' : 'fn-trek-when', longDate(day?.date) || dayNumber(day))}</span>`;
      return head(glyph(card), card.name, kindLabel('stay'))
        + `<span class="fn-trek-stay">${end(t('Check-in', '入住'), card.from, card.check_in)}`
        + `<span class="fn-trek-leg">${span('fn-trek-duration', nights(card.from, card.to))}</span>`
        + `${end(t('Check-out', '退房'), card.to, card.check_out)}</span>`;
    }
    case 'day': {
      const shown = card.stops.slice(0, 6); const hidden = card.stops.length - shown.length + card.more;
      const rows = shown.map((stop) => `<li class="fn-trek-stop"><span class="fn-trek-stop-time">${escapeHtml(stop.time || '')}</span>`
        + `<span class="fn-trek-stop-icon" aria-hidden="true">${escapeHtml(stop.icon || BOOKING_GLYPHS[stop.type] || '')}</span>`
        + `${span('fn-trek-stop-name', stop.name)}</li>`).join('');
      const more = hidden ? `<li class="fn-trek-stop fn-trek-stop--more">${escapeHtml(t('{count} more stops', '还有 {count} 个地方',
        { count: hidden }))}</li>` : '';
      return head(leaf(card.date, glyph(card)), card.name || dayNumber(card) || kindLabel('day'),
        joined([card.name && dayNumber(card), longDate(card.date)]))
        + (rows || more ? `<ol class="fn-trek-stops">${rows}${more}</ol>` : '')
        + (card.stay ? `<span class="fn-trek-foot fn-trek-night">${iconSvg('stay', 'fn-trek-svg fn-trek-svg--small')}`
          + `${escapeHtml(t('Night at {name}', '住 {name}', { name: card.stay }))}</span>` : '');
    }
  }
}

// A card: the whole of it opens the item in the trip, and a map button sits apart where there is somewhere to go. One the trip
// no longer has keeps its stored name, dimmed.
export function trekCardHtml(ref: string, label: string | undefined, card: TrekObject | null | undefined) {
  const kind = kindOf(ref); const stored = label?.trim() || kindLabel(kind);
  if (!card) {
    const note = card === null ? t('Removed from this trip', '已从这次旅行中移除') : kindLabel(kind);
    return `<div class="fn-trek ${card === null ? 'fn-trek--missing' : 'fn-trek--pending'}" data-kind="${kind}">`
      + `<span class="fn-trek-main">${head(iconSvg(kind), stored, note)}</span></div>`;
  }
  const tint = card.kind === 'place' && card.category?.color ? ` style="--trek-tint: ${card.category.color}"` : '';
  const map = 'map' in card && card.map ? `<a class="fn-trek-map" href="${escapeHtml(card.map)}" aria-label="${escapeHtml(t('Open in Maps',
    '在地图中打开'))}" title="${escapeHtml(t('Open in Maps', '在地图中打开'))}">${iconSvg('map')}</a>` : '';
  const type = card.kind === 'booking' ? ` data-type="${escapeHtml(card.type)}"` : '';
  return `<div class="fn-trek${map ? ' fn-trek--map' : ''}" data-kind="${kind}"${type}${tint}>`
    + `<a class="fn-trek-main" href="${escapeHtml(`fieldnotes://trek${card.link}`)}">${body(card)}</a>${map}</div>`;
}

// Items on adjacent lines: one box, each item in it as its own card would show it.
export function trekGroupHtml(items: (readonly [string, string | undefined, TrekObject | null | undefined])[]) {
  return `<div class="fn-trek-group">${items.map(([ref, label, card]) => trekCardHtml(ref, label, card)).join('')}</div>`;
}

// In running text an item is a tag: its icon and current name, or the stored name once the trip no longer has it.
export function trekChipHtml(ref: string, label: string | undefined, card: TrekObject | null | undefined) {
  const kind = kindOf(ref); const name = card?.name || label?.trim() || kindLabel(kind);
  const icon = card ? glyph(card) : iconSvg(kind);
  return `<span class="fn-trek-chip${card === null ? ' fn-trek-chip--missing' : ''}" data-trek="${TREK_PREFIX}${escapeHtml(ref)}"`
    + ` data-label="${escapeHtml(label?.trim() || '')}" role="button" tabindex="0"${card === null
      ? ` title="${escapeHtml(t('Removed from this trip', '已从这次旅行中移除'))}"` : ''}>`
    + `<span class="fn-trek-chip-icon">${icon}</span>${escapeHtml(name)}</span>`;
}

// The TREK page a card opens, from `fieldnotes://trek/trips/…`; anything else is not a card's link.
export function trekPath(href: string) {
  const path = href.startsWith('fieldnotes://trek/') ? href.slice('fieldnotes://trek'.length) : '';
  return /^\/trips\/\d+\?tab=plan&(place|booking|day)=\d+$/.test(path) ? path : null;
}

// A tag opens its card in a popover: on hover with a mouse, on a tap or Enter anywhere. A hover card closes once the pointer has
// left both; one opened on purpose stays until a click elsewhere or Escape. On a phone the card rises from the bottom.
let popover: { element: HTMLElement; chip: HTMLElement; pinned: boolean; close: () => void } | null = null;
let hoverTimer = 0;
function showCard(chip: HTMLElement, references: ReferenceLinks, pinned: boolean) {
  if (popover?.chip === chip) { popover.pinned ||= pinned; return; }
  popover?.close();
  const doc = chip.ownerDocument; const win = doc.defaultView!;
  const target = chip.dataset.trek!; const link = references[target];
  const element = doc.createElement('div');
  element.className = 'fn-trek-pop'; element.setAttribute('role', 'dialog'); element.setAttribute('aria-label', chip.textContent || '');
  const range = doc.createRange(); range.selectNodeContents(element);
  element.append(range.createContextualFragment(trekCardHtml(trekRef(target), chip.dataset.label,
    link && 'trek' in link ? link.trek : undefined)));
  doc.body.append(element);
  if (!isPhone()) {
    const box = chip.getBoundingClientRect(); const { width, height } = element.getBoundingClientRect();
    const below = box.bottom + 6 + height <= win.innerHeight - 8 || box.top - 6 - height < 8;
    element.style.left = `${Math.max(8, Math.min(box.left, win.innerWidth - width - 8))}px`;
    element.style.top = `${below ? box.bottom + 6 : box.top - 6 - height}px`;
    element.style.transformOrigin = below ? 'top left' : 'bottom left';
  } else element.classList.add('fn-trek-pop--sheet');
  const follow = (event: MouseEvent) => {
    const anchor = (event.target as HTMLElement).closest('a');
    if (!anchor) return;
    event.preventDefault(); close(); open(anchor.getAttribute('href') || '');
  };
  const outside = (event: Event) => {
    if (!element.contains(event.target as Node) && !chip.contains(event.target as Node)) close();
  };
  const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close(); chip.focus(); } };
  const leave = () => { if (!popover?.pinned) { win.clearTimeout(hoverTimer); hoverTimer = win.setTimeout(close, 220); } };
  const stay = () => win.clearTimeout(hoverTimer);
  function close() {
    win.clearTimeout(hoverTimer); element.remove(); chip.removeAttribute('aria-expanded');
    doc.removeEventListener('pointerdown', outside, true); win.removeEventListener('keydown', escape, true);
    if (popover?.element === element) popover = null;
  }
  element.addEventListener('click', follow);
  element.addEventListener('pointerenter', stay); element.addEventListener('pointerleave', leave);
  doc.addEventListener('pointerdown', outside, true); win.addEventListener('keydown', escape, true);
  chip.setAttribute('aria-expanded', 'true');
  popover = { element, chip, pinned, close };
}
export function mountTrekChips(root: HTMLElement, references: ReferenceLinks) {
  const win = root.ownerDocument.defaultView!;
  root.querySelectorAll<HTMLElement>('.fn-trek-chip').forEach((chip) => {
    chip.setAttribute('aria-haspopup', 'dialog');
    chip.addEventListener('click', (event) => { event.stopPropagation(); showCard(chip, references, true); });
    chip.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showCard(chip, references, true); }
    });
    chip.addEventListener('pointerenter', (event) => {
      if (event.pointerType !== 'mouse') return;
      win.clearTimeout(hoverTimer); hoverTimer = win.setTimeout(() => showCard(chip, references, false), 300);
    });
    chip.addEventListener('pointerleave', () => {
      win.clearTimeout(hoverTimer);
      if (popover?.chip === chip && !popover.pinned) hoverTimer = win.setTimeout(() => popover?.close(), 220);
    });
  });
}
