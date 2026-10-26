// A rulebook: a YAML + CEL file of sections and rules, checked at load against the
// agent's registry, which it keeps. It provides the agent's choices, the working set's
// starting keys, re-gathering, fixture runs, and decisions. Its CEL environment stays inside it.
import { basename, normalize } from 'node:path';
import { decide } from './decide.js';
import { runFixture } from './fixture.js';
import { checkMacroText, checkRulebook, loadRulebook, loadRulebookText } from './load.js';
import { givenPath } from './macros.js';
import { initialWorkingSet, rulebookProvider } from './provider.js';
import { describeFunctions, describeMacros } from './reference.js';

// Only `load` and `fromText` make a rulebook, so every one has passed the checks.
const CHECKED = Symbol('checked rulebook');

const FIXTURE_OPTIONS = ['fixture', 'deps', 'finishChecker', 'finalizer', 'maxIterations'];
const DECIDE_OPTIONS = ['deps', 'maxIterations', 'onCopyLoss'];
const COPY_LOSSES = ['drop', 'fail'];
const TEXT_OPTIONS = ['baseDir', 'imports'];
// A macro file can be imported, by a file it imports too, so its check may say where it sits (since 0.4).
const MACRO_FILE_OPTIONS = [...TEXT_OPTIONS, 'path'];

export class Rulebook {
  #loaded;
  #registry;

  constructor(checked, loaded, registry) {
    if (checked !== CHECKED) throw new TypeError('new Rulebook: use Rulebook.load(path, registry) or Rulebook.fromText(text, registry)');
    this.#loaded = loaded;
    this.#registry = keptRegistry(registry);
  }

  static load(path, registry) {
    requireString('Rulebook.load', 'path', path);
    return new Rulebook(CHECKED, loadRulebook(path, registry), registry);
  }

  static fromText(text, registry, options = {}) {
    requireString('Rulebook.fromText', 'text', text);
    return new Rulebook(CHECKED, loadRulebookText(text, registry, textOptions('Rulebook.fromText', options)), registry);
  }

  static check(text, registry, options = {}) {
    requireString('Rulebook.check', 'text', text);
    return checkRulebook(text, registry, textOptions('Rulebook.check', options));
  }

  // A macro file on its own (since 0.3): every macro in it, whether or not a rulebook calls it.
  static checkMacros(text, registry, options = {}) {
    requireString('Rulebook.checkMacros', 'text', text);
    return checkMacroText(text, registry, macroFileOptions('Rulebook.checkMacros', options, text));
  }

  // Copies, so a caller can't change what the rulebook runs.
  get sections() {
    return this.#loaded.sections.map(describeSection);
  }

