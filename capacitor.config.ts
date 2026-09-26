import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.tietkiemgiadinh.app',
  appName: 'Kho Sách Cá Nhân',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    hostname: 'localhost',
  },
  plugins: {
    GoogleAuth: {
      scopes: [
        'profile',
        'email',
        'openid',
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive.readonly',
      ],
      clientId: '864440372329-fgoo89lqp196nvcptmfc7pquofuj8agt.apps.googleusercontent.com',
      serverClientId: '864440372329-fgoo89lqp196nvcptmfc7pquofuj8agt.apps.googleusercontent.com',
      forceCodeForRefreshToken: false,
    },
  },
};

export default config;
