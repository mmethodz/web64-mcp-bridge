import { validateUltimateRequirements } from './ultimate-preflight.mjs';

const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const NONCE = /^[a-f0-9]{32}$/;
const PROFILES = new Set(['standard-8k', 'standard-16k', 'magic-desk', 'easyflash']);
const keys = value => Object.keys(value).sort().join(',');
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const fail = () => { throw new Error('invalid_device_recipe'); };

function artifact(byId, id, kind) {
  if (!ID.test(id) || byId.get(id)?.kind !== kind) fail();
  return byId.get(id);
}

function bootstrap(recipe, byId) {
  const boot = recipe.bootstrap;
  if (!object(boot) || keys(boot) !== 'artifactId,nonce,workspace' || !NONCE.test(boot.nonce) ||
      !object(boot.workspace) || keys(boot.workspace) !== 'address,length') fail();
  artifact(byId, boot.artifactId, 'prg');
  const { address, length } = boot.workspace;
  if (!Number.isInteger(address) || !Number.isInteger(length) || length < 192 ||
      address < 0x0200 || address + length > 0xd000 ||
      (address < 0xc000 && address + length > 0xa000)) fail();
}

function reu(recipe, byId) {
  if (recipe.reuArtifactId === null) {
    if (recipe.requirements.reuCapacityKiB !== null) fail();
    return;
  }
  const image = artifact(byId, recipe.reuArtifactId, 'reu');
  if (recipe.requirements.reuCapacityKiB * 1024 !== image.length) fail();
}

export function validateDeviceRecipe(recipe, artifacts, { allowLab = false } = {}) {
  if (!object(recipe) || !Array.isArray(artifacts)) fail();
  if (allowLab && recipe.kind === 'lab' && keys(recipe) === 'kind') return recipe;
  const byId = new Map(artifacts.map(item => [item.id, item]));
  const used = new Set();
  const use = (id, kind) => { const result = artifact(byId, id, kind); used.add(id); return result; };
  validateUltimateRequirements(recipe.requirements);
  if (recipe.kind === 'prg') {
    if (keys(recipe) !== 'bootstrap,kind,program,requirements,reuArtifactId' ||
        !object(recipe.program) || keys(recipe.program) !== 'artifactId,entryAddress') fail();
    use(recipe.program.artifactId, 'prg');
    reu(recipe, byId);
    if (recipe.reuArtifactId !== null) used.add(recipe.reuArtifactId);
    if (recipe.bootstrap === null) {
      if (recipe.reuArtifactId !== null || recipe.program.entryAddress !== null) fail();
    } else {
      bootstrap(recipe, byId);
      used.add(recipe.bootstrap.artifactId);
      if (!Number.isInteger(recipe.program.entryAddress) || recipe.program.entryAddress < 0x0200 ||
          recipe.program.entryAddress > 0xffff || recipe.program.artifactId === recipe.bootstrap.artifactId) fail();
    }
    if (recipe.requirements.driveUnits.length) fail();
  } else if (recipe.kind === 'disk-set') {
    if (keys(recipe) !== 'bootstrap,kind,mounts,program,requirements,reuArtifactId' ||
        !object(recipe.program) || keys(recipe.program) !== 'bootNameHex,entryAddress,unit' ||
        !/^(?:[a-f0-9]{2}){1,16}$/.test(recipe.program.bootNameHex) ||
        ![8, 9].includes(recipe.program.unit) || !Number.isInteger(recipe.program.entryAddress) ||
        recipe.program.entryAddress < 0x0200 || recipe.program.entryAddress > 0xffff ||
        !Array.isArray(recipe.mounts) || recipe.mounts.length < 1 || recipe.mounts.length > 2) fail();
    bootstrap(recipe, byId);
    used.add(recipe.bootstrap.artifactId);
    reu(recipe, byId);
    if (recipe.reuArtifactId !== null) used.add(recipe.reuArtifactId);
    const units = new Set();
    for (const mount of recipe.mounts) {
      if (!object(mount) || keys(mount) !== 'artifactId,mode,unit' ||
          ![8, 9].includes(mount.unit) || units.has(mount.unit) ||
          !['unlinked', 'readonly'].includes(mount.mode)) fail();
      artifact(byId, mount.artifactId, 'd64');
      used.add(mount.artifactId);
      units.add(mount.unit);
    }
    if (!units.has(recipe.program.unit) ||
        recipe.requirements.driveUnits.length !== units.size ||
        recipe.requirements.driveUnits.some(unit => !units.has(unit))) fail();
  } else if (recipe.kind === 'cartridge') {
    if (keys(recipe) !== 'kind,program,requirements,reuArtifactId' ||
        !object(recipe.program) || keys(recipe.program) !== 'artifactId,profile' ||
        !PROFILES.has(recipe.program.profile) || recipe.reuArtifactId !== null ||
        recipe.requirements.reuCapacityKiB !== null || recipe.requirements.driveUnits.length) fail();
    use(recipe.program.artifactId, 'crt');
  } else fail();
  if (used.size !== byId.size) fail();
  return recipe;
}
