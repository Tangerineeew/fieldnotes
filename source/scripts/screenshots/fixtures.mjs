// Writes fixtures.en.json and fixtures.zh.json, the trips and people the dev server plays: node fixtures.mjs
// The main trip is a spring in Yunnan; two smaller trips let a note sit in more than one.
import fs from 'node:fs';


const PDF = JSON.parse(fs.readFileSync(new URL('./fixtures.en.json', import.meta.url))).trips['10'].files[0].content_base64;
const L = (en, zh) => ({ en, zh });
const CATEGORY = {
  stay: [7, L('Stay', '住宿'), '🛏️', '#64748b'], history: [3, L('History', '历史文化'), '🏛️', '#8b5cf6'],
  food: [4, L('Food', '美食'), '🍜', '#f59e0b'], nature: [8, L('Nature', '自然'), '🏞️', '#10b981'],
  views: [5, L('Views', '观景'), '🗻', '#0ea5e9'],
};
const PLACES = {
  601: [L('Green Lake Park', '翠湖公园'), 'nature', 25.0516, 102.7058, L('Cuihu South Road, Kunming', '昆明市翠湖南路')],
  602: [L('Wenlin Street', '文林街'), 'food', 25.0573, 102.7029, L('Wenlin Street, Kunming', '昆明市文林街')],
  603: [L('Golden Horse and Jade Rooster Arch', '金马碧鸡坊'), 'history', 25.0332, 102.7110, L('Jinbi Road, Kunming', '昆明市金碧路')],
  604: [L('Stone Forest', '石林'), 'nature', 24.8144, 103.3253, L('Shilin County, Kunming', '昆明市石林县')],
  605: [L('Jianxin Garden', '建新园'), 'food', 25.0402, 102.7093, L('Baoshan Street, Kunming', '昆明市宝善街')],
  606: [L('Cuihu Hotel', '翠湖宾馆'), 'stay', 25.0498, 102.7041, L('6 Cuihu South Road, Kunming', '昆明市翠湖南路 6 号')],
  607: [L('Erhai Lake', '洱海'), 'views', 25.7690, 100.2610, L('Dali', '大理')],
  608: [L('Dali Old Town', '大理古城'), 'history', 25.6930, 100.1640, L('Dali', '大理市')],
  609: [L('Xizhou Ancient Town', '喜洲古镇'), 'history', 25.8530, 100.1350, L('Xizhou, Dali', '大理市喜洲镇')],
  610: [L('Erhai Lakeside Inn', '洱海边客栈'), 'stay', 25.7850, 100.2500, L('Caicun, Dali', '大理市才村')],
  611: [L('Jade Dragon Snow Mountain', '玉龙雪山'), 'views', 27.1000, 100.1800, L('Lijiang', '丽江市')],
};
const DAYS = [
  [101, '2026-04-01', L('Arrive in Kunming', '抵达昆明'), [[606, '14:30'], [601, '16:00'], [602, null], [603, '18:30']]],
  [102, '2026-04-02', L('Stone Forest', '石林一日'), [[604, '08:30'], [605, '19:00']]],
  [103, '2026-04-03', L('On to Dali', '前往大理'), [[610, '13:30'], [607, '16:00'], [608, '19:00']]],
  [104, '2026-04-04', L('Around Erhai', '环洱海'), [[609, '10:00']]],
  [105, '2026-04-05', L('Jade Dragon Snow Mountain', '玉龙雪山'), [[611, '08:00']]],
];
const PEOPLE = [L('Mika', '橘子'), L('Leo', '小周'), L('Aya', '阿雅'), L('Ken', '阿健'), L('Nora', '诺拉')];

