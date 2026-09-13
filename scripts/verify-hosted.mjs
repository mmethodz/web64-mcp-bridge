#!/usr/bin/env node
// Maintainer-only, one bounded human-browser check through the actual stdio CLI.
// Invitation output is the intended client handoff, never retained as evidence.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { CAPABILITIES } from '@web64/mcp-contract';
import { createHash } from 'node:crypto';

assert.ok(process.argv.slice(2).every(arg => arg === '--hostinger'));
const production = process.argv.includes('--hostinger');
const origin = production ? 'https://web64.nofs.ai' : 'https://web64-react-nbo02ig2k-mika-jussilas-projects.vercel.app';
let deployment = null;
if (production) {
  const response = await fetch(origin + '/ide/');
  assert.equal(response.status, 200);
  assert.equal(new URL(response.url).origin, origin);
  const headers = Object.fromEntries(['cross-origin-opener-policy', 'cross-origin-embedder-policy',
    'cross-origin-resource-policy', 'content-security-policy', 'x-content-type-options',
    'access-control-allow-origin'].map(name => [name, response.headers.get(name)]));
  assert.equal(headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(headers['cross-origin-embedder-policy'], 'require-corp');
  assert.equal(headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(headers['content-security-policy'], 'upgrade-insecure-requests');
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['access-control-allow-origin'], null);
  const html = await response.text();
  const entry = /<script[^>]*src="([^"]+)"/u.exec(html)?.[1];
  assert.ok(entry);
  const entryUrl = new URL(entry, origin);
  assert.equal(entryUrl.origin, origin);
  const asset = await fetch(entryUrl);
  assert.equal(asset.status, 200);
  const bytes = Buffer.from(await asset.arrayBuffer());
  assert.ok(bytes.toString('utf8').includes('#web64-mcp='), 'Deployed entry lacks M0 opt-in bootstrap');
  deployment = { entry: entryUrl.pathname, sha256: createHash('sha256').update(bytes).digest('hex'), headers };
  console.log(JSON.stringify({ deployment }));
}
const client = new Client({ name: 'M0 hosted verification', version: '1.0.0' }, {
  versionNegotiation: { mode: { pin: '2026-07-28' } }, supportedProtocolVersions: ['2026-07-28']
});
const transport = new StdioClientTransport({ command: process.execPath, args: [
  fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), '--ide-url', origin + '/ide/'
], stderr: 'pipe' });
try {
  await client.connect(transport);
  const result = await client.callTool({ name: 'web64_connection', arguments: { action: 'begin_pairing' } });
  assert.equal(result.structuredContent.ok, true);
  const invitation = result.structuredContent;
  assert.equal(new URL(invitation.url).origin, origin);
  console.log(JSON.stringify({ invitation: invitation.url, expiresAt: invitation.expiresAt }));
  let connected = false;
  while (Date.now() < invitation.expiresAt) {
    const status = await client.callTool({ name: 'web64_connection', arguments: { action: 'status' } });
    if (status.structuredContent.state === 'connected') { connected = true; break; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(connected, true, 'Invitation expired before browser consent; no success claimed.');
  const connection = JSON.parse((await client.readResource({ uri: 'web64://connection' })).contents[0].text);
  assert.deepEqual(connection.browserEcho, CAPABILITIES);
  const revoked = await client.callTool({ name: 'web64_connection', arguments: { action: 'disconnect' } });
  assert.equal(revoked.structuredContent.state, 'unpaired');
  console.log(JSON.stringify({ status: 'pass', origin, deployment,
    commit: production ? null : 'd35c014ffe913f6ab3436474d753bf8e1007c6b7',
    protocol: '2026-07-28', transport: 'stdio', browserEcho: connection.browserEcho,
    revoked: true, uiCleanup: 'requires human confirmation',
    authority: production ? 'Hostinger equivalence: actual deployment headers, browser mutual authentication, explicit consent, capability response and MCP revoke'
      : 'real hosted browser mutual authentication, explicit consent, capability response and MCP revoke; not Hostinger equivalence' }));
} catch (error) {
  console.error(JSON.stringify({ status: 'fail', reason: error instanceof assert.AssertionError ? error.message : 'hosted_check_failed' }));
  process.exitCode = 1;
} finally { await client.close(); }
