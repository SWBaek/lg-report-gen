import { clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { IPC, IPC_ALLOWLIST } from '../../shared/constants/ipc.js';
import {
  chatCreateSchema,
  chatAiSettingsSchema,
  codexCancelSchema,
  codexTurnSchema,
  createReportSchema,
  externalPurposeSchema,
  importSourcesSchema,
  listReportsSchema,
  messageListSchema,
  personaSchema,
  renameSchema,
  reportFlagSchema,
  reportIdSchema,
  revisionCreateSchema,
  revisionRestoreSchema,
  saveReportSchema,
  textSchema,
  workspacePathSchema,
  reportGenerationListSchema,
  deletionRetentionListSchema,
  deletionRetentionRetrySchema,
  reportExportPreflightSchema,
  reportExportSchema,
} from '../../shared/schemas/index.js';
import type {
  BootstrapState,
  CodexEvent,
  PublicReport,
  PublicRevision,
  PublicSourceManifestEntry,
  Report,
  SourceManifestEntry,
  SourceSelection,
  ChatSession,
  ProviderSnapshot,
} from '../../shared/types/index.js';
import type { ApplicationContext } from '../app/context.js';
import { exportReport, preflightReportExport } from '../exporters/html-exporter.js';
import { isAuthorizedIpcSender } from '../security/renderer.js';
import { verifyWorkspacePath } from '../workspace/manager.js';
import { outputSchemaFor } from '../codex/output-schema.js';

const registered: string[] = [];
const SOURCE_SELECTION_TTL_MS = 10 * 60_000;
export function registerIpc(context: ApplicationContext): void {
  const pendingSources = new Map<string, { path: string; expiresAt: number }>();
  const exportApprovals = new Map<
    string,
    { reportId: string; format: 'html' | 'pdf'; expiresAt: number }
  >();
  const handle = <T>(channel: string, listener: (input: unknown) => Promise<T> | T): void => {
    if (!IPC_ALLOWLIST.has(channel)) throw new Error(`IPC_NOT_ALLOWED:${channel}`);
    ipcMain.handle(channel, (event, input) => {
      authorizeSender(event, context);
      return listener(input);
    });
    registered.push(channel);
  };
  handle(IPC.bootstrapGet, () => bootstrap(context));
  handle(IPC.appConsent, () => context.acceptConsent());
  handle(IPC.workspaceChoose, async () => {
    if (context.codex.snapshot.state === 'busy') throw new Error('WORKSPACE_AI_TASK_ACTIVE');
    const result = await dialog.showOpenDialog(context.mainWindow!, {
      title: 'Workspace 선택 또는 생성',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    await context.switchWorkspace(result.filePaths[0]);
    return result.filePaths[0];
  });
  handle(IPC.workspaceSwitch, async (input) => {
    if (context.codex.snapshot.state === 'busy') throw new Error('WORKSPACE_AI_TASK_ACTIVE');
    const { path: root } = workspacePathSchema.parse(input);
    await context.switchWorkspace(root);
    return bootstrap(context);
  });
  handle(IPC.workspaceOpen, async () => {
    await shell.openPath(context.requirePaths().root);
  });
  handle(IPC.reportsList, (input) => {
    const value = listReportsSchema.parse(input ?? {});
    return context.requireDatabase().listReports(value.includeDeleted, value.query, value.sort);
  });
  handle(IPC.reportCreate, (input) =>
    context.requireDatabase().createReport(createReportSchema.parse(input)).then(toPublicReport),
  );
  handle(IPC.reportGet, (input) =>
    context.requireDatabase().getReport(reportIdSchema.parse(input).id).then(toPublicReport),
  );
  handle(IPC.reportSave, (input) =>
    context.requireDatabase().saveReport(saveReportSchema.parse(input)).then(toPublicReport),
  );
  handle(IPC.reportRename, (input) => {
    const value = renameSchema.parse(input);
    context.requireDatabase().renameReport(value.id, value.title);
  });
  handle(IPC.reportFavorite, (input) => {
    const value = reportFlagSchema.parse(input);
    context.requireDatabase().favoriteReport(value.id, value.value);
  });
  handle(IPC.reportDuplicate, (input) =>
    context.requireDatabase().duplicateReport(reportIdSchema.parse(input).id).then(toPublicReport),
  );
  handle(IPC.reportTrash, (input) =>
    context.requireDatabase().trashReport(reportIdSchema.parse(input).id),
  );
  handle(IPC.reportRestore, (input) =>
    context.requireDatabase().restoreReport(reportIdSchema.parse(input).id),
  );
  handle(IPC.reportDelete, async (input) => {
    const id = reportIdSchema.parse(input).id;
    const report = await context.requireDatabase().getReport(id);
    const linkedChats = context.requireDatabase().listChatsForReport(id);
    const threadIds = [
      ...(report.codexThreadId ? [report.codexThreadId] : []),
      ...linkedChats.flatMap((chat) => (chat.codexThreadId ? [chat.codexThreadId] : [])),
    ].filter((threadId, index, all) => all.indexOf(threadId) === index);
    const pendingThreadIds: string[] = [];
    let threadDeleteFailed = false;
    for (const threadId of threadIds) {
      try {
        await context.codex.deleteThread(threadId);
      } catch {
        threadDeleteFailed = true;
        pendingThreadIds.push(threadId);
      }
    }
    await context.requireDatabase().deleteReport(id);
    const retention = context.requireDatabase().recordDeletionRetention({
      ownerType: 'report',
      ownerId: id,
      codexThreadIds: threadIds,
      pendingThreadIds,
    });
    return { threadDeleteFailed, retentionId: retention.id, pendingThreadIds };
  });
  handle(IPC.reportExportPreflight, async (input) => {
    const value = reportExportPreflightSchema.parse(input);
    const report = await context.requireDatabase().getReport(value.id);
    const now = Date.now();
    for (const [token, approval] of exportApprovals) {
      if (approval.expiresAt <= now) exportApprovals.delete(token);
    }
    const result = await preflightReportExport(report, { format: value.format });
    const token = randomUUID();
    const expiresAt = now + 5 * 60_000;
    exportApprovals.set(token, { reportId: value.id, format: value.format, expiresAt });
    return { ...result, reservationToken: token, expiresAt: new Date(expiresAt).toISOString() };
  });
  handle(IPC.reportExport, async (input) => {
    // The token is required for the new preflight/approval flow. Keeping the
    // omitted-token HTML path preserves compatibility with older integrations.
    const value = reportExportSchema.parse(input);
    if (value.approvalToken) {
      const approval = exportApprovals.get(value.approvalToken);
      exportApprovals.delete(value.approvalToken);
      if (
        !approval ||
        approval.expiresAt <= Date.now() ||
        approval.reportId !== value.id ||
        approval.format !== value.format
      )
        throw new Error('EXPORT_APPROVAL_INVALID');
    } else if (value.format === 'pdf') {
      throw new Error('EXPORT_APPROVAL_REQUIRED');
    }
    const report = await context.requireDatabase().getReport(value.id);
    return exportReport(report, context.requirePaths().exports, {
      format: value.format,
      ...(value.metadata ? { metadata: value.metadata } : {}),
    });
  });
  handle(IPC.reportGenerationsList, (input) =>
    context.requireDatabase().listGenerations(reportGenerationListSchema.parse(input).reportId),
  );
  handle(IPC.reportClaimsList, (input) =>
    context.requireDatabase().listClaimEvidence(reportGenerationListSchema.parse(input).reportId),
  );
  handle(IPC.deletionRetentionList, (input) => {
    const value = deletionRetentionListSchema.parse(input ?? {});
    return context.requireDatabase().listDeletionRetention(value.id);
  });
  handle(IPC.deletionRetentionRetry, async (input) => {
    const value = deletionRetentionRetrySchema.parse(input);
    const retention = context
      .requireDatabase()
      .listDeletionRetention()
      .find((entry) => entry.id === value.id);
    if (!retention) throw new Error('DELETION_RETENTION_NOT_FOUND');
    const pending: string[] = [];
    for (const threadId of retention.pendingThreadIds) {
      try {
        await context.codex.deleteThread(threadId);
      } catch {
        pending.push(threadId);
      }
    }
    return context.requireDatabase().updateDeletionRetention(value.id, pending);
  });
  handle(IPC.revisionCreate, (input) => {
    const value = revisionCreateSchema.parse(input);
    return context
      .requireDatabase()
      .createRevision(value.reportId, value.reason, value.description)
      .then(toPublicRevision);
  });
  handle(IPC.revisionsList, (input) =>
    context.requireDatabase().listRevisions(reportIdSchema.parse(input).id).map(toPublicRevision),
  );
  handle(IPC.revisionRestore, (input) => {
    const value = revisionRestoreSchema.parse(input);
    return context
      .requireDatabase()
      .restoreRevision(value.reportId, value.revisionId)
      .then(toPublicReport);
  });
  handle(IPC.personasList, () => context.requireDatabase().listPersonas());
  handle(IPC.personaSave, (input) => {
    const value = personaSchema.parse(input);
    return context.requireDatabase().savePersona({
      ...(value.id ? { id: value.id } : {}),
      name: value.name,
      description: value.description,
      instructions: value.instructions,
      isDefault: value.isDefault,
    });
  });
  handle(IPC.personaDelete, (input) =>
    context.requireDatabase().deletePersona(reportIdSchema.parse(input).id),
  );
  handle(IPC.fileChoose, async () => {
    const result = await dialog.showOpenDialog(context.mainWindow!, {
      title: 'Source 파일 선택',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: '지원 문서',
          extensions: [
            'pdf',
            'docx',
            'pptx',
            'xlsx',
            'csv',
            'txt',
            'md',
            'png',
            'jpg',
            'jpeg',
            'webp',
          ],
        },
      ],
    });
    if (result.canceled) return [];
    const now = Date.now();
    pruneExpiredSelections(pendingSources, now);
    const expiresAt = now + SOURCE_SELECTION_TTL_MS;
    return result.filePaths.map((filePath): SourceSelection => {
      const selectionId = randomUUID();
      pendingSources.set(selectionId, { path: filePath, expiresAt });
      return { selectionId, originalName: path.basename(filePath) };
    });
  });
  handle(IPC.sourcesImport, async (input) => {
    const value = importSourcesSchema.parse(input);
    const now = Date.now();
    pruneExpiredSelections(pendingSources, now);
    // Validate the whole batch before consuming anything. Map.delete is the
    // atomic consume step (and this handler has no await before it), so retries
    // cannot reuse a token and a failed batch cannot partially consume tokens.
    const entries = value.selectionIds.map((selectionId) => {
      const entry = pendingSources.get(selectionId);
      if (!entry || entry.expiresAt <= now) throw new Error('SOURCE_SELECTION_EXPIRED');
      return entry;
    });
    value.selectionIds.forEach((selectionId) => pendingSources.delete(selectionId));
    const paths = entries.map((entry) => entry.path);
    const sources = await context.sourceImporter!.import(value.reportId, paths);
    for (const source of sources) context.requireDatabase().saveSource(value.reportId, source);
    return sources.map(toPublicSource);
  });
  handle(IPC.sourcesList, (input) =>
    context.requireDatabase().listSources(reportIdSchema.parse(input).id).map(toPublicSource),
  );
  handle(IPC.chatsList, () => context.requireDatabase().listChats());
  handle(IPC.chatCreate, (input) => {
    const value = chatCreateSchema.parse(input ?? {});
    return context.requireDatabase().createChat(value.title, value.reportId);
  });
  handle(IPC.chatRename, (input) => {
    const value = renameSchema.parse(input);
    context.requireDatabase().renameChat(value.id, value.title);
  });
  handle(IPC.chatAiSettings, (input) => {
    const value = chatAiSettingsSchema.parse(input);
    return context
      .requireDatabase()
      .updateChatAiSettings(value.id, value.model, value.reasoningEffort);
  });
  handle(IPC.chatDelete, async (input) => {
    const id = reportIdSchema.parse(input).id;
    const chat = context.requireDatabase().getChat(id);
    const pendingThreadIds: string[] = [];
    if (chat?.codexThreadId) {
      try {
        await context.codex.deleteThread(chat.codexThreadId);
      } catch {
        pendingThreadIds.push(chat.codexThreadId);
      }
    }
    context.requireDatabase().deleteChat(id);
    const retention = context.requireDatabase().recordDeletionRetention({
      ownerType: 'chat',
      ownerId: id,
      codexThreadIds: chat?.codexThreadId ? [chat.codexThreadId] : [],
      pendingThreadIds,
    });
    return { threadDeleteFailed: pendingThreadIds.length > 0, retentionId: retention.id };
  });
  handle(IPC.messagesList, (input) =>
    context.requireDatabase().listMessages(messageListSchema.parse(input).sessionId),
  );
  handle(IPC.codexRefresh, () => context.codex.refresh());
  handle(IPC.codexBrowse, async () => {
    const result = await dialog.showOpenDialog(context.mainWindow!, {
      title: 'Codex 실행 파일 선택',
      properties: ['openFile'],
      filters: [{ name: 'Codex 실행 파일', extensions: ['exe', 'cmd'] }],
    });
    const selected = result.filePaths[0];
    if (result.canceled || !selected) return null;
    context.preferences.codexExecutablePath = selected;
    context.codex.setConfiguredPath(selected);
    await context.savePreferences();
    return context.codex.refresh();
  });
  handle(IPC.codexLogin, async () => {
    const url = await context.codex.login();
    if (!isAllowedLoginUrl(url)) throw new Error('EXTERNAL_URL_NOT_ALLOWED');
    await shell.openExternal(url);
  });
  const streams = new Map<string, { sessionId: string; text: string }>();
  const finalizedTasks = new Set<string>();
  const finishTaskOnce = (
    taskId: string,
    state: string,
    errorCode: string | null = null,
    message: string | null = null,
  ): void => {
    if (finalizedTasks.has(taskId)) return;
    finalizedTasks.add(taskId);
    // Keep this guard bounded for long-lived app sessions.
    if (finalizedTasks.size > 2048) {
      const oldest = finalizedTasks.values().next().value;
      if (typeof oldest === 'string') finalizedTasks.delete(oldest);
    }
    context.database?.finishTask(taskId, state, errorCode, message);
  };
  context.codex.on('event', (event: CodexEvent) => {
    if (event.type === 'delta' && event.taskId) {
      const stream = streams.get(event.taskId);
      if (stream && event.text) stream.text += event.text;
    }
    if ((event.type === 'complete' || event.type === 'error') && event.taskId) {
      const stream = streams.get(event.taskId);
      if (stream) {
        if (event.type === 'complete' && event.text !== undefined) stream.text = event.text;
        const interrupted = event.errorCode === 'CODEX_TURN_INTERRUPTED';
        context.database?.addMessage(
          stream.sessionId,
          'assistant',
          stream.text,
          event.type === 'complete' ? 'complete' : interrupted ? 'interrupted' : 'failed',
        );
        finishTaskOnce(
          event.taskId,
          event.type === 'complete' ? 'completed' : interrupted ? 'interrupted' : 'failed',
          event.errorCode ?? null,
          event.message ?? null,
        );
        streams.delete(event.taskId);
      }
    }
    context.mainWindow?.webContents.send(IPC.codexEvent, event);
  });
  handle(IPC.codexTurn, async (input) => {
    const value = codexTurnSchema.parse(input);
    const db = context.requireDatabase();
    const session = db.listChats().find((item) => item.id === value.sessionId);
    if (!session) throw new Error('CHAT_NOT_FOUND');
    const sessionType = value.intent === 'chat' ? 'chat' : 'report';
    if (
      (value.intent === 'chat' && session.kind !== 'general') ||
      (value.intent !== 'chat' && (!session.reportId || session.kind !== 'report'))
    )
      throw new Error('AI_SESSION_INVALID');
    const paths = context.requirePaths();
    const reportRoot = session.reportId ? path.join(paths.reports, session.reportId) : null;
    const cwd =
      value.intent === 'chat' ? path.join(paths.chats, session.id, 'agent-work') : reportRoot!;
    // Keep report evidence/source directories readable through cwd, but allow
    // Codex writes only in a dedicated output directory.
    const writableRoot =
      value.intent === 'chat' ? undefined : path.join(reportRoot!, 'agent-work', 'output');
    const taskId = db.beginTask(sessionType, value.sessionId, 'turn');
    if (sessionType === 'chat' || sessionType === 'report')
      db.addMessage(value.sessionId, 'user', value.displayText ?? 'AI 작업 요청', 'complete');
    // Register before the first await: a very fast app-server can complete a
    // turn before startTurn() resolves, and its terminal event must still close
    // the task and persist the assistant message exactly once.
    streams.set(taskId, { sessionId: value.sessionId, text: '' });
    try {
      await verifyWorkspacePath(paths, cwd, { rejectSymlink: true });
      if (writableRoot) {
        await mkdir(writableRoot, { recursive: true });
        await verifyWorkspacePath(paths, writableRoot, { rejectSymlink: true });
      }
      const config = resolveTurnConfig(context.codex.snapshot, session, value.model, value.effort);
      const result = await context.codex.startTurn({
        taskId,
        sessionId: value.sessionId,
        prompt: value.prompt,
        cwd,
        ...(writableRoot ? { writableRoot } : {}),
        threadId: session.codexThreadId,
        model: config.model,
        effort: config.effort,
        outputSchema: outputSchemaFor(
          value.intent,
          session.reportId ? db.listSources(session.reportId).map((source) => source.sourceId) : [],
        ),
        writable: value.intent !== 'chat',
      });
      db.setThread(value.sessionId, result.threadId);
      return { taskId };
    } catch (error) {
      streams.delete(taskId);
      const errorCode =
        error instanceof Error && /^CODEX_[A-Z0-9_]+$/.test(error.message)
          ? error.message
          : 'CODEX_EXECUTION_FAILED';
      finishTaskOnce(taskId, 'failed', errorCode, 'AI 작업을 시작할 수 없습니다.');
      throw error;
    }
  });
  handle(IPC.codexCancel, (input) => {
    const value = codexCancelSchema.parse(input ?? {});
    return context.codex.cancel(value.taskId, value.sessionId);
  });
  handle(IPC.externalOpen, async (input) => {
    const { purpose } = externalPurposeSchema.parse(input);
    await shell.openExternal(EXTERNAL_URLS[purpose]);
  });
  handle(IPC.clipboardWrite, (input) => clipboard.writeText(textSchema.parse(input).text));
  handle(IPC.diagnosticCopy, () => {
    const snapshot = context.codex.snapshot;
    const diagnostic = {
      state: snapshot.state,
      installed: snapshot.installed,
      version: snapshot.version,
      appServerSupported: snapshot.appServerSupported,
      authenticated: snapshot.authenticated,
      planType: snapshot.planType,
      lastCheckedAt: snapshot.lastCheckedAt,
      errorCode: snapshot.actionableErrorCode,
      workspaceConfigured: Boolean(context.workspacePaths),
    };
    clipboard.writeText(JSON.stringify(diagnostic, null, 2));
  });
}

const EXTERNAL_URLS = {
  codexCliDocs: 'https://developers.openai.com/codex/cli',
} as const;

function authorizeSender(event: IpcMainInvokeEvent, context: ApplicationContext): void {
  const mainWindow = context.mainWindow;
  if (!isAuthorizedIpcSender(event, mainWindow)) throw new Error('IPC_UNAUTHORIZED');
}

function isAllowedLoginUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      (parsed.hostname === 'auth.openai.com' || parsed.hostname === 'chatgpt.com')
    );
  } catch {
    return false;
  }
}

