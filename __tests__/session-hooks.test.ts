/**
 * Integration: session_start/session_end hooks + context cache
 *
 * Requires a live Honcho workspace (HONCHO_API_KEY).
 * Seeds a session with messages so session_start has real history to load.
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

maybe("session hooks: context cache", () => {
  let api: ReturnType<typeof makeApi>;
  let state: ReturnType<typeof createPluginState>;

  beforeAll(async () => {
    // Seed some history so session_start has real context to load.
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
    state = createPluginState(api as never);
    registerSessionHooks(api as never, state);
    registerContextHook(api as never, state);
  }, 30_000);

  it("session_start populates the context cache", async () => {
    await api.fire("session_start", SESSION_EVENT, SESSION_CTX);
    expect(state.contextCache.has(SESSION_KEY)).toBe(true);
  });

  it("before_prompt_build returns prependContext (not systemPrompt) from cache", async () => {
    // Manually prime cache with known content — Honcho won't produce a representation
    // for a freshly seeded session without a dream, so we control the value here.
    const fakeContext = "## User Memory Context\n\nKey facts:\n• Prefers TypeScript";
    state.contextCache.set(SESSION_KEY, fakeContext);

    const result = await api.fireCapture(
      "before_prompt_build",
      { prompt: "hello", messages: [] },
      SESSION_CTX,
    ) as Record<string, unknown> | undefined;

    expect(result).toBeDefined();
    expect(result).not.toHaveProperty("systemPrompt");
    expect(result).toHaveProperty("prependContext", fakeContext);
    // Cache must be unchanged (not evicted or mutated by context hook).
    expect(state.contextCache.get(SESSION_KEY)).toBe(fakeContext);
  });

  it("before_prompt_build returns undefined when cache is null (no history)", async () => {
    state.contextCache.set(SESSION_KEY, null);

    const result = await api.fireCapture(
      "before_prompt_build",
      { prompt: "hello", messages: [] },
      SESSION_CTX,
    );

    expect(result).toBeUndefined();
  });

  it("session_end evicts the cache entry", async () => {
    await api.fire("session_end", { ...SESSION_EVENT, messageCount: 4 }, SESSION_CTX);
    expect(state.contextCache.has(SESSION_KEY)).toBe(false);
  });
});

maybeDream("session hooks: dreamOnSessionEnd", () => {
  it("scheduleDream completes without error", async () => {
    const api = makeApi({ dreamOnSessionEnd: true });
    const state = createPluginState(api as never);
    registerSessionHooks(api as never, state);

    // Prime the cache so session_end has an initialized state to work with.
    await api.fire("session_start", SESSION_EVENT, SESSION_CTX);
    await expect(
      api.fire("session_end", { ...SESSION_EVENT, messageCount: 4 }, SESSION_CTX),
    ).resolves.not.toThrow();
  }, 30_000);
});
