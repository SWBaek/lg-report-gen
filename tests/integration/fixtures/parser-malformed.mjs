/* global process */
process.once('message', () => process.send?.({ malformed: true }));
