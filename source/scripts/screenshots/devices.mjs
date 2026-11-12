// The cover's devices, drawn from their real proportions: a Space Black 14-inch MacBook Pro showing the light page in Safari,
// and a white iPhone showing the dark one. Shapes and colours only, no logos or model names.
import { MAC } from './lib.mjs';


// The laptop's screen is drawn in points, the menu bar and Safari's toolbar above the page, and scaled down whole.
const MENU_BAR = 37; const TOOLBAR = 52;
const SCREEN = { width: MAC.width, height: MAC.height + MENU_BAR + TOOLBAR };
const MENU = {
  en: { app: 'Safari', items: ['File', 'Edit', 'View', 'History', 'Bookmarks', 'Window', 'Help'], clock: 'Thu Nov 12 9:41 AM' },
  zh: { app: 'Safari浏览器', items: ['文件', '编辑', '显示', '历史记录', '书签', '窗口', '帮助'], clock: '11月12日 周四 09:41' },
};
const icon = (paths, size) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor"
  stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const BATTERY = `<svg width="27" height="13" viewBox="0 0 27 13"><rect x=".5" y=".5" width="23" height="12" rx="3.5" fill="none"
  stroke="currentColor" stroke-opacity=".45"/><rect x="2.5" y="2.5" width="16" height="8" rx="2" fill="currentColor"/>
  <path d="M25 4.5v4a2 2 0 0 0 0-4Z" fill="currentColor" fill-opacity=".45"/></svg>`;
const WIFI = '<path d="M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0"/>'
  + '<circle cx="12" cy="19.5" r=".6" fill="currentColor"/>';
const SEARCH = '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>';
const CONTROLS = '<rect x="3" y="6" width="18" height="4" rx="2"/><rect x="3" y="14" width="18" height="4" rx="2"/>'
  + '<circle cx="7" cy="8" r="1" fill="currentColor"/><circle cx="17" cy="16" r="1" fill="currentColor"/>';
const LIGHTS = ['#ff5f57', '#febc2e', '#28c840'].map((colour) => `<i class="light" style="background:${colour}"></i>`).join('');

const desktop = (shot, lang) => { const menu = MENU[lang];
  return `<div class="menubar"><b>${menu.app}</b>${menu.items.map((item) => `<span>${item}</span>`).join('')}
  <span class="tray">${icon(WIFI, 17)}${BATTERY}${icon(SEARCH, 16)}${icon(CONTROLS, 17)}<span>${menu.clock}</span></span></div>
<div class="safari"><div class="toolbar">${LIGHTS}
  <span class="tool sidebar">${icon('<rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M9.5 4.5v15"/>', 19)}</span>
  <span class="tool">${icon('<path d="m14.5 6-6 6 6 6"/>', 20)}</span>
  <span class="tool dim">${icon('<path d="m9.5 6 6 6-6 6"/>', 20)}</span>
  <div class="address">${icon('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 12h8M8 15h5"/>', 16)}
    <span>trek.example.com</span>
    ${icon('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>', 15)}</div>
  <span class="tool share">${icon('<path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-8"/>', 19)}
  </span>
  <span class="tool">${icon('<path d="M12 5v14M5 12h14"/>', 19)}</span>
  <span class="tool">${icon('<rect x="3" y="7" width="14" height="13" rx="2.5"/><path d="M7 4h11a3 3 0 0 1 3 3v10"/>', 19)}</span></div>
  <div class="page" style="height:${MAC.height}px"><img src="file://${shot}" style="width:${MAC.width}px"></div></div>`; };

// width is the screen's; the lid's bezel, the hinge and the base are drawn around it.
export const laptop = (shot, lang, { x, y, width }) => {
  const scale = width / SCREEN.width; const lid = width + 22; const base = Math.round(lid * 1.135);
  return `<div class="mbp" style="left:${x}px;top:${y}px;width:${lid}px">
  <div class="lid" style="height:${Math.round(SCREEN.height * scale) + 32}px"><div class="display">
    <div class="desk" style="transform:scale(${scale})">${desktop(shot, lang)}</div></div><i class="notch"></i></div>
  <div class="hinge"></div><div class="base" style="width:${base}px;margin-left:${(lid - base) / 2}px"><i class="thumb"></i></div>
  <div class="floor" style="width:${base + 60}px;margin-left:${(lid - base) / 2 - 30}px"></div></div>`;
};

