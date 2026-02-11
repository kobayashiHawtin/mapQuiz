import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Map as MapIcon,
  Award,
  BookOpen,
  RefreshCw,
  ChevronRight,
  Loader2,
  CheckCircle2,
  XCircle,
  Maximize,
  Menu,
  X,
  Target,
} from 'lucide-react'
import { initializeApp, type FirebaseOptions } from 'firebase/app'
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
  signInWithCustomToken,
  type User,
} from 'firebase/auth'
import { getFirestore, collection, addDoc, onSnapshot } from 'firebase/firestore'

type Geometry =
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] }

type GeoProperties = {
  ADMIN?: string
  name?: string
  ISO_A3?: string
  ISO_A2?: string
  'ISO3166-1-Alpha-2'?: string
  'ISO3166-1-Alpha-3'?: string
}

type GeoFeature = {
  type: 'Feature'
  geometry: Geometry
  properties: GeoProperties
}

type RawGeoFeature = {
  geometry?: Geometry | null
  properties?: GeoProperties
}

type RawGeoCollection = {
  type: 'FeatureCollection'
  features: RawGeoFeature[]
}

type GeoCollection = {
  type: 'FeatureCollection'
  features: GeoFeature[]
}

type Hint = {
  main_hint: string
  summary: string
}

type Feedback = {
  isCorrect: boolean
  message: string
}

type QuizHistoryItem = {
  id: string
  countryName: string
  isCorrect: boolean
  hintText: string
  timestamp: string
}

type PathDatum = {
  id: string
  name: string
  d: string
}

