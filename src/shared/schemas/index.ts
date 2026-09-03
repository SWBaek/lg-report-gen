import { z } from 'zod';

export const idSchema = z.string().uuid();
export const workspacePathSchema = z.object({ path: z.string().min(1).max(1024) }).strict();
export const reportOutputOptionsSchema = z.object({
  tone: z.enum(['concise', 'standard', 'detailed']).default('standard'),
  audience: z.enum(['executive', 'manager', 'practitioner', 'expert']).default('manager'),
  length: z.enum(['one-page', 'short', 'standard', 'detailed']).default('standard'),
  format: z.enum(['narrative', 'table', 'bullets', 'balanced']).default('balanced'),
  language: z.enum(['ko', 'en', 'bilingual']).default('ko'),
  conclusionFirst: z.boolean().default(true),
  terminology: z.enum(['minimal', 'standard', 'expert']).default('standard'),
  evidence: z.enum(['minimal', 'standard', 'detailed']).default('standard'),
  model: z.string().nullable().default(null),
  reasoningEffort: z.string().nullable().default(null),
});
export const createReportSchema = z.object({
  title: z.string().trim().max(200).default('제목 없는 보고서'),
  purpose: z.string().max(10_000).default(''),
  personaId: z.string().uuid().nullable().default(null),
  outputOptions: reportOutputOptionsSchema,
  layoutMode: z.enum(['a4', 'web']).default('a4'),
  html: z.string().max(10_000_000).default('<p></p>'),
});
export const saveReportSchema = z.object({
  id: idSchema,
  title: z.string().trim().min(1).max(200),
  html: z.string().max(10_000_000),
  editorJson: z.unknown(),
  layoutMode: z.enum(['a4', 'web']),
  generation: z
    .object({
      schemaVersion: z.literal(1).default(1),
      executiveSummary: z.string().max(30_000),
      sourceUsage: z
        .array(
          z.object({
            sourceId: z.string().uuid(),
            locator: z.string().trim().min(1).max(500),
            claimSummary: z.string().max(5_000),
          }),
        )
        .max(200),
      assumptions: z.array(z.string().max(5_000)).max(100),
      warnings: z.array(z.string().max(5_000)).max(100),
      model: z.string().max(200).nullable().default(null),
      promptVersion: z.string().trim().min(1).max(100),
      sourceSnapshotHashes: z
        .record(z.string().uuid(), z.string().regex(/^[0-9a-f]{64}$/i))
        .default({}),
      claimEvidence: z
        .array(
          z.object({
            claim: z.string().min(1).max(5_000),
            sourceId: z.string().uuid(),
            locator: z.string().trim().min(1).max(500),
            evidenceExcerpt: z.string().max(10_000).optional(),
          }),
        )
        .max(500)
        .default([]),
    })
    .strict()
    .optional(),
});
export const reportIdSchema = z.object({ id: idSchema });
export const exportMetadataSchema = z
  .object({
    lang: z.enum(['ko', 'en', 'bilingual']).default('ko'),
    author: z.string().max(200).default(''),
    date: z.string().max(100).default(''),
    revision: z.string().max(100).default(''),
    classification: z.string().max(100).default(''),
    header: z.string().max(500).default(''),
    footer: z.string().max(500).default('LG Report Agent'),
    pageNumber: z.boolean().default(true),
  })
  .strict();
export const reportExportPreflightSchema = z
  .object({
    id: idSchema,
    format: z.enum(['html', 'pdf']).default('html'),
    metadata: exportMetadataSchema.optional(),
  })
  .strict();
export const reportExportSchema = z
  .object({
    id: idSchema,
    format: z.enum(['html', 'pdf']).default('html'),
    approvalToken: z.string().min(20).max(200).optional(),
    metadata: exportMetadataSchema.optional(),
  })
  .strict();
