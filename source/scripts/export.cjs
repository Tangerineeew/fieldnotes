'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

// Copies the built plugins to the roots of their repositories, which is exactly what `trek-plugin pack` and the
// registry read: Fieldnotes to the repository that holds this source/ directory, Trip Fieldnotes to its sibling
// checkout (or the directory given as the first argument). README, docs/ and LICENSE stay untouched.
const PLUGIN_FILES = ['trek-plugin.json', 'package.json', 'server', 'client'];

async function replace(from, to) {
  await fs.rm(to, { recursive: true, force: true });
  await fs.cp(from, to, { recursive: true });
}

async function main() {
  const source = path.resolve(__dirname, '..');
  const fieldnotes = path.dirname(source);
  const trip = path.resolve(process.argv[2] || path.join(fieldnotes, '..', 'fieldnotes-trip'));
  for (const [name, target] of [['fieldnotes', fieldnotes], ['fieldnotes-trip', trip]]) {
    if (path.basename(target) !== name) throw new Error(`${target} must be a directory named ${name}, as the registry requires.`);
    await fs.access(path.join(target, '.git')).catch(() => { throw new Error(`${target} is not a checkout of the ${name} repository.`); });
    for (const file of PLUGIN_FILES) await replace(path.join(source, 'dist', name, file), path.join(target, file));
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
