import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'smol-toml';
import { configPath, prepareConfig, commitConfig, launchEntry, probeBridge, runCommand } from '../src/setup.mjs';

const entry = { command: 'C:\\Program Files\\nodejs\\node.exe', args: ["C:\\Users\\O'Brien\\Bridge & tools\\src\\cli.mjs"] };
test('Codex registration preserves unrelated TOML and round-trips Windows paths', () => {
  const before = '# personal settings\nmodel = "custom"\n[mcp_servers.other]\ncommand = "other"\n';
  const after = prepareConfig('codex', before, entry, parse);
  assert.ok(after.startsWith(before));
  assert.deepEqual(parse(after).mcp_servers.web64, entry);
  assert.equal(prepareConfig('codex', after, entry, parse), after);
  assert.throws(() => prepareConfig('codex', '[mcp_servers."web64"]\ncommand="other"', entry, parse), /different web64/);
  assert.throws(() => prepareConfig('codex', 'mcp_servers = {web64={command="other"}}', entry, parse), /different web64/);
  assert.throws(() => prepareConfig('codex', 'not valid TOML !!!', entry, parse));
});
test('Claude Desktop preserves unrelated settings and refuses conflicts or invalid JSON', () => {
  const data = { theme: 'dark', mcpServers: { other: { command: 'other' } } };
  const after = prepareConfig('claude-desktop', JSON.stringify(data), entry);
  assert.deepEqual(JSON.parse(after), { ...data, mcpServers: { ...data.mcpServers, web64: entry } });
  assert.equal(prepareConfig('claude-desktop', after, entry), after);
  assert.throws(() => prepareConfig('claude-desktop', '{bad}', entry));
  assert.throws(() => prepareConfig('claude-desktop', '{"mcpServers":[]}', entry));
  assert.throws(() => prepareConfig('claude-desktop', '{"mcpServers":{"web64":{"url":"https://other"}}}', entry), /different web64/);
});
test('configuration writes back up exact prior contents and refuse stale updates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'web64 setup '));
  const path = join(directory, 'config.toml');
  const before = '# preserved secret/settings\n';
  await writeFile(path, before);
  const after = prepareConfig('codex', before, entry, parse);
  const result = await commitConfig(path, before, after);
  assert.equal(await readFile(result.backup, 'utf8'), before);
  assert.equal(await readFile(path, 'utf8'), after);
  assert.deepEqual(await commitConfig(path, after, after), { changed: false });
  await assert.rejects(commitConfig(path, before, 'stale'), /changed during setup/);
  assert.equal(await readFile(path, 'utf8'), after);
});
test('client locations honor CODEX_HOME and standard desktop config roots', () => {
  assert.equal(configPath('codex', { home: '/user', env: { CODEX_HOME: '/custom' } }), join('/custom', 'config.toml'));
  assert.equal(configPath('claude-desktop', { home: '/user', env: {}, platform: 'darwin' }), join('/user', 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
  assert.equal(configPath('claude-desktop', { home: '/user', env: { APPDATA: '/appdata' }, platform: 'win32' }), join('/appdata', 'Claude', 'claude_desktop_config.json'));
  assert.throws(() => configPath('claude-desktop', { platform: 'linux' }), /Claude Code on Linux/);
});
test('setup probes actual stdio initialization and pairing tool without requesting a grant', async () => {
  await probeBridge(launchEntry());
  await assert.rejects(probeBridge({ command: process.execPath, args: ['-e', 'process.exit(1)'] }), /exited before/);
  await assert.rejects(probeBridge({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }, 200), /timed out/);
});
test('process arguments remain literal with shell punctuation', () => {
  const sample = "O'Brien & $() `quoted` %PATH%";
  const result = runCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', sample]);
  assert.equal(result.status, 0); assert.equal(result.stdout, sample);
});

test('Windows command shims preserve quoted paths and arguments', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "web64 O'Brien & setup "));
  const shim = join(directory, 'echo-args.cmd');
  await writeFile(shim, `@echo off\r\n"${process.execPath}" -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" %*\r\n`);
  const args = ["C:\\O'Brien & apps\\Bridge tools\\cli.mjs", 'normal'];
  const result = runCommand(shim, args);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test('real setup/check/rerun use only isolated Codex and Claude Desktop settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'web64 registration '));
  const setup = process.env.WEB64_TEST_SETUP || fileURLToPath(new URL('../setup.mjs', import.meta.url));
  const codexDir = join(directory, 'codex');
  await mkdir(codexDir);
  const env = { ...process.env, CODEX_HOME: codexDir, APPDATA: join(directory, 'appdata') };
  const run = (client, check = false) => runCommand(process.execPath, [setup, '--client', client, ...(check ? ['--check'] : [])], { env });
  assert.equal(run('codex', true).status, 1, 'check must not create a registration');
  const first = run('codex');
  assert.equal(first.status, 0, first.stderr + first.stdout);
  assert.match(first.stdout, /Setup complete/);
  const config = await readFile(join(codexDir, 'config.toml'), 'utf8');
  assert.equal(parse(config).mcp_servers.web64.command, process.execPath);
  assert.equal(run('codex', true).status, 0);
  assert.equal(run('codex').status, 0);
  assert.equal(await readFile(join(codexDir, 'config.toml'), 'utf8'), config);
  if (process.platform === 'win32') {
    assert.equal(run('claude-desktop').status, 1, 'missing client folder fails');
    const claudeDir = join(env.APPDATA, 'Claude');
    await mkdir(claudeDir, { recursive: true });
    const path = join(claudeDir, 'claude_desktop_config.json');
    await writeFile(path, '{"theme":"dark"}');
    const desktop = run('claude-desktop');
    assert.equal(desktop.status, 0, desktop.stderr + desktop.stdout);
    assert.equal(run('claude-desktop', true).status, 0);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).theme, 'dark');
  }
});

test('Claude Code adapter invokes user-scoped registration and preserves existing entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'web64 claude adapter '));
  const record = join(directory, 'calls.json');
  const fake = join(directory, 'fake-claude.mjs');
  await writeFile(fake, `import fs from 'node:fs';
const args = process.argv.slice(2), path = process.env.WEB64_TEST_RECORD;
if (args[0] === '--version') console.log('Claude Code fixture');
else if (args[1] === 'get') { if (fs.existsSync(path)) console.log('registered'); else process.exitCode = 1; }
else if (args[1] === 'add') fs.writeFileSync(path, JSON.stringify(args));
else process.exitCode = 1;
`);
  if (process.platform === 'win32') {
    await writeFile(join(directory, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`);
  } else {
    const shim = join(directory, 'claude');
    await writeFile(shim, `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' '${fake.replace(/'/g, "'\\''")}' "$@"\n`);
    await chmod(shim, 0o755);
  }
  const env = { ...process.env, WEB64_TEST_RECORD: record };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = directory + delimiter + (process.env.PATH || process.env.Path);
  const setup = process.env.WEB64_TEST_SETUP || fileURLToPath(new URL('../setup.mjs', import.meta.url));
  const run = () => runCommand(process.execPath, [setup, '--client', 'claude-code'], { env });
  const result = run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const calls = JSON.parse(await readFile(record, 'utf8'));
  assert.deepEqual(calls.slice(0, 8), ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'web64', '--']);
  assert.equal(calls[8], process.execPath);
  assert.ok(calls[9].endsWith(join('src', 'cli.mjs')));
  assert.equal(run().status, 1, 'existing entries must not be replaced');
  assert.deepEqual(JSON.parse(await readFile(record, 'utf8')), calls);
});
