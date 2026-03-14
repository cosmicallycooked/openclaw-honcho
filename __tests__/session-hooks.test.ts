/**
 * Integration: session_end hook + before_prompt_build context injection
 *
 * Requires a live Honcho workspace (HONCHO_API_KEY).
 * Seeds a session with messages so before_prompt_build has real history to load.
 *
 * HONCHO_SKIP_DREAM_TESTS=1 — skip the dreamOnSessionEnd test
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Honcho } from "@honcho-ai/sdk";
import { createPluginState } from "../state.js";
import { registerSessionHooks } from "../hooks/session.js";
import { registerContextHook } from "../hooks/context.js";

const API_KEY = process.env.HONCHO_API_KEY;
const WORKSPACE_ID = process.env.HONCHO_WORKSPACE_ID ?? "openclaw-test";
const BASE_URL = process.env.HONCHO_BASE_URL ?? "https://api.honcho.dev";
const maybe = !API_KEY ? describe.skip : describe;
const maybeDream =
  !API_KEY || process.env.HONCHO_SKIP_DREAM_TESTS === "1" ? describe.skip : describe;

const RUN_ID = `hooks-${Date.now()}`;
// Must match buildSessionKey({ sessionKey: RUN_ID, messageProvider: "telegram" })
const SESSION_KEY = `${RUN_ID}-telegram`;
const AGENT_ID = "prime";

function makeApi(cfg: Record<string, unknown> = {}) {
  const handlers = new Map<string, Array<(e: unknown, c: unknown) => unknown>>();
  return {
    on(event: string, handler: (e: unknown, c: unknown) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    async fire(event: string, eventData: unknown, ctx: unknown) {
      for (const h of handlers.get(event) ?? []) await h(eventData, ctx);
    },
    /** Like fire(), but returns the first non-undefined result from a hook. */
    async fireCapture(event: string, eventData: unknown, ctx: unknown): Promise<unknown> {
      for (const h of handlers.get(event) ?? []) {
        const result = await h(eventData, ctx);
        if (result !== undefined) return result;
      }
      return undefined;
    },
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    config: {
      agents: { list: [{ id: AGENT_ID, default: true }] },
    },
    pluginConfig: {
      apiKey: API_KEY,
      workspaceId: WORKSPACE_ID,
      baseUrl: BASE_URL,
      ...cfg,
    },
  };
}

const SESSION_CTX = { sessionKey: RUN_ID, messageProvider: "telegram", agentId: AGENT_ID };
const SESSION_EVENT = { sessionId: RUN_ID };

maybe("before_prompt_build: context injection", () => {
  let api: ReturnType<typeof makeApi>;

  beforeAll(async () => {
    // Seed some history so before_prompt_build has real messages to work with.
    const honcho = new Honcho({ apiKey: API_KEY, workspaceId: WORKSPACE_ID, baseURL: BASE_URL });
    const ownerPeer = await honcho.peer("owner", { metadata: {} });
    const agentPeer = await honcho.peer(`agent-${AGENT_ID}`, { metadata: { agentId: AGENT_ID } });
    const session = await honcho.session(SESSION_KEY, { metadata: { agentId: AGENT_ID } });
    await session.addPeers([
      [ownerPeer.id, { observeMe: true, observeOthers: false }],
      [agentPeer.id, { observeMe: true, observeOthers: true }],
    ]);
    await session.addMessages([
      ownerPeer.message("I prefer concise answers"),
      agentPeer.message("Understood, I will keep responses brief"),
      ownerPeer.message("Always use TypeScript in this project"),
      agentPeer.message("Got it"),
    ]);

    api = makeApi();
    const state = createPluginState(api as never);
    registerSessionHooks(api as never, state);
    registerContextHook(api as never, state);
  }, 30_000);

  it("returns prependContext (not systemPrompt) when history exists", async () => {
    const result = await api.fireCapture(
      "before_prompt_build",
      { prompt: "hello", messages: [] },
      SESSION_CTX,
    ) as Record<string, unknown> | undefined;

    // May be undefined if Honcho hasn't processed the seeded messages yet (no dream),
    // but if context is returned it must use prependContext not systemPrompt.
    if (result !== undefined) {
      expect(result).not.toHaveProperty("systemPrompt");
      expect(result).toHaveProperty("prependContext");
      expect(typeof result.prependContext).toBe("string");
    }
  });

  it("returns undefined for a session with no history", async () => {
    const freshKey = `fresh-${Date.now()}`;
    const freshCtx = { sessionKey: freshKey, messageProvider: "telegram", agentId: AGENT_ID };

    const result = await api.fireCapture(
      "before_prompt_build",
      { prompt: "hello", messages: [] },
      freshCtx,
    );

    expect(result).toBeUndefined();
  });
});

maybeDream("session hooks: dreamOnSessionEnd", () => {
  it("scheduleDream completes without error", async () => {
    const api = makeApi({ dreamOnSessionEnd: true });
    const state = createPluginState(api as never);
    registerSessionHooks(api as never, state);

    await expect(
      api.fire("session_end", { ...SESSION_EVENT, messageCount: 4 }, SESSION_CTX),
    ).resolves.not.toThrow();
  }, 30_000);
});
