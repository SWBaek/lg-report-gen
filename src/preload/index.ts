import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/constants/ipc.js';
import type { CodexEvent } from '../shared/types/index.js';
import type { DesktopApi } from '../shared/contracts/api.js';

const invoke = <T>(channel: string, input?: unknown): Promise<T> =>
  ipcRenderer.invoke(channel, input) as Promise<T>;
const codexListeners = new Set<(event: CodexEvent) => void>();
let codexTurnPending = false;
const deferredCodexEvents: CodexEvent[] = [];
const dispatchCodexEvent = (event: CodexEvent): void => {
  if (codexTurnPending) {
    // Main may receive a completion before the turn IPC response gives the
    // renderer its taskId. Hold the bounded turn burst until that response.
    if (deferredCodexEvents.length < 256) deferredCodexEvents.push(event);
    else if (event.type === 'complete' || event.type === 'error') {
      const index = deferredCodexEvents.findIndex(
        (candidate) => candidate.type !== 'complete' && candidate.type !== 'error',
      );
      if (index >= 0) deferredCodexEvents.splice(index, 1, event);
    }
    return;
  }
  for (const listener of codexListeners) listener(event);
};
const flushDeferredCodexEvents = (): void => {
  const events = deferredCodexEvents.splice(0);
  for (const event of events) dispatchCodexEvent(event);
};
ipcRenderer.on(IPC.codexEvent, (_event, value: CodexEvent) => dispatchCodexEvent(value));
const api: DesktopApi = {
  bootstrap: { get: () => invoke(IPC.bootstrapGet), acceptConsent: () => invoke(IPC.appConsent) },
  workspace: {
    choose: () => invoke(IPC.workspaceChoose),
    switch: (path) => invoke(IPC.workspaceSwitch, { path }),
    open: () => invoke(IPC.workspaceOpen),
  },
  reports: {
    list: (input) => invoke(IPC.reportsList, input),
    create: (input) => invoke(IPC.reportCreate, input),
    get: (id) => invoke(IPC.reportGet, { id }),
    save: (input) => invoke(IPC.reportSave, input),
    rename: (id, title) => invoke(IPC.reportRename, { id, title }),
    favorite: (id, value) => invoke(IPC.reportFavorite, { id, value }),
    duplicate: (id) => invoke(IPC.reportDuplicate, { id }),
    trash: (id) => invoke(IPC.reportTrash, { id }),
    restore: (id) => invoke(IPC.reportRestore, { id }),
    delete: (id) => invoke(IPC.reportDelete, { id }),
    exportPreflight: (id, format = 'html') => invoke(IPC.reportExportPreflight, { id, format }),
    export: (id, format = 'html', approvalToken) =>
      invoke(IPC.reportExport, { id, format, ...(approvalToken ? { approvalToken } : {}) }),
    generations: (reportId) => invoke(IPC.reportGenerationsList, { reportId }),
    claims: (reportId) => invoke(IPC.reportClaimsList, { reportId }),
  },
  revisions: {
    list: (reportId) => invoke(IPC.revisionsList, { id: reportId }),
    create: (reportId, reason, description) =>
      invoke(IPC.revisionCreate, { reportId, reason, description }),
    restore: (reportId, revisionId) => invoke(IPC.revisionRestore, { reportId, revisionId }),
  },
  personas: {
    list: () => invoke(IPC.personasList),
    save: (input) => invoke(IPC.personaSave, input),
    delete: (id) => invoke(IPC.personaDelete, { id }),
  },
  sources: {
    import: (reportId, selectionIds) => invoke(IPC.sourcesImport, { reportId, selectionIds }),
    list: (reportId) => invoke(IPC.sourcesList, { id: reportId }),
    choose: () => invoke(IPC.fileChoose),
  },
  chats: {
    list: () => invoke(IPC.chatsList),
    create: (title = '새 대화', reportId = null) => invoke(IPC.chatCreate, { title, reportId }),
    rename: (id, title) => invoke(IPC.chatRename, { id, title }),
    updateAiSettings: (id, model, reasoningEffort) =>
      invoke(IPC.chatAiSettings, { id, model, reasoningEffort }),
    delete: (id) => invoke(IPC.chatDelete, { id }),
    messages: (sessionId) => invoke(IPC.messagesList, { sessionId }),
  },
  deletionRetention: {
    list: (ownerId) => invoke(IPC.deletionRetentionList, ownerId ? { id: ownerId } : {}),
    retry: (id) => invoke(IPC.deletionRetentionRetry, { id }),
  },
  codex: {
    refresh: () => invoke(IPC.codexRefresh),
    browse: () => invoke(IPC.codexBrowse),
    login: () => invoke(IPC.codexLogin),
    turn: async (input) => {
      codexTurnPending = true;
      try {
        return await invoke<{ taskId: string }>(IPC.codexTurn, input);
      } finally {
        // Let the caller's await continuation store taskId before replaying
        // events. A microtask here can still run before that continuation.
        setTimeout(() => {
          codexTurnPending = false;
          flushDeferredCodexEvents();
        }, 0);
      }
    },
    cancel: (input) => invoke(IPC.codexCancel, input ?? {}),
    onEvent: (listener) => {
      codexListeners.add(listener);
      return () => {
        codexListeners.delete(listener);
      };
    },
  },
  system: {
    openExternal: (purpose) => invoke(IPC.externalOpen, { purpose }),
    copy: (text) => invoke(IPC.clipboardWrite, { text }),
    diagnosticCopy: () => invoke(IPC.diagnosticCopy),
  },
};
contextBridge.exposeInMainWorld('lgReportAgent', api);
