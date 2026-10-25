import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createUltimateHttp } from '../src/devices/ultimate-http.mjs';

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const target = { host: 'c64u.local', assertStable: async () => '127.0.0.1' };
    return await run(createUltimateHttp({ target, port: server.address().port, password: 'test' }));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('HTTP preflight requires success status and empty firmware errors', async () => {
  const seen = [];
  await withServer((req, res) => {
    seen.push({ path: req.url, host: req.headers.host, password: req.headers['x-password'] });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ version: '0.1', errors: [] }));
  }, async http => {
    assert.equal((await http.getVersion()).version, '0.1');
    assert.deepEqual(seen, [{ path: '/v1/version', host: 'c64u.local', password: 'test' }]);
  });
  await withServer((_req, res) => res.end(JSON.stringify({ errors: ['no REU'] })), async http => {
    await assert.rejects(http.getVersion(), /device_error:no REU/);
  });
  await withServer((_req, res) => { res.statusCode = 403; res.end(); }, async http => {
    await assert.rejects(http.getVersion(), /device_auth_rejected/);
  });
});

test('HTTP adapter does not follow redirects or accept oversized responses', async () => {
  await withServer((_req, res) => { res.statusCode = 302; res.setHeader('Location', 'http://example.com/'); res.end(); }, async http => {
    await assert.rejects(http.getInfo(), /http_status_302/);
  });
  await withServer((_req, res) => res.end(Buffer.alloc(256 * 1024 + 1, 65)), async http => {
    await assert.rejects(http.getInfo(), /http_response_oversized/);
  });
});

test('read-only configuration adapter requests only two allowlisted categories', async () => {
  const seen = [];
  await withServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.end(JSON.stringify({ 'U64 Specific Settings': { 'System Mode': 'PAL' }, errors: [] }));
  }, async http => {
    assert.equal((await http.getConfigCategory('U64 Specific Settings'))['U64 Specific Settings']['System Mode'], 'PAL');
    assert.deepEqual(seen, ['GET /v1/configs/U64%20Specific%20Settings']);
    assert.throws(() => http.getConfigCategory('Drive A Settings'), /invalid_config_category/);
  });
});

test('mailbox read accepts only the fixed 64-byte response and mount is nonpersistent', async () => {
  await withServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/machine:readmem?address=CFC0&length=64') res.end(Buffer.alloc(64, 7));
    else res.end(Buffer.alloc(63, 7));
  }, async http => {
    assert.equal((await http.readMailbox(0xcfc0)).length, 64);
    await assert.rejects(http.readMailbox(0xcfc1), /http_binary_length_mismatch/);
    assert.throws(() => http.mountD64('c', 'unlinked', {}), /invalid_mount/);
    assert.throws(() => http.mountD64('a', 'readwrite', {}), /invalid_mount/);
    assert.throws(() => http.writeMemory(0xffff, Buffer.from([1, 2])), /invalid_memory_range/);
  });
});

test('bounded RAM write uses the upstream single-file attachment contract', async () => {
  let observed;
  await withServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    observed = { method: req.method, path: req.url, type: req.headers['content-type'],
      bytes: Buffer.concat(chunks) };
    res.end(JSON.stringify({ errors: [] }));
  }, async http => {
    await http.writeMemory(0x2000, Buffer.from([0x11, 0x22]));
    assert.equal(observed.method, 'POST');
    assert.equal(observed.path, '/v1/machine:writemem?address=2000');
    assert.match(observed.type, /^multipart\/form-data; boundary=web64-[a-f0-9]{32}$/);
    assert.ok(observed.bytes.includes(Buffer.from('filename="ram.bin"')));
    assert.ok(observed.bytes.includes(Buffer.from([0x11, 0x22])));
  });
});

test('HTTP response deadline rejects a stalled device', async () => {
  const server = createServer(() => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const http = createUltimateHttp({ target: { host: 'c64u.local', assertStable: async () => '127.0.0.1' },
      port: server.address().port, timeoutMs: 20 });
    await assert.rejects(http.getVersion(), /http_timeout/);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
