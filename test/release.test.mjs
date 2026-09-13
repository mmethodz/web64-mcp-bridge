import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BRIDGE_VERSION } from '../src/version.mjs';

test('release identity and CLI guidance match the packaged v0.1.0 contract', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  const compatibility = JSON.parse(await readFile(new URL('../compatibility.json', import.meta.url)));
  assert.equal(BRIDGE_VERSION, '0.1.0'); assert.equal(pkg.version, BRIDGE_VERSION);
  assert.equal(compatibility.bridgeVersion, BRIDGE_VERSION);
  assert.equal(compatibility.contractVersion, '0.1.0');
  assert.deepEqual(pkg.bundleDependencies, ['@web64/mcp-contract']);
  assert.deepEqual(pkg.files, ['src', 'README.md', 'compatibility.json', 'vendor/web64-mcp-contract-0.1.0.tgz']);
  const help = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr); assert.equal(help.stdout, '');
  assert.match(help.stderr, /v0\.1\.0/); assert.match(help.stderr, /editing\/local save and builds/);
  assert.doesNotMatch(help.stderr, /M2 development|No writes/);
});
