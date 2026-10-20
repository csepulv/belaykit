// Every export is documented. Each runtime export, and every name the package's
// .d.ts entry point exports (following `export * from` into the files it re-exports), is a
// heading on its package's API page.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as core from '@belaykit/core';
import * as rulebook from '@belaykit/rulebook';
import { describe, expect, test } from 'vitest';
import { headingText, nodesOf, readDoc, REPO, repoPathOf } from '../src/docs.js';

const DECLARATION = /^export (?:declare )?(?:abstract )?(?:interface|type|class|function|const|let|enum|namespace) (\w+)/gm;
const NAMED_EXPORTS = /^export (?:type )?\{([^}]*)\}/gm;
const STAR_EXPORT = /^export \* from ['"](.+?)['"]/gm;

// `export { a, b as c }` exports b's new name, c.
const namesIn = (list) => list.split(',').map((part) => part.trim().split(/\s+as\s+/).pop()).filter(Boolean);

function declared(file) {
  const source = readFileSync(join(REPO, file), 'utf-8');
  const reexported = [...source.matchAll(STAR_EXPORT)].map(([, target]) => join(dirname(file), target.replace(/\.js$/, '.d.ts')));
  return [
    ...[...source.matchAll(DECLARATION)].map(([, name]) => name),
    ...[...source.matchAll(NAMED_EXPORTS)].flatMap(([, list]) => namesIn(list)),
    ...reexported.flatMap(declared),
  ];
}

const PACKAGES = {
  core: { runtime: Object.keys(core), types: declared('packages/core/index.d.ts') },
  rulebook: { runtime: Object.keys(rulebook), types: declared('packages/rulebook/index.d.ts') },
};

const headingsOf = (path) => {
  const doc = readDoc(path);
  return new Set([...nodesOf(doc.tree)].filter((node) => node.type === 'heading').map(headingText).map((text) => text.replace(/\(.*$/, '').trim()));
};

describe.each(Object.entries(PACKAGES))('the API reference for %s', (name, { runtime, types }) => {
  test('names every export and exported type as a heading', () => {
    const headings = headingsOf(repoPathOf(`documentation/api/${name}.md`));
    expect([...new Set([...runtime, ...types])].filter((exported) => !headings.has(exported))).toEqual([]);
  });

  test('finds the exports it checks', () => {
    expect(runtime.length).toBeGreaterThan(2);
    expect(types.length).toBeGreaterThan(5);
  });
});
