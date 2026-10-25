import { lookup as defaultLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export function isPrivateIPv4(value) {
  if (isIP(value) !== 4) return false;
  const [a, b] = value.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function validHost(value) {
  return typeof value === 'string' && value.length <= 253 &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value) &&
    !value.includes('..') && !value.endsWith('.');
}

export async function createUltimateTarget(host, { lookup = defaultLookup, allowLabLoopback = false } = {}) {
  if (!validHost(host) || (isIP(host) && isIP(host) !== 4)) throw new Error('invalid_device_address');
  const permitted = address => isPrivateIPv4(address) || (allowLabLoopback && address === '127.0.0.1');
  const resolve = async () => {
    const answers = isIP(host) === 4 ? [{ address: host, family: 4 }] : await lookup(host, { all: true, verbatim: true });
    if (!Array.isArray(answers) || answers.length === 0 || answers.some(row => row.family !== 4 || !permitted(row.address))) {
      throw new Error('device_address_not_private');
    }
    return [...new Set(answers.map(row => row.address))].sort();
  };
  const addresses = await resolve();
  const pinnedAddress = addresses[0];
  return Object.freeze({
    host,
    pinnedAddress,
    async assertStable() {
      const current = await resolve();
      if (current.length !== addresses.length || current.some((address, index) => address !== addresses[index])) {
        throw new Error('device_address_changed');
      }
      return pinnedAddress;
    },
  });
}
