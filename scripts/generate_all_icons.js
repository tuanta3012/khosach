import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

async function generateAllIcons() {
  console.log('[Icon Resizer] Bắt đầu kết xuất và đổi kích thước icon chuẩn xác 100% từ app_icon.png...');

  const srcIconPath = path.resolve('app_icon.png');
  if (!fs.existsSync(srcIconPath)) {
    console.error('LỖI: Không tìm thấy file app_icon.png tại thư mục gốc!');
    process.exit(1);
  }

  // 1. Tạo các thư mục đích
  const dirs = [
    'public',
    'src/assets/images',
    'resources/android',
    'android/app/src/main/res/values',
    'android/app/src/main/res/mipmap-mdpi',
    'android/app/src/main/res/mipmap-hdpi',
    'android/app/src/main/res/mipmap-xhdpi',
    'android/app/src/main/res/mipmap-xxhdpi',
    'android/app/src/main/res/mipmap-xxxhdpi',
  ];

  dirs.forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });

  // Cập nhật background color XML cho Android thành màu trắng (#FFFFFF)
  const backgroundXmlPath = 'android/app/src/main/res/values/ic_launcher_background.xml';
  const backgroundXmlContent = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#FFFFFF</color>
</resources>
`;
  fs.writeFileSync(backgroundXmlPath, backgroundXmlContent);
  console.log(' -> Đã cập nhật ic_launcher_background.xml thành #FFFFFF');

  // 2. Render master 1024x1024 PNG
  const master1024Buffer = await sharp(srcIconPath)
    .resize(1024, 1024, { kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer();

  fs.writeFileSync('resources/icon.png', master1024Buffer);
  fs.writeFileSync('resources/icon-foreground.png', master1024Buffer);
  fs.writeFileSync('resources/android/icon-foreground.png', master1024Buffer);
  console.log(' -> Đã tạo resources/icon.png, resources/icon-foreground.png');

  // Background 1024x1024 chuẩn màu nền #FFFFFF (trắng)
  const bg1024Buffer = await sharp({
    create: {
      width: 1024,
      height: 1024,
      channels: 4,
      background: '#FFFFFF',
    },
  })
    .png()
    .toBuffer();

  fs.writeFileSync('resources/icon-background.png', bg1024Buffer);
  fs.writeFileSync('resources/android/icon-background.png', bg1024Buffer);
  console.log(' -> Đã tạo resources/icon-background.png');

  // 3. Render Public Web & App Logo Assets (Chỉ thay đổi kích thước bằng Lanczos3 từ app_icon.png)
  const webSizes = [
    { file: 'public/stk_app_icon.png', size: 512 },
    { file: 'src/assets/images/stk_app_icon.png', size: 512 },
    { file: 'public/favicon.png', size: 64 },
    { file: 'public/favicon-32x32.png', size: 32 },
    { file: 'public/apple-touch-icon.png', size: 180 },
    { file: 'public/pwa-192x192.png', size: 192 },
    { file: 'public/pwa-512x512.png', size: 512 },
  ];

  for (const item of webSizes) {
    await sharp(srcIconPath)
      .resize(item.size, item.size, { kernel: sharp.kernel.lanczos3 })
      .png()
      .toFile(item.file);
    console.log(` -> Đã tạo ${item.file} (${item.size}x${item.size})`);
  }

  // 4. Render Splash Screen 2732x2732 (Màu nền trắng #FFFFFF đồng bộ)
  const logo800 = await sharp(srcIconPath)
    .resize(800, 800, { kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer();

  await sharp({
    create: {
      width: 2732,
      height: 2732,
      channels: 4,
      background: '#FFFFFF',
    },
  })
    .composite([{ input: logo800, gravity: 'center' }])
    .png()
    .toFile('resources/splash.png');
  console.log(' -> Đã tạo resources/splash.png (2732x2732) với màu nền trắng');

  // 5. Render Android Mipmap densities
  const densities = [
    { folder: 'mipmap-mdpi', size: 48, fgSize: 108 },
    { folder: 'mipmap-hdpi', size: 72, fgSize: 162 },
    { folder: 'mipmap-xhdpi', size: 96, fgSize: 216 },
    { folder: 'mipmap-xxhdpi', size: 144, fgSize: 324 },
    { folder: 'mipmap-xxxhdpi', size: 192, fgSize: 432 },
  ];

  const baseRes = 'android/app/src/main/res';
  for (const d of densities) {
    const dirPath = path.join(baseRes, d.folder);

    // Standard square icon
    await sharp(srcIconPath)
      .resize(d.size, d.size, { kernel: sharp.kernel.lanczos3 })
      .png()
      .toFile(path.join(dirPath, 'ic_launcher.png'));

    // Round icon
    await sharp(srcIconPath)
      .resize(d.size, d.size, { kernel: sharp.kernel.lanczos3 })
      .png()
      .toFile(path.join(dirPath, 'ic_launcher_round.png'));

    // Adaptive Foreground (scaled 72% centered)
    const scaledFg = await sharp(srcIconPath)
      .resize(Math.round(d.fgSize * 0.72), Math.round(d.fgSize * 0.72), { kernel: sharp.kernel.lanczos3 })
      .png()
      .toBuffer();

    await sharp({
      create: {
        width: d.fgSize,
        height: d.fgSize,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([{ input: scaledFg, gravity: 'center' }])
      .png()
      .toFile(path.join(dirPath, 'ic_launcher_foreground.png'));

    console.log(` -> Đã tạo Android Mipmap cho ${d.folder}`);
  }

  console.log('HOÀN TẤT: Toàn bộ icon, logo, favicon, splash screen và Android mipmaps đã được cập nhật thành công từ app_icon.png!');
}

generateAllIcons().catch((err) => {
  console.error('Lỗi sinh icon:', err);
  process.exit(1);
});
