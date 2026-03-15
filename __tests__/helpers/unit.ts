import { vi } from "vitest";
import type { HonchoConfig } from "../../config.js";

export type HookHandler = (
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => Promise<unknown>;

export const makeCtx = (sessionKey: string, agentId = "worker") => ({
  sessionKey,
  agentId,
  messageProvider: "discord",
});

export const makeMockLogger = () => ({
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
});

export function makePeer(
  id: string,
  contextResult: { peerCard?: string[]; representation?: string | null } = {
    peerCard: [],
    representation: null,
  },
) {
  return {
    id,
    message: vi.fn((content: string) => ({ peerId: id, content })),
    getMetadata: vi.fn().mockResolvedValue({}),
    setMetadata: vi.fn().mockResolvedValue(undefined),
    context: vi.fn().mockResolvedValue(contextResult),
  };
}

export function makeMockSession(contextResult: Record<string, unknown> = {}) {
  return {
    context: vi.fn().mockResolvedValue(contextResult),
    getMetadata: vi.fn().mockResolvedValue({}),
    setMetadata: vi.fn().mockResolvedValue(undefined),
    addMessages: vi.fn().mockResolvedValue(undefined),
    addPeers: vi.fn().mockResolvedValue(undefined),
  };
}

export function makeMockHoncho(
  ownerPeer: ReturnType<typeof makePeer>,
  session = makeMockSession(),
) {
  return {
    session: vi.fn().mockResolvedValue(session),
    peer: vi.fn().mockResolvedValue(ownerPeer),
    getMetadata: vi.fn().mockResolvedValue({}),
    setMetadata: vi.fn().mockResolvedValue(undefined),
    peers: vi.fn().mockReturnValue([]),
  };
}

export const makeCfg = (): HonchoConfig => ({
  apiKey: "test",
  workspaceId: "test-workspace",
  baseUrl: "http://localhost",
  contextTokens: 2000,
  maxConclusions: 10,
  dreamOnSessionEnd: false,
  noisePatterns: [],
});
