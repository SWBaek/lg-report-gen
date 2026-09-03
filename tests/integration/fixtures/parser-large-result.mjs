/* global process */
process.once('message', () =>
  process.send?.({ ok: true, content: 'x'.repeat(10_000), metadata: {}, warnings: [] }),
);
