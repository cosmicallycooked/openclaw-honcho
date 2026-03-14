import { describe, it, expect, vi } from "vitest";
import { registerContextHook } from "../hooks/context.js";
import type { PluginState } from "../state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type HookHandler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>;

function makeApi() {
  let capturedHandler: HookHandler | undefined;
  const api = {
    on: vi.fn((hookName: string, handler: HookHandler) => {
      if (hookName === "before_prompt_build") capturedHandler = handler;
    }),
    logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
    config: { agents: { list: [{ id: "worker", default: true }] } },
    pluginConfig: {},
  };
  const getHandler = () => {
    if (!capturedHandler) throw new Error("before_prompt_build handler not registered");
    return capturedHandler;
  };
  return { api, getHandler };
}

function makePeer(id: string, contextResult: { peerCard?: string[]; representation?: string }) {
  return {
    id,
    context: vi.fn().mockResolvedValue(contextResult),
    getMetadata: vi.fn().mockResolvedValue({}),
    setMetadata: vi.fn().mockResolvedValue(undefined),
    message: vi.fn(),
  };
}

function makeState(overrides: Partial<PluginState> = {}): PluginState {
  const ownerPeer = makePeer("owner", {});
  const agentPeer = makePeer("agent-worker", {
    peerCard: ["I specialize in research tasks"],
    representation: "This agent has completed 12 prior research sessions.",
  });

  const sessionContextResult = {
    peerCard: ["user prefers concise answers"],
    peerRepresentation: "User context from session",
    summary: { content: "Earlier in conversation: user asked about X" },
  };

  const mockSession = {
    context: vi.fn().mockResolvedValue(sessionContextResult),
    getMetadata: vi.fn().mockResolvedValue({}),
    setMetadata: vi.fn().mockResolvedValue(undefined),
    addMessages: vi.fn().mockResolvedValue(undefined),
    addPeers: vi.fn().mockResolvedValue(undefined),
  };

  const mockHoncho = {
    session: vi.fn().mockResolvedValue(mockSession),
    peer: vi.fn().mockResolvedValue(ownerPeer),
    getMetadata: vi.fn().mockResolvedValue({}),
    setMetadata: vi.fn().mockResolvedValue(undefined),
    peers: vi.fn().mockReturnValue([]),
  };

  return {
    honcho: mockHoncho as unknown as PluginState["honcho"],
    cfg: {
      apiKey: "test",
      workspaceId: "test-workspace",
      baseUrl: "http://localhost",
      contextTokens: 2000,
      maxConclusions: 10,
      ownerObserveOthers: false,
      dreamOnSessionEnd: false,
      noisePatterns: [],
    } as PluginState["cfg"],
    ownerPeer: ownerPeer as unknown as PluginState["ownerPeer"],
    agentPeers: new Map(),
    agentPeerMap: {},
    turnStartIndex: new Map(),
    initialized: true,
    api: {} as PluginState["api"],
    ensureInitialized: vi.fn().mockResolvedValue(undefined),
    getAgentPeer: vi.fn().mockResolvedValue(agentPeer),
    resolveDefaultAgentId: vi.fn().mockReturnValue("worker"),
    ...overrides,
  } as unknown as PluginState;
}

const SUBAGENT_SESSION_KEY = "agent:worker:subagent:abc-123";
const MAIN_SESSION_KEY = "agent:worker:main";

const makeEvent = (overrides: Record<string, unknown> = {}) => ({
  prompt: "Do the research task now",
  messages: [{ role: "user", content: "hello" }],
  ...overrides,
});

const makeCtx = (sessionKey: string, agentId = "worker") => ({
  sessionKey,
  agentId,
  messageProvider: "discord",
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerContextHook — subagent before_prompt_build", () => {
  it("calls agentPeer.context() with no arguments — own context, no target peer", async () => {
    const { api, getHandler } = makeApi();
    const state = makeState();
    const agentPeer = await state.getAgentPeer();
    registerContextHook(api as never, state);

    await getHandler()(makeEvent(), makeCtx(SUBAGENT_SESSION_KEY));

    expect(agentPeer.context).toHaveBeenCalledWith();
  });

  it("injects agent own context into prependContext", async () => {
    const { api, getHandler } = makeApi();
    const state = makeState();
    registerContextHook(api as never, state);

    const result = await getHandler()(makeEvent(), makeCtx(SUBAGENT_SESSION_KEY)) as Record<string, string>;

    expect(result?.prependContext).toContain("I specialize in research tasks");
    expect(result?.prependContext).toContain("Subagent context:");
    expect(result?.prependContext).toContain("This agent has completed 12 prior research sessions.");
  });

  it("returns undefined when agent has no prior context", async () => {
    const { api, getHandler } = makeApi();
    const emptyPeer = makePeer("agent-worker", { peerCard: [], representation: undefined });
    const state = makeState({ getAgentPeer: vi.fn().mockResolvedValue(emptyPeer) });
    registerContextHook(api as never, state);

    const result = await getHandler()(makeEvent(), makeCtx(SUBAGENT_SESSION_KEY));

    expect(result).toBeUndefined();
  });

  it("skips context injection when prompt is too short", async () => {
    const { api, getHandler } = makeApi();
    const state = makeState();
    registerContextHook(api as never, state);

    const result = await getHandler()(makeEvent({ prompt: "hi" }), makeCtx(SUBAGENT_SESSION_KEY));

    expect(result).toBeUndefined();
    expect(state.ensureInitialized).not.toHaveBeenCalled();
  });
});

describe("registerContextHook — main agent before_prompt_build", () => {
  it("uses session.context() with owner as target", async () => {
    const { api, getHandler } = makeApi();
    const state = makeState();
    registerContextHook(api as never, state);

    await getHandler()(makeEvent(), makeCtx(MAIN_SESSION_KEY));

    expect(state.honcho.session).toHaveBeenCalled();
    const session = await (state.honcho.session as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(session.context).toHaveBeenCalledWith(
      expect.objectContaining({ summary: true, peerTarget: state.ownerPeer }),
    );
  });

  it("does NOT call agentPeer.context() for non-subagent sessions", async () => {
    const { api, getHandler } = makeApi();
    const state = makeState();
    const agentPeer = await state.getAgentPeer();
    registerContextHook(api as never, state);

    await getHandler()(makeEvent(), makeCtx(MAIN_SESSION_KEY));

    expect(agentPeer.context).not.toHaveBeenCalled();
  });
});
