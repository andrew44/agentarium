// claude plugin test .   (the pane of hooks/pane.tsx, drawn from the band's numbers)
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// What the pane reads: the band's `line`, as the engine's store would answer it, and the clock.
// Its own tab is left to the kit's store, so a press really switches it.
function seed(on: On, values: { line?: unknown, now?: number }) {
  on('state.get', (_, e, next) => (e.key === 'line' ? { value: { value: values.line, version: 1 } } : next(e)))
  on('clock.now', () => ({ value: (values.now ?? 0) * 1000 }))
}

const PANE = {
  plugin: 'agentarium',
  component: 'Pane',
  requestId: 'agentarium',
  props: {
    title: 'Agentarium', isFocused: false, bodyColumns: 60, placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 }, view: {},
  },
} as const

const OUTLOOK = {
  step: '£0.04', forecast: '£0.42', steps: 10, at_risk: '£0.31', cold: false,
  budget: { kind: 'session', left: '£0.90', limit: '£5.00', used_pct: 82, steps_left: 8, over: false },
  tip: { action: '/compact', saves: '£0.20', why: 'the context is 79% full', kind: 'compact' },
  saved: '£0.12',
} as const

const LINE = {
  show: true, model: 'claude-opus-5-5', pct: 79.5, level: 'yellow', gauge: '━━━━━━━━━╸──',
  tokens: '4.1M', cost: '~£1.46', ttl: 300, cold_at: 1_000_120, icons: ['F', 'H', 'E'], outlook: OUTLOOK,
} as const

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

test('Now: model, context, tokens, spend and the cache countdown, on every surface', async ($, on) => {
  seed(on, { line: LINE, now: 1_000_000 })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /claude-opus-5-5/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^80%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /context · filling up/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^4\.1M$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^£1\.46$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^02:00$/ })).toBeDefined()
    expect(await ui.find({ text: /Context window/ })).toBeDefined()           // the Progress bars
    expect(await ui.find({ text: /Prompt cache/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the tabs switch on a press, and Advice counts what is urgent', async ($, on) => {
  seed(on, { line: { ...LINE, pct: 93, level: 'red', outlook: { ...OUTLOOK, tip: null } }, now: 1_000_000 })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab-ahead' })
    expect(await ui.find({ type: 'Text', text: /next 10 steps/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^£0\.42$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^£0\.90 left$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^£0\.12$/ })).toBeDefined()
    await ui.press({ key: 'tab-advice' })
    expect(await ui.find({ type: 'Text', text: /^Compact now$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Budget running low$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /sommelier saved £0\.12/ })).toBeDefined()
    await ui.press({ key: 'tab-now' })
    await ui.unmount()
  }
})

test('Advice: the outlook tip is not repeated, a cold cache comes first', async ($, on) => {
  seed(on, { line: { ...LINE, cold_at: 999_000, outlook: { ...OUTLOOK, cold: true } }, now: 1_000_000 })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-advice' })
  const titles = (await ui.findAll({ type: 'Text', text: /^(Cache is cold|\/compact|Context filling up|Budget running low)$/ }))
    .map(t => t.text)
  expect(titles).toEqual(['Cache is cold', '/compact', 'Budget running low'])  // the compact tip covers the context
  await ui.unmount()
})

test('Advice with nothing to change says so', async ($, on) => {
  seed(on, { line: { ...LINE, pct: 20, level: 'green', cold_at: 1_000_290, outlook: null }, now: 1_000_000 })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-advice' })
  expect(await ui.find({ type: 'Text', text: /^Nothing to change$/ })).toBeDefined()
  await ui.unmount()
})

test('minimised to a widget: spend, context and the top advice', async ($, on) => {
  seed(on, { line: { ...LINE, pct: 93, level: 'red', outlook: null }, now: 1_000_000 })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, placement: 'widget' } })
  expect(await ui.find({ type: 'Text', text: /^93% ctx$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Compact now$/ })).toBeDefined()
  expect(await ui.find({ type: 'Button' })).toBeUndefined()                 // no tabs in a glance
  await ui.unmount()
})

test('before the numbers arrive it says so', async ($, on) => {
  seed(on, {})
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Waiting for the first numbers/ })).toBeDefined()
  await ui.unmount()
})

test('with the numbers turned off (--band-off) it says how to bring them back', async ($, on) => {
  seed(on, { line: { show: false } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /The numbers are off/ })).toBeDefined()
  await ui.unmount()
})

