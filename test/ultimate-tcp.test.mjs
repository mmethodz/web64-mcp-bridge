import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { connectUltimateTcp, encodeReuWrite, encodeTcpFrame } from '../src/devices/ultimate-tcp.mjs';

test('TCP serializer matches pinned vectors and enforces REU boundaries', () => {
  assert.equal(encodeReuWrite(0x080000, Buffer.from([0x11, 0x22]), 0x100000).toString('hex'), '07ff05000000081122');
  assert.equal(encodeTcpFrame(0xff0e).toString('hex'), '0eff0000');
  assert.throws(() => encodeReuWrite(0xffffff, Buffer.from([1, 2]), 0x1000000), /invalid_reu_write/);
  assert.throws(() => encodeReuWrite(0, Buffer.alloc(32769), 0x1000000), /invalid_reu_write/);
  assert.throws(() => encodeReuWrite(0, Buffer.alloc(0), 0x1000000), /invalid_reu_write/);
});

test('TCP auth, write and fragmented identify reply stay on one connection', async () => {
  const frames = [];
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4 && pending.length >= 4 + pending.readUInt16LE(2)) {
        const length = pending.readUInt16LE(2);
        const frame = pending.subarray(0, 4 + length);
        pending = pending.subarray(4 + length);
        frames.push(Buffer.from(frame));
        const command = frame.readUInt16LE(0);
        if (command === 0xff1f) socket.write(Buffer.from([1]));
        if (command === 0xff0e) {
          socket.write(Buffer.from([4]));
          setTimeout(() => socket.write(Buffer.from('C64U')), 5);
        }
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const target = { assertStable: async () => '127.0.0.1' };
    const session = await connectUltimateTcp({ target, password: 'test', port: server.address().port });
    await session.writeReu(0x080000, Buffer.from([0x11, 0x22]), 0x100000);
    assert.equal(await session.barrier(), 'C64U');
    session.close();
    assert.deepEqual(frames.map(frame => frame.readUInt16LE(0)), [0xff1f, 0xff07, 0xff0e]);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});

test('short identify response never qualifies a processing fence', async () => {
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('data', frame => {
      if (frame.readUInt16LE(0) === 0xff0e) {
        socket.write(Buffer.from([5, 65]));
        socket.end();
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const session = await connectUltimateTcp({ target: { assertStable: async () => '127.0.0.1' }, port: server.address().port });
    await assert.rejects(session.barrier(), /tcp_reply_short|tcp_connection_closed/);
    session.close();
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});

test('missing TCP barrier reply times out without permitting launch', async () => {
  const sockets = new Set();
  const server = createServer(socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const session = await connectUltimateTcp({ target: { assertStable: async () => '127.0.0.1' },
      port: server.address().port, responseTimeoutMs: 20 });
    await assert.rejects(session.barrier(), /tcp_reply_timeout/);
    session.close();
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
