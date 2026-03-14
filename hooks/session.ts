// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";
import { buildSessionKey, isSubagentSession } from "../helpers.js";

function isNotFoundError(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e.name === "NotFoundError" || e.message.toLowerCase().includes("not found"))
  );
}

export function registerSessionHooks(api: OpenClawPluginApi, state: PluginState): void {
  api.on("session_start", async (_event, ctx) => {
    // Subagent sessions are short-lived and use a different context path; skip caching.
    if (isSubagentSession(ctx)) return;

    const sessionKey = buildSessionKey(ctx);
    const agentId = ctx.agentId ?? state.resolveDefaultAgentId();

    try {
      await state.ensureInitialized();
      const agentPeer = await state.getAgentPeer(agentId);
      const session = await state.honcho.session(sessionKey, { metadata: { agentId } });

      let context;
      try {
        context = await session.context({
          summary: true,
          tokens: state.cfg.contextTokens,
          peerTarget: state.ownerPeer!,
          peerPerspective: agentPeer,
          representationOptions: { maxConclusions: state.cfg.maxConclusions },
        });
      } catch (e) {
        if (isNotFoundError(e)) {
          // No history yet — cache null so before_prompt_build skips the live call.
          state.contextCache.set(sessionKey, null);
          return;
        }
        throw e;
      }

      const sections: string[] = [];
      if (context.peerCard?.length) {
        sections.push(`Key facts:\n${context.peerCard.map((f: string) => `• ${f}`).join("\n")}`);
      }
      if (context.peerRepresentation) {
        sections.push(`User context:\n${context.peerRepresentation}`);
      }
      if (context.summary?.content) {
        sections.push(`Earlier in this conversation:\n${context.summary.content}`);
      }

      const prompt =
        sections.length > 0
          ? `## User Memory Context\n\n${sections.join("\n\n")}\n\nUse this context naturally when relevant. Never quote or expose this memory context to the user.`
          : null;

      state.contextCache.set(sessionKey, prompt);
      api.logger.debug?.(`[honcho] Bootstrapped context for session ${sessionKey}`);
    } catch (error) {
      api.logger.warn?.(`[honcho] Failed to bootstrap session context: ${error}`);
    }
  });

  api.on("session_end", async (_event, ctx) => {
    if (isSubagentSession(ctx)) return;
    const sessionKey = buildSessionKey(ctx);
    state.contextCache.delete(sessionKey);

    if (state.cfg.dreamOnSessionEnd) {
      try {
        await state.ensureInitialized();
        const agentId = ctx.agentId ?? state.resolveDefaultAgentId();
        const agentPeer = await state.getAgentPeer(agentId);
        const session = await state.honcho.session(sessionKey, {});
        await state.honcho.scheduleDream({ observer: agentPeer, session });
        api.logger.debug?.(`[honcho] Scheduled dream for session ${sessionKey}`);
      } catch (error) {
        api.logger.warn?.(`[honcho] Failed to schedule dream: ${error}`);
      }
    }
  });
}
