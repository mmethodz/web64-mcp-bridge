import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BRIDGE_VERSION } from '../src/version.mjs';

test('release identity and CLI guidance match bridge v0.1.3 with contract v0.1.2', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  const compatibility = JSON.parse(await readFile(new URL('../compatibility.json', import.meta.url)));
  assert.equal(BRIDGE_VERSION, '0.1.3'); assert.equal(pkg.version, BRIDGE_VERSION);
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url)));
  assert.equal(lock.version, BRIDGE_VERSION); assert.equal(lock.packages[''].version, BRIDGE_VERSION);
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(readme.startsWith(`# Web64 MCP bridge v${BRIDGE_VERSION}`));
  assert.ok(readme.includes(`web64-mcp-bridge-${BRIDGE_VERSION}-setup.zip`));
  assert.equal(compatibility.bridgeVersion, BRIDGE_VERSION);
  assert.equal(compatibility.contractVersion, '0.1.2');
  assert.deepEqual(pkg.bundleDependencies, ['@web64/mcp-contract']);
  assert.deepEqual(pkg.files, ['src', 'setup.mjs', 'setup.cmd', 'setup.command', 'README.md', 'CHANGELOG.md', 'compatibility.json', 'vendor/web64-mcp-contract-0.1.2.tgz']);
  const help = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr); assert.equal(help.stdout, '');
  assert.match(help.stderr, /v0\.1\.3/); assert.match(help.stderr, /editing\/local save and builds/);
  assert.doesNotMatch(help.stderr, /M2 development|No writes/);
});
