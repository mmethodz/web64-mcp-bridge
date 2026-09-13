// Maintainer-only download artifact. No version bump, npm publish or deployment.
import { mkdtemp, readFile, writeFile, mkdir, cp, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findExecutable, runCommand, probeBridge, launchEntry } from '../src/setup.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const stage = await mkdtemp(join(tmpdir(), 'web64-download-'));
const folder = join(stage, 'web64-mcp-bridge');
await mkdir(folder);
for (const path of pkg.files.filter(path => path !== 'node_modules')) {
  await cp(join(root, path), join(folder, path), { recursive: true });
}
// A developer may have smoke-installed a previous bridge tarball into this
// checkout. It is not a runtime dependency and must not become self-recursive
// in the download. Leave the developer's package/lock files untouched.
delete pkg.dependencies[pkg.name];
delete pkg.devDependencies;
pkg.scripts = { setup: 'node setup.mjs' };
await writeFile(join(folder, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
const npm = await findExecutable('npm');
if (!npm) throw Error('npm is required to prepare a setup download.');
const installed = runCommand(npm, ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
  { cwd: folder, stdio: 'inherit', timeout: 300000 });
if (installed.status !== 0) throw Error('Could not install the download dependencies.');
await chmod(join(folder, 'setup.command'), 0o755);
await probeBridge(launchEntry(process.execPath, folder));
const output = resolve(root, 'dist');
await mkdir(output, { recursive: true });
const archive = join(output, `web64-mcp-bridge-${pkg.version}-setup.zip`);
// Never silently overwrite an earlier download artifact.
try { await readFile(archive); throw Error(`Archive already exists: ${archive}. Move it aside before rebuilding.`); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
let zipped;
if (process.platform === 'win32') {
  const literal = value => `'${value.replace(/'/g, "''")}'`;
  const code = `$ProgressPreference = 'SilentlyContinue'; Compress-Archive -LiteralPath ${literal(folder)} -DestinationPath ${literal(archive)} -ErrorAction Stop`;
  zipped = runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { stdio: 'inherit' });
} else {
  const zip = await findExecutable('zip');
  if (!zip) throw Error('Install the zip utility to build the setup download.');
  zipped = runCommand(zip, ['-qr', archive, 'web64-mcp-bridge'], { cwd: stage, stdio: 'inherit' });
}
if (zipped.status !== 0) throw Error('Could not create the setup ZIP.');
console.log(`Setup download: ${archive}\nVerified staged folder: ${folder}\nDependencies are included; end users only need Node.js 22+ and their MCP client.`);