// The engine beneath session.start and the command: records opens and what the store holds.
// `surfaces` is the roster $.session.surfaces() reads: a test changes it as an app attaches.
function engine(on: On, store: Record<string, unknown> = {}, surfaces: string[] = ['desktop'],
  placed: { isPlaced: true } | { isPlaced: false, reason: string } = { isPlaced: true }) {
  const opened: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: [...surfaces] as ('terminal' | 'desktop' | 'vscode' | 'mobile')[] }))
  on('session.id', () => ({ value: 's1' }))
  on('session.info', () => ({ value: { transcriptPath: '/t/s1.jsonl' } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { tokens: 1, window: 200_000, percent: 0 } } }))
  on('process.hookEnv', () => ({ value: {} }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '{"show":false}', stderr: '',
    isStdoutTruncated: false, isStderrTruncated: false } }))
  on('command.register', () => ({ value: { command: 'agentarium-pane' } }))
  on('ui.open', (_, e) => { opened.push(e.id); return { value: placed } })
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => { store[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_, e) => { delete store[e.key]; return { value: undefined } })
  return { opened, store }
}

test('opens by itself in the desktop app; the command opens it and forgets a close by hand', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const { opened, store } = engine(on, { 'pane.closed': false })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(10)
  expect(opened).toEqual(['agentarium'])

  store['pane.closed'] = true                            // as a close by hand leaves it
  await $.command.run({ command: 'agentarium-pane', args: '', origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 } })
  expect(store['pane.closed']).toBeUndefined()
  expect(opened).toEqual(['agentarium', 'agentarium'])
})

test('closed by hand last time: no pane unasked', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const { opened } = engine(on, { 'pane.closed': true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(10)
  expect(opened).toEqual([])
})

test('in the desktop app it opens when the app attaches, after a start with no surface', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const surfaces: string[] = []
  const { opened } = engine(on, { 'pane.closed': false }, surfaces)
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await clock.advance(10)
  expect(opened).toEqual([])
  surfaces.push('desktop')
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await clock.advance(10)
  expect(opened).toEqual(['agentarium'])
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:second' })
  await clock.advance(10)
  expect(opened).toEqual(['agentarium'])                 // once, not per client
})

test('an attach after a close by hand opens nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const { opened } = engine(on, { 'pane.closed': true })
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await clock.advance(10)
  expect(opened).toEqual([])
})

test('the terminal opens it only when asked', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const { opened } = engine(on, {}, ['terminal', 'desktop'])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(10)
  expect(opened).toEqual([])
})

test('an app that attached before the start still gets the pane', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const { opened } = engine(on, { 'pane.closed': false }, ['desktop'])
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await clock.advance(10)
  expect(opened).toEqual(['agentarium'])
})

// An app that never says how it lays panes out: the engine opens the pane but nothing draws it.
const UNDRAWN = 'no attached surface places panes (desktop:default)'

function undrawn(on: On, logs: { text: string, to: string }[], isPlacedLater = false) {
  on('ui.panes', () => ({ value: [{ id: 'agentarium', title: 'Agentarium', isShown: isPlacedLater,
    isFocused: false, isPlaced: isPlacedLater }] }))
  on('ui.log', (_, e) => { logs.push({ text: e.text, to: e.to }); return { value: undefined } })
}

test('the command says why when the app does not draw the pane', async ($, on) => {
  const logs: { text: string, to: string }[] = []
  engine(on, {}, ['desktop'], { isPlaced: false, reason: UNDRAWN })
  undrawn(on, logs)
  const { text } = await $.command.run({ command: 'agentarium-pane', args: '', origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 } })
  expect(text).toContain('nothing here draws it yet')
  expect(text).toContain(UNDRAWN)
})

test('opened unasked and still undrawn after 10s: says so once in the transcript', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const logs: { text: string, to: string }[] = []
  engine(on, { 'pane.closed': false }, ['desktop'], { isPlaced: false, reason: UNDRAWN })
  undrawn(on, logs)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(5_000)
  expect(logs.filter(l => l.to === 'transcript')).toEqual([])
  expect(logs.some(l => l.to === 'debug' && l.text.includes(UNDRAWN))).toBe(true)
  await clock.advance(10_000)
  const said = logs.filter(l => l.to === 'transcript')
  expect(said.length).toBe(1)
  expect(said[0]?.text).toContain('this app isn\'t drawing it')
  await clock.advance(30_000)
  expect(logs.filter(l => l.to === 'transcript').length).toBe(1)
})

test('drawn once the app reports its layout: nothing said', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const logs: { text: string, to: string }[] = []
  engine(on, { 'pane.closed': false }, ['desktop'], { isPlaced: false, reason: UNDRAWN })
  undrawn(on, logs, true)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(20_000)
  expect(logs.filter(l => l.to === 'transcript')).toEqual([])
})
