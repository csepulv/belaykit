import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

// The core has no dependencies, at import time and at install time. Relative
// imports stay in the package and the source may use only Node built-ins; tests
// may also use vitest and the package's own name (to exercise its exports map).
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8'));
const IMPORT_SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

const listSourceFiles = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listSourceFiles(path);
  return /\.(js|mjs|cjs|ts)$/.test(entry.name) ? [path] : [];
});

const isInside = (directory, path) => !relative(directory, path).startsWith('..');

function isAllowed(specifier, file) {
  if (specifier.startsWith('.')) return isInside(PACKAGE_ROOT, resolve(dirname(file), specifier));
  if (specifier.startsWith('node:')) return true;
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

test('@belaykit/core imports nothing from outside its own package', () => {
  expect(findForbiddenImports()).toEqual([]);
});

test('package.json declares no dependencies or peer dependencies', () => {
  expect({ dependencies: MANIFEST.dependencies, peerDependencies: MANIFEST.peerDependencies })
    .toEqual({ dependencies: undefined, peerDependencies: undefined });
});
