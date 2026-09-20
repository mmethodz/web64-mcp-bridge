import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { WebSocket } from 'ws';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { CAPABILITIES, LIMITS, hexToken, parseInvitation, proof, verifyProof, transcript } from '@web64/mcp-contract';
import { browserCapabilities } from '@web64/mcp-contract/browser-capabilities';
import { createPairing } from '../src/pairing.mjs';
import { startHttp } from '../src/mcp.mjs';
import { readCredentials, authenticate, Budget } from '../src/security.mjs';

const origin = 'http://127.0.0.1:5173';
const row = (id = 'a') => ({ id, label: `Client ${id}`, token: hexToken(), expiresAt: Date.now() + LIMITS.grantMs - 1000 });
const clientOptions = version => ({ versionNegotiation: { mode: version === '2026-07-28' ? { pin: version } : 'legacy' }, supportedProtocolVersions: [version] });

async function setup(t, responseMode = 'auto') {
  const credentials = [row(), row('b')];
  const pairing = await createPairing({ ideUrl: `${origin}/ide/`, clients: credentials });
  const http = await startHttp(pairing, credentials, { port: 0, origin, responseMode });
  t.after(async () => { await http.close(); await pairing.close(); });
  return { pairing, http, credentials, url: `http://127.0.0.1:${http.port}/mcp`, port: http.port };
}
async function httpClient(t, fixture, version, index = 0, shapes = []) {
  const client = new Client({ name: 'm0-test-client', version: '1.0.0' }, clientOptions(version));
  const transport = new StreamableHTTPClientTransport(new URL(fixture.url), {
    requestInit: { headers: { Authorization: `Bearer ${fixture.credentials[index].token}` } },
    fetch: async (...args) => { const response = await fetch(...args); shapes.push(response.headers.get('content-type')); return response; }
  });
  await client.connect(transport); t.after(() => client.close());
  return client;
}
async function peer(t, url, { badProof = false, consent = true, echo = true, capabilities = CAPABILITIES, reply } = {}) {
  // Spawned Node clocks can differ by 1ms on Windows. Model a real invitation
  // click delay without relaxing the production five-minute expiry validation.
  await new Promise(resolve => setTimeout(resolve, 10));
  const invitation = parseInvitation(new URL(url).hash, origin);
  const ws = new WebSocket(`ws://127.0.0.1:${invitation.port}/session`, { origin });
  t.after(() => ws.terminate());
  const messages = [], waiters = [];
  ws.on('message', raw => { const message = JSON.parse(raw); (waiters.shift() ?? (m => messages.push(m)))(message); });
  const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise(resolve => waiters.push(resolve));
  await once(ws, 'open');
  const hello = { type: 'hello', wire: invitation.wire, id: invitation.id, instance: invitation.instance, clientNonce: hexToken(), sessionId: hexToken() };
  ws.send(JSON.stringify(hello));
  const challenge = await next();
  assert.equal(await verifyProof(invitation.secret, transcript(invitation, hello, challenge, 'bridge'), challenge.proof), true);
  ws.send(JSON.stringify({ type: 'proof', proof: badProof ? hexToken() : await proof(invitation.secret, transcript(invitation, hello, challenge, 'browser')) }));
  if (badProof) { await once(ws, 'close'); return { invitation, hello }; }
  assert.equal((await next()).type, 'verified');
  if (consent) {
    ws.send(JSON.stringify({ type: 'consent', ...(invitation.scopes ? { scopes: invitation.scopes } : {}) }));
    assert.equal((await next()).type, 'ready');
  }
  if (echo) ws.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.type === 'request') ws.send(JSON.stringify({ type: 'result', requestId: message.requestId, sessionId: hello.sessionId, result: reply?.(message) ?? capabilities }));
  });
  return { ws, invitation, hello, next };
}

test('credentials are bounded, distinct, expiring and never inferred from loopback', () => {
  const a = row(), b = row('b');
  assert.deepEqual(readCredentials(JSON.stringify([a, b])), [a, b]);
  assert.equal(authenticate(`Bearer ${a.token}`, [a, b]).id, a.id);
  assert.equal(authenticate(`Bearer ${a.token}`, [a], a.expiresAt), null);
  assert.equal(authenticate(undefined, [a]), null);
  assert.throws(() => readCredentials(JSON.stringify([a, { ...b, token: a.token }])));
  assert.throws(() => readCredentials(undefined));
  const budget = new Budget(); const release = Array.from({ length: 4 }, () => budget.take());
  assert.throws(() => budget.take()); release.forEach(fn => { fn(); fn(); }); assert.equal(budget.active, 0);
});

