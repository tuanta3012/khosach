import pkg from '../package.json';
import buildSettings from '../build_settings.json';

export const CURRENT_APP_VERSION = buildSettings?.version || pkg.version || '1.0.0';
