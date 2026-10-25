import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { validLocalRequest } from '../security.mjs';
import { DEVICE_MAX_BINARY_FRAME, DEVICE_WIRE, decodeDeviceChunk, deviceErrorCode, deviceProof,
  deviceTranscript, verifyDeviceProof } from './device-contract.mjs';

const nonce = () => randomBytes(16).toString('hex');
const MAX_CONTROL = 64 * 1024;
const INVITATION_MS = 5 * 60 * 1000;
const GRANT_MS = 20 * 60 * 1000;
const ACTIVE_JOB_PHASES = new Set(['preparing', 'transferring', 'launch-requested']);

function exact(message, names) {
  return message && typeof message === 'object' && !Array.isArray(message) &&
    Object.keys(message).sort().join(',') === [...names].sort().join(',');
}

function safeError(error) {
  return deviceErrorCode(error);
}

export async function createDevicePairing({ ideUrl, jobs, describe, clock = Date.now, listenPort = 0 } = {}) {
  const url = new URL(ideUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.pathname !== '/ide/' || url.search || url.hash ||
      url.username || url.password) throw new Error('invalid_ide_url');
  if (!jobs || typeof describe !== 'function') throw new Error('invalid_device_pairing');
  const origin = url.origin;
  const instance = nonce();
  const server = createServer((_req, response) => { response.writeHead(404); response.end(); });
  server.maxConnections = 2;
  server.requestTimeout = 10000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: DEVICE_MAX_BINARY_FRAME, perMessageDeflate: false });
  let invitation = null;
  let session = null;
  let closed = false;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(listenPort, '127.0.0.1', resolve); });
  const port = server.address().port;

  // An expired grant is not revoked while one of its jobs is transferring or
  // releasing the guest: revoking cancels the job and would leave the device
  // in an unknown, half-loaded state. The session ends as soon as it settles.
  function sessionBusy(current) {
    for (const id of current.jobs) {
      try { if (ACTIVE_JOB_PHASES.has(jobs.status(id, current.id)?.phase)) return true; } catch { /* trimmed receipt */ }
    }
    return false;
  }
  function expireIfIdle() {
    if (session && session.expiresAt <= clock() && !sessionBusy(session)) revoke();
  }

  function revoke() {
    invitation = null;
    if (!session) return;
    const old = session;
    session = null;
    old.ws.close(1000, 'Device grant revoked');
    for (const id of old.jobs) void jobs.cancel(id, old.id).catch(() => {});
  }
  server.on('upgrade', (request, socket, head) => {
    if (closed || request.url !== '/device-session' || !validLocalRequest(request, port, origin, true) ||
        wss.clients.size >= 1) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, ws => {
      let phase = 'hello';
      let claimed = null;
      let clientNonce = null;
      let serverNonce = null;
      let chain = Promise.resolve();
      const seenRequests = new Set();
      const timeout = setTimeout(() => ws.close(1008, 'Device pairing expired'), INVITATION_MS);
      const reject = () => ws.close(1008, 'Device pairing rejected');
      const reply = (requestId, promise) => {
        Promise.resolve(promise).then(value => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'result', requestId, ok: true, value }));
        }, error => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'result', requestId, ok: false, error: safeError(error) }));
        });
      };
      ws.on('error', reject);
      ws.on('close', () => {
        clearTimeout(timeout);
        if (session?.ws === ws) revoke();
      });
      ws.on('message', (raw, binary) => {
        chain = chain.then(async () => {
          if (ws.readyState !== ws.OPEN) throw new Error('session_unavailable');
          if (binary) {
            if (phase !== 'connected' || !session || session.ws !== ws ||
                !session.scopes.includes('execute') || session.expiresAt <= clock()) throw new Error('scope_denied');
            const frame = decodeDeviceChunk(Buffer.from(raw));
            if (seenRequests.has(frame.requestId) || seenRequests.size >= 1024) throw new Error('duplicate_request');
            seenRequests.add(frame.requestId);
            reply(frame.requestId, jobs.upload(frame.jobId, frame.artifactId, frame.offset, frame.data, session.id));
            return;
          }
          if (raw.length > MAX_CONTROL) throw new Error('control_too_large');
          const message = JSON.parse(raw.toString('utf8'));
          if (phase === 'hello') {
            if (!exact(message, ['type', 'wire', 'id', 'instance', 'clientNonce']) || message.type !== 'hello' ||
                message.wire !== DEVICE_WIRE || !/^[a-f0-9]{32}$/.test(message.clientNonce) ||
                !invitation || invitation.id !== message.id || invitation.instance !== message.instance ||
                invitation.expiresAt <= clock()) throw new Error('invitation_invalid');
            claimed = invitation;
            invitation = null; // Consume before awaiting any proof or consent.
            clientNonce = message.clientNonce;
            serverNonce = nonce();
            phase = 'proof';
            ws.send(JSON.stringify({ type: 'challenge', serverNonce,
              proof: deviceProof(claimed.secret, deviceTranscript(claimed, clientNonce, serverNonce, 'bridge')) }));
            return;
          }
          if (phase === 'proof') {
            if (!exact(message, ['type', 'proof']) || message.type !== 'proof' ||
                claimed.expiresAt <= clock() ||
                !verifyDeviceProof(claimed.secret, deviceTranscript(claimed, clientNonce, serverNonce, 'browser'), message.proof)) {
              throw new Error('proof_invalid');
            }
            phase = 'consent';
            ws.send(JSON.stringify({ type: 'verified', deviceLabel: claimed.deviceLabel,
              scopes: ['inspect', 'execute'], expiresAt: claimed.expiresAt }));
            return;
          }
          if (phase === 'consent') {
            if (!exact(message, ['type', 'scopes']) || message.type !== 'consent' ||
                !Array.isArray(message.scopes) ||
                !(['["inspect"]', '["inspect","execute"]'].includes(JSON.stringify(message.scopes))) ||
                claimed.expiresAt <= clock()) throw new Error('consent_invalid');
            clearTimeout(timeout);
            phase = 'connected';
            session = { id: nonce(), ws, scopes: message.scopes,
              expiresAt: Math.min(clock() + GRANT_MS, claimed.expiresAt + GRANT_MS), jobs: new Set() };
            ws.send(JSON.stringify({ type: 'ready', wire: DEVICE_WIRE, sessionId: session.id,
              scopes: session.scopes, expiresAt: session.expiresAt }));
            claimed = null;
            return;
          }
          if (!session || session.ws !== ws ||
              !exact(message, ['type', 'requestId', 'action', 'params']) || message.type !== 'request' ||
              !/^[a-f0-9]{32}$/.test(message.requestId) || seenRequests.has(message.requestId) ||
              seenRequests.size >= 1024 || !message.params || typeof message.params !== 'object') {
            throw new Error('device_request_invalid');
          }
          seenRequests.add(message.requestId);
          const inspect = session.scopes.includes('inspect');
          const execute = session.scopes.includes('execute');
          const { action, params, requestId } = message;
          const expectedParams = action === 'device.describe' ? [] : action === 'job.create' ? ['manifest']
            : ['job.seal', 'job.preflight', 'job.commit', 'job.status', 'job.cancel'].includes(action) ? ['jobId'] : null;
          if (!expectedParams || !exact(params, expectedParams)) throw new Error('device_request_invalid');
          if (session.expiresAt <= clock() &&
              !(['job.status', 'job.cancel'].includes(action) && session.jobs.has(params.jobId))) {
            // Report expiry as an ordinary error; only the owner's running job
            // may still be observed or cancelled until it settles.
            reply(requestId, Promise.reject(new Error('device_session_expired')));
            return;
          }
          let result;
          switch (action) {
            case 'device.describe':
              if (!inspect) throw new Error('scope_denied');
              result = describe(); break;
            case 'job.create':
              if (!execute) throw new Error('scope_denied');
              {
                const owner = session;
                result = jobs.create(params.manifest, owner.id).then(async value => {
                  if (session !== owner) await jobs.cancel(value.jobId, owner.id);
                  else owner.jobs.add(value.jobId);
                  return value;
                });
              }
              break;
            case 'job.seal':
              if (!execute) throw new Error('scope_denied');
              result = jobs.seal(params.jobId, session.id); break;
            case 'job.preflight':
              if (!inspect) throw new Error('scope_denied');
              result = jobs.preflight(params.jobId, session.id); break;
            case 'job.commit':
              if (!execute) throw new Error('scope_denied');
              // A 16 MiB REU transfer can exceed the browser control timeout.
              // Commit starts once; status/cancel remain available while it runs.
              // Job-state errors (unknown job, not approved) are thrown
              // synchronously; report them instead of ending the whole session.
              try {
                jobs.commit(params.jobId, session.id);
                result = jobs.status(params.jobId, session.id);
              } catch (error) { result = Promise.reject(error); }
              break;
            case 'job.status':
              if (!inspect) throw new Error('scope_denied');
              {
                const owner = session.id;
                result = Promise.resolve().then(() => jobs.status(params.jobId, owner));
              }
              break;
            case 'job.cancel':
              if (!execute) throw new Error('scope_denied');
              result = jobs.cancel(params.jobId, session.id); break;
            default: throw new Error('device_action_not_allowed');
          }
          // A long-running commit must not block status or cancellation traffic.
          reply(requestId, result);
        }).catch(reject);
      });
    });
  });
  const expiry = setInterval(() => {
    if (invitation?.expiresAt <= clock()) invitation = null;
    expireIfIdle();
  }, 1000);
  expiry.unref();
  return Object.freeze({
    port,
    begin(deviceLabel) {
      if (closed) throw new Error('device_pairing_closed');
      revoke();
      if (typeof deviceLabel !== 'string' || deviceLabel.length < 1 || deviceLabel.length > 80) throw new Error('invalid_device_label');
      invitation = { wire: DEVICE_WIRE, id: nonce(), instance, secret: randomBytes(32).toString('hex'),
        origin, port, expiresAt: clock() + INVITATION_MS, deviceLabel };
      const fragment = Buffer.from(JSON.stringify(invitation)).toString('base64url');
      return { url: `${url.href}#web64-device-v1=${fragment}`, expiresAt: invitation.expiresAt,
        authority: 'Inspect reads device state. Execute can replace current program, temporary disk mounts and REU bytes after an explicit Run on C64U action. No AI/Cloud access.' };
    },
    status() {
      if (invitation?.expiresAt <= clock()) invitation = null;
      expireIfIdle();
      return { state: session ? 'connected' : invitation ? 'inviting' : 'idle',
        scopes: session?.scopes || [], expiresAt: session?.expiresAt || invitation?.expiresAt || null };
    },
    revoke,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(expiry);
      revoke();
      for (const client of wss.clients) client.terminate();
      await new Promise(resolve => wss.close(resolve));
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  });
}