test('runtime wire consent, read-scope isolation, generator routing and MCP PNG image envelope', async t => {
  const fixture = await setup(t), client = await httpClient(t, fixture, '2026-07-28');
  let requests = 0;
  await peer(t, fixture.pairing.begin('a', 'project:read').url, { capabilities: browserCapabilities(null, true),
    reply: message => { if (message.method !== 'project.command') return; requests++;
      assert.equal(message.params.action, 'generate'); return { ok: true, value: { authority: 'native fixture' } }; } });
  const denied = await client.callTool({ name: 'web64_runtime', arguments: { action: 'status' } });
  assert.equal(denied.structuredContent.error.code, 'scope_denied'); assert.equal(requests, 0);
  const generated = await client.callTool({ name: 'web64_generate_table', arguments: { action: 'describe' } });
  assert.equal(generated.structuredContent.value.authority, 'native fixture');
  await peer(t, fixture.pairing.begin('a', 'build+runtime').url, { capabilities: browserCapabilities(null, true, false, false, true, true),
    reply: message => message.method === 'project.command' ? { ok: true, value: { mimeType: 'image/png', data: 'iVBORw0KGgo=', width: 1, height: 1 } } : null });
  assert.equal((await fixture.pairing.capabilities('a')).emulatorControl, true);
  const image = await client.callTool({ name: 'web64_runtime', arguments: { action: 'capture_frame' } });
  assert.equal(image.content[0].type, 'image'); assert.equal(image.content[0].mimeType, 'image/png');
  fixture.pairing.disconnect('a');
  assert.equal((await client.callTool({ name: 'web64_runtime', arguments: { action: 'status' } })).structuredContent.error.code, 'session_unavailable');
});

test('portable template inspect fields traverse the real SDK/bridge with explicit write scope', async t => {
  const fixture = await setup(t), client = await httpClient(t, fixture, '2026-07-28');
  let received;
  await peer(t, fixture.pairing.begin('a', 'project:write').url, { capabilities: browserCapabilities(null, true, true),
    reply: message => { if (message.method !== 'project.command') return;
      received = message.params; return { ok: true, value: { templateFormatVersion: 1, applied: false } }; } });
  const operation = { operationId: crypto.randomUUID(), expected: { sessionId: 'one', epoch: 'epoch', generation: 0 } };
  const args = { ...operation, uploadId: 'staged-template', mode: 'inspect', options: { title: 'Demo', count: 2, sound: false, mode: 'pal', parts: ['art'] } };
  const result = await client.callTool({ name: 'web64_project_create', arguments: args });
  assert.equal(result.structuredContent.value.templateFormatVersion, 1);
  assert.deepEqual(received, { action: 'create', input: args });
  const invalid = await client.callTool({ name: 'web64_project_create', arguments: { ...args, templateId: 'also-bundled', templateVersion: 1 } });
  assert.equal(invalid.isError, true);
  fixture.pairing.disconnect('a');
  await peer(t, fixture.pairing.begin('a', 'project:read').url, { capabilities: browserCapabilities(null, true) });
  const denied = await client.callTool({ name: 'web64_project_create', arguments: args });
  assert.equal(denied.structuredContent.error.code, 'scope_denied');
});

test('authenticated M1 browser echo carries release identity but cannot extend the method set', async t => {
  const { pairing } = await setup(t);
  const knowledge = { schema: 'web64.public-knowledge-release', version: 1, release: 'a'.repeat(64),
    web64Version: '2.4.1', sdkVersion: '0.1', catalogSha256: 'b'.repeat(64), catalogBytes: 100, resourceCount: 1 };
  const capabilities = browserCapabilities(knowledge);
  await peer(t, pairing.begin('a').url, { capabilities });
  assert.deepEqual(await pairing.capabilities('a'), capabilities);
  assert.deepEqual(capabilities.methods, ['capabilities']);
  assert.equal(pairing.disconnect('a').state, 'unpaired');
});

