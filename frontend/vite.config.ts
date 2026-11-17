import { defineConfig, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

const BACKEND = 'http://localhost:4891'

// The backend not running (or restarting) isn't an error worth a red stack
// trace in the Vite log: answer 503 JSON quietly instead. The frontend's
// usual !res.ok handling then reads it as "backend unavailable". Vite adds
// its own error logger after configure(), so the event is caught here,
// before it reaches that listener. Any other proxy error is left to Vite.
function isConnRefused(err: unknown): boolean {
  const e = err as { code?: string; errors?: { code?: string }[] } | null
  if (!e) return false
  if (e.code === 'ECONNREFUSED') return true
  return Array.isArray(e.errors) && e.errors.some(x => x?.code === 'ECONNREFUSED')
}

const backend: ProxyOptions = {
  target: BACKEND,
  changeOrigin: true,
  configure(proxy) {
    const emit = proxy.emit.bind(proxy)
    proxy.emit = ((event: string, ...args: unknown[]) => {
      if (event === 'error' && isConnRefused(args[0])) {
        const res = args[2] as {
          headersSent?: boolean
          writableEnded?: boolean
          writeHead?: (status: number, headers: Record<string, string>) => { end: (body: string) => void }
          end?: () => void
        } | undefined
        if (res?.writeHead) {
          if (!res.headersSent && !res.writableEnded) {
            res.writeHead(503, { 'Content-Type': 'application/json' })
              .end(JSON.stringify({ error: 'Backend not running' }))
          }
        } else {
          res?.end?.()
        }
        return true
      }
      return emit(event, ...args)
    }) as typeof proxy.emit
  },
}

export default defineConfig({
  plugins: [react()],
  // The app version (package.json), shown beside Setup's Release Notes link.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: {
    port: 5273,
    strictPort: true,
    proxy: Object.fromEntries(
      [
        '/bootstrap', '/agent', '/brief', '/recap', '/relic', '/agents',
        '/agent-drafts', '/file', '/models', '/saved-searches', '/mcp-tools',
        '/validate-config',
      ].map(path => [path, backend]),
    ),
  },
})
