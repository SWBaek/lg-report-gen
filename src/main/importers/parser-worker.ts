import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { extractByType } from './source-importer.js';

const requestSchema = z.object({
  inputPath: z.string().min(1).max(4_096),
  extension: z.string().regex(/^\.[a-z0-9]+$/),
  allowedRoot: z.string().min(1).max(4_096),
  assetPath: z.string().max(4_096).optional(),
});

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

type UtilityParentPort = {
  once(event: 'message', listener: (event: MessageEvent) => void): unknown;
  postMessage(value: unknown): void;
};

const utilityPort = (process as NodeJS.Process & { parentPort?: UtilityParentPort }).parentPort;

if (process.send || utilityPort) {
  const send = (value: unknown): Promise<void> => {
    if (utilityPort) {
      utilityPort.postMessage(value);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      process.send?.(value, () => resolve());
    });
  };
  const handle = async (raw: unknown): Promise<void> => {
    try {
      const request = requestSchema.parse(raw);
      const input = path.resolve(request.inputPath);
      const root = path.resolve(request.allowedRoot);
      const asset = request.assetPath ? path.resolve(request.assetPath) : undefined;
      if (!isWithin(input, root) || (asset && !isWithin(asset, root)))
        throw new Error('PARSER_PATH_NOT_ALLOWED');
      const result = await extractByType(request.extension, input, await readFile(input));
      let imageAssetCreated = false;
      if (result.metadata.image && asset) {
        try {
          const sharpModule = await import('sharp');
          await sharpModule
            .default(input)
            .rotate()
            .resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true })
            .png()
            .toFile(asset);
          imageAssetCreated = true;
        } catch {
          result.warnings.push(
            '메타데이터 안전 표시본을 생성하지 못해 이미지 미리보기를 생략했습니다.',
          );
        }
      }
      await send({ ok: true, ...result, imageAssetCreated });
    } catch (error) {
      await send({
        ok: false,
        error: error instanceof Error ? error.message : '추출에 실패했습니다.',
      });
    } finally {
      setImmediate(() => process.exit(0));
    }
  };
  if (utilityPort) utilityPort.once('message', (event) => void handle(event.data));
  else process.once('message', (raw: unknown) => void handle(raw));
}
