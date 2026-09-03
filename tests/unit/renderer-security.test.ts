import { app } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isAuthorizedIpcSender,
  isLoopbackUrl,
  rendererUrlFromEnvironment,
} from '../../src/main/security/renderer.js';

vi.mock('electron', () => ({ app: { isPackaged: false } }));

const previousRendererUrl = process.env.ELECTRON_RENDERER_URL;

afterEach(() => {
  if (previousRendererUrl === undefined) delete process.env.ELECTRON_RENDERER_URL;
  else process.env.ELECTRON_RENDERER_URL = previousRendererUrl;
  (app as unknown as { isPackaged: boolean }).isPackaged = false;
});

describe('renderer security policy', () => {
  function eventFor(sender: { mainFrame: { url: string } }, senderFrame = sender.mainFrame) {
    return { sender, senderFrame } as Parameters<typeof isAuthorizedIpcSender>[0];
  }

  it('authorizes only the registered window main frame at a trusted URL', () => {
    const mainFrame = { url: 'https://localhost:4173/index.html' };
    const sender = { mainFrame };
    const trustedUrl = vi.fn((value: string) => value.startsWith('https://localhost:4173/'));

    expect(isAuthorizedIpcSender(eventFor(sender), { webContents: sender }, trustedUrl)).toBe(true);
    expect(trustedUrl).toHaveBeenCalledWith(mainFrame.url);
  });

  it('rejects an unregistered webContents even when its frame is trusted', () => {
    const mainFrame = { url: 'https://localhost:4173/index.html' };
    const sender = { mainFrame };
    const registeredSender = { mainFrame };

    expect(
      isAuthorizedIpcSender(eventFor(sender), { webContents: registeredSender }, () => true),
    ).toBe(false);
  });

  it('rejects subframes and untrusted or remote URLs', () => {
    const mainFrame = { url: 'https://localhost:4173/index.html' };
    const subframe = { url: 'https://localhost:4173/embedded.html' };
    const sender = { mainFrame };
    const window = { webContents: sender };

    expect(isAuthorizedIpcSender(eventFor(sender, subframe), window, () => true)).toBe(false);
    expect(isAuthorizedIpcSender(eventFor(sender), window, () => false)).toBe(false);
    expect(
      isAuthorizedIpcSender(
        eventFor({ mainFrame: { url: 'https://attacker.example/index.html' } }),
        { webContents: sender },
        () => false,
      ),
    ).toBe(false);
  });

  it('keeps development and packaged origin policy separate', () => {
    process.env.ELECTRON_RENDERER_URL = 'https://localhost:4173';
    (app as unknown as { isPackaged: boolean }).isPackaged = false;
    const devFrame = { url: 'https://localhost:4173/index.html' };
    const devSender = { mainFrame: devFrame };
    expect(isAuthorizedIpcSender(eventFor(devSender), { webContents: devSender })).toBe(true);

    (app as unknown as { isPackaged: boolean }).isPackaged = true;
    const packagedFrame = { url: 'https://localhost:4173/index.html' };
    const packagedSender = { mainFrame: packagedFrame };
    expect(isAuthorizedIpcSender(eventFor(packagedSender), { webContents: packagedSender })).toBe(
      false,
    );
  });

  it('accepts only loopback HTTP(S) development URLs', () => {
    expect(isLoopbackUrl('http://localhost:5173')).toBe(true);
    expect(isLoopbackUrl('https://127.0.0.1:5173/')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:5173')).toBe(true);
    expect(isLoopbackUrl('https://example.com')).toBe(false);
    expect(isLoopbackUrl('file:///tmp/index.html')).toBe(false);
    expect(isLoopbackUrl('javascript:alert(1)')).toBe(false);
  });

  it('ignores a renderer override when the app is packaged', () => {
    process.env.ELECTRON_RENDERER_URL = 'http://127.0.0.1:5173';
    (app as unknown as { isPackaged: boolean }).isPackaged = true;
    expect(rendererUrlFromEnvironment()).toBeNull();
  });

  it('accepts only loopback renderer overrides during development', () => {
    (app as unknown as { isPackaged: boolean }).isPackaged = false;
    process.env.ELECTRON_RENDERER_URL = 'https://localhost:4173';
    expect(rendererUrlFromEnvironment()).toBe('https://localhost:4173');
    process.env.ELECTRON_RENDERER_URL = 'https://attacker.example';
    expect(rendererUrlFromEnvironment()).toBeNull();
  });
});
