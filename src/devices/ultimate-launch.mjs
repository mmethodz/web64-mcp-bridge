import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { readUltimatePreflight } from './ultimate-preflight.mjs';
import { deviceErrorCode } from './device-contract.mjs';

const MAILBOX_BYTES = 64;
const PHASE_OFFSET = 21;
const READY = 1, RELEASED = 2, RUNNING = 3, FAILED = 4, LOADING = 5;
const MAX_RAM_CHUNK = 8192;
const MAILBOX_MAGIC = Buffer.from([0x57, 0x36, 0x34, 0x55, 1]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const overlap = (a, b, c, d) => a < d && c < b;
const mappedRam = (start, end) => start >= 0x0200 &&
  ((end <= 0xa000) || (start >= 0xc000 && end <= 0xd000));

function named(artifacts, id) {
  const artifact = artifacts.find(item => item.id === id);
  if (!artifact) throw new Error('device_artifact_missing');
  return artifact;
}

async function prg(artifact) {
  const bytes = await readFile(artifact.path);
  if (bytes.length !== artifact.length || bytes.length < 3 || bytes.length > 65538) throw new Error('invalid_prg_artifact');
  const loadAddress = bytes.readUInt16LE(0);
  if (loadAddress < 0x0200 || loadAddress + bytes.length - 2 > 0x10000) throw new Error('invalid_prg_load_range');
  return { bytes, loadAddress, endAddress: loadAddress + bytes.length - 2 };
}

function basicSys(prg) {
  const { bytes, loadAddress, endAddress } = prg;
  if (loadAddress !== 0x0801 || bytes.length < 14 || bytes[6] !== 0x9e) throw new Error('prg_requires_basic_sys');
  const end = bytes.indexOf(0, 7);
  if (end < 8 || end > 13) throw new Error('prg_requires_basic_sys');
  const digits = bytes.subarray(7, end).toString('ascii').trim();
  const entry = Number(digits);
  if (!/^\d+$/.test(digits) || !Number.isInteger(entry) || entry < loadAddress || entry >= endAddress) {
    throw new Error('prg_requires_basic_sys');
  }
}

function assertCartridge(bytes, profile) {
  const expected = {
    'standard-8k': [0, 0, 1], 'standard-16k': [0, 0, 0],
    'magic-desk': [19, 0, 1], easyflash: [32, 1, 0],
  }[profile];
  if (!expected || bytes.length < 0x40 + 0x10 || bytes.length > 0x40 + 128 * (0x10 + 0x2000) ||
      bytes.subarray(0, 16).toString('ascii') !== 'C64 CARTRIDGE   ' ||
      bytes.readUInt32BE(0x10) !== 0x40 ||
      ![0x0100, 0x0101, 0x0200].includes(bytes.readUInt16BE(0x14)) ||
      bytes.readUInt16BE(0x16) !== expected[0] ||
      bytes[0x18] !== expected[1] || bytes[0x19] !== expected[2]) {
    throw new Error('invalid_crt_artifact');
  }
  let offset = 0x40, chips = 0, boot = null;
  const seen = new Set();
  while (offset < bytes.length) {
    if (offset + 0x10 > bytes.length || bytes.toString('ascii', offset, offset + 4) !== 'CHIP') {
      throw new Error('invalid_crt_artifact');
    }
    const packetLength = bytes.readUInt32BE(offset + 4);
    const imageLength = bytes.readUInt16BE(offset + 14);
    const chipType = bytes.readUInt16BE(offset + 8);
    const bank = bytes.readUInt16BE(offset + 10);
    const address = bytes.readUInt16BE(offset + 12);
    if (packetLength !== imageLength + 0x10 || imageLength < 1 ||
        imageLength > (profile === 'standard-16k' ? 0x4000 : 0x2000) ||
        offset + packetLength > bytes.length) throw new Error('invalid_crt_artifact');
    const standard = profile === 'standard-8k' || profile === 'standard-16k';
    const window = address === 0x8000 ? 'roml' : 'romh';
    const key = `${bank}:${window}`;
    if (seen.has(key) ||
        (standard && (chips !== 0 || chipType !== 0 || bank !== 0 || address !== 0x8000 ||
          imageLength !== (profile === 'standard-8k' ? 0x2000 : 0x4000))) ||
        (profile === 'magic-desk' && (chipType !== 0 || bank >= 64 || address !== 0x8000 || imageLength !== 0x2000)) ||
        (profile === 'easyflash' && (chipType !== 2 || bank >= 64 ||
          ![0x8000, 0xa000, 0xe000].includes(address) || imageLength !== 0x2000))) {
      throw new Error('invalid_crt_artifact');
    }
    seen.add(key);
    if (bank === 0 && ((profile === 'easyflash' && address === 0xe000) ||
        (profile !== 'easyflash' && address === 0x8000))) {
      boot = bytes.subarray(offset + 0x10, offset + packetLength);
    }
    chips++;
    offset += packetLength;
  }
  if (chips === 0 || offset !== bytes.length || !boot) throw new Error('invalid_crt_artifact');
  if (profile === 'easyflash') {
    const reset = boot.readUInt16LE(0x1ffc);
    if (reset < 0xe000 || reset > 0xffff || boot[reset - 0xe000] === 0xff) {
      throw new Error('invalid_crt_artifact');
    }
  } else {
    const start = boot.readUInt16LE(0), warm = boot.readUInt16LE(2);
    if (start < 0x8000 || start > 0x9fff || warm < 0x8000 || warm > 0x9fff ||
        !boot.subarray(4, 9).equals(Buffer.from([0xc3, 0xc2, 0xcd, 0x38, 0x30]))) {
      throw new Error('invalid_crt_artifact');
    }
  }
}

function sectorOffset(track, sector) {
  if (!Number.isInteger(track) || track < 1 || track > 35) throw new Error('d64_directory_invalid');
  const sectors = t => t <= 17 ? 21 : t <= 24 ? 19 : t <= 30 ? 18 : 17;
  if (!Number.isInteger(sector) || sector < 0 || sector >= sectors(track)) throw new Error('d64_directory_invalid');
  let count = sector;
  for (let t = 1; t < track; t++) count += sectors(t);
  return count * 256;
}

function readD64File(bytes, startTrack, startSector) {
  const chunks = [];
  let total = 0, track = startTrack, sector = startSector;
  const seen = new Set();
  while (track) {
    const key = `${track}:${sector}`;
    if (seen.has(key) || seen.size > 683) throw new Error('d64_file_chain_invalid');
    seen.add(key);
    const offset = sectorOffset(track, sector);
    const nextTrack = bytes[offset], nextSector = bytes[offset + 1];
    const used = nextTrack ? 254 : nextSector - 1;
    if (used < 0 || used > 254) throw new Error('d64_file_chain_invalid');
    chunks.push(bytes.subarray(offset + 2, offset + 2 + used));
    total += used;
    if (total > 65538) throw new Error('d64_boot_too_large');
    track = nextTrack;
    sector = nextSector;
  }
  if (total < 3) throw new Error('d64_boot_invalid');
  return Buffer.concat(chunks, total);
}

function assertD64Boot(bytes, bootNameHex, workspace, entryAddress) {
  if (bytes.length !== 174848) throw new Error('d64_size_unsupported');
  const name = Buffer.from(bootNameHex, 'hex');
  let track = 18, sector = 1;
  const seen = new Set();
  while (track) {
    const key = `${track}:${sector}`;
    if (seen.has(key) || seen.size > 19) throw new Error('d64_directory_invalid');
    seen.add(key);
    const offset = sectorOffset(track, sector);
    for (let index = 0; index < 8; index++) {
      const base = offset + index * 32;
      if ((bytes[base + 2] & 7) !== 2 || !(bytes[base + 2] & 0x80)) continue;
      const filename = bytes.subarray(base + 5, base + 21);
      if (filename.subarray(0, name.length).equals(name) &&
          filename.subarray(name.length).every(byte => byte === 0xa0)) {
        const file = readD64File(bytes, bytes[base + 3], bytes[base + 4]);
        const loadAddress = file.readUInt16LE(0), endAddress = loadAddress + file.length - 2;
        if (!mappedRam(loadAddress, endAddress) ||
            overlap(loadAddress, endAddress, workspace.address, workspace.address + workspace.length) ||
            entryAddress < loadAddress || entryAddress >= endAddress) throw new Error('d64_boot_workspace_conflict');
        return { loadAddress, endAddress };
      }
    }
    track = bytes[offset];
    sector = bytes[offset + 1];
  }
  throw new Error('d64_boot_file_missing');
}

function mailboxState(bytes, nonce) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== MAILBOX_BYTES) throw new Error('device_mailbox_invalid');
  if (!bytes.subarray(0, 5).equals(MAILBOX_MAGIC) || !bytes.subarray(5, 21).equals(nonce)) return 'stale';
  return bytes[PHASE_OFFSET];
}

