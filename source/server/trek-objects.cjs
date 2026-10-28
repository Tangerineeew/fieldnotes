'use strict';

// A trip's places, bookings, days and stays as the cards a snapshot shows for `![[trek:place/12|Name]]`. Every read runs as the
// reader, so TREK's own membership check applies; a reference resolves only within the trip whose page asks, and only what a
// card shows leaves the server, never a booking's confirmation number, price or travellers.
const REF = /^(place|booking|day|stay)\/(\d{1,12})$/;
const MAX_REFS = 200;
const MAX_STOPS = 40;

const clip = (value, size) => {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > size ? `${flat.slice(0, size - 1)}…` : flat;
};
const rows = (value) => (Array.isArray(value) ? value : []);
const dayOf = (day) => (day ? { number: Number(day.day_number) || null, date: day.date || null } : null);
const plan = (tripId, param, id) => `/trips/${tripId}?tab=plan&${param}=${id}`;
const clock = (value) => /^\d{2}:\d{2}/.exec(String(value ?? ''))?.[0] || null;
const colour = (value) => (/^#[0-9a-f]{3,8}$/i.test(String(value ?? '')) ? String(value) : null);
const coordinate = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null
  : Number(value));
function metadata(booking) {
  if (booking.metadata && typeof booking.metadata === 'object') return booking.metadata;
  try { return JSON.parse(booking.metadata || '{}') || {}; } catch { return {}; }
}

// A Google Maps search for the item: its Google place when TREK has one, else its coordinates, else its address.
function mapUrl({ name, lat, lng, placeId, address }) {
  const point = coordinate(lat) !== null && coordinate(lng) !== null ? `${coordinate(lat)},${coordinate(lng)}` : '';
  const query = placeId ? clip(name, 160) || point : point || clip(address, 200);
  if (!query) return null;
  const params = new URLSearchParams({ api: '1', query });
  if (placeId) params.set('query_place_id', String(placeId));
  return `https://www.google.com/maps/search/?${params}`;
}
const categoryOf = (place) => {
  const category = place?.category && typeof place.category === 'object' ? place.category
    : place?.category_name ? { name: place.category_name, icon: place.category_icon, color: place.category_color } : null;
  return category?.name ? { name: clip(category.name, 60), icon: clip(category.icon, 8) || null, color: colour(category.color) } : null;
};

function parseRefs(refs) {
  if (!Array.isArray(refs) || refs.length > MAX_REFS) return null;
  const parsed = refs.map((ref) => REF.exec(String(ref)));
  return parsed.every(Boolean) ? parsed.map(([ref, kind, id]) => ({ ref, kind, id: Number(id) })) : null;
}

function placeCard(tripId, place, scheduled) {
  const slot = scheduled.get(Number(place.id));
  return { ref: `place/${place.id}`, kind: 'place', name: clip(place.name, 160), category: categoryOf(place),
    day: slot?.day || null, time: slot?.time || clock(place.place_time),
    map: mapUrl({ name: place.name, lat: place.lat, lng: place.lng, placeId: place.google_place_id, address: place.address }),
    link: plan(tripId, 'place', place.id) };
}

function bookingCard(tripId, booking, days) {
  const meta = metadata(booking);
  const endpoint = (role) => {
    const found = rows(booking.endpoints).find((point) => point.role === role);
    const code = clip(found?.code || meta[role === 'from' ? 'departure_airport' : 'arrival_airport'], 8) || null;
    return found ? { name: clip(found.name, 120), code, time: clock(found.local_time), date: found.local_date || null,
      zone: clip(found.timezone || meta[role === 'from' ? 'departure_timezone' : 'arrival_timezone'], 60) || null } : null;
  };
  return { ref: `booking/${booking.id}`, kind: 'booking', name: clip(booking.title, 160), type: String(booking.type || 'other'),
    status: booking.status === 'pending' ? 'pending' : 'confirmed', start: booking.reservation_time || null,
    end: booking.reservation_end_time || null, from: endpoint('from'), to: endpoint('to'),
    number: clip(meta.flight_number || meta.train_number, 40) || null, carrier: clip(meta.airline, 60) || null,
    seat: clip(meta.seat, 40) || null, location: clip(booking.location || booking.place_name, 200) || null,
    day: dayOf(days.get(Number(booking.day_id))) || (booking.day_number ? { number: Number(booking.day_number), date: null } : null),
    map: booking.location ? mapUrl({ address: booking.location }) : null, link: plan(tripId, 'booking', booking.id) };
}

