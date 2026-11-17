// Settings on the deployment page (Chat): the same SettingsModal as Setup,
// with the same localStorage-backed preferences. Changes also apply to the
// running agent from its next turn (onApply → Chat's config overrides):
// provider/model, max workers, search defaults and location.
import { useEffect, useRef, useState } from 'react'
import SettingsModal from './SettingsModal'
import { fetchModelInfo } from '../api'
import { storedOllamaModel, storedCloudflareModel } from '../modelLabel'
import { getDateFormat, type DateFormatId } from '../dateFormat'
import type { AgentConfig, ArmStat, LlmProvider, SearchDefaults } from '../types'

type Overrides = Partial<Pick<AgentConfig, 'provider' | 'ollama_model' | 'max_delegations' | 'search_defaults' | 'location'>>

interface Props {
  isOpen: boolean
  onClose: () => void
  agentConfig: AgentConfig
  onApply: (o: Overrides) => void
}

export default function ChatSettings({ isOpen, onClose, agentConfig, onApply }: Props) {
  const [provider, setProvider] = useState<LlmProvider>(agentConfig.provider ?? 'ollama')
  const [ollamaModel, setOllamaModel] = useState<string | null>(() =>
    agentConfig.provider === 'ollama' && agentConfig.ollama_model ? agentConfig.ollama_model : storedOllamaModel())
  const [cloudflareModel, setCloudflareModel] = useState<string>(() =>
    agentConfig.provider === 'cloudflare' && agentConfig.ollama_model ? agentConfig.ollama_model : storedCloudflareModel())
  const [maxDelegations, setMaxDelegations] = useState<number | null>(agentConfig.max_delegations ?? null)
  const [searchDefaults, setSearchDefaults] = useState<SearchDefaults>(agentConfig.search_defaults ?? {})
  const [dateFormat, setDateFormat] = useState<DateFormatId>(() => getDateFormat())
  const [location, setLocation] = useState(agentConfig.location ?? '')
  const [locationSuggestions, setLocationSuggestions] = useState<string[]>([])
  const [showLocationSuggestions, setShowLocationSuggestions] = useState(false)
  const [detectingLocation, setDetectingLocation] = useState(false)
  const locationDebounceRef = useRef<number | undefined>(undefined)
  const locationAbortRef = useRef<AbortController | null>(null)
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [cloudflareModels, setCloudflareModels] = useState<string[]>([])
  const [modelsLoaded, setModelsLoaded] = useState(false)
  const [recommendedArm, setRecommendedArm] = useState<{ provider: string; model: string } | null>(null)
  const [armStats, setArmStats] = useState<ArmStat[]>([])

  useEffect(() => {
    if (!isOpen || modelsLoaded) return
    fetchModelInfo().then(({ models, cloudflareModels, recommended, armStats }) => {
      setAvailableModels(models)
      setCloudflareModels(cloudflareModels)
      setRecommendedArm(recommended)
      setArmStats(armStats)
      setModelsLoaded(true)
    })
  }, [isOpen, modelsLoaded])

  function store(key: string, value: string | null) {
    try {
      if (value) localStorage.setItem(key, value)
      else localStorage.removeItem(key)
    } catch { /* private mode */ }
  }

  function modelFor(p: LlmProvider, local: string | null, cf: string): string | null {
    return p === 'cloudflare' ? cf : p === 'ollama' ? local : null
  }

  function handleProviderChange(p: LlmProvider) {
    setProvider(p)
    store('aiagent_provider', p || null)
    onApply({ provider: p, ollama_model: modelFor(p, ollamaModel, cloudflareModel) })
  }
  function handleOllamaModelChange(m: string | null) {
    setOllamaModel(m)
    store('aiagent_ollama_model', m)
    if (provider === 'ollama') onApply({ ollama_model: m })
  }
  function handleCloudflareModelChange(m: string) {
    setCloudflareModel(m)
    store('aiagent_cloudflare_model', m)
    if (provider === 'cloudflare') onApply({ ollama_model: m })
  }
  function handleMaxDelegationsChange(n: number | null) {
    setMaxDelegations(n)
    store('aiagent_max_delegations', n ? String(n) : null)
    onApply({ max_delegations: n })
  }
  function handleSearchDefaultsChange(d: SearchDefaults) {
    setSearchDefaults(d)
    store('aiagent_search_defaults', Object.keys(d).length > 0 ? JSON.stringify(d) : null)
    onApply({ search_defaults: d })
  }
  function handleDateFormatChange(f: DateFormatId) {
    setDateFormat(f)
    store('aiagent_date_format', f)
  }

  // Location: same Nominatim lookups as Setup.
  function applyLocation(name: string) {
    setLocation(name)
    onApply({ location: name })
  }
  async function fetchLocationSuggestions(query: string) {
    locationAbortRef.current?.abort()
    const controller = new AbortController()
    locationAbortRef.current = controller
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&addressdetails=0&limit=5&q=${encodeURIComponent(query)}`,
        { signal: controller.signal },
      )
      if (!res.ok) return
      const data = await res.json()
      const names: string[] = Array.isArray(data)
        ? data.map((d: { display_name?: string }) => d.display_name).filter((n): n is string => Boolean(n))
        : []
      setLocationSuggestions(names)
      setShowLocationSuggestions(true)
    } catch { /* aborted or offline */ }
  }
  function handleLocationChange(value: string) {
    applyLocation(value)
    window.clearTimeout(locationDebounceRef.current)
    const query = value.trim()
    if (query.length < 3) {
      setLocationSuggestions([])
      setShowLocationSuggestions(false)
      return
    }
    locationDebounceRef.current = window.setTimeout(() => fetchLocationSuggestions(query), 400)
  }
  function selectLocation(name: string) {
    applyLocation(name)
    setLocationSuggestions([])
    setShowLocationSuggestions(false)
  }
  function detectLocation() {
    if (!navigator.geolocation) return
    setDetectingLocation(true)
    navigator.geolocation.getCurrentPosition(
      async pos => {
        try {
          const { latitude, longitude } = pos.coords
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=10&addressdetails=0`,
          )
          if (res.ok) {
            const name: string | undefined = (await res.json())?.display_name
            if (name) applyLocation(name)
          }
        } catch { /* keep the current location */ } finally {
          setDetectingLocation(false)
        }
      },
      () => setDetectingLocation(false),
      { timeout: 8000 },
    )
  }

  return (
    <SettingsModal
      isOpen={isOpen}
      onClose={onClose}
      location={location}
      onLocationChange={handleLocationChange}
      locationSuggestions={locationSuggestions}
      showLocationSuggestions={showLocationSuggestions}
      onLocationFocus={() => { if (locationSuggestions.length > 0) setShowLocationSuggestions(true) }}
      onLocationBlur={() => window.setTimeout(() => setShowLocationSuggestions(false), 150)}
      onSelectLocation={selectLocation}
      onDetectLocation={detectLocation}
      detectingLocation={detectingLocation}
      provider={provider}
      onProviderChange={handleProviderChange}
      ollamaModel={ollamaModel}
      onOllamaModelChange={handleOllamaModelChange}
      availableModels={availableModels}
      cloudflareModel={cloudflareModel}
      onCloudflareModelChange={handleCloudflareModelChange}
      cloudflareModels={cloudflareModels}
      modelsLoaded={modelsLoaded}
      recommendedArm={recommendedArm}
      armStats={armStats}
      maxDelegations={maxDelegations}
      onMaxDelegationsChange={handleMaxDelegationsChange}
      searchDefaults={searchDefaults}
      onSearchDefaultsChange={handleSearchDefaultsChange}
      dateFormat={dateFormat}
      onDateFormatChange={handleDateFormatChange}
      disabled={false}
    />
  )
}
