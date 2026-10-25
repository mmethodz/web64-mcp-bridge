import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readUltimatePreflight, validateUltimateRequirements } from '../src/devices/ultimate-preflight.mjs';

const requirements = { video: 'pal', reuCapacityKiB: 512, driveUnits: [8, 9] };

// Value shapes follow the firmware REST API: enum settings are the raw option
// text, so CPU Speed reads " 1" (not "1 MHz") and Turbo Control defaults to Off.
function device({ video = 'PAL', cpu = ' 1', turbo = 'Off', reu = 'Enabled', size = '512 KB',
  drives = [{ a: { enabled: true, bus_id: 9 } }, { b: { enabled: true, bus_id: 8 } }] } = {}) {
  const calls = [];
  const http = {
    getVersion: async () => { calls.push('version'); return { version: '0.1' }; },
    getInfo: async () => { calls.push('info'); return { product: 'C64 Ultimate', firmware_version: '1.1' }; },
    getConfigs: async () => { calls.push('configs'); return { categories: ['U64 Specific Settings', 'C64 and Cartridge Settings'] }; },
    getDrives: async () => { calls.push('drives'); return { drives }; },
    getConfigCategory: async category => {
      calls.push(category);
      return category === 'U64 Specific Settings'
        ? { [category]: { 'System Mode': video, 'Turbo Control': turbo, 'CPU Speed': cpu } }
        : { [category]: { 'RAM Expansion Unit': reu, 'REU Size': size } };
    },
  };
  return { http, calls };
}

test('preflight is read-only and maps IEC 8/9 from live drive IDs, not A/B order', async () => {
  const { http, calls } = device();
  const result = await readUltimatePreflight(http, requirements);
  assert.equal(result.ready, true);
  assert.deepEqual(result.driveMapping, { 8: 'b', 9: 'a' });
  assert.equal(result.identity.product, 'C64 Ultimate');
  assert.equal(calls.length, 6);
  assert.equal(calls.some(name => name.startsWith('write') || name.startsWith('mount')), false);
});

test('video, turbo, insufficient/disabled REU, unknown values and drive conflicts fail closed', async () => {
  for (const changed of [
    { video: 'NTSC' }, { video: undefined, turbo: 'Manual', cpu: ' 2' }, { reu: 'Disabled' },
    { reu: 'GeoRAM Mode' }, { turbo: 'U64 Turbo Registers', cpu: '48' }, { turbo: null, cpu: null },
    { size: '256 KB' }, { size: 'unknown' },
    { drives: [{ a: { enabled: true, bus_id: 8 } }, { b: { enabled: false, bus_id: 9 } }] },
    { drives: [{ a: { enabled: true, bus_id: 8 } }, { b: { enabled: true, bus_id: 9 } },
      { softiec: { enabled: true, bus_id: 9 } }] },
  ]) {
    const result = await readUltimatePreflight(device(changed).http, requirements);
    assert.equal(result.ready, false, JSON.stringify(changed));
    assert.ok(result.issues.length > 0);
  }
});

test('unknown schema and malformed requirements never imply compatibility', async () => {
  assert.throws(() => validateUltimateRequirements({ ...requirements, driveUnits: [8, 8] }), /invalid_device_requirements/);
  assert.throws(() => validateUltimateRequirements({ ...requirements, reuCapacityKiB: 64 }), /invalid_device_requirements/);
  const { http } = device();
  http.getConfigs = async () => ({ categories: ['C64 and Cartridge Settings'] });
  await assert.rejects(readUltimatePreflight(http, requirements), /device_config_unknown/);
  const broken = device();
  broken.http.getConfigCategory = async () => ({ 'U64 Specific Settings': null });
  await assert.rejects(readUltimatePreflight(broken.http, requirements), /device_config_unknown/);
  const unknown = device();
  unknown.http.getInfo = async () => ({ product: '' });
  await assert.rejects(readUltimatePreflight(unknown.http, requirements), /device_identity_unknown/);
});

test('firmware CPU Speed values pass when the 6510 runs at the standard clock', async () => {
  for (const changed of [
    { cpu: ' 1', turbo: 'Off' }, { cpu: '48', turbo: 'Off' }, { cpu: ' 1', turbo: 'Manual' },
    { cpu: '1 MHz', turbo: null }, { cpu: ' 1', turbo: null },
  ]) {
    const result = await readUltimatePreflight(device(changed).http, requirements);
    assert.equal(result.ready, true, JSON.stringify(changed));
  }
  const blocked = await readUltimatePreflight(device({ cpu: ' 4', turbo: 'Manual' }).http, requirements);
  assert.deepEqual(blocked.issues.map(issue => issue.code), ['cpu_not_standard']);
  assert.equal(blocked.issues[0].turboControl, 'Manual');
});

test('unknown drive-list entries are tolerated unless they occupy a requested unit', async () => {
  const base = [{ a: { enabled: true, bus_id: 9 } }, { b: { enabled: true, bus_id: 8 } }];
  const extra = await readUltimatePreflight(device({ drives: [...base,
    { 'Printer Emulation': { enabled: true, bus_id: 4 } }, { future: { note: 'no bus id' } }] }).http, requirements);
  assert.equal(extra.ready, true);
  const clash = await readUltimatePreflight(device({ drives: [...base,
    { future: { enabled: true, bus_id: 8 } }] }).http, requirements);
  assert.equal(clash.ready, false);
  assert.deepEqual(clash.issues.map(issue => issue.code), ['drive_mapping']);
  await assert.rejects(readUltimatePreflight(device({ drives: [{ a: { enabled: 'yes', bus_id: 8 } }] }).http,
    { ...requirements, driveUnits: [8] }), /device_drives_unknown/);
});
