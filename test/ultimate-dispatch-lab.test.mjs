import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDeviceJobs } from '../src/devices/device-jobs.mjs';
import { createUltimateHttp } from '../src/devices/ultimate-http.mjs';
import { createUltimateLaunchExecutor } from '../src/devices/ultimate-launch.mjs';
import { connectUltimateTcp } from '../src/devices/ultimate-tcp.mjs';

const nonce = 'af'.repeat(16);
const owner = 'cd'.repeat(16);
const boot = Buffer.from([1, 8, 11, 8, 10, 0, 0x9e, 50, 48, 54, 49, 0, 0, 0, 0xea, 0x60]);
const program = Buffer.from([0, 0x40, 0xa9, 5, 0x8d, 0x20, 0xd0, 0x60]);
const image = Buffer.alloc(128 * 1024);
for (let i = 0; i < image.length; i++) image[i] = (i ^ (i >>> 8)) & 255;

function multipartPayload(body) {
  const start = body.indexOf(Buffer.from('\r\n\r\n')) + 4;
  const end = body.lastIndexOf(Buffer.from('\r\n--'));
  if (start < 4 || end <= start) throw new Error('invalid_lab_multipart');
  return body.subarray(start, end);
}

test('sealed job through real HTTP/TCP adapters waits for guest ready and REU fence before release', async () => {
  const events = [], sockets = new Set(), guestMemory = Buffer.alloc(65536), reu = Buffer.alloc(image.length);
  const mailbox = 0xcfc0;
  let guestReady = false, released = false;
  const reply = (response, value) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ...value, errors: [] }));
  };
  const httpServer = createHttpServer(async (request, response) => {
    if (request.headers['x-password'] !== 'lab-secret') { response.statusCode = 403; response.end(); return; }
    const path = new URL(request.url, 'http://device.invalid');
    const body = Buffer.concat(await Array.fromAsync(request));
    events.push(`${request.method} ${path.pathname}`);
    if (path.pathname === '/v1/version') return reply(response, { version: '1.0' });
    if (path.pathname === '/v1/info') return reply(response, { product: 'C64 Ultimate', firmware_version: 'lab' });
    if (path.pathname === '/v1/configs') return reply(response,
      { categories: ['U64 Specific Settings', 'C64 and Cartridge Settings'] });
    if (path.pathname === '/v1/configs/U64%20Specific%20Settings') return reply(response,
      { 'U64 Specific Settings': { 'System Mode': 'PAL', 'Turbo Control': 'Off', 'CPU Speed': ' 1' } });
    if (path.pathname === '/v1/configs/C64%20and%20Cartridge%20Settings') return reply(response,
      { 'C64 and Cartridge Settings': { 'RAM Expansion Unit': 'Enabled', 'REU Size': '128 KB' } });
    if (path.pathname === '/v1/drives') return reply(response, { drives: [{ a: { enabled: true, bus_id: 8 } }] });
    if (path.pathname === '/v1/runners:run_prg') {
      assert.deepEqual(multipartPayload(body), boot);
      guestReady = true;
      return reply(response, {});
    }
    if (path.pathname === '/v1/machine:readmem') {
      assert.equal(path.searchParams.get('address'), 'CFC0');
      assert.equal(path.searchParams.get('length'), '64');
      const bytes = Buffer.alloc(64);
      Buffer.from('W64U').copy(bytes);
      bytes[4] = 1;
      Buffer.from(nonce, 'hex').copy(bytes, 5);
      bytes[21] = released ? 3 : guestReady ? 1 : 0;
      response.end(bytes);
      return;
    }
    if (path.pathname === '/v1/machine:writemem') {
      const address = Number.parseInt(path.searchParams.get('address'), 16);
      const payload = multipartPayload(body);
      payload.copy(guestMemory, address);
      if (address === mailbox + 21) {
        assert.deepEqual(payload, Buffer.of(2));
        assert.deepEqual(reu, image, 'all REU bytes must precede release');
        events.push('guest release');
        released = true;
      }
      return reply(response, {});
    }
    response.statusCode = 404;
    reply(response, {});
  });
  const tcpServer = createTcpServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4 && pending.length >= 4 + pending.readUInt16LE(2)) {
        const length = pending.readUInt16LE(2);
        const frame = pending.subarray(0, 4 + length);
        pending = pending.subarray(4 + length);
        const command = frame.readUInt16LE(0);
        if (command === 0xff1f) {
          assert.equal(frame.subarray(4).toString(), 'lab-secret');
          socket.write(Buffer.of(1));
        } else if (command === 0xff07) {
          const offset = frame[4] | (frame[5] << 8) | (frame[6] << 16);
          frame.subarray(7).copy(reu, offset);
          events.push(`REU ${offset}`);
        } else if (command === 0xff0e) {
          events.push('REU fence');
          socket.write(Buffer.from([4, 67, 54, 52, 85]));
        } else throw new Error('unexpected_lab_tcp_command');
      }
    });
  });
  await Promise.all([
    new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve)),
    new Promise(resolve => tcpServer.listen(0, '127.0.0.1', resolve)),
  ]);
  const scratch = await mkdtemp(join(tmpdir(), 'web64-c64u-dispatch-lab-'));
  let jobs;
  try {
    const target = { host: 'c64u.lab', pinnedAddress: '127.0.0.1', assertStable: async () => '127.0.0.1' };
    const http = createUltimateHttp({ target, password: 'lab-secret', port: httpServer.address().port });
    const executor = createUltimateLaunchExecutor({ http,
      connectTcp: () => connectUltimateTcp({ target, password: 'lab-secret', port: tcpServer.address().port }),
      pollMs: 1, acknowledgementMs: 20 });
    jobs = createDeviceJobs({ target, executor, stagingRoot: scratch, lease: async () => async () => {} });
    const parts = [
      { id: 'bootstrap', kind: 'prg', bytes: boot },
      { id: 'program', kind: 'prg', bytes: program },
      { id: 'image', kind: 'reu', bytes: image },
    ];
    const manifest = { operationId: randomUUID(), projectRevision: 'lab:one', recipe: {
      kind: 'prg', requirements: { video: 'pal', reuCapacityKiB: 128, driveUnits: [] },
      program: { artifactId: 'program', entryAddress: 0x4000 }, reuArtifactId: 'image',
      bootstrap: { artifactId: 'bootstrap', nonce, workspace: { address: 0xc800, length: 0x800 } },
    }, artifacts: parts.map(({ id, kind, bytes }) => ({ id, kind, length: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') })) };
    const created = await jobs.create(manifest, owner);
    for (const { id, bytes } of parts) {
      for (let offset = 0; offset < bytes.length; offset += 65536) {
        await jobs.upload(created.jobId, id, offset, bytes.subarray(offset, offset + 65536), owner);
      }
    }
    await jobs.seal(created.jobId, owner);
    const checked = await jobs.preflight(created.jobId, owner);
    assert.equal(checked.details.ready, true);
    assert.equal(jobs.status(created.jobId, owner).phase, 'awaiting-approval');
    const receipt = await jobs.commit(created.jobId, owner);
    assert.equal(receipt.phase, 'finished');
    assert.equal(receipt.deliveryLevel, 'launch-requested');
    assert.equal(receipt.outcomeKnown, false);
    assert.equal(receipt.guestHandoffObserved, true);
    assert.deepEqual(guestMemory.subarray(0x4000, 0x4000 + program.length - 2), program.subarray(2));
    const at = event => events.findIndex(item => item === event);
    assert.ok(at('POST /v1/runners:run_prg') < at('REU 0'));
    // The first fence is the preflight DMA-service probe; the last one follows the REU writes.
    const lastFence = events.lastIndexOf('REU fence');
    assert.ok(at('REU fence') < at('POST /v1/runners:run_prg'));
    assert.ok(at('REU 98304') < lastFence);
    assert.ok(lastFence < at('guest release'));
    assert.equal(events.filter(item => item === 'guest release').length, 1);
  } finally {
    if (jobs) await jobs.close();
    for (const socket of sockets) socket.destroy();
    httpServer.closeAllConnections();
    await Promise.all([
      new Promise(resolve => httpServer.close(resolve)),
      new Promise(resolve => tcpServer.close(resolve)),
    ]);
    await rm(scratch, { recursive: true, force: false });
  }
});
