import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import styles from '../styles/LocationMapModal.module.css'

// Pick the search location on a map. OpenStreetMap tiles (keyless) drawn
// greyscale under a tint of the page's ink, and the same Nominatim host
// Setup already uses for location suggestions and detection: forward
// search for the box, reverse lookup for a click on the map.

interface Place {
  name: string
  lat: number
  lon: number
}

interface Props {
  isOpen: boolean
  location: string
  onClose: () => void
  onSelect: (name: string) => void
}

const NOMINATIM = 'https://nominatim.openstreetmap.org'
// Melbourne: the app's default location, used when the current one can't be found.
const FALLBACK: [number, number] = [-37.8136, 144.9631]

// The pin is our own SVG rather than Leaflet's default marker images, which
// need extra bundler wiring and are blue.
const PIN_ICON = L.divIcon({
  className: styles.pinIcon,
  html: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="#fff" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 22s-7.5-6.4-7.5-12a7.5 7.5 0 0 1 15 0c0 5.6-7.5 12-7.5 12z"/><circle cx="12" cy="10" r="2.6" fill="#fff" stroke="none"/></svg>`,
  iconSize: [30, 30],
  iconAnchor: [15, 29],
})

async function searchPlaces(q: string, limit: number, signal?: AbortSignal): Promise<Place[]> {
  const res = await fetch(`${NOMINATIM}/search?format=json&addressdetails=0&limit=${limit}&q=${encodeURIComponent(q)}`, { signal })
  if (!res.ok) return []
  const data = await res.json()
  return Array.isArray(data)
    ? data
        .filter((d: { display_name?: string; lat?: string; lon?: string }) => d.display_name && d.lat && d.lon)
        .map((d: { display_name: string; lat: string; lon: string }) => ({ name: d.display_name, lat: +d.lat, lon: +d.lon }))
    : []
}

async function reversePlace(lat: number, lon: number): Promise<string | null> {
  const res = await fetch(`${NOMINATIM}/reverse?format=json&lat=${lat}&lon=${lon}&zoom=10&addressdetails=0`)
  if (!res.ok) return null
  const data = await res.json()
  return typeof data?.display_name === 'string' ? data.display_name : null
}

export default function LocationMapModal({ isOpen, location, onClose, onSelect }: Props) {
  const mapEl = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markerRef = useRef<L.Marker | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Place[]>([])
  const [picked, setPicked] = useState<Place | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function placePin(p: Place, zoom?: number) {
    const map = mapRef.current
    if (!map) return
    if (markerRef.current) markerRef.current.setLatLng([p.lat, p.lon])
    else markerRef.current = L.marker([p.lat, p.lon], { icon: PIN_ICON, keyboard: false }).addTo(map)
    map.flyTo([p.lat, p.lon], zoom ?? Math.max(map.getZoom(), 9), { duration: 0.6 })
    setPicked(p)
  }

  // Build the map when the window opens, centred on the current location.
  useEffect(() => {
    if (!isOpen || !mapEl.current) return
    setQuery('')
    setResults([])
    setPicked(null)
    setError(null)
    const map = L.map(mapEl.current, { center: FALLBACK, zoom: 3, attributionControl: false })
    L.control.attribution({ prefix: false }).addTo(map)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
    }).addTo(map)
    mapRef.current = map

    map.on('click', async (e: L.LeafletMouseEvent) => {
      const { lat, lng } = e.latlng
      setBusy('Finding that place…')
      setError(null)
      try {
        const name = await reversePlace(lat, lng)
        if (name) placePin({ name, lat, lon: lng }, map.getZoom())
        else setError('No place found there. Try a little closer to a town.')
      } catch {
        setError('Couldn’t look that place up. Check your connection.')
      } finally {
        setBusy(null)
      }
    })

    const controller = new AbortController()
    if (location.trim()) {
      searchPlaces(location, 1, controller.signal)
        .then(([p]) => { if (p) placePin(p, 9) })
        .catch(() => {})
    }
    return () => {
      controller.abort()
      map.remove()
      mapRef.current = null
      markerRef.current = null
    }
    // Rebuilt per open; the location read here is the one it opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  async function runSearch(e: React.FormEvent) {
    e.preventDefault()
    const q = query.trim()
    if (q.length < 2) return
    setBusy('Searching…')
    setError(null)
    try {
      const found = await searchPlaces(q, 5)
      setResults(found)
      if (found.length === 0) setError('No places match that.')
      else if (found.length === 1) { placePin(found[0], 9); setResults([]) }
    } catch {
      setError('Search failed. Check your connection.')
    } finally {
      setBusy(null)
    }
  }

  function useMyLocation() {
    if (!navigator.geolocation) { setError('This browser can’t share its location.'); return }
    setBusy('Finding you…')
    setError(null)
    navigator.geolocation.getCurrentPosition(
      async pos => {
        const { latitude, longitude } = pos.coords
        try {
          const name = await reversePlace(latitude, longitude)
          if (name) placePin({ name, lat: latitude, lon: longitude }, 10)
        } catch {
          setError('Couldn’t look up where you are.')
        } finally {
          setBusy(null)
        }
      },
      () => { setBusy(null); setError('Location permission was refused.') },
      { timeout: 8000 },
    )
  }

  if (!isOpen) return null

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="location-map-title"
        onClick={e => e.stopPropagation()}
      >
        <span className={styles.dossierTab} aria-hidden="true">Field Map</span>
        <div className={styles.header}>
          <span id="location-map-title" className={styles.title}>Search location</span>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close map">×</button>
        </div>

        <div className={styles.body}>
          <form className={styles.searchRow} onSubmit={runSearch}>
            <input
              className={styles.searchInput}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search a town, city or country"
              aria-label="Search for a place"
              autoFocus
            />
            <button type="submit" className={styles.btn} disabled={busy !== null || query.trim().length < 2}>Search</button>
            <button type="button" className={styles.btn} onClick={useMyLocation} disabled={busy !== null}>Use mine</button>
          </form>
          {results.length > 1 && (
            <ul className={styles.results}>
              {results.map(r => (
                <li key={`${r.lat},${r.lon}`}>
                  <button type="button" onClick={() => { placePin(r, 9); setResults([]) }}>{r.name}</button>
                </li>
              ))}
            </ul>
          )}

          <div ref={mapEl} className={styles.map} />

          <p className={`${styles.status} ${error ? styles.statusError : ''}`} role="status">
            {error ?? busy ?? (picked ? picked.name : 'Tap the map or search to choose a place.')}
          </p>
        </div>

        <div className={styles.footer}>
          <button type="button" className={styles.btn} onClick={onClose}>Cancel</button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={!picked}
            onClick={() => { if (picked) { onSelect(picked.name); onClose() } }}
          >
            Use this location
          </button>
        </div>
      </div>
    </div>
  )
}
