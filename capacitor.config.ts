import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.khosach.app',
  appName: 'Kho sách',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    hostname: 'localhost',
  },
  plugins: {
    StatusBar: {
      overlaysWebView: false,
      backgroundColor: '#0f172a',
      style: 'DARK',
    },
  },
};

export default config;
