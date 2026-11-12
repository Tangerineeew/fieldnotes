// The README images, made the same way every time. For each language (en, then zh):
//   1. Stop the dev server, copy fixtures.<lang>.json to dist/fieldnotes/dev-fixtures.json, delete dist/fieldnotes/.trek-dev.
//   2. Start the dev server on port 4317 and run `node seed.mjs <lang> dist/fieldnotes/.trek-dev/db.sqlite`.
//   3. In ego-browser: `(await import('./shots.mjs')).run(page, '<lang>', null, task)` captures the raw shots.
// Then `node compose.mjs [name …]` writes the pages and `(await import('./render.mjs')).render(page, names)` the images.
// Every raw README shot for one language, from the seeded demo data: run(page, 'en' | 'zh', only, task).
import { setup, phone, shot, wait, settle, frameBox, hideScrollbars, MAC, PHONE } from './lib.mjs';

const T = {
  en: { country: 'China', region: 'Yunnan', main: 'Getting around Yunnan', day: 'Day 1: Kunming', around: 'Getting around',
    plans: 'Daily plans', prep: 'Before you go', esim: 'eSIM and Wi-Fi', edit: 'Edit', sharing: 'Sharing', comments: 'Comments',
    bin: 'Recently Deleted', old: 'Lijiang hostels (old list)', preview: 'Jade Dragon Snow Mountain', properties: 'Properties' },
  zh: { country: '中国', region: '云南', main: '云南交通速查', day: '第一天：昆明', around: '交通', plans: '每日计划', prep: '行前准备',
    esim: 'eSIM 与 Wi-Fi', edit: '编辑', sharing: '共享', comments: '评论', bin: '最近删除', old: '丽江青旅（旧清单）',
    preview: '玉龙雪山', properties: '属性' },
};

// Finder rows by their exact name, so a folder never matches a note that starts with its name.
const row = (label) => `css=.fn-finder-column .fn-finder-name > bdi:text-is("${label}")`;
const open = async (page, label) => { await page.waitForSelector(row(label)); await page.click(row(label)); await wait(500); };
const twice = async (page, label) => { await open(page, label); await page.click(row(label)); await wait(1800); };
const button = (page, name) => page.click(`loc=role:button[name="${name}"]`);
// Scrolls the note back to its top, as it first opens.
const top = async (page) => {
  const box = await frameBox(page); const x = box.x + box.width / 2; const y = box.y + box.height / 2;
  await page.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: -4000 }); await wait(800);
};

// The cover shots also need the task, to reach inside the plugin frame.
export async function run(page, lang, only = null, task = null) {
  const t = T[lang]; const go = (name) => !only || only.includes(name);
  const name = (shotName) => `${lang}-${shotName}`;
  if (go('library-light')) {
    await setup(page, { locale: lang, width: 1360 });
    await open(page, t.country); await open(page, t.region); await open(page, t.main); await wait(1200);
    await shot(page, name('library-light'), { height: 900 });
  }
  // The covers: the light page as a MacBook shows it in Safari, and the dark page on a phone; both hide their scrollbars.
  if (go('library-mac')) {
    await setup(page, { locale: lang, width: MAC.width, height: 1300 });
    await open(page, t.country); await open(page, t.region); await open(page, t.main); await wait(1200);
    await hideScrollbars(task); await shot(page, name('library-mac'), { height: MAC.height });
  }
  if (go('library-phone')) {
    await phone(page, { locale: lang });
    await open(page, t.country); await open(page, t.region); await open(page, t.main); await wait(2500);
    // The note itself, closed drawer and scrolled to the top, as it first opens on a phone.
    await page.click('css=.fn-note-browser-scrim'); await settle(page);
    await top(page); await hideScrollbars(task);
    await shot(page, name('library-phone'), { top: -PHONE.top, height: PHONE.height });
  }
  if (go('editor')) {
    await setup(page, { locale: lang, width: 1100, height: 1300 });
    await open(page, t.country); await open(page, t.region); await twice(page, t.main);
    await button(page, t.edit); await wait(2500);
    // Folded properties leave the writing itself in view.
    await button(page, t.properties); await wait(600);
    await shot(page, name('editor'), { height: 1080 });
  }
  if (go('sharing')) {
    await setup(page, { locale: lang, width: 1360, height: 1300 });
    await open(page, t.prep); await twice(page, t.esim);
    await button(page, t.sharing); await wait(1200);
    await shot(page, name('sharing'), { height: 1200 });
  }
  if (go('deleted')) {
    await setup(page, { locale: lang, width: 1360 });
    await open(page, t.bin); await open(page, t.old); await wait(800);
    await shot(page, name('deleted'), { height: 640 });
  }
  if (go('trip-list')) {
    await setup(page, { locale: lang, trip: true, width: 1360 });
    await open(page, t.preview); await wait(1000);
    await shot(page, name('trip-list'), { height: 760 });
  }
  if (go('comments')) {
    await setup(page, { locale: lang, trip: true, width: 1400, height: 1300 });
    await open(page, t.around); await twice(page, t.main);
    await button(page, t.comments); await wait(1500);
    await shot(page, name('comments'), { height: 1000 });
  }
  if (go('comments-mac')) {
    await setup(page, { locale: lang, trip: true, width: MAC.width, height: 1300 });
    await open(page, t.around); await twice(page, t.main);
    await button(page, t.comments); await wait(1500); await settle(page);
    await hideScrollbars(task); await shot(page, name('comments-mac'), { height: MAC.height });
  }
  if (go('comments-phone')) {
    await phone(page, { locale: lang, trip: true });
    await open(page, t.around); await open(page, t.main); await wait(2500);
    await page.click('css=.fn-note-browser-scrim'); await settle(page);
    await button(page, t.comments); await wait(1500); await settle(page); await hideScrollbars(task);
    await shot(page, name('comments-phone'), { top: -PHONE.top, height: PHONE.height });
  }
  if (go('cards')) {
    await setup(page, { locale: lang, trip: true, width: 1100, height: 1500 });
    await open(page, t.plans); await twice(page, t.day); await wait(1500);
    await shot(page, name('cards'), { height: 1240 });
  }
  return frameBox(page);
}
