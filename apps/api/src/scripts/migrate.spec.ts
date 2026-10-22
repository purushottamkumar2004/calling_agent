import { parseArgs, readDatabaseUrl, readLockTimeout } from './migrate';

describe('migrate entrypoint argument handling', () => {
  it('defaults to applying everything', () => {
    expect(parseArgs([])).toEqual({ direction: 'up' });
    expect(parseArgs(['up'])).toEqual({ direction: 'up' });
  });

  it('rolls back one by default, or n', () => {
    expect(parseArgs(['down'])).toEqual({ direction: 'down', count: 1 });
    expect(parseArgs(['down', '3'])).toEqual({ direction: 'down', count: 3 });
  });

  it.each([[['sideways']], [['down', '0']], [['down', 'x']], [['up', '2']], [['down', '1', 'extra']]])(
    'rejects %j',
    (argv) => {
      expect(() => parseArgs(argv)).toThrow();
    },
  );
});

describe('readDatabaseUrl', () => {
  it('requires MIGRATION_DATABASE_URL and ignores DATABASE_URL', () => {
    expect(() => readDatabaseUrl({ DATABASE_URL: 'postgresql://a:b@h/db' })).toThrow(/not set/);
  });

  it('rejects non-postgres URLs without echoing them', () => {
    try {
      readDatabaseUrl({ MIGRATION_DATABASE_URL: 'mysql://user:secret@h/db' });
      throw new Error('expected failure');
    } catch (err) {
      expect(String(err)).toMatch(/postgres/);
      expect(String(err)).not.toContain('secret');
    }
  });

  it('accepts postgres and postgresql schemes', () => {
    expect(readDatabaseUrl({ MIGRATION_DATABASE_URL: 'postgres://u:p@h:5432/db' })).toBe('postgres://u:p@h:5432/db');
    expect(readDatabaseUrl({ MIGRATION_DATABASE_URL: 'postgresql://u:p@h/db' })).toBe('postgresql://u:p@h/db');
  });
});

describe('readLockTimeout', () => {
  it('defaults to 600 seconds and validates overrides', () => {
    expect(readLockTimeout({})).toBe(600);
    expect(readLockTimeout({ MIGRATION_LOCK_TIMEOUT_SEC: '30' })).toBe(30);
    expect(() => readLockTimeout({ MIGRATION_LOCK_TIMEOUT_SEC: '0' })).toThrow();
    expect(() => readLockTimeout({ MIGRATION_LOCK_TIMEOUT_SEC: 'soon' })).toThrow();
  });
});
