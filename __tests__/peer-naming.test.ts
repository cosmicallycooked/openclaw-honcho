/**
 * Unit tests: peer naming convention
 *
 * Verifies that distinct agent IDs produce distinct, predictable peer IDs.
 * This mirrors the logic in `getAgentPeer()` inside index.ts.
 */
import { describe, it, expect } from 'vitest';
// ── Replicate the naming logic from index.ts ────────────────────────────────
// Any change here that makes tests fail means the plugin behaviour changed too.
function derivePeerId(agentId) {
    const id = agentId.toLowerCase().trim() || 'main';
    return `agent-${id}`;
}
function buildSessionKey(ctx) {
    const baseKey = ctx?.sessionKey ?? 'default';
    // messageProvider disambiguates sessions across platforms (e.g. telegram vs slack).
    // Cron and other internal triggers don't set it — omit rather than appending "-unknown".
    const provider = ctx?.messageProvider;
    const combined = provider ? `${baseKey}-${provider}` : baseKey;
    return combined.replace(/[^a-zA-Z0-9-]/g, '-');
}
// ────────────────────────────────────────────────────────────────────────────
describe('peer naming — distinct IDs per agent', () => {
    it('agent-prime and agent-developer get different peer IDs', () => {
        expect(derivePeerId('prime')).not.toBe(derivePeerId('developer'));
    });
    it('follows the agent-{id} pattern', () => {
        expect(derivePeerId('prime')).toBe('agent-prime');
        expect(derivePeerId('developer')).toBe('agent-developer');
        expect(derivePeerId('main')).toBe('agent-main');
    });
    it('normalises case and whitespace', () => {
        expect(derivePeerId('PRIME')).toBe('agent-prime');
        expect(derivePeerId('  prime  ')).toBe('agent-prime');
    });
    it('falls back to "main" for empty/blank agent IDs', () => {
        expect(derivePeerId('')).toBe('agent-main');
        expect(derivePeerId('   ')).toBe('agent-main');
    });
});
describe('session key building', () => {
    it('combines sessionKey + messageProvider with a hyphen', () => {
        expect(buildSessionKey({ sessionKey: 'abc', messageProvider: 'telegram' })).toBe('abc-telegram');
    });
    it('replaces non-alphanumeric chars with hyphens', () => {
        const key = buildSessionKey({ sessionKey: 'agent:prime:main', messageProvider: 'telegram' });
        expect(key).toBe('agent-prime-main-telegram');
        expect(key).toMatch(/^[a-zA-Z0-9-]+$/);
    });
    it('uses "default" when ctx is undefined (no provider suffix)', () => {
        expect(buildSessionKey()).toBe('default');
    });
    it('two different providers produce different session keys for the same base key', () => {
        const a = buildSessionKey({ sessionKey: 'test', messageProvider: 'telegram' });
        const b = buildSessionKey({ sessionKey: 'test', messageProvider: 'discord' });
        expect(a).not.toBe(b);
    });
});