for (const lang of ['en', 'zh']) {
  const place = (id) => {
    const [name, kind, lat, lng, address] = PLACES[id]; const [cid, cname, icon, color] = CATEGORY[kind];
    return { id, trip_id: 10, name: name[lang], category: { id: cid, name: cname[lang], icon, color }, lat, lng, address: address[lang] };
  };
  let assignment = 0; const assignmentOf = {};
  const days = DAYS.map(([id, date, title, stops], index) => ({ id, trip_id: 10, day_number: index + 1, date, title: title[lang],
    assignments: stops.map(([placeId, time], order) => {
      assignment += 1; assignmentOf[placeId] = assignment;
      return { id: assignment, day_id: id, place_id: placeId, order_index: order, assignment_time: time, place: place(placeId) };
    }) }));
  const name = (id) => PLACES[id][0][lang];
  const trip = {
    members: [1, 2, 3, 4, 5], data: { id: 10, user_id: 1, title: L('Spring in Yunnan', '云南春日')[lang] }, days,
    files: [{ id: 41, trip_id: 10, filename: 'a1b2.pdf', original_name: L('Dali inn confirmation.pdf', '大理客栈预订确认.pdf')[lang],
      mime_type: 'application/pdf', mimetype: 'application/pdf', file_size: 5054, created_at: '2026-03-20T09:00:00Z',
      content_base64: PDF }],
    places: Object.keys(PLACES).map((id) => place(Number(id))),
    reservations: [
      { id: 71, trip_id: 10, type: 'flight', title: L('Shanghai Pudong → Kunming Changshui', '上海浦东 → 昆明长水')[lang],
        status: 'confirmed', confirmation_number: 'MU7K2D', reservation_time: '2026-04-01T08:35',
        reservation_end_time: '2026-04-01T12:10', day_id: 101, day_positions: { 101: 0.5 },
        metadata: JSON.stringify({ airline: L('China Eastern', '东方航空')[lang], flight_number: 'MU5801', seat: '32A',
          departure_timezone: 'Asia/Shanghai', arrival_timezone: 'Asia/Shanghai' }),
        endpoints: [
          { role: 'from', name: L('Shanghai Pudong', '上海浦东')[lang], code: 'PVG', local_time: '08:35', local_date: '2026-04-01',
            timezone: 'Asia/Shanghai' },
          { role: 'to', name: L('Kunming Changshui', '昆明长水')[lang], code: 'KMG', local_time: '12:10', local_date: '2026-04-01',
            timezone: 'Asia/Shanghai' }] },
      { id: 72, trip_id: 10, type: 'event', title: L('Stone Forest tickets', '石林门票')[lang], status: 'pending',
        reservation_time: '2026-04-02T08:30', day_id: 102, assignment_id: assignmentOf[604], location: PLACES[604][4][lang] },
      { id: 73, trip_id: 10, type: 'restaurant', title: name(605), status: 'confirmed', confirmation_number: 'R-2046',
        reservation_time: '2026-04-02T19:00', reservation_end_time: '2026-04-02T20:30', day_id: 102,
        assignment_id: assignmentOf[605], location: PLACES[605][4][lang] },
      { id: 74, trip_id: 10, type: 'hotel', title: name(606), status: 'confirmed', accommodation_id: 31, confirmation_number: '5520873',
        day_id: 101 },
      { id: 75, trip_id: 10, type: 'train', title: L('Kunming South → Dali', '昆明南 → 大理')[lang], status: 'confirmed',
        reservation_time: '2026-04-03T09:10', reservation_end_time: '2026-04-03T11:15', day_id: 103, day_positions: { 103: 0.5 },
        metadata: JSON.stringify({ train_number: 'D8662', seat: L('Car 5, 08F', '5 车 08F')[lang] }),
        endpoints: [{ role: 'from', name: L('Kunming South', '昆明南')[lang], local_time: '09:10', local_date: '2026-04-03' },
          { role: 'to', name: L('Dali', '大理')[lang], local_time: '11:15', local_date: '2026-04-03' }] },
      { id: 76, trip_id: 10, type: 'hotel', title: name(610), status: 'confirmed', accommodation_id: 32, confirmation_number: 'DL0412',
        day_id: 103 },
    ],
    accommodations: [[31, 606, 101, 103], [32, 610, 103, 105]].map(([id, placeId, start, end]) => ({ id, trip_id: 10,
      place_id: placeId, start_day_id: start, end_day_id: end, check_in: '14:00', check_out: '12:00',
      confirmation: id === 31 ? '5520873' : 'DL0412', place_name: name(placeId), place_address: PLACES[placeId][4][lang],
      place_lat: PLACES[placeId][2], place_lng: PLACES[placeId][3] })),
  };
  const small = (id, title, date, dayTitle, members) => ({ members, data: { id, user_id: 1, title: title[lang] },
    days: [{ id: id * 10 + 1, trip_id: id, date, title: dayTitle[lang] }] });
  const fixtures = {
    actingUserId: 1,
    trips: { 10: trip, 20: small(20, L('Seoul Weekend', '首尔周末'), '2026-11-01', L('Seoul', '首尔'), [1, 2, 4]),
      30: small(30, L('Autumn in Kyoto', '京都秋日'), '2026-11-15', L('Kyoto', '京都'), [1, 3, 5]) },
    users: Object.fromEntries(PEOPLE.map((person, index) => [index + 1, { id: index + 1, display_name: person[lang] }])),
  };
  fs.writeFileSync(new URL(`./fixtures.${lang}.json`, import.meta.url), `${JSON.stringify(fixtures, null, 2)}\n`);
}
console.log('fixtures written');