// A day as it runs: its places and the bookings set on it, in the plan's order, then where the night is spent.
function dayCard(tripId, day, bookings, stays) {
  const stops = rows(day.assignments).map((assignment) => ({ at: Number(assignment.order_index ?? 0),
    name: clip(assignment.place?.name, 80), time: clock(assignment.assignment_time || assignment.place?.place_time),
    icon: categoryOf(assignment.place)?.icon || null, type: 'place' }));
  for (const booking of bookings) {
    // A booking tied to one of the day's places is that stop already; a stay shows below the timeline.
    const elsewhere = Number(booking.day_id) !== Number(day.id) || booking.assignment_id || booking.accommodation_id;
    if (elsewhere || booking.type === 'hotel') continue;
    const at = booking.day_positions?.[day.id] ?? booking.day_plan_position;
    stops.push({ at: at === null || at === undefined ? Infinity : Number(at), name: clip(booking.title, 80),
      time: clock(String(booking.reservation_time || '').split('T')[1]), icon: null, type: String(booking.type || 'other') });
  }
  const ordered = stops.filter((stop) => stop.name).sort((a, b) => a.at - b.at || String(a.time).localeCompare(String(b.time)));
  const number = Number(day.day_number);
  const night = stays.find((stay) => stay.from?.number <= number && number < stay.to?.number);
  return { ref: `day/${day.id}`, kind: 'day', name: clip(day.title, 160), ...dayOf(day),
    stops: ordered.slice(0, MAX_STOPS).map(({ at: _at, ...stop }) => stop), more: Math.max(0, ordered.length - MAX_STOPS),
    stay: night?.name || null, link: plan(tripId, 'day', day.id) };
}

function stayCard(tripId, stay, days) {
  return { ref: `stay/${stay.id}`, kind: 'stay', name: clip(stay.place_name || stay.reservation_title, 160),
    address: clip(stay.place_address, 200) || null, check_in: clock(stay.check_in), check_out: clock(stay.check_out),
    from: dayOf(days.get(Number(stay.start_day_id))), to: dayOf(days.get(Number(stay.end_day_id))),
    map: mapUrl({ name: stay.place_name, lat: stay.place_lat, lng: stay.place_lng, address: stay.place_address }),
    link: stay.place_id ? plan(tripId, 'place', stay.place_id) : plan(tripId, 'day', stay.start_day_id) };
}

// Reads only what the asked kinds need: days date everything, and a day also shows its bookings and the night's stay. Days are
// kept in the plan's order.
async function load(ctx, tripId, kinds) {
  const wanted = (kind) => kinds.has(kind);
  const [places, bookings, dayRows, stays] = await Promise.all([
    wanted('place') ? ctx.trips.getPlaces(tripId) : [], wanted('booking') || wanted('day') ? ctx.trips.getReservations(tripId) : [],
    ctx.trips.getDays(tripId), wanted('stay') || wanted('day') ? ctx.trips.getAccommodations(tripId) : [],
  ]);
  const ordered = rows(dayRows).toSorted((a, b) => (a.day_number ?? 0) - (b.day_number ?? 0));
  const days = new Map(ordered.map((day) => [Number(day.id), day]));
  const scheduled = new Map();
  for (const day of days.values()) {
    for (const assignment of rows(day.assignments)) {
      const placeId = Number(assignment.place_id ?? assignment.place?.id);
      if (!scheduled.has(placeId)) scheduled.set(placeId, { day: dayOf(day), time: clock(assignment.assignment_time) });
    }
  }
  return { places: rows(places), bookings: rows(bookings), days, stays: rows(stays), scheduled };
}

function cardsOf(tripId, data, kinds, listing = false) {
  const stays = data.stays.map((stay) => stayCard(tripId, stay, data.days));
  return [
    ...(kinds.has('day') ? [...data.days.values()].map((day) => dayCard(tripId, day, data.bookings, stays)) : []),
    ...(kinds.has('stay') ? stays : []),
    ...(kinds.has('booking') ? data.bookings.filter((booking) => !listing || !booking.accommodation_id)
      .map((booking) => bookingCard(tripId, booking, data.days)) : []),
    ...data.places.map((place) => placeCard(tripId, place, data.scheduled)),
  ];
}

function createTrekObjects({ fail }) {
  // The cards for the references a note holds; a reference the trip no longer has is simply missing from the answer.
  async function resolve(ctx, tripId, refs) {
    const parsed = parseRefs(refs);
    if (!parsed) fail(400, 'Invalid trip item reference.');
    if (!parsed.length) return { objects: [] };
    const wanted = new Set(parsed.map((item) => item.ref)); const kinds = new Set(parsed.map((item) => item.kind));
    return { objects: cardsOf(tripId, await load(ctx, tripId, kinds), kinds).filter((card) => wanted.has(card.ref)) };
  }

  // Everything a snapshot editor may insert. A hotel booking already shows as its stay, so it is listed once, as the stay.
  async function list(ctx, tripId) {
    const kinds = new Set(['place', 'booking', 'day', 'stay']);
    return { objects: cardsOf(tripId, await load(ctx, tripId, kinds), kinds, true) };
  }

  return { list, resolve };
}

module.exports = { createTrekObjects };
