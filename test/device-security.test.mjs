import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import WebSocket from 'ws';
import { createDevicePairing } from '../src/devices/device-pairing.mjs';
import { DEVICE_WIRE, decodeDeviceChunk, deviceErrorCode, deviceProof, deviceTranscript, encodeDeviceChunk } from '../src/devices/device-contract.mjs';

const origin = 'https://web64.nofs.ai';
const ideUrl = `${origin}/ide/`;
const fakeJobs = {
  create: async () => ({ jobId: '11111111-1111-1111-1111-111111111111', phase: 'created' }),
  upload: async () => ({ received: 2, length: 2 }),
  seal: async () => ({ phase: 'sealed' }),
  preflight: async () => ({ phase: 'awaiting-approval' }),
  commit: async () => ({ phase: 'finished' }),
  status: () => ({ phase: 'created' }),
  cancel: async () => ({ phase: 'cancelled' }),
};

function invitationFrom(url) {
  const fragment = new URL(url).hash;
  assert.ok(fragment.startsWith('#web64-device-v1='));
  return JSON.parse(Buffer.from(fragment.slice('#web64-device-v1='.length), 'base64url').toString());
}

async function readJson(ws) {
  const [raw] = await once(ws, 'message');
  return JSON.parse(raw.toString());
}

async function pair(bridge, scopes = ['inspect']) {
  const invitation = invitationFrom(bridge.begin('Lab C64U').url);
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/device-session`, { origin });
  await once(ws, 'open');
  const clientNonce = 'a'.repeat(32);
  ws.send(JSON.stringify({ type: 'hello', wire: DEVICE_WIRE, id: invitation.id, instance: invitation.instance, clientNonce }));
  const challenge = await readJson(ws);
  assert.equal(challenge.type, 'challenge');
  assert.equal(challenge.proof, deviceProof(invitation.secret, deviceTranscript(invitation, clientNonce, challenge.serverNonce, 'bridge')));
  ws.send(JSON.stringify({ type: 'proof', proof: deviceProof(invitation.secret,
    deviceTranscript(invitation, clientNonce, challenge.serverNonce, 'browser')) }));
  assert.equal((await readJson(ws)).type, 'verified');
  ws.send(JSON.stringify({ type: 'consent', scopes }));
  assert.equal((await readJson(ws)).type, 'ready');
  return { ws, invitation };
}

test('device channel is independent, exact-origin and one-use', async () => {
  const bridge = await createDevicePairing({ ideUrl, jobs: fakeJobs, describe: async () => ({ product: 'lab' }) });
  try {
    const invited = invitationFrom(bridge.begin('Lab C64U').url);
    const denied = new WebSocket(`ws://127.0.0.1:${bridge.port}/device-session`, { origin: 'https://evil.example' });
    await assert.rejects(once(denied, 'open'));
    const badHost = new WebSocket(`ws://127.0.0.1:${bridge.port}/device-session`, { origin, headers: { Host: `evil.example:${bridge.port}` } });
    await assert.rejects(once(badHost, 'open'));
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/device-session`, { origin });
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', wire: DEVICE_WIRE, id: invited.id, instance: invited.instance, clientNonce: 'b'.repeat(32) }));
    assert.equal((await readJson(ws)).type, 'challenge');
    ws.send(JSON.stringify({ type: 'proof', proof: '0'.repeat(64) }));
    await once(ws, 'close');
    const replay = new WebSocket(`ws://127.0.0.1:${bridge.port}/device-session`, { origin });
    await once(replay, 'open');
    replay.send(JSON.stringify({ type: 'hello', wire: DEVICE_WIRE, id: invited.id, instance: invited.instance, clientNonce: 'c'.repeat(32) }));
    await once(replay, 'close');
    assert.equal(bridge.status().state, 'idle');
  } finally { await bridge.close(); }
});

