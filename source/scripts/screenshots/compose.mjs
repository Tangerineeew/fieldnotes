// Writes one HTML page per README image: a quiet near-white ground and the cropped interface in one window. Covers add the
// app tile, the name and the tagline above a single window that runs off the bottom edge.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { WORK as DIR } from './lib.mjs';


const RAW = `${DIR}/raw`;
fs.mkdirSync(`${DIR}/pages`, { recursive: true });

// Crops in CSS pixels of the raw shots, which were taken at 2x.
const CROP = {
  library: { x: 124, y: 182, w: 1112, h: 637 },
  editor: { x: 311, y: 163, w: 765, h: 845 },
  sharing: { x: 400, y: 70, w: 560, h: 720 },
  bring: { x: 412, y: 604, w: 512, h: 150 },
  properties: { x: 360, y: 378, w: 640, h: 262 },
  deleted: { x: 124, y: 182, w: 1112, h: 420 },
  trip: { x: 124, y: 122, w: 1112, h: 481 },
  comments: { x: 310, y: 162, w: 1075, h: 678 },
  cards: { x: 311, y: 163, w: 765, h: 945 },
};
const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
<path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4"/><path d="M2 6h4M2 10h4M2 14h4M2 18h4"/>
<path d="M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837
  a2 2 0 0 0 .854-.506z"/></svg>`;

// Shots are 2x, so a CSS pixel of the page they came from is two of theirs.
const pixels = (file) => Number(/pixelWidth: (\d+)/.exec(execFileSync('sips', ['-g', 'pixelWidth', file]).toString())[1]);
const windowOf = (shot, crop, width, extra = '') => {
  const scale = width / crop.w; const natural = pixels(`${RAW}/${shot}.png`) / 2;
  return `<div class="window" style="width:${width}px;height:${Math.round(crop.h * scale)}px;${extra}">
    <img src="file://${RAW}/${shot}.png" style="width:${natural * scale}px;left:${-crop.x * scale}px;top:${-crop.y * scale}px"></div>`;
};
const page = (name, width, height, body, lang) => fs.writeFileSync(`${DIR}/pages/${name}.html`, `<!doctype html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><meta charset="utf-8"><meta name="size" content="${width}x${height}"><style>
  html, body { margin: 0; }
  body { width: ${width}px; height: ${height}px; overflow: hidden; position: relative; color: #1d1d1f;
    background: radial-gradient(1400px 700px at 50% -20%, #ffffff, transparent 70%), linear-gradient(#f9f9fb, #efeff2);
    font-family: -apple-system, "SF Pro Display", "PingFang SC", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  .window { position: absolute; overflow: hidden; border-radius: 16px; background: #fff;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, .06), 0 1px 3px rgba(0, 0, 0, .05), 0 24px 60px -24px rgba(0, 0, 0, .22); }
  .window img { position: absolute; height: auto; }
  .head { position: absolute; left: 0; right: 0; top: 64px; display: grid; justify-items: center; text-align: center; }
  .head b { display: grid; place-items: center; width: 60px; height: 60px; border-radius: 15px;
    background: linear-gradient(165deg, #3a3a3f, #141416); box-shadow: 0 8px 20px -8px rgba(0, 0, 0, .4); }
  .head b svg { width: 32px; height: 32px; }
  .head h1 { margin: 22px 0 0; font-size: 56px; font-weight: 600; letter-spacing: -.035em; line-height: 1.05; }
  .head p { margin: 12px 0 0; font-size: 22px; color: #6e6e73; letter-spacing: -.005em; }
</style><body>${body}</body></html>`);

const TAGLINE = {
  en: { fieldnotes: 'Write it down once. Have it on every trip.', trip: 'What your group needs to know, kept with the trip.' },
  zh: { fieldnotes: '记录下旅途中积累的经验，下次出发随时用得上。', trip: '同行的人需要知道的，都放在旅行里。' },
};

for (const lang of ['en', 'zh']) {
  const suffix = lang === 'zh' ? '.zh-CN' : '';
  const cover = (out, name, tagline, shot, crop) => page(`${out}${suffix}`, 1600, 900,
    `<div class="head"><b>${ICON}</b><h1>${name}</h1><p>${tagline}</p></div>`
    + windowOf(shot, crop, 1200, 'left:200px;top:318px;'), lang);
  cover('fieldnotes-screenshot', 'Fieldnotes', TAGLINE[lang].fieldnotes, `${lang}-library-light`, CROP.library);
  cover('trip-screenshot', 'Trip Fieldnotes', TAGLINE[lang].trip, `${lang}-comments`, CROP.comments);
  // A feature sits whole in the middle of its image with an even margin, never drawn larger than it was taken; a small one
  // gets a small image rather than empty space.
  const feature = (out, shot, crop) => {
    const fit = Math.min(1, 1040 / crop.w, 960 / crop.h); const width = Math.round(crop.w * fit); const height = Math.round(crop.h * fit);
    const margin = 80;
    page(`${out}${suffix}`, width + margin * 2, height + margin * 2,
      windowOf(shot, crop, width, `left:${margin}px;top:${margin}px;`), lang);
  };
  feature('fieldnotes-library', `${lang}-library-light`, CROP.library);
  feature('fieldnotes-editor', `${lang}-editor`, CROP.editor);
  feature('fieldnotes-properties', `${lang}-comments`, CROP.properties);
  feature('fieldnotes-sharing', `${lang}-sharing`, CROP.sharing);
  feature('fieldnotes-bring', `${lang}-sharing`, CROP.bring);
  feature('fieldnotes-deleted', `${lang}-deleted`, CROP.deleted);
  feature('fieldnotes-trip-list', `${lang}-trip-list`, CROP.trip);
  feature('trip-trip-list', `${lang}-trip-list`, CROP.trip);
  feature('trip-comments', `${lang}-comments`, CROP.comments);
  feature('trip-cards', `${lang}-cards`, CROP.cards);
}
console.log(fs.readdirSync(`${DIR}/pages`).join(' '));
