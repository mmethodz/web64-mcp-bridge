import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKnowledgeCache } from '../src/public-knowledge-cache.mjs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { knowledgeUri } from '@web64/mcp-contract/knowledge';
import { browserCapabilities } from '@web64/mcp-contract/browser-capabilities';
import { hexToken, LIMITS } from '@web64/mcp-contract';
import { createKnowledgeReader } from '../src/knowledge.mjs';
import { createPairing } from '../src/pairing.mjs';
import { startHttp } from '../src/mcp.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
function fixture(label = 'one') {
  const text = `void example_${label}(void);\n` + '/* long header */\n'.repeat(2000);
  const blob = JSON.stringify({ text }) + '\n';
  const row = { id: 'sdk/c/web64/example.h', kind: 'sdk', title: 'example.h', summary: 'Public fixture header.',
    source: { authority: 'web64://sdk/c/example.h', contentSha256: sha(text) }, symbols: [`example_${label}`],
    sha256: sha(blob), bytes: Buffer.byteLength(blob) };
  const core = { schema: 'web64.public-knowledge', version: 1, web64Version: '2.4.1', sdkVersion: '0.1', resources: [row] };
  const release = sha(JSON.stringify(core)), catalog = JSON.stringify({ ...core, release }) + '\n';
  const manifest = { schema: 'web64.public-knowledge-release', version: 1, release, web64Version: core.web64Version,
    sdkVersion: core.sdkVersion, catalogSha256: sha(catalog), catalogBytes: Buffer.byteLength(catalog), resourceCount: 1 };
  return { manifest, text, uri: knowledgeUri(release, row.id), files: new Map([
    ['/docs/mcp/manifest.json', JSON.stringify(manifest) + '\n'],
    [`/docs/mcp/releases/${release}/manifest.json`, JSON.stringify(manifest) + '\n'],
    [`/docs/mcp/releases/${release}/catalog.json`, catalog],
    [`/docs/mcp/releases/${release}/blobs/${row.sha256}.json`, blob]
  ]) };
}
const unpaired = { status: () => ({ state: 'unpaired', sessionId: null }), capabilities: () => { throw Error('must not contact browser'); } };
function readerFor(data, override, cache = null) {
  const requests = [];
  return { requests, reader: createKnowledgeReader({ ideUrl: 'https://web64.nofs.ai/ide/', cache,
    fetchImpl: async (url, options) => {
      requests.push(url.href);
      assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
      assert.equal(options.headers.Authorization, undefined);
      if (override) return override(url, options);
      return new Response(data.files.get(url.pathname), { status: data.files.has(url.pathname) ? 200 : 404,
        headers: { 'Content-Type': 'application/json' } });
    } }) };
}

test('public lookup is lazy, explicitly unbound, hashed, cached and paged without truncation', async () => {
  const data = fixture(), { reader, requests } = readerFor(data);
  assert.equal(requests.length, 0);
  const found = await reader.search(unpaired, 'a', { query: 'example_one' });
  assert.equal(found.results[0].uri, data.uri);
  assert.equal(found.binding.connectedReleaseVerified, false);
  assert.equal(found.binding.authority, 'public-release');
  const first = await reader.read(unpaired, 'a', { uri: data.uri });
  assert.ok(first.nextOffset);
  const last = await reader.read(unpaired, 'a', { uri: data.uri, offset: first.nextOffset });
  assert.equal(first.text + last.text, data.text); assert.equal(last.nextOffset, null);
  assert.equal(requests.filter(url => url.includes('/blobs/')).length, 1);
  assert.equal(requests.filter(url => url.endsWith('/catalog.json')).length, 1);
});

test('public validation happens once per logical session, with epoch changes requiring fresh authority', async () => {
  const old = fixture('old'), newer = fixture('new'), files = new Map([...old.files, ...newer.files]);
  files.set('/docs/mcp/manifest.json', old.files.get('/docs/mcp/manifest.json'));
  let epoch = 0;
  const pairing = { status: () => ({ state: 'unpaired', sessionId: null, validationEpoch: epoch }) };
  const { reader, requests } = readerFor({ files });
  assert.equal((await reader.describe(pairing, 'a')).release, old.manifest.release);
  files.set('/docs/mcp/manifest.json', newer.files.get('/docs/mcp/manifest.json'));
  assert.equal((await reader.describe(pairing, 'a')).release, old.manifest.release);
  assert.equal((await reader.read(pairing, 'a', { uri: old.uri })).release, old.manifest.release);
  assert.equal(requests.filter(url => url.endsWith('/manifest.json')).length, 1);
  epoch++;
  assert.equal((await reader.describe(pairing, 'a')).release, newer.manifest.release);
  assert.equal(requests.filter(url => url.endsWith('/manifest.json')).length, 2);
  await reader.describe(pairing, 'b'); // Another authenticated principal validates independently.
  assert.equal(requests.filter(url => url.endsWith('/manifest.json')).length, 3);
});

