// Every link leads somewhere in the public repo. A relative link resolves to a file the
// public repo has; a link into the public repo on GitHub names such a file; an anchor names a
// heading on that page. Nothing points at another of the owner's repositories.
import { dirname, join, normalize } from 'node:path';
import GithubSlugger from 'github-slugger';
import { describe, expect, test } from 'vitest';
import { existsInPublicRepo, headingText, nodesOf, PUBLIC_REPO, publicDocs, publishedPath, readDoc } from '../src/docs.js';

const docs = publicDocs().map(readDoc);
const byPublishedPath = new Map(docs.map((doc) => [publishedPath(doc.path), doc]));

const publicFileExists = (path) => existsInPublicRepo(path.split('#')[0]);

const anchorsOf = (doc) => {
  const slugger = new GithubSlugger();
  return new Set([...nodesOf(doc.tree)].filter((node) => node.type === 'heading').map((heading) => slugger.slug(headingText(heading))));
};

// Every link a reader can follow, including images and links written as HTML. Reference
// links resolve through their definitions, which are collected here too.
const LINK_NODES = new Set(['link', 'definition', 'image']);
const HTML_URL = /\b(?:href|src)\s*=\s*["']([^"']*)["']/gi;
const urlsOf = (doc) => [...nodesOf(doc.tree)].flatMap((node) => {
  if (LINK_NODES.has(node.type)) return [node.url];
  return node.type === 'html' ? [...node.value.matchAll(HTML_URL)].map(([, url]) => url) : [];
});

// Any other repository of the same owner may be private.
const isOtherOwnerRepo = (url) => /^https?:\/\/github\.com\/csepulv\//i.test(url) && !new RegExp(`^${PUBLIC_REPO}(?:[/#?]|$)`).test(url);

function problemsWith(doc, url) {
  if (isOtherOwnerRepo(url)) return 'links to a repository other than the public one';
  if (url.startsWith(`${PUBLIC_REPO}/`)) {
    const path = url.slice(PUBLIC_REPO.length + 1).replace(/^(blob|tree)\/main\//, '');
    if (!/^(blob|tree)\/main\//.test(url.slice(PUBLIC_REPO.length + 1))) return 'a public-repo link that isn\'t blob/main or tree/main';
    return publicFileExists(path) ? anchorProblem(path, url) : `names ${path}, which publishing won't create`;
  }
  if (/^[a-z]+:/i.test(url)) return null;
  const [file, anchor] = url.split('#');
  const target = file === '' ? publishedPath(doc.path) : normalize(join(dirname(publishedPath(doc.path)), file));
  if (target.startsWith('..')) return 'leaves the public repo';
  if (!publicFileExists(target)) return `resolves to ${target}, which doesn't exist once published`;
  return anchorProblem(`${target}${anchor ? `#${anchor}` : ''}`, url);
}

function anchorProblem(path, url) {
  const [file, anchor] = path.split('#');
  if (!anchor) return null;
  const target = byPublishedPath.get(file);
  if (!target) return null;
  return anchorsOf(target).has(anchor) ? null : `anchor #${anchor} is not a heading in ${file} (${url})`;
}

describe('the docs\' links', () => {
  test.each(docs.map((doc) => [doc.path, doc]))('%s: every link leads somewhere', (path, doc) => {
    const problems = urlsOf(doc).map((url) => [url, problemsWith(doc, url)]).filter(([, problem]) => problem).map(([url, problem]) => `${url}: ${problem}`);
    expect(problems).toEqual([]);
  });

  test('the package READMEs link with absolute URLs, since npm shows them on its own pages', () => {
    const relative = publicDocs().filter((path) => path.startsWith('packages/')).map(readDoc)
      .flatMap((doc) => [...nodesOf(doc.tree)].filter((node) => node.type === 'link' && !/^[a-z]+:/i.test(node.url) && !node.url.startsWith('#')).map((node) => `${doc.path}: ${node.url}`));
    expect(relative).toEqual([]);
  });
});
