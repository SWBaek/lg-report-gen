import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import spawn from 'cross-spawn';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { CodexEvent, ModelInfo, ProviderSnapshot } from '../../shared/types/index.js';
import { redact, resolveCodexExecutable } from './executable-resolver.js';
import {
  agentMessageDeltaSchema,
  accountResponseSchema,
  CodexProtocolAdapter,
  modelResponseSchema,
  notificationSchema,
  notificationRequestSchema,
  responseSchema,
  requestSchema,
  turnCompletedSchema,
  type ProtocolInfo,
} from './protocol-adapter.js';
import packageJson from '../../../package.json' with { type: 'json' };

export type CodexAppServerManagerOptions = {
  /** Injectable clock hooks keep overload retry tests deterministic. */
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  overloadMaxAttempts?: number;
  overloadBaseDelayMs?: number;
  overloadMaxDelayMs?: number;
  maxPendingRequests?: number;
  maxOutboundMessages?: number;
  gracefulShutdownMs?: number;
};

class CodexRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'CodexRpcError';
  }
}
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  generation: number;
};

type ActiveTurn = {
  taskId: string;
  sessionId: string;
  threadId: string | null;
  turnId: string | null;
  generation: number;
  cancelled: boolean;
  outputSchema: Record<string, unknown> | null;
};

type Outbound = { child: ChildProcessWithoutNullStreams; generation: number; line: string };
type BufferedNotification = { method: string; params: unknown };

