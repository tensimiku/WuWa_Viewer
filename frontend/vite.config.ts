import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  const rootEnv = loadEnv(mode, '..', '')
  const apiTarget = process.env.VITE_API_TARGET || rootEnv.VITE_API_TARGET || rootEnv.WUWA_API_URL || 'http://localhost:5180'
  const devPort = Number(process.env.VITE_PORT || rootEnv.VITE_PORT || rootEnv.WUWA_FRONTEND_PORT) || 5173

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: devPort,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true
        }
      }
    }
  }
})
