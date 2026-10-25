const REU_CAPACITIES = new Set([128, 256, 512, 1024, 2048, 4096, 8192, 16384]);

function categoryBody(response, category) {
  const body = response?.[category];
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('device_config_unknown');
  return body;
}

// The REST API returns enum settings as their raw option text. CPU Speed
// options are " 1", " 2", ... "64" (the " MHz" suffix exists only in the menu's
// display format), so accept both the raw value and a formatted "1 MHz".
function cpuSpeedMHz(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d+)(?:\s*mhz)?$/i.exec(value.trim());
  return match ? Number(match[1]) : null;
}

// With Turbo Control "Off" (the firmware default) the firmware disables the
// CPU Speed item and runs the 6510 at the standard clock, whatever it says.
function turboOff(value) {
  return typeof value === 'string' && value.trim().toLowerCase() === 'off';
}

function reuSizeKiB(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d+)\s*(KB|MB)$/i.exec(value.trim());
  if (!match) return null;
  const size = Number(match[1]) * (match[2].toUpperCase() === 'MB' ? 1024 : 1);
  return REU_CAPACITIES.has(size) ? size : null;
}

const KNOWN_DRIVE_SLOTS = new Set(['a', 'b', 'softiec']);

// Firmware lists physical drives a/b plus software IEC targets. Newer firmware
// may add further IEC entries; an unknown, well-formed entry still occupies its
// bus ID (so a clash with unit 8/9 is reported), while an unknown entry without
// a readable bus ID is ignored instead of blocking every launch.
function driveMapping(response, requestedUnits) {
  if (!Array.isArray(response?.drives)) throw new Error('device_drives_unknown');
  const used = new Map();
  for (const item of response.drives) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('device_drives_unknown');
    for (const [slot, drive] of Object.entries(item)) {
      const readable = Boolean(drive) && typeof drive === 'object' && !Array.isArray(drive) &&
        typeof drive.enabled === 'boolean' && Number.isInteger(drive.bus_id);
      if (!readable) {
        if (KNOWN_DRIVE_SLOTS.has(slot)) throw new Error('device_drives_unknown');
        continue;
      }
      if (!drive.enabled) continue;
      const occupants = used.get(drive.bus_id) || [];
      occupants.push(slot);
      used.set(drive.bus_id, occupants);
    }
  }
  const mapping = {};
  const issues = [];
  for (const unit of requestedUnits) {
    const slots = used.get(unit) || [];
    if (slots.length !== 1 || !['a', 'b'].includes(slots[0])) {
      issues.push({ code: 'drive_mapping', unit, detail: slots.length ? slots.join(',') : 'missing' });
    } else mapping[unit] = slots[0];
  }
  return { mapping, issues };
}

export function validateUltimateRequirements(requirements) {
  if (!requirements || typeof requirements !== 'object' || Array.isArray(requirements) ||
      !['pal', 'ntsc'].includes(requirements.video) ||
      !Array.isArray(requirements.driveUnits) || requirements.driveUnits.length > 2 ||
      new Set(requirements.driveUnits).size !== requirements.driveUnits.length ||
      requirements.driveUnits.some(unit => ![8, 9].includes(unit)) ||
      !(requirements.reuCapacityKiB === null || REU_CAPACITIES.has(requirements.reuCapacityKiB)) ||
      Object.keys(requirements).sort().join(',') !== 'driveUnits,reuCapacityKiB,video') {
    throw new Error('invalid_device_requirements');
  }
  return requirements;
}

export async function readUltimatePreflight(http, requirements) {
  validateUltimateRequirements(requirements);
  const [version, info, categories, drives] = await Promise.all([
    http.getVersion(), http.getInfo(), http.getConfigs(), http.getDrives(),
  ]);
  if (typeof version?.version !== 'string' || !version.version ||
      typeof info?.product !== 'string' || !info.product ||
      typeof info?.firmware_version !== 'string' || !info.firmware_version) {
    throw new Error('device_identity_unknown');
  }
  if (!Array.isArray(categories?.categories) ||
      !categories.categories.includes('U64 Specific Settings') ||
      !categories.categories.includes('C64 and Cartridge Settings')) {
    throw new Error('device_config_unknown');
  }
  const [u64Response, cartridgeResponse] = await Promise.all([
    http.getConfigCategory('U64 Specific Settings'),
    http.getConfigCategory('C64 and Cartridge Settings'),
  ]);
  const u64 = categoryBody(u64Response, 'U64 Specific Settings');
  const cartridge = categoryBody(cartridgeResponse, 'C64 and Cartridge Settings');
  const video = u64['System Mode'];
  const cpu = u64['CPU Speed'];
  const turbo = u64['Turbo Control'];
  const reuEnabled = cartridge['RAM Expansion Unit'];
  const reuCapacityKiB = reuSizeKiB(cartridge['REU Size']);
  const issues = [];
  if (typeof video !== 'string' || video.toLowerCase() !== requirements.video) {
    issues.push({ code: 'video_mismatch', required: requirements.video, actual: video ?? null });
  }
  if (!turboOff(turbo) && cpuSpeedMHz(cpu) !== 1) {
    issues.push({ code: 'cpu_not_standard', required: '1 MHz or Turbo Control Off',
      actual: cpu ?? null, turboControl: turbo ?? null });
  }
  if (requirements.reuCapacityKiB !== null &&
      (reuEnabled !== 'Enabled' || reuCapacityKiB === null || reuCapacityKiB < requirements.reuCapacityKiB)) {
    issues.push({ code: 'reu_mismatch', requiredKiB: requirements.reuCapacityKiB,
      enabled: reuEnabled ?? null, actualKiB: reuCapacityKiB });
  }
  const { mapping, issues: driveIssues } = driveMapping(drives, requirements.driveUnits);
  issues.push(...driveIssues);
  return { ready: issues.length === 0, issues, identity: {
    product: info?.product ?? null, firmwareVersion: info?.firmware_version ?? null,
    apiVersion: version?.version ?? null,
  }, actual: { video, cpu, turbo: turbo ?? null, reuEnabled, reuCapacityKiB }, driveMapping: mapping };
}
