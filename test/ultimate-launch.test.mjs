import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createUltimateLaunchExecutor } from '../src/devices/ultimate-launch.mjs';

const nonce = '1f'.repeat(16);
const requirements = { video: 'pal', reuCapacityKiB: 128, driveUnits: [] };
const basicPrg = Buffer.from([1, 8, 11, 8, 10, 0, 0x9e, 50, 48, 54, 49, 0, 0, 0, 0xea, 0x60]);
const rawPrg = Buffer.from([0, 0x40, 0xa9, 5, 0x8d, 0x20, 0xd0, 0x60]);

function labHttp(log, state) {
  return {
    getVersion: async () => ({ version: '0.1' }),
    getInfo: async () => ({ product: 'C64 Ultimate', firmware_version: '1.1' }),
    getConfigs: async () => ({ categories: ['U64 Specific Settings', 'C64 and Cartridge Settings'] }),
    getConfigCategory: async category => category === 'U64 Specific Settings'
      ? { [category]: { 'System Mode': 'PAL', 'Turbo Control': state.turbo || 'Off', 'CPU Speed': state.cpu || ' 1' } }
      : { [category]: { 'RAM Expansion Unit': 'Enabled', 'REU Size': '128 KB' } },
    getDrives: async () => ({ drives: [{ a: { enabled: true, bus_id: state.swap ? 9 : 8 } },
      { b: { enabled: true, bus_id: state.swap ? 8 : 9 } }] }),
    readMailbox: async () => {
      log.push('mailbox read');
      const bytes = Buffer.alloc(64);
      Buffer.from([0x57, 0x36, 0x34, 0x55, 1]).copy(bytes);
      Buffer.from(nonce, 'hex').copy(bytes, 5);
      bytes[21] = state.released ? (state.guestPhase ?? 3) : 1;
      return bytes;
    },
    runPrg: async file => { log.push(`run ${file.name}`); },
    mountD64: async (slot, mode) => { log.push(`mount ${slot}:${mode}`); },
    writeMemory: async (address, bytes) => {
      log.push(`write ${address.toString(16)}:${bytes.length}`);
      if (address === 0xcfd5 && bytes.equals(Buffer.of(2))) state.released = true;
    },
    runCrt: async () => { log.push('run crt'); },
  };
}

function bootDisk(loadAddress = 0x4000) {
  const bytes = Buffer.alloc(174848);
  const directory = (17 * 21 + 1) * 256;
  bytes[directory + 2] = 0x82;
  bytes[directory + 3] = 1;
  bytes[directory + 4] = 0;
  bytes.fill(0xa0, directory + 5, directory + 21);
  Buffer.from('TEST', 'ascii').copy(bytes, directory + 5);
  bytes[0] = 0;
  bytes[1] = 6;
  bytes.set([loadAddress & 255, loadAddress >> 8, 0xea, 0xea, 0x60], 2);
  return bytes;
}

function cartridgeBytes(profile) {
  const info = {
    'standard-8k': [0, 0, 1, 0x2000, 0, 0x8000],
    'standard-16k': [0, 0, 0, 0x4000, 0, 0x8000],
    'magic-desk': [19, 0, 1, 0x2000, 0, 0x8000],
    easyflash: [32, 1, 0, 0x2000, 2, 0xe000],
  }[profile];
  const bytes = Buffer.alloc(0x50 + info[3]);
  Buffer.from('C64 CARTRIDGE   ').copy(bytes);
  bytes.writeUInt32BE(0x40, 0x10);
  bytes.writeUInt16BE(0x0100, 0x14);
  bytes.writeUInt16BE(info[0], 0x16);
  bytes[0x18] = info[1]; bytes[0x19] = info[2];
  Buffer.from('CHIP').copy(bytes, 0x40);
  bytes.writeUInt32BE(0x10 + info[3], 0x44);
  bytes.writeUInt16BE(info[4], 0x48);
  bytes.writeUInt16BE(info[5], 0x4c);
  bytes.writeUInt16BE(info[3], 0x4e);
  if (profile === 'easyflash') {
    bytes.writeUInt16LE(0xe000, 0x50 + 0x1ffc);
    bytes[0x50] = 0x78;
  } else {
    bytes.writeUInt16LE(0x8010, 0x50);
    bytes.writeUInt16LE(0x8010, 0x52);
    Buffer.from([0xc3, 0xc2, 0xcd, 0x38, 0x30]).copy(bytes, 0x54);
  }
  return bytes;
}

