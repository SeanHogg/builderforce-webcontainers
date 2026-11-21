/** `scrubCredentials` (and the capped `scrubString` on top of it): every credential form that reaches a log, an error or evidence. */
import { describe, expect, it } from 'vitest';
import { scrubCredentials, scrubString } from '../src/security/securityEvent.js';

describe('scrubCredentials', () => {
  it('regression: catches any identifier ENDING in a secret word, whatever its prefix or case', () => {
    expect(scrubCredentials('GITHUB_TOKEN=ghp_x1 next')).toBe('GITHUB_TOKEN=[redacted] next');
    expect(scrubCredentials('DB_PASSWORD=hunter2')).toBe('DB_PASSWORD=[redacted]');
    expect(scrubCredentials('export OPENAI_API_KEY=sk-1')).toBe('export OPENAI_API_KEY=[redacted]');
    expect(scrubCredentials('aws_access_key: AKIA1, sessionId=abc; pwd=p')).toBe('aws_access_key: [redacted], sessionId=[redacted]; pwd=[redacted]');
    expect(scrubCredentials('https://x/cb?code=1&client_secret=s3&state=2')).toBe('https://x/cb?code=1&client_secret=[redacted]&state=2');
  });

  it('regression: a JSON or quoted key and a quoted value', () => {
    expect(scrubCredentials('{"token":"abc","user":"me"}')).toBe('{"token":"[redacted]","user":"me"}');
    expect(scrubCredentials(`{'refresh_token': 'r-1'}`)).toBe(`{'refresh_token': '[redacted]'}`);
    expect(scrubCredentials('{"password": "a b c"}')).toBe('{"password": "[redacted]"}');
  });

  it('regression: Authorization with any scheme, or none', () => {
    expect(scrubCredentials('Authorization: Token abc')).toBe('Authorization: Token [redacted]');
    expect(scrubCredentials('authorization: Bearer abc.def')).toBe('authorization: Bearer [redacted]');
    expect(scrubCredentials('Proxy-Authorization: Digest xyz')).toBe('Proxy-Authorization: Digest [redacted]');
    expect(scrubCredentials('{"Authorization":"Basic dXNlcjpwYXNz"}')).toBe('{"Authorization":"Basic [redacted]"}');
    expect(scrubCredentials('Authorization: rawsecret')).toBe('Authorization: [redacted]');
  });

  it('keeps what it did before: URL user info, bare Bearer/Basic values, short keys', () => {
    expect(scrubCredentials('postgres://user:hunter2@localhost/db')).toBe('postgres://[redacted]@localhost/db');
    expect(scrubCredentials('Bearer sk-123 and api_key=xyz')).toBe('Bearer [redacted] and api_key=[redacted]');
    expect(scrubCredentials('token=t secret: s')).toBe('token=[redacted] secret: [redacted]');
  });

  it('leaves ordinary text alone', () => {
    for (const text of ['GET /health 200 3ms', 'tokens used: 12', 'passage=ok', 'the password is wrong', 'Restarts: 2']) expect(scrubCredentials(text)).toBe(text);
  });

  it('scrubString scrubs the same forms and caps', () => {
    expect(scrubString('GITHUB_TOKEN=ghp_x')).toBe('GITHUB_TOKEN=[redacted]');
  });
});
