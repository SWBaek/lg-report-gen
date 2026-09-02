import { clipboard, dialog, ipcMain, shell } from 'electron';
import { IPC, IPC_ALLOWLIST } from '../../shared/constants/ipc.js';
import {
  chatCreateSchema,
  codexTurnSchema,
  createReportSchema,
  externalUrlSchema,
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
} from '../../shared/schemas/index.js';
import type { BootstrapState, CodexEvent } from '../../shared/types/index.js';
import type { ApplicationContext } from '../app/context.js';
import { exportReportHtml } from '../exporters/html-exporter.js';

const registered: string[] = [];
export function registerIpc(context: ApplicationContext): void {
  const handle = <T>(channel: string, listener: (input: unknown) => Promise<T> | T): void => {
    if (!IPC_ALLOWLIST.has(channel)) throw new Error(`IPC_NOT_ALLOWED:${channel}`);
    ipcMain.handle(channel, (_event, input) => listener(input));
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
    context.requireDatabase().createReport(createReportSchema.parse(input)),
  );
  handle(IPC.reportGet, (input) =>
    context.requireDatabase().getReport(reportIdSchema.parse(input).id),
  );
  handle(IPC.reportSave, (input) =>
    context.requireDatabase().saveReport(saveReportSchema.parse(input)),
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
    context.requireDatabase().duplicateReport(reportIdSchema.parse(input).id),
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
    let threadDeleteFailed = false;
    if (report.codexThreadId) {
      try {
        await context.codex.deleteThread(report.codexThreadId);
      } catch {
        threadDeleteFailed = true;
      }
    }
    await context.requireDatabase().deleteReport(id);
    return { threadDeleteFailed };
  });
  handle(IPC.reportExport, async (input) => {
    const report = await context.requireDatabase().getReport(reportIdSchema.parse(input).id);
    return exportReportHtml(report, context.requirePaths().exports);
  });
  handle(IPC.revisionCreate, (input) => {
    const value = revisionCreateSchema.parse(input);
    return context
      .requireDatabase()
      .createRevision(value.reportId, value.reason, value.description);
  });
  handle(IPC.revisionsList, (input) =>
    context.requireDatabase().listRevisions(reportIdSchema.parse(input).id),
  );
  handle(IPC.revisionRestore, (input) => {
    const value = revisionRestoreSchema.parse(input);
    return context.requireDatabase().restoreRevision(value.reportId, value.revisionId);
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
    return result.canceled ? [] : result.filePaths;
  });
  handle(IPC.sourcesImport, async (input) => {
    const value = importSourcesSchema.parse(input);
    const sources = await context.sourceImporter!.import(value.reportId, value.paths);
    for (const source of sources) context.requireDatabase().saveSource(value.reportId, source);
    return sources;
  });
  handle(IPC.sourcesList, (input) =>
    context.requireDatabase().listSources(reportIdSchema.parse(input).id),
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
  handle(IPC.chatDelete, (input) =>
    context.requireDatabase().deleteChat(reportIdSchema.parse(input).id),
  );
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
    await shell.openExternal(url);
  });
  const streams = new Map<string, { sessionId: string; text: string }>();
  context.codex.on('event', (event: CodexEvent) => {
    if (event.type === 'delta' && event.taskId) {
      const stream = streams.get(event.taskId);
      if (stream && event.text) stream.text += event.text;
    }
    if ((event.type === 'complete' || event.type === 'error') && event.taskId) {
      const stream = streams.get(event.taskId);
      if (stream) {
        if (event.type === 'complete' && event.text !== undefined) stream.text = event.text;
        context.database?.addMessage(
          stream.sessionId,
          'assistant',
          stream.text,
          event.type === 'complete' ? 'complete' : 'failed',
        );
        context.database?.finishTask(
          event.taskId,
          event.type === 'complete' ? 'completed' : 'failed',
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
    const taskId = db.beginTask(value.sessionType, value.sessionId, 'turn');
    if (value.sessionType === 'chat' || value.sessionType === 'report')
      db.addMessage(value.sessionId, 'user', value.displayText ?? 'AI 작업 요청', 'complete');
    try {
      const result = await context.codex.startTurn({ ...value, taskId });
      if (value.sessionType === 'chat' || value.sessionType === 'report') {
        db.setThread(value.sessionId, result.threadId);
        streams.set(taskId, { sessionId: value.sessionId, text: '' });
      }
      return { taskId };
    } catch (error) {
      db.finishTask(taskId, 'failed', 'CODEX_EXECUTION_FAILED', 'AI 작업을 시작할 수 없습니다.');
      throw error;
    }
  });
  handle(IPC.codexCancel, () => context.codex.cancel());
  handle(IPC.externalOpen, async (input) => {
    const { url } = externalUrlSchema.parse(input);
    await shell.openExternal(url);
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
