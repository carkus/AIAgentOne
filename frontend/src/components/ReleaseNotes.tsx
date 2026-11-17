import { Fragment, type ReactNode } from 'react'
import styles from '../styles/ReleaseNotes.module.css'
import logo from '../assets/favicon.png'
import notesJson from '../releaseNotes.json'

// The Release Notes page, opened from the link opposite Setup's Deploy
// toolbar (a new tab at #/release-notes). Its text lives in
// releaseNotes.json, the same file tools/release-notes/make_pdf.py turns
// into the PDF, so the page and the PDF always say the same thing.
// Releases are listed newest first; only version, date and title are
// required, so a patch release can be a few fixes and nothing else.

interface Table { columns: string[]; rows: string[][] }
// A change is either a short title + text (what release.py writes from the
// Unreleased list) or the longer problem / fix / result form.
interface Fix { title: string; text?: string; problem?: string; fix?: string; result?: string }
interface Release {
  version: string
  date: string
  title: string
  subtitle?: string
  intro?: string
  headline?: Table & { title: string; text: string }
  fixesTitle?: string
  fixesNote?: string
  groups?: { title: string; fixes: Fix[] }[]
  servicesTitle?: string
  servicesIntro?: string
  services?: (Table & { title: string })[]
  closingTitle?: string
  closing?: string
}

const releases = (notesJson as { releases: Release[] }).releases

// **bold** and `code` are the only inline marks the notes use.
function inline(text: string): ReactNode {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>
    return <Fragment key={i}>{part}</Fragment>
  })
}

function DataTable({ columns, rows }: Table) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>{columns.map(c => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => j === 0
                ? <th key={j} scope="row">{inline(cell)}</th>
                : <td key={j}>{inline(cell)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ReleaseSection({ r }: { r: Release }) {
  return (
    <section id={`v${r.version}`} className={styles.release}>
      <header className={styles.header}>
        <p className={styles.kicker}>v{r.version} · {r.date}</p>
        <h2 className={styles.title}>{r.title}</h2>
        {r.subtitle && <p className={styles.subtitle}>{r.subtitle}</p>}
      </header>

      {r.intro && <p className={styles.lead}>{inline(r.intro)}</p>}

      {r.headline && (
        <>
          <h3 className={styles.h2}>{r.headline.title}</h3>
          <p className={styles.p}>{inline(r.headline.text)}</p>
          <DataTable columns={r.headline.columns} rows={r.headline.rows} />
        </>
      )}

      {r.groups && r.groups.length > 0 && (
        <>
          {r.fixesTitle && <h3 className={styles.h2}>{r.fixesTitle}</h3>}
          {r.fixesNote && <p className={styles.note}>{r.fixesNote}</p>}
          {r.groups.map(group => (
            <div key={group.title} className={styles.group}>
              <h4 className={styles.h3}>{group.title}</h4>
              {group.fixes.map(f => (
                <div key={f.title} className={styles.fix}>
                  <h5 className={styles.fixTitle}>{f.title}</h5>
                  {f.text && <p className={styles.fixText}>{inline(f.text)}</p>}
                  {(f.problem || f.fix || f.result) && (
                    <dl className={styles.fixBody}>
                      {f.problem && <><dt>Problem</dt><dd>{inline(f.problem)}</dd></>}
                      {f.fix && <><dt>Fix</dt><dd>{inline(f.fix)}</dd></>}
                      {f.result && <><dt>Result</dt><dd>{inline(f.result)}</dd></>}
                    </dl>
                  )}
                </div>
              ))}
            </div>
          ))}
        </>
      )}

      {r.services && r.services.length > 0 && (
        <>
          {r.servicesTitle && <h3 className={styles.h2}>{r.servicesTitle}</h3>}
          {r.servicesIntro && <p className={styles.p}>{inline(r.servicesIntro)}</p>}
          {r.services.map(s => (
            <div key={s.title} className={styles.group}>
              <h4 className={styles.h3}>{s.title}</h4>
              <DataTable columns={s.columns} rows={s.rows} />
            </div>
          ))}
        </>
      )}

      {r.closing && (
        <>
          {r.closingTitle && <h3 className={styles.h2}>{r.closingTitle}</h3>}
          <p className={styles.p}>{inline(r.closing)}</p>
        </>
      )}
    </section>
  )
}

export default function ReleaseNotes() {
  return (
    <div className={styles.page}>
      <article className={styles.card}>
        <div className={styles.top}>
          <a href="/" className={styles.logoLink} aria-label="Agent One" title="Agent One">
            <img src={logo} alt="Agent One" className={styles.logo} />
          </a>
          <div>
            <h1 className={styles.pageTitle}>Release Notes</h1>
            <p className={styles.subtitle}>Agent One v{__APP_VERSION__}</p>
          </div>
        </div>

        {releases.length > 1 && (
          // Jump list, newest first.
          <nav className={styles.versions} aria-label="Releases">
            {releases.map(r => (
              <a key={r.version} href={`#v${r.version}`} onClick={ev => {
                // The page's own address is the #/release-notes hash, so
                // scroll instead of following the link.
                ev.preventDefault()
                document.getElementById(`v${r.version}`)?.scrollIntoView({ behavior: 'smooth' })
              }}>
                v{r.version}
              </a>
            ))}
          </nav>
        )}

        {releases.map(r => <ReleaseSection key={r.version} r={r} />)}

        <footer className={styles.footer}>
          <a href="/" className={styles.back}>Back to Agent One</a>
        </footer>
      </article>
    </div>
  )
}
