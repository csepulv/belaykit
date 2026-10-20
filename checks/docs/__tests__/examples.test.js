// A reader copies any example and it runs. A ```js run block is written to a fresh
// directory beside this package (so it imports @belaykit/* as a reader's project would, and
// finds no file an earlier example left) and run with node; the ```text output block right
// after it is what it must print. A ```js fragment block is an excerpt and isn't run; every
// JavaScript block must be one or the other.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { codeBlocks, publicDocs, readDoc, REPO } from '../src/docs.js';

const RUN_DIR = fileURLToPath(new URL('../.run', import.meta.url));
const JAVASCRIPT = new Set(['js', 'javascript', 'mjs', 'cjs', 'jsx']);
const EXAMPLE_TIMEOUT_MS = 20_000;

const docs = publicDocs().map(readDoc);
const blocks = docs.flatMap((doc) => codeBlocks(doc).map((block) => ({ doc, block, where: `${doc.path}:${block.position.start.line}` })));
const jsBlocks = blocks.filter(({ block }) => JAVASCRIPT.has(block.lang));
const runnable = jsBlocks.filter(({ block }) => block.meta === 'run');

const isRun = (node) => node?.type === 'code' && JAVASCRIPT.has(node.lang) && node.meta === 'run';
const isOutput = (node) => node?.type === 'code' && node.lang === 'text' && node.meta === 'output';

// An excerpt is whole lines of its source, so a fragment of a line, or nothing, doesn't match.
const containsLines = (source, excerpt) => excerpt.trim() !== '' && `\n${source}\n`.includes(`\n${excerpt}\n`);

function runExample(code) {
  mkdirSync(RUN_DIR, { recursive: true });
  const directory = mkdtempSync(join(RUN_DIR, 'example-'));
  try {
    writeFileSync(join(directory, 'example.mjs'), code);
    return execFileSync(process.execPath, ['example.mjs'], { encoding: 'utf-8', cwd: directory, timeout: EXAMPLE_TIMEOUT_MS });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('the docs\' examples', () => {
  test('every JavaScript block is marked run or fragment', () => {
    const unmarked = jsBlocks.filter(({ block }) => block.meta !== 'run' && !/^fragment( |$)/.test(block.meta ?? '')).map(({ where }) => where);
    expect(unmarked).toEqual([]);
  });

  test('every run block is followed by its output, and every output block follows a run block', () => {
    const withoutOutput = runnable.filter(({ block }) => !isOutput(block.next)).map(({ where }) => `${where}: no text output block right after it`);
    const strayOutput = blocks.filter(({ block }) => isOutput(block) && !isRun(block.previous)).map(({ where }) => `${where}: an output block not right after a run block`);
    expect([...withoutOutput, ...strayOutput]).toEqual([]);
  });

  test('an excerpt that names its source file appears in it as whole lines, word for word', () => {
    const excerpts = blocks.filter(({ block }) => /^fragment \S/.test(block.meta ?? ''))
      .map(({ block, where }) => ({ where, source: block.meta.slice('fragment '.length), text: block.value }));
    const drifted = excerpts.filter(({ source, text }) => !existsSync(join(REPO, source)) || !containsLines(readFileSync(join(REPO, source), 'utf-8'), text))
      .map(({ where, source }) => `${where} doesn't match ${source}`);
    expect(drifted).toEqual([]);
  });

  test('there are runnable examples', () => {
    expect(runnable.length).toBeGreaterThan(0);
  });

  test.each(runnable.map(({ where, block }) => [where, block]))('%s runs and prints what the docs show', (where, block) => {
    const expected = isOutput(block.next) ? block.next.value.trim() : '(no output block right after the example)';
    expect(runExample(block.value).trim()).toBe(expected);
  }, EXAMPLE_TIMEOUT_MS + 5_000);
});
