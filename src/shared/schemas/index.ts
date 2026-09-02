import { z } from 'zod';

export const idSchema = z.string().uuid();
export const workspacePathSchema = z.object({ path: z.string().min(1).max(1024) });
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
});
export const reportIdSchema = z.object({ id: idSchema });
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
export const importSourcesSchema = z.object({
  reportId: idSchema,
  paths: z.array(z.string().min(1).max(1024)).min(1).max(50),
});
export const chatCreateSchema = z.object({
  title: z.string().trim().min(1).max(200).default('새 대화'),
  reportId: idSchema.nullable().default(null),
});
export const messageListSchema = z.object({ sessionId: idSchema });
export const codexTurnSchema = z.object({
  sessionType: z.enum(['chat', 'report', 'planning', 'generation', 'revision']),
  sessionId: idSchema,
  prompt: z.string().min(1).max(2_000_000),
  displayText: z.string().max(100_000).optional(),
  cwd: z.string().min(1).max(1024),
  threadId: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  effort: z.string().nullable().default(null),
  outputSchema: z.record(z.string(), z.unknown()).nullable().default(null),
  writable: z.boolean().default(false),
});
export const externalUrlSchema = z.object({
  url: z
    .string()
    .url()
    .refine((url) => url.startsWith('https://'), 'HTTPS만 허용됩니다.'),
});
export const textSchema = z.object({ text: z.string().max(100_000) });

export const planningOutputSchema = z.object({
  suggestedTitle: z.string(),
  purpose: z.string(),
  executiveSummaryDirection: z.string(),
  outline: z.array(
    z.object({
      id: z.string(),
      heading: z.string(),
      level: z.number().int().min(1).max(4),
      intent: z.string(),
      evidenceSourceIds: z.array(z.string()),
    }),
  ),
  assumptions: z.array(z.string()),
  questions: z.array(z.string()),
  warnings: z.array(z.string()),
});
export const reportOutputSchema = z.object({
  title: z.string(),
  htmlBody: z.string(),
  executiveSummary: z.string(),
  sourceUsage: z.array(
    z.object({ sourceId: z.string(), locator: z.string(), claimSummary: z.string() }),
  ),
  assumptions: z.array(z.string()),
  warnings: z.array(z.string()),
});
export const revisionOutputSchema = z.object({
  scope: z.enum(['document', 'selection']),
  updatedHtml: z.string(),
  replacementHtml: z.string().nullable(),
  changeSummary: z.array(z.string()),
  assumptions: z.array(z.string()),
  warnings: z.array(z.string()),
});
