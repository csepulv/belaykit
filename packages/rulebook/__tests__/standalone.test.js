import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

// The plugin uses exactly what it declares: its four dependencies and the core
// as a peer. Relative imports stay in the package (the core is reached by name,
// never by path); tests may also use vitest and the package's own name.
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8'));
const DECLARED = [...Object.keys(MANIFEST.dependencies ?? {}), ...Object.keys(MANIFEST.peerDependencies ?? {})];
const IMPORT_SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

const listSourceFiles = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listSourceFiles(path);
  return /\.(js|mjs|cjs|ts)$/.test(entry.name) ? [path] : [];
});

const packageName = (specifier) => specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');

const isInside = (directory, path) => !relative(directory, path).startsWith('..');

function isAllowed(specifier, file) {
  if (specifier.startsWith('.')) return isInside(PACKAGE_ROOT, resolve(dirname(file), specifier));
  if (specifier.startsWith('node:')) return true;
  if (DECLARED.includes(packageName(specifier))) return true;
  const isTest = file.includes('/__tests__/');
  return isTest && (specifier === 'vitest' || specifier === MANIFEST.name);
}

function findForbiddenImports() {
  return listSourceFiles(PACKAGE_ROOT).flatMap((file) =>
    [...readFileSync(file, 'utf-8').matchAll(IMPORT_SPECIFIER)]
      .map(([, specifier]) => specifier)
      .filter((specifier) => !isAllowed(specifier, file))
      .map((specifier) => `${relative(PACKAGE_ROOT, file)} imports ${specifier}`));
}

test('@belaykit/rulebook imports only what it declares', () => {
  expect(findForbiddenImports()).toEqual([]);
});

test('package.json declares the four packages and the core as its only peer', () => {
  expect({
    dependencies: Object.keys(MANIFEST.dependencies ?? {}).sort(),
    peerDependencies: Object.keys(MANIFEST.peerDependencies ?? {}),
  }).toEqual({
    dependencies: ['@marcbachmann/cel-js', 'ajv', 'safe-regex2', 'yaml'],
    peerDependencies: ['@belaykit/core'],
  });
});
