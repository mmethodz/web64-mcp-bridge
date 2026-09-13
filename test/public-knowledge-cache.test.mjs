import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, stat, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPublicKnowledgeCache } from '../src/public-knowledge-cache.mjs';

test('cache is lazy, origin-isolated, size-bounded and evicts only its own regular entries', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'web64-cache-budget-test-')), directory = join(parent, 'cache');
  const cache = createPublicKnowledgeCache({ directory, origin: 'https://web64.nofs.ai', maxBytes: 16 });
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  assert.equal(await cache.get('blob', 'a'.repeat(64), 16), null);
  await cache.put('blob', 'a'.repeat(64), Buffer.from('1234567890'));
  await writeFile(join(directory, 'user-notes.txt'), 'must remain');
  await cache.put('blob', 'b'.repeat(64), Buffer.from('abcdefghij'));
  const entries = (await readdir(directory)).filter(name => name.endsWith('.json'));
  assert.equal(entries.length, 1);
  assert.equal(await readFile(join(directory, 'user-notes.txt'), 'utf8'), 'must remain');
  const other = createPublicKnowledgeCache({ directory, origin: 'https://example.com', maxBytes: 16 });
  assert.equal(await other.get('blob', 'b'.repeat(64), 16), null);
  assert.equal(await cache.put('blob', 'c'.repeat(64), Buffer.alloc(17)), false);
  await assert.rejects(cache.get('blob', '../outside', 10));
  assert.equal(await cache.get('blob', 'b'.repeat(64), 1), null);
});

test('cache refuses a symlink/junction root and does not write through it', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'web64-cache-link-test-'));
  const outside = join(parent, 'outside'), directory = join(parent, 'cache');
  await mkdir(outside);
  try { await symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('OS does not permit test symlink creation'); return; } throw error; }
  const cache = createPublicKnowledgeCache({ directory, origin: 'https://web64.nofs.ai' });
  assert.equal(await cache.put('blob', 'a'.repeat(64), Buffer.from('no')), false);
  assert.deepEqual(await readdir(outside), []);
});
