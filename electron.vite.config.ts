import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = resolve('src/shared')
const context = resolve('src/context')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared, '@context': context } },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // Forked for one coding run. It has to be a built file beside index.
          agentProcess: resolve('src/main/coding/agentProcess.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared, '@context': context } },
    build: {
      rollupOptions: {
        input: resolve('src/preload/index.ts'),
        // A sandboxed preload is loaded by Electron's own CommonJS loader and
        // cannot be ESM, so it is emitted as .cjs regardless of "type": "module".
        output: { format: 'cjs', entryFileNames: 'index.cjs' }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@shared': shared, '@context': context, '@renderer': resolve('src/renderer/src') }
    },
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } }
  }
})