async function waitReady(http, address, nonce, checkActive, { timeoutMs, pollMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    checkActive();
    const phase = mailboxState(await http.readMailbox(address), nonce);
    if (phase === READY) return;
    if (phase === FAILED) throw new Error('guest_bootstrap_failed');
    await sleep(pollMs);
  }
  throw new Error('guest_ready_timeout');
}

// Returns 'running', 'loading' (disk bootstrap took the release and started its
// KERNAL LOAD, which can take far longer than the observation window at
// standard IEC speed) or null when no guest reaction was seen.
async function observeGuest(http, address, nonce, { timeoutMs, pollMs }) {
  const deadline = Date.now() + timeoutMs;
  let seen = null;
  while (Date.now() < deadline) {
    const phase = mailboxState(await http.readMailbox(address), nonce);
    if (phase === RUNNING) return 'running';
    if (phase === FAILED) throw new Error('guest_load_failed');
    if (phase === LOADING) seen = 'loading';
    await sleep(pollMs);
  }
  return seen;
}

// REU transfers need the separate TCP DMA service (port 64). Check that it is
// reachable and accepts the configured password before anything on the device
// is changed, instead of discovering it after the reset and RAM load.
async function probeDmaService(connectTcp) {
  let tcp = null;
  try {
    tcp = await connectTcp();
    return { identity: await tcp.barrier() };
  } catch (error) {
    const detail = deviceErrorCode(error);
    return { issue: { code: detail === 'tcp_auth_rejected' ? 'dma_auth_rejected' : 'dma_service_unavailable', detail } };
  } finally { tcp?.close(); }
}

