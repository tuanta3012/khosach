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
      backgroundColor: '#2b170e',
      style: 'DARK',
    },
    GoogleAuth: {
      scopes: [
        'profile',
        'email',
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/spreadsheets'
      ],
      serverClientId: '742077941372-fk4ef96nfj54dqjov8vhpgum2tsq9dep.apps.googleusercontent.com',
      forceCodeForRefreshToken: true,
    },
  },
};

export default config;