export class CodexAppServerManager extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private processGeneration = 0;
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private activeTurn: ActiveTurn | null = null;
  private outbound: Outbound[] = [];
  private terminalTombstones = new Map<string, number>();
  private cancelledThreadTombstones = new Map<string, number>();
  /** Threads are process-local; a persisted DB thread must be resumed once per generation. */
  private loadedThreads = new Map<string, number>();
  // The app-server may write turn notifications in the same JSONL burst as
  // the turn/start response. Buffer only this short hand-off window.
  private earlyNotifications: BufferedNotification[] = [];
  private static readonly MAX_EARLY_NOTIFICATIONS = 100;
  private starting: Promise<void> | null = null;
  private refreshing: Promise<ProviderSnapshot> | null = null;
  private malformed = 0;
  private configuredPath: string | null = null;
  private restartCount = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartToken = 0;
  private readonly protocol: CodexProtocolAdapter;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly overloadMaxAttempts: number;
  private readonly overloadBaseDelayMs: number;
  private readonly overloadMaxDelayMs: number;
  private readonly maxPendingRequests: number;
  private readonly maxOutboundMessages: number;
  private readonly gracefulShutdownMs: number;
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
  constructor(options: CodexAppServerManagerOptions = {}) {
    super();
    this.protocol = new CodexProtocolAdapter({ clientVersion: packageJson.version });
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.random = options.random ?? Math.random;
    this.overloadMaxAttempts = Math.max(1, options.overloadMaxAttempts ?? 3);
    this.overloadBaseDelayMs = Math.max(0, options.overloadBaseDelayMs ?? 100);
    this.overloadMaxDelayMs = Math.max(
      this.overloadBaseDelayMs,
      options.overloadMaxDelayMs ?? 2_000,
    );
    this.maxPendingRequests = Math.max(1, options.maxPendingRequests ?? 100);
    this.maxOutboundMessages = Math.max(1, options.maxOutboundMessages ?? 100);
    this.gracefulShutdownMs = Math.max(0, options.gracefulShutdownMs ?? 150);
  }
  get snapshot(): ProviderSnapshot {
    return structuredClone(this.snapshotValue);
  }
  get protocolInfo(): ProtocolInfo {
    return this.protocol.protocolInfo;
  }
  getProtocolInfo(): ProtocolInfo {
    return this.protocolInfo;
  }
  setConfiguredPath(value: string | null): void {
    this.configuredPath = value;
  }
  private update(patch: Partial<ProviderSnapshot>): void {
    this.snapshotValue = { ...this.snapshotValue, ...patch };
    this.emit('event', { type: 'state', snapshot: this.snapshot } satisfies CodexEvent);
  }
  async refresh(): Promise<ProviderSnapshot> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
  private async doRefresh(): Promise<ProviderSnapshot> {
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
      await this.refreshCatalog();
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

  private async refreshCatalog(): Promise<void> {
    const [accountRaw, modelsRaw] = await Promise.all([
      this.request('account/read', { refreshToken: false }, 10_000),
      this.request('model/list', { includeHidden: false }, 10_000),
    ]);
    const account = accountResponseSchema.parse(accountRaw);
    const models = modelResponseSchema
      .parse(modelsRaw)
      .data.filter((item) => !item.hidden)
      .map<ModelInfo>((item) => ({
        id: item.model ?? item.id,
        displayName: item.displayName ?? item.id,
        isDefault: Boolean(item.isDefault),
        defaultReasoningEffort: item.defaultReasoningEffort ?? null,
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
  }
  async start(executable?: string): Promise<void> {
    if (this.process) return;
    if (this.starting) return this.starting;
    this.cancelRestartTimer();
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
    const generation = ++this.processGeneration;
    this.process = child;
    child.stdin.on('drain', () => this.flushOutbound(child, generation));
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.handleLine(line, generation));
    child.stderr.on('data', (chunk: Buffer) => {
      redact(chunk.toString('utf8'));
    });
    child.once('error', (error) => this.handleCrash(error, generation, child));
    child.once('exit', (code) =>
      this.handleCrash(new Error(`CODEX_PROCESS_CRASHED:${code ?? 'unknown'}`), generation, child),
    );
    try {
      const initializeResult = await this.request(
        'initialize',
        this.protocol.initializeParams(),
        10_000,
      );
      const protocolInfo = this.protocol.negotiateInitialize(initializeResult);
      if (!protocolInfo.supported) throw new Error('CODEX_PROTOCOL_UNSUPPORTED');
      this.notify('initialized');
      this.malformed = 0;
      this.restartCount = 0;
    } catch (error) {
      this.handleCrash(
        error instanceof Error ? error : new Error('CODEX_PROCESS_CRASHED'),
        generation,
        child,
      );
      throw error;
    }
  }
  async stop(): Promise<void> {
    this.cancelRestartTimer();
    const child = this.process;
    const childGeneration = this.processGeneration;
    // Invalidate the generation before waiting for shutdown. Exit/error events
    // from this child must not reject a subsequently started generation.
    this.process = null;
    this.processGeneration++;
    this.outbound = [];
    const active = this.activeTurn;
    this.activeTurn = null;
    if (active) {
      this.addTombstone(active);
      this.emit('event', {
        type: 'error',
        taskId: active.taskId,
        sessionId: active.sessionId,
        errorCode: 'CODEX_PROCESS_STOPPED',
        message: 'Codex 프로세스가 종료되었습니다.',
      } satisfies CodexEvent);
    }
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('CODEX_PROCESS_STOPPED'));
    }
    this.pending.clear();
    if (child && !child.killed) {
      // Give a compliant app-server a short opportunity to flush and exit.
      // This write is deliberately independent of the outbound queue, which
      // was invalidated above as part of the lifecycle transition.
      try {
        child.stdin.write(JSON.stringify({ method: 'shutdown' }) + '\n');
      } catch {
        // The process may already have closed its pipe.
      }
      await waitForExit(child, this.gracefulShutdownMs);
      if (!child.killed) {
        child.kill();
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            shell: false,
            windowsHide: true,
            stdio: 'ignore',
          });
        }
      }
    }
    // Keep this read explicit: it documents that stop owns the old generation
    // even when no child was available (e.g. a failed spawn).
    void childGeneration;
    this.update({ state: 'stopped' });
  }
  request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    return this.requestWithRetry(method, params, timeoutMs);
  }
  private async requestWithRetry(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.requestOnce(method, params, timeoutMs);
      } catch (error) {
        if (
          !(error instanceof CodexRpcError) ||
          error.code !== -32001 ||
          attempt >= this.overloadMaxAttempts
        )
          throw error;
        const exponential = Math.min(
          this.overloadMaxDelayMs,
          this.overloadBaseDelayMs * 2 ** (attempt - 1),
        );
        // Full jitter avoids synchronized retries while injected random/sleep
        // hooks make the policy deterministic in integration tests.
        const delay = Math.floor(exponential * Math.max(0, Math.min(1, this.random())));
        await this.sleep(delay);
      }
    }
  }
  private requestOnce(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.pending.size >= this.maxPendingRequests)
      return Promise.reject(new Error('CODEX_QUEUE_OVERLOAD'));
    if (!this.process) return Promise.reject(new Error('CODEX_APP_SERVER_UNAVAILABLE'));
    const id = this.nextId++;
    const child = this.process;
    const generation = this.processGeneration;
    const message = requestSchema.parse({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CODEX_REQUEST_TIMEOUT'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, generation });
      if (!this.enqueueOutbound(child, generation, JSON.stringify(message) + '\n')) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('CODEX_STDIN_BACKPRESSURE'));
      }
    });
  }
  notify(method: string, params?: unknown): void {
    const child = this.process;
    if (!child) return;
    const message = notificationRequestSchema.parse(
      params === undefined ? { method } : { method, params },
    );
    this.enqueueOutbound(child, this.processGeneration, JSON.stringify(message) + '\n');
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
    writableRoot?: string;
    threadId: string | null;
    model: string | null;
    effort: string | null;
    outputSchema: Record<string, unknown> | null;
    writable: boolean;
  }): Promise<{ threadId: string; turnId: string }> {
    // Reserve synchronously. This is intentionally before the first await so two
    // IPC calls cannot both pass the busy check while the server is starting.
    if (this.activeTurn) throw new Error('CODEX_BUSY');
    const reservation: ActiveTurn = {
      taskId: input.taskId,
      sessionId: input.sessionId,
      threadId: input.threadId,
      turnId: null,
      generation: this.processGeneration,
      cancelled: false,
      outputSchema: input.outputSchema,
    };
    this.activeTurn = reservation;
    this.earlyNotifications = [];
    try {
      if (!this.process) await this.refresh();
      this.assertReservation(reservation);
      // refresh() may have created a new app-server process generation.
      reservation.generation = this.processGeneration;
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
        this.assertReservation(reservation);
        if (typeof response.thread?.id !== 'string') throw new Error('CODEX_PROTOCOL_ERROR');
        threadId = response.thread.id;
        reservation.threadId = threadId;
        this.loadedThreads.set(threadId, reservation.generation);
      } else if (this.loadedThreads.get(threadId) !== this.processGeneration) {
        // A thread ID survives in SQLite, while the app-server's in-memory thread
        // registry does not. Never silently fork a new thread when resuming fails.
        try {
          await this.request(
            'thread/resume',
            {
              threadId,
              cwd: input.cwd,
              runtimeWorkspaceRoots: [input.cwd],
              model: input.model,
              approvalPolicy: 'never',
              sandbox: input.writable ? 'workspace-write' : 'read-only',
              ephemeral: false,
              environments: [],
            },
            30_000,
          );
        } catch {
          throw new Error('CODEX_THREAD_RESUME_FAILED');
        }
        this.assertReservation(reservation);
        this.loadedThreads.set(threadId, this.processGeneration);
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
                writableRoots: [input.writableRoot ?? input.cwd],
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
      if (reservation.cancelled) {
        if (typeof result.turn?.id === 'string') {
          this.addTombstone(reservation, threadId, result.turn.id);
          await this.request('turn/interrupt', { threadId, turnId: result.turn.id }, 10_000).catch(
            () => undefined,
          );
        }
        throw new Error('CODEX_TURN_INTERRUPTED');
      }
      this.assertReservation(reservation);
      if (typeof result.turn?.id !== 'string') throw new Error('CODEX_PROTOCOL_ERROR');
      reservation.turnId = result.turn.id;
      reservation.generation = this.processGeneration;
      this.flushEarlyNotifications(reservation);
      return { threadId, turnId: result.turn.id };
    } catch (error) {
      if (this.activeTurn === reservation) {
        this.activeTurn = null;
        if (this.snapshotValue.state === 'busy') this.update({ state: 'ready' });
      }
      throw error;
    }
  }
  async cancel(taskId?: string, sessionId?: string): Promise<void> {
    const active = this.activeTurn;
    if (!active) return;
    if (taskId && taskId !== active.taskId) throw new Error('CODEX_TASK_MISMATCH');
    if (sessionId && sessionId !== active.sessionId) throw new Error('CODEX_SESSION_MISMATCH');
    active.cancelled = true;
    this.addTombstone(active);
    this.activeTurn = null;
    this.earlyNotifications = [];
    this.emit('event', {
      type: 'error',
      taskId: active.taskId,
      sessionId: active.sessionId,
      errorCode: 'CODEX_TURN_INTERRUPTED',
      message: 'AI 작업이 취소되었습니다.',
    } satisfies CodexEvent);
    if (active.threadId) this.cancelledThreadTombstones.set(active.threadId, Date.now() + 60_000);
    if (active.turnId) {
      await this.request(
        'turn/interrupt',
        { threadId: active.threadId, turnId: active.turnId },
        10_000,
      ).catch(() => undefined);
    }
    this.earlyNotifications = [];
    if (this.snapshotValue.state === 'busy') this.update({ state: 'ready' });
  }
  async deleteThread(threadId: string): Promise<void> {
    if (!this.process) return;
    await this.request('thread/delete', { threadId }, 10_000);
  }
  private handleLine(line: string, generation: number): void {
    if (generation !== this.processGeneration) return;
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.malformed++;
      if (this.malformed > 5 && this.process)
        this.handleCrash(new Error('CODEX_PROTOCOL_ERROR'), generation, this.process);
      return;
    }
    const response = responseSchema.safeParse(raw);
    if (response.success) {
      const pending = this.pending.get(response.data.id);
      if (!pending || pending.generation !== generation) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.data.id);
      if (response.data.error)
        pending.reject(new CodexRpcError(response.data.error.code, response.data.error.message));
      else pending.resolve(response.data.result);
      return;
    }
    const note = notificationSchema.safeParse(raw);
    if (note.success) this.handleNotification(note.data.method, note.data.params);
    else {
      this.malformed++;
      if (this.malformed > 5 && this.process)
        this.handleCrash(new Error('CODEX_PROTOCOL_ERROR'), generation, this.process);
    }
  }
  private handleNotification(method: string, params: unknown): void {
    if (method === 'item/agentMessage/delta') {
      const parsed = agentMessageDeltaSchema.safeParse(params);
      const active = this.activeTurn;
      if (
        parsed.success &&
        active &&
        active.threadId === parsed.data.threadId &&
        (active.turnId === parsed.data.turnId || !active.turnId)
      )
        if (!active.turnId) this.bufferEarlyNotification(method, params);
        else if (active.outputSchema) return;
        else
          this.emit('event', {
            type: 'delta',
            taskId: active.taskId,
            sessionId: active.sessionId,
            text: parsed.data.delta,
          } satisfies CodexEvent);
    } else if (method === 'turn/completed') {
      const active = this.activeTurn;
      const ids = notificationIds(params);
      if (!active) {
        if (ids.threadId && ids.turnId && this.hasTombstone(ids.threadId, ids.turnId)) return;
        if (ids.threadId && this.cancelledThreadTombstones.has(ids.threadId)) return;
        return;
      }
      if (ids.threadId && ids.threadId !== active.threadId) return;
      if (ids.turnId && active.turnId && ids.turnId !== active.turnId) return;
      const completed = turnCompletedSchema.safeParse(params);
      if (
        completed.success &&
        active &&
        !active.turnId &&
        active.threadId === completed.data.threadId
      ) {
        this.bufferEarlyNotification(method, params);
        return;
      }
      if (
        !completed.success ||
        !this.matches(active, completed.data.threadId, completed.data.turn.id)
      ) {
        this.finishTurn(active, {
          type: 'error',
          taskId: active.taskId,
          sessionId: active.sessionId,
          errorCode: 'CODEX_PROTOCOL_ERROR',
          message: 'Codex가 올바르지 않은 완료 응답을 보냈습니다.',
        });
        return;
      }
      if (completed.data.turn.status !== 'completed') {
        const interrupted = completed.data.turn.status === 'interrupted';
        const failure = classifyTurnFailure(completed.data.turn.error);
        this.finishTurn(active, {
          type: 'error',
          taskId: active.taskId,
          sessionId: active.sessionId,
          errorCode: interrupted ? 'CODEX_TURN_INTERRUPTED' : failure.errorCode,
          message: interrupted ? 'AI 작업이 중단되었습니다.' : failure.message,
        });
        return;
      }
      const messages = completed.data.turn.items.filter(
        (item): item is typeof item & { text: string } =>
          item.type === 'agentMessage' && typeof item.text === 'string',
      );
      const finalText =
        [...messages].reverse().find((item) => item.phase === 'final_answer')?.text ??
        messages.at(-1)?.text;
      if (active.outputSchema) {
        // Structured output is never streamed and invalid text is discarded;
        // callers only receive a normalized, schema-checked JSON value.
        if (finalText === undefined) {
          this.finishTurn(active, {
            type: 'error',
            taskId: active.taskId,
            sessionId: active.sessionId,
            errorCode: 'CODEX_PROTOCOL_ERROR',
            message: 'Codex가 구조화된 결과를 반환하지 않았습니다.',
          });
          return;
        }
        const parsed = this.protocol.parseStructuredOutput(finalText, active.outputSchema);
        if (!parsed.ok) {
          this.finishTurn(active, {
            type: 'error',
            taskId: active.taskId,
            sessionId: active.sessionId,
            errorCode: 'CODEX_PROTOCOL_ERROR',
            message: 'Codex가 올바르지 않은 구조화된 결과를 반환했습니다.',
          });
          return;
        }
        this.finishTurn(active, {
          type: 'complete',
          taskId: active.taskId,
          sessionId: active.sessionId,
          text: JSON.stringify(parsed.value),
        });
        return;
      }
      this.finishTurn(active, {
        type: 'complete',
        taskId: active.taskId,
        sessionId: active.sessionId,
        ...(finalText !== undefined ? { text: finalText } : {}),
      });
    } else if (method === 'account/login/completed' || method === 'account/updated') {
      this.emit('event', { type: 'login' } satisfies CodexEvent);
      if (this.process)
        void this.refreshCatalog().catch(() => {
          this.update({ state: 'error', actionableErrorCode: 'CODEX_APP_SERVER_UNAVAILABLE' });
        });
    }
  }
  private handleCrash(
    error: Error,
    generation: number,
    child: ChildProcessWithoutNullStreams,
  ): void {
    if (!this.process || this.process !== child || generation !== this.processGeneration) return;
    this.process = null;
    this.outbound = [];
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('CODEX_PROCESS_CRASHED'));
    }
    this.pending.clear();
    const active = this.activeTurn;
    this.activeTurn = null;
    if (active) {
      this.addTombstone(active);
      this.emit('event', {
        type: 'error',
        taskId: active.taskId,
        sessionId: active.sessionId,
        errorCode: 'CODEX_PROCESS_CRASHED',
        message: 'Codex 프로세스가 종료되었습니다.',
      } satisfies CodexEvent);
    }
    this.update({
      state: 'error',
      actionableErrorCode: 'CODEX_PROCESS_CRASHED',
      actionableMessage: safeError(error, 'Codex 프로세스가 종료되었습니다. 새로고침하십시오.'),
    });
    if (this.restartCount < 2 && this.snapshotValue.resolvedExecutablePath) {
      const delay = 500 * 2 ** this.restartCount++;
      this.update({ state: 'reconnecting' });
      this.scheduleRestart(delay);
    }
  }

  private assertReservation(reservation: ActiveTurn): void {
    if (reservation.cancelled) throw new Error('CODEX_TURN_INTERRUPTED');
    if (this.activeTurn !== reservation) {
      if (this.snapshotValue.state !== 'ready') throw new Error('CODEX_UNAUTHENTICATED');
      throw new Error('CODEX_BUSY');
    }
  }

  private matches(active: ActiveTurn, threadId: string, turnId: string): boolean {
    return active.threadId === threadId && active.turnId === turnId;
  }

  private finishTurn(active: ActiveTurn, event: CodexEvent): void {
    if (this.activeTurn !== active) return;
    this.addTombstone(active);
    this.activeTurn = null;
    this.earlyNotifications = [];
    this.emit('event', event);
    if (this.snapshotValue.state === 'busy') this.update({ state: 'ready' });
  }

  private bufferEarlyNotification(method: string, params: unknown): void {
    if (this.earlyNotifications.length >= CodexAppServerManager.MAX_EARLY_NOTIFICATIONS) return;
    this.earlyNotifications.push({ method, params });
  }

  private flushEarlyNotifications(active: ActiveTurn): void {
    if (this.activeTurn !== active || !active.turnId) return;
    const buffered = this.earlyNotifications;
    this.earlyNotifications = [];
    for (const notification of buffered) {
      if (this.activeTurn !== active) break;
      this.handleNotification(notification.method, notification.params);
    }
  }

  private addTombstone(
    active: ActiveTurn,
    threadId = active.threadId,
    turnId = active.turnId,
  ): void {
    if (threadId && turnId)
      this.terminalTombstones.set(
        `${active.generation}:${threadId}:${turnId}`,
        Date.now() + 60_000,
      );
  }

  private hasTombstone(threadId: string, turnId: string): boolean {
    const now = Date.now();
    for (const [key, expires] of this.terminalTombstones) {
      if (expires <= now) this.terminalTombstones.delete(key);
    }
    return [...this.terminalTombstones.keys()].some((key) =>
      key.endsWith(`:${threadId}:${turnId}`),
    );
  }

  private enqueueOutbound(
    child: ChildProcessWithoutNullStreams | null,
    generation: number,
    line: string,
  ): boolean {
    if (!child || this.process !== child || this.processGeneration !== generation) return false;
    if (this.outbound.length >= this.maxOutboundMessages) return false;
    this.outbound.push({ child, generation, line });
    this.flushOutbound(child, generation);
    return true;
  }

  private flushOutbound(child: ChildProcessWithoutNullStreams, generation: number): void {
    if (this.process !== child || this.processGeneration !== generation) return;
    while (this.outbound.length > 0) {
      const item = this.outbound[0];
      if (!item) break;
      if (item.child !== child || item.generation !== generation) {
        this.outbound.shift();
        continue;
      }
      try {
        this.outbound.shift();
        if (!child.stdin.write(item.line)) return;
      } catch (error) {
        this.handleCrash(
          error instanceof Error ? error : new Error('CODEX_PROCESS_CRASHED'),
          generation,
          child,
        );
        return;
      }
    }
  }

  private cancelRestartTimer(): void {
    this.restartToken++;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private scheduleRestart(delay: number): void {
    this.cancelRestartTimer();
    const token = this.restartToken;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (token !== this.restartToken || this.process) return;
      void this.start()
        .then(() => this.refreshCatalog())
        .catch(() => {
          // A reconnect probe failed; leave the process lifecycle in the
          // normal error state and let the bounded crash policy decide next.
          if (this.process) void this.stop();
        });
    }, delay);
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once('exit', finish);
    if (child.exitCode !== null || child.signalCode !== null) finish();
  });
}