export function createUltimateLaunchExecutor({ http, connectTcp, readyTimeoutMs = 15000,
  acknowledgementMs = 2000, diskAcknowledgementMs = 5000, pollMs = 250 } = {}) {
  if (!http || typeof connectTcp !== 'function') throw new Error('invalid_device_executor');
  async function inspect(manifest, artifacts) {
    const { recipe } = manifest;
    let compatibility = await readUltimatePreflight(http, recipe.requirements);
    let dmaService = null;
    if (compatibility.ready && recipe.reuArtifactId !== null) {
      const probe = await probeDmaService(connectTcp);
      if (probe.issue) compatibility = { ...compatibility, ready: false, issues: [...compatibility.issues, probe.issue] };
      else dmaService = { identity: probe.identity };
    }
    const published = manifest.artifacts?.map(({ id, kind, length, sha256 }) => ({ id, kind, length, sha256 })) ||
      artifacts.map(({ id, kind, length }) => ({ id, kind, length }));
    if (!compatibility.ready) return { ...compatibility, projectRevision: manifest.projectRevision,
      artifacts: published };
    const details = { ...compatibility, projectRevision: manifest.projectRevision, artifacts: published,
      ...(dmaService ? { dmaService } : {}) };
    if (recipe.kind === 'prg') {
      const program = await prg(named(artifacts, recipe.program.artifactId));
      if (recipe.bootstrap) {
        const boot = await prg(named(artifacts, recipe.bootstrap.artifactId));
        basicSys(boot);
        const { address, length } = recipe.bootstrap.workspace;
        if (!mappedRam(program.loadAddress, program.endAddress) ||
            overlap(program.loadAddress, program.endAddress, address, address + length) ||
            recipe.program.entryAddress < program.loadAddress || recipe.program.entryAddress >= program.endAddress) {
          throw new Error('bootstrap_program_overlap');
        }
      } else basicSys(program);
      details.program = { loadAddress: program.loadAddress, endAddress: program.endAddress,
        entryAddress: recipe.program.entryAddress };
    } else if (recipe.kind === 'disk-set') {
      basicSys(await prg(named(artifacts, recipe.bootstrap.artifactId)));
      for (const mount of recipe.mounts) {
        const bytes = await readFile(named(artifacts, mount.artifactId).path);
        if (mount.unit === recipe.program.unit) {
          details.bootProgram = assertD64Boot(bytes, recipe.program.bootNameHex,
            recipe.bootstrap.workspace, recipe.program.entryAddress);
        }
        else if (bytes.length !== 174848) throw new Error('d64_size_unsupported');
      }
      details.mounts = recipe.mounts.map(item => ({ unit: item.unit, mode: item.mode,
        slot: compatibility.driveMapping[item.unit], artifactId: item.artifactId }));
    } else if (recipe.kind === 'cartridge') {
      const file = named(artifacts, recipe.program.artifactId);
      const handle = await readFile(file.path);
      if (handle.length !== file.length) throw new Error('invalid_crt_artifact');
      assertCartridge(handle, recipe.program.profile);
      details.cartridgeProfile = recipe.program.profile;
    }
    return details;
  }

  return Object.freeze({
    preflight: ({ manifest, artifacts }) => inspect(manifest, artifacts),
    async commit(context) {
      const { manifest, artifacts, checkActive, markMutation, markLaunchRequested } = context;
      const recipe = manifest.recipe;
      checkActive();
      const checked = await inspect(manifest, artifacts);
      const approved = context.approvedPreflight;
      if (!checked.ready || !approved?.ready ||
          JSON.stringify([checked.identity, checked.actual, checked.driveMapping]) !==
          JSON.stringify([approved.identity, approved.actual, approved.driveMapping])) {
        throw new Error('device_preflight_changed');
      }
      checkActive();
      if (recipe.kind === 'cartridge') {
        markLaunchRequested();
        await http.runCrt({ ...named(artifacts, recipe.program.artifactId), name: 'launch.crt',
          size: named(artifacts, recipe.program.artifactId).length });
        return { deliveryLevel: 'launch-requested' };
      }
      if (recipe.kind === 'prg' && !recipe.bootstrap) {
        markLaunchRequested();
        await http.runPrg({ ...named(artifacts, recipe.program.artifactId), name: 'launch.prg',
          size: named(artifacts, recipe.program.artifactId).length });
        return { deliveryLevel: 'launch-requested' };
      }
      const bootFile = named(artifacts, recipe.bootstrap.artifactId);
      checkActive();
      markMutation();
      await http.runPrg({ ...bootFile, name: 'bootstrap.prg', size: bootFile.length });
      const { address, length } = recipe.bootstrap.workspace;
      const mailboxAddress = address + length - MAILBOX_BYTES;
      const nonce = Buffer.from(recipe.bootstrap.nonce, 'hex');
      await waitReady(http, mailboxAddress, nonce, checkActive, { timeoutMs: readyTimeoutMs, pollMs });
      // The runner may reset the machine. Mount only after its guest is ready,
      // so a reset cannot silently drop the intended disk before KERNAL LOAD.
      if (recipe.kind === 'disk-set') {
        const latest = await readUltimatePreflight(http, recipe.requirements);
        if (!latest.ready || recipe.mounts.some(item => latest.driveMapping[item.unit] !== checked.driveMapping[item.unit])) {
          throw new Error('device_drive_mapping_changed');
        }
        for (const mount of recipe.mounts) {
          checkActive();
          markMutation();
          const file = named(artifacts, mount.artifactId);
          await http.mountD64(checked.driveMapping[mount.unit], mount.mode,
            { ...file, name: `${mount.artifactId}.d64`, size: file.length });
        }
      }
      if (recipe.kind === 'prg') {
        const program = await prg(named(artifacts, recipe.program.artifactId));
        const payload = program.bytes.subarray(2);
        for (let offset = 0; offset < payload.length; offset += MAX_RAM_CHUNK) {
          checkActive();
          await http.writeMemory(program.loadAddress + offset, payload.subarray(offset, offset + MAX_RAM_CHUNK));
        }
      }
      if (recipe.reuArtifactId !== null) {
        const image = named(artifacts, recipe.reuArtifactId);
        const tcp = await connectTcp();
        try {
          let offset = 0;
          for await (const chunk of createReadStream(image.path, { highWaterMark: 32768 })) {
            checkActive();
            await tcp.writeReu(offset, chunk, image.length);
            offset += chunk.length;
          }
          if (offset !== image.length) throw new Error('reu_image_short_read');
          checkActive();
          await tcp.barrier(); // Same TCP connection: all preceding REU writes were processed.
        } finally { tcp.close(); }
      }
      checkActive();
      markLaunchRequested();
      await http.writeMemory(mailboxAddress + PHASE_OFFSET, Buffer.of(RELEASED));
      const guestPhase = await observeGuest(http, mailboxAddress, nonce,
        { timeoutMs: recipe.kind === 'disk-set' ? Math.max(acknowledgementMs, diskAcknowledgementMs) : acknowledgementMs,
          pollMs });
      return { deliveryLevel: 'launch-requested', guestHandoffObserved: guestPhase !== null, guestPhase };
    },
  });
}
