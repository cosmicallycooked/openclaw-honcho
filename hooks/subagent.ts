// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi, PluginHookSubagentContext, PluginHookSubagentSpawnedEvent, PluginHookSubagentEndedEvent } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";
import { buildSessionKey } from "../helpers.js";

/**
 * Module-level singleton: childSessionKey → parent agent ID.
 * Populated by subagent_spawned; read by agent_end in capture.ts.
 */
export const subagentParentMap = new Map<string, string>();

/**
 * Maps OpenClaw sessionKey → agentId, built from before_prompt_build and
 * subagent_spawned (event.agentId). Exported so capture.ts can use the
 * child's actual agentId, which may differ from ctx.agentId at agent_end time.
 */
export const sessionKeyToAgentId = new Map<string, string>();

/**
 * Maps OpenClaw sessionKey → canonical Honcho session key. Only updated when
 * messageProvider is present so provider-less continuation turns (e.g. the parent
 * agent resuming after a subagent returns) don't overwrite the canonical key and
 * create spurious bare sessions like "agent-prime-main" vs "agent-prime-main-telegram".
 * Exported so capture.ts can resolve the correct target session for any turn.
 */
export const sessionKeyToHonchoKey = new Map<string, string>();

/**
 * Per-session conversation timestamp. Set once on the first provider-having
 * before_prompt_build for a session key, cleared on session_end. Gives each
 * conversation a unique Honcho session ID so stale peer configs from old
 * sessions don't pollute new ones.
 */
const sessionKeyToConversationTs = new Map<string, number>();

/**
 * Resolve the canonical Honcho session key for a given ctx. Uses the stored
 * timestamped key when available; falls back to buildSessionKey.
 * Import this instead of buildSessionKey wherever you need a Honcho key.
 */
export function resolveHonchoKey(ctx?: { sessionKey?: string; messageProvider?: string }): string {
  const stored = ctx?.sessionKey ? sessionKeyToHonchoKey.get(ctx.sessionKey) : undefined;
  return stored ?? buildSessionKey(ctx);
}

/**
 * Maps child OpenClaw sessionKey → parent Honcho session key.
 * Used by capture.ts to write subagent messages into the parent session
 * instead of creating a separate per-subagent session.
 */
export const subagentParentHonchoSessionMap = new Map<string, string>();

