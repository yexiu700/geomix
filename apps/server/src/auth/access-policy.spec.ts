import { describe, expect, it } from 'vitest';
import { writeBlockReason } from './access-policy';

const now = Date.parse('2026-11-16T00:00:00.000Z');

describe('writeBlockReason', () => {
  it('lets an expired tenant read and blocks writes', () => {
    const auth = { isActive: true, expiresAt: new Date(now - 1000) };
    expect(writeBlockReason(auth, 'GET', now)).toBeNull();
    expect(writeBlockReason(auth, 'POST', now)).toBe('expired');
  });

  it('blocks a disabled tenant even on reads', () => {
    const auth = { isActive: false, expiresAt: new Date(now + 86_400_000) };
    expect(writeBlockReason(auth, 'GET', now)).toBe('inactive');
  });

  it('allows an active tenant to write', () => {
    const auth = { isActive: true, expiresAt: new Date(now + 86_400_000) };
    expect(writeBlockReason(auth, 'POST', now)).toBeNull();
  });
});
