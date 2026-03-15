import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerCaptureHook } from "../hooks/capture.js";
import { subagentParentMap, subagentParentHonchoSessionMap, sessionKeyToHonchoKey, resolveHonchoKey } from "../hooks/subagent.js";
import type { PluginState } from "../state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type HookHandler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>;

function makeApi() {
  let capturedHandler: HookHandler | undefined;
  const api = {
    on: vi.fn((hookName: string, handler: HookHandler) => {
      if (hookName === "agent_end") capturedHandler = handler;
    }),
    logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  };
  const getHandler = () => {
    if (!capturedHandler) throw new Error("agent_end handler not registered");
    return capturedHandler;
  };
  return { api, getHandler };
}

function makePeer(id: string) {
  return {
    id,
    message: vi.fn((content: string) => ({ peerId: id, content })),
    getMetadata: vi.fn().mockResolvedValue({}),
    setMetadata: vi.fn().mockResolvedValue(undefined),
    context: vi.fn().mockResolvedValue({ peerCard: [], representation: null }),
  };
}

function makeState(overrides: Partial<PluginState> = {}): PluginState {
  const ownerPeer = makePeer("owner");
  const agentPeer = makePeer("agent-worker");
  const parentPeer = makePeer("agent-orchestrator");

  const mockSession = {
    context: vi.fn().mockResolvedValue({}),
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
    getAgentPeer: vi.fn().mockImplementation(async (id?: string) => {
      if (!id || id === "worker") return agentPeer;
      if (id === "orchestrator") return parentPeer;
      return agentPeer;
    }),
    resolveDefaultAgentId: vi.fn().mockReturnValue("worker"),
    ...overrides,
  } as unknown as PluginState;
}

const SUBAGENT_SESSION_KEY = "agent:worker:subagent:abc-123";
const MAIN_SESSION_KEY = "agent:worker:main";
const PARENT_HONCHO_KEY = "agent-worker-main-discord";

const makeMessages = () => [
  { role: "user", content: "[Subagent Task]: research open PRs" },
  { role: "assistant", content: "I will research the open PRs now." },
];

const makeCtx = (sessionKey: string, agentId = "worker") => ({
  sessionKey,
  agentId,
  messageProvider: "discord",
});

const makeEvent = (overrides: Record<string, unknown> = {}) => ({
  messages: makeMessages(),
  success: true,
  ...overrides,
});

