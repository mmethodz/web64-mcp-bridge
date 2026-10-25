import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { acquireDeviceLease } from './device-lease.mjs';
import { validateDeviceRecipe } from './device-recipe.mjs';
import { deviceErrorCode } from './device-contract.mjs';

const MAX_ARTIFACTS = 16;
const MAX_STAGED = 32 * 1024 * 1024;
const MAX_REU = 16 * 1024 * 1024;
const MAX_CHUNK = 64 * 1024;
const MAX_METADATA = 64 * 1024;
const RECEIPTS = 32;
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;

function validManifest(value, allowLabRecipe) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_METADATA ||
      Object.keys(value).sort().join(',') !== 'artifacts,operationId,projectRevision,recipe' ||
      typeof value.operationId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.operationId) ||
      typeof value.projectRevision !== 'string' || value.projectRevision.length < 1 || value.projectRevision.length > 128 ||
      !Array.isArray(value.artifacts) || value.artifacts.length < 1 || value.artifacts.length > MAX_ARTIFACTS ||
      !value.recipe || typeof value.recipe !== 'object' || Array.isArray(value.recipe)) {
    throw new Error('invalid_device_job');
  }
  const ids = new Set();
  let total = 0, reuCount = 0;
  for (const artifact of value.artifacts) {
    if (!artifact || !ID.test(artifact.id) || ids.has(artifact.id) ||
        Object.keys(artifact).sort().join(',') !== 'id,kind,length,sha256' ||
        !['prg', 'd64', 'crt', 'reu', 'bin'].includes(artifact.kind) ||
        !Number.isSafeInteger(artifact.length) || artifact.length < 1 ||
        artifact.length > MAX_STAGED || !HASH.test(artifact.sha256)) throw new Error('invalid_device_artifact');
    ids.add(artifact.id);
    total += artifact.length;
    if (artifact.kind === 'reu') {
      reuCount++;
      if (artifact.length > MAX_REU) throw new Error('reu_image_too_large');
    }
  }
  if (total > MAX_STAGED || reuCount > 1) throw new Error('device_job_too_large');
  validateDeviceRecipe(value.recipe, value.artifacts, { allowLab: allowLabRecipe });
  return JSON.stringify(value);
}

function publicStatus(job) {
  return {
    jobId: job.id, phase: job.phase, projectRevision: job.manifest.projectRevision,
    cancelRequested: job.cancelRequested, deviceMutated: job.deviceMutated,
    outcomeKnown: job.outcomeKnown, deliveryLevel: job.deliveryLevel,
    guestHandoffObserved: job.guestHandoffObserved, guestPhase: job.guestPhase,
    ...(job.error ? { error: job.error } : {}),
    ...(job.stagingCleanupFailed ? { stagingCleanupFailed: true } : {}),
    artifacts: [...job.artifacts.values()].map(item => ({ id: item.id, received: item.received, length: item.length })),
  };
}

