'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

// Refreshes the two publishable repositories from this workspace. Each repository root is the built plugin, exactly
// what `trek-plugin pack` zips; fieldnotes also carries this workspace under source/. README, docs/ and LICENSE are
// written in the repositories themselves and left untouched here.
const PLUGIN_FILES = ['trek-plugin.json', 'package.json', 'server', 'client'];
const SOURCE_FILES = ['client', 'server', 'shared', 'scripts', 'tests', 'fieldnotes.json', 'fieldnotes-trip.json', 'package.json',
  'package-lock.json', 'tsconfig.json', '.gitignore'];

async function replace(from, to) {
  await fs.rm(to, { recursive: true, force: true });
  await fs.cp(from, to, { recursive: true });
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const targets = process.argv.slice(2).map((target) => path.resolve(target));
  if (targets.length !== 2) throw new Error('Usage: npm run export -- <fieldnotes repository> <fieldnotes-trip repository>');
  for (const [name, target] of [['fieldnotes', targets[0]], ['fieldnotes-trip', targets[1]]]) {
    if (path.basename(target) !== name) throw new Error(`${target} must be a directory named ${name}, as the registry requires.`);
    for (const file of PLUGIN_FILES) await replace(path.join(root, 'dist', name, file), path.join(target, file));
  }
  for (const file of SOURCE_FILES) await replace(path.join(root, file), path.join(targets[0], 'source', file));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
