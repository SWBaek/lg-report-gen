import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/constants/ipc.js';
import type { CodexEvent } from '../shared/types/index.js';
import type { DesktopApi } from '../shared/contracts/api.js';

const invoke = <T>(channel: string, input?: unknown): Promise<T> =>
  ipcRenderer.invoke(channel, input) as Promise<T>;
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
    export: (id) => invoke(IPC.reportExport, { id }),
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
    import: (reportId, paths) => invoke(IPC.sourcesImport, { reportId, paths }),
    list: (reportId) => invoke(IPC.sourcesList, { id: reportId }),
    choose: () => invoke(IPC.fileChoose),
  },
  chats: {
    list: () => invoke(IPC.chatsList),
    create: (title = '새 대화', reportId = null) => invoke(IPC.chatCreate, { title, reportId }),
    rename: (id, title) => invoke(IPC.chatRename, { id, title }),
    delete: (id) => invoke(IPC.chatDelete, { id }),
    messages: (sessionId) => invoke(IPC.messagesList, { sessionId }),
  },
  codex: {
    refresh: () => invoke(IPC.codexRefresh),
    browse: () => invoke(IPC.codexBrowse),
    login: () => invoke(IPC.codexLogin),
    turn: (input) => invoke(IPC.codexTurn, input),
    cancel: () => invoke(IPC.codexCancel),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, value: CodexEvent): void =>
        listener(value);
      ipcRenderer.on(IPC.codexEvent, handler);
      return () => ipcRenderer.removeListener(IPC.codexEvent, handler);
    },
  },
  system: {
    openExternal: (url) => invoke(IPC.externalOpen, { url }),
    copy: (text) => invoke(IPC.clipboardWrite, { text }),
    diagnosticCopy: () => invoke(IPC.diagnosticCopy),
  },
};
contextBridge.exposeInMainWorld('lgReportAgent', api);