const isGeometrySupported = (geometry: RawGeoFeature['geometry']): geometry is Geometry =>
  Boolean(geometry && (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon'))

const hasName = (properties?: GeoProperties) => Boolean(properties?.ADMIN || properties?.name)

const getEnglishName = (properties: GeoProperties) => properties.ADMIN || properties.name || 'Unknown'

const getCountryId = (properties: GeoProperties) =>
  properties.ISO_A3 || properties['ISO3166-1-Alpha-3'] || properties.name || properties.ADMIN || 'unknown'

const getJapaneseName = (properties: GeoProperties) => {
  const rawRegion = properties['ISO3166-1-Alpha-2'] || properties.ISO_A2
  const regionCode = rawRegion?.toUpperCase()
  if (regionCode && /^[A-Z]{2}$/.test(regionCode) && typeof Intl.DisplayNames !== 'undefined') {
    const display = new Intl.DisplayNames('ja', { type: 'region' }).of(regionCode)
    if (display) return display
  }
  return getEnglishName(properties)
}

const extractPoints = (geometry: Geometry) => {
  if (geometry.type === 'Polygon') return geometry.coordinates.flat()
  return geometry.coordinates.flatMap((polygon) => polygon.flat())
}

const buildFallbackHint = (feature: GeoFeature): Hint => {
  const points = extractPoints(feature.geometry)
  const name = getJapaneseName(feature.properties)
  if (points.length === 0) {
    return {
      summary: `${name} / 解説準備中`,
      main_hint: `${name}の解説を表示するにはAIヒントを生成してください。`,
    }
  }
  let minLat = Infinity
  let maxLat = -Infinity
  let minLon = Infinity
  let maxLon = -Infinity
  for (const [lon, lat] of points) {
    minLat = Math.min(minLat, lat)
    maxLat = Math.max(maxLat, lat)
    minLon = Math.min(minLon, lon)
    maxLon = Math.max(maxLon, lon)
  }
  const centerLat = (minLat + maxLat) / 2
  const centerLon = (minLon + maxLon) / 2
  const latLabel = centerLat >= 0 ? '北半球' : '南半球'
  const lonLabel = centerLon >= 0 ? '東半球' : '西半球'
  const extentArea = Math.abs((maxLat - minLat) * (maxLon - minLon))
  const sizeLabel = extentArea < 20 ? '小さめ' : extentArea < 80 ? '中規模' : '広い'
  const shapeLabel =
    feature.geometry.type === 'MultiPolygon' && feature.geometry.coordinates.length > 1
      ? '島が点在する国'
      : 'ひと続きの陸地を持つ国'
  return {
    summary: `${name} / ${latLabel}・${lonLabel} / ${sizeLabel}`,
    main_hint: `${name}は${latLabel}・${lonLabel}に位置し、${shapeLabel}で、${sizeLabel}な国です。`,
  }
}

const isCoordinateHint = (value: string) =>
  /緯度|経度|北緯|南緯|東経|西経|°/.test(value)

const MAP_WIDTH = 800
const MAP_HEIGHT = 400

const project = (coords: number[]) => {
  const lon = coords[0]
  const lat = coords[1]
  const x = (lon + 180) * (MAP_WIDTH / 360)
  const y = (90 - lat) * (MAP_HEIGHT / 180)
  return [x, y]
}

const getProjectedBounds = (feature: GeoFeature) => {
  const points = extractPoints(feature.geometry)
  if (points.length === 0) return null
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const [lon, lat] of points) {
    const [x, y] = project([lon, lat])
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  return { minX, maxX, minY, maxY }
}

// --- Configuration ---
const firebaseConfig = JSON.parse(__firebase_config) as FirebaseOptions
const app = initializeApp(firebaseConfig)
const auth = getAuth(app)
const db = getFirestore(app)
const appId = __app_id ?? 'world-quiz-smooth'
// .env 設定方法:
// 1) プロジェクト直下に .env を作成
// 2) VITE_GEMINI_API_KEY=あなたのAPIキー を追加
// 3) 開発サーバー/ビルドを再起動
const apiKey = import.meta.env.VITE_GEMINI_API_KEY ?? ''
const hasValidFirebaseKey = Boolean(firebaseConfig?.apiKey) && firebaseConfig.apiKey !== 'demo-key'
const MODEL_NAME = 'gemini-2.5-flash-lite'
const GEO_DATA_URL =
  'https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson'

const App = () => {
  const [user, setUser] = useState<User | null>(null)
  const [view, setView] = useState<'start' | 'quiz' | 'review'>('start')
  const [geoData, setGeoData] = useState<GeoCollection | null>(null)
  const [currentCountry, setCurrentCountry] = useState<GeoFeature | null>(null)
  const [hint, setHint] = useState<Hint | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [score, setScore] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [history, setHistory] = useState<QuizHistoryItem[]>([])
  const [isHintMinimized, setIsHintMinimized] = useState(false)

  // --- Map State ---
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 })
  const mapRef = useRef<HTMLDivElement | null>(null)
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map())
  const lastCenter = useRef<{ x: number; y: number } | null>(null)
  const lastDist = useRef(0)
  const dragState = useRef<{ start: { x: number; y: number } | null; moved: boolean }>({
    start: null,
    moved: false,
  })
  const suppressClick = useRef(false)

  // --- Auth & Data Fetching ---
  useEffect(() => {
    if (!hasValidFirebaseKey) {
      setUser(null)
      return
    }
    const initAuth = async () => {
      try {
        if (__initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token)
        } else {
          await signInAnonymously(auth)
        }
      } catch (err) {
        console.error('Auth error:', err)
      }
    }
    initAuth()
    const unsubscribe = onAuthStateChanged(auth, setUser)
    return () => unsubscribe()
  }, [])

  useEffect(() => {
    const fetchGeoData = async () => {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch(GEO_DATA_URL)
        if (!res.ok) throw new Error('地図データの取得に失敗しました')
        const data = (await res.json()) as RawGeoCollection
        const valid = (data.features ?? [])
          .map((feature): GeoFeature | null => {
            if (!isGeometrySupported(feature.geometry) || !hasName(feature.properties)) return null
            return {
              type: 'Feature',
              geometry: feature.geometry,
              properties: feature.properties ?? {},
            }
          })
          .filter((feature): feature is GeoFeature => feature !== null)
        setGeoData({ type: 'FeatureCollection', features: valid })
      } catch (err) {
        const message = err instanceof Error ? err.message : '地図データの取得に失敗しました'
        setError(message)
        console.error('Map data fetch error:', err)
      } finally {
        setLoading(false)
      }
    }
    fetchGeoData()
  }, [])

  useEffect(() => {
    if (!user) return
    const q = collection(db, 'artifacts', appId, 'users', user.uid, 'quiz_history')
    return onSnapshot(
      q,
      (snapshot) => {
        const docs = snapshot.docs.map((doc) => {
          const data = doc.data() as Omit<QuizHistoryItem, 'id'>
          return { id: doc.id, ...data }
        })
        setHistory(docs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()))
      },
      (err) => console.error('Firestore error:', err),
    )
  }, [user])

  const pathData = useMemo<PathDatum[]>(() => {
    if (!geoData || !geoData.features) return []
    return geoData.features.flatMap((feature) => {
      const { type, coordinates } = feature.geometry
      const renderPolygon = (poly: number[][][]) =>
        poly.map((ring) => `M${ring.map((point) => project(point).join(',')).join(' L')}Z`).join(' ')
      let d = ''
      if (type === 'Polygon') d = renderPolygon(coordinates)
      else if (type === 'MultiPolygon') d = coordinates.map(renderPolygon).join(' ')
      if (!d) return []
      return [
        {
          id: getCountryId(feature.properties),
          name: getJapaneseName(feature.properties),
          d,
        },
      ]
    })
  }, [geoData])

  // --- Interaction Logic ---
  const getCenter = (pts: Map<number, { x: number; y: number }>) => {
    const arr = Array.from(pts.values())
    if (arr.length === 1) return { x: arr[0].x, y: arr[0].y }
    if (arr.length >= 2) return { x: (arr[0].x + arr[1].x) / 2, y: (arr[0].y + arr[1].y) / 2 }
    return { x: 0, y: 0 }
  }

  const getDist = (pts: Map<number, { x: number; y: number }>) => {
    const arr = Array.from(pts.values())
    if (arr.length < 2) return 0
    return Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y)
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    lastCenter.current = getCenter(pointers.current)
    if (pointers.current.size === 2) lastDist.current = getDist(pointers.current)
    if (pointers.current.size === 1) {
      dragState.current = { start: { x: e.clientX, y: e.clientY }, moved: false }
    } else {
      dragState.current.moved = true
    }
    const target = e.target as Element | null
    if (target?.setPointerCapture) {
      target.setPointerCapture(e.pointerId)
    } else {
      e.currentTarget.setPointerCapture(e.pointerId)
    }
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId) || !lastCenter.current) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const center = getCenter(pointers.current)

    if (pointers.current.size === 1) {
      const dx = center.x - lastCenter.current.x
      const dy = center.y - lastCenter.current.y
      const start = dragState.current.start
      if (start && !dragState.current.moved) {
        const movedDist = Math.hypot(e.clientX - start.x, e.clientY - start.y)
        if (movedDist > 6) dragState.current.moved = true
      }
      setTransform((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }))
    } else if (pointers.current.size === 2) {
      dragState.current.moved = true
      const dist = getDist(pointers.current)
      if (lastDist.current > 0 && mapRef.current) {
        const rect = mapRef.current.getBoundingClientRect()
        const cx = center.x - rect.left
        const cy = center.y - rect.top
        const scaleFactor = dist / lastDist.current
        setTransform((prev) => {
          const nextScale = Math.max(1, Math.min(20, prev.scale * scaleFactor))
          const s = nextScale / prev.scale
          return {
            scale: nextScale,
            x: cx - (cx - prev.x) * s,
            y: cy - (cy - prev.y) * s,
          }
        })
      }
      lastDist.current = dist
    }
    lastCenter.current = center
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId)
    if (dragState.current.moved) {
      suppressClick.current = true
    }
    if (pointers.current.size === 1) lastCenter.current = getCenter(pointers.current)
    if (pointers.current.size === 0) {
      lastCenter.current = null
      dragState.current = { start: null, moved: false }
    } else if (pointers.current.size === 1) {
      dragState.current = { start: getCenter(pointers.current), moved: false }
    }
  }

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!mapRef.current) return
    e.preventDefault()
    const rect = mapRef.current.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    const zoomFactor = Math.exp(-e.deltaY * 0.001)
    setTransform((prev) => {
      const nextScale = Math.max(1, Math.min(20, prev.scale * zoomFactor))
      const s = nextScale / prev.scale
      return {
        scale: nextScale,
        x: cx - (cx - prev.x) * s,
        y: cy - (cy - prev.y) * s,
      }
    })
  }

  const resetView = () => setTransform({ x: 0, y: 0, scale: 1 })

  // --- Quiz Logic ---
  const generateAIHint = useCallback(async (feature: GeoFeature) => {
    setLoading(true)
    setHint(null)
    const countryName = getEnglishName(feature.properties)
    const systemPrompt = `地理専門家として、指定国について簡潔な2文解説を生成。
    国名は必ず含める。緯度経度に触れない。
    歴史・文化・地形から1～2項目で、100文字以内。
    JSONのみ: {"main_hint": "簡潔な解説", "summary": "短いキャッチ"}` 

    try {
      if (!apiKey) {
        setHint(buildFallbackHint(feature))
        return
      }
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `国: ${countryName}` }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
            generationConfig: { responseMimeType: 'application/json' },
          }),
        },
      )
      const result = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
      }
      const text = result.candidates?.[0]?.content?.parts?.[0]?.text
      if (text) {
        const parsed = JSON.parse(text) as Hint
        if (isCoordinateHint(parsed.main_hint) || isCoordinateHint(parsed.summary)) {
          setHint(buildFallbackHint(feature))
        } else {
          setHint(parsed)
        }
      }
    } catch (e) {
      console.error('AI hint error:', e)
      setHint(buildFallbackHint(feature))
    } finally {
      setLoading(false)
    }
  }, [])

  const startNewQuestion = useCallback(() => {
    if (!geoData) return
    const random = geoData.features[Math.floor(Math.random() * geoData.features.length)]
    setCurrentCountry(random)
    setFeedback(null)
    setSelectedId(null)
    setIsHintMinimized(false)
    generateAIHint(random)
  }, [geoData, generateAIHint])

  useEffect(() => {
    if (view === 'quiz' && geoData && !currentCountry) {
      startNewQuestion()
    }
  }, [view, geoData, currentCountry, startNewQuestion])

  const handleCountryClick = (id: string, name: string) => {
    if (feedback || loading || pointers.current.size > 1 || !currentCountry) return
    if (suppressClick.current) {
      suppressClick.current = false
      return
    }
    const correctName = getJapaneseName(currentCountry.properties)
    const targetId = getCountryId(currentCountry.properties)
    if (!targetId) return
    const isCorrect = id === targetId

    setSelectedId(id)
    setFeedback({
      isCorrect,
      message: isCorrect
        ? '正解！'
        : `違います。そこは「${name}」です。正解は「${correctName}」です。`,
    })

    if (isCorrect) setScore((prev) => prev + 10)
    if (user) {
      addDoc(collection(db, 'artifacts', appId, 'users', user.uid, 'quiz_history'), {
        countryName: correctName,
        isCorrect,
        hintText: hint?.main_hint || '',
        timestamp: new Date().toISOString(),
      }).catch((err) => console.error('Error saving history:', err))
    }
  }

  useEffect(() => {
    if (!feedback || !currentCountry || !mapRef.current) return
    const targetId = getCountryId(currentCountry.properties)
    const raf = requestAnimationFrame(() => {
      const svg = mapRef.current?.querySelector('svg')
      if (!svg) return
      const path = svg.querySelector(`path[data-country-id="${targetId}"]`) as SVGGraphicsElement | null
      let bounds = null as { minX: number; maxX: number; minY: number; maxY: number } | null
      if (path) {
        const bbox = path.getBBox()
        bounds = {
          minX: bbox.x,
          maxX: bbox.x + bbox.width,
          minY: bbox.y,
          maxY: bbox.y + bbox.height,
        }
      } else {
        bounds = getProjectedBounds(currentCountry)
      }
      if (!bounds) return
      const viewWidth = svg.viewBox.baseVal.width || MAP_WIDTH
      const viewHeight = svg.viewBox.baseVal.height || MAP_HEIGHT
      const containerWidth = mapRef.current?.clientWidth ?? 0
      const containerHeight = mapRef.current?.clientHeight ?? 0
      if (!containerWidth || !containerHeight) return
      const baseScale = Math.min(containerWidth / viewWidth, containerHeight / viewHeight)
      const offsetX = (containerWidth - viewWidth * baseScale) / 2
      const offsetY = (containerHeight - viewHeight * baseScale) / 2
      const padding = 40
      const width = Math.max(1, bounds.maxX - bounds.minX)
      const height = Math.max(1, bounds.maxY - bounds.minY)
      const scaleX = (containerWidth - padding * 2) / (width * baseScale)
      const scaleY = (containerHeight - padding * 2) / (height * baseScale)
      const nextScale = Math.max(1, Math.min(20, Math.min(scaleX, scaleY)))
      const centerX = (bounds.minX + bounds.maxX) / 2
      const centerY = (bounds.minY + bounds.maxY) / 2
      const centerCssX = offsetX + centerX * baseScale
      const centerCssY = offsetY + centerY * baseScale
      setTransform({
        scale: nextScale,
        x: containerWidth / 2 - centerCssX * nextScale,
        y: containerHeight / 2 - centerCssY * nextScale,
      })
    })
    return () => cancelAnimationFrame(raf)
  }, [feedback, currentCountry, pathData])

  return (
    <div className="fixed inset-0 bg-white text-slate-900 font-sans overflow-hidden select-none touch-none">
      {/* Map Layer */}
      <div
        ref={mapRef}
        className="absolute inset-0 z-0 bg-sky-100 transition-colors duration-500"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={handleWheel}
      >
        <div
          className="w-full h-full origin-top-left will-change-transform"
          style={{
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
            transition: pointers.current.size === 0 ? 'transform 0.2s ease-out' : 'none',
          }}
        >
          <svg viewBox="0 0 800 400" className="w-full h-full drop-shadow-sm">
            <rect x="-1000" y="-1000" width="3000" height="3000" fill="#d4e9f7" />
            {pathData.map((path) => {
              const targetId = currentCountry ? getCountryId(currentCountry.properties) : undefined
              const isTarget = path.id === targetId
              const isSelected = path.id === selectedId

              let fill = '#f0f4f8'
              const stroke = '#cbd5e1'
              const strokeWidth = 0.5 / transform.scale

              if (feedback) {
                if (isTarget) fill = '#22c55e'
                else if (isSelected) fill = '#ef4444'
              } else if (isSelected) {
                fill = '#3b82f6'
              }

              return (
                <path
                  key={path.id}
                  d={path.d}
                  data-country-id={path.id}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={strokeWidth}
                  className="cursor-pointer"
                  style={{ transition: 'fill 0.15s ease-out' }}
                  onClick={(e) => {
                    e.stopPropagation()
                    handleCountryClick(path.id, path.name)
                  }}
                />
              )
            })}
          </svg>
        </div>
      </div>

      {/* Overlay: Navigation */}
      <div className="absolute top-0 left-0 right-0 p-4 pointer-events-none flex justify-between items-start z-20">
        <div className="pointer-events-auto bg-white/80 backdrop-blur-xl px-4 py-2 rounded-2xl shadow-xl border border-white/50 flex items-center gap-3">
          <button
            onClick={() => setView('start')}
            className="p-1 hover:bg-slate-100 rounded-lg"
            aria-label="Open menu"
          >
            <Menu size={20} className="text-slate-600" />
          </button>
          <div className="h-4 w-px bg-slate-200" />
          <div className="flex items-center gap-2">
            <Award className="text-amber-500" size={18} />
            <span className="font-black text-sm tabular-nums">{score}</span>
          </div>
        </div>
        <button
          onClick={resetView}
          className="pointer-events-auto bg-white/80 backdrop-blur-xl p-3 rounded-2xl shadow-xl border border-white/50 text-slate-600 active:scale-90 transition-transform"
          aria-label="Reset map view"
        >
          <Maximize size={20} />
        </button>
      </div>

      {/* Overlay: Hint Panel */}
      {view === 'quiz' && (
        <div
          className={`absolute bottom-6 left-1/2 -translate-x-1/2 w-[calc(100%-2rem)] max-w-lg transition-all duration-500 z-30 ${
            feedback ? 'translate-y-0' : isHintMinimized ? 'translate-y-[calc(100%-3rem)]' : ''
          }`}
        >
          <div className="bg-white/95 backdrop-blur-2xl shadow-2xl rounded-[2.5rem] border border-white overflow-hidden">
            <div
              className="px-6 py-3 bg-slate-50/50 flex justify-between items-center cursor-pointer"
              onClick={() => !feedback && setIsHintMinimized(!isHintMinimized)}
            >
              <div className="flex items-center gap-2 text-blue-600">
                <Target size={18} />
                <span className="text-[10px] font-black uppercase tracking-widest">Region Data Analysis</span>
              </div>
              {!feedback && (
                <ChevronRight
                  className={`transition-transform duration-300 ${isHintMinimized ? '-rotate-90' : 'rotate-90'} text-slate-400`}
                />
              )}
            </div>

            <div className="p-6 select-text touch-auto">
              {loading ? (
                <div className="py-8 flex flex-col items-center gap-4">
                  <Loader2 className="animate-spin text-blue-600" size={32} />
                  <p className="text-[10px] font-black text-blue-600 animate-pulse tracking-widest">
                    FETCHING CONTEXT...
                  </p>
                </div>
              ) : error ? (
                <div className="text-center p-4 text-red-500 font-bold">{error}</div>
              ) : feedback ? (
                <div className="space-y-4 animate-in zoom-in-95 duration-300">
                  <div
                    className={`flex items-center gap-4 p-5 rounded-3xl ${feedback.isCorrect ? 'bg-green-500 text-white' : 'bg-red-500 text-white'}`}
                  >
                    {feedback.isCorrect ? <CheckCircle2 size={32} /> : <XCircle size={32} />}
                    <div>
                      <p className="font-black text-xl leading-none">{feedback.isCorrect ? 'SUCCESS' : 'WRONG'}</p>
                      <p className="text-sm opacity-90 font-medium mt-1">{feedback.message}</p>
                    </div>
                  </div>
                  <button
                    onClick={startNewQuestion}
                    className="w-full bg-slate-900 text-white font-black py-5 rounded-[1.5rem] shadow-xl hover:bg-slate-800 transition-all active:scale-95 flex items-center justify-center gap-3 text-lg"
                  >
                    NEXT CHALLENGE <RefreshCw size={20} />
                  </button>
                </div>
              ) : (
                <div className="space-y-2 animate-in fade-in duration-500">
                  <div className="bg-blue-600 text-white p-2 px-3 rounded-lg inline-block shadow-lg select-text">
                    <p className="font-bold italic text-[10px]">"{hint?.summary || '...'}"</p>
                  </div>
                  <p className="text-[11px] text-slate-500 font-bold">
                    正解国: {currentCountry ? getJapaneseName(currentCountry.properties) : '...'}
                  </p>
                  <p className="text-slate-700 text-sm leading-snug font-semibold max-h-24 overflow-y-auto pr-2">
                    {hint?.main_hint || 'ターゲットを探索中...'}
                  </p>
                  <p className="text-[9px] text-slate-400 font-black uppercase tracking-wide">
                    Pinch/Scroll • Drag
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Start/Archive Screens */}
      {view !== 'quiz' && (
        <div className="absolute inset-0 z-50 bg-white flex items-center justify-center p-8 animate-in fade-in duration-300">
          <div className="w-full max-w-md space-y-12">
            <div className="text-center">
              <div className="inline-block bg-blue-600 p-5 rounded-[2.5rem] shadow-2xl mb-6 rotate-3">
                <MapIcon className="text-white" size={48} />
              </div>
              <h1 className="text-6xl font-black text-slate-900 tracking-tighter mb-2">
                Geo<span className="text-blue-600">Mind</span>
              </h1>
              <p className="text-slate-500 font-bold">AI Historical Geography Quiz</p>
            </div>
            {view === 'start' && (
              <div className="flex flex-col gap-4">
                <button
                  onClick={() => {
                    setView('quiz')
                    startNewQuestion()
                  }}
                  className="w-full bg-blue-600 text-white font-black py-6 rounded-[2rem] shadow-2xl hover:scale-105 active:scale-95 transition-all text-2xl"
                >
                  START GAME
                </button>
                <button
                  onClick={() => setView('review')}
                  className="w-full bg-white border-2 border-slate-100 text-slate-400 font-black py-5 rounded-[2rem] hover:bg-slate-50 transition-all flex items-center justify-center gap-2"
                >
                  <BookOpen size={20} /> ARCHIVE
                </button>
              </div>
            )}
            {view === 'review' && (
              <div className="space-y-6 max-h-[60vh] overflow-y-auto pr-2">
                <div className="flex justify-between items-center sticky top-0 bg-white py-2 z-10">
                  <h2 className="text-2xl font-black tracking-tight">LEARNING LOG</h2>
                  <button
                    onClick={() => setView('start')}
                    className="p-2 bg-slate-100 rounded-full"
                    aria-label="Close log"
                  >
                    <X size={20} />
                  </button>
                </div>
                {history.length === 0 ? (
                  <p className="text-slate-400 text-center py-10">NO DATA FOUND</p>
                ) : (
                  history.map((item) => (
                    <div
                      key={item.id}
                      className="p-5 bg-slate-50 rounded-3xl border border-slate-100 flex gap-4"
                    >
                      <div className={item.isCorrect ? 'text-green-500' : 'text-red-500'}>
                        {item.isCorrect ? <CheckCircle2 size={24} /> : <XCircle size={24} />}
                      </div>
                      <div>
                        <h4 className="font-black text-slate-900 text-lg uppercase">{item.countryName}</h4>
                        <p className="text-xs text-slate-500 font-medium mt-1 leading-relaxed line-clamp-2">
                          {item.hintText}
                        </p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default App
