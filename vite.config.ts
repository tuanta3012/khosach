import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

import fs from 'fs';
import { exec } from 'child_process';

export default defineConfig(() => {
  // Build-time obfuscation of GEMINI_API_KEY to package inside standalone client APK
  const plainKey = process.env.GEMINI_API_KEY || 'AQ.Ab8RN6L9FYLan3H46BD2LwEv6eVyuVy_xWSyEGRB-QOOR8o_Dg';
  const OBFUSCATION_SALT = "kho-sach-secure-salt-2026";
  let obfuscatedKey = '';

  if (plainKey) {
    let scrambled = "";
    for (let i = 0; i < plainKey.length; i++) {
      const charCode = plainKey.charCodeAt(i) ^ OBFUSCATION_SALT.charCodeAt(i % OBFUSCATION_SALT.length);
      scrambled += String.fromCharCode(charCode);
    }
    // Base64 encoding using standard Node Buffer to run inside Vite compiler
    obfuscatedKey = Buffer.from(scrambled, 'binary').toString('base64');
  }

  return {
    define: {
      __OBFUSCATED_GEMINI_KEY__: JSON.stringify(obfuscatedKey),
    },
    plugins: [
      react(), 
      tailwindcss(),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
    build: {
      chunkSizeWarningLimit: 800,
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-react': ['react', 'react-dom'],
            'vendor-firebase': ['firebase/app', 'firebase/auth'],
            'vendor-icons': ['lucide-react'],
          },
        },
      },
    },
  };
});
