import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerCaptureHook } from "../hooks/capture.js";
import { subagentParentMap } from "../hooks/subagent.js";
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
  });

  it("does NOT set ownerPeer observeMe=true for subagent sessions", async () => {
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

  it("sets agentPeer observeMe=true for subagent sessions", async () => {
    const { api, getHandler } = makeApi();
    const state = makeState();
    registerCaptureHook(api as never, state);

    await getHandler()(makeEvent(), makeCtx(SUBAGENT_SESSION_KEY));

    const session = await getSession(state);
    const peerConfigs: Array<[string, { observeMe: boolean }]> = session.addPeers.mock.calls[0][0];
    const agentConfig = peerConfigs.find(([id]) => id === "agent-worker");
    expect(agentConfig).toBeDefined();
    expect(agentConfig![1].observeMe).toBe(true);
  });

  it("sets parentPeer observeMe=true when parent is known", async () => {
    subagentParentMap.set(SUBAGENT_SESSION_KEY, "orchestrator");
    const { api, getHandler } = makeApi();
    const state = makeState();
    registerCaptureHook(api as never, state);

    await getHandler()(makeEvent(), makeCtx(SUBAGENT_SESSION_KEY));

    const session = await getSession(state);
    const peerConfigs: Array<[string, { observeMe: boolean }]> = session.addPeers.mock.calls[0][0];
    const parentConfig = peerConfigs.find(([id]) => id === "agent-orchestrator");
    expect(parentConfig).toBeDefined();
    expect(parentConfig![1].observeMe).toBe(true);
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
  });

  it("attributes user messages to parentPeer (not ownerPeer) in subagent sessions", async () => {
    subagentParentMap.set(SUBAGENT_SESSION_KEY, "orchestrator");
    const { api, getHandler } = makeApi();
    const state = makeState();
    registerCaptureHook(api as never, state);

    await getHandler()(makeEvent(), makeCtx(SUBAGENT_SESSION_KEY));

    // parentPeer.message should have been called for the user-role message
    const parentPeer = await state.getAgentPeer("orchestrator");
    const parentCalls = (parentPeer.message as ReturnType<typeof vi.fn>).mock.calls;
    expect(parentCalls.some(([content]: [string]) => content.includes("research open PRs"))).toBe(true);
    // ownerPeer.message should NOT have been called
    expect((state.ownerPeer as ReturnType<typeof makePeer>).message).not.toHaveBeenCalled();
  });

  it("attributes user messages to agentPeer when no parent is known", async () => {
    // No entry in subagentParentMap — same-agent spawn or unknown parent
    const { api, getHandler } = makeApi();
    const state = makeState();
    registerCaptureHook(api as never, state);

    await getHandler()(makeEvent(), makeCtx(SUBAGENT_SESSION_KEY));

    expect((state.ownerPeer as ReturnType<typeof makePeer>).message).not.toHaveBeenCalled();
  });

  it("attributes user messages to ownerPeer for main agent sessions", async () => {
    const { api, getHandler } = makeApi();
    const state = makeState();
    registerCaptureHook(api as never, state);

    await getHandler()(makeEvent(), makeCtx(MAIN_SESSION_KEY));

    const ownerCalls = (state.ownerPeer as ReturnType<typeof makePeer>).message.mock.calls;
    expect(ownerCalls.some(([content]: [string]) => content.includes("research open PRs"))).toBe(true);
  });
});
