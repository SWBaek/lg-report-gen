#!/usr/bin/env node
const readline = require('node:readline');
const fs = require('node:fs');
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 99.0.0-test\n');
  process.exit(0);
}
let thread = 0;
let turn = 0;
let overloadSent = false;
const mode = process.env.MOCK_CODEX_MODE || 'normal';
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
  if (method === 'initialize')
    send({
      id,
      result: {
        serverInfo: { name: 'mock', version: '99.0.0-test', protocolVersion: 'v1' },
        protocolVersion: 'v1',
        features: { structuredOutput: true, threadResume: true, turnInterrupt: true },
      },
    });
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
  else if (method === 'thread/resume')
    send({ id, result: { thread: { id: params?.threadId || `thread-${++thread}` } } });
  else if (method === 'turn/start') {
    if (mode === 'overload-once' && !overloadSent) {
      overloadSent = true;
      send({ id, error: { code: -32001, message: 'Server is overloaded' } });
      return;
    }
    const turnId = `turn-${++turn}`;
    const threadId = params?.threadId || `thread-${thread}`;
    const properties = params?.outputSchema?.properties ?? {};
    const structured = Boolean(params?.outputSchema);
    const response = properties.suggestedTitle
      ? JSON.stringify({
          schemaVersion: 1,
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
            schemaVersion: 1,
            title: 'E2E 검증 보고서',
            htmlBody: `<h1>E2E 검증 보고서</h1><blockquote><p>안전하게 생성된 본문</p></blockquote><h2>검증 결과</h2><p>선택한 AI 설정과 주요 결과를 요약합니다.</p><table><thead><tr><th>항목</th><th>결과</th></tr></thead><tbody><tr><td>모델 및 Reasoning</td><td>${params.model} · ${params.effort}</td></tr><tr><td>HTML 안전성</td><td>통과</td></tr></tbody></table><h3>후속 조치</h3><ul><li>내보낸 문서의 화면 및 인쇄 레이아웃을 확인합니다.</li><li>근거가 부족한 항목은 확인 필요로 표시합니다.</li></ul>`,
            executiveSummary: '안전하게 생성된 본문',
            sourceUsage: [],
            assumptions: [],
            warnings: [],
          })
        : properties.updatedHtml
          ? JSON.stringify({
              schemaVersion: 1,
              scope: 'document',
              updatedHtml: '<p>수정된 본문</p>',
              replacementHtml: null,
              changeSummary: ['본문을 수정했습니다.'],
              assumptions: [],
              warnings: [],
            })
          : mode === 'malformed-structured'
            ? '{invalid structured output'
            : '안전한 응답';
    const commentary = structured ? '{"progress":"draft"}' : null;
    send({ id, result: { turn: { id: turnId } } });
    if (mode === 'turn-failed-schema') {
      send({
        method: 'turn/completed',
        params: {
          threadId,
          turn: {
            id: turnId,
            status: 'failed',
            items: [],
            error: { message: '{"code":"invalid_json_schema"}', codexErrorInfo: 'badRequest' },
          },
        },
      });
      return;
    }
    if (mode === 'fast')
      send({
        method: 'turn/completed',
        params: {
          threadId,
          turn: {
            id: turnId,
            status: 'completed',
            items: [{ type: 'agentMessage', text: response, phase: 'final_answer' }],
            error: null,
          },
        },
      });
    const crashMarker = process.env.MOCK_CODEX_CRASH_MARKER;
    const crashOnce = mode === 'crash-once' && crashMarker && !fs.existsSync(crashMarker);
    if (crashOnce && crashMarker) fs.writeFileSync(crashMarker, 'crashed');
    if (mode === 'crash' || crashOnce) {
      setTimeout(() => process.kill(process.pid, 'SIGTERM'), 5);
      return;
    }
    if (commentary) {
      send({
        method: 'item/started',
        params: {
          threadId,
          turnId,
          item: { id: 'commentary-1', type: 'agentMessage', text: '', phase: 'commentary' },
        },
      });
      send({
        method: 'item/agentMessage/delta',
        params: { threadId, turnId, itemId: 'commentary-1', delta: commentary },
      });
    }
    const firstDelay = structured ? 80 : 5;
    const secondDelay = structured ? 160 : 10;
    const completeDelay =
      mode === 'malformed-structured' ? 0 : structured ? 500 : mode === 'fast' ? 0 : 15;
    setTimeout(
      () =>
        send({
          method: 'item/agentMessage/delta',
          params: {
            threadId,
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
            threadId,
            turnId,
            itemId: 'item-1',
            delta: response.slice(Math.ceil(response.length / 2)),
          },
        }),
      secondDelay,
    );
    setTimeout(
      () =>
        send(
          mode === 'malformed-completion'
            ? {
                method: 'turn/completed',
                params: { threadId, turn: { id: turnId, status: 'completed' } },
              }
            : {
                method: 'turn/completed',
                params: {
                  threadId,
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
              },
        ),
      mode === 'cancel-late' ? 120 : completeDelay,
    );
    if (mode === 'out-of-order') {
      send({
        method: 'item/agentMessage/delta',
        params: { threadId: 'other-thread', turnId: 'other-turn', delta: '무시' },
      });
      send({
        method: 'turn/completed',
        params: {
          threadId: 'other-thread',
          turn: { id: 'other-turn', status: 'completed', items: [] },
        },
      });
    }
    if (mode === 'duplicate') {
      setTimeout(
        () =>
          send({
            method: 'turn/completed',
            params: {
              threadId,
              turn: {
                id: turnId,
                status: 'completed',
                items: [{ type: 'agentMessage', text: response, phase: 'final_answer' }],
              },
            },
          }),
        (mode === 'cancel-late' ? 120 : completeDelay) + 10,
      );
    }
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
