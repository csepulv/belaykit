// A schema problem in the file's own words: where it is (`placeOf` turns ajv's JSON path into
// a place), then what's wrong, with an enum's allowed values spelled out. The one object whose
// property names a schema checks is named by `nameLabel` (a rulebook's selectFirst binding,
// a macro file's macro).
export function schemaMessage(error, placeOf = keyPathPlace, nameLabel = 'binding') {
  const where = placeOf(error.instancePath);
  if (error.propertyName !== undefined) return `${where}: ${nameLabel} "${error.propertyName}" ${error.message}`;
  if (error.keyword === 'additionalProperties') return `${where}: unknown key "${error.params.additionalProperty}"`;
  if (error.keyword === 'enum') return `${where}: must be one of ${error.params.allowedValues.join(', ')}`;
  if (error.keyword === 'const') return `${where}: must be ${JSON.stringify(error.params.allowedValue)}`;
  return `${where}: ${error.message}`;
}

// '/expect/status' -> 'expect.status'.
export const keyPathPlace = (instancePath) => instancePath.split('/').slice(1).join('.') || '(top level)';
