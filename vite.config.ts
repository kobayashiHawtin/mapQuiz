import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  base: '/mapQuiz/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico'],
      manifest: {
        name: 'GeoMind',
        short_name: 'GeoMind',
        description: 'AI Historical Geography Quiz',
        theme_color: '#2563eb',
        background_color: '#ffffff',
        display: 'standalone',
        scope: '/mapQuiz/',
        start_url: '/mapQuiz/',
        icons: [
          {
            src: '/mapQuiz/favicon.ico',
            sizes: '32x32',
            type: 'image/x-icon',
          },
        ],
      },
    }),
  ],
})
