// Every diagram in the docs parses as Mermaid, so none renders as an error box on GitHub.
// Mermaid's own parser is the judge. It sanitizes labels with DOMPurify, which needs a window
// when it loads, so Mermaid is imported after one is in place. (A happy-dom test environment
// would also replace `URL`, which the docs' own path handling can't take.) GitHub may render
// with an older Mermaid than this one.
import { Window } from 'happy-dom';
import { describe, expect, test } from 'vitest';
import { codeBlocks, publicDocs, readDoc } from '../src/docs.js';

globalThis.window = new Window();
const { default: mermaid } = await import('mermaid');

const diagrams = publicDocs().map(readDoc).flatMap((doc) => codeBlocks(doc)
  .filter(({ lang }) => lang === 'mermaid')
  .map((block) => [`${doc.path}:${block.position.start.line}`, block.value]));

describe('the docs\' diagrams', () => {
  test('the docs have diagrams to check', () => {
    expect(diagrams.length).toBeGreaterThan(0);
  });

  test.each(diagrams)('%s parses as Mermaid', async (where, diagram) => {
    await expect(mermaid.parse(diagram)).resolves.toBeTruthy();
  });
});
