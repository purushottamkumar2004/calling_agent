import { stableStringify } from './idempotency.service';

describe('stableStringify', () => {
  it('is independent of key order and ignores undefined', () => {
    expect(stableStringify({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe(
      stableStringify({ a: { d: [1, { x: 1, y: 2 }] }, b: 1 }),
    );
  });

  it('distinguishes different values', () => {
    expect(stableStringify({ slot_id: 'a' })).not.toBe(stableStringify({ slot_id: 'b' }));
  });
});