for (const version of ['2026-07-28', '2025-11-25']) {
  test(`Streamable HTTP ${version}: real SDK client, shared catalog, browser echo and revoke`, async t => {
    const fixture = await setup(t), shapes = [];
    const client = await httpClient(t, fixture, version, 0, shapes);
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['web64_connection', 'web64_project_read', 'web64_runtime', 'web64_generate_table', 'web64_project_apply', 'web64_project_create', 'web64_project_save', 'web64_operation', 'web64_build', 'web64_project_open', 'web64_project_import', 'web64_transfer']);
    const invitation = (await client.callTool({ name: 'web64_connection', arguments: { action: 'begin_pairing' } })).structuredContent;
    await peer(t, invitation.url);
    const result = await client.readResource({ uri: 'web64://connection' });
    assert.deepEqual(JSON.parse(result.contents[0].text).browserEcho, CAPABILITIES);
    assert.equal((await client.callTool({ name: 'web64_connection', arguments: { action: 'disconnect' } })).structuredContent.state, 'unpaired');
    assert.ok(shapes.some(type => type?.includes(version === '2026-07-28' ? 'application/json' : 'text/event-stream')));
    assert.equal((await client.callTool({ name: 'web64_project_read', arguments: { action: 'manifest' } })).structuredContent.error.code, 'session_unavailable');
  });
  test(`stdio ${version}: spawned executable, no HTTP MCP and parity`, async t => {
    const client = new Client({ name: 'm0-stdio', version: '1.0.0' }, clientOptions(version));
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), '--ide-url', `${origin}/ide/`, '--allow-local-ide'], stderr: 'pipe' });
    let stderr = ''; transport.stderr?.on('data', data => { stderr += data; });
    await client.connect(transport); t.after(() => client.close());
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['web64_connection', 'web64_project_read', 'web64_runtime', 'web64_generate_table', 'web64_project_apply', 'web64_project_create', 'web64_project_save', 'web64_operation', 'web64_build', 'web64_project_open', 'web64_project_import', 'web64_transfer', 'web64_knowledge_search', 'web64_knowledge_read']);
    const invitation = (await client.callTool({ name: 'web64_connection', arguments: { action: 'begin_pairing' } })).structuredContent;
    const browser = await peer(t, invitation.url);
    assert.equal((await fetch(`http://127.0.0.1:${browser.invitation.port}/mcp`)).status, 404);
    assert.deepEqual(JSON.parse((await client.readResource({ uri: 'web64://connection' })).contents[0].text).browserEcho, CAPABILITIES);
    assert.ok(!stderr.includes(browser.invitation.secret));
  });
}

test('HTTP rejects unauthorized, hostile Origin/Host, wrong methods, oversized and malformed requests', async t => {
  const { url, credentials } = await setup(t);
  const headers = { Authorization: `Bearer ${credentials[0].token}`, 'Content-Type': 'application/json' };
  const send = (extra = {}, body = '{}') => fetch(url, { method: 'POST', headers: { ...headers, ...extra }, body });
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await send({ Authorization: 'Bearer ' + hexToken() })).status, 401);
  assert.equal((await send({ Origin: 'https://attacker.example' })).status, 403);
  const hostileHostStatus = await new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { ...headers, Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end('{}');
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await send({ Forwarded: 'host=127.0.0.1' })).status, 403);
  assert.equal((await send({ 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await send({}, '{')).status, 400);
  assert.equal((await send({}, 'x'.repeat(LIMITS.envelope + 1))).status, 413);
  assert.equal((await fetch(url, { headers })).status, 405);
  assert.equal((await fetch(url, { method: 'DELETE', headers })).status, 405);
  credentials[0].expiresAt = Date.now() - 1;
  assert.equal((await send()).status, 401);
});

test('single-use pairing, failed proof, missing/wrong WS Origin and version rejection', async t => {
  const { pairing } = await setup(t);
  const first = pairing.begin('a');
  await peer(t, first.url, { badProof: true });
  assert.equal(pairing.status('a').state, 'unpaired');
  const invitation = parseInvitation(new URL(first.url).hash, origin);
  const replay = new WebSocket(`ws://127.0.0.1:${pairing.port}/session`, { origin });
  await once(replay, 'open');
  replay.send(JSON.stringify({ type: 'hello', wire: 1, id: invitation.id, instance: invitation.instance, clientNonce: hexToken(), sessionId: hexToken() }));
  assert.equal((await once(replay, 'close'))[0], 1008);
  for (const badOrigin of [undefined, 'null', 'https://attacker.example']) {
    const ws = new WebSocket(`ws://127.0.0.1:${pairing.port}/session`, { origin: badOrigin });
    ws.on('error', () => {});
    assert.equal((await once(ws, 'unexpected-response'))[1].statusCode, 403); ws.terminate();
  }
  const ws = new WebSocket(`ws://127.0.0.1:${pairing.port}/session`, { origin });
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'hello', wire: 999 }));
  assert.equal((await once(ws, 'close'))[0], 1008);
});

