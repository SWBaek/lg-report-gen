import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { UtilityProcess } from 'electron';

/** The parser is deliberately a one-shot process: a stuck/crashed parser cannot
 * take down the Electron Main event loop or poison a later import. */
export const PARSER_TIMEOUT_MS = 30_000;
export const MAX_PARSER_RESULT_BYTES = 32 * 1024 * 1024;
const MAX_PATH_CHARS = 4_096;
const parserRequestSchema = z.object({
  inputPath: z.string().min(1).max(MAX_PATH_CHARS),
  extension: z.string().regex(/^\.[a-z0-9]+$/),
  allowedRoot: z.string().min(1).max(MAX_PATH_CHARS),
  assetPath: z.string().max(MAX_PATH_CHARS).optional(),
});
const parserResultSchema = z.object({
  ok: z.literal(true),
  content: z.unknown(),
  metadata: z.record(z.string(), z.unknown()),
  warnings: z.array(z.string()),
  imageAssetCreated: z.boolean().optional(),
});
const parserErrorSchema = z.object({ ok: z.literal(false), error: z.string().max(1_024) });
const parserMessageSchema = z.union([parserResultSchema, parserErrorSchema]);
export type ParserResult = z.infer<typeof parserResultSchema>;
export interface ParserSupervisorOptions {
  workerPath?: string;
  timeoutMs?: number;
  /** Test hook; production callers should leave this at the bounded default. */
  maxResultBytes?: number;
}

interface ParserRequest {
  inputPath: string;
  extension: string;
  allowedRoot: string;
  assetPath?: string;
}