  get declaredKeys() {
    return [...this.#loaded.declaredKeys];
  }

  // What this rulebook may call: the registry's reference, then the macros its imports give it (since 0.3).
  describeFunctions() {
    const macros = describeMacros(this.#loaded.macros);
    const reference = describeFunctions(this.#registry);
    return macros ? `${reference}\n${macros}` : reference;
  }

  initialize(initial) {
    return initialWorkingSet(this.#loaded, initial);
  }

  provider(deps) {
    return rulebookProvider(this.#loaded, this.#registry, deps);
  }

  // A key is gathered while it is present; removing it has its section gather it again.
  regather(workingSet, key) {
    const { declaredKeys } = this.#loaded;
    if (!declaredKeys.includes(key)) {
      throw new TypeError(`regather: "${key}" is not a needs key of this rulebook (needs keys: ${declaredKeys.join(', ')})`);
    }
    delete workingSet[key];
  }

  async runFixture(options = {}) {
    const unknown = Object.keys(options ?? {}).find((key) => !FIXTURE_OPTIONS.includes(key));
    if (unknown !== undefined) {
      throw new TypeError(`rulebook.runFixture: unknown option "${unknown}" (options: ${FIXTURE_OPTIONS.join(', ')})`);
    }
    for (const required of ['fixture', 'finishChecker']) {
      if (!options?.[required]) throw new TypeError(`rulebook.runFixture: "${required}" is required`);
    }
    return runFixture({ ...options, loaded: this.#loaded, registry: this.#registry });
  }

  // Runs until every declared output is present; always resolves, but a rulebook without
  // outputs, or an option it doesn't take, is the caller's mistake.
  async decide(initial, options = {}) {
    if (this.#loaded.outputs === null) throw new TypeError('rulebook.decide: this rulebook declares no outputs');
    const unknown = Object.keys(options ?? {}).find((key) => !DECIDE_OPTIONS.includes(key));
    if (unknown !== undefined) {
      throw new TypeError(`rulebook.decide: unknown option "${unknown}" (options: ${DECIDE_OPTIONS.join(', ')})`);
    }
    const onCopyLoss = options?.onCopyLoss;
    if (onCopyLoss !== undefined && !COPY_LOSSES.includes(onCopyLoss)) {
      const given = typeof onCopyLoss === 'string' || onCopyLoss === null ? JSON.stringify(onCopyLoss)
        : typeof onCopyLoss === 'object' ? 'an object' : `a ${typeof onCopyLoss}`;
      throw new TypeError(`rulebook.decide: onCopyLoss must be "drop" or "fail", got ${given}`);
    }
    return decide({ ...options, initial, loaded: this.#loaded, registry: this.#registry });
  }
}

// Without this, a missing or non-string argument fails deep in the parser with a native message.
function requireString(caller, argument, value) {
  if (typeof value !== 'string') throw new TypeError(`${caller}: ${argument} must be a string`);
}

// A rulebook given as text has no folder of its own, so its imports resolve from `baseDir`, or come as text
// (`imports`, since 0.4); one source of files, not both.
function textOptions(caller, options, known = TEXT_OPTIONS) {
  // A string would otherwise read as keys "0", "1", …
  if (options !== null && options !== undefined && (typeof options !== 'object' || Array.isArray(options))) {
    throw new TypeError(`${caller}: options must be an object, such as { baseDir }`);
  }
  const unknown = Object.keys(options ?? {}).find((key) => !known.includes(key));
  if (unknown !== undefined) throw new TypeError(`${caller}: unknown option "${unknown}" (options: ${known.join(', ')})`);
  if (options?.baseDir !== undefined) requireString(caller, 'baseDir', options.baseDir);
  if (options?.baseDir !== undefined && options?.imports !== undefined) throw new TypeError(`${caller}: pass baseDir or imports, not both`);
  return { baseDir: options?.baseDir, imports: options?.imports === undefined ? undefined : importsByFile(caller, options.imports) };
}

// A macro file's text options, plus where the file sits (`path`), relative to the folder or the map's root: an import
// back to it is then a cycle, as the command reports one.
function macroFileOptions(caller, options, text) {
  const read = textOptions(caller, options, MACRO_FILE_OPTIONS);
  const path = options?.path;
  if (path === undefined) return read;
  requireString(caller, 'path', path);
  if (read.baseDir === undefined && read.imports === undefined) {
    throw new TypeError(`${caller}: path places the file among baseDir or imports; pass one`);
  }
  if (read.imports === undefined) {
    if (namesFolder(path)) throw new TypeError(`${caller}: path "${path}" isn't a file path relative to baseDir`);
    return { ...read, path };
  }
  const file = givenPath(path);
  if (file === null) throw new TypeError(`${caller}: path "${path}" isn't a file path relative to the imports`);
  // The checked text is the file at `path`, so a map entry there would be a second, different file of one name.
  if (Object.hasOwn(read.imports, file) && read.imports[file] !== text) {
    throw new TypeError(`${caller}: imports "${file}" holds other text than the file checked at path "${path}"`);
  }
  return { ...read, path: file };
}

// `.`, `..`, `''`, `x/..`: a folder, not a file in one.
const namesFolder = (path) => path === '' || ['.', '..'].includes(basename(normalize(path)));

// The map's paths as the import walk names files (`givenPath`, macros.js), relative to the text they come with. A Map
// or a class instance would read as no keys, and every import as missing, so only a plain object is taken.
function importsByFile(caller, imports) {
  const prototype = imports !== null && typeof imports === 'object' ? Object.getPrototypeOf(imports) : undefined;
  if (prototype !== Object.prototype && prototype !== null) {
    const hint = imports instanceof Map ? '; for a Map, pass Object.fromEntries(map)' : '';
    throw new TypeError(`${caller}: imports must be a plain object of path to text${hint}`);
  }
  const keyOf = new Map();
  for (const [path, text] of Object.entries(imports)) {
    if (typeof text !== 'string') throw new TypeError(`${caller}: imports "${path}" must be text (a string)`);
    const file = givenPath(path);
    if (file === null) throw new TypeError(`${caller}: imports "${path}" isn't a file path relative to the text it comes with`);
    if (keyOf.has(file)) throw new TypeError(`${caller}: imports "${keyOf.get(file)}" and "${path}" name the same file`);
    keyOf.set(file, path);
  }
  return Object.fromEntries([...keyOf].map(([file, path]) => [file, imports[path]]));
}

// The registry as checked: its producers, actions and functions are copied, so changing the
// caller's registry later can't change what this rulebook runs or what its reference lists.
const keptRegistry = (registry) => ({
  ...registry,
  producers: copyEach(registry.producers),
  actions: copyEach(registry.actions),
  ...(registry.functions && { functions: registry.functions.map(copyFunction) }),
});

const copyFunction = (entry) => ({
  ...entry,
  ...(Array.isArray(entry.params) && { params: entry.params.map((param) => ({ ...param })) }),
  ...(entry.keyArgs && { keyArgs: { ...entry.keyArgs } }),
});

// `run` is kept bound to its entry, so an entry made from a class keeps its method.
const copyEach = (entries) => Object.fromEntries(Object.entries(entries).map(([name, entry]) => [name, {
  ...entry,
  run: typeof entry.run === 'function' ? entry.run.bind(entry) : entry.run,
}]));

// As written: an expression that calls a macro shows the call, not its expansion.
const describeSection = ({ name, whenAsWritten, needs, hitPolicy, rules }) => ({
  name, when: whenAsWritten, needs: { ...needs }, hitPolicy, rules: rules.map(describeRule),
});

const describeRule = ({ id, selectFirst, whenAsWritten, action, params, why }) => ({
  id,
  selectFirst: selectFirst && { name: selectFirst.name, expression: selectFirst.asWritten },
  when: whenAsWritten,
  action,
  params: structuredClone(params),
  why,
});
