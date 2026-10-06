import pkg from '../../package.json' with { type: 'json' };

/**
 * Chế độ đóng gói và phiên bản được cấu hình tập trung trong package.json.
 */
export const IS_BUILD_AAB: boolean = pkg.buildAab;

export const IS_AUTO_UPDATE_ENABLED: boolean = !IS_BUILD_AAB;
