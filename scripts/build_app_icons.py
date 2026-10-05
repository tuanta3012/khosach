#!/usr/bin/env python3
import os
import subprocess

def run(cmd):
    print("Running:", " ".join(cmd[:6]), "...")
    subprocess.run(cmd, check=True)

def main():
    os.makedirs('public', exist_ok=True)
    os.makedirs('resources/android', exist_ok=True)
    os.makedirs('src/assets/images', exist_ok=True)

    master_png = 'resources/icon.png'

    # Master 1024x1024 app icon matching ks_app_icon1.png
    draw_cmds = [
        'convert', '-size', '1024x1024', 'xc:white',
        '-stroke', '#192538', '-strokewidth', '14',

        # Bookmark 1 (Pink)
        '-fill', '#f43f8e', '-draw', 'roundrectangle 195,160,237,230,6,6',
        # Book 1 (Wine Maroon)
        '-fill', '#88284c', '-draw', 'roundrectangle 148,220,276,800,32,32',
        '-strokewidth', '6', '-stroke', 'rgba(255,255,255,0.25)',
        '-draw', 'line 170,265 254,265',
        '-draw', 'line 170,650 254,650',
        '-strokewidth', '4', '-stroke', '#88284c', '-fill', '#fdf2f8',
        '-draw', 'roundrectangle 168,688,256,772,20,20',

        # Bookmark 2 (Purple)
        '-strokewidth', '14', '-stroke', '#192538',
        '-fill', '#a855f7', '-draw', 'roundrectangle 345,240,387,310,6,6',
        # Book 2 (Royal Violet)
        '-fill', '#653f96', '-draw', 'roundrectangle 300,300,420,800,32,32',
        '-strokewidth', '6', '-stroke', 'rgba(255,255,255,0.25)',
        '-draw', 'line 322,345 398,345',
        '-draw', 'line 322,650 398,650',
        '-strokewidth', '4', '-stroke', '#653f96', '-fill', '#faf5ff',
        '-draw', 'roundrectangle 320,688,400,772,20,20',

        # Bookmark 3 (Cyan / Center - Tallest)
        '-strokewidth', '14', '-stroke', '#192538',
        '-fill', '#0284c7', '-draw', 'roundrectangle 495,100,537,170,6,6',
        # Book 3 (Pine Teal)
        '-fill', '#1b6b5b', '-draw', 'roundrectangle 448,160,576,800,34,34',
        '-strokewidth', '6', '-stroke', 'rgba(255,255,255,0.25)',
        '-draw', 'line 470,205 554,205',
        '-draw', 'line 470,650 554,650',
        '-strokewidth', '4', '-stroke', '#1b6b5b', '-fill', '#f0fdfa',
        '-draw', 'roundrectangle 468,688,556,772,20,20',

        # Bookmark 4 (Golden Amber - Shortest)
        '-strokewidth', '14', '-stroke', '#192538',
        '-fill', '#f59e0b', '-draw', 'roundrectangle 645,280,687,350,6,6',
        # Book 4 (Sienna Amber)
        '-fill', '#9e5628', '-draw', 'roundrectangle 602,340,720,800,32,32',
        '-strokewidth', '6', '-stroke', 'rgba(255,255,255,0.25)',
        '-draw', 'line 624,385 698,385',
        '-draw', 'line 624,650 698,650',
        '-strokewidth', '4', '-stroke', '#9e5628', '-fill', '#fffbeb',
        '-draw', 'roundrectangle 622,688,700,772,20,20',

        # Bookmark 5 (Blue)
        '-strokewidth', '14', '-stroke', '#192538',
        '-fill', '#6366f1', '-draw', 'roundrectangle 795,200,837,270,6,6',
        # Book 5 (Denim Navy)
        '-fill', '#295588', '-draw', 'roundrectangle 748,260,876,800,34,34',
        '-strokewidth', '6', '-stroke', 'rgba(255,255,255,0.25)',
        '-draw', 'line 770,305 854,305',
        '-draw', 'line 770,650 854,650',
        '-strokewidth', '4', '-stroke', '#295588', '-fill', '#eff6ff',
        '-draw', 'roundrectangle 768,688,856,772,20,20',

        # Shelf Base (Honey Gold Wood)
        '-strokewidth', '14', '-stroke', '#192538',
        '-fill', '#f0be40', '-draw', 'roundrectangle 92,795,932,862,26,26',
        '-fill', '#d99b1c', '-draw', 'roundrectangle 96,860,928,895,14,14',

        master_png
    ]

    run(draw_cmds)

    # 2. Public assets
    run(['convert', master_png, '-resize', '512x512', 'public/stk_app_icon.png'])
    run(['convert', master_png, '-resize', '512x512', 'src/assets/images/stk_app_icon.png'])
    run(['convert', master_png, '-resize', '64x64', 'public/favicon.png'])
    run(['convert', master_png, '-resize', '32x32', 'public/favicon-32x32.png'])
    run(['convert', master_png, '-resize', '180x180', 'public/apple-touch-icon.png'])
    run(['convert', master_png, '-resize', '192x192', 'public/pwa-192x192.png'])
    run(['convert', master_png, '-resize', '512x512', 'public/pwa-512x512.png'])

    # 3. Splash Screen (2732x2732) with Warm Sienna Espresso background (#2b170e)
    run([
        'convert', '-size', '2732x2732', 'xc:#2b170e',
        '(', master_png, '-resize', '800x800', ')',
        '-gravity', 'center', '-composite',
        'resources/splash.png'
    ])

    # 4. Foreground & Background for adaptive icons
    run(['convert', master_png, '-resize', '1024x1024', 'resources/icon-foreground.png'])
    run(['convert', '-size', '1024x1024', 'xc:#2b170e', 'resources/icon-background.png'])
    run(['cp', 'resources/icon-foreground.png', 'resources/android/icon-foreground.png'])
    run(['cp', 'resources/icon-background.png', 'resources/android/icon-background.png'])

    # 5. Android mipmap densities
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
        run(['convert', master_png, '-resize', f'{size}x{size}', os.path.join(dir_path, 'ic_launcher.png')])
        run(['convert', master_png, '-resize', f'{size}x{size}', os.path.join(dir_path, 'ic_launcher_round.png')])
        run([
            'convert', '-size', f'{fg_size}x{fg_size}', 'xc:none',
            '(', master_png, '-resize', f'{int(fg_size * 0.72)}x{int(fg_size * 0.72)}', ')',
            '-gravity', 'center', '-composite',
            os.path.join(dir_path, 'ic_launcher_foreground.png')
        ])

    print("SUCCESS: All app icons and Android mipmaps built from ks_app_icon1.png!")

if __name__ == '__main__':
    main()