export function registerSubagentHooks(api: OpenClawPluginApi, state: PluginState): void {
  api.on("before_prompt_build", (_event, ctx) => {
    if (ctx.sessionKey && ctx.agentId) {
      sessionKeyToAgentId.set(ctx.sessionKey, ctx.agentId);
    }
    if (ctx.sessionKey) {
      if (ctx.messageProvider) {
        // Stamp a TS on the first provider-having turn of this session so each
        // conversation gets a unique Honcho session key. Continuation turns
        // (no provider) will fall back to this stored key via resolveHonchoKey.
        if (!sessionKeyToConversationTs.has(ctx.sessionKey)) {
          sessionKeyToConversationTs.set(ctx.sessionKey, Date.now());
        }
        const ts = sessionKeyToConversationTs.get(ctx.sessionKey)!;
        const baseKey = buildSessionKey(ctx);
        const honchoKey = `${baseKey}-${ts}`;
        sessionKeyToHonchoKey.set(ctx.sessionKey, honchoKey);
        api.logger.warn?.(`[honcho] before_prompt_build: sessionKey=${ctx.sessionKey} agentId=${ctx.agentId} messageProvider=${ctx.messageProvider} honchoKey=${honchoKey}`);
      } else if (!sessionKeyToHonchoKey.has(ctx.sessionKey)) {
        // No provider and no existing entry (e.g. cron, subagent) — use bare key.
        const honchoKey = buildSessionKey(ctx);
        sessionKeyToHonchoKey.set(ctx.sessionKey, honchoKey);
        api.logger.warn?.(`[honcho] before_prompt_build: sessionKey=${ctx.sessionKey} agentId=${ctx.agentId} messageProvider=${ctx.messageProvider} honchoKey=${honchoKey}`);
      } else {
        api.logger.warn?.(`[honcho] before_prompt_build: sessionKey=${ctx.sessionKey} agentId=${ctx.agentId} messageProvider=${ctx.messageProvider} honchoKey=${sessionKeyToHonchoKey.get(ctx.sessionKey)} (reused)`);
      }
    }
  });

  api.on("session_end", (_event, ctx) => {
    if (ctx.sessionKey) {
      sessionKeyToConversationTs.delete(ctx.sessionKey);
      sessionKeyToHonchoKey.delete(ctx.sessionKey);
      sessionKeyToAgentId.delete(ctx.sessionKey);
    }
  });

  api.on("subagent_spawned", async (event: PluginHookSubagentSpawnedEvent, ctx: PluginHookSubagentContext) => {
    const childSessionKey = event.childSessionKey ?? ctx.childSessionKey;
    const requesterSessionKey = ctx.requesterSessionKey;

    api.logger.warn?.(
      `[honcho] subagent_spawned: child=${childSessionKey} requester=${requesterSessionKey} event.agentId=${event.agentId} parentHonchoKey=${sessionKeyToHonchoKey.get(requesterSessionKey ?? "")} parentAgentId=${sessionKeyToAgentId.get(requesterSessionKey ?? "")}`,
    );

    if (childSessionKey && event.agentId) {
      // Pre-populate the child's agentId so subagent-of-subagent tracking works
      // even before the child's first before_prompt_build fires.
      sessionKeyToAgentId.set(childSessionKey, event.agentId);
    }

    let parentHonchoKey: string | undefined;

    if (childSessionKey && requesterSessionKey) {
      const parentAgentId = sessionKeyToAgentId.get(requesterSessionKey);
      if (parentAgentId) {
        subagentParentMap.set(childSessionKey, parentAgentId);
      } else {
        api.logger.warn?.(
          `[honcho] subagent_spawned: could not resolve parent agentId for requesterSessionKey=${requesterSessionKey} — parent observation will be skipped for child ${childSessionKey}`,
        );
      }

      parentHonchoKey = sessionKeyToHonchoKey.get(requesterSessionKey);
      if (parentHonchoKey) {
        subagentParentHonchoSessionMap.set(childSessionKey, parentHonchoKey);
      } else {
        api.logger.warn?.(
          `[honcho] subagent_spawned: could not resolve parent Honcho session key for requesterSessionKey=${requesterSessionKey} — subagent messages will use their own session`,
        );
      }
    }

    // Proactively add the subagent as a peer in the parent session so the
    // parent session knows about it immediately (not just when agent_end fires).
    if (parentHonchoKey && event.agentId) {
      try {
        await state.ensureInitialized();
        const subagentPeer = await state.getAgentPeer(event.agentId);
        const parentSession = await state.honcho.session(parentHonchoKey);
        await parentSession.addPeers([[subagentPeer.id, { observeMe: true, observeOthers: false }]]);
        api.logger.warn?.(`[honcho] subagent_spawned: added peer ${subagentPeer.id} to parent session ${parentHonchoKey}`);
      } catch (e) {
        api.logger.warn?.(`[honcho] subagent_spawned: failed to add subagent peer to parent session: ${e}`);
      }
    }
  });

  api.on("subagent_ended", (event: PluginHookSubagentEndedEvent) => {
    const { targetSessionKey, outcome, reason } = event;
    api.logger.debug?.(
      `[honcho] subagent_ended: ${targetSessionKey} (outcome=${outcome ?? "unknown"}, reason=${reason})`,
    );
    // Clean up ephemeral child session maps. subagentParentMap and
    // subagentParentHonchoSessionMap are read by capture.ts's agent_end handler,
    // which fires AFTER subagent_ended — let capture.ts own that cleanup.
    sessionKeyToAgentId.delete(targetSessionKey);
    sessionKeyToHonchoKey.delete(targetSessionKey);
  });
}