// A 390×844 point phone screen inside an 8px black glass border and a 4px titanium band; width is the whole phone's.
const BARS = `<svg viewBox="0 0 66 12" fill="#fff"><rect x="0" y="8" width="3" height="4" rx=".8"/>
<rect x="4.6" y="6" width="3" height="6" rx=".8"/>
<rect x="9.2" y="3.5" width="3" height="8.5" rx=".8"/><rect x="13.8" y="1" width="3" height="11" rx=".8"/>
<path d="M30 3.2a10 10 0 0 1 7.6 3.4l-1.3 1.3a8.2 8.2 0 0 0-12.6 0l-1.3-1.3A10 10 0 0 1 30 3.2Z
  m0 3.7a6 6 0 0 1 4.4 1.9L30 13.2l-4.4-4.4A6 6 0 0 1 30 6.9Z" transform="translate(-2 -1.4) scale(.95)"/>
<rect x="40.5" y="1.5" width="21" height="10" rx="3" fill="none" stroke="#fff" stroke-opacity=".45"/>
<rect x="42.2" y="3.2" width="14" height="6.6" rx="1.7"/><path d="M63 5v3.2a1.7 1.7 0 0 0 0-3.2Z" fill-opacity=".45"/></svg>`;
export const iphoneHeight = (width) => Math.round(844 * (width - 24) / 390) + 24;
export const iphone = (shot, { x, y, width }) => {
  const screen = width - 24; const scale = screen / 390;
  const box = `left:${x}px;top:${y}px;width:${width}px;height:${iphoneHeight(width)}px`;
  return `<div class="iphone" style="${box};--r:${Math.round(width * .165)}px;--pt:${scale}px">
  <i class="key action"></i><i class="key up"></i><i class="key down"></i><i class="key side"></i><i class="key camera"></i>
  <div class="glass"><div class="screen"><img src="file://${shot}" style="width:${screen}px">
    <div class="status"><span>9:41</span>${BARS}</div><i class="island"></i></div></div></div>`;
};