function pruneExpiredSelections(
  selections: Map<string, { path: string; expiresAt: number }>,
  now: number,
): void {
  for (const [selectionId, entry] of selections) {
    if (entry.expiresAt <= now) selections.delete(selectionId);
  }
}

/** Resolve renderer hints against Main-owned session settings and live catalog. */
function resolveTurnConfig(
  snapshot: ProviderSnapshot,
  session: ChatSession,
  requestedModel: string | null,
  requestedEffort: string | null,
): { model: string; effort: string | null } {
  const modelId = session.model ?? requestedModel ?? snapshot.selectedModel;
  if (!modelId) throw new Error('CODEX_MODEL_UNSUPPORTED');
  const model = snapshot.availableModels.find((candidate) => candidate.id === modelId);
  if (!model) throw new Error('CODEX_MODEL_UNSUPPORTED');

  const effort = session.reasoningEffort ?? requestedEffort ?? model.defaultReasoningEffort;
  if (effort !== null && !model.reasoningEfforts.includes(effort))
    throw new Error('CODEX_EFFORT_UNSUPPORTED');
  return { model: model.id, effort };
}

function toPublicReport(report: Report): PublicReport {
  const publicReport = { ...report } as Partial<Report>;
  delete publicReport.contentPath;
  delete publicReport.editorStatePath;
  return publicReport as PublicReport;
}

function toPublicSource(source: SourceManifestEntry): PublicSourceManifestEntry {
  const publicSource = { ...source } as Partial<SourceManifestEntry>;
  delete publicSource.storedPath;
  delete publicSource.extractedPath;
  return publicSource as PublicSourceManifestEntry;
}

function toPublicRevision(
  revision: Awaited<
    ReturnType<NonNullable<ApplicationContext['database']>['listRevisions']>
  >[number],
): PublicRevision {
  const publicRevision = { ...revision } as Partial<typeof revision>;
  delete publicRevision.snapshotPath;
  return publicRevision as PublicRevision;
}

export function unregisterIpc(): void {
  for (const channel of registered) ipcMain.removeHandler(channel);
  registered.length = 0;
}
async function bootstrap(context: ApplicationContext): Promise<BootstrapState> {
  return {
    workspacePath: context.preferences.workspacePath,
    consentAccepted: context.preferences.consentAccepted,
    reports: context.database?.listReports(false, '', 'updated') ?? [],
    chats: context.database?.listChats() ?? [],
    personas: context.database?.listPersonas() ?? [],
    provider: context.codex.snapshot,
  };
}
