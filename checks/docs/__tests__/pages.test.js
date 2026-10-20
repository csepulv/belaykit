import { describe, expect, test } from 'vitest';
import { publicDocs, readDoc, repoPathOf } from '../src/docs.js';

const PAGES = ['getting-started.md', 'concepts.md', 'rulebooks.md', 'api/core.md', 'api/rulebook.md'].map((page) => repoPathOf(`documentation/${page}`));

describe('the public docs', () => {
  test('every planned page exists', () => {
    expect(publicDocs()).toEqual(expect.arrayContaining(PAGES));
  });

  test.each(publicDocs().filter((path) => path.startsWith(repoPathOf('documentation/'))))('%s has a title in its frontmatter, for a docs site later', (path) => {
    expect(readDoc(path).frontmatter?.title).toEqual(expect.any(String));
  });
});
