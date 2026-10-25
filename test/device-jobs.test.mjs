import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { acquireDeviceLease } from '../src/devices/device-lease.mjs';
import { createDeviceJobs } from '../src/devices/device-jobs.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
function manifest(bytes, operationId = randomUUID()) {
  return { operationId, projectRevision: 'vfs:42', recipe: { kind: 'lab' }, artifacts: [
    { id: 'boot', kind: 'prg', length: bytes.length, sha256: sha(bytes) },
  ] };
}
async function lab(run, executor) {
  const root = await mkdtemp(join(tmpdir(), 'web64-device-jobs-test-'));
  const rawManager = createDeviceJobs({ target: { pinnedAddress: '192.168.1.20' },
    executor, stagingRoot: join(root, 'staging'), lease: async () => async () => {}, allowLabRecipe: true });
  const owner = 'a'.repeat(32);
  const manager = {
    create: manifest => rawManager.create(manifest, owner),
    upload: (jobId, artifactId, offset, data) => rawManager.upload(jobId, artifactId, offset, data, owner),
    seal: jobId => rawManager.seal(jobId, owner),
    preflight: jobId => rawManager.preflight(jobId, owner),
    commit: jobId => rawManager.commit(jobId, owner),
    cancel: jobId => rawManager.cancel(jobId, owner),
    status: jobId => rawManager.status(jobId, owner),
  };
  try { return await run(manager); }
  finally {
    await rawManager.close();
    if (resolve(root).startsWith(resolve(tmpdir()) + '\\') || resolve(root).startsWith(resolve(tmpdir()) + '/')) {
      await rm(root, { recursive: true, force: false });
    }
  }
}

test('cross-process device lease refuses another owner and releases exact lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'web64-device-lease-test-'));
  try {
    const release = await acquireDeviceLease('192.168.1.20', { root });
    await assert.rejects(acquireDeviceLease('192.168.1.20', { root }), /device_busy/);
    await release();
    const releaseAgain = await acquireDeviceLease('192.168.1.20', { root });
    await releaseAgain();
  } finally {
    if (resolve(root).startsWith(resolve(tmpdir()) + '\\') || resolve(root).startsWith(resolve(tmpdir()) + '/')) {
      await rm(root, { recursive: true, force: false });
    }
  }
});

test('immutable staged job seals by hash, commits once and retains an honest receipt', async () => {
  const bytes = Buffer.from([1, 2, 3, 4]);
  let commits = 0;
  await lab(async manager => {
    const source = manifest(bytes);
    const first = await manager.create(source);
    const again = await manager.create(source);
    assert.equal(again.jobId, first.jobId);
    await assert.rejects(manager.create({ ...source, projectRevision: 'vfs:43' }), /duplicate_operation_conflict/);
    await assert.rejects(manager.create(manifest(bytes)), /device_busy/);
    await assert.rejects(manager.upload(first.jobId, 'boot', 1, bytes), /invalid_device_chunk/);
    await manager.upload(first.jobId, 'boot', 0, bytes.subarray(0, 2));
    await manager.upload(first.jobId, 'boot', 2, bytes.subarray(2));
    await assert.rejects(manager.upload(first.jobId, 'boot', 2, bytes.subarray(2)), /invalid_device_chunk/);
    assert.equal((await manager.seal(first.jobId)).phase, 'sealed');
    assert.equal((await manager.preflight(first.jobId)).phase, 'awaiting-approval');
    const result = await manager.commit(first.jobId);
    assert.equal(result.phase, 'finished');
    assert.equal(result.deliveryLevel, 'transfer-processed');
    assert.equal(result.outcomeKnown, false);
    assert.deepEqual(await manager.commit(first.jobId), result);
    assert.equal(commits, 1);
  }, {
    preflight: async () => ({ ready: true }),
    commit: async context => {
      commits++;
      assert.deepEqual(await readFile(context.artifacts[0].path), bytes);
      context.markMutation();
      return { deliveryLevel: 'transfer-processed' };
    },
  });
});

test('bad hash and pre-dispatch cancel produce no device mutation', async () => {
  let commits = 0;
  await lab(async manager => {
    const bytes = Buffer.from([1, 2]);
    const created = await manager.create(manifest(bytes));
    await manager.upload(created.jobId, 'boot', 0, Buffer.from([3, 4]));
    await assert.rejects(manager.seal(created.jobId), /device_artifact_integrity/);
    assert.equal(manager.status(created.jobId).phase, 'failed');
    const second = await manager.create(manifest(bytes));
    assert.equal((await manager.cancel(second.jobId)).phase, 'cancelled');
    assert.equal(manager.status(second.jobId).deviceMutated, false);
    assert.equal(commits, 0);
  }, { preflight: async () => ({}), commit: async () => { commits++; } });
});

