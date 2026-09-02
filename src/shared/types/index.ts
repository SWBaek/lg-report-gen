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
}
export interface Revision {
  id: string;
  reportId: string;
  snapshotPath: string;
  reason: string;
  description: string;
  baseContentHash: string;
  createdAt: string;
}
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
