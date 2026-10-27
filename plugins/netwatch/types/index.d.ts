export type ApiCall = {
  /** Sequence number within the watch, 1-based. */
  seq: number
  /** agent-browser's (CDP) request id, used to skip requests already recorded. */
  requestId: string
  /** Epoch ms when the browser sent the request. */
  at: number
  method: string
  url: string
  /** HTTP status, or null when the request got no response (failed / still pending at stop). */
  status: number | null
  /** CDP resource type (Document, XHR, Fetch, …), null when the browser gives none. */
  type: string | null
}

export type Watch = {
  /** `browser`: agent-browser's own visible Chrome; `connect`: the user's running Chrome. */
  mode: 'browser' | 'connect'
  /** The URL opened at start, if any. */
  url: string | null
  isActive: boolean
  startedAt: number
  stoppedAt: number | null
  /** Static assets (scripts, styles, images, fonts) seen and left out of `calls`. */
  ignored: number
  /** The last poll's error, null after a poll that worked. */
  lastError: string | null
}

declare module 'claude-code' {
  interface PluginState {
    netwatch: {
      calls: ApiCall[]
      watch: Watch | null
    }
  }
}
