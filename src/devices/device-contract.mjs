import { createHmac, timingSafeEqual } from 'node:crypto';

export const DEVICE_WIRE = 'web64-device-v1';
export const DEVICE_BINARY_MAGIC = Buffer.from('W64D');
export const DEVICE_MAX_BINARY_FRAME = 65536 + 110;

const NETWORK_ERROR_CODES = Object.freeze({
  ECONNREFUSED: 'device_connection_refused',
  EHOSTUNREACH: 'device_unreachable', ENETUNREACH: 'device_unreachable', EHOSTDOWN: 'device_unreachable',
  ETIMEDOUT: 'device_timeout',
  ECONNRESET: 'device_connection_reset', EPIPE: 'device_connection_reset', ECONNABORTED: 'device_connection_reset',
  ENOTFOUND: 'device_name_unresolved', EAI_AGAIN: 'device_name_unresolved',
});
const SAFE_CODE = /^[a-z][a-z0-9_:-]{0,79}$/;

// Stable, user-diagnosable error code without addresses or stack details.
// Node socket errors carry upper-case codes (ECONNREFUSED...), which the old
// sanitizer collapsed into a generic failure; firmware error text is kept.
export function deviceErrorCode(error) {
  const code = error?.code;
  if (typeof code === 'string' && NETWORK_ERROR_CODES[code]) return NETWORK_ERROR_CODES[code];
  const message = error?.message;
  if (typeof message === 'string') {
    if (SAFE_CODE.test(message)) return message;
    if (message.startsWith('device_error:')) return message.replace(/[^\x20-\x7e]/g, '?').slice(0, 200);
  }
  if (typeof code === 'string' && SAFE_CODE.test(code)) return code;
  return 'device_request_failed';
}

export function deviceTranscript(invitation, clientNonce, serverNonce, role) {
  return JSON.stringify([DEVICE_WIRE, invitation.id, invitation.instance, invitation.origin,
    clientNonce, serverNonce, role]);
}

export function deviceProof(secret, transcript) {
  return createHmac('sha256', Buffer.from(secret, 'hex')).update(transcript).digest('hex');
}

export function verifyDeviceProof(secret, transcript, supplied) {
  if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied)) return false;
  return timingSafeEqual(Buffer.from(deviceProof(secret, transcript), 'hex'), Buffer.from(supplied, 'hex'));
}

export function decodeDeviceChunk(frame) {
  if (!Buffer.isBuffer(frame) || frame.length < 46 || frame.length > DEVICE_MAX_BINARY_FRAME ||
      !frame.subarray(0, 4).equals(DEVICE_BINARY_MAGIC) || frame[4] !== 1) throw new Error('invalid_device_chunk_frame');
  const requestId = frame.subarray(5, 21).toString('hex');
  const jobHex = frame.subarray(21, 37).toString('hex');
  const jobId = `${jobHex.slice(0, 8)}-${jobHex.slice(8, 12)}-${jobHex.slice(12, 16)}-${jobHex.slice(16, 20)}-${jobHex.slice(20)}`;
  const idLength = frame[37];
  const headerLength = 46 + idLength;
  if (idLength < 1 || idLength > 64 || frame.length < headerLength ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(frame.subarray(38, 38 + idLength).toString('ascii'))) {
    throw new Error('invalid_device_chunk_frame');
  }
  const offset = frame.readUInt32LE(38 + idLength);
  const dataLength = frame.readUInt32LE(42 + idLength);
  if (dataLength < 1 || dataLength > 65536 || frame.length !== headerLength + dataLength) {
    throw new Error('invalid_device_chunk_frame');
  }
  return { requestId, jobId, artifactId: frame.subarray(38, 38 + idLength).toString('ascii'),
    offset, data: frame.subarray(headerLength) };
}

export function encodeDeviceChunk({ requestId, jobId, artifactId, offset, data }) {
  if (!/^[a-f0-9]{32}$/.test(requestId) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(jobId) ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(artifactId) || !Number.isInteger(offset) || offset < 0 ||
      !Buffer.isBuffer(data) || data.length < 1 || data.length > 65536) throw new Error('invalid_device_chunk_frame');
  const id = Buffer.from(artifactId, 'ascii');
  const frame = Buffer.allocUnsafe(46 + id.length + data.length);
  DEVICE_BINARY_MAGIC.copy(frame, 0);
  frame[4] = 1;
  Buffer.from(requestId, 'hex').copy(frame, 5);
  Buffer.from(jobId.replaceAll('-', ''), 'hex').copy(frame, 21);
  frame[37] = id.length;
  id.copy(frame, 38);
  frame.writeUInt32LE(offset, 38 + id.length);
  frame.writeUInt32LE(data.length, 42 + id.length);
  data.copy(frame, 46 + id.length);
  return frame;
}
