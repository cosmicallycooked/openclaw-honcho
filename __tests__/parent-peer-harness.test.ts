/**
 * Integration: subagent messages are written to the parent session
 *
 * Fires the full lifecycle: gateway_start → parent before_prompt_build →
 * subagent_spawned → subagent agent_end, then asserts that:
 *  - Messages landed in the PARENT session (not a separate subagent session)
 *  - The parent session contains the correct peer configs
 *  - Message peer attribution is correct (user→parentPeer, assistant→subagentPeer)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Honcho } from '@honcho-ai/sdk';
import honchoPlugin from '../index.js';
import { sessionKeyToHonchoKey } from '../hooks/subagent.js';

const API_KEY = process.env.HONCHO_API_KEY;
const WORKSPACE_ID = process.env.HONCHO_WORKSPACE_ID ?? 'openclaw-test';
const BASE_URL = process.env.HONCHO_BASE_URL ?? 'https://api.honcho.dev';
const maybe = !API_KEY ? describe.skip : describe;
const TS = Date.now();

// Parent session: prime running in 'test' provider
const PARENT_OPENCLAW_KEY = `parent-prime-${TS}`;
// Actual Honcho key is resolved after before_prompt_build fires (includes TS suffix)
let PARENT_HONCHO_KEY: string;

// Subagent session: developer spawned by prime
const CHILD_OPENCLAW_KEY  = `agent:developer:subagent:harness-${TS}`;

function buildMockApi() {
  const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  return {
    pluginConfig: {},
    logger: {
      info:  (..._a: unknown[]) => {},
      warn:  (..._a: unknown[]) => {},
      error: (..._a: unknown[]) => {},
      debug: (..._a: unknown[]) => {},
    },
    config: {
      agents: { list: [{ id: 'prime', default: true }, { id: 'developer', default: false }] },
    },
    on(name: string, cb: (...args: unknown[]) => unknown) {
      hooks.set(name, [...(hooks.get(name) ?? []), cb]);
    },
    registerTool: () => {},
    registerCli:  () => {},
    runtime: {
      tools: { createMemorySearchTool: () => null, createMemoryGetTool: () => null },
    },
    async fire(name: string, event: unknown, ctx: unknown) {
      for (const cb of hooks.get(name) ?? []) await cb(event, ctx);
    },
  };
}

maybe('subagent messages go to parent session', () => {
  let parentSessionPeerIds: string[];
  let parentSessionMessages: Array<{ peer_id: string; content: string }>;
  let subagentSessionExists: boolean;

  beforeAll(async () => {
    const api = buildMockApi();
    honchoPlugin.register(api);

    await api.fire('gateway_start', {}, {});

    // Parent turn fires before_prompt_build — this populates sessionKeyToHonchoKey
    // (including the TS suffix added to make sessions unique per conversation)
    await api.fire('before_prompt_build', { prompt: 'hello', messages: [] }, {
      sessionKey: PARENT_OPENCLAW_KEY,
      messageProvider: 'test',
      agentId: 'prime',
    });
    PARENT_HONCHO_KEY = sessionKeyToHonchoKey.get(PARENT_OPENCLAW_KEY)!;

    // Prime spawns developer subagent
    await api.fire('subagent_spawned', { agentId: 'developer' }, {
      childSessionKey:    CHILD_OPENCLAW_KEY,
      requesterSessionKey: PARENT_OPENCLAW_KEY,
    });

    // Subagent completes its turn
    await api.fire('agent_end', {
      success: true,
      messages: [
        { role: 'user',      content: 'Research open PRs for me' },
        { role: 'assistant', content: 'Found 3 open PRs: #1, #2, #3' },
      ],
    }, {
      sessionKey:      CHILD_OPENCLAW_KEY,
      messageProvider: 'test',
      agentId:         'developer',
    });

    // Inspect the parent session in Honcho
    const honcho = new Honcho({ apiKey: API_KEY, workspaceId: WORKSPACE_ID, baseURL: BASE_URL });
    const parentSession = await honcho.session(PARENT_HONCHO_KEY);
    parentSessionPeerIds = (await parentSession.peers()).map((p: { id: string }) => p.id);

    const msgPage = await parentSession.messages();
    parentSessionMessages = [];
    for await (const m of msgPage) {
      parentSessionMessages.push({ peer_id: m.peerId, content: m.content });
    }

    // Verify subagent's own session has no messages (all went to parent session)
    const subagentHonchoKey = `agent-developer-subagent-harness-${TS}-test`;
    const subagentSession = await honcho.session(subagentHonchoKey);
    const subagentMsgPage = await subagentSession.messages();
    const subagentMessages: unknown[] = [];
    for await (const m of subagentMsgPage) subagentMessages.push(m);
    subagentSessionExists = subagentMessages.length > 0;
  }, 60_000);

  it('messages land in the parent session', () => {
    expect(parentSessionMessages.length).toBeGreaterThan(0);
  });

  it('subagent own session has no messages (all went to parent)', () => {
    expect(subagentSessionExists).toBe(false);
  });

  it('parent session contains owner peer', () => {
    expect(parentSessionPeerIds).toContain('owner');
  });

  it('parent session contains agent-prime (parent)', () => {
    expect(parentSessionPeerIds).toContain('agent-prime');
  });

  it('parent session contains agent-developer (subagent)', () => {
    expect(parentSessionPeerIds.some(id => id.includes('developer'))).toBe(true);
  });

  it('user-role message is attributed to agent-prime (parent peer)', () => {
    const userMsg = parentSessionMessages.find(m => m.content.includes('Research open PRs'));
    expect(userMsg).toBeDefined();
    expect(userMsg!.peer_id).toContain('prime');
  });

  it('assistant-role message is attributed to agent-developer (subagent peer)', () => {
    const assistantMsg = parentSessionMessages.find(m => m.content.includes('Found 3 open PRs'));
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.peer_id).toContain('developer');
  });
});
