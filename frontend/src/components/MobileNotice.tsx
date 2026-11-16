import { useEffect, useRef, useState } from 'react'
import styles from '../styles/MobileNotice.module.css'

const KEY = 'agentone.mobileNoticeDismissed'
const QUERY = '(max-width: 768px), (pointer: coarse) and (max-width: 1024px)'

function shouldShow(): boolean {
  try {
    if (sessionStorage.getItem(KEY) === '1') return false
  } catch { /* storage blocked: show it */ }
  return typeof window !== 'undefined' && window.matchMedia?.(QUERY).matches === true
}

// Shown once per session on a phone-sized or touch screen: Agent One is
// built for desktop browsers for now; a mobile version comes later.
export default function MobileNotice() {
  const [open, setOpen] = useState(shouldShow)
  const btnRef = useRef<HTMLButtonElement>(null)

  const close = () => {
    try { sessionStorage.setItem(KEY, '1') } catch { /* ignore */ }
    setOpen(false)
  }

  useEffect(() => {
    if (!open) return
    btnRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null
  return (
    <div className={styles.overlay} onClick={close}>
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-notice-title"
        onClick={e => e.stopPropagation()}
      >
        <h2 id="mobile-notice-title" className={styles.title}>Not a mobile app yet</h2>
        <p className={styles.text}>
          Agent One is built for desktop and laptop browsers. A mobile version will come later,
          so for now some screens may not fit or work well on this device.
        </p>
        <button ref={btnRef} type="button" className={styles.button} onClick={close}>
          Continue anyway
        </button>
      </div>
    </div>
  )
}
