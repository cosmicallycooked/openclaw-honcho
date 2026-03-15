// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";
import { OWNER_ID } from "../state.js";
import {
  buildSessionKey,
  isSubagentSession,
  extractMessages,
} from "../helpers.js";
// buildSessionKey is still used for subagent own-session keys (no TS stamp needed)
import { subagentParentMap, sessionKeyToAgentId, subagentParentHonchoSessionMap, resolveHonchoKey } from "./subagent.js";

export function registerCaptureHook(api: OpenClawPluginApi, state: PluginState): void {
  api.on("agent_end", async (event, ctx) => {
    if (!event.messages?.length) return;

    // resolveHonchoKey returns the canonical (timestamped, provider-qualified) key
    // stored from before_prompt_build — covers both provider turns and
    // provider-less continuation turns (parent resuming after subagent).
    const sessionKey = isSubagentSession(ctx) ? buildSessionKey(ctx) : resolveHonchoKey(ctx);
    const isSubagent = isSubagentSession(ctx);
    // For subagent sessions prefer the agentId captured at subagent_spawned time
    // (event.agentId for the child), since ctx.agentId at agent_end may reflect
    // the parent's agent config rather than the spawned child's.
    const agentId =
      (isSubagent ? sessionKeyToAgentId.get(ctx.sessionKey ?? "") : undefined)
      ?? ctx.agentId
      ?? state.resolveDefaultAgentId();

    api.logger.warn?.(
      `[honcho] agent_end: sessionKey=${ctx.sessionKey} honchoKey=${sessionKey} agentId=${agentId} ctx.agentId=${ctx.agentId} isSubagent=${isSubagent} parentHonchoKey=${subagentParentHonchoSessionMap.get(ctx.sessionKey ?? "")} parentAgentId=${subagentParentMap.get(ctx.sessionKey ?? "")}`,
    );
    const parentAgentId = isSubagent ? subagentParentMap.get(ctx.sessionKey ?? "") : undefined;

    try {
      await state.ensureInitialized();
      const agentPeer = await state.getAgentPeer(agentId);
      const parentPeer =
        isSubagent && parentAgentId && parentAgentId !== agentId
          ? await state.getAgentPeer(parentAgentId)
          : null;

      // Peer observation semantics — agent observes owner, never itself:
      //   owner:  observeMe=true,  observeOthers=false  → agent draws conclusions about user
      //   agent:  observeMe=false, observeOthers=true   → agent observes, is not observed
      // A peer never has both observeMe and observeOthers true simultaneously,
      // which would cause it to observe itself and generate self-referential conclusions.
      //
      // For subagent sessions: messages are written to the PARENT session so all
      // context stays together. The subagent peer is made observable (observeMe=true,
      // observeOthers=false) so the parent agent draws conclusions about what it did.

      // For subagent sessions, write into the parent's Honcho session so conclusions
      // and context span the full conversation rather than being fragmented.
      const parentHonchoSessionKey = isSubagent
        ? subagentParentHonchoSessionMap.get(ctx.sessionKey ?? "")
        : undefined;
      const targetSessionKey = parentHonchoSessionKey ?? sessionKey;
      const writingToParentSession = isSubagent && !!parentHonchoSessionKey;

      const sessionMeta: Record<string, unknown> = { agentId };
      const session = await state.honcho.session(targetSessionKey, { metadata: sessionMeta });

      // turnStartIndex is keyed by the subagent's own session key (set in before_prompt_build).
      const turnStartIndex = Math.min(
        Math.max(state.turnStartIndex.get(sessionKey) ?? 0, 0),
        event.messages.length,
      );

      // Only read/write lastSavedIndex for sessions we own (not when writing to parent session).
      let startIndex = turnStartIndex;
      if (!writingToParentSession) {
        const meta = await session.getMetadata();
        const existingMeta: Record<string, unknown> =
          meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {};
        const rawLastSavedIndex =
          typeof existingMeta.lastSavedIndex === "number" ? existingMeta.lastSavedIndex : 0;
        const lastSavedIndex = Math.min(Math.max(rawLastSavedIndex, 0), event.messages.length);
        startIndex = Math.max(turnStartIndex, lastSavedIndex);
      }

      const peerConfigs: Array<[string, { observeMe: boolean; observeOthers: boolean }]> =
        writingToParentSession
          ? [
              [OWNER_ID, { observeMe: true, observeOthers: false }],
              // Parent agent observes owner + subagent; is not itself observed.
              ...(parentPeer
                ? [[parentPeer.id, { observeMe: false, observeOthers: true }] as [string, { observeMe: boolean; observeOthers: boolean }]]
                : []),
              // Subagent: observable so parent draws conclusions about what it did;
              // does NOT observe to avoid self-referential conclusions.
              [agentPeer.id, { observeMe: true, observeOthers: false }],
            ]
          : isSubagent
            ? [
                // Fallback: parent session key not known, use own session.
                [agentPeer.id, { observeMe: false, observeOthers: true }],
                [OWNER_ID, { observeMe: false, observeOthers: false }],
                ...(parentPeer
                  ? [[parentPeer.id, { observeMe: true, observeOthers: false }] as [string, { observeMe: boolean; observeOthers: boolean }]]
                  : []),
              ]
            : [
                [OWNER_ID, { observeMe: true, observeOthers: false }],
                [agentPeer.id, { observeMe: false, observeOthers: true }],
              ];

      await session.addPeers(peerConfigs);

      if (event.messages.length <= startIndex) {
        api.logger.debug?.("No new messages to save");
        return;
      }

      const newRawMessages = event.messages.slice(startIndex);
      // "user" role in a subagent session = task instructions from the parent agent.
      const userPeer = isSubagent ? (parentPeer ?? agentPeer) : state.ownerPeer!;
      const messages = extractMessages(newRawMessages, userPeer, agentPeer, state.cfg.noisePatterns);

      if (messages.length === 0) {
        if (!writingToParentSession) {
          const meta = await session.getMetadata();
          const existingMeta = meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {};
          await session.setMetadata({ ...existingMeta, ...sessionMeta, lastSavedIndex: event.messages.length });
        }
        return;
      }

      await session.addMessages(messages);

      // Only update lastSavedIndex for sessions we own; parent session manages its own index.
      if (!writingToParentSession) {
        const meta = await session.getMetadata();
        const existingMeta = meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {};
        await session.setMetadata({ ...existingMeta, ...sessionMeta, lastSavedIndex: event.messages.length });
      }
    } catch (error) {
      api.logger.error(`[honcho] Failed to save messages to Honcho: ${error}`);
      if (error instanceof Error) {
        api.logger.error(`[honcho] Stack: ${error.stack}`);
        const anyError = error as unknown as Record<string, unknown>;
        if (anyError.status) api.logger.error(`[honcho] Status: ${anyError.status}`);
        if (anyError.body) api.logger.error(`[honcho] Body: ${JSON.stringify(anyError.body)}`);
      }
    } finally {
      state.turnStartIndex.delete(sessionKey);
      if (isSubagent) {
        // capture.ts is the sole consumer — clean up here, not in subagent.ts,
        // so subagent_ended (which fires before agent_end) doesn't clear maps early.
        subagentParentMap.delete(ctx.sessionKey ?? "");
        subagentParentHonchoSessionMap.delete(ctx.sessionKey ?? "");
      }
    }
  });
}
