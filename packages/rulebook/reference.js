// The registry's functions as a Markdown reference, generated from the same CEL
// environment the loader checks rulebooks in, so it can't drift from what a rulebook
// file may call. The agent commits the output; git versions it.
import { NAMESPACE, NAMESPACE_TYPE } from './helpers.js';
import { makeEnvironment, nameInSignature } from './load.js';

// BelayKit's helpers come first, in every reference; then the registry's own functions.
export function describeFunctions(registry) {
  const { env, errors } = makeEnvironment(registry);
  if (errors.length) throw new Error(errors.join('\n'));

  const definitions = env.getDefinitions().functions;
  const header = ['# Rulebook functions', ...(registry.version ? [`Registry version: ${registry.version}`] : [])];
  const entriesByName = groupByName(registry.functions ?? []);
  const registered = entriesByName.size === 0
    ? ['The registry has no functions of its own.']
    : [...entriesByName].map(([head, entries]) => describeName(head, entries, definitionsOf(head, entries, definitions)));
  return `${[...header, ...describeHelpers(definitions), ...registered].join('\n\n')}\n`;
}

// Each helper as it is called, `belaykit.present(…)`, not as cel-js names its type.
function describeHelpers(definitions) {
  const helpers = definitions.filter(({ receiverType }) => receiverType === NAMESPACE_TYPE).map((definition) => ({
    ...definition,
    signature: definition.signature.replace(`${NAMESPACE_TYPE}.`, `${NAMESPACE}.`),
  }));
  return [
    `Functions named \`${NAMESPACE}.*\` are BelayKit's own helpers, in every rulebook; the others are the registry's.`,
    ...helpers.map((helper) => describeName(`${NAMESPACE}.${helper.name}`, [], [helper])),
  ];
}

function groupByName(entries) {
  const entriesByName = new Map();
  for (const entry of entries) {
    const head = nameInSignature(entry.signature);
    entriesByName.set(head, [...(entriesByName.get(head) ?? []), entry]);
  }
  return entriesByName;
}

// cel-js's definitions for one registered name, one per overload the registry added. They
// come after CEL's own overloads of the same name (`size`), so take the last ones.
function definitionsOf(head, entries, definitions) {
  const separator = head.lastIndexOf('.');
  const receiverType = separator < 0 ? null : head.slice(0, separator);
  const name = head.slice(separator + 1);
  return definitions.filter((definition) => definition.name === name && definition.receiverType === receiverType).slice(-entries.length);
}

// Overloads share a heading; each gets its signature, description, parameters and key note.
const describeName = (head, entries, definitions) =>
  [`## ${head}`, ...definitions.flatMap((definition, index) => describeOverload(definition, entries[index]))].join('\n\n');

function describeOverload(definition, entry) {
  return [
    `\`${definition.signature}\``,
    ...(definition.description ? [definition.description] : []),
    ...(definition.params.length ? [parameterTable(definition.params)] : []),
    ...(entry?.keyArgs ? [keyNote(definition.params, entry.keyArgs)] : []),
  ];
}

const parameterTable = (params) => [
  '| Parameter | Type | Description |',
  '| --- | --- | --- |',
  ...params.map(({ name, type, description }) => `| ${[name, type, description].filter(Boolean).map(tableCell).join(' | ')} |${description ? '' : ' |'}`),
].join('\n');

const tableCell = (text) => text.replaceAll('|', '\\|').replace(/\s*\n\s*/g, ' ');

const keyNote = (params, { key, in: container }) =>
  `Argument \`${params[key]?.name ?? key}\` names a field of argument \`${params[container]?.name ?? container}\`; a literal key is checked at load.`;
