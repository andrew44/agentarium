// The agentarium pane: the session's numbers and what to do about them, in a pane beside the transcript
// (a mod: see https://code.claude.com/docs/en/plugins/mods/interface#build-a-pane-with-tabs).
// Three tabs, hotkeys 1-3 once the pane has the keys:
//   * Now: model, context fill, tokens, spend and the cache countdown.
//   * Ahead: the outlook. The next step and the next steps' forecast, the budget left, what a cold
//     cache adds and what pennywise has saved.
//   * Advice: every change worth making right now, the most urgent first.
// Minimised to a widget in the desktop app it shows a glance: spend, context and the top advice.
// The numbers are the band's (hooks/band.tsx writes `line` from statusline.ts --json), so the pane,
// the band and the CLI status line always agree. band.tsx, the plugin's one hooks module, calls
// registerPane and startPane.
// Usage:
//   /agentarium-pane         open it, in any surface, the terminal included
// Opens by itself in the desktop and mobile apps, until you close it by hand; /agentarium-pane
// brings it back for good. The apps start the session through the SDK and attach a moment later,
// so session.start sees no surface there: the pane opens when the app attaches (session.attach).
// The app decides whether it draws a pane, and an app that doesn't report its layout to Claude
// Code never does: then /agentarium-pane says why, and so does one transcript line if a pane it
// opened unasked is still undrawn after 10s (the band has the same numbers meanwhile).
// AGENTARIUM_BAND=off (or --band-off) turns the numbers off for the pane too, since statusline.ts
// makes them.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { Line, PaneTab } from '../types'
import { budgetLevel, budgetText, THEME, timer, tipAction } from './lens'
import type { Level, Timer } from './lens'

const PANE = 'agentarium'
const TITLE = 'Agentarium'
const COMMAND = 'agentarium-pane'
const CLOSED = 'pane.closed'      // $.store: the person closed it, so don't open it unasked again

const line = atom({ plugin: 'agentarium', key: 'line' } as const, null)
const tab = atom({ plugin: 'agentarium', key: 'paneTab' } as const, 'now')

const TABS: { id: PaneTab, label: string, hotkey: string }[] = [
  { id: 'now', label: 'Now', hotkey: '1' },
  { id: 'ahead', label: 'Ahead', hotkey: '2' },
  { id: 'advice', label: 'Advice', hotkey: '3' },
]

// The app says how it lays panes out a moment after it attaches, and the engine seats a waiting
// pane then: only one still waiting after this long is worth telling the person about.
const WAIT_MS = 10_000

let isOpen = false
let waiting: { since: number, reason: string } | null = null   // opened unasked, not drawn yet
let toldWaiting = false

/** One piece of advice: how urgent, what to do, and why. `tip` marks the outlook's own saving. */
export type Advice = { level: Level | 'tip', title: string, detail: string }

const URGENCY: Record<Advice['level'], number> = { red: 0, tip: 1, yellow: 2, green: 3 }

/** Every change worth making now, the most urgent first. Empty: nothing to change. */
export function advise(b: Line, t: Timer): Advice[] {
  const out: Advice[] = []
  const o = b.outlook
  const pct = Math.round(b.pct ?? 0)
  const tipKind = o?.tip?.kind

  // the outlook's tip already prices a /clear or /compact: don't say it twice
  if (tipKind !== 'compact' && tipKind !== 'clear') {
    if (b.level === 'red') {
      out.push({ level: 'red', title: 'Compact now',
        detail: `Context is ${pct}% full. /compact <what to keep>, or /clear (doggybag keeps your place).` })
    } else if (b.level === 'yellow') {
      out.push({ level: 'yellow', title: 'Context filling up',
        detail: `${pct}% full: finish this task, then /clear before the next one.` })
    }
  }

  if (o?.at_risk) {
    if (t.caption === 'cache cold') {
      out.push({ level: 'red', title: 'Cache is cold',
        detail: `The next prompt re-reads the whole context: +${o.at_risk}. Put your next few asks in one prompt.` })
    } else if (t.level && t.level !== 'green' && tipKind !== 'warm') {
      out.push({ level: 'yellow', title: 'Keep the cache warm',
        detail: `Reply within ${t.text}, or the next prompt costs ${o.at_risk} more.` })
    }
  }

  if (o?.budget) {
    const bt = budgetText(o)
    const tone = budgetLevel(o)
    if (tone === 'red') {
      out.push({ level: 'red', title: 'Over budget',
        detail: `${bt.figure} (${bt.caption}). agentarium profile frugal routes down harder.` })
    } else if (tone === 'yellow') {
      out.push({ level: 'yellow', title: 'Budget running low',
        detail: `${bt.figure}, ${bt.caption.replace(/^budget /, '')}, against ~${o.forecast} for the next ${o.steps} steps.` })
    }
  }

  if (o?.tip) {
    const action = tipAction(o, t)
    if (action) out.push({ level: 'tip', title: action, detail: `Saves ~${o.tip.saves}: ${o.tip.why}` })
  }

  if (o?.saved) out.push({ level: 'green', title: `pennywise saved ${o.saved}`, detail: 'This session, net of its hand-offs.' })

  return out.sort((a, b) => URGENCY[a.level] - URGENCY[b.level])
}

