/**
 * Configuration schema and parsing for the Honcho memory plugin.
 */

import { z } from "zod";

export const DEFAULT_NOISE_PATTERNS: string[] = [
  "HEARTBEAT_OK",
  "A scheduled reminder has been triggered",
  "Execute your Session Startup sequence now",
  "Queued messages from",
];

const WorkspaceConfigSchema = z
  .object({
    reasoning: z
      .object({
        enabled: z.boolean().optional(),
        customInstructions: z.string().optional(),
      })
      .optional(),
    peerCard: z
      .object({
        use: z.boolean().optional(),
        create: z.boolean().optional(),
      })
      .optional(),
    summary: z
      .object({
        enabled: z.boolean().optional(),
        messagesPerShortSummary: z.number().int().min(10).optional(),
        messagesPerLongSummary: z.number().int().min(20).optional(),
      })
      .optional(),
    dream: z
      .object({
        enabled: z.boolean().optional(),
      })
      .optional(),
  })
  .optional();

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

export const DEFAULT_WORKSPACE_CONFIG: Required<NonNullable<WorkspaceConfig>> = {
  reasoning: { enabled: true },
  peerCard: { use: true, create: true },
  // Raise summary thresholds above Honcho's defaults (10/20) to reduce noise.
  summary: { enabled: true, messagesPerShortSummary: 20, messagesPerLongSummary: 50 },
  dream: { enabled: true },
};

export type HonchoConfig = {
  apiKey?: string;
  workspaceId: string;
  baseUrl: string;
  noisePatterns: string[];

  contextTokens: number;
  maxConclusions: number;
  dreamOnSessionEnd: boolean;
  workspace: Required<NonNullable<WorkspaceConfig>>;
};

/**
 * Resolve environment variable references in config values.
 * Supports ${ENV_VAR} syntax.
 */
function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

export const honchoConfigSchema = {
  parse(value: unknown): HonchoConfig {
    const cfg = (value ?? {}) as Record<string, unknown>;

    // Resolve API key with env var fallback
    let apiKey: string | undefined;
    if (typeof cfg.apiKey === "string" && cfg.apiKey.length > 0) {
      apiKey = resolveEnvVars(cfg.apiKey);
    } else {
      apiKey = process.env.HONCHO_API_KEY;
    }

    const userPatterns = Array.isArray(cfg.noisePatterns)
      ? (cfg.noisePatterns as unknown[]).filter((p): p is string => typeof p === "string" && p.length > 0)
      : [];
    const noisePatterns = [...new Set([...DEFAULT_NOISE_PATTERNS, ...userPatterns])];

    const userWorkspace = WorkspaceConfigSchema.parse(cfg.workspace) ?? {};
    const workspace: HonchoConfig["workspace"] = {
      reasoning: { ...DEFAULT_WORKSPACE_CONFIG.reasoning, ...userWorkspace.reasoning },
      peerCard: { ...DEFAULT_WORKSPACE_CONFIG.peerCard, ...userWorkspace.peerCard },
      summary: { ...DEFAULT_WORKSPACE_CONFIG.summary, ...userWorkspace.summary },
      dream: { ...DEFAULT_WORKSPACE_CONFIG.dream, ...userWorkspace.dream },
    };

    return {
      apiKey,
      workspaceId:
        typeof cfg.workspaceId === "string" && cfg.workspaceId.length > 0
          ? cfg.workspaceId
          : process.env.HONCHO_WORKSPACE_ID ?? "openclaw",
      baseUrl:
        typeof cfg.baseUrl === "string" && cfg.baseUrl.length > 0
          ? cfg.baseUrl
          : process.env.HONCHO_BASE_URL ?? "https://api.honcho.dev",
      noisePatterns,

      contextTokens: typeof cfg.contextTokens === "number" && cfg.contextTokens > 0 ? cfg.contextTokens : 4000,
      maxConclusions: typeof cfg.maxConclusions === "number" && cfg.maxConclusions > 0 ? cfg.maxConclusions : 50,
      dreamOnSessionEnd: typeof cfg.dreamOnSessionEnd === "boolean" ? cfg.dreamOnSessionEnd : false,
      workspace,
    };
  },
};