function notificationIds(params: unknown): { threadId?: string; turnId?: string } {
  if (!params || typeof params !== 'object') return {};
  const value = params as { threadId?: unknown; turnId?: unknown; turn?: { id?: unknown } };
  return {
    ...(typeof value.threadId === 'string' ? { threadId: value.threadId } : {}),
    ...(typeof value.turnId === 'string'
      ? { turnId: value.turnId }
      : typeof value.turn?.id === 'string'
        ? { turnId: value.turn.id }
        : {}),
  };
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

/** Convert provider failures to stable, content-free diagnostics for the Renderer. */
function classifyTurnFailure(
  error:
    | {
        message: string;
        codexErrorInfo?: unknown;
      }
    | null
    | undefined,
): { errorCode: string; message: string } {
  const normalized = error?.message.toLowerCase() ?? '';
  if (normalized.includes('invalid_json_schema'))
    return {
      errorCode: 'CODEX_OUTPUT_SCHEMA_INVALID',
      message: '현재 앱의 AI 출력 형식이 Codex와 호환되지 않습니다. 앱을 업데이트해 주세요.',
    };
  if (
    error?.codexErrorInfo === 'contextWindowExceeded' ||
    normalized.includes('context_length') ||
    normalized.includes('context window')
  )
    return {
      errorCode: 'CODEX_CONTEXT_LIMIT',
      message:
        '요청과 첨부 자료가 AI 컨텍스트 한도를 초과했습니다. 범위를 줄여 다시 시도해 주세요.',
    };
  if (
    error?.codexErrorInfo === 'rateLimitExceeded' ||
    error?.codexErrorInfo === 'usageLimitExceeded' ||
    error?.codexErrorInfo === 'sessionBudgetExceeded' ||
    normalized.includes('rate_limit') ||
    normalized.includes('usage limit')
  )
    return {
      errorCode: 'CODEX_RATE_LIMITED',
      message: 'Codex 사용 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.',
    };
  if (error?.codexErrorInfo === 'unauthorized')
    return {
      errorCode: 'CODEX_UNAUTHENTICATED',
      message: 'Codex 로그인이 만료되었습니다. 설정에서 다시 로그인해 주세요.',
    };
  if (error?.codexErrorInfo === 'sandboxError')
    return {
      errorCode: 'CODEX_SANDBOX_ERROR',
      message: 'Codex의 로컬 작업 격리를 시작하지 못했습니다. 설정을 새로고침해 주세요.',
    };
  if (error?.codexErrorInfo === 'serverOverloaded')
    return {
      errorCode: 'CODEX_SERVER_OVERLOADED',
      message: 'Codex 서비스가 혼잡합니다. 잠시 후 다시 시도해 주세요.',
    };
  return { errorCode: 'CODEX_EXECUTION_FAILED', message: 'AI 작업을 완료하지 못했습니다.' };
}