test('paired manifest is validated once per grant while every read still checks the grant identity', async () => {
  const data = fixture(); let sessionId = 'first', calls = 0;
  const pairing = { status: () => ({ state: 'connected', sessionId }),
    capabilities: async () => { calls++; return browserCapabilities(data.manifest); } };
  const { reader, requests } = readerFor(data);
  await reader.describe(pairing, 'a'); await reader.read(pairing, 'a', { uri: data.uri });
  assert.equal(calls, 1);
  sessionId = 'second'; await reader.describe(pairing, 'a');
  assert.equal(calls, 2);
  assert.equal(requests.some(url => url.endsWith('/manifest.json')), false);
});

test('disk cache survives reader restart but never substitutes for fresh session validation; corruption refetches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'web64-public-cache-test-'));
  const data = fixture(), cache = createPublicKnowledgeCache({ directory, origin: 'https://web64.nofs.ai' });
  const first = readerFor(data, undefined, cache);
  await first.reader.read(unpaired, 'a', { uri: data.uri });
  const entries = await readdir(directory);
  assert.equal(entries.length, 2); assert.ok(entries.every(name => /\.(catalog|blob)\.[a-f0-9]{64}\.json$/u.test(name)));
  const second = readerFor(data, undefined, createPublicKnowledgeCache({ directory, origin: 'https://web64.nofs.ai' }));
  assert.equal((await second.reader.read(unpaired, 'a', { uri: data.uri })).text, data.text.slice(0, 24000));
  assert.equal(second.requests.length, 1); assert.match(second.requests[0], /\/manifest\.json$/u);
  const offline = readerFor(data, () => { throw Error('offline'); }, cache);
  await assert.rejects(offline.reader.read(unpaired, 'a', { uri: data.uri }), { code: 'knowledge_unavailable' });
  const blobPath = join(directory, entries.find(name => name.includes('.blob.')));
  await writeFile(blobPath, 'invalid local data');
  const repaired = readerFor(data, undefined, cache);
  await repaired.reader.read(unpaired, 'a', { uri: data.uri });
  assert.equal(repaired.requests.filter(url => url.includes('/blobs/')).length, 1);
  assert.ok((await readFile(blobPath, 'utf8')).startsWith('{"text":'));
});

test('connected knowledge uses the attested immutable release, not latest, and M0 never claims a match', async () => {
  const old = fixture('old'), current = fixture('new');
  const data = { files: new Map([...old.files, ...current.files]) };
  const { reader, requests } = readerFor(data);
  let session = 'one';
  const paired = { status: () => ({ state: 'connected', sessionId: session }), capabilities: async () => browserCapabilities(old.manifest) };
  const found = await reader.search(paired, 'a', { query: 'example_old' });
  assert.equal(found.release, old.manifest.release); assert.equal(found.binding.connectedReleaseVerified, true);
  assert.equal(requests.some(url => url.endsWith('/manifest.json')), false);
  await assert.rejects(reader.read(paired, 'a', { uri: current.uri }), { code: 'knowledge_release_mismatch' });
  const legacy = { ...paired, capabilities: async () => browserCapabilities() };
  await assert.rejects(reader.describe(legacy, 'a'), { code: 'connected_knowledge_unavailable' });
  assert.equal((await reader.describe(legacy, 'a', { scope: 'public' })).binding.connectedReleaseVerified, false);
  session = 'two';
  paired.capabilities = async () => { session = 'replaced'; return browserCapabilities(old.manifest); };
  await assert.rejects(reader.describe(paired, 'a'), { code: 'session_unavailable' });
});

