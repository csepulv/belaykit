// Walking a cel-js syntax tree: a node's `args` hold its children, beside names and literals.

// The nodes among a node's args, in order.
export const childNodesOf = (args) => {
  if (Array.isArray(args)) return args.flatMap(childNodesOf);
  return args !== null && typeof args === 'object' && 'op' in args ? [args] : [];
};

// Every node of a parsed CEL expression, depth first.
export function* nodesOf(node) {
  yield node;
  for (const child of childNodesOf(node.args)) yield* nodesOf(child);
}
