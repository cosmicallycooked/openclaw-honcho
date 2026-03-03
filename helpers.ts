/**
 * Pure helper functions — no mutable state dependencies.
 */

import type { Peer, MessageInput } from "@honcho-ai/sdk";
import type { NoisePattern } from "./config.js";

// ── Built-in noise patterns ───────────────────────────────────────────────────
// These are always active. Add custom patterns via config.noisePatterns.

export const DEFAULT_NOISE_PATTERNS: NoisePattern[] = [
  // Heartbeat ping responses — assistant replying with just "HEARTBEAT_OK"
  {
    label: "heartbeat-ok-response",
    pattern: "^HEARTBEAT_OK\\s*$",
    skipMessage: true,
    role: "assistant",
  },
  // Cron reminder injection — the full scheduled reminder boilerplate
  {
    label: "cron-reminder-boilerplate",
    pattern: "A scheduled reminder has been triggered",
    skipMessage: true,
    role: "user",
  },
  // Session startup command
  {
    label: "session-startup-command",
    pattern: "Execute your Session Startup sequence now",
    skipMessage: true,
    role: "user",
  },
  // Inline: conversation metadata JSON blocks (timestamp/sender headers)
  {
    label: "conversation-metadata-json",
    pattern: "Conversation info \\(untrusted metadata\\)[\\s\\S]*?```",
    skipMessage: false,
  },
  // Inline: queued messages wrapper header
  {
    label: "queued-messages-wrapper",
    pattern: "\\[Queued messages while agent was busy\\][^\\n]*\\n---",
    skipMessage: false,
  },
  // Inline: replied message context block (untrusted)
  {
    label: "replied-message-context",
    pattern: "Replied message \\(untrusted, for context\\)[\\s\\S]*?```",
    skipMessage: false,
  },
];

/**
 * Build compiled noise filter list from defaults + user-supplied patterns.
 */
export type CompiledNoiseFilter = {
  label: string;
  regex: RegExp;
  skipMessage: boolean;
  role?: "user" | "assistant";
};

export function buildNoiseFilters(extra: NoisePattern[] = []): CompiledNoiseFilter[] {
  return [...DEFAULT_NOISE_PATTERNS, ...extra].map((p) => ({
    label: p.label,
    regex: new RegExp(p.pattern, "gi"),
    skipMessage: p.skipMessage !== false, // default true
    role: p.role,
  }));
}

/**
 * Returns true if the message should be dropped entirely.
 */
export function shouldSkipMessage(
  content: string,
  role: "user" | "assistant",
  filters: CompiledNoiseFilter[]
): boolean {
  for (const f of filters) {
    if (f.skipMessage && (f.role === undefined || f.role === role)) {
      f.regex.lastIndex = 0;
      if (f.regex.test(content)) return true;
    }
  }
  return false;
}

/**
 * Strip inline noise from content without dropping the whole message.
 */
export function stripInlineNoise(
  content: string,
  role: "user" | "assistant",
  filters: CompiledNoiseFilter[]
): string {
  let result = content;
  for (const f of filters) {
    if (!f.skipMessage && (f.role === undefined || f.role === role)) {
      f.regex.lastIndex = 0;
      result = result.replace(f.regex, "");
    }
  }
  return result.trim();
}

/**
 * Build a Honcho session key from OpenClaw context.
 * Combines sessionKey + messageProvider to create unique sessions per platform.
 * Uses hyphens as separators (Honcho requires hyphens, not underscores).
 */
export function buildSessionKey(ctx?: { sessionKey?: string; messageProvider?: string }): string {
  const baseKey = ctx?.sessionKey ?? "default";
  const provider = ctx?.messageProvider ?? "unknown";
  const combined = `${baseKey}-${provider}`;
  return combined.replace(/[^a-zA-Z0-9-]/g, "-");
}

export function isSubagentSession(ctx?: { sessionKey?: string }): boolean {
  return (ctx?.sessionKey ?? "").includes(":subagent:");
}

export function extractParentAgentKey(sessionKey?: string): string | undefined {
  const match = sessionKey?.match(/^(agent:[^:]+):subagent:/);
  return match?.[1] ?? undefined;
}

/**
 * Strip Honcho's own injected context from message content to prevent
 * feedback loops (context injected -> saved -> re-injected -> grows forever).
 * Also strips leading OpenClaw reply directive tags (e.g. [[reply_to_current]])
 * so control tokens are never persisted or re-surfaced as user-visible text.
 * Other metadata (platform headers, message IDs, etc.) is preserved as
 * useful provenance data for Honcho's memory layer.
 */
export function cleanMessageContent(content: string): string {
  let cleaned = content;
  cleaned = cleaned.replace(/<honcho-memory[^>]*>[\s\S]*?<\/honcho-memory>\s*/gi, "");
  cleaned = cleaned.replace(/<!--[^>]*honcho[^>]*-->\s*/gi, "");
  cleaned = cleaned.replace(
    /^(\s*\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\]\s*)+/gi,
    ""
  );
  return cleaned.trim();
}

export function extractMessages(
  rawMessages: unknown[],
  ownerPeer: Peer,
  agentPeer: Peer,
  noiseFilters: CompiledNoiseFilter[] = []
): MessageInput[] {
  const result: MessageInput[] = [];

  for (const msg of rawMessages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    const role = m.role as string | undefined;

    if (role !== "user" && role !== "assistant") continue;

    let content = "";
    if (typeof m.content === "string") {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      content = m.content
        .filter(
          (block: unknown) =>
            typeof block === "object" &&
            block !== null &&
            (block as Record<string, unknown>).type === "text"
        )
        .map((block: unknown) => (block as Record<string, unknown>).text)
        .filter((t): t is string => typeof t === "string")
        .join("\n");
    }

    content = cleanMessageContent(content);
    content = content.trim();

    if (!content) continue;

    // Apply noise filters
    if (shouldSkipMessage(content, role, noiseFilters)) continue;
    content = stripInlineNoise(content, role, noiseFilters);

    if (content) {
      const peer = role === "user" ? ownerPeer : agentPeer;
      result.push(peer.message(content));
    }
  }

  return result;
}
