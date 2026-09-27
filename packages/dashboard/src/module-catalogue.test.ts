import { describe, expect, it } from 'vitest';
import { filterModules, formatLimit } from './module-catalogue.js';

describe('formatLimit', () => {
  it('shows bytes in human units with the exact value', () => {
    expect(formatLimit('FILES_MAX_BYTES', 'bytes of one uploaded file', 10485760)).toEqual({ text: '10 MB', exact: '10,485,760 bytes' });
    expect(formatLimit('DATA_MAX_BYTES_PER_APP', 'bytes of records one app may store', 1572864)).toEqual({ text: '1.5 MB', exact: '1,572,864 bytes' });
    expect(formatLimit('FILES_QUOTA_PER_APP', 'bytes of files one app may store', 1073741824).text).toBe('1 GB');
    expect(formatLimit('DATA_MAX_DOC_BYTES', 'bytes of one record (its JSON)', 512)).toEqual({ text: '512 bytes', exact: '512 bytes' });
  });

  it('shows milliseconds as a duration with the exact value', () => {
    expect(formatLimit('DATA_WRITE_RATE_WINDOW_MS', 'the write rate-limit window in milliseconds', 60000)).toEqual({ text: '1 min', exact: '60,000 ms' });
    expect(formatLimit('X_TIMEOUT_MS', 'timeout', 1500).text).toBe('1.5 s');
    expect(formatLimit('X_TIMEOUT_MS', 'timeout', 250).text).toBe('250 ms');
    expect(formatLimit('X_WINDOW_MS', 'window', 7_200_000).text).toBe('2 h');
  });

  it('shows a count as is, with no unit', () => {
    expect(formatLimit('END_USERS_MAX_PER_APP', 'end users one app may have', 1000)).toEqual({ text: '1,000', exact: null });
    expect(formatLimit('AUTH_CODES_PER_IP_15MIN', 'sign-in codes one visitor IP may request per 15 minutes', 5)).toEqual({ text: '5', exact: null });
  });
});

describe('filterModules', () => {
  const modules = [
    { name: 'auth', useWhen: 'the app needs sign-in', slots: [{ name: 'auth.provider' }], limits: [{ name: 'END_USERS_MAX_PER_APP' }] },
    { name: 'files', useWhen: 'users upload files', slots: [], limits: [{ name: 'FILES_MAX_BYTES' }] },
  ];

  it('an empty query keeps every module', () => {
    expect(filterModules(modules, '  ').map((m) => m.name)).toEqual(['auth', 'files']);
    expect(filterModules(modules, null)).toHaveLength(2);
  });

  it('matches every word, case-insensitive, in the name, use-when, slots and limits', () => {
    expect(filterModules(modules, 'SIGN-IN').map((m) => m.name)).toEqual(['auth']);
    expect(filterModules(modules, 'max_bytes').map((m) => m.name)).toEqual(['files']);
    expect(filterModules(modules, 'auth.provider').map((m) => m.name)).toEqual(['auth']);
    expect(filterModules(modules, 'upload sign-in')).toEqual([]);
  });
});
