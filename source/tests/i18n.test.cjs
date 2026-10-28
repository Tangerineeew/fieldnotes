'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const LOCALES = ['zh', 'zh-TW', 'de', 'es', 'fr', 'hu', 'nl', 'br', 'cs', 'pl', 'ru', 'it', 'ar',
  'et', 'sk', 'tr', 'az', 'id', 'ja', 'ko', 'th', 'uk', 'gr', 'sv', 'vi', 'ca'];
const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

function sources(dir, pattern) {
  return fs.readdirSync(path.join(root, dir)).filter((name) => pattern.test(name)).map((name) => {
    const file = path.join(dir, name);
    return ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true,
      name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.JS);
  });
}
function visit(source, fn) {
  source.forEachChild(function walk(node) { fn(node); node.forEachChild(walk); });
}
const where = (node) => `${node.getSourceFile().fileName}:${node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
// String literals a value may take, including both branches of a conditional.
const literals = (node) => ts.isStringLiteralLike(node) ? [node.text]
  : ts.isConditionalExpression(node) ? [...literals(node.whenTrue), ...literals(node.whenFalse)] : null;

function table() {
  const [source] = sources('client', /^i18n\.ts$/);
  const rows = new Map();
  visit(source, (node) => {
    if (!ts.isVariableDeclaration(node) || node.name.getText() !== 'messages') return;
    for (const row of node.initializer.properties) {
      rows.set(row.name.text ?? row.name.getText(), Object.fromEntries(row.initializer.properties.map((cell) =>
        [cell.name.text ?? cell.name.getText(), cell.initializer.text])));
    }
  });
  return rows;
}

// Every message a user can see: t()/translate() keys and api.ts fallbacks in the client, failures and their parameters on the server.
function usedKeys() {
  const keys = new Map(); const dynamic = [];
  const add = (key, node, zh) => { if (!keys.has(key)) keys.set(key, { at: where(node), zh }); };
  for (const source of sources('client', /^(?!i18n\.ts$).+\.tsx?$/)) {
    visit(source, (node) => {
      if (source.fileName.endsWith('api.ts') && ts.isStringLiteral(node) && / /.test(node.text)) add(node.text, node);
      if (!ts.isCallExpression(node) || !node.arguments.length) return;
      const callee = node.expression.getText().replace(/\?\.?$/, '');
      const [key, zh] = node.arguments;
      if (!['t', 'options.t', 'translate'].includes(callee)) return;
      if (ts.isTemplateExpression(key)) dynamic.push(where(node));
      else if (ts.isStringLiteralLike(key)) {
        add(key.text, node, callee === 'translate' || !zh || !ts.isStringLiteralLike(zh) ? undefined : zh.text);
      }
    });
  }
  for (const source of sources('server', /\.cjs$/)) {
    const constants = new Map();
    visit(source, (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isStringLiteralLike(node.initializer)) {
        constants.set(node.name.getText(), node.initializer.text);
      }
    });
    visit(source, (node) => {
      if (ts.isParameter(node) && node.parent.name?.getText() === 'imageData' && node.initializer) add(node.initializer.text, node);
      const call = ts.isCallExpression(node) || ts.isNewExpression(node) ? node : null;
      if (!call?.arguments) return;
      const name = call.expression.getText();
      const argument = { fail: 1, Problem: 1, text: 2, imageData: 1 }[name];
      if (argument === undefined || !call.arguments[argument]) return;
      const message = call.arguments[argument];
      // `fail` forwards its own parameter, and String(error.message) relays a host error verbatim; neither is a key.
      if (message.getText() === 'message' || message.getText().startsWith('String(')) return;
      const values = literals(message) || (constants.has(message.getText()) ? [constants.get(message.getText())] : null);
      if (!values && (name === 'fail' || name === 'Problem')) dynamic.push(where(call));
      for (const value of values || []) add(value, call);
    });
  }
  return { keys, dynamic };
}

test('every visible message is a literal key with a complete translation row', () => {
  const rows = table(); const { keys, dynamic } = usedKeys();
  assert.deepEqual(dynamic, [], 'Interpolate with {placeholders} and vars instead of building keys at runtime.');
  const problems = [];
  for (const [key, { at, zh }] of keys) {
    const row = rows.get(key);
    if (!row) { problems.push(`${at} missing row: ${key}`); continue; }
    for (const locale of LOCALES) {
      if (!row[locale]?.trim()) problems.push(`${at} ${locale} missing: ${key}`);
      else if (placeholders(row[locale]).join() !== placeholders(key).join()) problems.push(`${at} ${locale} placeholders differ: ${key}`);
    }
    if (zh !== undefined && row.zh !== zh) problems.push(`${at} zh differs from the call site: ${key}`);
  }
  assert.deepEqual(problems, []);
});

test('the translation table holds no rows nothing uses', () => {
  const { keys } = usedKeys();
  assert.deepEqual([...table().keys()].filter((key) => !keys.has(key)), []);
});
