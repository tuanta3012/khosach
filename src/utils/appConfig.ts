import pkg from '../../package.json' with { type: 'json' };

export const IS_BUILD_AAB: boolean =
  (pkg as any)?.buildAab !== undefined
    ? Boolean((pkg as any).buildAab)
    : import.meta.env.VITE_BUILD_AAB === 'true' || import.meta.env.VITE_BUILD_AAB === true;

export const IS_AUTO_UPDATE_ENABLED: boolean = !IS_BUILD_AAB;