test('public reader rejects arbitrary origins, paths, corrupted hashes, redirects and oversized responses', async () => {
  assert.throws(() => createKnowledgeReader({ ideUrl: 'https://attacker.example/ide/' }));
  assert.throws(() => createKnowledgeReader({ ideUrl: 'http://127.0.0.1/ide/' }));
  const data = fixture();
  const { reader } = readerFor(data);
  await assert.rejects(reader.read(unpaired, 'a', { uri: 'file:///private.txt' }));
  for (const mode of ['catalog', 'blob', 'redirect', 'length', 'stream', 'type']) {
    const { reader: rejected } = readerFor(data, url => {
      let body = data.files.get(url.pathname), headers = { 'Content-Type': 'application/json' };
      if ((mode === 'catalog' && url.pathname.endsWith('catalog.json')) || (mode === 'blob' && url.pathname.includes('/blobs/'))) body += ' ';
      if (mode === 'redirect') return Response.redirect('https://attacker.example/private');
      if (mode === 'length') headers['Content-Length'] = '99999999';
      if (mode === 'stream') body = ' '.repeat(4097);
      if (mode === 'type') headers['Content-Type'] = 'text/html';
      return new Response(body, { headers });
    });
    await assert.rejects(async () => {
      await rejected.describe(unpaired, 'a');
      await rejected.read(unpaired, 'a', { uri: data.uri });
    }, undefined, mode);
  }
});

test('cancellation aborts the public request; revoked browser binding cannot finish a delayed resource read', async () => {
  const controller = new AbortController(), data = fixture();
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  const { reader } = readerFor(data, async (_url, { signal }) => {
    started(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const request = reader.describe(unpaired, 'a', {}, controller.signal);
  await waiting; controller.abort(); await assert.rejects(request, { code: 'request_cancelled' });
  let connected = true;
  const paired = { status: () => ({ state: connected ? 'connected' : 'unpaired', sessionId: connected ? 'one' : null }),
    capabilities: async () => browserCapabilities(data.manifest) };
  const { reader: revoked } = readerFor(data, url => {
    if (url.pathname.includes('/blobs/')) connected = false;
    return new Response(data.files.get(url.pathname), { headers: { 'Content-Type': 'application/json' } });
  });
  await assert.rejects(revoked.read(paired, 'a', { uri: data.uri }), { code: 'session_unavailable' });
});

for (const version of ['2026-07-28', '2025-11-25']) {
  test(`real SDK ${version}: knowledge is identical through stdio and authenticated Streamable HTTP`, async t => {
    const data = fixture();
    const web = createServer((req, res) => {
      const body = data.files.get(req.url);
      res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' }); res.end(body || '{}');
    });
    await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
    t.after(() => { web.closeAllConnections(); return new Promise(resolve => web.close(resolve)); });
    const origin = `http://127.0.0.1:${web.address().port}`, ideUrl = origin + '/ide/';
    const credentials = [{ id: 'a', label: 'Test', token: hexToken(), expiresAt: Date.now() + LIMITS.grantMs - 1000 }];
    const pairing = await createPairing({ ideUrl, clients: credentials });
    const http = await startHttp(pairing, credentials, { port: 0, origin,
      knowledge: createKnowledgeReader({ ideUrl, allowLocal: true }) });
    t.after(async () => { await http.close(); await pairing.close(); });
    const transports = [new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), '--ide-url', ideUrl, '--allow-local-ide', '--no-knowledge-cache'], stderr: 'pipe' }),
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${credentials[0].token}` } } })];
    const results = [];
    for (const transport of transports) {
      const client = new Client({ name: 'm1-test', version: '1.0.0' }, { supportedProtocolVersions: [version],
        versionNegotiation: { mode: version === '2026-07-28' ? { pin: version } : 'legacy' } });
      await client.connect(transport); t.after(() => client.close());
      const tools = (await client.listTools()).tools.map(tool => tool.name);
      assert.deepEqual(tools, ['web64_connection', 'web64_project_read', 'web64_project_apply', 'web64_project_create', 'web64_project_save', 'web64_operation', 'web64_build', 'web64_project_open', 'web64_project_import', 'web64_transfer', 'web64_knowledge_search', 'web64_knowledge_read']);
      assert.equal((await client.listResourceTemplates()).resourceTemplates.length, 2);
      const description = JSON.parse((await client.readResource({ uri: 'web64://knowledge' })).contents[0].text);
      const result = await client.callTool({ name: 'web64_knowledge_search', arguments: { query: 'example_one' } });
      assert.equal(result.isError, undefined);
      const uri = result.structuredContent.results[0].uri;
      const first = JSON.parse((await client.readResource({ uri })).contents[0].text);
      const rest = await client.callTool({ name: 'web64_knowledge_read', arguments: { uri, offset: first.nextOffset } });
      assert.equal(first.text + rest.structuredContent.text, data.text);
      results.push({ description, search: result.structuredContent, first, rest: rest.structuredContent });
      await client.close();
    }
    assert.deepEqual(results[0], results[1]);
  });
}