test('inspect grant cannot create jobs and execution grant uses bounded binary chunks', async () => {
  const bridge = await createDevicePairing({ ideUrl, jobs: fakeJobs, describe: async () => ({ product: 'lab' }) });
  try {
    const inspect = await pair(bridge, ['inspect']);
    inspect.ws.send(JSON.stringify({ type: 'request', requestId: '1'.repeat(32), action: 'device.describe', params: {} }));
    assert.deepEqual((await readJson(inspect.ws)).value, { product: 'lab' });
    inspect.ws.send(JSON.stringify({ type: 'request', requestId: '2'.repeat(32), action: 'job.create', params: { manifest: {} } }));
    await once(inspect.ws, 'close');

    const execute = await pair(bridge, ['inspect', 'execute']);
    const jobId = '11111111-1111-1111-1111-111111111111';
    execute.ws.send(encodeDeviceChunk({ requestId: '3'.repeat(32), jobId,
      artifactId: 'boot', offset: 0, data: Buffer.from([1, 2]) }));
    assert.equal((await readJson(execute.ws)).value.received, 2);
    execute.ws.close();
    await once(execute.ws, 'close');
    for (let i = 0; i < 20 && bridge.status().state !== 'idle'; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(bridge.status().state, 'idle');
  } finally { await bridge.close(); }
});

test('binary chunk header rejects wrong length and round-trips typed IDs', () => {
  const frame = encodeDeviceChunk({ requestId: '4'.repeat(32),
    jobId: '11111111-1111-1111-1111-111111111111', artifactId: 'boot', offset: 65536,
    data: Buffer.from([1, 2]) });
  assert.deepEqual(decodeDeviceChunk(frame).data, Buffer.from([1, 2]));
  const wrong = Buffer.from(frame);
  wrong.writeUInt32LE(3, 42 + 'boot'.length);
  assert.throws(() => decodeDeviceChunk(wrong), /invalid_device_chunk_frame/);
});

test('commit acknowledges start immediately so long REU transfers keep status and revoke usable', async () => {
  let finish;
  const ongoing = new Promise(resolve => { finish = resolve; });
  let cancelled = 0;
  const jobs = { ...fakeJobs,
    commit: () => ongoing,
    status: () => ({ phase: 'preparing' }),
    cancel: async () => { cancelled++; return { phase: 'cancelled' }; },
  };
  const bridge = await createDevicePairing({ ideUrl, jobs, describe: async () => ({ product: 'lab' }) });
  try {
    const { ws } = await pair(bridge, ['inspect', 'execute']);
    const jobId = '11111111-1111-1111-1111-111111111111';
    ws.send(JSON.stringify({ type: 'request', requestId: '5'.repeat(32), action: 'job.create',
      params: { manifest: {} } }));
    assert.equal((await readJson(ws)).value.jobId, jobId);
    ws.send(JSON.stringify({ type: 'request', requestId: '6'.repeat(32), action: 'job.commit',
      params: { jobId } }));
    assert.equal((await readJson(ws)).value.phase, 'preparing');
    ws.send(JSON.stringify({ type: 'request', requestId: '7'.repeat(32), action: 'job.status',
      params: { jobId } }));
    assert.equal((await readJson(ws)).value.phase, 'preparing');
    ws.close();
    await once(ws, 'close');
    for (let attempt = 0; attempt < 20 && cancelled === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(cancelled, 1);
  } finally { finish(); await bridge.close(); }
});

test('expired invitation and oversized control payload cannot gain a grant', async () => {
  let now = Date.now();
  const bridge = await createDevicePairing({ ideUrl, jobs: fakeJobs,
    describe: async () => ({ product: 'lab' }), clock: () => now });
  try {
    const expired = invitationFrom(bridge.begin('Lab C64U').url);
    now = expired.expiresAt + 1;
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/device-session`, { origin });
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', wire: DEVICE_WIRE, id: expired.id,
      instance: expired.instance, clientNonce: 'd'.repeat(32) }));
    await once(ws, 'close');
    assert.equal(bridge.status().state, 'idle');

    const invited = invitationFrom(bridge.begin('Lab C64U').url);
    const oversize = new WebSocket(`ws://127.0.0.1:${bridge.port}/device-session`, { origin });
    await once(oversize, 'open');
    oversize.send(JSON.stringify({ type: 'hello', wire: DEVICE_WIRE, id: invited.id,
      instance: invited.instance, clientNonce: 'e'.repeat(32), padding: 'x'.repeat(70000) }));
    await once(oversize, 'close');
    assert.equal(bridge.status().state, 'inviting');
  } finally { await bridge.close(); }
});

test('job-state errors are replied without ending the session', async () => {
  const jobs = { ...fakeJobs,
    commit() { throw new Error('device_job_not_ready'); },
    status() { throw new Error('unknown_device_job'); } };
  const bridge = await createDevicePairing({ ideUrl, jobs, describe: async () => ({ product: 'lab' }) });
  try {
    const { ws } = await pair(bridge, ['inspect', 'execute']);
    const jobId = '11111111-1111-1111-1111-111111111111';
    ws.send(JSON.stringify({ type: 'request', requestId: '8'.repeat(32), action: 'job.commit', params: { jobId } }));
    assert.deepEqual(await readJson(ws), { type: 'result', requestId: '8'.repeat(32), ok: false, error: 'device_job_not_ready' });
    ws.send(JSON.stringify({ type: 'request', requestId: '9'.repeat(32), action: 'job.status', params: { jobId } }));
    assert.equal((await readJson(ws)).error, 'unknown_device_job');
    assert.equal(bridge.status().state, 'connected');
    ws.close();
    await once(ws, 'close');
  } finally { await bridge.close(); }
});

test('an expired grant reports expiry, but its running job stays observable until it settles', async () => {
  let now = Date.now();
  let phase = 'transferring';
  const jobs = { ...fakeJobs, status: () => ({ phase }) };
  const bridge = await createDevicePairing({ ideUrl, jobs, describe: async () => ({ product: 'lab' }), clock: () => now });
  try {
    const { ws } = await pair(bridge, ['inspect', 'execute']);
    ws.send(JSON.stringify({ type: 'request', requestId: '1'.repeat(32), action: 'job.create', params: { manifest: {} } }));
    const { jobId } = (await readJson(ws)).value;
    now += 21 * 60 * 1000;
    ws.send(JSON.stringify({ type: 'request', requestId: '2'.repeat(32), action: 'device.describe', params: {} }));
    assert.equal((await readJson(ws)).error, 'device_session_expired');
    ws.send(JSON.stringify({ type: 'request', requestId: '3'.repeat(32), action: 'job.status', params: { jobId } }));
    assert.equal((await readJson(ws)).value.phase, 'transferring');
    assert.equal(bridge.status().state, 'connected');
    phase = 'finished';
    assert.equal(bridge.status().state, 'idle');
    await once(ws, 'close');
  } finally { await bridge.close(); }
});

test('device error codes keep network causes distinguishable without addresses', () => {
  const coded = (code, message = `connect ${code} 192.168.1.42:80`) => Object.assign(new Error(message), { code });
  assert.equal(deviceErrorCode(coded('ECONNREFUSED')), 'device_connection_refused');
  assert.equal(deviceErrorCode(coded('EHOSTUNREACH')), 'device_unreachable');
  assert.equal(deviceErrorCode(coded('ECONNRESET')), 'device_connection_reset');
  assert.equal(deviceErrorCode(new Error('device_connect_timeout')), 'device_connect_timeout');
  assert.equal(deviceErrorCode(new Error('device_error:Invalid Type')), 'device_error:Invalid Type');
  assert.equal(deviceErrorCode(new Error('Something /private/path broke')), 'device_request_failed');
});