/** The pane's part of session.start (band.tsx's hook calls it: one such hook per plugin). */
export async function startPane($: EngineInterface, surface: string | null) {
  await $.command.register({ name: COMMAND, description: 'Show the session\'s numbers and advice in a pane' })
  // an app that attached before this plugin started raises no session.attach for it
  const where = surface ?? (await $.session.surfaces())[0] ?? null
  if (where) await openUnasked($, where)
  // the band redraws each second in the apps; in the terminal the pane keeps its own countdown
  $.clock.every(1000, async () => {
    if (!isOpen) return
    await tellIfUndrawn($)
    const surfaces = await $.session.surfaces()
    if (surfaces.every(s => s === 'terminal')) $.ui.invalidate('ui.render')
  })
}

// unasked only where it is a sidebar, and never again once the person closed it
async function openUnasked($: EngineInterface, surface: string) {
  if (isOpen || (surface !== 'desktop' && surface !== 'mobile')) return
  if (await $.store.get(CLOSED)) {
    $.ui.log(`agentarium pane: closed by hand before, so not opened unasked (/${COMMAND} brings it back)`, { to: 'debug' })
    return
  }
  const placed = await open($)
  if (!placed.isPlaced) {
    $.ui.log(`agentarium pane: opened, not drawn yet: ${placed.reason}`, { to: 'debug' })
    waiting = { since: await $.clock.now(), reason: placed.reason }
  }
}

/** Once a session: the pane opened unasked and the app still isn't drawing it. */
async function tellIfUndrawn($: EngineInterface) {
  if (!waiting || (await $.clock.now()) - waiting.since < WAIT_MS) return
  const { reason } = waiting
  waiting = null
  const pane = (await $.ui.panes()).find(one => one.id === PANE)
  if (!pane || pane.isPlaced || toldWaiting) return
  toldWaiting = true
  $.ui.log(`agentarium: the pane is open but this app isn't drawing it (${reason}). ` +
    `agentarium's row in the band above the prompt box shows the same numbers; an update of the app may bring the pane.`)
}

async function open($: EngineInterface) {
  const placed = await $.ui.open({ id: PANE, title: TITLE })
  isOpen = true
  return placed
}

