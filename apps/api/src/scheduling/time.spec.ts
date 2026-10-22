import { overlapsOpeningHours, speakable, isValidTimezone } from './time';

const IST = 'Asia/Kolkata';
const hours = { mon: [['09:00', '13:00'], ['16:00', '20:00']], sat: [['10:00', '14:00']] } as const;
const h = hours as unknown as Parameters<typeof overlapsOpeningHours>[3];

describe('speakable', () => {
  it('formats in the location timezone like the contract example', () => {
    // 2026-10-24T11:00Z is 16:30 IST on a Saturday.
    expect(speakable(new Date('2026-10-24T11:00:00Z'), IST)).toBe('Saturday 24 October at 4:30 PM');
  });
});

describe('overlapsOpeningHours', () => {
  // Monday 26 Oct 2026, IST = UTC+5:30.
  const ist = (local: string) => new Date(`${local}+05:30`);

  it('is true inside a session', () => {
    expect(overlapsOpeningHours(ist('2026-10-26T10:00:00'), ist('2026-10-26T11:00:00'), IST, h)).toBe(true);
  });

  it('is false in the lunch gap and on closed days', () => {
    expect(overlapsOpeningHours(ist('2026-10-26T13:00:00'), ist('2026-10-26T16:00:00'), IST, h)).toBe(false);
    expect(overlapsOpeningHours(ist('2026-10-25T00:00:00'), ist('2026-10-25T23:59:00'), IST, h)).toBe(false);
  });

  it('treats interval ends as exclusive', () => {
    expect(overlapsOpeningHours(ist('2026-10-26T20:00:00'), ist('2026-10-26T22:00:00'), IST, h)).toBe(false);
  });

  it('handles windows spanning days', () => {
    expect(overlapsOpeningHours(ist('2026-10-25T20:00:00'), ist('2026-10-26T09:30:00'), IST, h)).toBe(true);
  });

  it('treats missing hours as always open', () => {
    expect(overlapsOpeningHours(ist('2026-10-25T03:00:00'), ist('2026-10-25T04:00:00'), IST, {})).toBe(true);
  });
});

describe('isValidTimezone', () => {
  it('validates IANA names', () => {
    expect(isValidTimezone('Asia/Kolkata')).toBe(true);
    expect(isValidTimezone('Mars/Base')).toBe(false);
  });
});
