/** The statusline's numbers, as `statusline.ts --json` gives them (already formatted), for the band. */
export type Line = {
  show: boolean
  model?: string
  pct?: number
  level?: 'green' | 'yellow' | 'red'
  gauge?: string
  tokens?: string
  cost?: string
  ttl?: number
  /** Epoch seconds when the prompt cache goes cold; null when nothing is cached yet. */
  cold_at?: number | null
  /** Egg-timer icons: full, half, empty. */
  icons?: string[]
  /** The forward view (money formatted): null when there's no context to forecast from yet. */
  outlook?: Outlook | null
}

/** What the session is about to cost, and the one change that saves most (statusline.ts `outlook`). */
export type Outlook = {
  /** The next request while the cache is warm. */
  step: string
  /** The next `steps` requests. */
  forecast: string
  steps: number
  /** What a cold cache adds to the next request; null when nothing is cached. */
  at_risk: string | null
  /** The cache has already gone cold: the next prompt pays `at_risk`. */
  cold: boolean
  /** The tighter of the daily and session limits; null when no budget is set. */
  budget: { kind: 'session' | 'daily' | 'task', left: string, limit: string, used_pct: number,
    steps_left: number | null, over: boolean } | null
  /** The single change that saves most over the forecast. */
  tip: { action: string, saves: string, why: string, kind: 'warm' | 'clear' | 'compact' | 'model' } | null
  /** What pennywise saved this session, net of its hand-offs; null when nothing yet. */
  saved?: string | null
}

/** The pane's open tab (hooks/pane.tsx). */
export type PaneTab = 'now' | 'ahead' | 'advice'

declare module 'claude-code' {
  interface PluginState {
    tokenomics: { line: Line | null, paneTab: PaneTab }
  }
}
