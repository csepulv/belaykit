#!/usr/bin/env node
// belaykit-rulebook: check rulebooks against an agent's registry before deploying them,
// or print the registry's function reference. Exit 0 on success, 1 otherwise.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { checkRulebook } from './load.js';
import { describeFunctions } from './reference.js';

const USAGE = [
  'Usage: belaykit-rulebook check <file>... --registry <module>#<export>',
  '       belaykit-rulebook reference --registry <module>#<export>',
].join('\n');

class UsageError extends Error {}

const COMMANDS = {
  check: checkFiles,
  reference: printReference,
};

async function main(args) {
  const { values, positionals: [command, ...files] } = parseArgs({
    args,
    allowPositionals: true,
    options: { registry: { type: 'string' } },
  });
  if (!COMMANDS[command] || !values.registry) throw new UsageError(USAGE);
  return COMMANDS[command](files, await importRegistry(values.registry));
}

function checkFiles(files, registry) {
  if (files.length === 0) throw new UsageError(USAGE);
  const problemsByFile = files.map((file) => [file, problemsIn(file, registry)]);
  for (const [file, problems] of problemsByFile) {
    if (problems.length === 0) console.log(`${file}: ok`);
    for (const problem of problems) console.error(`${file}: ${problem}`);
  }
  return problemsByFile.every(([, problems]) => problems.length === 0) ? 0 : 1;
}

function printReference(files, registry) {
  if (files.length > 0) throw new UsageError(USAGE);
  process.stdout.write(describeFunctions(registry));
  return 0;
}

function problemsIn(file, registry) {
  try {
    return checkRulebook(readFileSync(file, 'utf-8'), registry);
  } catch (error) {
    if (error.code === 'ENOENT') return ['no such file'];
    if (error.code) return [`cannot read (${error.code})`];
    throw error;
  }
}

// `<module>#<export>`: the module is resolved from the current directory, like any path an
// author types, and imported; the export is the registry.
async function importRegistry(specifier) {
  const separator = specifier.lastIndexOf('#');
  if (separator <= 0) throw new Error(`--registry must be <module>#<export>, got "${specifier}"`);
  const [path, name] = [specifier.slice(0, separator), specifier.slice(separator + 1)];
  const module = await import(pathToFileURL(resolve(path)).href);
  if (!(name in module)) throw new Error(`${path} has no export "${name}"`);
  const registry = module[name];
  if (typeof registry?.producers !== 'object' || typeof registry?.actions !== 'object') {
    throw new Error(`${path} export "${name}" is not a registry (it needs producers and actions)`);
  }
  return registry;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof UsageError ? error.message : `belaykit-rulebook: ${error.message.split('\n')[0]}`);
  process.exitCode = 1;
}
