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
      target: ['es2022'], outfile: path.join(out, 'client/app.js'), define: { 'process.env.NODE_ENV': '"production"' } });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
