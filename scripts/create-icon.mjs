import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = await readFile(path.join(root, 'build', 'icon.svg'));
const images = await Promise.all(
  [16, 24, 32, 48, 64, 128, 256].map((size) => sharp(svg).resize(size, size).png().toBuffer()),
);
await writeFile(path.join(root, 'build', 'icon.ico'), await pngToIco(images));
