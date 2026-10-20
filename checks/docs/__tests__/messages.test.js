// The error messages the docs quote are the ones the code prints. A message quoted in
// a page's prose (an inline code span that reads like one) must appear in a `text output`
// block on the same page, which the examples check compares with what its example printed.
// `…` in a quote stands for any text.
import { describe, expect, test } from 'vitest';
import { codeBlocks, nodesOf, publicDocs, readDoc } from '../src/docs.js';

const MESSAGE = /( failed: |unknown (ws field|field|function|key|action|producer)|must be (a|one|string)|No such key|no matching overload|takes no params|needs param|is not a choice|new Agent: |stopped after|: YAML: )/;

const escape = (text) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
const asPattern = (quote) => new RegExp(quote.split('…').map((part) => escape(part.trim())).join('[\\s\\S]*'));

const quotedMessages = (doc) => [...nodesOf(doc.tree)]
  .filter((node) => node.type === 'inlineCode' && MESSAGE.test(node.value))
  .map((node) => ({ quote: node.value, line: node.position.start.line }));

const printedOutput = (doc) => codeBlocks(doc).filter(({ lang, meta }) => lang === 'text' && meta === 'output').map(({ value }) => value).join('\n');

describe('the error messages the docs quote', () => {
  test.each(publicDocs())('%s quotes only messages its examples print', (path) => {
    const doc = readDoc(path);
    const output = printedOutput(doc);
    const unprinted = quotedMessages(doc).filter(({ quote }) => !asPattern(quote).test(output)).map(({ quote, line }) => `${line}: ${quote}`);
    expect(unprinted).toEqual([]);
  });
});
