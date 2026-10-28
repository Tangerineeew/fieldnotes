'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { build } = require('esbuild');

async function main() {
  const root = path.resolve(__dirname, '..');
  const { version } = require(path.join(root, 'package.json'));
  for (const name of ['fieldnotes', 'fieldnotes-trip']) {
    const out = path.join(root, 'dist', name);
    await fs.mkdir(path.join(out, 'server'), { recursive: true });
    // Hashed font names change with their content, so a stale client/ would ship every font it ever had.
    await fs.rm(path.join(out, 'client'), { recursive: true, force: true });
    await fs.mkdir(path.join(out, 'client'), { recursive: true });
    await fs.copyFile(path.join(root, `${name}.json`), path.join(out, 'trek-plugin.json'));
    await fs.writeFile(path.join(out, 'package.json'), JSON.stringify({ name, version, type: 'commonjs' }));
    // Packing strips node_modules and TREK injects only trek-plugin-sdk, so server dependencies (yjs) are bundled in.
    if (name === 'fieldnotes') {
      await build({ entryPoints: [path.join(root, 'server/index.js')], bundle: true, platform: 'node', format: 'cjs', target: ['node20'],
        external: ['trek-plugin-sdk'], outfile: path.join(out, 'server/index.js') });
    } else await fs.copyFile(path.join(root, 'server/trip.js'), path.join(out, 'server/index.js'));
    await fs.copyFile(path.join(root, 'client/index.html'), path.join(out, 'client/index.html'));
    await build({ entryPoints: [path.join(root, 'client/main.tsx')], bundle: true, minify: true, format: 'iife',
      target: ['es2022'], outfile: path.join(out, 'client/app.js'), define: { 'process.env.NODE_ENV': '"production"' },
      loader: { '.woff2': 'file' }, assetNames: 'fonts/[name]-[hash]' });
    // pdf.js is loaded only when a page shows a PDF; its data files become scripts, which the frame may load (see pdf-engine.ts).
    await build({ entryPoints: [path.join(root, 'client/pdf-engine.ts')], bundle: true, minify: true, format: 'iife',
      target: ['es2022'], outfile: path.join(out, 'client/pdf.js'), logOverride: { 'empty-import-meta': 'silent' },
      banner: { js: '/*! pdf.js, Mozilla, Apache License 2.0; see pdf-data/LICENSE_PDFJS */' } });
    await fs.mkdir(path.join(out, 'client/pdf-data'), { recursive: true });
    await fs.copyFile(path.join(root, 'node_modules/pdfjs-dist/LICENSE'), path.join(out, 'client/pdf-data/LICENSE_PDFJS'));
    for (const [from, to] of [['cmaps', 'cmaps'], ['standard_fonts', 'fonts']]) {
      const source = path.join(root, 'node_modules/pdfjs-dist', from); const target = path.join(out, 'client/pdf-data', to);
      await fs.mkdir(target, { recursive: true });
      for (const file of await fs.readdir(source)) {
        // The fonts' licences travel with them.
        if (file.startsWith('LICENSE')) await fs.copyFile(path.join(source, file), path.join(target, file));
        if (!/\.(bcmap|pfb|ttf)$/.test(file)) continue;
        const base64 = (await fs.readFile(path.join(source, file))).toString('base64');
        await fs.writeFile(path.join(target, `${file}.js`), `fieldnotesPdfData(${JSON.stringify(`${to}/${file}`)},"${base64}");`);
      }
    }
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
