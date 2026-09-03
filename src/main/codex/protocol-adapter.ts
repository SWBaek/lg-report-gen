import { z } from 'zod';

/**
 * The app-server protocol is intentionally kept behind this module.  The CLI
 * can add fields to messages without requiring a manager change, while fields
 * the manager consumes are checked at the process boundary.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['v1'] as const;
export type SupportedProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

export const clientIdentity = {
  name: 'lg-report-agent',
  title: 'LG Report Agent',
} as const;

export const responseSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.number(),
        message: z.string().max(4_000),
        data: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const notificationSchema = z
  .object({ method: z.string().min(1).max(200), params: z.unknown().optional() })
  .passthrough();

export const requestSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    method: z.string().min(1).max(200),
    params: z.unknown().optional(),
  })
  .passthrough();

export const notificationRequestSchema = z
  .object({ method: z.string().min(1).max(200), params: z.unknown().optional() })
  .passthrough();

export const agentMessageDeltaSchema = z
  .object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    delta: z.string().max(250_000),
  })
  .passthrough();

export const modelResponseSchema = z
  .object({
    data: z.array(
      z
        .object({
          id: z.string().min(1),
          model: z.string().min(1).optional(),
          displayName: z.string().optional(),
          isDefault: z.boolean().optional(),
          hidden: z.boolean().optional(),
          supportedReasoningEfforts: z
            .array(
              z
                .object({ reasoningEffort: z.string().optional(), effort: z.string().optional() })
                .passthrough(),
            )
            .optional(),
          defaultReasoningEffort: z.string().optional(),
          inputModalities: z.array(z.string()).optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const turnCompletedSchema = z
  .object({
    threadId: z.string().min(1),
    turn: z
      .object({
        id: z.string().min(1),
        status: z.enum(['completed', 'interrupted', 'failed']),
        error: z
          .object({
            message: z.string().max(4_000),
            codexErrorInfo: z.unknown().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
        items: z.array(
          z
            .object({
              type: z.string().min(1).max(100),
              text: z.string().max(2_000_000).optional(),
              phase: z.enum(['commentary', 'final_answer']).nullable().optional(),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
  })
  .passthrough();

export const accountResponseSchema = z
  .object({
    account: z
      .union([
        z
          .object({
            type: z.literal('chatgpt'),
            email: z.string().nullable().optional(),
            planType: z.string().optional(),
          })
          .passthrough(),
        z.object({ type: z.string() }).passthrough(),
      ])
      .nullable(),
    requiresOpenaiAuth: z.boolean().optional(),
  })
  .passthrough();

const initializeResultSchema = z
  .object({
    serverInfo: z
      .object({
        name: z.string().optional(),
        version: z.string().optional(),
        protocolVersion: z.string().optional(),
      })
      .passthrough()
      .optional(),
    protocolVersion: z.string().optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    features: z.record(z.string(), z.boolean()).optional(),
  })
  .passthrough();

export type FeatureFlags = Readonly<Record<string, boolean>>;
export type ProtocolInfo = {
  client: { name: string; title: string; version: string };
  server: { name: string | null; version: string | null };
  protocolVersion: string | null;
  supported: boolean;
  features: FeatureFlags;
  provenance: 'codex-app-server';
};

export type StructuredOutputResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'invalid-json' | 'not-object' | 'too-large' | 'schema-mismatch' };

export type ProtocolAdapterOptions = {
  clientVersion: string;
  maxStructuredOutputBytes?: number;
  supportedVersions?: readonly string[];
};

export class CodexProtocolAdapter {
  readonly maxStructuredOutputBytes: number;
  readonly supportedVersions: readonly string[];
  readonly clientVersion: string;
  private info: ProtocolInfo;

  constructor(options: ProtocolAdapterOptions) {
    this.clientVersion = options.clientVersion;
    this.maxStructuredOutputBytes = options.maxStructuredOutputBytes ?? 1_000_000;
    this.supportedVersions = options.supportedVersions ?? SUPPORTED_PROTOCOL_VERSIONS;
    this.info = {
      client: { ...clientIdentity, version: options.clientVersion },
      server: { name: null, version: null },
      protocolVersion: null,
      supported: true,
      features: {},
      provenance: 'codex-app-server',
    };
  }

  get protocolInfo(): ProtocolInfo {
    return structuredClone(this.info);
  }

  initializeParams(): Record<string, unknown> {
    return {
      clientInfo: { ...clientIdentity, version: this.clientVersion },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        protocolVersions: [...this.supportedVersions],
      },
      features: {
        structuredOutput: true,
        turnInterrupt: true,
        threadResume: true,
      },
    };
  }

  negotiateInitialize(raw: unknown): ProtocolInfo {
    const result = initializeResultSchema.parse(raw);
    const serverInfo = result.serverInfo;
    const version = result.protocolVersion ?? serverInfo?.protocolVersion ?? null;
    const features: Record<string, boolean> = {};
    for (const [name, enabled] of Object.entries(result.features ?? {})) features[name] = enabled;
    for (const [name, value] of Object.entries(result.capabilities ?? {})) {
      if (typeof value === 'boolean') features[name] = value;
    }
    this.info = {
      ...this.info,
      server: { name: serverInfo?.name ?? null, version: serverInfo?.version ?? null },
      protocolVersion: version,
      // Older app-servers omit protocolVersion. They remain compatible with
      // the v1 message shape; an explicitly unknown version is incompatible.
      supported: version === null || this.supportedVersions.includes(version),
      features,
    };
    return this.protocolInfo;
  }

  /** Parse only bounded structured output. The input is never included in errors. */
  parseStructuredOutput(
    text: string,
    schema?: Record<string, unknown> | null,
  ): StructuredOutputResult {
    if (Buffer.byteLength(text, 'utf8') > this.maxStructuredOutputBytes)
      return { ok: false, reason: 'too-large' };
    const candidate = extractJson(text);
    if (candidate === null) return { ok: false, reason: 'invalid-json' };
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate))
      return { ok: false, reason: 'not-object' };
    if (schema && !matchesJsonSchema(candidate as Record<string, unknown>, schema))
      return { ok: false, reason: 'schema-mismatch' };
    return { ok: true, value: candidate };
  }
}

