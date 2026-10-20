// The registry's functions as a Markdown reference, generated from the same CEL
// environment the loader checks rulebooks in, so it can't drift from what a rulebook
// file may call. The agent commits the output; git versions it.
import { makeEnvironment, nameInSignature } from './load.js';

export function describeFunctions(registry) {
  const { env, errors } = makeEnvironment(registry);
  if (errors.length) throw new Error(errors.join('\n'));

  const header = ['# Rulebook functions', ...(registry.version ? [`Registry version: ${registry.version}`] : [])];
  const entriesByName = groupByName(registry.functions ?? []);
  if (entriesByName.size === 0) return `${[...header, 'No functions are registered.'].join('\n\n')}\n`;

  const definitions = env.getDefinitions().functions;
  const sections = [...entriesByName].map(([head, entries]) => describeName(head, entries, definitionsOf(head, entries, definitions)));
  return `${[...header, ...sections].join('\n\n')}\n`;
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
