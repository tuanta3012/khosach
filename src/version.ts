import pkg from '../package.json' with { type: 'json' };

export const CURRENT_APP_VERSION: string = pkg.version;
