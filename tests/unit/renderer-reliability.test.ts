import { describe, expect, it } from 'vitest';
import {
  isLatestSequence,
  reconcilePendingMessages,
} from '../../src/renderer/src/utils/reliability.js';

describe('renderer async reliability helpers', () => {
  it('accepts only the latest async response sequence', () => {
    expect(isLatestSequence(3, 3)).toBe(true);
    expect(isLatestSequence(2, 3)).toBe(false);
  });

  it('treats the database response as authoritative and retains unseen optimistic messages', () => {
    const remote = [{ role: 'user', content: 'saved' }];
    const pending = [
      { role: 'user', content: 'saved' },
      { role: 'user', content: 'still pending' },
    ];
    expect(reconcilePendingMessages(remote, pending)).toEqual({
      messages: [...remote, pending[1]],
      pending: [pending[1]],
    });
  });
});
