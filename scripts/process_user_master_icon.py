import os
import subprocess

def run(cmd):
    print("Executing:", " ".join(cmd))
    subprocess.run(cmd, check=True)

def main():
    src_master = '/tmp/user_master_icon.png'
    if not os.path.exists(src_master):
        src_master = 'public/stk_app_icon.png'

    print(f"Using source master icon: {src_master}")

    # Ensure 1024x1024 master with transparent padding/centering if needed
    normalized_master = '/tmp/master_1024.png'
    # Scale keeping aspect ratio inside 1024x1024 and center on 1024x1024 transparent canvas
    run([
        'convert', src_master,
        '-resize', '1024x1024',
        '-gravity', 'center',
        '-background', 'none',
        '-extent', '1024x1024',
        normalized_master
    ])

    # 1. Update resources/icon.png (Capacitor master 1024x1024)
    os.makedirs('resources', exist_ok=True)
    os.makedirs('resources/android', exist_ok=True)
    run(['cp', normalized_master, 'resources/icon.png'])

    # 2. Update public & src/assets/images
    os.makedirs('public', exist_ok=True)
    os.makedirs('src/assets/images', exist_ok=True)
    run(['convert', normalized_master, '-resize', '512x512', 'public/stk_app_icon.png'])
    run(['cp', 'public/stk_app_icon.png', 'src/assets/images/stk_app_icon.png'])

    # 3. Web Favicons
    run(['convert', normalized_master, '-resize', '64x64', 'public/favicon.png'])
    run(['convert', normalized_master, '-resize', '32x32', 'public/favicon-32x32.png'])
    run(['convert', normalized_master, '-resize', '16x16', 'public/favicon-16x16.png'])

    # 4. Apple Touch Icon (180x180)
    run(['convert', normalized_master, '-resize', '180x180', 'public/apple-touch-icon.png'])

    # 5. PWA Icons (192x192 & 512x512)
    run(['convert', normalized_master, '-resize', '192x192', 'public/pwa-192x192.png'])
    run(['convert', normalized_master, '-resize', '512x512', 'public/pwa-512x512.png'])

    # 6. Splash Screen (2732x2732)
    splash_center = '/tmp/splash_center.png'
    run(['convert', normalized_master, '-resize', '768x768', splash_center])
    run([
        'convert', '-size', '2732x2732', 'xc:#0a1e1b',
        splash_center, '-gravity', 'center', '-composite',
        'resources/splash.png'
    ])

    # 7. Adaptive Icon resources for Capacitor
    adaptive_fg = '/tmp/adaptive_fg_1024.png'
    run(['convert', normalized_master, '-resize', '720x720', splash_center])
    run([
        'convert', '-size', '1024x1024', 'xc:none',
        splash_center, '-gravity', 'center', '-composite',
        'resources/icon-foreground.png'
    ])
    run(['convert', '-size', '1024x1024', 'xc:#06b46f', 'resources/icon-background.png'])
    run(['cp', 'resources/icon-foreground.png', 'resources/android/icon-foreground.png'])
    run(['cp', 'resources/icon-background.png', 'resources/android/icon-background.png'])

    # 8. Android native mipmaps (for APK building via GitHub Actions / Capacitor)
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

        # Standard squircle launcher icon (Android < 8 and square launchers)
        target_icon = os.path.join(dir_path, 'ic_launcher.png')
        run(['convert', normalized_master, '-resize', f'{size}x{size}', target_icon])

        # Round launcher icon (Android 7.1+ round launchers)
        target_round = os.path.join(dir_path, 'ic_launcher_round.png')
        radius = size / 2.0
        run([
            'convert', target_icon,
            '(', '+clone', '-alpha', 'extract',
            '-draw', f'fill black polygon 0,0 0,{size} {size},{size} {size},0 fill white circle {radius},{radius} {radius},0',
            ')', '-alpha', 'off', '-compose', 'CopyOpacity', '-composite',
            target_round
        ])

        # Foreground adaptive icon (Android 8.0+)
        # Standard foreground puts safe content in the center 66.6% circle of 108dp canvas
        fg_icon_size = int(fg_size * 0.72)
        tmp_fg = f'/tmp/fg_{size}.png'
        run(['convert', normalized_master, '-resize', f'{fg_icon_size}x{fg_icon_size}', tmp_fg])
        target_fg = os.path.join(dir_path, 'ic_launcher_foreground.png')
        run([
            'convert', '-size', f'{fg_size}x{fg_size}', 'xc:none',
            tmp_fg, '-gravity', 'center', '-composite',
            target_fg
        ])

    print("ALL ICON SIZES GENERATED SUCCESSFULLY FROM USER ORIGINAL FILE!")

if __name__ == '__main__':
    main()
