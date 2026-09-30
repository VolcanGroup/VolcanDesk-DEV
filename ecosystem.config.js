// Configuracion de PM2 para Volcan Desk / Ticket Management (ambiente DEV).
// Correr desde la carpeta que contiene /frontend y /backend:
//   pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'volcandesk-backend',
      cwd: './backend',
      script: 'server.js',
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'development',
        PORT: 4000,
      },
    },
    {
      name: 'volcandesk-frontend',
      cwd: './frontend',
      script: 'serve-static.cjs',
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'development',
        FRONTEND_PORT: 5173,
      },
    },
  ],
};
