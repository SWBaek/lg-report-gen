import { app } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const DEV_RENDERER_ENV = 'ELECTRON_RENDERER_URL';

export interface IpcRendererFrameLike {
  url: string;
}

export interface IpcRendererSenderLike {
  mainFrame: IpcRendererFrameLike;
}

export interface IpcSenderEventLike {
  sender: IpcRendererSenderLike;
  senderFrame: IpcRendererFrameLike | null;
}

/** Only a local development server may replace the packaged renderer. */
export function rendererUrlFromEnvironment(): string | null {
  if (app.isPackaged) return null;
  const candidate = process.env[DEV_RENDERER_ENV];
  if (!candidate || !isLoopbackUrl(candidate)) return null;
  return candidate;
}

export function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1' ||
        url.hostname === '[::1]' ||
        url.hostname === '::1')
    );
  } catch {
    return false;
  }
}

/**
 * The URL check is intentionally independent of navigation policy. It protects
 * IPC handlers if a renderer is ever navigated by a future code path.
 */
export function isTrustedRendererUrl(value: string): boolean {
  const configured = rendererUrlFromEnvironment();
  if (configured) {
    try {
      return new URL(value).origin === new URL(configured).origin;
    } catch {
      return false;
    }
  }
  if (!value.startsWith('file://')) return false;
  try {
    const expected = pathToFileURL(path.join(__dirname, '../renderer/index.html'));
    return path.resolve(fileURLToPath(value)) === path.resolve(fileURLToPath(expected));
  } catch {
    return false;
  }
}

/**
 * Authorize an IPC invocation from the one renderer frame owned by the main
 * application window.  Keeping this check as a pure seam makes it possible
 * to exercise the negative paths without constructing an Electron window in
 * unit tests.
 */
export function isAuthorizedIpcSender(
  event: IpcSenderEventLike,
  mainWindow: { webContents: IpcRendererSenderLike } | null,
  trustedUrl: (value: string) => boolean = isTrustedRendererUrl,
): boolean {
  const senderFrame = event.senderFrame;
  return Boolean(
    mainWindow &&
    event.sender === mainWindow.webContents &&
    senderFrame &&
    senderFrame === event.sender.mainFrame &&
    trustedUrl(senderFrame.url),
  );
}
