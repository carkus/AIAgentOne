import { useEffect, useState } from 'react'
import { fetchGatewayStatus, type GatewayStatus } from '../api'
import styles from '../styles/GatewayBanner.module.css'

// Shown only when the backend is set up to use the ChattyPrayers AI gateway
// (CHATTY_GATEWAY_URL) and it is unreachable or failing. Calls keep working,
// served by the local providers, so this is a notice, not an error screen.
const POLL_MS = 60_000

export default function GatewayBanner() {
  const [status, setStatus] = useState<GatewayStatus | null>(null)
  const [dismissedAt, setDismissedAt] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = () => fetchGatewayStatus().then(s => { if (!cancelled) setStatus(s) })
    load()
    const id = window.setInterval(load, POLL_MS)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [])

  if (!status?.configured || status.ok !== false) return null
  // Dismissing hides this occurrence; a later failure shows it again.
  if (dismissedAt && dismissedAt === status.checked_at) return null

  return (
    <div className={styles.banner} role="status">
      <span>
        <strong>AI gateway {status.error ?? 'unavailable'}.</strong>{' '}
        Using local models (Ollama, then Workers AI) until it's back.
      </span>
      <button className={styles.close} onClick={() => setDismissedAt(status.checked_at)} aria-label="Dismiss">×</button>
    </div>
  )
}
