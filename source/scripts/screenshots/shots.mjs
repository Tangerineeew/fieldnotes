// The README images, made the same way every time. For each language (en, then zh):
//   1. Stop the dev server, copy fixtures.<lang>.json to dist/fieldnotes/dev-fixtures.json, delete dist/fieldnotes/.trek-dev.
//   2. Start the dev server on port 4317 and run `node seed.mjs <lang> dist/fieldnotes/.trek-dev/db.sqlite`.
//   3. In ego-browser: `(await import('./shots.mjs')).run(page, '<lang>')` captures the raw shots.
// Then `node compose.mjs` writes the pages and `(await import('./render.mjs')).render(page, names)` the images.
// Every raw README shot for one language, from the seeded demo data: run(page, 'en' | 'zh').
import { setup, shot, wait, frameBox } from './lib.mjs';

const T = {
  en: { country: 'China', region: 'Yunnan', main: 'Getting around Yunnan', day: 'Day 1: Kunming', around: 'Getting around',
    plans: 'Daily plans', prep: 'Before you go', esim: 'eSIM and Wi-Fi', edit: 'Edit', sharing: 'Sharing', comments: 'Comments',
    bin: 'Recently deleted', old: 'Lijiang hostels (old list)', preview: 'Jade Dragon Snow Mountain', properties: 'Properties' },
  zh: { country: '中国', region: '云南', main: '云南交通速查', day: '第一天：昆明', around: '交通', plans: '每日计划', prep: '行前准备',
    esim: 'eSIM 与 Wi-Fi', edit: '编辑', sharing: '共享', comments: '评论', bin: '最近删除', old: '丽江青旅（旧清单）',
    preview: '玉龙雪山', properties: '属性' },
};

// Finder rows by their exact name, so a folder never matches a note that starts with its name.
const row = (label) => `css=.fn-finder-column .fn-finder-name:text-is("${label}")`;
const open = async (page, label) => { await page.click(row(label)); await wait(500); };
const twice = async (page, label) => { await open(page, label); await page.click(row(label)); await wait(1800); };
const button = (page, name) => page.click(`loc=role:button[name="${name}"]`);

export async function run(page, lang, only = null) {
  const t = T[lang]; const go = (name) => !only || only.includes(name);
  const name = (shotName) => `${lang}-${shotName}`;
  for (const theme of ['light', 'dark']) {
    if (!go(`library-${theme}`)) continue;
    await setup(page, { theme, locale: lang, width: 1360 });
    await open(page, t.country); await open(page, t.region); await open(page, t.main); await wait(1200);
    await shot(page, name(`library-${theme}`), { height: 900 });
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
  if (go('cards')) {
    await setup(page, { locale: lang, trip: true, width: 1100, height: 1500 });
    await open(page, t.plans); await twice(page, t.day); await wait(1500);
    await shot(page, name('cards'), { height: 1240 });
  }
  return frameBox(page);
}