export const DEVICE_CSS = `
  .mbp, .iphone { position: absolute; }
  .mbp img, .iphone img { position: absolute; left: 0; top: 0; height: auto; }
  .lid { position: relative; box-sizing: border-box; padding: 17px 11px 15px; border-radius: 19px 19px 9px 9px; background: #050506;
    box-shadow: inset 0 0 0 1.5px #3c3c41, inset 0 0 0 2.5px #18181b, 0 1px 0 #000; }
  .display { position: relative; overflow: hidden; height: 100%; border-radius: 9px 9px 2px 2px; }
  .display::after { content: ''; position: absolute; inset: 0;
    background: linear-gradient(115deg, rgba(255, 255, 255, .16) 0 22%, transparent 42%); }
  .notch { position: absolute; top: 15px; left: 50%; width: 116px; height: 19px; margin-left: -58px; border-radius: 0 0 8px 8px;
    background: #050506; }
  .notch::after { content: ''; position: absolute; left: 50%; top: 5px; width: 6px; height: 6px; margin-left: -3px; border-radius: 50%;
    background: radial-gradient(circle at 35% 35%, #34405a, #0b0c10 70%); }
  .hinge { height: 7px; margin: 0 26px; border-radius: 0 0 3px 3px; background: linear-gradient(#020203, #1c1c1f 70%, #2a2a2e); }
  .base { position: relative; height: 17px; border-radius: 2px 2px 28px 28px / 2px 2px 15px 15px;
    background: linear-gradient(#5d5d63 0, #3a3a3f 1.5px, #2c2c30 3px, #232327 55%, #141416 100%);
    box-shadow: inset 0 -1px 0 rgba(255, 255, 255, .06), 0 2px 2px -1px rgba(0, 0, 0, .5); }
  .thumb { position: absolute; top: 0; left: 50%; width: 132px; height: 6px; margin-left: -66px; border-radius: 0 0 9px 9px;
    background: linear-gradient(#0d0d0f, #26262a); box-shadow: inset 0 -1px 0 rgba(255, 255, 255, .08); }
  .floor { position: relative; z-index: -1; height: 26px; margin-top: -12px; border-radius: 50%; filter: blur(4px);
    background: radial-gradient(closest-side, rgba(0, 0, 0, .34), rgba(0, 0, 0, .1) 60%, transparent); }

  .desk { position: absolute; left: 0; top: 0; width: ${SCREEN.width}px; height: ${SCREEN.height}px; transform-origin: 0 0;
    background: linear-gradient(135deg, #b9cbe6, #d9cfe6 55%, #efd9cf);
    font-family: -apple-system, "SF Pro Text", "PingFang SC", system-ui, sans-serif; }
  .menubar { height: ${MENU_BAR}px; display: flex; align-items: center; gap: 20px; padding: 0 16px 0 22px; font-size: 13.5px; color: #1d1d1f;
    background: rgba(255, 255, 255, .42); }
  .menubar b { font-weight: 700; }
  .tray { margin-left: auto; display: flex; align-items: center; gap: 16px; }
  .safari { position: absolute; left: 0; right: 0; top: ${MENU_BAR}px; bottom: 0; overflow: hidden; border-radius: 12px 12px 0 0;
    background: #f3f3f6; box-shadow: 0 0 0 .5px rgba(0, 0, 0, .25); }
  .toolbar { position: relative; height: ${TOOLBAR}px; display: flex; align-items: center; gap: 4px; padding: 0 12px 0 20px; color: #6b6b70;
    background: #f7f7f8; box-shadow: inset 0 -1px 0 rgba(0, 0, 0, .1); }
  .light { width: 12px; height: 12px; margin-right: 8px; border-radius: 50%; box-shadow: inset 0 0 0 .5px rgba(0, 0, 0, .18); }
  .tool { display: grid; place-items: center; width: 34px; height: 30px; }
  .tool.sidebar { margin-left: 16px; } .tool.dim { color: #bdbdc2; } .tool.share { margin-left: auto; }
  .address { position: absolute; left: 50%; top: 9px; width: 560px; height: 34px; margin-left: -280px; box-sizing: border-box;
    padding: 0 12px; display: flex; align-items: center; justify-content: space-between; border-radius: 17px;
    background: rgba(0, 0, 0, .055); }
  .address span { font-size: 14px; color: #1d1d1f; }
  .page { position: relative; overflow: hidden; }

  .iphone { box-sizing: border-box; padding: 4px; border-radius: var(--r); transform: perspective(1800px) rotateY(-9deg);
    background: linear-gradient(90deg, #a9a8a4, #e9e8e4 1.2%, #f7f6f2 3%, #d8d7d3 6%, #e6e5e1 50%,
      #d4d3cf 94%, #f4f3ef 97%, #e2e1dd 98.8%, #9f9e9a);
    box-shadow: inset 0 0 0 .8px rgba(0, 0, 0, .28), inset 0 1.5px 0 rgba(255, 255, 255, .9), 0 1px 1px rgba(0, 0, 0, .2),
      0 36px 60px -22px rgba(0, 0, 0, .42), 0 14px 22px -12px rgba(0, 0, 0, .22); }
  .glass { position: relative; box-sizing: border-box; height: 100%; padding: 8px; border-radius: calc(var(--r) - 4px); background: #000;
    box-shadow: inset 0 0 0 1px #1c1c1e; }
  .glass::after { content: ''; position: absolute; z-index: 3; inset: 0; border-radius: inherit;
    background: linear-gradient(118deg, rgba(255, 255, 255, .13) 0 18%, transparent 38%); }
  .screen { position: relative; overflow: hidden; height: 100%; border-radius: calc(var(--r) - 12px); background: #1b1b1d; }
  .island { position: absolute; z-index: 2; top: calc(11 * var(--pt)); left: 50%; width: calc(125 * var(--pt));
    height: calc(37 * var(--pt)); transform: translateX(-50%); border-radius: 99px; background: #000; }
  .status { position: absolute; z-index: 2; left: 0; right: 0; top: calc(18 * var(--pt)); height: calc(22 * var(--pt)); display: flex;
    align-items: center; justify-content: space-between; padding: 0 calc(34 * var(--pt)) 0 calc(46 * var(--pt)); color: #fff;
    font: 600 calc(17 * var(--pt)) / 1 -apple-system, "SF Pro Text", system-ui, sans-serif; letter-spacing: -.01em; }
  .status svg { width: calc(69 * var(--pt)); }
  .key { position: absolute; width: 3px; border-radius: 2px; background: linear-gradient(90deg, #a3a29e, #e8e7e3 50%, #b9b8b4); }
  .key.action, .key.up, .key.down { left: -2.5px; } .key.side, .key.camera { right: -2.5px; }
  .key.action { top: 17.5%; height: 5.5%; } .key.up { top: 26.5%; height: 9.5%; } .key.down { top: 38.5%; height: 9.5%; }
  .key.side { top: 30%; height: 14%; } .key.camera { top: 62%; height: 7%; }
`;
