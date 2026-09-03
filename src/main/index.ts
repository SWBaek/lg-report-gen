import { app, BrowserWindow, session, screen } from 'electron';
import path from 'node:path';
import { ApplicationContext } from './app/context.js';
import { registerIpc, unregisterIpc } from './ipc/register.js';
import { rendererUrlFromEnvironment } from './security/renderer.js';

// The test-only userData override is never honored by a packaged build.
if (!app.isPackaged && process.env.LG_REPORT_AGENT_E2E_USER_DATA) {
  app.setPath('userData', process.env.LG_REPORT_AGENT_E2E_USER_DATA);
}
const context = new ApplicationContext();
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (context.mainWindow) {
      if (context.mainWindow.isMinimized()) context.mainWindow.restore();
      context.mainWindow.focus();
    }
  });
  app.whenReady().then(async () => {
    await context.initialize();
    registerIpc(context);
    createWindow();
    void context.codex.refresh();
  });
}
function createWindow(): void {
  const bounds = visibleBounds(context.preferences.windowBounds);
  const window = new BrowserWindow({
    title: 'LG Report Agent',
    ...bounds,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    backgroundColor: '#f7f5f4',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  context.mainWindow = window;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) =>
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",
        ],
      },
    }),
  );
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL();
    if (url !== current) event.preventDefault();
  });
  window.on('ready-to-show', () => window.show());
  window.on('close', () => {
    const value = window.getBounds();
    context.preferences.windowBounds = value;
    void context.savePreferences();
  });
  window.on('closed', () => {
    context.mainWindow = null;
  });
  const rendererUrl = rendererUrlFromEnvironment();
  if (rendererUrl) void window.loadURL(rendererUrl);
  else void window.loadFile(path.join(__dirname, '../renderer/index.html'));
}
function visibleBounds(saved: { x?: number; y?: number; width: number; height: number }): {
  x?: number;
  y?: number;
  width: number;
  height: number;
} {
  const width = Math.max(1180, saved.width || 1440);
  const height = Math.max(720, saved.height || 900);
  if (saved.x === undefined || saved.y === undefined) return { width, height };
  const visible = screen
    .getAllDisplays()
    .some(
      (display) =>
        saved.x! >= display.bounds.x - 100 &&
        saved.x! <= display.bounds.x + display.bounds.width - 100 &&
        saved.y! >= display.bounds.y - 100 &&
        saved.y! <= display.bounds.y + display.bounds.height - 100,
    );
  return visible ? { x: saved.x, y: saved.y, width, height } : { width, height };
}
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  unregisterIpc();
  void context.dispose();
});
