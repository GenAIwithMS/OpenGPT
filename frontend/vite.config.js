import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// start.sh / start.bat pick free ports and pass them here; the defaults are
// 3000 for this dev server and 8000 for the backend it forwards /api to.
const frontendPort = Number(process.env.OPENGPT_FRONTEND_PORT) || 3000
const backendPort = Number(process.env.OPENGPT_BACKEND_PORT) || 8000

export default defineConfig({
  plugins: [react()],
  server: {
    port: frontendPort,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${backendPort}`,
        changeOrigin: true,
      }
    }
  }
})
