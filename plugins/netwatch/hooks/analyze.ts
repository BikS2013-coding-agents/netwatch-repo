import type { ApiCall, Watch } from '../types'

export type RawRequest = {
  requestId: string
  at: number
  method: string
  url: string
  status: number | null
  type: string | null
}

type AbRequest = {
  requestId?: unknown
  timestamp?: unknown
  method?: unknown
  url?: unknown
  status?: unknown
  resourceType?: unknown
}

/**
 * Parses `agent-browser network requests --json`, in the order listed.
 * Throws with agent-browser's own message when the command reports a failure.
 */
export function parseRequests(stdout: string): RawRequest[] {
  const out = JSON.parse(stdout) as { success?: boolean; error?: unknown; data?: { requests?: AbRequest[] } }
  if (out.success !== true) throw new Error(String(out.error ?? 'agent-browser failed'))
  return (out.data?.requests ?? []).flatMap(r =>
    typeof r.url === 'string' && typeof r.requestId === 'string'
      ? [
          {
            requestId: r.requestId,
            at: typeof r.timestamp === 'number' ? r.timestamp : Date.now(),
            method: String(r.method ?? 'GET').toUpperCase(),
            url: r.url,
            status: typeof r.status === 'number' && r.status > 0 ? r.status : null,
            type: typeof r.resourceType === 'string' ? r.resourceType : null,
          },
        ]
      : [],
  )
}

const STATIC = /\.(js|mjs|cjs|css|map|png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|wav)$/i

const STATIC_TYPES = new Set(['Script', 'Stylesheet', 'Image', 'Font', 'Media', 'Manifest', 'TextTrack'])

/** True for requests worth analysing: http(s), not a static asset. */
export function isApiCall(r: Pick<RawRequest, 'url' | 'type'>): boolean {
  if (!/^https?:\/\//i.test(r.url)) return false
  if (r.type !== null && STATIC_TYPES.has(r.type)) return false
  try {
    return !STATIC.test(new URL(r.url).pathname)
  } catch {
    return false
  }
}

function queryKeys(u: URL): string[] {
  const keys: string[] = []
  u.searchParams.forEach((_v, k) => keys.push(k))
  return keys
}

const SECRET_KEY = /token|key|secret|pass|pwd|auth|session|sig|code|otp|jwt/i

/** The URL with query values of secret-looking keys masked. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    for (const k of queryKeys(u)) {
      if (SECRET_KEY.test(k)) u.searchParams.set(k, '***')
    }
    return u.toString()
  } catch {
    return url
  }
}

function isIdSegment(s: string): boolean {
  return (
    /^\d+$/.test(s) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ||
    /^[0-9a-f]{16,}$/i.test(s) ||
    (s.length >= 20 && /^[A-Za-z0-9_-]+$/.test(s) && /\d/.test(s))
  )
}

/** "GET host/path/:id?keys" — calls to the same endpoint collapse to one key. */
export function endpointOf(method: string, url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname
      .split('/')
      .map(s => (isIdSegment(s) ? ':id' : s))
      .join('/')
    const keys = [...new Set(queryKeys(u))].sort()
    return `${method} ${u.host}${path}${keys.length ? '?' + keys.join('&') : ''}`
  } catch {
    return `${method} ${url}`
  }
}

export function clock(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 8)
}

export function counts(calls: readonly ApiCall[]): { total: number; errors: number } {
  return { total: calls.length, errors: calls.filter(c => c.status !== null && c.status >= 400).length }
}

export function summaryLine(calls: readonly ApiCall[], watch: Watch | null): string {
  const { total, errors } = counts(calls)
  const state = watch?.isActive ? '● watching' : 'stopped'
  return `netwatch ${state} · ${total} calls${errors ? ` · ${errors} errors` : ''}`
}

const TIMELINE_MAX = 400

/** Plain-text digest of a watch: window, endpoint table, chronological timeline. */
export function digest(calls: readonly ApiCall[], watch: Watch | null): string {
  const lines: string[] = []
  const { total, errors } = counts(calls)
  if (watch) {
    const end = watch.stoppedAt ?? Date.now()
    lines.push(
      `Watch: ${watch.mode === 'connect' ? "the user's own Chrome" : "agent-browser's Chrome"}` +
        `${watch.url ? ` (opened ${redactUrl(watch.url)})` : ''}, ${clock(watch.startedAt)}–${clock(end)} ` +
        `(${Math.round((end - watch.startedAt) / 1000)} s), ${watch.isActive ? 'still running' : 'stopped'}.`,
    )
    lines.push(`Static assets left out: ${watch.ignored}.`)
  }
  lines.push(`API/document calls: ${total}; HTTP errors (>=400): ${errors}.`, '')

  const groups = new Map<string, { n: number; statuses: Map<string, number>; first: number; last: number }>()
  for (const c of calls) {
    const key = endpointOf(c.method, c.url)
    const g = groups.get(key) ?? { n: 0, statuses: new Map(), first: c.at, last: c.at }
    g.n++
    const s = c.status === null ? 'none' : String(c.status)
    g.statuses.set(s, (g.statuses.get(s) ?? 0) + 1)
    g.first = Math.min(g.first, c.at)
    g.last = Math.max(g.last, c.at)
    groups.set(key, g)
  }
  lines.push('Endpoints (count | statuses | first–last seen):')
  for (const [key, g] of [...groups].sort((a, b) => b[1].n - a[1].n)) {
    const st = [...g.statuses].map(([s, n]) => `${s}×${n}`).join(', ')
    lines.push(`- ${key} | ${g.n} | ${st} | ${clock(g.first)}–${clock(g.last)}`)
  }

  lines.push('', 'Timeline (time = when the browser sent the request):')
  const shown = [...calls].sort((a, b) => a.at - b.at).slice(-TIMELINE_MAX)
  if (calls.length > shown.length) lines.push(`(first ${calls.length - shown.length} calls omitted)`)
  for (const c of shown) {
    const url = redactUrl(c.url)
    lines.push(`${clock(c.at)} ${c.method} ${c.status ?? '---'} ${c.type ?? '-'} ${url.length > 200 ? url.slice(0, 200) + '…' : url}`)
  }
  return lines.join('\n')
}
