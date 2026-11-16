import { useEffect, useState } from 'react'
import type { ResultFeedback } from '../types'
import styles from '../styles/Chat.module.css'

interface Props {
  feedback?: ResultFeedback
  onChange: (feedback: ResultFeedback | undefined) => void
  // On the latest answer only: the box becomes a reply to the question the
  // agent ended on, sent as the user's next message. Without it the box is
  // the optional note on a rating, shown once a thumb is picked.
  onReply?: (text: string) => void
  replyDisabled?: boolean
}

function ThumbIcon({ down }: { down?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={down ? { transform: 'rotate(180deg)' } : undefined}>
      <path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3Z" />
      <path d="M7 10l4-7a2.5 2.5 0 0 1 2.5 2.5V9h5.2a2 2 0 0 1 2 2.3l-1.4 8A2 2 0 0 1 17.3 21H7" />
    </svg>
  )
}

// Optional rating of one result. It steers the rest of this job only:
// agent_stream.py's _job_continuity_note reads it from the history on the
// next turn. Clicking the active thumb again clears it.
export default function ResultRating({ feedback, onChange, onReply, replyDisabled }: Props) {
  const [note, setNote] = useState(feedback?.note ?? '')
  useEffect(() => { setNote(feedback?.note ?? '') }, [feedback?.note])

  const rate = (rating: 'up' | 'down') =>
    onChange(feedback?.rating === rating ? undefined : { rating, note: feedback?.note })

  const commitNote = () => {
    if (!feedback) return
    const trimmed = note.trim()
    if (trimmed !== (feedback.note ?? '')) onChange({ ...feedback, note: trimmed || undefined })
  }

  const [reply, setReply] = useState('')
  const sendReply = () => {
    const text = reply.trim()
    if (!text || replyDisabled || !onReply) return
    onReply(text)
    setReply('')
  }

  return (
    <div className={styles.resultRating}>
      <span className={styles.resultRatingLabel}>Useful for this job?</span>
      {(['up', 'down'] as const).map(r => (
        <button
          key={r}
          type="button"
          className={`${styles.resultRatingBtn} ${feedback?.rating === r ? styles.resultRatingBtnActive : ''}`}
          onClick={() => rate(r)}
          aria-pressed={feedback?.rating === r}
          aria-label={r === 'up' ? 'Useful' : 'Not useful'}
          title={r === 'up' ? 'Useful: do more like this' : 'Not useful: steer away from this'}
        >
          <ThumbIcon down={r === 'down'} />
        </button>
      ))}
      {onReply && (
        <>
          <input
            className={styles.resultRatingNote}
            value={reply}
            onChange={e => setReply(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); sendReply() } }}
            placeholder="Reply to the agent's question…"
            maxLength={2000}
            aria-label="Reply to the agent"
          />
          <button
            type="button"
            className={`${styles.resultRatingBtn} ${styles.resultReplyBtn}`}
            onClick={sendReply}
            disabled={!reply.trim() || replyDisabled}
          >
            Reply
          </button>
        </>
      )}
      {!onReply && feedback && (
        <input
          className={styles.resultRatingNote}
          value={note}
          onChange={e => setNote(e.target.value)}
          onBlur={commitNote}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitNote(); (e.target as HTMLInputElement).blur() } }}
          placeholder={feedback.rating === 'up' ? 'Optional: what to keep doing' : 'Optional: what to change'}
          maxLength={300}
          aria-label="Optional note on this result"
        />
      )}
    </div>
  )
}
