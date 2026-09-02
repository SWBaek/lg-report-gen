import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { AppDatabase } from '../database/database.js';
import { CodexAppServerManager } from '../codex/app-server-manager.js';
import { SourceImporter } from '../importers/source-importer.js';
import { atomicWrite, readJson } from '../services/files.js';
import { ensureWorkspace, type WorkspacePaths } from '../workspace/manager.js';

interface BootstrapPreferences {
  workspacePath: string | null;
  consentAccepted: boolean;
  codexExecutablePath: string | null;
  windowBounds: { x?: number; y?: number; width: number; height: number };
  sandboxMode: 'workspace-write' | 'read-only';
}
const DEFAULTS: BootstrapPreferences = {
  workspacePath: null,
  consentAccepted: false,
  codexExecutablePath: null,
  windowBounds: { width: 1440, height: 900 },
  sandboxMode: 'workspace-write',
};

export class ApplicationContext {
  database: AppDatabase | null = null;
  workspacePaths: WorkspacePaths | null = null;
  sourceImporter: SourceImporter | null = null;
  readonly codex = new CodexAppServerManager();
  preferences: BootstrapPreferences = structuredClone(DEFAULTS);
  mainWindow: BrowserWindow | null = null;
  private get preferencePath(): string {
    return path.join(app.getPath('userData'), 'bootstrap.json');
  }
  async initialize(): Promise<void> {
    this.preferences = {
      ...DEFAULTS,
      ...(await readJson<Partial<BootstrapPreferences>>(this.preferencePath, {})),
    };
    this.codex.setConfiguredPath(this.preferences.codexExecutablePath);
    if (this.preferences.workspacePath) {
      try {
        await this.switchWorkspace(this.preferences.workspacePath);
      } catch {
        this.preferences.workspacePath = null;
        await this.savePreferences();
      }
    }
  }
  async switchWorkspace(root: string): Promise<void> {
    const paths = await ensureWorkspace(root);
    const next = new AppDatabase(paths);
    await next.open();
    this.database?.close();
    this.database = next;
    this.workspacePaths = paths;
    this.sourceImporter = new SourceImporter(paths);
    this.preferences.workspacePath = paths.root;
    await this.savePreferences();
    await this.codex.stop();
    void this.codex.refresh();
  }
  requireDatabase(): AppDatabase {
    if (!this.database) throw new Error('WORKSPACE_NOT_SELECTED');
    return this.database;
  }
  requirePaths(): WorkspacePaths {
    if (!this.workspacePaths) throw new Error('WORKSPACE_NOT_SELECTED');
    return this.workspacePaths;
  }
  async savePreferences(): Promise<void> {
    await atomicWrite(this.preferencePath, JSON.stringify(this.preferences, null, 2));
  }
  async acceptConsent(): Promise<void> {
    this.preferences.consentAccepted = true;
    await this.savePreferences();
  }
  async dispose(): Promise<void> {
    this.database?.close();
    await this.codex.stop();
  }
}
