import os
import subprocess

def run(cmd):
    print("Running:", " ".join(cmd))
    subprocess.run(cmd, check=True)

def main():
    src_img = 'src/assets/images/app_icon_1790218034410.jpg'
    os.makedirs('public', exist_ok=True)
    os.makedirs('resources/android', exist_ok=True)

    # 1. Generate master PNG from JPG (1024x1024)
    master_png = 'resources/icon.png'
    run(['convert', src_img, master_png])
    
    # 2. stk_app_icon.png in public (512x512) and src/assets/images
    run(['convert', master_png, '-resize', '512x512', 'public/stk_app_icon.png'])
    run(['convert', master_png, '-resize', '512x512', 'src/assets/images/stk_app_icon.png'])

    # 3. Web favicon (64x64 & 32x32)
    run(['convert', master_png, '-resize', '64x64', 'public/favicon.png'])
    run(['convert', master_png, '-resize', '32x32', 'public/favicon-32x32.png'])
    run(['convert', master_png, '-resize', '16x16', 'public/favicon-16x16.png'])

    # 4. Apple Touch Icon (180x180)
    run(['convert', master_png, '-resize', '180x180', 'public/apple-touch-icon.png'])

    # 5. PWA icons
    run(['convert', master_png, '-resize', '192x192', 'public/pwa-192x192.png'])
    run(['convert', master_png, '-resize', '512x512', 'public/pwa-512x512.png'])

    # 6. Splash screen (2732x2732) with dark slate background (#0f172a) and centered logo
    run([
        'convert', '-size', '2732x2732', 'xc:#0f172a',
        '(', master_png, '-resize', '768x768', ')',
        '-gravity', 'center', '-composite',
        'resources/splash.png'
    ])

    # 7. Foreground & Background for Adaptive icons
    run(['convert', master_png, '-resize', '1024x1024', 'resources/icon-foreground.png'])
    run(['convert', '-size', '1024x1024', 'xc:#06b46f', 'resources/icon-background.png'])
    run(['cp', 'resources/icon-foreground.png', 'resources/android/icon-foreground.png'])
    run(['cp', 'resources/icon-background.png', 'resources/android/icon-background.png'])

    # 8. Android mipmap directories
    densities = {
        'mipmap-mdpi': (48, 108),
        'mipmap-hdpi': (72, 162),
        'mipmap-xhdpi': (96, 216),
        'mipmap-xxhdpi': (144, 324),
        'mipmap-xxxhdpi': (192, 432),
    }

    base_res = 'android/app/src/main/res'
    for folder, (size, fg_size) in densities.items():
        dir_path = os.path.join(base_res, folder)
        os.makedirs(dir_path, exist_ok=True)
        # ic_launcher.png
        run(['convert', master_png, '-resize', f'{size}x{size}', os.path.join(dir_path, 'ic_launcher.png')])
        # ic_launcher_round.png (with circle mask)
        run([
            'convert', master_png, '-resize', f'{size}x{size}',
            '(', '+clone', '-alpha', 'extract',
            '-draw', f'fill black polygon 0,0 0,{size} {size},{size} {size},0 fill white circle {size/2},{size/2} {size/2},0',
            ')', '-alpha', 'off', '-compose', 'CopyOpacity', '-composite',
            os.path.join(dir_path, 'ic_launcher_round.png')
        ])
        # ic_launcher_foreground.png (for adaptive icon)
        # In adaptive icon (108dp), safe zone is center 66dp or 72dp
        run([
            'convert', '-size', f'{fg_size}x{fg_size}', 'xc:none',
            '(', master_png, '-resize', f'{int(fg_size * 0.72)}x{int(fg_size * 0.72)}', ')',
            '-gravity', 'center', '-composite',
            os.path.join(dir_path, 'ic_launcher_foreground.png')
        ])

    # 9. Adaptive icon xml for Android 8+ (mipmap-anydpi-v26)
    v26_dir = os.path.join(base_res, 'mipmap-anydpi-v26')
    os.makedirs(v26_dir, exist_ok=True)
    
    launcher_xml = '''<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
'''
    with open(os.path.join(v26_dir, 'ic_launcher.xml'), 'w') as f:
        f.write(launcher_xml)
    with open(os.path.join(v26_dir, 'ic_launcher_round.xml'), 'w') as f:
        f.write(launcher_xml)

    # 10. Color values for background
    values_dir = os.path.join(base_res, 'values')
    os.makedirs(values_dir, exist_ok=True)
    colors_xml = '''<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#06B46F</color>
</resources>
'''
    with open(os.path.join(values_dir, 'ic_launcher_background.xml'), 'w') as f:
        f.write(colors_xml)

    print("All app icons successfully generated!")

if __name__ == '__main__':
    main()