async function getSession(state: PluginState) {
  return (state.honcho.session as ReturnType<typeof vi.fn>).mock.results[0]?.value;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerCaptureHook — subagent peer configs", () => {
  beforeEach(() => {
    subagentParentMap.clear();
    subagentParentHonchoSessionMap.clear();
    sessionKeyToHonchoKey.clear();
  });

  // --- Writing to parent session (normal path) ---

  it("writes subagent messages to parent session when parent Honcho key is known", async () => {
    subagentParentHonchoSessionMap.set(SUBAGENT_SESSION_KEY, PARENT_HONCHO_KEY);
    const { api, getHandler } = makeApi();
    const state = makeState();
    registerCaptureHook(api as never, state);

    await getHandler()(makeEvent(), makeCtx(SUBAGENT_SESSION_KEY));

    const sessionCall = (state.honcho.session as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sessionCall[0]).toBe(PARENT_HONCHO_KEY);
  });

  it("sets subagent peer observeMe=true, observeOthers=false in parent session (observable, no self-obs)", async () => {
    subagentParentHonchoSessionMap.set(SUBAGENT_SESSION_KEY, PARENT_HONCHO_KEY);
    const { api, getHandler } = makeApi();
    const state = makeState();
    registerCaptureHook(api as never, state);

    await getHandler()(makeEvent(), makeCtx(SUBAGENT_SESSION_KEY));

    const session = await getSession(state);
    const peerConfigs: Array<[string, { observeMe: boolean; observeOthers: boolean }]> = session.addPeers.mock.calls[0][0];
    const agentConfig = peerConfigs.find(([id]) => id === "agent-worker");
    expect(agentConfig).toBeDefined();
    expect(agentConfig![1].observeMe).toBe(true);   // observable by parent
    expect(agentConfig![1].observeOthers).toBe(false); // no self-observation
  });

  it("sets parentPeer observeOthers=true in parent session when parent is known", async () => {
    subagentParentMap.set(SUBAGENT_SESSION_KEY, "orchestrator");
    subagentParentHonchoSessionMap.set(SUBAGENT_SESSION_KEY, PARENT_HONCHO_KEY);
    const { api, getHandler } = makeApi();
    const state = makeState();
    registerCaptureHook(api as never, state);

    await getHandler()(makeEvent(), makeCtx(SUBAGENT_SESSION_KEY));

    const session = await getSession(state);
    const peerConfigs: Array<[string, { observeMe: boolean; observeOthers: boolean }]> = session.addPeers.mock.calls[0][0];
    const parentConfig = peerConfigs.find(([id]) => id === "agent-orchestrator");
    expect(parentConfig).toBeDefined();
    // Parent observes (draws conclusions about owner + subagent), is not itself observable.
    expect(parentConfig![1].observeOthers).toBe(true);
    expect(parentConfig![1].observeMe).toBe(false);
  });

  // --- Fallback: own session (parent Honcho key not known) ---

  it("falls back to own session when parent Honcho key is unknown", async () => {
    // No subagentParentHonchoSessionMap entry
    const { api, getHandler } = makeApi();
    const state = makeState();
    registerCaptureHook(api as never, state);

    await getHandler()(makeEvent(), makeCtx(SUBAGENT_SESSION_KEY));

    const sessionCall = (state.honcho.session as ReturnType<typeof vi.fn>).mock.calls[0];
    // Should use the subagent's own normalized session key, not a parent key
    expect(sessionCall[0]).not.toBe(PARENT_HONCHO_KEY);
  });

  it("fallback: does NOT set ownerPeer observeMe=true for subagent sessions", async () => {
    const { api, getHandler } = makeApi();
    const state = makeState();
    registerCaptureHook(api as never, state);

    await getHandler()(makeEvent(), makeCtx(SUBAGENT_SESSION_KEY));

    const session = await getSession(state);
    const peerConfigs: Array<[string, { observeMe: boolean }]> = session.addPeers.mock.calls[0][0];
    const ownerConfig = peerConfigs.find(([id]) => id === "owner");
    expect(ownerConfig).toBeDefined();
    expect(ownerConfig![1].observeMe).toBe(false);
  });

  it("fallback: sets agentPeer observeMe=false (no self-observation)", async () => {
    const { api, getHandler } = makeApi();
    const state = makeState();
    registerCaptureHook(api as never, state);

    await getHandler()(makeEvent(), makeCtx(SUBAGENT_SESSION_KEY));

    const session = await getSession(state);
    const peerConfigs: Array<[string, { observeMe: boolean; observeOthers: boolean }]> = session.addPeers.mock.calls[0][0];
    const agentConfig = peerConfigs.find(([id]) => id === "agent-worker");
    expect(agentConfig).toBeDefined();
    expect(agentConfig![1].observeMe).toBe(false);
    expect(agentConfig![1].observeOthers).toBe(true);
  });

  it("uses canonical Honcho key when messageProvider is absent (continuation turn)", async () => {
    // Simulate: first turn set the canonical key (with provider), then a
    // provider-less continuation turn fires (parent resuming after subagent).
    const BASE_SESSION_KEY = "agent:worker:main";
    const CANONICAL_KEY = "agent-worker-main-discord";
    sessionKeyToHonchoKey.set(BASE_SESSION_KEY, CANONICAL_KEY);

    const { api, getHandler } = makeApi();
    const state = makeState();
    registerCaptureHook(api as never, state);

    // ctx has no messageProvider — simulates continuation turn
    await getHandler()(makeEvent(), { sessionKey: BASE_SESSION_KEY, agentId: "worker" });

    const sessionCall = (state.honcho.session as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sessionCall[0]).toBe(CANONICAL_KEY);
  });

  it("sets ownerPeer observeMe=true for main agent sessions", async () => {
    const { api, getHandler } = makeApi();
    const state = makeState();
    registerCaptureHook(api as never, state);

    await getHandler()(makeEvent(), makeCtx(MAIN_SESSION_KEY));

    const session = await getSession(state);
    const peerConfigs: Array<[string, { observeMe: boolean }]> = session.addPeers.mock.calls[0][0];
    const ownerConfig = peerConfigs.find(([id]) => id === "owner");
    expect(ownerConfig).toBeDefined();
    expect(ownerConfig![1].observeMe).toBe(true);
  });
});