test('consent is separate from authentication; HTTP clients never inherit a paired tab', async t => {
  const fixture = await setup(t);
  await peer(t, fixture.pairing.begin('a').url, { consent: false });
  assert.equal(fixture.pairing.status('a').state, 'unpaired');
  await peer(t, fixture.pairing.begin('a').url);
  const b = await httpClient(t, fixture, '2026-07-28', 1);
  const value = JSON.parse((await b.readResource({ uri: 'web64://connection' })).contents[0].text);
  assert.equal(value.browserEcho, null); assert.equal(value.sessionId, null);
  await b.callTool({ name: 'web64_connection', arguments: { action: 'disconnect' } });
  assert.equal(fixture.pairing.status('a').state, 'connected');
});

function modernRequest(fixture, method, params = {}, version = '2026-07-28') {
  const body = { jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: {
    'io.modelcontextprotocol/protocolVersion': version,
    'io.modelcontextprotocol/clientInfo': { name: 'm0-wire-test', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {}
  } } };
  const headers = { Authorization: `Bearer ${fixture.credentials[0].token}`, 'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': version, 'Mcp-Method': method };
  if (params.uri) headers['Mcp-Name'] = params.uri;
  return { method: 'POST', headers, body: JSON.stringify(body) };
}

test('modern HTTP metadata, unknown revision and revoked client credentials fail closed', async t => {
  const fixture = await setup(t);
  const mismatch = modernRequest(fixture, 'tools/list');
  mismatch.headers['Mcp-Method'] = 'resources/list';
  assert.equal((await fetch(fixture.url, mismatch)).status, 400);
  assert.equal((await fetch(fixture.url, modernRequest(fixture, 'tools/list', {}, '2099-01-01'))).status, 400);
  await peer(t, fixture.pairing.begin('a').url);
  await fixture.http.revokeClient('a');
  assert.equal(fixture.pairing.status('a').state, 'unpaired');
  assert.equal((await fetch(fixture.url, modernRequest(fixture, 'tools/list'))).status, 401);
  const other = await httpClient(t, fixture, '2026-07-28', 1);
  assert.equal((await other.listTools()).tools.length, 12);
});

test('modern HTTP SSE delivers SDK responses and abort cancels an unfinished browser request', async t => {
  const fixture = await setup(t, 'sse');
  const shapes = [], client = await httpClient(t, fixture, '2026-07-28', 0, shapes);
  await client.listTools(); assert.ok(shapes.some(shape => shape?.includes('text/event-stream')));
  await peer(t, fixture.pairing.begin('a').url, { echo: false });
  let observedCancel, observedEntry;
  const cancelled = new Promise(resolve => { observedCancel = resolve; });
  const entered = new Promise(resolve => { observedEntry = resolve; });
  const capabilities = fixture.pairing.capabilities.bind(fixture.pairing);
  fixture.pairing.capabilities = (id, signal) => {
    signal.addEventListener('abort', observedCancel, { once: true });
    observedEntry();
    return capabilities(id, signal);
  };
  const controller = new AbortController();
  const response = fetch(fixture.url, { ...modernRequest(fixture, 'resources/read', { uri: 'web64://connection' }), signal: controller.signal });
  const rejected = assert.rejects(response, /abort/iu);
  await entered;
  controller.abort();
  await rejected;
  let timeout;
  try { await Promise.race([cancelled, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('SDK did not propagate cancellation')), 1500); })]); }
  finally { clearTimeout(timeout); }
  assert.equal(fixture.pairing.status('a').state, 'connected');
});

test('invitation/grant expiry and socket loss remove authority', async t => {
  let now = Date.now();
  const credentials = [row()];
  const pairing = await createPairing({ ideUrl: `${origin}/ide/`, clients: credentials, clock: () => now });
  t.after(() => pairing.close());
  const invitation = pairing.begin('a');
  await peer(t, invitation.url);
  now = credentials[0].expiresAt;
  assert.throws(() => pairing.status('a'), /unauthorized/u);
  await assert.rejects(pairing.capabilities('a'), /unauthorized/u);
});
