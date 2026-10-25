import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateDeviceRecipe } from '../src/devices/device-recipe.mjs';

const requirements = { video: 'pal', reuCapacityKiB: 512, driveUnits: [] };
const artifacts = [
  { id: 'program', kind: 'prg', length: 123 },
  { id: 'bootstrap', kind: 'prg', length: 350 },
  { id: 'image', kind: 'reu', length: 512 * 1024 },
  { id: 'disk8', kind: 'd64', length: 174848 },
  { id: 'cart', kind: 'crt', length: 8192 },
];
const bootstrap = { artifactId: 'bootstrap', nonce: '01'.repeat(16),
  workspace: { address: 0xc800, length: 0x800 } };

test('composed PRG binds each role to a typed staged artifact', () => {
  const recipe = { kind: 'prg', requirements, program: { artifactId: 'program', entryAddress: 0xc000 },
    reuArtifactId: 'image', bootstrap };
  const staged = artifacts.slice(0, 3);
  assert.equal(validateDeviceRecipe(recipe, staged), recipe);
  assert.throws(() => validateDeviceRecipe({ ...recipe, reuArtifactId: 'disk8' }, staged), /invalid_device_recipe/);
  assert.throws(() => validateDeviceRecipe({ ...recipe, bootstrap: null }, staged), /invalid_device_recipe/);
  assert.throws(() => validateDeviceRecipe({ ...recipe, arbitraryAddress: 0x1000 }, staged), /invalid_device_recipe/);
  assert.throws(() => validateDeviceRecipe(recipe, artifacts), /invalid_device_recipe/, 'unreferenced staged bytes');
});

test('disk recipe requires exact device 8/9 bindings and safe temporary mount modes', () => {
  const recipe = { kind: 'disk-set', requirements: { ...requirements, driveUnits: [8] },
    program: { bootNameHex: '4d5946494c45', entryAddress: 0x1000, unit: 8 },
    reuArtifactId: 'image', bootstrap, mounts: [{ unit: 8, artifactId: 'disk8', mode: 'unlinked' }] };
  const staged = [artifacts[1], artifacts[2], artifacts[3]];
  assert.equal(validateDeviceRecipe(recipe, staged), recipe);
  assert.throws(() => validateDeviceRecipe({ ...recipe, mounts: [{ ...recipe.mounts[0], mode: 'readwrite' }] }, staged), /invalid_device_recipe/);
  assert.throws(() => validateDeviceRecipe({ ...recipe, program: { ...recipe.program, unit: 9 } }, staged), /invalid_device_recipe/);
});

test('standalone CRT profiles are typed; REU coexistence cannot be silently enabled', () => {
  const recipe = { kind: 'cartridge', requirements: { video: 'ntsc', reuCapacityKiB: null, driveUnits: [] },
    program: { artifactId: 'cart', profile: 'easyflash' }, reuArtifactId: null };
  assert.equal(validateDeviceRecipe(recipe, [artifacts[4]]), recipe);
  assert.throws(() => validateDeviceRecipe({ ...recipe, reuArtifactId: 'image' }, artifacts), /invalid_device_recipe/);
});
