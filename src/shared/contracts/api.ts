import type {
  BootstrapState,
  ChatMessage,
  ChatSession,
  CodexEvent,
  Persona,
  ProviderSnapshot,
  PublicReport,
  ReportSummary,
  PublicRevision,
  PublicSourceManifestEntry,
  SourceSelection,
  ReportGenerationRecord,
  ClaimEvidence,
  DeletionRetention,
} from '../types/index.js';
export type ExportFormat = 'html' | 'pdf';
export type ExportWarningCode =
  | 'EXTERNAL_ASSET'
  | 'MISSING_ASSET'
  | 'UNSUPPORTED_IMAGE'
  | 'INVALID_IMAGE_MIME'
  | 'EMBEDDED_ASSET_TOO_LARGE'
  | 'PAGE_OVERFLOW_POSSIBLE';
export interface ExportWarning {
  code: ExportWarningCode;
  message: string;
  asset?: string;
}
export interface ExportPreflight {
  reportId: string;
  format: ExportFormat;
  warnings: ExportWarning[];
  canExport: boolean;
  reservationToken: string;
  expiresAt: string;
}

export type CodexTurnIntent = 'chat' | 'plan' | 'generate' | 'revise';
export interface CodexTurnInput {
  intent: CodexTurnIntent;
  sessionId: string;
  prompt: string;
  displayText?: string;
  model?: string | null;
  effort?: string | null;
}

export interface CodexCancelInput {
  taskId?: string;
  sessionId?: string;
}

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
    create(input: unknown): Promise<PublicReport>;
    get(id: string): Promise<PublicReport>;
    save(input: unknown): Promise<PublicReport>;
    rename(id: string, title: string): Promise<void>;
    favorite(id: string, value: boolean): Promise<void>;
    duplicate(id: string): Promise<PublicReport>;
    trash(id: string): Promise<void>;
    restore(id: string): Promise<void>;
    delete(id: string): Promise<{ threadDeleteFailed: boolean }>;
    exportPreflight(id: string, format?: ExportFormat): Promise<ExportPreflight>;
    export(id: string, format?: ExportFormat, approvalToken?: string): Promise<string | null>;
    generations(reportId: string): Promise<ReportGenerationRecord[]>;
    claims(reportId: string): Promise<ClaimEvidence[]>;
  };
  revisions: {
    list(reportId: string): Promise<PublicRevision[]>;
    create(reportId: string, reason: string, description: string): Promise<PublicRevision>;
    restore(reportId: string, revisionId: string): Promise<PublicReport>;
  };
  personas: {
    list(): Promise<Persona[]>;
    save(input: unknown): Promise<Persona>;
    delete(id: string): Promise<{ threadDeleteFailed: boolean }>;
  };
  deletionRetention: {
    list(ownerId?: string): Promise<DeletionRetention[]>;
    retry(id: string): Promise<DeletionRetention>;
  };
  sources: {
    import(reportId: string, selectionIds: string[]): Promise<PublicSourceManifestEntry[]>;
    list(reportId: string): Promise<PublicSourceManifestEntry[]>;
    choose(): Promise<SourceSelection[]>;
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
    turn(input: CodexTurnInput): Promise<{ taskId: string }>;
    cancel(input?: CodexCancelInput): Promise<void>;
    onEvent(listener: (event: CodexEvent) => void): () => void;
  };
  system: {
    openExternal(purpose: 'codexCliDocs'): Promise<void>;
    copy(text: string): Promise<void>;
    diagnosticCopy(): Promise<void>;
  };
}

declare global {
  interface Window {
    lgReportAgent: DesktopApi;
  }
}
