// Renders the composed pages to PNG at 2x, straight into the repositories' docs/: render(page, names).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORK as DIR, capture } from './lib.mjs';


// fieldnotes-x goes to this repository's docs/x.png, trip-x to the sibling fieldnotes-trip checkout's.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const target = (name) => name.startsWith('trip-')
  ? path.join(ROOT, '../fieldnotes-trip/docs', `${name.slice(5)}.png`) : path.join(ROOT, 'docs', `${name.slice(11)}.png`);
export async function render(page, names) {
  for (const name of names) {
    const [width, height] = /name="size" content="(\d+)x(\d+)"/.exec(fs.readFileSync(`${DIR}/pages/${name}.html`, 'utf8'))
      .slice(1).map(Number);
    await page.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
    await page.goto(`file://${DIR}/pages/${name}.html`);
    await page.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await capture(page, target(name), { x: 0, y: 0, width, height });
  }
}
