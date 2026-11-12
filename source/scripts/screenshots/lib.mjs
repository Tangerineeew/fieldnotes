import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Raw shots and composed pages live outside the repository; only the finished images are kept, in each repository's docs/.
export const WORK = path.join(os.tmpdir(), 'fieldnotes-screenshots');

// Shared steps for the README screenshots: one viewport, one frame width, theme, language and trip context.
export const OUT = path.join(WORK, 'raw');
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function setup(page, { theme = 'light', trip = false, locale = 'en', width = 1200, height = 1100 } = {}) {
  // The preview places the frame 500px in, so the window widens with it rather than cutting its edge off.
  const viewport = Math.max(2000, width + 540);
  await page.cdp('Emulation.setDeviceMetricsOverride', { width: viewport, height, deviceScaleFactor: 2, mobile: false });
  await page.goto(`http://localhost:4317/preview?theme=${theme}`);
  await page.waitForSelector('iframe');
  await page.evaluate(({ trip, locale, width }) => {
    const original = window.ctx;
    window.ctx = () => { const context = original(); context.locale = locale; context.formats.locale = locale; return context; };
    const box = document.getElementById('trip'); box.checked = trip; box.dispatchEvent(new Event('change'));
    const frame = document.querySelector('iframe'); frame.style.width = `${width}px`;
    document.querySelectorAll('body > *:not(:has(iframe)):not(iframe)').forEach((node) => { node.style.visibility = 'hidden'; });
  }, { trip, locale, width });
  await wait(1500);
}

// A 14-inch MacBook Pro shows 1512×982 points; below the menu bar and Safari's toolbar the page has 1512×893.
export const MAC = { width: 1512, height: 893 };

// A phone's plugin page on a 390×844 point screen. From TREK 5.1.4 the frame sits below the status bar and above the home
// indicator (the dock is not drawn), so a shot reaches PHONE.top above the frame and PHONE.bottom below it, in the page's colour.
export const PHONE = { width: 390, height: 844, top: 54, bottom: 24 };

export async function phone(page, { theme = 'dark', trip = false, locale = 'en' } = {}) {
  await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 1000, deviceScaleFactor: 2, mobile: false });
  await page.goto(`http://localhost:4317/preview?theme=${theme}`);
  await page.waitForSelector('iframe');
  await page.evaluate(({ trip, locale, PHONE }) => {
    const original = window.ctx;
    window.ctx = () => { const context = original(); context.locale = locale; context.formats.locale = locale;
      context.viewport = { surface: 'plugin-page', formFactor: 'phone', fill: true, insets: { top: 0, bottom: 0 } };
      return context; };
    const { width, height, top, bottom } = PHONE;
    const style = document.createElement('style');
    style.textContent = `iframe { width: ${width}px !important; height: ${height - top - bottom}px !important;
      margin-block: ${top}px ${bottom}px; } body { background: ${original().tokens['--bg-secondary']} !important; }`;
    document.head.append(style);
    document.querySelectorAll('body > *:not(:has(iframe)):not(iframe)').forEach((node) => { node.style.visibility = 'hidden'; });
    const box = document.getElementById('trip'); box.checked = trip; box.dispatchEvent(new Event('change'));
  }, { trip, locale, PHONE });
  await wait(2000);
}

// The agent's page sits in a background space, where the browser draws frames only when asked, so a sheet can stall
// mid-rise; a few throwaway captures let animations run to their end.
export async function settle(page, times = 4) {
  const clip = { x: 0, y: 0, width: 1, height: 1, scale: 1 };
  for (let index = 0; index < times; index += 1) { await page.cdp('Page.captureScreenshot', { format: 'png', clip }); await wait(250); }
}

// Safari on a Mac and a phone overlay their scrollbars and keep them out of sight. The plugin frame is cross-origin, so the
// style that hides them goes in through the frame's own target; Target commands need the task, not the page.
const HIDDEN = '* { scrollbar-width: none !important } ::-webkit-scrollbar { display: none }';
export async function hideScrollbars(task) {
  if (!task) throw new Error('The cover shots need the task: run(page, lang, only, task).');
  const { targetInfos } = await task.cdp('Target.getTargets', {});
  const frame = targetInfos.find((target) => target.type === 'iframe' && target.url.startsWith('http://localhost:4317/'));
  if (!frame) throw new Error('No plugin frame from the dev server on port 4317.');
  const { sessionId } = await task.cdp('Target.attachToTarget', { targetId: frame.targetId, flatten: false });
  const expression = `document.head.append(Object.assign(document.createElement('style'), { textContent: '${HIDDEN}' }))`;
  const message = JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression } });
  await task.cdp('Target.sendMessageToTarget', { sessionId, message });
  await task.cdp('Target.detachFromTarget', { sessionId });
  await wait(300);
}

export async function frameBox(page) {
  return page.evaluate(() => { const box = document.querySelector('iframe').getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height }; });
}

// The plugin's own area, from its top down to `height` CSS pixels (or the frame's own height).
export async function shot(page, name, { top = 0, height, left = 0, width } = {}) {
  const box = await frameBox(page);
  const clip = { x: box.x + left, y: box.y + top, width: width ?? box.width - left, height: height ?? box.height - top };
  return capture(page, `${OUT}/${name}.png`, clip);
}

export { wait };

// Page.captureScreenshot keeps the emulated 2x; the page helper would hand back CSS pixels.
export async function capture(page, path, clip) {
  const { data } = await page.cdp('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } });
  fs.writeFileSync(path, Buffer.from(data, 'base64'));
  return path;
}