export function createDeviceJobs({ target, executor, stagingRoot = join(tmpdir(), 'web64-device-jobs'),
  lease = acquireDeviceLease, allowLabRecipe = false } = {}) {
  if (!target || !executor || typeof executor.preflight !== 'function' || typeof executor.commit !== 'function') {
    throw new Error('invalid_device_executor');
  }
  const jobs = new Map();
  const operations = new Map();
  const rootPath = resolve(stagingRoot);
  let activeCommit = null;
  let inFlightChunks = 0;
  let closed = false;

  async function cleanDeadOwnedStaging() {
    const entries = await readdir(rootPath, { withFileTypes: true });
    for (const entry of entries.slice(0, 100)) {
      const match = /^job-(\d+)-[a-zA-Z0-9]{6}$/.exec(entry.name);
      if (!match || !entry.isDirectory() || Number(match[1]) === process.pid) continue;
      let alive = true;
      try { process.kill(Number(match[1]), 0); }
      catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) continue;
      const path = resolve(rootPath, entry.name);
      if (dirname(path) !== rootPath || !(await lstat(path)).isDirectory()) continue;
      await rm(path, { recursive: true, force: false });
    }
  }

  async function cleanup(job) {
    for (const item of job.artifacts.values()) {
      if (item.handle) {
        await item.handle.close();
        item.handle = null;
      }
    }
    if (job.directory) {
      const directory = resolve(job.directory);
      if (dirname(directory) !== rootPath || !directory.startsWith(rootPath)) throw new Error('invalid_staging_path');
      await rm(directory, { recursive: true, force: false });
      job.directory = null;
    }
  }
  function requireJob(id, ownerId) {
    const job = jobs.get(id);
    if (!job) throw new Error('unknown_device_job');
    if (ownerId !== undefined && job.ownerId !== ownerId) throw new Error('device_job_owner_mismatch');
    return job;
  }
  function trimReceipts() {
    if (jobs.size <= RECEIPTS) return;
    for (const [id, job] of jobs) {
      if (jobs.size <= RECEIPTS) break;
      if (['finished', 'failed', 'cancelled', 'unknown'].includes(job.phase)) {
        jobs.delete(id);
        operations.delete(job.manifest.operationId);
      }
    }
  }
  return Object.freeze({
    async create(manifest, ownerId) {
      if (closed) throw new Error('device_jobs_closed');
      if (typeof ownerId !== 'string' || !/^[a-f0-9]{32,64}$/.test(ownerId)) throw new Error('invalid_device_job_owner');
      const canonical = validManifest(manifest, allowLabRecipe);
      const previous = operations.get(manifest.operationId);
      if (previous) {
        if (previous.canonical !== canonical || previous.job.ownerId !== ownerId) throw new Error('duplicate_operation_conflict');
        return publicStatus(previous.job);
      }
      if ([...jobs.values()].some(job => !['finished', 'failed', 'cancelled', 'unknown'].includes(job.phase))) {
        throw new Error('device_busy');
      }
      await mkdir(rootPath, { recursive: true, mode: 0o700 });
      await cleanDeadOwnedStaging();
      const directory = await mkdtemp(join(rootPath, `job-${process.pid}-`));
      const id = randomUUID();
      const job = { id, ownerId, manifest: structuredClone(manifest), canonical, directory, phase: 'created',
        artifacts: new Map(), cancelRequested: false, deviceMutated: false, outcomeKnown: true,
        guestHandoffObserved: false, guestPhase: null,
        deliveryLevel: null, promise: null, activeUploads: 0, uploadPromises: new Set() };
      try {
        for (const artifact of manifest.artifacts) {
          const path = join(directory, `${artifact.id}.part`);
          const handle = await open(path, 'wx', 0o600);
          job.artifacts.set(artifact.id, { ...artifact, path, handle, received: 0, hash: createHash('sha256'), busy: false });
        }
      } catch (error) { await cleanup(job); throw error; }
      jobs.set(id, job);
      operations.set(manifest.operationId, { canonical, job });
      trimReceipts();
      return publicStatus(job);
    },
    async upload(id, artifactId, offset, data, ownerId) {
      const job = requireJob(id, ownerId);
      const item = job.artifacts.get(artifactId);
      if (!item || !Buffer.isBuffer(data) || data.length < 1 || data.length > MAX_CHUNK ||
          !Number.isSafeInteger(offset) || offset !== item.received || offset + data.length > item.length ||
          !['created', 'staging'].includes(job.phase) || job.cancelRequested || item.busy || inFlightChunks >= 4) {
        throw new Error('invalid_device_chunk');
      }
      item.busy = true;
      job.activeUploads++;
      inFlightChunks++;
      const work = (async () => {
      try {
        const { bytesWritten } = await item.handle.write(data, 0, data.length, offset);
        if (bytesWritten !== data.length) throw new Error('staging_short_write');
        item.hash.update(data);
        item.received += data.length;
        job.phase = 'staging';
        return { received: item.received, length: item.length };
      } finally {
        item.busy = false;
        job.activeUploads--;
        inFlightChunks--;
        if (job.cancelRequested && job.activeUploads === 0 && !job.promise) {
          job.phase = 'cancelled';
          await cleanup(job);
        }
      }
      })();
      job.uploadPromises.add(work);
      try { return await work; } finally { job.uploadPromises.delete(work); }
    },
    async seal(id, ownerId) {
      const job = requireJob(id, ownerId);
      if (job.cancelRequested || job.activeUploads || !['created', 'staging'].includes(job.phase)) throw new Error('device_job_not_stageable');
      for (const item of job.artifacts.values()) {
        if (item.received !== item.length || item.hash.digest('hex') !== item.sha256) {
          job.phase = 'failed';
          await cleanup(job);
          throw new Error('device_artifact_integrity');
        }
        await item.handle.sync();
        await item.handle.close();
        item.handle = null;
      }
      job.phase = 'sealed';
      return publicStatus(job);
    },
    async preflight(id, ownerId) {
      const job = requireJob(id, ownerId);
      if (job.phase !== 'sealed' || job.cancelRequested) throw new Error('device_job_not_sealed');
      const details = await executor.preflight({ manifest: structuredClone(job.manifest), artifacts: [...job.artifacts.values()].map(item => ({ id: item.id, kind: item.kind, length: item.length, path: item.path })) });
      if (job.cancelRequested) throw new Error('device_job_cancelled');
      if (details?.ready === false) return { ...publicStatus(job), details };
      job.approvedPreflight = structuredClone(details);
      job.phase = 'awaiting-approval';
      return { ...publicStatus(job), details };
    },
    commit(id, ownerId) {
      const job = requireJob(id, ownerId);
      if (job.promise) return job.promise;
      if (job.phase !== 'awaiting-approval' || job.cancelRequested || activeCommit) throw new Error('device_job_not_ready');
      activeCommit = id;
      job.phase = 'preparing';
      job.promise = (async () => {
        let release;
        try {
          release = await lease(target.pinnedAddress);
          if (job.cancelRequested) throw new Error('device_job_cancelled');
          const context = {
            manifest: structuredClone(job.manifest),
            approvedPreflight: structuredClone(job.approvedPreflight),
            artifacts: [...job.artifacts.values()].map(item => ({ id: item.id, kind: item.kind, length: item.length, path: item.path })),
            checkActive() { if (job.cancelRequested) throw new Error('device_job_cancelled'); },
            markMutation() { job.deviceMutated = true; job.phase = 'transferring'; },
            markLaunchRequested() { job.deviceMutated = true; job.outcomeKnown = false; job.phase = 'launch-requested'; },
          };
          const result = await executor.commit(context);
          job.deliveryLevel = result?.deliveryLevel || 'transfer-processed';
          job.guestHandoffObserved = result?.guestHandoffObserved === true;
          job.guestPhase = ['running', 'loading'].includes(result?.guestPhase) ? result.guestPhase : null;
          if (!['transfer-processed', 'launch-requested', 'application-acknowledged'].includes(job.deliveryLevel)) {
            throw new Error('invalid_device_receipt');
          }
          job.phase = 'finished';
          job.outcomeKnown = job.deliveryLevel === 'application-acknowledged';
        } catch (error) {
          job.phase = job.deviceMutated ? 'unknown' : job.cancelRequested ? 'cancelled' : 'failed';
          job.outcomeKnown = !job.deviceMutated;
          job.error = deviceErrorCode(error);
        } finally {
          if (release) {
            try { await release(); } catch {
              job.phase = 'unknown'; job.outcomeKnown = false; job.error = job.error || 'device_lease_lost';
            }
          }
          // Local staging cleanup does not change what happened on the device:
          // keep the phase and the original error, and flag the leftover files.
          try { await cleanup(job); } catch {
            job.stagingCleanupFailed = true;
            job.error = job.error || 'staging_cleanup_failed';
          }
          activeCommit = null;
          trimReceipts();
        }
        return { ...publicStatus(job), ...(job.error ? { error: job.error } : {}) };
      })();
      return job.promise;
    },
    async cancel(id, ownerId) {
      const job = requireJob(id, ownerId);
      if (['finished', 'failed', 'cancelled', 'unknown'].includes(job.phase)) return publicStatus(job);
      job.cancelRequested = true;
      if (!job.promise && job.activeUploads === 0) {
        job.phase = 'cancelled';
        await cleanup(job);
      }
      return publicStatus(job);
    },
    status: (id, ownerId) => publicStatus(requireJob(id, ownerId)),
    async close() {
      closed = true;
      for (const job of jobs.values()) {
        job.cancelRequested = true;
        if (job.promise) await job.promise;
        else {
          await Promise.allSettled(job.uploadPromises);
          if (job.directory) await cleanup(job);
        }
      }
      jobs.clear();
      operations.clear();
    },
  });
}
