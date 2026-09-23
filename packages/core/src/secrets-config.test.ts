import { describe, expect, it } from 'vitest';
import { findSecretProblems, secretsConfigError } from './secrets-config.js';

const REAL = 'a3f1c9e07b5d42a8916e0c3b7d8f2a415c6e9b0d1f3a5c7e9b2d4f6a8c0e1b3d';

describe('findSecretProblems', () => {
  it('rejects the .env.example placeholder in any environment', () => {
    const env = { NODE_ENV: 'development', DROBEK_MASTER_KEY: 'change-me-generate-with-openssl-rand-hex-32' };
    expect(findSecretProblems(env)).toEqual([{ name: 'DROBEK_MASTER_KEY', reason: 'placeholder' }]);
  });

  it('rejects placeholders on every known secret', () => {
    const env = {
      UPLOAD_SIGNING_SECRET: 'changeme',
      SMTP_PASS: 'CHANGE_ME',
      GOOGLE_CLIENT_SECRET: 'replace-me',
      DROBEK_MASTER_KEY: REAL,
    };
    expect(findSecretProblems(env).map((p) => p.name).sort()).toEqual([
      'GOOGLE_CLIENT_SECRET',
      'SMTP_PASS',
      'UPLOAD_SIGNING_SECRET',
    ]);
  });

  it('allows the all-zero dev KEK outside production only', () => {
    const zeros = '0'.repeat(64);
    expect(findSecretProblems({ NODE_ENV: 'development', DROBEK_MASTER_KEY: zeros })).toEqual([]);
    expect(findSecretProblems({ NODE_ENV: 'production', DROBEK_MASTER_KEY: zeros })).toEqual([
      { name: 'DROBEK_MASTER_KEY', reason: 'weak' },
    ]);
  });

  it('requires the KEK in production', () => {
    expect(findSecretProblems({ NODE_ENV: 'production' })).toEqual([
      { name: 'DROBEK_MASTER_KEY', reason: 'missing' },
    ]);
    expect(findSecretProblems({ NODE_ENV: 'production', DROBEK_MASTER_KEY: REAL })).toEqual([]);
  });

  it('never echoes secret values in the error message', () => {
    const msg = secretsConfigError({ UPLOAD_SIGNING_SECRET: 'change-me-hunter2' });
    expect(msg).toContain('UPLOAD_SIGNING_SECRET');
    expect(msg).not.toContain('hunter2');
    expect(secretsConfigError({ DROBEK_MASTER_KEY: REAL })).toBeNull();
  });
});
