#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { createUltimateTarget } from './devices/ultimate-target.mjs';
import { createUltimateHttp } from './devices/ultimate-http.mjs';
import { connectUltimateTcp } from './devices/ultimate-tcp.mjs';
import { createUltimateLaunchExecutor } from './devices/ultimate-launch.mjs';
import { createDeviceJobs } from './devices/device-jobs.mjs';
import { createDevicePairing } from './devices/device-pairing.mjs';
import { BRIDGE_VERSION } from './version.mjs';

let pairing, jobs, stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await pairing?.close();
  await jobs?.close();
}

try {
  const { values } = parseArgs({ options: {
    device: { type: 'string' },
    'ide-url': { type: 'string', default: 'https://web64.nofs.ai/ide/' },
    'allow-local-ide': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  }, allowPositionals: false });
  if (values.help) {
    process.stdout.write(`web64-device-bridge v${BRIDGE_VERSION}\nUsage: web64-device-bridge --device PRIVATE_IPV4_OR_LAN_HOSTNAME [--ide-url https://web64.nofs.ai/ide/]\nOptional WEB64_C64U_PASSWORD is read from this process environment and never saved. This device-only command does not register an MCP client or use Cloud.\n`);
  } else {
    if (!values.device) throw new Error('device_required');
    const url = new URL(values['ide-url']);
    if (url.pathname === '/ide') url.pathname = '/ide/';
    const hosted = ['https://web64.nofs.ai', 'https://web64-react-p6twac9nn-mika-jussilas-projects.vercel.app',
      'https://web64-react-nbo02ig2k-mika-jussilas-projects.vercel.app'];
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if ((!hosted.includes(url.origin) && !(values['allow-local-ide'] && local && ['http:', 'https:'].includes(url.protocol))) ||
        url.pathname !== '/ide/' || url.search || url.hash || url.username || url.password) throw new Error('origin_not_allowed');
    const target = await createUltimateTarget(values.device);
    const password = process.env.WEB64_C64U_PASSWORD || '';
    delete process.env.WEB64_C64U_PASSWORD;
    const http = createUltimateHttp({ target, password });
    const describe = async () => {
      const [api, info, drives, configs] = await Promise.all([
        http.getVersion(), http.getInfo(), http.getDrives(), http.getConfigs(),
      ]);
      return { product: info.product, firmwareVersion: info.firmware_version,
        apiVersion: api.version, drives: drives.drives, configCategories: configs.categories,
        status: 'read-only preflight; hardware support not yet qualified' };
    };
    jobs = createDeviceJobs({ target, executor: createUltimateLaunchExecutor({ http,
      connectTcp: () => connectUltimateTcp({ target, password }) }) });
    pairing = await createDevicePairing({ ideUrl: url.href, jobs, describe });
    const showInvitation = () => {
      const invitation = pairing.begin(`C64 Ultimate at ${values.device}`);
      process.stdout.write(`\nOpen this invitation in the selected Web64 IDE browser, then approve the requested scope:\n${invitation.url}\n\n`);
    };
    showInvitation();
    process.stderr.write(`[INFO] Device bridge v${BRIDGE_VERSION} listening on loopback. Type invite for a fresh link, status, or quit.\n`);
    const input = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
    input.on('line', line => {
      const command = line.trim().toLowerCase();
      if (command === 'invite') showInvitation();
      else if (command === 'status') process.stderr.write(`${JSON.stringify(pairing.status())}\n`);
      else if (command === 'quit') void stop();
    });
    process.once('SIGINT', () => void stop());
    process.once('SIGTERM', () => void stop());
  }
} catch (error) {
  process.stderr.write(`[ERROR] Device bridge startup failed (${error.message === 'origin_not_allowed' ? 'origin_not_allowed' :
    error.message === 'device_required' ? 'device_required' : 'invalid_configuration'}).\n`);
  await stop();
  process.exitCode = 1;
}
