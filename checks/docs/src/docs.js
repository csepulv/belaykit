// The public docs as a reader meets them: the repo's README, the pages in documentation/,
// and the package and example READMEs. Each file is parsed into a Markdown syntax tree once,
// so the checks read code blocks, links and headings, not text.
//
// Paths are written as the public repo has them. Where the repo keeps its public root in
// publish/ (its README, LICENSE and documentation/ live there until published), they are
// read from there, so the checks run the same before and after publishing.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { frontmatter } from 'micromark-extension-frontmatter';
import { gfm } from 'micromark-extension-gfm';
import { parse as parseYaml } from 'yaml';

export const REPO = fileURLToPath(new URL('../../..', import.meta.url));
export const PUBLIC_REPO = 'https://github.com/csepulv/belaykit';

// A folder that isn't there yet holds no docs.
const walk = (directory) => (!existsSync(directory) ? [] : readdirSync(directory)).flatMap((name) => {
  const path = join(directory, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});

const PUBLIC_ROOT = existsSync(join(REPO, 'publish')) ? 'publish' : '';
const IN_PUBLIC_ROOT = ['README.md', 'CHANGELOG.md', 'LICENSE', '.gitignore', 'documentation'];
// The top-level entries the public repo has; a link to anything else leads nowhere there.
const PUBLIC_ENTRIES = [...IN_PUBLIC_ROOT, 'packages', 'examples', 'checks', 'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'];

const topLevelOf = (publicPath) => publicPath.split('/')[0];

// This repo's path for a file the public repo has at `publicPath`.
export const repoPathOf = (publicPath) => (PUBLIC_ROOT && IN_PUBLIC_ROOT.includes(topLevelOf(publicPath)) ? `${PUBLIC_ROOT}/${publicPath}` : publicPath);

// The public repo's path for a file at `repoPath` here.
export const publishedPath = (repoPath) => (PUBLIC_ROOT && repoPath.startsWith(`${PUBLIC_ROOT}/`) ? repoPath.slice(PUBLIC_ROOT.length + 1) : repoPath);

export const existsInPublicRepo = (publicPath) => PUBLIC_ENTRIES.includes(topLevelOf(publicPath)) && existsSync(join(REPO, repoPathOf(publicPath)));

const readmesIn = (folder) => (existsSync(join(REPO, folder)) ? readdirSync(join(REPO, folder)) : [])
  .map((name) => `${folder}/${name}/README.md`).filter((path) => existsSync(join(REPO, path))).sort();

// Repo-relative paths of every public doc, in a stable order.
export const publicDocs = () => [
  repoPathOf('README.md'),
  repoPathOf('CHANGELOG.md'),
  ...walk(join(REPO, repoPathOf('documentation'))).filter((path) => path.endsWith('.md')).map((path) => relative(REPO, path)).sort(),
  ...readmesIn('packages'),
  ...readmesIn('examples'),
];

export function readDoc(repoPath) {
  const source = readFileSync(join(REPO, repoPath), 'utf-8');
  const tree = fromMarkdown(source, { extensions: [gfm(), frontmatter(['yaml'])], mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(['yaml'])] });
  const yamlNode = tree.children.find((node) => node.type === 'yaml');
  return { path: repoPath, source, tree, frontmatter: yamlNode ? parseYaml(yamlNode.value) : null };
}

export function* nodesOf(node) {
  yield node;
  for (const child of node.children ?? []) yield* nodesOf(child);
}

// Each code block at any depth (in a list or a quote too), with its neighbours: the node
// before it and the one after it (an example's expected output).
export const codeBlocks = (doc) => [...nodesOf(doc.tree)].flatMap((parent) => (parent.children ?? []).flatMap((node, index, siblings) =>
  (node.type === 'code' ? [{ ...node, previous: siblings[index - 1], next: siblings[index + 1] }] : [])));

export const headingText = (heading) => [...nodesOf(heading)].filter((node) => node.type === 'text' || node.type === 'inlineCode').map((node) => node.value).join('');
