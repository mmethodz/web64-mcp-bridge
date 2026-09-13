import manifest from '../package.json' with { type: 'json' };

export const BRIDGE_VERSION = manifest.version;