/** Adds the pane's hooks. Called from band.tsx's register: a plugin has one hooks module. */
export function registerPane(on: On) {
  isOpen = false
  waiting = null
  toldWaiting = false

  on('command.run', { command: COMMAND }, async $ => {
    await $.store.delete(CLOSED)
    const placed = await open($)
    waiting = null                 // asked: this reply says it, the timer needn't
    if (placed.isPlaced) return { text: 'Agentarium pane opened.' }
    return { text: `Agentarium pane opened, but nothing here draws it yet: ${placed.reason}. ` +
      'agentarium\'s row in the band above the prompt box (in a terminal, the status line) shows the same numbers.' }
  })

  // the desktop and mobile apps attach after session.start, which saw no surface
  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    void openUnasked($, e.surface).catch(err => $.ui.log(`agentarium pane: ${String(err)}`, { to: 'debug' }))
    return attached
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    isOpen = false
    if (e.origin.kind === 'person') await $.store.set(CLOSED, true)
    return closed
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Progress } = $.ui.resolve(e)
    const b = await read($, line)
    const current = await read($, tab)
    const t = b ? timer(b, (await $.clock.now()) / 1000) : null
    const wide = (e.props.bodyColumns ?? 40) >= 56

    const muted = (text: string) => <Text dimColor>{text}</Text>
    const colour = (level: Level | undefined) => (level && level !== 'green' ? THEME[level] : undefined)

    // A card: a caption over its figure, in a rounded border.
    const card = (key: string, caption: string, figure: JSX.Element, foot?: JSX.Element | null) => (
      <Box key={key} flexDirection="column" borderStyle="round" borderDimColor paddingX="sm"
        flexGrow={1} minWidth={wide ? 18 : undefined}>
        <Text size="caption" dimColor>{caption}</Text>
        {figure}
        {foot}
      </Box>
    )
    const figure = (text: string, color?: string) =>
      <Text size="heading" weight="semibold" tabular color={color}>{text}</Text>

    if (!b || !t) return <Box padding="sm">{muted('Waiting for the first numbers: they arrive after the first reply.')}</Box>
    if (!b.show) {
      return (
        <Box flexDirection="column" padding="sm" gap="xs">
          <Text>The numbers are off.</Text>
          {muted('agentarium statusline --band-on (or AGENTARIUM_BAND=on) brings them back.')}
        </Box>
      )
    }

    const pct = Math.round(b.pct ?? 0)
    const level: Level = b.level ?? 'green'
    const estimated = (b.cost ?? '').startsWith('~')
    const cost = estimated ? (b.cost ?? '').slice(1) : b.cost ?? ''
    const tips = advise(b, t)
    const urgent = tips.filter(a => a.level === 'red').length

    const adviceRow = (a: Advice, i: number) => {
      const mark = a.level === 'tip' ? '→' : a.level === 'green' ? '✓' : a.level === 'red' ? '▲' : '●'
      const color = a.level === 'tip' ? 'claude' : a.level === 'green' ? THEME.green : THEME[a.level]
      return (
        <Box key={`advice-${i}`} flexDirection="row" gap="sm">
          <Text color={color} weight="bold">{mark}</Text>
          <Box flexDirection="column" flexShrink={1}>
            <Text weight="semibold" color={a.level === 'red' ? THEME.red : undefined}>{a.title}</Text>
            <Text size="footnote" dimColor>{a.detail}</Text>
          </Box>
        </Box>
      )
    }

    // Minimised in the desktop app: spend, context and the one thing to do.
    if (e.props.placement === 'widget') {
      const top = tips[0]
      return (
        <Box flexDirection="column" gap="xs" padding="xs">
          <Box flexDirection="row" gap="md" alignItems="center">
            <Text weight="semibold" tabular>{cost}</Text>
            <Text tabular color={colour(level)}>{pct}% ctx</Text>
            <Text tabular color={colour(t.level)} dimColor={!t.level}>{t.icon} {t.text}</Text>
          </Box>
          {top ? <Text size="footnote" color={top.level === 'red' ? THEME.red : undefined}>{top.title}</Text>
            : muted('Nothing to change.')}
        </Box>
      )
    }

    const now = () => (
      <Box flexDirection="column" gap="sm">
        <Box flexDirection="row" alignItems="center" gap="sm">
          <Text color="claude" weight="bold">✦</Text>
          <Text weight="semibold">{b.model ?? ''}</Text>
        </Box>
        <Box flexDirection="row" flexWrap="wrap" gap="sm">
          {card('spent', estimated ? 'spent · est.' : 'spent', figure(cost))}
          {card('tokens', 'tokens', figure(b.tokens ?? ''))}
        </Box>
        {card('context', level === 'red' ? 'context · compact soon' : level === 'yellow' ? 'context · filling up' : 'context window',
          figure(`${pct}%`, colour(level)),
          <Progress label="Context window" value={pct} max={100} valueText={`${pct}% full`} color={THEME[level]} />)}
        {card('cache', t.caption, figure(t.text, colour(t.level)),
          b.cold_at == null ? muted('Starts with the first reply.')
            : <Progress label="Prompt cache" value={t.frac} valueText={`${t.text} left`}
              color={t.level ? THEME[t.level] : undefined} />)}
      </Box>
    )

    const ahead = () => {
      const o = b.outlook
      if (!o) return <Box padding="sm">{muted('No forecast yet: it starts once there is context to forecast from.')}</Box>
      const bt = o.budget && budgetText(o)
      const tone = budgetLevel(o)
      return (
        <Box flexDirection="column" gap="sm">
          <Box flexDirection="row" flexWrap="wrap" gap="sm">
            {card('step', 'next step · cache warm', figure(o.step))}
            {card('forecast', `next ${o.steps} steps`, figure(o.forecast))}
          </Box>
          {o.budget && bt && card('budget', bt.caption, figure(bt.figure, colour(tone)),
            <Progress label="Budget used" value={Math.min(100, o.budget.used_pct)} max={100}
              valueText={`${Math.round(o.budget.used_pct)}% used`} color={tone ? THEME[tone] : THEME.green} />)}
          {!o.budget && card('budget', 'budget', figure('none set'),
            muted('Set AGENTARIUM_BUDGET_SESSION or _DAILY (e.g. 5) to count one down here.'))}
          <Box flexDirection="row" flexWrap="wrap" gap="sm">
            {o.at_risk && card('risk', o.cold ? 'cache cold · next prompt' : 'if the cache goes cold',
              figure(o.cold ? `+${o.at_risk}` : o.at_risk, o.cold ? THEME.red : colour(t.level)))}
            {card('saved', 'saved by pennywise', figure(o.saved ?? 'nothing yet', o.saved ? THEME.green : undefined))}
          </Box>
        </Box>
      )
    }

    const advice = () => (
      <Box flexDirection="column" gap="sm">
        {tips.length ? tips.map(adviceRow)
          : adviceRow({ level: 'green', title: 'Nothing to change', detail: 'Context, cache and budget all look fine. Carry on.' }, 0)}
      </Box>
    )

    return (
      <Box flexDirection="column" gap="sm" paddingX="xs">
        <Box flexDirection="row" flexWrap="wrap" gap="xs">
          {TABS.map(one => (
            <Button key={`tab-${one.id}`} hotkey={one.hotkey}
              variant={one.id === current ? 'primary' : 'secondary'} dimColor={one.id !== current}
              onPress={() => update($, tab, () => one.id)}>
              {one.id === 'advice' && urgent ? `${one.label} (${urgent})` : one.label}
            </Button>
          ))}
        </Box>
        {current === 'ahead' ? ahead() : current === 'advice' ? advice() : now()}
      </Box>
    )
  })
}
