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
  const { id, method, params } = message;
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
            model: 'dynamic-model',
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: '빠른 응답' },
              { reasoningEffort: 'medium', description: '균형' },
              { reasoningEffort: 'high', description: '깊은 분석' },
            ],
            inputModalities: ['text', 'image'],
          },
          {
            id: 'alternate-model',
            model: 'alternate-model',
            displayName: 'Alternate model',
            isDefault: false,
            hidden: false,
            defaultReasoningEffort: 'high',
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: '빠른 응답' },
              { reasoningEffort: 'high', description: '깊은 분석' },
            ],
            inputModalities: ['text'],
          },
        ],
        nextCursor: null,
      },
    });
  else if (method === 'thread/start')
    send({ id, result: { thread: { id: `thread-${++thread}` } } });
  else if (method === 'turn/start') {
    const turnId = 'turn-1';
    const properties = params?.outputSchema?.properties ?? {};
    const structured = Boolean(params?.outputSchema);
    const response = properties.suggestedTitle
      ? JSON.stringify({
          suggestedTitle: 'E2E 검증 보고서',
          purpose: '자동화 검증',
          executiveSummaryDirection: '결론 우선',
          outline: [
            {
              id: 'summary',
              heading: '요약 및 결론',
              level: 1,
              intent: '핵심 결과',
              evidenceSourceIds: [],
            },
          ],
          assumptions: [],
          questions: [],
          warnings: [],
        })
      : properties.htmlBody
        ? JSON.stringify({
            title: 'E2E 검증 보고서',
            htmlBody: `<h1>E2E 검증 보고서</h1><p>안전하게 생성된 본문</p><p>${params.model} · ${params.effort}</p>`,
            executiveSummary: '안전하게 생성된 본문',
            sourceUsage: [],
            assumptions: [],
            warnings: [],
          })
        : properties.updatedHtml
          ? JSON.stringify({
              scope: 'document',
              updatedHtml: '<p>수정된 본문</p>',
              replacementHtml: null,
              changeSummary: ['본문을 수정했습니다.'],
              assumptions: [],
              warnings: [],
            })
          : '안전한 응답';
    const commentary = structured ? '{"progress":"draft"}' : null;
    send({ id, result: { turn: { id: turnId } } });
    if (commentary) {
      send({
        method: 'item/started',
        params: {
          threadId: 'thread-1',
          turnId,
          item: { id: 'commentary-1', type: 'agentMessage', text: '', phase: 'commentary' },
        },
      });
      send({
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-1', turnId, itemId: 'commentary-1', delta: commentary },
      });
    }
    const firstDelay = structured ? 80 : 5;
    const secondDelay = structured ? 160 : 10;
    const completeDelay = structured ? 500 : 15;
    setTimeout(
      () =>
        send({
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'thread-1',
            turnId,
            itemId: 'item-1',
            delta: response.slice(0, Math.ceil(response.length / 2)),
          },
        }),
      firstDelay,
    );
    setTimeout(
      () =>
        send({
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'thread-1',
            turnId,
            itemId: 'item-1',
            delta: response.slice(Math.ceil(response.length / 2)),
          },
        }),
      secondDelay,
    );
    setTimeout(
      () =>
        send({
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: {
              id: turnId,
              status: 'completed',
              items: [
                ...(commentary
                  ? [
                      {
                        id: 'commentary-1',
                        type: 'agentMessage',
                        text: commentary,
                        phase: 'commentary',
                      },
                    ]
                  : []),
                { id: 'item-1', type: 'agentMessage', text: response, phase: 'final_answer' },
              ],
              error: null,
            },
          },
        }),
      completeDelay,
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