function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    return JSON.parse(withoutFence) as unknown;
  } catch {
    // Some compatible servers add a short preamble. Only parse the first
    // balanced object; no source text is retained in the error path.
    const start = withoutFence.indexOf('{');
    const end = withoutFence.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(withoutFence.slice(start, end + 1)) as unknown;
    } catch {
      return null;
    }
  }
}

function matchesJsonSchema(
  value: Record<string, unknown>,
  schema: Record<string, unknown>,
): boolean {
  if (schema.type && schema.type !== 'object') return false;
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (!required.every((key) => typeof key === 'string' && key in value)) return false;
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return true;
  for (const [key, definition] of Object.entries(properties)) {
    if (!(key in value) || !definition || typeof definition !== 'object') continue;
    if (!matchesValue(value[key], definition as Record<string, unknown>)) return false;
  }
  return true;
}

function matchesValue(value: unknown, schema: Record<string, unknown>): boolean {
  const type = schema.type;
  if (type === 'string' && typeof value !== 'string') return false;
  if (type === 'array') {
    if (!Array.isArray(value)) return false;
    const itemSchema = schema.items;
    if (itemSchema && typeof itemSchema === 'object' && !Array.isArray(itemSchema))
      return value.every((item) => matchesValue(item, itemSchema as Record<string, unknown>));
  }
  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    if (!matchesJsonSchema(value as Record<string, unknown>, schema)) return false;
  }
  if (type === 'boolean' && typeof value !== 'boolean') return false;
  if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return false;
  if (type === 'integer' && (typeof value !== 'number' || !Number.isInteger(value))) return false;
  if (type === 'null' && value !== null) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value)))
    return false;
  return true;
}
