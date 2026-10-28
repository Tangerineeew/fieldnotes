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
  await page.cdp('Emulation.setDeviceMetricsOverride', { width: 2000, height, deviceScaleFactor: 2, mobile: false });
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