async function staged(run, additional = []) {
  const root = await mkdtemp(join(tmpdir(), 'web64-ultimate-launch-test-'));
  try {
    const image = Buffer.alloc(128 * 1024, 0x4a);
    const files = [
      { id: 'bootstrap', kind: 'prg', bytes: basicPrg },
      { id: 'program', kind: 'prg', bytes: rawPrg },
      { id: 'image', kind: 'reu', bytes: image },
      ...additional,
    ];
    for (const file of files) {
      file.path = join(root, `${file.id}.bin`);
      file.length = file.bytes.length;
      await writeFile(file.path, file.bytes);
    }
    return await run(files.map(({ id, kind, path, length }) => ({ id, kind, path, length })));
  } finally { await rm(root, { recursive: true, force: false }); }
}

test('composed launch orders bootstrap ready, RAM load, REU writes, same-socket barrier, then release', async () => {
  await staged(async artifacts => {
    const log = [], state = {};
    const http = labHttp(log, state);
    const executor = createUltimateLaunchExecutor({ http, connectTcp: async () => ({
      writeReu: async (offset, chunk) => { log.push(`reu ${offset}:${chunk.length}`); },
      barrier: async () => { log.push('fence'); return 'C64U'; },
      close() { log.push('tcp close'); },
    }), pollMs: 1, acknowledgementMs: 10 });
    const manifest = { recipe: { kind: 'prg', requirements,
      program: { artifactId: 'program', entryAddress: 0x4000 }, reuArtifactId: 'image',
      bootstrap: { artifactId: 'bootstrap', nonce, workspace: { address: 0xc800, length: 0x800 } } } };
    const approvedPreflight = await executor.preflight({ manifest, artifacts });
    assert.equal(approvedPreflight.ready, true);
    let mutated = false, launched = false;
    const result = await executor.commit({ manifest, artifacts, approvedPreflight, checkActive() {},
      markMutation() { mutated = true; }, markLaunchRequested() { launched = true; } });
    assert.equal(mutated, true);
    assert.equal(launched, true);
    assert.equal(result.deliveryLevel, 'launch-requested');
    assert.equal(result.guestHandoffObserved, true);
    const at = text => log.findIndex(item => item.startsWith(text));
    assert.ok(at('run bootstrap.prg') < at('mailbox read'));
    assert.ok(at('mailbox read') < at('write 4000:6'));
    assert.ok(at('write 4000:6') < at('reu 0:32768'));
    // The first fence is the read-only DMA-service probe during preflight.
    assert.ok(at('fence') < at('run bootstrap.prg'));
    const lastFence = log.lastIndexOf('fence');
    assert.ok(at('reu 98304:32768') < lastFence);
    assert.ok(lastFence < at('write cfd5:1'));
  });
});

test('changed preflight or cancellation blocks all launch dispatch before mutation', async () => {
  await staged(async artifacts => {
    const log = [], state = { cpu: ' 2', turbo: 'Manual' };
    const executor = createUltimateLaunchExecutor({ http: labHttp(log, state), connectTcp: async () => {
      throw new Error('tcp must not connect');
    } });
    const manifest = { recipe: { kind: 'prg', requirements,
      program: { artifactId: 'program', entryAddress: 0x4000 }, reuArtifactId: 'image',
      bootstrap: { artifactId: 'bootstrap', nonce, workspace: { address: 0xc800, length: 0x800 } } } };
    const approvedPreflight = await executor.preflight({ manifest, artifacts });
    assert.equal(approvedPreflight.ready, false);
    await assert.rejects(executor.commit({ manifest, artifacts, approvedPreflight,
      checkActive() {}, markMutation() {
      throw new Error('must_not_mutate');
    }, markLaunchRequested() { throw new Error('must_not_launch'); } }), /device_preflight_changed/);
    assert.equal(log.length, 0);
  });
});

