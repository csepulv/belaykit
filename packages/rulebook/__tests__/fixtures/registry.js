// A registry module for the command's tests, imported the way an agent's would be.
export const triageRegistry = {
  version: '3',
  producers: { classify_item: { writes: ['classification'], run: async () => ({ urgent: true }) } },
  actions: { flag: { writes: ['flags'], run: async () => {} } },
  functions: [
    {
      signature: 'app_isBlank(string): bool',
      handler: (text) => !text.trim(),
      description: 'True when the string is empty or whitespace.',
      params: [{ name: 'text', description: 'The string to test' }],
    },
    {
      signature: 'app_state(map, string): string',
      handler: (container, key) => (key in container ? 'present' : 'absent'),
      keyArgs: { key: 1, in: 0 },
    },
  ],
  initialKeys: ['item', 'flags'],
};

export const notARegistry = 42;
