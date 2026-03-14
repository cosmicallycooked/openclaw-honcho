// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi, PluginHookSubagentContext, PluginHookSubagentSpawnedEvent, PluginHookSubagentEndedEvent } from "openclaw/plugin-sdk";

/**
 * Module-level singleton: childSessionKey → parent agent ID.
 * Populated by subagent_spawned; read by agent_end in capture.ts.
 */
export const subagentParentMap = new Map<string, string>();

/**
 * Maps OpenClaw sessionKey → agentId, built from before_prompt_build.
 * Used to resolve the parent's agent ID from ctx.requesterSessionKey in
 * subagent_spawned without relying on session-key string parsing.
 */
const sessionKeyToAgentId = new Map<string, string>();

export function registerSubagentHooks(api: OpenClawPluginApi): void {
  api.on("before_prompt_build", (_event, ctx) => {
    if (ctx.sessionKey && ctx.agentId) {
      sessionKeyToAgentId.set(ctx.sessionKey, ctx.agentId);
    }
  });

  api.on("subagent_spawned", async (event: PluginHookSubagentSpawnedEvent, ctx: PluginHookSubagentContext) => {
    const childSessionKey = event.childSessionKey ?? ctx.childSessionKey;
    const requesterSessionKey = ctx.requesterSessionKey;

    if (childSessionKey && event.agentId) {
      // Pre-populate the child's agentId so subagent-of-subagent tracking works
      // even before the child's first before_prompt_build fires.
      sessionKeyToAgentId.set(childSessionKey, event.agentId);
    }

    if (childSessionKey && requesterSessionKey) {
      const parentAgentId = sessionKeyToAgentId.get(requesterSessionKey);
      if (parentAgentId) {
        subagentParentMap.set(childSessionKey, parentAgentId);
      } else {
        api.logger.warn?.(
          `[honcho] subagent_spawned: could not resolve parent agentId for requesterSessionKey=${requesterSessionKey} — parent observation will be skipped for child ${childSessionKey}`,
        );
      }
    }
  });

  api.on("subagent_ended", (event: PluginHookSubagentEndedEvent) => {
    const { targetSessionKey, outcome, reason } = event;
    if (subagentParentMap.has(targetSessionKey)) {
      api.logger.debug?.(
        `[honcho] subagent_ended: cleaning up ${targetSessionKey} (outcome=${outcome ?? "unknown"}, reason=${reason})`,
      );
      subagentParentMap.delete(targetSessionKey);
    }
    sessionKeyToAgentId.delete(targetSessionKey);
  });

  api.on("agent_end", (_event, ctx) => {
    if (ctx.sessionKey) {
      sessionKeyToAgentId.delete(ctx.sessionKey);
    }
  });
}