test('disk preflight checks PETSCII boot PRG and rejects workspace collision before mount', async () => {
  await staged(async artifacts => {
    const disk = artifacts.find(item => item.id === 'disk8');
    const log = [], state = {};
    const executor = createUltimateLaunchExecutor({ http: labHttp(log, state), connectTcp: async () => {
      throw new Error('no REU requested');
    }, acknowledgementMs: 10, pollMs: 1 });
    const recipe = { kind: 'disk-set', requirements: { video: 'pal', reuCapacityKiB: null, driveUnits: [8] },
      program: { bootNameHex: Buffer.from('TEST').toString('hex'), entryAddress: 0x4000, unit: 8 },
      bootstrap: { artifactId: 'bootstrap', nonce, workspace: { address: 0xc800, length: 0x800 } },
      reuArtifactId: null, mounts: [{ unit: 8, artifactId: 'disk8', mode: 'unlinked' }] };
    const manifest = { recipe };
    const approvedPreflight = await executor.preflight({ manifest, artifacts });
    assert.deepEqual(approvedPreflight.bootProgram,
      { loadAddress: 0x4000, endAddress: 0x4003 });
    const receipt = await executor.commit({ manifest, artifacts, approvedPreflight,
      checkActive() {}, markMutation() {},
      markLaunchRequested() {} });
    assert.equal(receipt.deliveryLevel, 'launch-requested');
    assert.equal(receipt.guestHandoffObserved, true);
    assert.ok(log.indexOf('run bootstrap.prg') < log.indexOf('mount a:unlinked'));
    assert.ok(log.indexOf('mount a:unlinked') < log.indexOf('write cfd5:1'));
    await writeFile(disk.path, bootDisk(0xc800));
    await assert.rejects(executor.preflight({ manifest, artifacts }), /d64_boot_workspace_conflict/);
  }, [{ id: 'disk8', kind: 'd64', bytes: bootDisk() }]);
});

test('an IEC slot remap after approval blocks commit before any mount or runner request', async () => {
  await staged(async artifacts => {
    const log = [], state = {};
    const executor = createUltimateLaunchExecutor({ http: labHttp(log, state), connectTcp: async () => {
      throw new Error('must not connect');
    } });
    const manifest = { recipe: { kind: 'disk-set',
      requirements: { video: 'pal', reuCapacityKiB: null, driveUnits: [8] },
      program: { bootNameHex: Buffer.from('TEST').toString('hex'), entryAddress: 0x4000, unit: 8 },
      bootstrap: { artifactId: 'bootstrap', nonce, workspace: { address: 0xc800, length: 0x800 } },
      reuArtifactId: null, mounts: [{ unit: 8, artifactId: 'disk8', mode: 'readonly' }] } };
    const approvedPreflight = await executor.preflight({ manifest, artifacts });
    assert.equal(approvedPreflight.driveMapping[8], 'a');
    state.swap = true;
    await assert.rejects(executor.commit({ manifest, artifacts, approvedPreflight,
      checkActive() {}, markMutation() { throw new Error('must_not_mutate'); },
      markLaunchRequested() { throw new Error('must_not_launch'); } }), /device_preflight_changed/);
    assert.equal(log.length, 0);
  }, [{ id: 'disk8', kind: 'd64', bytes: bootDisk() }]);
});

test('two-drive disk launch mounts only after guest ready; a second-mount failure never releases it', async () => {
  await staged(async artifacts => {
    const log = [], state = {};
    const http = labHttp(log, state);
    http.mountD64 = async (slot, mode) => {
      log.push(`mount ${slot}:${mode}`);
      if (slot === 'b') throw new Error('device_mount_failed');
    };
    const executor = createUltimateLaunchExecutor({ http, connectTcp: async () => {
      throw new Error('no REU transfer expected');
    }, pollMs: 1 });
    const manifest = { recipe: { kind: 'disk-set',
      requirements: { video: 'pal', reuCapacityKiB: null, driveUnits: [8, 9] },
      program: { bootNameHex: Buffer.from('TEST').toString('hex'), entryAddress: 0x4000, unit: 8 },
      bootstrap: { artifactId: 'bootstrap', nonce, workspace: { address: 0xc800, length: 0x800 } },
      reuArtifactId: null, mounts: [
        { unit: 8, artifactId: 'disk8', mode: 'unlinked' },
        { unit: 9, artifactId: 'disk9', mode: 'readonly' },
      ] } };
    const approvedPreflight = await executor.preflight({ manifest, artifacts });
    assert.deepEqual(approvedPreflight.driveMapping, { 8: 'a', 9: 'b' });
    let mutated = false;
    await assert.rejects(executor.commit({ manifest, artifacts, approvedPreflight,
      checkActive() {}, markMutation() { mutated = true; },
      markLaunchRequested() { throw new Error('must_not_release'); } }), /device_mount_failed/);
    assert.equal(mutated, true);
    assert.ok(log.indexOf('run bootstrap.prg') < log.indexOf('mount a:unlinked'));
    assert.deepEqual(log.filter(item => item.startsWith('mount ')), ['mount a:unlinked', 'mount b:readonly']);
    assert.equal(log.some(item => item.startsWith('write cfd5')), false);
  }, [{ id: 'disk8', kind: 'd64', bytes: bootDisk() },
    { id: 'disk9', kind: 'd64', bytes: bootDisk() }]);
});

