import type { z } from 'zod';

export class StructuredOutputError extends Error {
  readonly code = 'CODEX_STRUCTURED_OUTPUT_INVALID';

  constructor() {
    super('AI가 반환한 구조화된 응답을 해석할 수 없습니다. 다시 생성해 주세요.');
    this.name = 'StructuredOutputError';
  }
}

/**
 * App Server의 완료 메시지를 방어적으로 해석한다. 일부 구버전 모델은 JSON Schema를
 * 사용해도 Markdown fence나 짧은 설명을 덧붙일 수 있으므로 마지막으로 Schema에 맞는
 * 완전한 JSON 값만 선택한다.
 */
export function parseStructuredOutput<T>(raw: string, schema: z.ZodType<T>): T {
  for (const candidate of jsonCandidates(raw)) {
    try {
      let value: unknown = JSON.parse(candidate);
      if (typeof value === 'string') value = JSON.parse(value);
      const parsed = schema.safeParse(value);
      if (parsed.success) return parsed.data;
    } catch {
      // 다음 완전한 JSON 후보를 검사한다. 원문은 오류나 로그에 포함하지 않는다.
    }
  }
  throw new StructuredOutputError();
}

function jsonCandidates(raw: string): string[] {
  const trimmed = raw.trim();
  const fenced = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) =>
    match[1]!.trim(),
  );
  const balanced = extractBalancedJson(trimmed);
  return unique([trimmed, ...fenced.reverse(), ...balanced.reverse()]);
}

function extractBalancedJson(value: string): string[] {
  const results: string[] = [];
  let start = -1;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (start < 0) {
      if (character === '{' || character === '[') {
        start = index;
        stack.push(character);
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{' || character === '[') stack.push(character);
    else if (character === '}' || character === ']') {
      const opening = stack.at(-1);
      const matches =
        (opening === '{' && character === '}') || (opening === '[' && character === ']');
      if (!matches) {
        start = -1;
        stack.length = 0;
        continue;
      }
      stack.pop();
      if (stack.length === 0) {
        results.push(value.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return results;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
