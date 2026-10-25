import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

function ownerAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'ESRCH' ? false : null; }
}

export async function acquireDeviceLease(address, { root = join(tmpdir(), 'web64-device-leases') } = {}) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) throw new Error('invalid_lease_device');
  const key = createHash('sha256').update(address).digest('hex');
  const rootPath = resolve(root);
  const leasePath = resolve(rootPath, key);
  if (dirname(leasePath) !== rootPath) throw new Error('invalid_lease_path');
  await mkdir(rootPath, { recursive: true, mode: 0o700 });
  const nonce = randomUUID();
  try {
    await mkdir(leasePath, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // A missing/malformed owner or uncertain liveness is busy, never takeover.
    let owner;
    try { owner = JSON.parse(await readFile(join(leasePath, 'owner.json'), 'utf8')); }
    catch { throw new Error('device_busy'); }
    if (ownerAlive(owner.pid) !== false) throw new Error('device_busy');
    // Proven-dead process: atomic rename claims this exact stale directory. A
    // concurrent replacement or failed claim remains busy instead of deleting it.
    const stalePath = resolve(rootPath, `${key}.stale-${nonce}`);
    if (dirname(stalePath) !== rootPath) throw new Error('invalid_lease_path');
    try { await rename(leasePath, stalePath); }
    catch { throw new Error('device_busy'); }
    await rm(stalePath, { recursive: true, force: false });
    try { await mkdir(leasePath, { mode: 0o700 }); }
    catch { throw new Error('device_busy'); }
  }
  try {
    await writeFile(join(leasePath, 'owner.json'), JSON.stringify({ pid: process.pid, nonce }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    await rm(leasePath, { recursive: true, force: true });
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    let owner;
    try { owner = JSON.parse(await readFile(join(leasePath, 'owner.json'), 'utf8')); }
    catch { throw new Error('device_lease_lost'); }
    if (owner.nonce !== nonce || owner.pid !== process.pid) throw new Error('device_lease_lost');
    await rm(leasePath, { recursive: true, force: false });
  };
}