test('standalone BASIC-SYS PRG and four CRT profiles use exactly one typed runner dispatch', async () => {
  await staged(async artifacts => {
    const log = [], state = {};
    const executor = createUltimateLaunchExecutor({ http: labHttp(log, state), connectTcp: async () => {
      throw new Error('standalone launch must not open TCP');
    } });
    const program = artifacts.filter(item => item.id === 'bootstrap');
    const direct = { recipe: { kind: 'prg', requirements: { video: 'pal', reuCapacityKiB: null, driveUnits: [] },
      program: { artifactId: 'bootstrap', entryAddress: null }, bootstrap: null, reuArtifactId: null } };
    const directApproval = await executor.preflight({ manifest: direct, artifacts: program });
    assert.equal((await executor.commit({ manifest: direct, artifacts: program, approvedPreflight: directApproval,
      checkActive() {}, markMutation() {}, markLaunchRequested() {} })).deliveryLevel, 'launch-requested');
    for (const profile of ['standard-8k', 'standard-16k', 'magic-desk', 'easyflash']) {
      const cartridge = artifacts.filter(item => item.id === 'cart');
      const bytes = cartridgeBytes(profile);
      await writeFile(cartridge[0].path, bytes);
      cartridge[0].length = bytes.length;
      const manifest = { recipe: { kind: 'cartridge',
        requirements: { video: 'pal', reuCapacityKiB: null, driveUnits: [] },
        program: { artifactId: 'cart', profile }, reuArtifactId: null } };
      const approvedPreflight = await executor.preflight({ manifest, artifacts: cartridge });
      assert.equal((await executor.commit({ manifest, artifacts: cartridge, approvedPreflight,
        checkActive() {}, markMutation() {}, markLaunchRequested() {} })).deliveryLevel, 'launch-requested');
    }
    assert.deepEqual(log, ['run launch.prg', 'run crt', 'run crt', 'run crt', 'run crt']);
  }, [{ id: 'cart', kind: 'crt', bytes: cartridgeBytes('standard-8k') }]);
});

test('malformed CRT bank or missing boot vectors is rejected before any runner mutation', async () => {
  await staged(async artifacts => {
    const cart = artifacts.find(item => item.id === 'cart');
    const log = [], state = {};
    const executor = createUltimateLaunchExecutor({ http: labHttp(log, state), connectTcp: async () => {
      throw new Error('must_not_connect');
    } });
    const manifest = { recipe: { kind: 'cartridge',
      requirements: { video: 'pal', reuCapacityKiB: null, driveUnits: [] },
      program: { artifactId: 'cart', profile: 'standard-8k' }, reuArtifactId: null } };
    for (const modify of [
      bytes => bytes.writeUInt16BE(1, 0x4a),
      bytes => bytes.writeUInt16BE(0xc000, 0x4c),
      bytes => bytes[0x54] = 0,
    ]) {
      const bytes = cartridgeBytes('standard-8k');
      modify(bytes);
      await writeFile(cart.path, bytes);
      await assert.rejects(executor.preflight({ manifest, artifacts: [cart] }), /invalid_crt_artifact/);
    }
    assert.equal(log.length, 0);
  }, [{ id: 'cart', kind: 'crt', bytes: cartridgeBytes('standard-8k') }]);
});

