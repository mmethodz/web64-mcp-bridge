import { access, readFile, writeFile, mkdir, copyFile, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve, join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const clients = ['codex', 'claude-code', 'claude-desktop'];
const labels = ['Codex (desktop app, CLI, or IDE extension)', 'Claude Code', 'Claude Desktop'];
const missing = error => error.code === 'ENOENT';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export async function readOptional(path) {
  try { return await readFile(path, 'utf8'); } catch (error) { if (missing(error)) return null; throw error; }
}
export function configPath(client, { home = homedir(), env = process.env, platform = process.platform } = {}) {
  if (client === 'codex') return join(env.CODEX_HOME || join(home, '.codex'), 'config.toml');
  if (client === 'claude-desktop') {
    if (platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'Claude', 'claude_desktop_config.json');
    if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    throw Error('Claude Desktop setup supports Windows and macOS. Choose Claude Code on Linux.');
  }
  throw Error('Unknown client. Choose codex, claude-code, or claude-desktop.');
}
export function launchEntry(node = process.execPath, directory = root) {
  return { command: node, args: [join(directory, 'src', 'cli.mjs')] };
}
function sameEntry(value, entry) {
  return object(value) && value.command === entry.command &&
    JSON.stringify(value.args) === JSON.stringify(entry.args) && value.enabled !== false && !value.url;
}
export function prepareConfig(client, original, entry, parseToml) {
  if (client === 'codex') {
    const data = parseToml(original || '');
    if (data.mcp_servers !== undefined && !object(data.mcp_servers)) throw Error('Codex mcp_servers is not a table; repair it before setup.');
    if (data.mcp_servers?.web64 !== undefined) {
      if (sameEntry(data.mcp_servers.web64, entry)) return original;
      throw Error('Codex already has a different web64 registration. Remove that entry in MCP settings, then rerun setup.');
    }
    // Preserve all existing TOML, comments and formatting; the parser checks even
    // unusual inline/quoted tables and prevents duplicate or ambiguous entries.
    const quote = value => JSON.stringify(value).replace(/\u007f/g, '\\u007f');
    const updated = `${original || ''}\n# Web64 local bridge (added by setup)\n[mcp_servers.web64]\ncommand = ${quote(entry.command)}\nargs = [${entry.args.map(quote).join(', ')}]\n`;
    const verified = parseToml(updated);
    if (!sameEntry(verified.mcp_servers?.web64, entry)) throw Error('Could not validate the Codex registration.');
    return updated;
  }
  const data = JSON.parse((original || '{}').replace(/^\uFEFF/, ''));
  if (!object(data) || (data.mcpServers !== undefined && !object(data.mcpServers))) throw Error('Client configuration must contain an mcpServers object.');
  if (data.mcpServers?.web64 !== undefined) {
    if (sameEntry(data.mcpServers.web64, entry)) return original;
    throw Error('Claude Desktop already has a different web64 registration. Remove that entry in Developer settings, then rerun setup.');
  }
  data.mcpServers = { ...data.mcpServers, web64: entry };
  return JSON.stringify(data, null, 2) + '\n';
}
export async function commitConfig(path, original, updated) {
  if (original === updated) return { changed: false };
  await mkdir(dirname(path), { recursive: true });
  if (await readOptional(path) !== original) throw Error('Client configuration changed during setup. Close its settings and rerun setup.');
  const suffix = randomUUID();
  const backup = original === null ? null : `${path}.web64-backup-${suffix}`;
  if (backup) await copyFile(path, backup, constants.COPYFILE_EXCL);
  const temp = `${path}.web64-${suffix}.tmp`;
  try {
    await writeFile(temp, updated, { flag: 'wx', mode: 0o600 });
    if (await readOptional(path) !== original) throw Error('Client configuration changed during setup. Rerun setup.');
    await rename(temp, path);
  } finally { await unlink(temp).catch(error => { if (!missing(error)) throw error; }); }
  if (await readOptional(path) !== updated) throw Error('Registration verification failed. Restore the backup and rerun setup.');
  return { changed: true, backup };
}
export async function findExecutable(name, env = process.env, platform = process.platform) {
  const extensions = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const directory of (env.PATH || env.Path || '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = resolve(directory, name + extension);
      try { await access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK); return candidate; } catch {}
    }
  }
  return null;
}
export function runCommand(command, args, options = {}) {
  // Windows npm/claude can be .cmd shims. PowerShell literal arguments avoid
  // cmd.exe string interpolation of paths containing spaces or metacharacters.
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    const literal = value => `'${value.replace(/'/g, "''")}'`;
    const code = `& ${[command, ...args].map(literal).join(' ')}; exit $LASTEXITCODE`;
    return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')],
      { encoding: 'utf8', windowsHide: true, timeout: 120000, ...options });
  }
  return spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 120000, ...options });
}
// Test the actual stdio process without pairing, network access or capabilities.
export async function probeBridge(entry, timeoutMs = 15000) {
  return new Promise((resolveProbe, reject) => {
    const child = spawn(entry.command, entry.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let pending = '', settled = false, initialized = false;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); child.stdin.end(); child.kill();
      if (error) reject(error); else resolveProbe();
    };
    const timer = setTimeout(() => finish(Error('Bridge startup timed out. Check Node and reinstall dependencies.')), timeoutMs);
    child.once('error', () => finish(Error('Could not start the bridge with the selected Node executable.')));
    child.once('exit', () => { if (!settled) finish(Error('Bridge exited before its MCP startup check completed.')); });
    child.stdin.on('error', () => finish(Error('Bridge closed its input during startup.')));
    child.stderr.resume();
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    child.stdout.on('data', chunk => {
      pending += chunk;
      if (pending.length > 262144) return finish(Error('Bridge startup output exceeded the check limit.'));
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { return finish(Error('Bridge stdout was not valid MCP JSON.')); }
        if (message.id === 1 && !initialized) {
          if (message.error || !message.result?.capabilities?.tools) return finish(Error('Bridge did not initialize its MCP tools.'));
          initialized = true;
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (message.id === 2) {
          finish(message.result?.tools?.some(tool => tool.name === 'web64_connection') ? null : Error('Pairing tool missing from the bridge.'));
        }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'web64-setup-check', version: '1.0.0' }
    } });
  });
}
export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    client: { type: 'string' }, check: { type: 'boolean' }, help: { type: 'boolean' }
  }, allowPositionals: false });
  if (values.help) {
    console.log('Web64 setup: node setup.mjs [--client codex|claude-code|claude-desktop] [--check]\n--check checks prerequisites, bridge startup and registration without installing or writing configuration.');
    return;
  }
  if (Number(process.versions.node.split('.')[0]) < 22) throw Error('Node.js 22 or newer is required. Install the LTS release from https://nodejs.org/ and rerun setup.');
  console.log('\nWeb64 bridge setup\n');
  let client = values.client;
  if (!client) {
    if (!process.stdin.isTTY) throw Error('Choose a client with --client codex, --client claude-code, or --client claude-desktop.');
    console.log(labels.map((label, i) => `  ${i + 1}. ${label}`).join('\n'));
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { client = clients[Number((await prompt.question('\nChoose your MCP client (1-3): ')).trim()) - 1]; }
    finally { prompt.close(); }
  }
  if (!clients.includes(client)) throw Error('Choose codex, claude-code, or claude-desktop.');
  let path, claude;
  if (client === 'claude-code') {
    claude = await findExecutable('claude');
    if (!claude || runCommand(claude, ['--version']).status !== 0) throw Error('Install and start Claude Code first: https://code.claude.com/docs/en/setup. Then reopen your terminal and rerun setup.');
  } else {
    path = configPath(client);
    try { await access(dirname(path)); } catch { throw Error(`Install and start ${client === 'codex' ? 'Codex' : 'Claude Desktop'} once, then rerun setup. Expected settings folder: ${dirname(path)}`); }
  }
  console.log(`Client: ${labels[clients.indexOf(client)]}\nNode: ${process.execPath} (${process.version})\nBridge folder: ${root}`);
  let dependenciesReady = true;
  for (const name of ['@modelcontextprotocol/server', '@modelcontextprotocol/node', '@web64/mcp-contract', 'ws', 'zod', 'smol-toml']) {
    try { import.meta.resolve(name); } catch { dependenciesReady = false; }
  }
  if (!dependenciesReady) {
    if (values.check) throw Error('Dependencies are missing. Run setup without --check to install them.');
    const npm = await findExecutable('npm');
    if (!npm) throw Error('npm is missing. Reinstall Node.js LTS with npm, then rerun setup.');
    console.log('Installing bridge dependencies. Internet access to npm is required...');
    const install = runCommand(npm, ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit', timeout: 300000 });
    if (install.status !== 0) throw Error('Dependency installation failed. Check your network/proxy and npm output above, then rerun setup.');
  }
  const { parse } = await import('smol-toml');
  const entry = launchEntry();
  console.log('Checking the bridge MCP handshake and pairing tool...');
  await probeBridge(entry);
  if (client === 'claude-code') {
    const existing = runCommand(claude, ['mcp', 'get', 'web64']);
    if (existing.error || existing.signal) throw Error('Claude Code did not respond to the registration check.');
    if (existing.status === 0) {
      // get is human-readable; do not guess whether an existing command is ours.
      if (values.check) { console.log('Claude Code has a web64 entry. Check /mcp in Claude Code to verify its connection.'); return; }
      throw Error('Claude Code already has a web64 entry. Use claude mcp get web64 to inspect it. To replace the user entry, run claude mcp remove --scope user web64, then rerun setup.');
    }
    if (values.check) throw Error('Bridge startup passed, but Web64 is not registered. Run setup without --check.');
    const added = runCommand(claude, ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'web64', '--', entry.command, ...entry.args]);
    if (added.status !== 0) throw Error('Claude Code could not register Web64. Check claude mcp --help and rerun setup.');
    if (runCommand(claude, ['mcp', 'get', 'web64']).status !== 0) throw Error('Claude Code registration could not be verified. Run claude mcp get web64.');
  } else {
    const original = await readOptional(path);
    let updated;
    try { updated = prepareConfig(client, original, entry, parse); }
    catch (error) { throw Error(`${error.message}\nConfiguration: ${path}`); }
    if (values.check) {
      if (updated !== original) throw Error('Bridge startup passed, but Web64 is not registered. Run setup without --check.');
      console.log('Bridge startup and registration checks passed.'); return;
    }
    const result = await commitConfig(path, original, updated);
    console.log(`${result.changed ? 'Registered' : 'Already registered'}: ${path}`);
    if (result.backup) console.log(`Previous settings backup: ${result.backup}`);
  }
  console.log('\nSetup complete. Keep this bridge folder in its current location.\n\n1. Fully quit and restart your MCP client.\n2. Ask: "Pair with Web64 so you can edit and build my project. Show me the invitation link."\n3. Open the invitation and click Connect local bridge.\n4. Accept any browser local-network prompt, then approve Allow editing and builds.\n\nYour client starts the bridge automatically. No terminal needs to stay open.\nIf an invitation expires, ask for a new one. Setup never grants browser capabilities.');
}