describe("registerCaptureHook — subagent message attribution", () => {
  beforeEach(() => {
    subagentParentMap.clear();
    subagentParentHonchoSessionMap.clear();
    sessionKeyToHonchoKey.clear();
  });

  // --- Parent-session path (normal: subagentParentHonchoSessionMap is set) ---

  it("writes to parent session: user message attributed to parentPeer", async () => {
    subagentParentMap.set(SUBAGENT_SESSION_KEY, "orchestrator");
    subagentParentHonchoSessionMap.set(SUBAGENT_SESSION_KEY, PARENT_HONCHO_KEY);
    const { api, getHandler } = makeApi();
    const state = makeState();
    registerCaptureHook(api as never, state);

    await getHandler()(makeEvent(), makeCtx(SUBAGENT_SESSION_KEY));

    const parentPeer = await state.getAgentPeer("orchestrator");
    const parentCalls = (parentPeer.message as ReturnType<typeof vi.fn>).mock.calls;
    expect(parentCalls.some(([content]: [string]) => content.includes("research open PRs"))).toBe(true);
    expect((state.ownerPeer as ReturnType<typeof makePeer>).message).not.toHaveBeenCalled();
  });

  it("writes to parent session: assistant message attributed to agentPeer (subagent)", async () => {
    subagentParentMap.set(SUBAGENT_SESSION_KEY, "orchestrator");
    subagentParentHonchoSessionMap.set(SUBAGENT_SESSION_KEY, PARENT_HONCHO_KEY);
    const { api, getHandler } = makeApi();
    const state = makeState();
    registerCaptureHook(api as never, state);

    await getHandler()(makeEvent(), makeCtx(SUBAGENT_SESSION_KEY));

    const agentPeer = await state.getAgentPeer("worker");
    const agentCalls = (agentPeer.message as ReturnType<typeof vi.fn>).mock.calls;
    expect(agentCalls.some(([content]: [string]) => content.includes("I will research"))).toBe(true);
  });

  it("writes to parent session: maps are cleaned up in finally", async () => {
    subagentParentMap.set(SUBAGENT_SESSION_KEY, "orchestrator");
    subagentParentHonchoSessionMap.set(SUBAGENT_SESSION_KEY, PARENT_HONCHO_KEY);
    const { api, getHandler } = makeApi();
    const state = makeState();
    registerCaptureHook(api as never, state);

    await getHandler()(makeEvent(), makeCtx(SUBAGENT_SESSION_KEY));

    expect(subagentParentMap.has(SUBAGENT_SESSION_KEY)).toBe(false);
    expect(subagentParentHonchoSessionMap.has(SUBAGENT_SESSION_KEY)).toBe(false);
  });

  // --- Fallback path (subagentParentHonchoSessionMap not set) ---

  it("fallback: user message attributed to parentPeer (not ownerPeer)", async () => {
    subagentParentMap.set(SUBAGENT_SESSION_KEY, "orchestrator");
    // No subagentParentHonchoSessionMap entry → fallback to own session
    const { api, getHandler } = makeApi();
    const state = makeState();
    registerCaptureHook(api as never, state);

    await getHandler()(makeEvent(), makeCtx(SUBAGENT_SESSION_KEY));

    const parentPeer = await state.getAgentPeer("orchestrator");
    const parentCalls = (parentPeer.message as ReturnType<typeof vi.fn>).mock.calls;
    expect(parentCalls.some(([content]: [string]) => content.includes("research open PRs"))).toBe(true);
    expect((state.ownerPeer as ReturnType<typeof makePeer>).message).not.toHaveBeenCalled();
  });

  it("fallback: user message attributed to agentPeer when no parent known", async () => {
    // Neither map set — same-agent spawn or unknown parent
    const { api, getHandler } = makeApi();
    const state = makeState();
    registerCaptureHook(api as never, state);

    await getHandler()(makeEvent(), makeCtx(SUBAGENT_SESSION_KEY));

    expect((state.ownerPeer as ReturnType<typeof makePeer>).message).not.toHaveBeenCalled();
  });

  // --- Main agent ---

  it("attributes user messages to ownerPeer for main agent sessions", async () => {
    const { api, getHandler } = makeApi();
    const state = makeState();
    registerCaptureHook(api as never, state);

    await getHandler()(makeEvent(), makeCtx(MAIN_SESSION_KEY));

    const ownerCalls = (state.ownerPeer as ReturnType<typeof makePeer>).message.mock.calls;
    expect(ownerCalls.some(([content]: [string]) => content.includes("research open PRs"))).toBe(true);
  });

  it("attributes assistant messages to agentPeer for main agent sessions", async () => {
    const { api, getHandler } = makeApi();
    const state = makeState();
    registerCaptureHook(api as never, state);

    await getHandler()(makeEvent(), makeCtx(MAIN_SESSION_KEY));

    const agentPeer = await state.getAgentPeer("worker");
    const agentCalls = (agentPeer.message as ReturnType<typeof vi.fn>).mock.calls;
    expect(agentCalls.some(([content]: [string]) => content.includes("I will research"))).toBe(true);
  });
});
