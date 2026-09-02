const readline = require('node:readline');
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 99.0.0-test\n');
  process.exit(0);
}
let thread = 0;
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
rl.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === 'initialized') return;
  const { id, method } = message;
  if (method === 'initialize') send({ id, result: { serverInfo: { name: 'mock' } } });
  else if (method === 'account/read')
    send({
      id,
      result: {
        account: { type: 'chatgpt', email: 'user@example.com', planType: 'pro' },
        requiresOpenaiAuth: true,
      },
    });
  else if (method === 'model/list')
    send({
      id,
      result: {
        data: [
          {
            id: 'dynamic-model',
            displayName: 'Dynamic model',
            isDefault: true,
            hidden: false,
            supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
            inputModalities: ['text', 'image'],
          },
        ],
        nextCursor: null,
      },
    });
  else if (method === 'thread/start')
    send({ id, result: { thread: { id: `thread-${++thread}` } } });
  else if (method === 'turn/start') {
    const turnId = 'turn-1';
    send({ id, result: { turn: { id: turnId } } });
    setTimeout(
      () =>
        send({
          method: 'item/agentMessage/delta',
          params: { threadId: 'thread-1', turnId, itemId: 'item-1', delta: '안전한 ' },
        }),
      5,
    );
    setTimeout(
      () =>
        send({
          method: 'item/agentMessage/delta',
          params: { threadId: 'thread-1', turnId, itemId: 'item-1', delta: '응답' },
        }),
      10,
    );
    setTimeout(
      () =>
        send({
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: { id: turnId, status: 'completed', items: [], error: null },
          },
        }),
      15,
    );
  } else if (method === 'turn/interrupt' || method === 'thread/delete') send({ id, result: {} });
  else if (method === 'account/login/start')
    send({
      id,
      result: {
        type: 'chatgpt',
        loginId: 'login-1',
        authUrl: 'https://example.com/login',
      },
    });
  else send({ id, error: { code: -32601, message: 'Unsupported method' } });
});
