import { timingSafeEqual } from 'node:crypto';
import { LIMITS, exactKeys, isToken, requireThat } from '@web64/mcp-contract';

export function readCredentials(text, now = Date.now()) {
  requireThat(typeof text === 'string' && text.length <= 8192, 'http_credentials_required');
  const rows = JSON.parse(text);
  requireThat(Array.isArray(rows) && rows.length > 0 && rows.length <= LIMITS.clients, 'invalid_credentials');
  const ids = new Set(), tokens = new Set();
  return rows.map(row => {
    exactKeys(row, ['id', 'label', 'token', 'expiresAt']);
    requireThat(typeof row.id === 'string' && /^[a-z0-9_-]{1,64}$/u.test(row.id) && !ids.has(row.id), 'invalid_credentials');
    requireThat(typeof row.label === 'string' && /^[^\u0000-\u001f\u007f]{1,80}$/u.test(row.label), 'invalid_credentials');
    requireThat(isToken(row.token) && !tokens.has(row.token), 'invalid_credentials');
    requireThat(Number.isSafeInteger(row.expiresAt) && row.expiresAt > now
      && row.expiresAt <= now + LIMITS.grantMs, 'invalid_credentials');
    ids.add(row.id); tokens.add(row.token);
    return Object.freeze({ ...row });
  });
}
export function authenticate(header, credentials, now = Date.now()) {
  const token = typeof header === 'string' && /^Bearer ([a-f0-9]{64})$/u.exec(header)?.[1];
  if (!token) return null;
  const bytes = Buffer.from(token, 'hex');
  let found = null;
  for (const row of credentials) {
    if (timingSafeEqual(bytes, Buffer.from(row.token, 'hex')) && row.expiresAt > now) found = row;
  }
  return found;
}
export function validLocalRequest(req, port, origin, requireOrigin = false) {
  return req.socket.remoteAddress === '127.0.0.1'
    && req.headers.host === `127.0.0.1:${port}`
    && (req.headers.origin === origin || (!requireOrigin && req.headers.origin === undefined))
    && !req.headers.forwarded && !Object.keys(req.headers).some(key => key.startsWith('x-forwarded-'));
}
export async function readBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    requireThat(bytes <= LIMITS.envelope, 'payload_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export class Budget {
  constructor() { this.tokens = LIMITS.burst; this.time = Date.now(); this.active = 0; }
  take() {
    const now = Date.now();
    this.tokens = Math.min(LIMITS.burst, this.tokens + (now - this.time) * LIMITS.rate / 1000);
    this.time = now;
    requireThat(this.tokens >= 1 && this.active < LIMITS.requests, 'rate_limited');
    this.tokens--; this.active++;
    let released = false;
    return () => { if (!released) { released = true; this.active--; } };
  }
}
