// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";
import { buildSessionKey, isSubagentSession } from "../helpers.js";
import { resolveHonchoKey } from "./subagent.js";

export function registerSessionHooks(api: OpenClawPluginApi, state: PluginState): void {
  api.on("session_end", async (_event, ctx) => {
    if (isSubagentSession(ctx)) return;
    const sessionKey = resolveHonchoKey(ctx);

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
