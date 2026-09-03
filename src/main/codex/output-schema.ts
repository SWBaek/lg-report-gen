import { z } from 'zod';
import {
  planningOutputSchema,
  reportOutputSchema,
  revisionOutputSchema,
} from '../../shared/schemas/index.js';

export type AiIntent = 'chat' | 'plan' | 'generate' | 'revise';

/** Build a strict Codex schema whose evidence IDs are limited to this report's Sources. */
export function outputSchemaFor(
  intent: AiIntent,
  sourceIds: string[] = [],
): Record<string, unknown> | null {
  if (intent === 'chat') return null;
  const schema =
    intent === 'plan'
      ? planningOutputSchema
      : intent === 'generate'
        ? reportOutputSchema
        : revisionOutputSchema;
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  constrainEvidenceSourceIds(jsonSchema, intent, sourceIds);
  return jsonSchema;
}

function constrainEvidenceSourceIds(
  schema: Record<string, unknown>,
  intent: AiIntent,
  sourceIds: string[],
): void {
  if (intent !== 'plan' && intent !== 'generate') return;
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return;
  const targetArray =
    intent === 'generate'
      ? properties.sourceUsage
      : ((
          (properties.outline?.items as Record<string, unknown> | undefined)?.properties as
            Record<string, Record<string, unknown>> | undefined
        )?.evidenceSourceIds ?? null);
  if (!targetArray) return;
  if (sourceIds.length === 0) {
    targetArray.maxItems = 0;
    return;
  }
  const item =
    intent === 'generate'
      ? (targetArray.items as Record<string, unknown> | undefined)
      : targetArray;
  const sourceIdSchema =
    intent === 'generate'
      ? ((item?.properties as Record<string, Record<string, unknown>> | undefined)?.sourceId ??
        null)
      : (item?.items as Record<string, unknown> | undefined);
  if (sourceIdSchema) sourceIdSchema.enum = [...new Set(sourceIds)];
}
