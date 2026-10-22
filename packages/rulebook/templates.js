// Templated params: text with placeholders, CEL inside braces, as in Python's `format`:
// "Dear {ws.customer.name}, about {ws.facts.count} reports". `{{` and `}}` are literal braces.
// A placeholder ends at the brace that closes it, so braces inside CEL string literals and map
// literals belong to the expression: `{"}" + ws.x}` and `{ {"a": 1}["a"] }` are one placeholder each.

// The parts of a template: `{ text }` for literal text and `{ expression, source }` for a
// placeholder (`source` is how it is written, braces included). When the text can't be read
// further, `problem` says why, beside the parts read before it (so their own problems are found too).
export function parseTemplate(template) {
  const parts = [];
  let text = '';
  let index = 0;
  while (index < template.length) {
    const char = template[index];
    const next = template[index + 1];
    if ((char === '{' && next === '{') || (char === '}' && next === '}')) {
      text += char;
      index += 2;
    } else if (char === '}') {
      return { parts, problem: 'a lone } (write }} for a brace)' };
    } else if (char === '{') {
      const end = closingBraceOf(template, index);
      if (end === -1) return { parts, problem: 'an unclosed { (write {{ for a brace)' };
      const expression = template.slice(index + 1, end);
      if (expression.trim() === '') return { parts, problem: 'an empty placeholder {}' };
      if (text) parts.push({ text });
      parts.push({ expression, source: template.slice(index, end + 1) });
      text = '';
      index = end + 1;
    } else {
      text += char;
      index += 1;
    }
  }
  if (text) parts.push({ text });
  return { parts };
}

export const hasPlaceholderSyntax = (value) => typeof value === 'string' && /[{}]/.test(value);

// The index of the brace that closes the one at `open`, counting nested braces and skipping CEL
// string literals and comments (`//` to the end of the line); -1 when it never closes.
function closingBraceOf(template, open) {
  let depth = 0;
  for (let index = open; index < template.length; index += 1) {
    const char = template[index];
    if (char === '"' || char === '\'') {
      index = endOfStringLiteral(template, index);
      if (index === -1) return -1;
    } else if (char === '/' && template[index + 1] === '/') {
      index = template.indexOf('\n', index);
      if (index === -1) return -1;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

// The index of the last quote of the CEL string literal starting at `start`: single or double
// quotes, tripled or not. A backslash keeps the next character in the string, in a raw string too
// (cel-js 8 reads `r"a\"b"` as `a\"b`). -1 when it never ends.
function endOfStringLiteral(template, start) {
  const quote = template[start];
  const delimiter = template.startsWith(quote.repeat(3), start) ? quote.repeat(3) : quote;
  for (let index = start + delimiter.length; index < template.length; index += 1) {
    if (template[index] === '\\') {
      index += 1;
    } else if (template.startsWith(delimiter, index)) {
      return index + delimiter.length - 1;
    }
  }
  return -1;
}
