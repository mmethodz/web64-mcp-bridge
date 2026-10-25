import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUltimateTarget, isPrivateIPv4 } from '../src/devices/ultimate-target.mjs';

test('production destination policy accepts only private IPv4', async () => {
  for (const value of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.20']) {
    assert.equal(isPrivateIPv4(value), true);
    assert.equal((await createUltimateTarget(value)).pinnedAddress, value);
  }
  for (const value of ['127.0.0.1', '169.254.1.1', '172.15.1.1', '172.32.1.1', '8.8.8.8', '224.0.0.1', '::1']) {
    assert.equal(isPrivateIPv4(value), false);
    await assert.rejects(createUltimateTarget(value));
  }
  for (const value of ['http://192.168.1.1', '192.168.1.1:80', 'device/path', 'evil\r\nHost: x']) {
    await assert.rejects(createUltimateTarget(value));
  }
});

test('hostname resolution pins all private answers and rejects rebinding', async () => {
  let answer = [{ address: '192.168.1.4', family: 4 }];
  const target = await createUltimateTarget('c64u.local', { lookup: async () => answer });
  assert.equal(await target.assertStable(), '192.168.1.4');
  answer = [{ address: '8.8.8.8', family: 4 }];
  await assert.rejects(target.assertStable(), /device_address_not_private/);
  answer = [{ address: '192.168.1.5', family: 4 }];
  await assert.rejects(target.assertStable(), /device_address_changed/);
  await assert.rejects(createUltimateTarget('c64u.local', { lookup: async () => [
    { address: '192.168.1.4', family: 4 }, { address: '8.8.8.8', family: 4 },
  ] }), /device_address_not_private/);
});

test('loopback is restricted to explicit injected laboratory policy', async () => {
  assert.equal((await createUltimateTarget('127.0.0.1', { allowLabLoopback: true })).pinnedAddress, '127.0.0.1');
});