function workerModulePath(): { modulePath: string; execArgv: string[] } {
  // electron-vite bundles the main entry into `out/main/chunks`, while the
  // worker is emitted as the top-level `out/main/parser-worker.js` entry.
  // Resolve that stable packaged location explicitly; import.meta.url points
  // at the chunk and cannot be used to discover sibling entry points.
  if (process.versions.electron && process.resourcesPath) {
    const packagedRoot = path.join(process.resourcesPath, 'app.asar');
    if (existsSync(packagedRoot)) {
      return {
        modulePath: path.join(packagedRoot, 'out', 'main', 'parser-worker.js'),
        execArgv: [],
      };
    }
  }
  const compiled = path.join(path.dirname(fileURLToPath(import.meta.url)), 'parser-worker.js');
  if (existsSync(compiled)) return { modulePath: compiled, execArgv: [] };
  // Vitest executes TypeScript directly. Node 24's type transformer plus this
  // resolver lets the same worker be spawned as a real child process in tests.
  const source = path.join(path.dirname(fileURLToPath(import.meta.url)), 'parser-worker.ts');
  const loader = path.join(path.dirname(source), 'parser-ts-loader.mjs');
  const loaderArg = `./${path.relative(process.cwd(), loader).replaceAll('\\', '/')}`;
  return {
    // fork() passes the module argument through Node's ESM resolver. A
    // relative path avoids treating a Windows `C:\\...` filename as a URL
    // protocol; cwd is the application directory in dev and tests.
    modulePath: path.relative(process.cwd(), source),
    execArgv: ['--experimental-transform-types', '--experimental-loader', loaderArg],
  };
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

export class ParserSupervisor {
  private readonly options: Required<
    Pick<ParserSupervisorOptions, 'timeoutMs' | 'maxResultBytes'>
  > &
    Pick<ParserSupervisorOptions, 'workerPath'>;

  constructor(options: ParserSupervisorOptions = {}) {
    this.options = {
      timeoutMs: options.timeoutMs ?? PARSER_TIMEOUT_MS,
      maxResultBytes: options.maxResultBytes ?? MAX_PARSER_RESULT_BYTES,
      ...(options.workerPath ? { workerPath: options.workerPath } : {}),
    };
  }

  async run(
    inputPath: string,
    extension: string,
    allowedRoot: string,
    assetPath?: string,
    signal?: AbortSignal,
  ): Promise<ParserResult> {
    const root = await realpath(allowedRoot);
    const input = await realpath(inputPath);
    const request: ParserRequest = { inputPath: input, extension, allowedRoot: root };
    if (assetPath) request.assetPath = path.resolve(assetPath);
    if (!isWithin(input, root) || (request.assetPath && !isWithin(request.assetPath, root)))
      throw new Error('PARSER_PATH_NOT_ALLOWED');
    parserRequestSchema.parse(request);
    if (signal?.aborted) throw new Error('PARSER_ABORTED');

    const selected = this.options.workerPath
      ? { modulePath: this.options.workerPath, execArgv: [] }
      : workerModulePath();
    // Electron production binaries intentionally disable RunAsNode. A
    // child_process.fork() therefore starts the full Electron application
    // instead of the worker and eventually times out. utilityProcess.fork()
    // uses Electron's dedicated Node utility helper and remains compatible
    // with the hardened fuse policy. Vitest and plain Node retain the
    // child_process.fork path for isolated worker tests.
    const utility =
      !this.options.workerPath && process.versions.electron
        ? (await import('electron')).utilityProcess
        : undefined;
    return await new Promise<ParserResult>((resolve, reject) => {
      let child: ChildProcess | UtilityProcess | undefined;
      let settled = false;
      const finish = (error?: Error, result?: ParserResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(result!);
      };
      const terminate = (error: Error): void => {
        child?.kill();
        finish(error);
      };
      const onAbort = (): void => terminate(new Error('PARSER_ABORTED'));
      const timer = setTimeout(
        () => terminate(new Error('PARSER_TIMEOUT')),
        this.options.timeoutMs,
      );
      const disconnect = (): void => {
        if (child && 'disconnect' in child) child.disconnect();
      };
      const handleMessage = (value: unknown): void => {
        if (settled) return;
        let encoded: string | undefined;
        try {
          encoded = JSON.stringify(value);
        } catch {
          terminate(new Error('PARSER_RESULT_INVALID'));
          return;
        }
        if (encoded === undefined) {
          terminate(new Error('PARSER_RESULT_INVALID'));
          return;
        }
        if (Buffer.byteLength(encoded, 'utf8') > this.options.maxResultBytes) {
          terminate(new Error('PARSER_RESULT_TOO_LARGE'));
          return;
        }
        const parsed = parserMessageSchema.safeParse(value);
        if (!parsed.success) {
          terminate(new Error('PARSER_RESULT_INVALID'));
          return;
        }
        if (!parsed.data.ok) {
          disconnect();
          finish(new Error(parsed.data.error));
          return;
        }
        disconnect();
        finish(undefined, parsed.data);
      };
      try {
        if (utility) {
          child = utility.fork(selected.modulePath, [], {
            stdio: ['ignore', 'pipe', 'pipe'],
            serviceName: 'LG Report source parser',
          });
          let stderr = '';
          child.stderr?.on('data', (chunk: Buffer | string) => {
            stderr = `${stderr}${chunk.toString()}`.slice(-4_096);
          });
          child.once('error', (type, location) =>
            finish(
              new Error(
                `PARSER_CRASH: ${type} at ${location}${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
              ),
            ),
          );
          child.once('exit', (code) => {
            if (!settled)
              finish(
                new Error(
                  `PARSER_CRASH: worker exited (${code})${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
                ),
              );
          });
          child.on('message', handleMessage);
          signal?.addEventListener('abort', onAbort, { once: true });
          child.postMessage(request);
          return;
        }
        const nodeChild = fork(selected.modulePath, [], {
          execArgv: selected.execArgv,
          silent: true,
          serialization: 'advanced',
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
          // `windowsHide` is supported by child_process at runtime, but older
          // @types/node versions omit it from ForkOptions.
          ...(process.platform === 'win32' ? { windowsHide: true } : {}),
        } as Parameters<typeof fork>[2]);
        child = nodeChild;
        child.once('error', (error) => finish(new Error(`PARSER_CRASH: ${error.message}`)));
        child.once('exit', (code, signalName) => {
          if (!settled)
            finish(new Error(`PARSER_CRASH: worker exited (${code ?? signalName ?? 'unknown'})`));
        });
        child.on('message', handleMessage);
        signal?.addEventListener('abort', onAbort, { once: true });
        child.send(request, (error) => {
          if (error) finish(new Error(`PARSER_CRASH: ${error.message}`));
        });
      } catch (error) {
        finish(error instanceof Error ? error : new Error('PARSER_CRASH'));
      }
    });
  }
}
