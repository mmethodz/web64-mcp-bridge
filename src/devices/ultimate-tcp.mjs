import { connect as netConnect } from 'node:net';

const MAX_REU_CHUNK = 32768;
const MAX_IDENTITY = 255;

export function encodeTcpFrame(command, payload = Buffer.alloc(0)) {
  if (!Number.isInteger(command) || command < 0 || command > 0xffff ||
      !Buffer.isBuffer(payload) || payload.length > 0xffff) throw new Error('invalid_tcp_frame');
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt16LE(command, 0);
  frame.writeUInt16LE(payload.length, 2);
  payload.copy(frame, 4);
  return frame;
}

export function encodeReuWrite(offset, data, capacityBytes) {
  if (!Buffer.isBuffer(data) || data.length < 1 || data.length > MAX_REU_CHUNK ||
      !Number.isSafeInteger(offset) || offset < 0 || offset > 0xffffff ||
      !Number.isSafeInteger(capacityBytes) || capacityBytes < 1 || capacityBytes > 0x1000000 ||
      offset + data.length > capacityBytes || offset + data.length > 0x1000000) {
    throw new Error('invalid_reu_write');
  }
  const payload = Buffer.allocUnsafe(3 + data.length);
  payload[0] = offset & 255;
  payload[1] = (offset >>> 8) & 255;
  payload[2] = (offset >>> 16) & 255;
  data.copy(payload, 3);
  return encodeTcpFrame(0xff07, payload);
}

class BoundedReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.pending = null;
    this.error = null;
    socket.on('data', data => {
      if (this.error) return;
      if (this.buffer.length + data.length > 1024) return this.fail(new Error('tcp_reply_oversized'));
      this.buffer = Buffer.concat([this.buffer, data]);
      this.flush();
    });
    socket.on('error', error => this.fail(error));
    socket.on('end', () => this.fail(new Error('tcp_reply_short')));
    socket.on('close', () => this.fail(new Error('tcp_connection_closed')));
  }
  fail(error) {
    if (this.error) return;
    this.error = error;
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending?.reject(error);
    this.pending = null;
    this.socket.destroy();
  }
  flush() {
    if (!this.pending || this.buffer.length < this.pending.length) return;
    const { length, resolve, timer } = this.pending;
    clearTimeout(timer);
    this.pending = null;
    const result = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    resolve(result);
  }
  read(length, timeoutMs = 30000) {
    if (!Number.isInteger(length) || length < 1 || length > 256 || this.pending) throw new Error('invalid_tcp_read');
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('tcp_reply_timeout')), timeoutMs);
      this.pending = { length, resolve, reject, timer };
      this.flush();
    });
  }
}

async function writeFrame(socket, frame) {
  if (socket.destroyed) throw new Error('tcp_connection_closed');
  await new Promise((resolve, reject) => socket.write(frame, error => error ? reject(error) : resolve()));
}

export async function connectUltimateTcp({ target, password = '', port = 64, connect = netConnect,
  timeoutMs = 10000, responseTimeoutMs = 30000 }) {
  const address = await target.assertStable();
  const socket = connect({ host: address, port });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('tcp_connect_timeout')); }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); socket.off('error', onError); resolve(); });
    const onError = error => { clearTimeout(timer); reject(error); };
    socket.once('error', onError);
  });
  const reader = new BoundedReader(socket);
  try {
    if (password) {
      const bytes = Buffer.from(password, 'utf8');
      if (bytes.length > 255 || bytes.length === 0) throw new Error('invalid_device_password');
      await writeFrame(socket, encodeTcpFrame(0xff1f, bytes));
      const reply = await reader.read(1, responseTimeoutMs);
      if (reply[0] !== 1) throw new Error('tcp_auth_rejected');
    }
    return {
      async writeReu(offset, data, capacityBytes) {
        await target.assertStable();
        await writeFrame(socket, encodeReuWrite(offset, data, capacityBytes));
      },
      async barrier() {
        await target.assertStable();
        await writeFrame(socket, encodeTcpFrame(0xff0e));
        const length = (await reader.read(1, responseTimeoutMs))[0];
        if (length < 1 || length > MAX_IDENTITY) throw new Error('tcp_identity_invalid');
        return (await reader.read(length, responseTimeoutMs)).toString('utf8');
      },
      close() { socket.destroy(); },
    };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}