test('cancel after guest ready and REU fence failure both prevent release', async () => {
  await staged(async artifacts => {
    const log = [], state = {};
    const http = labHttp(log, state);
    const originalRead = http.readMailbox;
    http.readMailbox = async address => { const value = await originalRead(address); state.cancel = true; return value; };
    const executor = createUltimateLaunchExecutor({ http, connectTcp: async () => {
      if (state.cancel) throw new Error('TCP must not connect after cancellation');
      return { async writeReu() {}, async barrier() { return 'C64U'; }, close() {} };
    } });
    const manifest = { recipe: { kind: 'prg', requirements,
      program: { artifactId: 'program', entryAddress: 0x4000 }, reuArtifactId: 'image',
      bootstrap: { artifactId: 'bootstrap', nonce, workspace: { address: 0xc800, length: 0x800 } } } };
    const approvedPreflight = await executor.preflight({ manifest, artifacts });
    await assert.rejects(executor.commit({ manifest, artifacts, approvedPreflight,
      checkActive() { if (state.cancel) throw new Error('device_job_cancelled'); },
      markMutation() {}, markLaunchRequested() { throw new Error('must_not_release'); } }), /device_job_cancelled/);
    assert.equal(log.some(item => item.startsWith('write cfd5')), false);
  });
  await staged(async artifacts => {
    const log = [], state = {};
    const executor = createUltimateLaunchExecutor({ http: labHttp(log, state), connectTcp: async () => ({
      async writeReu() { log.push('reu write'); },
      async barrier() {
        if (!log.includes('reu write')) return 'C64U'; // preflight DMA-service probe
        log.push('fence failed'); throw new Error('tcp_reply_timeout');
      },
      close() { log.push('tcp close'); },
    }) });
    const manifest = { recipe: { kind: 'prg', requirements,
      program: { artifactId: 'program', entryAddress: 0x4000 }, reuArtifactId: 'image',
      bootstrap: { artifactId: 'bootstrap', nonce, workspace: { address: 0xc800, length: 0x800 } } } };
    const approvedPreflight = await executor.preflight({ manifest, artifacts });
    await assert.rejects(executor.commit({ manifest, artifacts, approvedPreflight,
      checkActive() {}, markMutation() {}, markLaunchRequested() { throw new Error('must_not_release'); } }),
    /tcp_reply_timeout/);
    assert.equal(log.some(item => item.startsWith('write cfd5')), false);
    assert.ok(log.includes('tcp close'));
  });
});

test('REU preflight reports an unavailable or rejecting DMA service before any device change', async () => {
  for (const [failure, code] of [[Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), 'dma_service_unavailable'],
    [new Error('tcp_auth_rejected'), 'dma_auth_rejected']]) {
    await staged(async artifacts => {
      const log = [], state = {};
      const executor = createUltimateLaunchExecutor({ http: labHttp(log, state), connectTcp: async () => { throw failure; } });
      const manifest = { recipe: { kind: 'prg', requirements,
        program: { artifactId: 'program', entryAddress: 0x4000 }, reuArtifactId: 'image',
        bootstrap: { artifactId: 'bootstrap', nonce, workspace: { address: 0xc800, length: 0x800 } } } };
      const preflight = await executor.preflight({ manifest, artifacts });
      assert.equal(preflight.ready, false);
      assert.equal(preflight.issues.at(-1).code, code);
      assert.deepEqual(log, []);
    });
  }
});

test('disk guest that took the release and is still loading counts as an observed handoff', async () => {
  await staged(async artifacts => {
    const log = [], state = { guestPhase: 5 };
    const executor = createUltimateLaunchExecutor({ http: labHttp(log, state), connectTcp: async () => {
      throw new Error('no REU requested');
    }, acknowledgementMs: 10, diskAcknowledgementMs: 20, pollMs: 1 });
    const manifest = { recipe: { kind: 'disk-set', requirements: { video: 'pal', reuCapacityKiB: null, driveUnits: [8] },
      program: { bootNameHex: Buffer.from('TEST').toString('hex'), entryAddress: 0x4000, unit: 8 },
      bootstrap: { artifactId: 'bootstrap', nonce, workspace: { address: 0xc800, length: 0x800 } },
      reuArtifactId: null, mounts: [{ unit: 8, artifactId: 'disk8', mode: 'unlinked' }] } };
    const approvedPreflight = await executor.preflight({ manifest, artifacts });
    const receipt = await executor.commit({ manifest, artifacts, approvedPreflight,
      checkActive() {}, markMutation() {}, markLaunchRequested() {} });
    assert.equal(receipt.guestHandoffObserved, true);
    assert.equal(receipt.guestPhase, 'loading');
    state.released = false;
    state.guestPhase = 4;
    const failed = await executor.preflight({ manifest, artifacts });
    await assert.rejects(executor.commit({ manifest, artifacts, approvedPreflight: failed,
      checkActive() {}, markMutation() {}, markLaunchRequested() {} }), /guest_load_failed/);
  }, [{ id: 'disk8', kind: 'd64', bytes: bootDisk() }]);
});
