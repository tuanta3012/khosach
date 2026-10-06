import pkg from '../../package.json';
import buildSettings from '../../build_settings.json';

/**
 * Cấu hình chế độ xuất bản ứng dụng:
 * - IS_BUILD_AAB = true (Bản AAB cho Google Play Store):
 *     Vô hiệu hóa và dọn sạch toàn bộ tính năng Auto Update / Sideloading APK
 *     để tuân thủ nghiêm ngặt chính sách của Google Play Developer Policy.
 * - IS_BUILD_AAB = false (Bản APK cho GitHub Release):
 *     Bật đầy đủ cơ chế tự động kiểm tra phiên bản mới và tải APK cập nhật.
 */
export const IS_BUILD_AAB: boolean =
  buildSettings?.buildAab !== undefined
    ? Boolean(buildSettings.buildAab)
    : (pkg as any)?.buildAab !== undefined
    ? Boolean((pkg as any).buildAab)
    : import.meta.env.VITE_BUILD_AAB === 'true' || import.meta.env.VITE_BUILD_AAB === true;

export const IS_AUTO_UPDATE_ENABLED: boolean = !IS_BUILD_AAB;
