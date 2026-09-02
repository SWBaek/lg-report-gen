import type {
  BootstrapState,
  ChatMessage,
  ChatSession,
  CodexEvent,
  Persona,
  ProviderSnapshot,
  Report,
  ReportSummary,
  Revision,
  SourceManifestEntry,
} from '../types/index.js';

export interface DesktopApi {
  bootstrap: { get(): Promise<BootstrapState>; acceptConsent(): Promise<void> };
  workspace: {
    choose(): Promise<string | null>;
    switch(path: string): Promise<BootstrapState>;
    open(): Promise<void>;
  };
  reports: {
    list(input?: {
      includeDeleted?: boolean;
      query?: string;
      sort?: 'updated' | 'title';
    }): Promise<ReportSummary[]>;
    create(input: unknown): Promise<Report>;
    get(id: string): Promise<Report>;
    save(input: unknown): Promise<Report>;
    rename(id: string, title: string): Promise<void>;
    favorite(id: string, value: boolean): Promise<void>;
    duplicate(id: string): Promise<Report>;
    trash(id: string): Promise<void>;
    restore(id: string): Promise<void>;
    delete(id: string): Promise<{ threadDeleteFailed: boolean }>;
    export(id: string): Promise<string | null>;
  };
  revisions: {
    list(reportId: string): Promise<Revision[]>;
    create(reportId: string, reason: string, description: string): Promise<Revision>;
    restore(reportId: string, revisionId: string): Promise<Report>;
  };
  personas: {
    list(): Promise<Persona[]>;
    save(input: unknown): Promise<Persona>;
    delete(id: string): Promise<void>;
  };
  sources: {
    import(reportId: string, paths: string[]): Promise<SourceManifestEntry[]>;
    list(reportId: string): Promise<SourceManifestEntry[]>;
    choose(): Promise<string[]>;
  };
  chats: {
    list(): Promise<ChatSession[]>;
    create(title?: string, reportId?: string | null): Promise<ChatSession>;
    rename(id: string, title: string): Promise<void>;
    updateAiSettings(
      id: string,
      model: string | null,
      reasoningEffort: string | null,
    ): Promise<ChatSession>;
    delete(id: string): Promise<void>;
    messages(sessionId: string): Promise<ChatMessage[]>;
  };
  codex: {
    refresh(): Promise<ProviderSnapshot>;
    browse(): Promise<ProviderSnapshot | null>;
    login(): Promise<void>;
    turn(input: unknown): Promise<{ taskId: string }>;
    cancel(): Promise<void>;
    onEvent(listener: (event: CodexEvent) => void): () => void;
  };
  system: {
    openExternal(url: string): Promise<void>;
    copy(text: string): Promise<void>;
    diagnosticCopy(): Promise<void>;
  };
}

declare global {
  interface Window {
    lgReportAgent: DesktopApi;
  }
}
