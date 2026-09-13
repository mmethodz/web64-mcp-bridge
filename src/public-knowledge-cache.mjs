import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, open, readdir, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, dirname, parse } from 'node:path';

const keyPattern = /^[a-f0-9]{64}$/u;
const entryPattern = /^[a-f0-9]{64}\.(?:catalog|blob)\.[a-f0-9]{64}\.json$/u;
export const PUBLIC_CACHE_BUDGET = 32 * 1024 * 1024;
export function defaultPublicKnowledgeCacheDirectory() {
  const base = process.platform === 'win32' ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    : process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'web64-mcp-bridge', 'public-knowledge-v1');
}

// The cache stores verified PUBLIC catalog/blob bytes, never manifests, grants,
// credentials, source projects or arbitrary URLs. Callers revalidate hashes on reads.
export function createPublicKnowledgeCache({ directory = defaultPublicKnowledgeCacheDirectory(), origin,
  maxBytes = PUBLIC_CACHE_BUDGET, onUnavailable = () => {} } = {}) {
  const root = resolve(directory);
  if (root === parse(root).root || root === resolve(homedir())) throw new Error('unsafe_cache_directory');
  const namespace = createHash('sha256').update(new URL(origin).origin).digest('hex');
  let warned = false, writes = Promise.resolve();
  const warn = () => { if (!warned) { warned = true; onUnavailable(); } };
  async function ready(create = false) {
    if (create) await mkdir(root, { recursive: true, mode: 0o700 });
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe_cache_directory');
  }
  function pathFor(kind, key) {
    if (!['catalog', 'blob'].includes(kind) || !keyPattern.test(key)) throw new Error('invalid_cache_key');
    const path = resolve(root, `${namespace}.${kind}.${key}.json`);
    if (dirname(path) !== root) throw new Error('invalid_cache_path');
    return path;
  }
  async function prune() {
    const rows = [];
    for (const name of await readdir(root)) {
      if (!entryPattern.test(name)) continue;
      try {
        const stat = await lstat(join(root, name));
        if (stat.isFile() && !stat.isSymbolicLink()) rows.push({ path: join(root, name), size: stat.size, time: stat.mtimeMs });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    let total = rows.reduce((sum, row) => sum + row.size, 0), count = rows.length;
    rows.sort((a, b) => a.time - b.time || a.path.localeCompare(b.path));
    for (const row of rows) {
      if (total <= maxBytes && count <= 4096) break;
      // Exact regular cache entries only. Never recurse or touch unrelated files.
      try { await unlink(row.path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      total -= row.size; count--;
    }
  }
  return {
    async get(kind, key, maximum) {
      const path = pathFor(kind, key); let file;
      try {
        await ready(); const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) return null;
        file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const opened = await file.stat();
        if (!opened.isFile() || opened.size > maximum || opened.ino !== stat.ino) return null;
        const bytes = Buffer.alloc(Math.min(maximum + 1, opened.size + 1));
        let length = 0;
        while (length < bytes.length) {
          const result = await file.read(bytes, length, bytes.length - length, null);
          if (!result.bytesRead) break; length += result.bytesRead;
        }
        return length === opened.size ? bytes.subarray(0, length) : null;
      } catch (error) { if (error.code !== 'ENOENT') warn(); return null; }
      finally { await file?.close().catch(() => {}); }
    },
    put(kind, key, bytes) {
      const path = pathFor(kind, key);
      if (bytes.length > maxBytes) return Promise.resolve(false);
      const operation = writes.then(async () => {
        const temporary = join(root, `.write-${randomUUID()}.tmp`);
        let created = false;
        try {
          await ready(true);
          try { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink()) return false; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          const file = await open(temporary, 'wx', 0o600); created = true;
          try { await file.writeFile(bytes); } finally { await file.close(); }
          await rename(temporary, path); created = false;
          await prune(); return true;
        } catch { warn(); return false; }
        finally { if (created) await unlink(temporary).catch(() => {}); }
      });
      writes = operation.catch(() => {}); return operation;
    }
  };
}
