import os
import subprocess

def run(cmd):
    try:
        subprocess.run(cmd, check=True)
    except Exception as e:
        print("Error running", cmd, e)

def main():
    master_png = 'public/stk_app_icon.png'
    if not os.path.exists(master_png):
        print("Master icon not found:", master_png)
        return

    os.makedirs('resources/android', exist_ok=True)
    os.makedirs('public', exist_ok=True)
    os.makedirs('src/assets/images', exist_ok=True)

    # 1. Copy to resources and src
    run(['cp', master_png, 'resources/icon.png'])
    run(['cp', master_png, 'src/assets/images/stk_app_icon.png'])

    # 2. Favicon sizes
    run(['convert', master_png, '-resize', '64x64', 'public/favicon.png'])
    run(['convert', master_png, '-resize', '32x32', 'public/favicon-32x32.png'])
    run(['convert', master_png, '-resize', '16x16', 'public/favicon-16x16.png'])

    # 3. Apple Touch Icon (180x180)
    run(['convert', master_png, '-resize', '180x180', 'public/apple-touch-icon.png'])

    # 4. PWA Icons (192x192 & 512x512)
    run(['convert', master_png, '-resize', '192x192', 'public/pwa-192x192.png'])
    run(['convert', master_png, '-resize', '512x512', 'public/pwa-512x512.png'])

    # 5. Splash Screen (2732x2732)
    splash_icon = '/tmp/splash_logo_768.png'
    run(['convert', master_png, '-resize', '768x768', splash_icon])
    run([
        'convert', '-size', '2732x2732', 'xc:#0f172a',
        splash_icon, '-gravity', 'center', '-composite',
        'resources/splash.png'
    ])

    # 6. Adaptive Icons
    run(['convert', master_png, '-resize', '1024x1024', 'resources/icon-foreground.png'])
    run(['convert', '-size', '1024x1024', 'xc:#06b46f', 'resources/icon-background.png'])
    run(['cp', 'resources/icon-foreground.png', 'resources/android/icon-foreground.png'])
    run(['cp', 'resources/icon-background.png', 'resources/android/icon-background.png'])

    # 7. Android Mipmaps
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
        # ic_launcher_round.png
        run([
            'convert', os.path.join(dir_path, 'ic_launcher.png'),
            '(', '+clone', '-alpha', 'extract',
            '-draw', f'fill black polygon 0,0 0,{size} {size},{size} {size},0 fill white circle {size/2},{size/2} {size/2},0',
            ')', '-alpha', 'off', '-compose', 'CopyOpacity', '-composite',
            os.path.join(dir_path, 'ic_launcher_round.png')
        ])
        # ic_launcher_foreground.png
        fg_scaled = int(fg_size * 0.72)
        tmp_fg = f'/tmp/fg_{size}.png'
        run(['convert', master_png, '-resize', f'{fg_scaled}x{fg_scaled}', tmp_fg])
        run([
            'convert', '-size', f'{fg_size}x{fg_size}', 'xc:none',
            tmp_fg, '-gravity', 'center', '-composite',
            os.path.join(dir_path, 'ic_launcher_foreground.png')
        ])

    print("Successfully rendered all app icons from master PNG!")

if __name__ == '__main__':
    main()
