import os
import subprocess

def run(cmd):
    print("Running:", " ".join(cmd))
    subprocess.run(cmd, check=True)

def main():
    svg_file = 'public/stk_app_icon.svg'
    master_png = 'resources/icon.png'
    os.makedirs('resources/android', exist_ok=True)
    os.makedirs('public', exist_ok=True)
    os.makedirs('src/assets/images', exist_ok=True)

    # 1. Master PNG (1024x1024)
    run(['rsvg-convert', '-w', '1024', '-h', '1024', svg_file, '-o', master_png])

    # 2. stk_app_icon.png (512x512)
    run(['rsvg-convert', '-w', '512', '-h', '512', svg_file, '-o', 'public/stk_app_icon.png'])
    run(['cp', 'public/stk_app_icon.png', 'src/assets/images/stk_app_icon.png'])

    # 3. Favicon sizes
    run(['rsvg-convert', '-w', '64', '-h', '64', svg_file, '-o', 'public/favicon.png'])
    run(['rsvg-convert', '-w', '32', '-h', '32', svg_file, '-o', 'public/favicon-32x32.png'])
    run(['rsvg-convert', '-w', '16', '-h', '16', svg_file, '-o', 'public/favicon-16x16.png'])

    # 4. Apple Touch Icon (180x180)
    run(['rsvg-convert', '-w', '180', '-h', '180', svg_file, '-o', 'public/apple-touch-icon.png'])

    # 5. PWA Icons (192x192 & 512x512)
    run(['rsvg-convert', '-w', '192', '-h', '192', svg_file, '-o', 'public/pwa-192x192.png'])
    run(['rsvg-convert', '-w', '512', '-h', '512', svg_file, '-o', 'public/pwa-512x512.png'])

    # 6. Splash Screen (2732x2732)
    splash_icon = '/tmp/splash_logo_768.png'
    run(['rsvg-convert', '-w', '768', '-h', '768', svg_file, '-o', splash_icon])
    run([
        'convert', '-size', '2732x2732', 'xc:#0f172a',
        splash_icon, '-gravity', 'center', '-composite',
        'resources/splash.png'
    ])

    # 7. Adaptive Icons (Foreground & Background)
    run(['rsvg-convert', '-w', '1024', '-h', '1024', svg_file, '-o', 'resources/icon-foreground.png'])
    run(['convert', '-size', '1024x1024', 'xc:#06b46f', 'resources/icon-background.png'])
    run(['cp', 'resources/icon-foreground.png', 'resources/android/icon-foreground.png'])
    run(['cp', 'resources/icon-background.png', 'resources/android/icon-background.png'])

    # 8. Android Mipmaps
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
        run(['rsvg-convert', '-w', str(size), '-h', str(size), svg_file, '-o', os.path.join(dir_path, 'ic_launcher.png')])
        # ic_launcher_round.png
        run([
            'convert', os.path.join(dir_path, 'ic_launcher.png'),
            '(', '+clone', '-alpha', 'extract',
            '-draw', f'fill black polygon 0,0 0,{size} {size},{size} {size},0 fill white circle {size/2},{size/2} {size/2},0',
            ')', '-alpha', 'off', '-compose', 'CopyOpacity', '-composite',
            os.path.join(dir_path, 'ic_launcher_round.png')
        ])
        # ic_launcher_foreground.png (safe zone centered)
        fg_scaled = int(fg_size * 0.72)
        tmp_fg = f'/tmp/fg_{size}.png'
        run(['rsvg-convert', '-w', str(fg_scaled), '-h', str(fg_scaled), svg_file, '-o', tmp_fg])
        run([
            'convert', '-size', f'{fg_size}x{fg_size}', 'xc:none',
            tmp_fg, '-gravity', 'center', '-composite',
            os.path.join(dir_path, 'ic_launcher_foreground.png')
        ])

    print("SUCCESS: All assets generated accurately from SVG!")

if __name__ == '__main__':
    main()
