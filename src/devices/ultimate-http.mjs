import { createReadStream } from 'node:fs';
import { request as defaultRequest } from 'node:http';
import { randomBytes } from 'node:crypto';

const MAX_JSON_BYTES = 256 * 1024;
const MAX_BINARY_BYTES = 64;
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

function hexAddress(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new Error('invalid_c64_address');
  return value.toString(16).toUpperCase().padStart(4, '0');
}

async function boundedBody(response, maxBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      response.destroy();
      throw new Error('http_response_oversized');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJsonResponse(body) {
  let result;
  try { result = JSON.parse(body.toString('utf8')); } catch { throw new Error('http_invalid_json'); }
  if (!result || !Array.isArray(result.errors) || result.errors.some(error => typeof error !== 'string')) {
    throw new Error('http_invalid_response');
  }
  if (result.errors.length) throw new Error(`device_error:${result.errors.join('; ').slice(0, 512)}`);
  return result;
}

export function createUltimateHttp({ target, password = '', port = 80, request = defaultRequest, timeoutMs = 30000,
  connectTimeoutMs = 5000 }) {
  if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > 256 || /[\r\n]/.test(password)) {
    throw new Error('invalid_device_password');
  }
  async function send(method, path, { body, contentType, file, multipartFilename, binaryLength } = {}) {
    const address = await target.assertStable();
    const headers = { Host: target.host, Connection: 'close', ...(password ? { 'X-Password': password } : {}) };
    let prefix, suffix, fileSize;
    if (file) {
      if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_UPLOAD_BYTES ||
          !/^[a-z0-9][a-z0-9_-]{0,63}\.(?:prg|crt|d64|bin)$/i.test(file.name)) {
        throw new Error('invalid_device_artifact');
      }
      const boundary = `web64-${randomBytes(16).toString('hex')}`;
      prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
      suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
      fileSize = file.size;
      headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
      headers['Content-Length'] = prefix.length + fileSize + suffix.length;
    } else if (body) {
      if (!Buffer.isBuffer(body) || body.length < 1 || body.length > 65536) throw new Error('invalid_device_body');
      if (multipartFilename) {
        if (!/^[a-z0-9_-]{1,64}\.bin$/i.test(multipartFilename)) throw new Error('invalid_device_artifact');
        const boundary = `web64-${randomBytes(16).toString('hex')}`;
        const first = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${multipartFilename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
        const last = Buffer.from(`\r\n--${boundary}--\r\n`);
        body = Buffer.concat([first, body, last]);
        headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
      } else headers['Content-Type'] = contentType || 'application/octet-stream';
      headers['Content-Length'] = body.length;
    }
    // The staged artifact stream must be closed on every outcome. A failed or
    // timed-out upload used to leave it open, so on Windows the job's staging
    // directory could not be removed and the real error was masked.
    let input = null;
    let inputClosed = Promise.resolve();
    try {
      const response = await new Promise((resolve, reject) => {
        const outgoing = request({ host: address, port, method, path, headers, agent: false }, resolve);
        outgoing.setTimeout(timeoutMs, () => outgoing.destroy(new Error('http_timeout')));
        outgoing.once('error', reject);
        // An unreachable private address otherwise waits for the 30 s idle
        // timeout, longer than the browser's request deadline.
        outgoing.once('socket', socket => {
          if (!socket.connecting) return;
          const timer = setTimeout(() => outgoing.destroy(new Error('device_connect_timeout')), connectTimeoutMs);
          socket.once('connect', () => clearTimeout(timer));
          socket.once('close', () => clearTimeout(timer));
        });
        if (file) {
          outgoing.write(prefix);
          input = createReadStream(file.path, { highWaterMark: 65536 });
          const stream = input;
          inputClosed = new Promise(done => stream.once('close', done));
          stream.once('error', error => outgoing.destroy(error));
          stream.once('end', () => outgoing.end(suffix));
          outgoing.once('close', () => { if (!stream.readableEnded) stream.destroy(); });
          stream.pipe(outgoing, { end: false });
        } else outgoing.end(body);
      });
      if (response.statusCode < 200 || response.statusCode >= 300 || response.headers.location) {
        response.destroy();
        throw new Error(response.statusCode === 403 ? 'device_auth_rejected' : `http_status_${response.statusCode}`);
      }
      const payload = await boundedBody(response, binaryLength === undefined ? MAX_JSON_BYTES : MAX_BINARY_BYTES);
      if (binaryLength !== undefined) {
        if (payload.length !== binaryLength) throw new Error('http_binary_length_mismatch');
        return payload;
      }
      return parseJsonResponse(payload);
    } finally {
      if (input) {
        if (!input.readableEnded) input.destroy();
        await inputClosed;
      }
    }
  }
  return Object.freeze({
    getVersion: () => send('GET', '/v1/version'),
    getInfo: () => send('GET', '/v1/info'),
    getConfigs: () => send('GET', '/v1/configs'),
    getConfigCategory: category => {
      if (!['U64 Specific Settings', 'C64 and Cartridge Settings'].includes(category)) {
        throw new Error('invalid_config_category');
      }
      return send('GET', `/v1/configs/${encodeURIComponent(category)}`);
    },
    getDrives: () => send('GET', '/v1/drives'),
    runPrg: file => send('POST', '/v1/runners:run_prg', { file }),
    runCrt: file => send('POST', '/v1/runners:run_crt', { file }),
    mountD64: (drive, mode, file) => {
      if (!['a', 'b'].includes(drive) || !['unlinked', 'readonly'].includes(mode)) throw new Error('invalid_mount');
      return send('POST', `/v1/drives/${drive}:mount?type=d64&mode=${mode}`, { file });
    },
    readMailbox: address => send('GET', `/v1/machine:readmem?address=${hexAddress(address)}&length=64`, { binaryLength: 64 }),
    writeMemory: (address, body) => {
      hexAddress(address);
      if (!Buffer.isBuffer(body) || address + body.length > 0x10000) throw new Error('invalid_memory_range');
      return send('POST', `/v1/machine:writemem?address=${hexAddress(address)}`,
        { body, multipartFilename: 'ram.bin' });
    },
    reset: () => send('PUT', '/v1/machine:reset'),
  });
}
