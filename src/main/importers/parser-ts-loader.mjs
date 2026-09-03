/* global URL */
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.js') && (specifier.startsWith('.') || specifier.startsWith('file:'))) {
    const candidate = new URL(specifier, context.parentURL);
    const tsCandidate = new URL(candidate.href.slice(0, -3) + '.ts');
    if (existsSync(fileURLToPath(tsCandidate)))
      return { url: pathToFileURL(fileURLToPath(tsCandidate)).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