test('failed read-only compatibility check keeps a sealed job uncommittable', async () => {
  const bytes = Buffer.from([1, 2]);
  await lab(async manager => {
    const created = await manager.create({ ...manifest(bytes), recipe: {
      kind: 'prg', requirements: { video: 'pal', reuCapacityKiB: null, driveUnits: [] },
      program: { artifactId: 'boot', entryAddress: null }, bootstrap: null, reuArtifactId: null,
    } });
    await manager.upload(created.jobId, 'boot', 0, bytes);
    await manager.seal(created.jobId);
    const checked = await manager.preflight(created.jobId);
    assert.equal(checked.phase, 'sealed');
    assert.equal(checked.details.ready, false);
    assert.throws(() => manager.commit(created.jobId), /device_job_not_ready/);
  }, { preflight: async () => ({ ready: false, issues: [{ code: 'cpu_not_standard' }] }),
    commit: async () => { throw new Error('must_not_commit'); } });
});

test('cancel after mutation reports partial unknown and never dispatches launch', async () => {
  const bytes = Buffer.from([9]);
  let releaseCommit;
  const waiting = new Promise(resolve => { releaseCommit = resolve; });
  await lab(async manager => {
    const created = await manager.create(manifest(bytes));
    await manager.upload(created.jobId, 'boot', 0, bytes);
    await manager.seal(created.jobId);
    await manager.preflight(created.jobId);
    const commit = manager.commit(created.jobId);
    while (manager.status(created.jobId).phase !== 'transferring') await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal((await manager.cancel(created.jobId)).cancelRequested, true);
    releaseCommit();
    const result = await commit;
    assert.equal(result.phase, 'unknown');
    assert.equal(result.deviceMutated, true);
    assert.equal(result.outcomeKnown, false);
  }, {
    preflight: async () => ({}),
    commit: async context => { context.markMutation(); await waiting; context.checkActive(); context.markLaunchRequested(); },
  });
});

test('lost response after irreversible runner request is unknown and duplicate commit never reruns', async () => {
  const bytes = Buffer.from([1, 8, 0xea]);
  let dispatches = 0;
  await lab(async manager => {
    const created = await manager.create(manifest(bytes));
    await manager.upload(created.jobId, 'boot', 0, bytes);
    await manager.seal(created.jobId);
    await manager.preflight(created.jobId);
    const receipt = await manager.commit(created.jobId);
    assert.equal(receipt.phase, 'unknown');
    assert.equal(receipt.deviceMutated, true);
    assert.equal(receipt.outcomeKnown, false);
    assert.equal(receipt.error, 'runner_reply_lost');
    assert.deepEqual(await manager.commit(created.jobId), receipt);
    assert.equal(dispatches, 1);
  }, {
    preflight: async () => ({ ready: true }),
    commit: async context => {
      context.markLaunchRequested();
      dispatches++;
      throw new Error('runner_reply_lost');
    },
  });
});

test('staging limits reject capacity plus one before allocation or device access', async () => {
  await lab(async manager => {
    const base = { operationId: randomUUID(), projectRevision: 'limits', recipe: { kind: 'lab' },
      artifacts: [{ id: 'image', kind: 'reu', length: 16 * 1024 * 1024, sha256: '0'.repeat(64) }] };
    const created = await manager.create(base);
    await assert.rejects(manager.upload(created.jobId, 'image', 0, Buffer.alloc(65537)), /invalid_device_chunk/);
    await manager.cancel(created.jobId);
    await assert.rejects(manager.create({ ...base, operationId: randomUUID(), artifacts: [
      { ...base.artifacts[0], length: 16 * 1024 * 1024 + 1 },
    ] }), /reu_image_too_large/);
    await assert.rejects(manager.create({ ...base, operationId: randomUUID(), artifacts: [
      base.artifacts[0], { id: 'extra', kind: 'bin', length: 16 * 1024 * 1024 + 1, sha256: '0'.repeat(64) },
    ] }), /device_job_too_large/);
  }, { preflight: async () => ({}), commit: async () => ({}) });
});
