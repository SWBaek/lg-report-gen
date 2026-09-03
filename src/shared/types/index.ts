import type { z } from 'zod';
import type { reportOutputOptionsSchema } from '../schemas/index.js';

export type ReportOutputOptions = z.infer<typeof reportOutputOptionsSchema>;
export type ProviderState =
  | 'unknown'
  | 'checking'
  | 'missing'
  | 'incompatible'
  | 'unauthenticated'
  | 'starting'
  | 'ready'
  | 'busy'
  | 'reconnecting'
  | 'error'
  | 'stopped';
export interface ModelInfo {
  id: string;
  displayName: string;
  isDefault: boolean;
  defaultReasoningEffort: string | null;
  reasoningEfforts: string[];
  supportsImages: boolean;
}
export interface ProviderSnapshot {
  state: ProviderState;
  installed: boolean;
  resolvedExecutablePath: string | null;
  version: string | null;
  appServerSupported: boolean;
  authenticated: boolean | null;
  authenticationState: 'authenticated' | 'unauthenticated' | 'unknown';
  maskedAccount: string | null;
  planType: string | null;
  selectedModel: string | null;
  availableModels: ModelInfo[];
  lastCheckedAt: string | null;
  actionableErrorCode: string | null;
  actionableMessage: string | null;
}
export interface ReportSummary {
  id: string;
  title: string;
  purpose: string;
  layoutMode: 'a4' | 'web';
  isFavorite: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
export interface Report extends ReportSummary {
  personaId: string | null;
  personaConfig: string;
  outputOptions: ReportOutputOptions;
  contentPath: string;
  editorStatePath: string;
  currentRevisionId: string | null;
  codexThreadId: string | null;
  html: string;
  editorJson: unknown;
  /** SHA-256 of the sanitized HTML projection of the canonical editor JSON. */
  htmlProjectionHash: string;
  /** Version of the Tiptap document envelope stored on disk. */
  canonicalSchemaVersion: number;
  /** Most recent AI generation provenance, if this report was AI generated. */
  latestGeneration: ReportGenerationRecord | null;
}
/** Renderer-facing report shape; filesystem locations stay in Main. */
export type PublicReport = Omit<Report, 'contentPath' | 'editorStatePath'>;
export interface Revision {
  id: string;
  reportId: string;
  snapshotPath: string;
  reason: string;
  description: string;
  baseContentHash: string;
  createdAt: string;
  /** Versioned snapshot envelope metadata. */
  schemaVersion: number;
  editorJson: unknown;
  html: string;
  title: string;
  purpose: string;
  outputOptions: ReportOutputOptions;
  layoutMode: 'a4' | 'web';
  htmlProjectionHash: string;
  editorJsonHash: string;
}
/** Renderer-facing revision shape; snapshots are internal files. */
export type PublicRevision = Omit<Revision, 'snapshotPath'>;
export interface Persona {
  id: string;
  name: string;
  description: string;
  instructions: string;
  isBuiltIn: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface SourceManifestEntry {
  sourceId: string;
  originalName: string;
  storedPath: string;
  mimeType: string;
  size: number;
  sha256: string;
  extractionStatus: 'pending' | 'extracting' | 'ready' | 'partial' | 'failed';
  extractedPath: string | null;
  metadata: Record<string, unknown>;
  warnings: string[];
  createdAt: string;
}
/** Renderer-facing source shape; imported file locations stay in Main. */
export type PublicSourceManifestEntry = Omit<SourceManifestEntry, 'storedPath' | 'extractedPath'>;
export interface SourceSelection {
  selectionId: string;
  originalName: string;
}
export interface SourceUsage {
  sourceId: string;
  locator: string;
  claimSummary: string;
}
export interface ClaimEvidence {
  claim: string;
  sourceId: string;
  locator: string;
  evidenceExcerpt?: string | undefined;
}
export interface ReportGenerationRecord {
  id: string;
  reportId: string;
  schemaVersion: number;
  executiveSummary: string;
  sourceUsage: SourceUsage[];
  assumptions: string[];
  warnings: string[];
  model: string | null;
  promptVersion: string;
  sourceSnapshotHashes: Record<string, string>;
  claimEvidence: ClaimEvidence[];
  createdAt: string;
}
export interface DeletionRetention {
  id: string;
  ownerType: 'report' | 'chat';
  ownerId: string;
  codexThreadIds: string[];
  pendingThreadIds: string[];
  localState: 'deleted' | 'failed';
  codexState: 'deleted' | 'pending' | 'none';
  createdAt: string;
  updatedAt: string;
}
export interface ChatSession {
  id: string;
  title: string;
  kind: 'general' | 'report';
  reportId: string | null;
  codexThreadId: string | null;
  model: string | null;
  reasoningEffort: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
export interface ChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  state: 'streaming' | 'complete' | 'failed' | 'interrupted';
  createdAt: string;
}
export interface BootstrapState {
  workspacePath: string | null;
  consentAccepted: boolean;
  reports: ReportSummary[];
  chats: ChatSession[];
  personas: Persona[];
  provider: ProviderSnapshot;
}
export interface CodexEvent {
  type: 'delta' | 'complete' | 'error' | 'state' | 'login';
  taskId?: string;
  sessionId?: string;
  text?: string;
  snapshot?: ProviderSnapshot;
  errorCode?: string;
  message?: string;
}
