import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createUltimateHttp } from '../src/devices/ultimate-http.mjs';
import { connectUltimateTcp } from '../src/devices/ultimate-tcp.mjs';

test('pinned-wire lab composes read-only preflight, REU write/fence and one runner dispatch', async () => {
  const log = [];
  const reu = Buffer.alloc(512 * 1024);
  const sockets = new Set();
  const httpServer = createHttpServer(async (request, response) => {
    log.push(`${request.method} ${request.url}`);
    if (request.headers['x-password'] !== 'test') { response.statusCode = 403; response.end(); return; }
    const bodies = {
      '/v1/version': { version: '0.1', errors: [] },
      '/v1/info': { product: 'Synthetic C64U', firmware_version: 'lab', errors: [] },
      '/v1/drives': { drives: [{ a: { enabled: true, bus_id: 8 } }], errors: [] },
      '/v1/configs': { categories: ['C64 and Cartridge Settings'], errors: [] },
      '/v1/runners:run_prg': { errors: [] },
    };
    if (!bodies[request.url]) { response.statusCode = 404; response.end(JSON.stringify({ errors: ['unknown'] })); return; }
    for await (const _ of request) { /* consume the single-file attachment */ }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(bodies[request.url]));
  });
  const tcpServer = createTcpServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let buffered = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt16LE(2)) {
        const length = buffered.readUInt16LE(2);
        const frame = buffered.subarray(0, 4 + length);
        buffered = buffered.subarray(4 + length);
        const command = frame.readUInt16LE(0);
        if (command === 0xff1f) {
          log.push('TCP auth');
          socket.write(Buffer.from([frame.subarray(4).toString() === 'test' ? 1 : 0]));
        } else if (command === 0xff07) {
          const offset = frame[4] | (frame[5] << 8) | (frame[6] << 16);
          frame.subarray(7).copy(reu, offset);
          log.push(`TCP write ${offset}`);
        } else if (command === 0xff0e) {
          log.push('TCP identify');
          socket.write(Buffer.from([4]));
          setTimeout(() => socket.write(Buffer.from('C64U')), 1);
        }
      }
    });
  });
  await Promise.all([
    new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve)),
    new Promise(resolve => tcpServer.listen(0, '127.0.0.1', resolve)),
  ]);
  const scratch = await mkdtemp(join(tmpdir(), 'web64-c64u-lab-'));
  try {
    const target = { host: 'c64u.local', assertStable: async () => '127.0.0.1' };
    const http = createUltimateHttp({ target, password: 'test', port: httpServer.address().port });
    const [version, info, drives, configs] = await Promise.all([
      http.getVersion(), http.getInfo(), http.getDrives(), http.getConfigs(),
    ]);
    assert.equal(version.version, '0.1');
    assert.equal(info.product, 'Synthetic C64U');
    assert.equal(drives.drives[0].a.bus_id, 8);
    assert.equal(configs.categories.length, 1);
    const tcp = await connectUltimateTcp({ target, password: 'test', port: tcpServer.address().port });
    await tcp.writeReu(0x100, Buffer.from([0x11, 0x22]), reu.length);
    assert.equal(await tcp.barrier(), 'C64U');
    tcp.close();
    const path = join(scratch, 'boot.prg');
    await writeFile(path, Buffer.from([0x01, 0x08, 0x60]));
    await http.runPrg({ name: 'boot.prg', path, size: 3 });
    assert.deepEqual(reu.subarray(0x100, 0x102), Buffer.from([0x11, 0x22]));
    assert.ok(log.indexOf('TCP identify') < log.indexOf('POST /v1/runners:run_prg'));
    assert.equal(log.filter(entry => entry === 'POST /v1/runners:run_prg').length, 1);
  } finally {
    for (const socket of sockets) socket.destroy();
    httpServer.closeAllConnections();
    await Promise.all([
      new Promise(resolve => httpServer.close(resolve)),
      new Promise(resolve => tcpServer.close(resolve)),
    ]);
    await rm(scratch, { recursive: true, force: false });
  }
});
