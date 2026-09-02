import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import spawn from 'cross-spawn';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import type { CodexEvent, ModelInfo, ProviderSnapshot } from '../../shared/types/index.js';
import { redact, resolveCodexExecutable } from './executable-resolver.js';

const responseSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    result: z.unknown().optional(),
    error: z.object({ code: z.number().optional(), message: z.string() }).passthrough().optional(),
  })
  .passthrough();
const notificationSchema = z
  .object({ method: z.string(), params: z.unknown().optional() })
  .passthrough();
const modelResponseSchema = z
  .object({
    data: z.array(
      z
        .object({
          id: z.string(),
          displayName: z.string().optional(),
          isDefault: z.boolean().optional(),
          hidden: z.boolean().optional(),
          supportedReasoningEfforts: z
            .array(
              z
                .object({ reasoningEffort: z.string().optional(), effort: z.string().optional() })
                .passthrough(),
            )
            .optional(),
          inputModalities: z.array(z.string()).optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const accountResponseSchema = z
  .object({
    account: z
      .union([
        z
          .object({
            type: z.literal('chatgpt'),
            email: z.string().nullable().optional(),
            planType: z.string().optional(),
          })
          .passthrough(),
        z.object({ type: z.string() }).passthrough(),
      ])
      .nullable(),
    requiresOpenaiAuth: z.boolean().optional(),
  })
  .passthrough();
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class CodexAppServerManager extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private activeTurn: {
    taskId: string;
    sessionId: string;
    threadId: string;
    turnId: string | null;
  } | null = null;
  private starting: Promise<void> | null = null;
  private malformed = 0;
  private configuredPath: string | null = null;
  private restartCount = 0;
  private snapshotValue: ProviderSnapshot = {
    state: 'unknown',
    installed: false,
    resolvedExecutablePath: null,
    version: null,
    appServerSupported: false,
    authenticated: null,
    authenticationState: 'unknown',
    maskedAccount: null,
    planType: null,
    selectedModel: null,
    availableModels: [],
    lastCheckedAt: null,
    actionableErrorCode: null,
    actionableMessage: null,
  };
  get snapshot(): ProviderSnapshot {
    return structuredClone(this.snapshotValue);
  }
  setConfiguredPath(value: string | null): void {
    this.configuredPath = value;
  }
  private update(patch: Partial<ProviderSnapshot>): void {
    this.snapshotValue = { ...this.snapshotValue, ...patch };
    this.emit('event', { type: 'state', snapshot: this.snapshot } satisfies CodexEvent);
  }
  async refresh(): Promise<ProviderSnapshot> {
    this.update({ state: 'checking', actionableErrorCode: null, actionableMessage: null });
    const resolved = await resolveCodexExecutable(this.configuredPath);
    if (!resolved) {
      await this.stop();
      this.update({
        state: 'missing',
        installed: false,
        resolvedExecutablePath: null,
        version: null,
        appServerSupported: false,
        authenticated: false,
        authenticationState: 'unknown',
        lastCheckedAt: new Date().toISOString(),
        actionableErrorCode: 'CODEX_NOT_FOUND',
        actionableMessage: 'Codex CLI를 설치하고 로그인한 뒤 새로고침하십시오.',
      });
      return this.snapshot;
    }
    this.update({
      installed: true,
      resolvedExecutablePath: resolved.path,
      version: resolved.version,
      state: 'starting',
    });
    try {
      await this.start(resolved.path);
      const [accountRaw, modelsRaw] = await Promise.all([
        this.request('account/read', { refreshToken: false }, 10_000),
        this.request('model/list', { includeHidden: false }, 10_000),
      ]);
      const account = accountResponseSchema.parse(accountRaw);
      const models = modelResponseSchema
        .parse(modelsRaw)
        .data.filter((item) => !item.hidden)
        .map<ModelInfo>((item) => ({
          id: item.id,
          displayName: item.displayName ?? item.id,
          isDefault: Boolean(item.isDefault),
          reasoningEfforts: (item.supportedReasoningEfforts ?? [])
            .map((value) => value.reasoningEffort ?? value.effort)
            .filter((value): value is string => Boolean(value)),
          supportsImages: (item.inputModalities ?? []).includes('image'),
        }));
      const authenticated = account.account !== null;
      const chatgpt = account.account?.type === 'chatgpt' ? account.account : null;
      const accountEmail = typeof chatgpt?.email === 'string' ? chatgpt.email : null;
      const accountPlan =
        typeof chatgpt?.planType === 'string'
          ? chatgpt.planType
          : typeof account.account?.type === 'string'
            ? account.account.type
            : null;
      const selected = models.find((item) => item.isDefault)?.id ?? models[0]?.id ?? null;
      this.update({
        state: authenticated ? 'ready' : 'unauthenticated',
        appServerSupported: true,
        authenticated,
        authenticationState: authenticated ? 'authenticated' : 'unauthenticated',
        maskedAccount: maskEmail(accountEmail),
        planType: accountPlan,
        availableModels: models,
        selectedModel: selected,
        lastCheckedAt: new Date().toISOString(),
        actionableErrorCode: authenticated ? null : 'CODEX_UNAUTHENTICATED',
        actionableMessage: authenticated ? null : 'Codex CLI 로그인이 필요합니다.',
      });
    } catch (error) {
      await this.stop();
      this.update({
        state: 'incompatible',
        appServerSupported: false,
        authenticated: null,
        authenticationState: 'unknown',
        lastCheckedAt: new Date().toISOString(),
        actionableErrorCode: 'CODEX_APP_SERVER_UNAVAILABLE',
        actionableMessage: safeError(
          error,
          'Codex CLI 업데이트가 필요하거나 App Server를 시작할 수 없습니다.',
        ),
      });
    }
    return this.snapshot;
  }
  async start(executable?: string): Promise<void> {
    if (this.process) return;
    if (this.starting) return this.starting;
    this.starting = this.doStart(
      executable ?? this.snapshotValue.resolvedExecutablePath ?? 'codex',
    ).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  private async doStart(executable: string): Promise<void> {
    const child = spawn(executable, ['app-server', '--stdio'], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    this.process = child;
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.handleLine(line));
    child.stderr.on('data', (chunk: Buffer) => {
      redact(chunk.toString('utf8'));
    });
    child.once('error', (error) => this.handleCrash(error));
    child.once('exit', (code) =>
      this.handleCrash(new Error(`CODEX_PROCESS_CRASHED:${code ?? 'unknown'}`)),
    );
    await this.request(
      'initialize',
      {
        clientInfo: { name: 'lg-report-agent', title: 'LG Report Agent', version: '1.0.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
      10_000,
    );
    this.notify('initialized');
    this.restartCount = 0;
  }
  async stop(): Promise<void> {
    const child = this.process;
    this.process = null;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('CODEX_PROCESS_STOPPED'));
    }
    this.pending.clear();
    if (child && !child.killed) {
      child.kill();
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        });
      }
    }
    this.update({ state: 'stopped' });
  }
  request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.pending.size >= 100) return Promise.reject(new Error('CODEX_QUEUE_OVERLOAD'));
    if (!this.process) return Promise.reject(new Error('CODEX_APP_SERVER_UNAVAILABLE'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CODEX_REQUEST_TIMEOUT'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process?.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
  notify(method: string, params?: unknown): void {
    this.process?.stdin.write(
      `${JSON.stringify(params === undefined ? { method } : { method, params })}\n`,
    );
  }
  async login(): Promise<string> {
    if (!this.process) await this.refresh();
    const result = (await this.request(
      'account/login/start',
      { type: 'chatgpt', useHostedLoginSuccessPage: true },
      20_000,
    )) as { authUrl?: unknown };
    if (typeof result.authUrl !== 'string' || !result.authUrl.startsWith('https://'))
      throw new Error('CODEX_PROTOCOL_ERROR');
    return result.authUrl;
  }
  async startTurn(input: {
    taskId: string;
    sessionId: string;
    prompt: string;
    cwd: string;
    threadId: string | null;
    model: string | null;
    effort: string | null;
    outputSchema: Record<string, unknown> | null;
    writable: boolean;
  }): Promise<{ threadId: string; turnId: string }> {
    if (this.activeTurn) throw new Error('CODEX_BUSY');
    if (!this.process) await this.refresh();
    if (this.snapshotValue.state !== 'ready') throw new Error('CODEX_UNAUTHENTICATED');
    this.update({ state: 'busy' });
    let threadId = input.threadId;
    if (!threadId) {
      const response = (await this.request(
        'thread/start',
        {
          model: input.model,
          cwd: input.cwd,
          runtimeWorkspaceRoots: [input.cwd],
          approvalPolicy: 'never',
          sandbox: input.writable ? 'workspace-write' : 'read-only',
          ephemeral: false,
          environments: [],
        },
        30_000,
      )) as { thread?: { id?: unknown } };
      if (typeof response.thread?.id !== 'string') throw new Error('CODEX_PROTOCOL_ERROR');
      threadId = response.thread.id;
    }
    const result = (await this.request(
      'turn/start',
      {
        threadId,
        input: [{ type: 'text', text: input.prompt, text_elements: [] }],
        cwd: input.cwd,
        runtimeWorkspaceRoots: [input.cwd],
        approvalPolicy: 'never',
        sandboxPolicy: input.writable
          ? {
              type: 'workspaceWrite',
              writableRoots: [input.cwd],
              networkAccess: false,
              excludeTmpdirEnvVar: true,
              excludeSlashTmp: true,
            }
          : { type: 'readOnly', networkAccess: false },
        model: input.model,
        effort: input.effort,
        outputSchema: input.outputSchema,
        environments: [],
      },
      30_000,
    )) as { turn?: { id?: unknown } };
    if (typeof result.turn?.id !== 'string') throw new Error('CODEX_PROTOCOL_ERROR');
    this.activeTurn = {
      taskId: input.taskId,
      sessionId: input.sessionId,
      threadId,
      turnId: result.turn.id,
    };
    return { threadId, turnId: result.turn.id };
  }
  async cancel(): Promise<void> {
    const active = this.activeTurn;
    if (!active) return;
    await this.request(
      'turn/interrupt',
      { threadId: active.threadId, turnId: active.turnId },
      10_000,
    ).catch(() => undefined);
    this.emit('event', {
      type: 'error',
      taskId: active.taskId,
      sessionId: active.sessionId,
      errorCode: 'CODEX_TURN_INTERRUPTED',
      message: 'AI 작업이 취소되었습니다.',
    } satisfies CodexEvent);
    this.activeTurn = null;
    this.update({ state: 'ready' });
  }
  async deleteThread(threadId: string): Promise<void> {
    if (!this.process) return;
    await this.request('thread/delete', { threadId }, 10_000);
  }
  private handleLine(line: string): void {
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.malformed++;
      if (this.malformed > 5) this.handleCrash(new Error('CODEX_PROTOCOL_ERROR'));
      return;
    }
    const response = responseSchema.safeParse(raw);
    if (response.success) {
      const pending = this.pending.get(response.data.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.data.id);
      if (response.data.error) pending.reject(new Error(response.data.error.message));
      else pending.resolve(response.data.result);
      return;
    }
    const note = notificationSchema.safeParse(raw);
    if (note.success) this.handleNotification(note.data.method, note.data.params);
  }
  private handleNotification(method: string, params: unknown): void {
    if (method === 'item/agentMessage/delta') {
      const parsed = z.object({ delta: z.string() }).safeParse(params);
      if (parsed.success && this.activeTurn)
        this.emit('event', {
          type: 'delta',
          taskId: this.activeTurn.taskId,
          sessionId: this.activeTurn.sessionId,
          text: parsed.data.delta,
        } satisfies CodexEvent);
    } else if (method === 'turn/completed') {
      const active = this.activeTurn;
      if (active) {
        this.emit('event', {
          type: 'complete',
          taskId: active.taskId,
          sessionId: active.sessionId,
        } satisfies CodexEvent);
        this.activeTurn = null;
        this.update({ state: 'ready' });
      }
    } else if (method === 'account/login/completed' || method === 'account/updated') {
      this.emit('event', { type: 'login' } satisfies CodexEvent);
      void this.refresh();
    }
  }
  private handleCrash(error: Error): void {
    if (!this.process) return;
    this.process = null;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('CODEX_PROCESS_CRASHED'));
    }
    this.pending.clear();
    const active = this.activeTurn;
    this.activeTurn = null;
    if (active)
      this.emit('event', {
        type: 'error',
        taskId: active.taskId,
        sessionId: active.sessionId,
        errorCode: 'CODEX_PROCESS_CRASHED',
        message: 'Codex 프로세스가 종료되었습니다.',
      } satisfies CodexEvent);
    this.update({
      state: 'error',
      actionableErrorCode: 'CODEX_PROCESS_CRASHED',
      actionableMessage: safeError(error, 'Codex 프로세스가 종료되었습니다. 새로고침하십시오.'),
    });
    if (this.restartCount < 2 && this.snapshotValue.resolvedExecutablePath) {
      const delay = 500 * 2 ** this.restartCount++;
      this.update({ state: 'reconnecting' });
      setTimeout(
        () =>
          void this.start()
            .then(() => this.refresh())
            .catch(() => undefined),
        delay,
      );
    }
  }
}
function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const [local, domain] = email.split('@');
  if (!local || !domain) return null;
  return `${local.slice(0, 2)}***@${domain}`;
}
function safeError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : '';
  return /^[A-Z0-9_:-]+$/.test(message) ? `${fallback} (${message})` : fallback;
}