export const listReportsSchema = z.object({
  includeDeleted: z.boolean().default(false),
  query: z.string().max(200).default(''),
  sort: z.enum(['updated', 'title']).default('updated'),
});
export const reportFlagSchema = z.object({ id: idSchema, value: z.boolean() });
export const renameSchema = z.object({ id: idSchema, title: z.string().trim().min(1).max(200) });
export const revisionCreateSchema = z.object({
  reportId: idSchema,
  reason: z.string().max(60),
  description: z.string().max(500),
});
export const revisionRestoreSchema = z.object({ reportId: idSchema, revisionId: idSchema });
export const personaSchema = z.object({
  id: idSchema.optional(),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(4000),
  instructions: z.string().max(10_000),
  isDefault: z.boolean().default(false),
});
export const importSourcesSchema = z
  .object({
    reportId: idSchema,
    selectionIds: z
      .array(idSchema)
      .min(1)
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length, '선택 토큰은 중복될 수 없습니다.'),
  })
  .strict();
export const chatCreateSchema = z.object({
  title: z.string().trim().min(1).max(200).default('새 대화'),
  reportId: idSchema.nullable().default(null),
});
export const chatAiSettingsSchema = z.object({
  id: idSchema,
  model: z.string().min(1).max(200).nullable(),
  reasoningEffort: z.string().min(1).max(50).nullable(),
});
export const messageListSchema = z.object({ sessionId: idSchema });
export const codexTurnSchema = z
  .object({
    intent: z.enum(['chat', 'plan', 'generate', 'revise']),
    sessionId: idSchema,
    prompt: z.string().min(1).max(2_000_000),
    displayText: z.string().max(100_000).optional(),
    model: z.string().nullable().default(null),
    effort: z.string().nullable().default(null),
  })
  .strict();
export const codexCancelSchema = z
  .object({ taskId: idSchema.optional(), sessionId: idSchema.optional() })
  .strict();
export const externalPurposeSchema = z.object({ purpose: z.enum(['codexCliDocs']) }).strict();
export const textSchema = z.object({ text: z.string().max(100_000) });

export const planningOutputSchema = z.object({
  schemaVersion: z.literal(1),
  suggestedTitle: z.string().max(200),
  purpose: z.string().max(10_000),
  executiveSummaryDirection: z.string().max(10_000),
  outline: z
    .array(
      z
        .object({
          id: z.string().max(100),
          heading: z.string().max(300),
          level: z.number().int().min(1).max(4),
          intent: z.string().max(5_000),
          evidenceSourceIds: z.array(z.string().uuid()).max(50),
        })
        .strict(),
    )
    .max(100),
  assumptions: z.array(z.string().max(5_000)).max(100),
  questions: z.array(z.string().max(5_000)).max(100),
  warnings: z.array(z.string().max(5_000)).max(100),
});
export const reportOutputSchema = z.object({
  schemaVersion: z.literal(1),
  title: z.string().max(200),
  htmlBody: z.string().max(10_000_000),
  executiveSummary: z.string().max(30_000),
  sourceUsage: z
    .array(
      z
        .object({
          sourceId: z.string().uuid(),
          locator: z.string().trim().min(1).max(500),
          claimSummary: z.string().max(5_000),
        })
        .strict(),
    )
    .max(200),
  assumptions: z.array(z.string().max(5_000)).max(100),
  warnings: z.array(z.string().max(5_000)).max(100),
});
export const revisionOutputSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  scope: z.enum(['document', 'selection']),
  updatedHtml: z.string().max(10_000_000),
  replacementHtml: z.string().max(10_000_000).nullable(),
  changeSummary: z.array(z.string().max(5_000)).max(100),
  assumptions: z.array(z.string().max(5_000)).max(100),
  warnings: z.array(z.string().max(5_000)).max(100),
});

export const reportGenerationListSchema = z.object({ reportId: idSchema });
export const deletionRetentionListSchema = z.object({ id: idSchema }).partial().strict();
export const deletionRetentionRetrySchema = z.object({ id: idSchema }).strict();
