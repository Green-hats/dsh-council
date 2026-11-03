import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import * as React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { modelReturnSchema } from '../src/context-types.js'
import { councilResultV2Schema } from '../src/run-records.js'
import { renderModelReturn } from '../src/handoff.js'

// Only public service/slot boundaries are faked. Components and hooks run on
// real React 18; there is no simulated Harness DOM, raw event stream, or HTML preview.
type Bag = Record<string, any>
type Definition = Bag & { kind: string; match: Record<string, (event: Bag) => Bag | null> }
type Entry = { options: Bag; component: React.ComponentType<Bag>; active: boolean }
class Source<T> {
  listeners = new Set<() => void>()
  constructor(public value: T) {}
  getSnapshot = (): T => this.value
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  publish(value: T): void {
    this.value = value
    for (const listener of this.listeners) listener()
  }
}
const openBinding = (change: Bag = {}): Bag => ({ session: new Source({ openState: 'open' }), ...change })
function load() {
  let descriptor: Bag | undefined
  const requires: string[] = []
  runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: (value: Bag) => { descriptor = value } } }, URL, TextEncoder,
  }, { filename: 'client.js' })
  const module = descriptor!.factory((id: string) => {
    requires.push(id)
    if (id !== 'react') throw new Error(`Unexpected runtime dependency: ${id}`)
    return React
  }) as { inject: string[]; apply: (ctx: Bag) => void }
  return { descriptor: descriptor!, module, requires }
}
function harness(overrides: Bag = {}) {
  const loaded = load()
  const definitions: Definition[] = []
  const entries: Entry[] = []
  const effects: Array<() => void> = []
  const slotCleanups: Array<() => void> = []
  let dictionaries: Bag = {}
  const ctx: Bag = {
    effect: (effect: () => (() => void)) => { effects.push(effect()) },
    locale: { register: (_namespace: string, values: Bag) => { dictionaries = values; return vi.fn() } },
    uiConversation: {
      events: { register: (definition: Definition) => { definitions.push(definition); return vi.fn() } },
      binding: vi.fn(),
    },
    sessions: { retain: vi.fn() },
    slots: {
      register: (options: Bag, component: React.ComponentType<Bag>) => {
        const entry = { options, component, active: true }
        entries.push(entry)
        return () => { entry.active = false }
      },
      inject: (_slot: string, callback: () => unknown) => {
        const result = callback()
        if (typeof result === 'function') slotCleanups.push(result as () => void)
        else if (result && Symbol.iterator in Object(result)) {
          for (const dispose of result as Iterable<() => void>) slotCleanups.push(dispose)
        }
      },
    },
    ...overrides,
  }
  loaded.module.apply(ctx)
  const t = (key: string, values: Bag = {}, language = 'en'): string => {
    const template = dictionaries[language]?.[key] ?? key
    return template.replace(/\{(\w+)\}/g, (_match: string, name: string) => String(values[name] ?? ''))
  }
  const component = (key: string): React.ComponentType<Bag> => entries.find(entry => entry.options.key === key)!.component
  const definition = (kind: string): Definition => definitions.find(value => value.kind === kind)!
  return { ...loaded, ctx, definitions, entries, t, component, definition, effects, slotCleanups, dictionaries }
}
const participant = (change: Bag = {}): Bag => ({ key: 'answer:1', stage: 'answer', index: 1, status: 'queued', ...change })
const snapshot = (change: Bag = {}): Bag => ({ version: 1, commandId: 'command-1', status: 'running', question: 'Question', participants: [participant()], ...change })
function progress(ui = snapshot(), seq = 2, type = 'agent/inbox/spliced'): Bag {
  const message = { content: [], source: { kind: 'dsh-council', ui } }
  return { type, seq, time: 100, data: type === 'user/message' ? message : { inserted: [message] } }
}
function question(change: Bag = {}, seq = 1, type = 'agent/inbox/spliced'): Bag {
  const message = { content: [{ type: 'text', text: 'Original question' }], source: { kind: 'dsh-council',
    question: { version: 1, commandId: 'command-1', text: 'Original question', ...change } } }
  return { type, seq, time: 90, data: type === 'user/message' ? message : { inserted: [message] } }
}
function inbox(event: Bag): Bag { return { ...event, type: 'agent/inbox/spliced', data: { inserted: [event.data] } } }
function answer(change: Bag = {}, seq = 20): Bag {
  return { type: 'user/message', seq, time: 200, data: { content: [{ type: 'text', text: '**Council answer**' }],
    source: { kind: 'dsh-council', result: { version: 1, commandId: 'command-1', status: 'success', ...change } } } }
}
const packetHash = 'sha256:' + 'a'.repeat(64)
function modelReturn(change: Bag = {}): Bag {
  return { version: 1, runId: 'command-1', packetHash, answerMarkdown: '**Decision**\n## 审计\nThis heading is part of the answer.\n## Ranking\nKeep this too.',
    decisionDeltas: [{ sourceAliases: ['S1', 'S3'], disposition: 'revised', text: 'Use the corrected deadline.' }],
    consensus: ['Shared conclusion'], contradictions: ['Unresolved disagreement'], blindSpots: ['Missing measurement'],
    confidenceNotes: 'Limited supporting evidence.', citations: [{ sourceAliases: ['S3'], verification: 'reported' }],
    coverage: { answerersRequested: 3, answerersSucceeded: 2, reviewersRequested: 2, reviewersSucceeded: 1 },
    limitations: ['Surface-only background; pending material may be missing.'], ...change }
}
function answerV2(change: Bag = {}, seq = 20): Bag {
  const value = modelReturn()
  const event = answer({ version: 2, runId: 'command-1', parentSessionId: 'parent-1', mode: 'chat', locale: 'en', modelReturn: value,
    presentation: { answerMarkdown: value.answerMarkdown, auditMarkdown: 'FULL_AUDIT_ONLY\nPRIVATE_MODEL_MAPPING' }, ...change }, seq)
  const parsed = councilResultV2Schema.safeParse(event.data.source.result)
  event.data.content[0].text = parsed.success && parsed.data.status === 'success'
    ? renderModelReturn(parsed.data.modelReturn, parsed.data.locale) : renderModelReturn(modelReturnSchema.parse(value), 'en')
  return event
}
function matchOf(definition: Definition, event: Bag): Bag | null {
  return definition.match[event.type]?.(event) ?? null
}
function start(definition: Definition, event: Bag): Bag {
  const identity = matchOf(definition, event)!
  const match = { event, role: 'start', location: { kind: 'session' } }
  const context = { key: definition.kind + ':' + identity.id, kind: definition.kind, id: identity.id, start: match, matches: [match] }
  return { ...context, state: definition.start(context, match) }
}
function propsFor(t: (key: string, values?: Bag) => string, node: Bag, session = new Source({ sessionId: 'parent-1' })): Bag {
  return { node, t,
    useSession: (select: (value: Bag) => unknown) => select(React.useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)),
    renderFactorySlot: vi.fn((name: string, input: Bag) => React.createElement('pre', { 'data-factory': name }, input.text)),
  }
}
function textOf(renderer: ReactTestRenderer): string { return JSON.stringify(renderer.toJSON()) }

describe('Council Client lazy factory and exact Conversation definitions', () => {
  it('requires only the browser React, registers owned slots, and disposes every slot contribution', () => {
    const test = harness()
    expect(test.descriptor.id).toBe('@greenhats/dsh-council')
    expect(test.requires).toEqual(['react'])
    expect(test.module.inject).toEqual(['slots', 'uiConversation', 'sessions', 'locale'])
    expect(test.definitions.map(value => value.kind)).toEqual(['dsh-council-question', 'dsh-council-progress', 'dsh-council-answer'])
    expect(test.entries.map(value => value.options.key)).toEqual(['dsh-council-question', 'dsh-council-progress', 'dsh-council-answer', 'council'])
    expect(test.entries.every(value => value.options.locale === 'dsh-council')).toBe(true)
    expect(Object.keys(test.dictionaries.en).sort()).toEqual(Object.keys(test.dictionaries.zh).sort())
    expect(test.slotCleanups).toHaveLength(4)
    for (const dispose of test.slotCleanups) dispose()
    expect(test.entries.every(value => !value.active)).toBe(true)
    expect(test.effects).toHaveLength(4)
    for (const dispose of test.effects) dispose()
  })

  it('leaves an unsupported older Client untouched', () => {
    const test = harness({ uiConversation: { events: {} } })
    expect(test.definitions).toHaveLength(0)
    expect(test.entries).toHaveLength(0)
    expect(test.effects).toHaveLength(0)
  })

  it('claims only valid explicitly marked progress, never command/done or ordinary messages', () => {
    const definition = harness().definition('dsh-council-progress')
    for (const event of [
      { type: 'command/done', data: { commandId: 'command-1', name: 'council' } },
      { type: 'command/done', data: { commandId: 'other', name: 'something-else' } },
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'council' }] } },
      progress(snapshot({ version: 2 })), progress(snapshot({ status: 'mystery' })),
      progress(snapshot({ participants: [participant({ index: 0 })] })),
      progress(snapshot({ participants: [participant(), participant()] })),
      { type: 'user/message', data: { source: { kind: 'another-plugin', ui: snapshot() } } },
    ]) expect(matchOf(definition, event)).toBeNull()
    expect(matchOf(definition, progress())).toEqual({ id: '["command-1","progress"]', role: 'start', exclusive: true })
  })

  it('updates a strict full snapshot without rolling back on context admission', () => {
    const definition = harness().definition('dsh-council-progress')
    let context = start(definition, progress(snapshot(), 2))
    const latest = snapshot({ status: 'success', participants: [participant({ status: 'completed', childId: 'child-1' })] })
    context.state = definition.update(context, { event: progress(latest, 9) })
    const state = context.state
    context.state = definition.update(context, { event: progress(snapshot(), 10, 'user/message') })
    expect(context.state).toBe(state)
    const node = definition.buildViewNode(context)
    expect(node).toMatchObject({ target: 'chat', kind: 'dsh-council-progress', anchorSeq: 2, visibility: 'visible',
      data: { status: 'success', participants: [{ key: 'answer:1', stage: 'answer', index: 1, status: 'completed', childId: 'child-1' }] } })
    expect(JSON.stringify(node)).not.toContain('secret')
    expect(node.kind).not.toBe('command') // Chat.isActive treats non-command rows as activity.
    const replay = start(definition, progress(latest, 9))
    expect(definition.buildViewNode(replay).data).toEqual(node.data)
    context.state = definition.update(context, { event: progress(snapshot({ participants: [] }), 11) })
    expect(definition.buildViewNode(context).data.participants).toEqual([])
  })

  it('can rebuild old admitted markers without child metadata, without inventing identities', () => {
    const definition = harness().definition('dsh-council-progress')
    const context = start(definition, progress(snapshot({ status: 'error' }), 5, 'user/message'))
    expect(definition.buildViewNode(context).data.participants[0].childId).toBeUndefined()
    context.state = definition.update(context, { event: progress(snapshot({ status: 'canceled' }), 7, 'user/message') })
    expect(definition.buildViewNode(context).data.status).toBe('canceled')
  })

  it('keeps inbox question → progress → result order and deduplicates their later admissions', () => {
    const test = harness()
    const cases = [
      { kind: 'dsh-council-question', event: question(), admitted: question({}, 30, 'user/message') },
      { kind: 'dsh-council-progress', event: progress(), admitted: progress(snapshot(), 31, 'user/message') },
      { kind: 'dsh-council-answer', event: inbox(answer({}, 20)), admitted: answer({}, 32) },
    ]
    const nodes: Bag[] = []
    for (const item of cases) {
      const definition = test.definition(item.kind)
      expect(matchOf(definition, item.event)).toEqual(matchOf(definition, item.admitted))
      expect(matchOf(definition, item.event)?.exclusive).toBe(true)
      const context = start(definition, item.event)
      const original = context.state
      context.state = definition.update(context, { event: item.admitted })
      expect(context.state).toBe(original)
      nodes.push(definition.buildViewNode(context))
      // A cold history window containing only admission can still reconstruct the same domain payload.
      expect(definition.buildViewNode(start(definition, item.admitted)).data).toEqual(nodes.at(-1)!.data)
      for (const other of cases) if (other.kind !== item.kind) expect(matchOf(definition, other.event)).toBeNull()
      for (const command of [
        { type: 'command/run', data: { commandId: 'command-1', name: 'council' } },
        { type: 'command/done', data: { commandId: 'other', name: 'other', outcome: { kind: 'success' } } },
      ]) expect(matchOf(definition, command)).toBeNull()
    }
    expect(nodes.map(node => node.kind)).toEqual(['dsh-council-question', 'dsh-council-progress', 'dsh-council-answer'])
    expect(nodes.map(node => node.anchorSeq)).toEqual([1, 2, 20])
    expect(new Set(nodes.map(node => node.key)).size).toBe(3)
    expect(nodes[0]!.data).toEqual({ commandId: 'command-1', text: 'Original question' })
    expect(nodes[2]!.data.text).toBe('**Council answer**')
  })

  it('requires the versioned original question source rather than guessing from content', () => {
    const definition = harness().definition('dsh-council-question')
    for (const event of [question({ version: 2 }), question({ commandId: '' }), question({ text: '  ' }),
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Original question' }] } },
      { type: 'user/message', data: { source: { kind: 'another-plugin', question: { version: 1, commandId: 'command-1', text: 'Question' } } } },
    ]) expect(matchOf(definition, event)).toBeNull()
    expect(matchOf(definition, question())).toEqual({ id: '["command-1","question"]', role: 'start', exclusive: true })
  })

  it('creates a separate non-command final row at its own event position', () => {
    const test = harness()
    const definition = test.definition('dsh-council-answer')
    const event = answer()
    expect(matchOf(definition, event)).toEqual({ id: '["command-1","answer"]', role: 'start', exclusive: true })
    const result = definition.buildViewNode(start(definition, event))
    expect(result).toMatchObject({ kind: 'dsh-council-answer', anchorSeq: 20, data: { commandId: 'command-1', text: '**Council answer**' } })
    const progressNode = test.definition('dsh-council-progress').buildViewNode(start(test.definition('dsh-council-progress'), progress()))
    expect(result.key).not.toBe(progressNode.key)
    expect(result.anchorSeq).toBeGreaterThan(progressNode.anchorSeq)
    const withPresentation = definition.buildViewNode(start(definition, answer({ presentation: {
      answerMarkdown: '**Decision**', auditMarkdown: '## Audit',
    } })))
    expect(withPresentation.data.presentation).toEqual({ answerMarkdown: '**Decision**', auditMarkdown: '## Audit' })
    expect(matchOf(definition, answer({ presentation: { answerMarkdown: '', auditMarkdown: 'Audit' } }))).toBeNull()
    for (const invalid of [answer({ version: 2 }), answer({ status: 'running' }), answer({ commandId: '' }),
      { ...event, type: 'assistant/message' },
      { ...event, data: { ...event.data, content: [{ type: 'text', text: '  ' }] } },
      { type: 'command/done', seq: 21, data: { commandId: 'other', name: 'other', outcome: { text: 'anything' } } },
    ]) expect(matchOf(definition, invalid)).toBeNull()
  })
})

describe('Council React rendering and child-reference ownership', () => {
  it('renders the original question as a right-aligned normal-font literal bubble', () => {
    const test = harness()
    const Question = test.component('dsh-council-question')
    const props = propsFor(test.t, { data: { commandId: 'command-1', text: '<script>literal only</script>\n**Original question**' } })
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(React.createElement(Question, props)) })
    const wrapper = renderer.root.findAllByType('div')[0]!
    const bubble = renderer.root.findAllByType('div')[1]!
    expect(wrapper.props.style.justifyContent).toBe('flex-end')
    expect(bubble.props.style.font).toBe('inherit')
    expect(bubble.props.style.whiteSpace).toBe('pre-wrap')
    expect(bubble.props.style.background).toBe('var(--dsw-alias-bg-layer-2)')
    expect(bubble.children).toEqual(['<script>literal only</script>\n**Original question**'])
    expect(props.renderFactorySlot).not.toHaveBeenCalled()
    expect(renderer.root.findAll(node => Object.hasOwn(node.props, 'dangerouslySetInnerHTML'))).toHaveLength(0)
    act(() => renderer.unmount())
  })

  it('uses the host Markdown factory for final answers and conservatively falls back for historical commands', () => {
    const test = harness()
    const Answer = test.component('dsh-council-answer')
    const answerProps = propsFor(test.t, { data: { text: '<script>not raw HTML</script> **answer**' } })
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(React.createElement(Answer, answerProps)) })
    expect(answerProps.renderFactorySlot).toHaveBeenCalledWith('conversation.chat.reasoning.content', {
      text: '<script>not raw HTML</script> **answer**', running: false,
    })
    expect(renderer.root.findAll(node => Object.hasOwn(node.props, 'dangerouslySetInnerHTML'))).toHaveLength(0)
    act(() => renderer.unmount())

    const Command = test.component('council')
    const commandProps = propsFor(test.t, { commandId: 'command-1', name: 'council', outcome: { kind: 'error', text: '**Historical error**' } })
    act(() => { renderer = create(React.createElement(Command, commandProps)) })
    expect(textOf(renderer)).toContain('Historical error')
    act(() => renderer.update(React.createElement(Command, { ...commandProps,
      node: { ...commandProps.node, outcome: { kind: 'success', sourceEventSeq: 20, text: 'duplicate' } } })))
    expect(textOf(renderer)).toContain('duplicate') // A source seq alone never proves a mounted result.
    const own = { kind: 'dsh-council-answer', data: { commandId: 'command-1', status: 'error', text: 'Presented failure' } }
    act(() => renderer.update(React.createElement(Command, { ...commandProps,
      useChat: (select: (chat: Bag) => unknown) => select({ order: ['answer'], nodes: { get: () => own } }) })))
    expect(renderer.toJSON()).toBeNull()
    const progressRow = { kind: 'dsh-council-progress', data: { commandId: 'command-1' } }
    act(() => renderer.update(React.createElement(Command, { ...commandProps, node: { ...commandProps.node, outcome: null },
      useChat: (select: (chat: Bag) => unknown) => select({ order: ['progress'], nodes: { get: () => progressRow } }) })))
    expect(textOf(renderer)).toContain('Running') // Progress alone must not swallow a pre-handoff error.
    act(() => renderer.update(React.createElement(Command, { ...commandProps,
      useChat: (select: (chat: Bag) => unknown) => select({ order: ['progress'], nodes: { get: () => ({ ...progressRow, data: { commandId: 'another-command' } }) } }) })))
    expect(textOf(renderer)).toContain('Historical error')
    act(() => renderer.unmount())
  })

  it('renders structured decisions normally and keeps structured audit Markdown folded until requested', () => {
    const test = harness()
    const Answer = test.component('dsh-council-answer')
    const props = propsFor(test.t, { data: { text: 'Canonical full result', presentation: {
      answerMarkdown: '**Decision only**', auditMarkdown: '## Private-by-default audit',
    } } })
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(React.createElement(Answer, props)) })
    expect(textOf(renderer)).toContain('Decision only')
    expect(textOf(renderer)).not.toContain('Canonical full result')
    expect(textOf(renderer)).not.toContain('Private-by-default audit')
    expect(renderer.root.findByType('details').props.open).toBe(false)
    act(() => renderer.root.findByType('details').props.onToggle({ currentTarget: { open: true } }))
    expect(textOf(renderer)).toContain('Private-by-default audit')
    expect(props.renderFactorySlot).toHaveBeenCalledWith('conversation.chat.reasoning.content', { text: '## Private-by-default audit', running: false })
    act(() => renderer.unmount())
  })

  it('retains only expanded children, streams derived keyed nodes, and releases on collapse/unmount', async () => {
    const test = harness()
    const Progress = test.component('dsh-council-progress')
    const nodeSource = new Source<Bag>({ key: 'assistant-1', kind: 'assistant-step', data: {
      status: 'running', blocks: [{ kind: 'reasoning', text: 'Public reasoning' }, { kind: 'text', text: 'Public text' }],
      providerMetadata: { model: 'PRIVATE MODEL' }, requestConfig: { provider: 'PRIVATE PROVIDER' },
    } })
    const chat = { order: ['assistant-1'], nodes: { get: () => nodeSource.value, source: () => nodeSource } }
    const target = new Source(chat)
    const binding = openBinding()
    const release = vi.fn()
    test.ctx.sessions.retain.mockReturnValue({ binding, ready: Promise.resolve(binding), release })
    test.ctx.uiConversation.binding.mockReturnValue({ target: vi.fn(() => target) })
    const props = propsFor(test.t, { data: snapshot({ participants: [participant({ status: 'running', childId: 'child-1' })] }) })
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(React.createElement(Progress, props)) })
    expect(test.ctx.sessions.retain).not.toHaveBeenCalled()
    expect(textOf(renderer)).toContain('Participant 1')
    expect(renderer.root.findByType('button').props['aria-label']).not.toContain('Answer A')
    await act(async () => { renderer.root.findByType('button').props.onClick(); await Promise.resolve() })
    expect(test.ctx.sessions.retain).toHaveBeenCalledExactlyOnceWith({ parentSessionId: 'parent-1', childSessionId: 'child-1', mode: 'continuable' }, { source: 'controllerOperation' })
    expect(test.ctx.uiConversation.binding).toHaveBeenCalledWith(binding)
    expect(target.listeners.size).toBe(1)
    expect(nodeSource.listeners.size).toBe(1)
    expect(textOf(renderer)).toContain('Public reasoning')
    expect(textOf(renderer)).toContain('Public text')
    expect(textOf(renderer)).not.toContain('PRIVATE')
    expect(props.renderFactorySlot).toHaveBeenCalledWith('conversation.chat.reasoning.content', { text: 'Public reasoning', running: true })
    act(() => nodeSource.publish({ ...nodeSource.value, data: { status: 'settled', blocks: [{ kind: 'text', text: 'Finished text only' }] } }))
    expect(textOf(renderer)).toContain('Finished text only')
    expect(textOf(renderer)).toContain('No public reasoning was provided')
    act(() => renderer.root.findByType('button').props.onClick())
    expect(release).toHaveBeenCalledTimes(1)
    expect(target.listeners.size).toBe(0)
    expect(nodeSource.listeners.size).toBe(0)
    await act(async () => { renderer.root.findByType('button').props.onClick(); await Promise.resolve() })
    expect(test.ctx.sessions.retain).toHaveBeenCalledTimes(2)
    act(() => renderer.unmount())
    expect(release).toHaveBeenCalledTimes(2)
    expect(target.listeners.size).toBe(0)
    expect(nodeSource.listeners.size).toBe(0)
  })

  it('automatically folds terminal progress and releases expanded children, while allowing later review', async () => {
    const test = harness()
    const Progress = test.component('dsh-council-progress')
    const target = new Source({ order: [], nodes: { get: () => undefined } })
    const release = vi.fn()
    test.ctx.sessions.retain.mockReturnValue({ binding: openBinding(), ready: Promise.resolve(), release })
    test.ctx.uiConversation.binding.mockReturnValue({ target: () => target })
    const ui = snapshot({ participants: [participant({ childId: 'child-1', status: 'running' })] })
    const props = propsFor(test.t, { data: ui })
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(React.createElement(Progress, props)) })
    expect(renderer.root.findByType('details').props.open).toBe(true)
    await act(async () => { renderer.root.findByType('button').props.onClick(); await Promise.resolve() })
    expect(release).not.toHaveBeenCalled()
    expect(target.listeners.size).toBe(1)
    act(() => renderer.update(React.createElement(Progress, { ...props, node: { data: { ...ui,
      status: 'success', participants: [participant({ childId: 'child-1', status: 'completed' })] } } })))
    expect(renderer.root.findByType('details').props.open).toBe(false)
    expect(textOf(renderer)).toContain('1/1 complete')
    expect(renderer.root.findAllByType('button')).toHaveLength(0)
    expect(release).toHaveBeenCalledOnce()
    expect(target.listeners.size).toBe(0)
    act(() => renderer.root.findByType('details').props.onToggle({ currentTarget: { open: true } }))
    expect(renderer.root.findAllByType('button')).toHaveLength(1)
    expect(test.ctx.sessions.retain).toHaveBeenCalledOnce() // No eager read even when reopening the process.
    act(() => renderer.unmount())
  })

  it('releases a pending acquisition and never subscribes after its view is gone', async () => {
    const test = harness()
    const Progress = test.component('dsh-council-progress')
    let settle!: () => void
    const ready = new Promise<void>(resolve => { settle = resolve })
    const release = vi.fn()
    test.ctx.sessions.retain.mockReturnValue({ binding: {}, ready, release })
    const props = propsFor(test.t, { data: snapshot({ participants: [participant({ childId: 'late-child' })] }) })
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(React.createElement(Progress, props)) })
    act(() => renderer.root.findByType('button').props.onClick())
    expect(textOf(renderer)).toContain('Loading public output')
    act(() => renderer.unmount())
    expect(release).toHaveBeenCalledTimes(1)
    await act(async () => { settle(); await ready })
    expect(test.ctx.uiConversation.binding).not.toHaveBeenCalled()
  })

  it('handles unavailable children and old logs without guessing attribution; terminal queued roles are not running', async () => {
    const test = harness()
    const Progress = test.component('dsh-council-progress')
    const release = vi.fn()
    test.ctx.sessions.retain.mockReturnValue({ binding: openBinding(), ready: Promise.reject(new Error('private host error')), release })
    const props = propsFor(test.t, { data: snapshot({ status: 'canceled', participants: [
      participant({ childId: 'missing-child', status: 'error', diagnostic: 'run-canceled' }),
      participant({ key: 'review:1', stage: 'review' }),
    ] }) })
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(React.createElement(Progress, props)) })
    expect(renderer.root.findByType('details').props.open).toBe(false)
    expect(renderer.root.findAllByType('button')).toHaveLength(0)
    act(() => renderer.root.findByType('details').props.onToggle({ currentTarget: { open: true } }))
    expect(textOf(renderer)).toContain('Not run')
    expect(textOf(renderer)).toContain('No child-session metadata was recorded')
    await act(async () => { renderer.root.findByType('button').props.onClick(); await Promise.resolve() })
    expect(textOf(renderer)).toContain('Public output is unavailable')
    expect(textOf(renderer)).not.toContain('private host error')
    act(() => renderer.unmount())
    expect(release).toHaveBeenCalledOnce()
  })
})

describe('Structured child stage output from shared Chat node sources', () => {
  const review = {
    evaluations: [{ answerId: 'Answer B', strengths: ['Review strength'], weaknesses: ['Review weakness'] }],
    ranking: ['Answer B'], consensus: ['Review consensus'], contradictions: ['Review contradiction'],
    coverageGaps: ['Review coverage gap'], uniqueInsights: [{ answerId: 'Answer B', insight: 'Review unique insight' }], blindSpots: ['Review blind spot'],
    providerMetadata: 'SECRET REVIEW MODEL', requestConfig: 'SECRET REVIEW CONFIG',
  }
  const arbiter = { answerMarkdown: '**Arbiter stage decision**', consensus: ['Arbiter consensus'],
    contradictions: ['Arbiter contradiction'], blindSpots: ['Arbiter blind spot'], confidenceNotes: 'Arbiter confidence',
    label: 'SECRET ARBITER LABEL', providerMetadata: 'SECRET ARBITER MODEL' }
  function guarded(root: Bag): Bag {
    Object.defineProperties(root, {
      args: { get() { throw new Error('PartialArguments must not be inspected') } },
      content: { get() { throw new Error('Opaque result content must not be inspected') } },
      subCalls: { get() { throw new Error('Recursive tool calls must not be inspected') } },
    })
    return root
  }
  function tool(root: Bag): Bag { return { kind: 'tool-call', data: { root }, providerMetadata: 'SECRET NODE MODEL' } }
  function childCache(id: string, root: Bag, preface?: string) {
    const sources = new Map<string, Source<Bag>>([[id + ':tool', new Source(tool(root))]])
    if (preface) sources.set(id + ':text', new Source({ kind: 'assistant-step', data: { status: 'settled',
      blocks: [{ kind: 'text', text: preface }], requestConfig: 'SECRET ASSISTANT CONFIG', providerMetadata: 'SECRET ASSISTANT MODEL' } }))
    const nodes = { get: (key: string) => sources.get(key)?.value, source: (key: string) => sources.get(key)! }
    const target = new Source({ order: [...sources.keys()], nodes })
    const binding = openBinding({ id })
    const release = vi.fn()
    const reference = { binding, ready: Promise.resolve(binding), release }
    return { sources, target, binding, reference, release,
      // Deliberately publish only this key: neither order nor target snapshot changes.
      update(next: Bag) { sources.get(id + ':tool')!.publish(tool(next)) } }
  }
  const subtreeText = (node: any): string => typeof node === 'string' ? node : node.children.map(subtreeText).join(' ')

  it('keeps interleaved review and arbitration in their own retained child bindings and releases independently', async () => {
    const test = harness()
    const reviewer = childCache('review-child', guarded({ name: 'structured_output', phase: 'preparing' }), 'Review public preface')
    const arbitrator = childCache('arbiter-child', guarded({ name: 'structured_output', phase: 'start', argsRaw: '{"answerMarkdown":' }), 'Arbiter public preface')
    const children = [reviewer, arbitrator]
    test.ctx.sessions.retain.mockImplementation((address: Bag) => children.find(child => child.binding.id === address.childSessionId)!.reference)
    test.ctx.uiConversation.binding.mockImplementation((binding: Bag) => ({ target: (name: string) => {
      expect(name).toBe('chat')
      return children.find(child => child.binding === binding)!.target
    } }))
    const Progress = test.component('dsh-council-progress')
    const Answer = test.component('dsh-council-answer')
    const props = propsFor(test.t, { data: snapshot({ participants: [
      participant({ key: 'review:1', stage: 'review', childId: 'review-child', status: 'running' }),
      participant({ key: 'arbiter:1', stage: 'arbiter', childId: 'arbiter-child', status: 'running' }),
    ] }) })
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(React.createElement(React.Fragment, null,
      React.createElement(Progress, props), React.createElement(Answer, propsFor(test.t, { data: { text: 'MAIN FINAL DISTINCT' } })))) })
    await act(async () => {
      for (const button of renderer.root.findAllByType('button')) button.props.onClick()
      await Promise.resolve()
    })
    expect(test.ctx.sessions.retain.mock.calls.map((call: Bag[]) => call[0]!.childSessionId)).toEqual(['review-child', 'arbiter-child'])
    const reviewSection = renderer.root.findAllByType('section').find(node => node.props['aria-label'] === 'Peer reviews')!
    const arbiterSection = renderer.root.findAllByType('section').find(node => node.props['aria-label'] === 'Arbitration')!
    expect(subtreeText(reviewSection)).toContain('Submitting peer review')
    expect(subtreeText(arbiterSection)).toContain('Submitting arbitration')
    expect(textOf(renderer)).not.toContain('No public output')
    expect(textOf(renderer)).not.toContain('No public reasoning')
    act(() => reviewer.update(guarded({ name: 'structured_output', phase: 'start', argsRaw: JSON.stringify(review) })))
    expect(subtreeText(reviewSection)).toContain('Review strength')
    expect(subtreeText(reviewSection)).toContain('Review weakness')
    expect(subtreeText(reviewSection)).toContain('Answer B')
    for (const field of ['Review consensus', 'Review contradiction', 'Review coverage gap', 'Review unique insight', 'Review blind spot']) {
      expect(subtreeText(reviewSection)).toContain(field)
      expect(subtreeText(arbiterSection)).not.toContain(field)
    }
    act(() => arbitrator.update(guarded({ kind: 'tool-result', name: 'structured_output', call: { name: 'structured_output', argsRaw: JSON.stringify(arbiter) }, isError: false })))
    expect(subtreeText(arbiterSection)).toContain('Arbiter stage decision')
    expect(subtreeText(arbiterSection)).toContain('Arbiter confidence')
    expect(subtreeText(reviewSection)).not.toContain('Arbiter stage decision')
    expect(subtreeText(arbiterSection)).not.toContain('MAIN FINAL DISTINCT')
    expect(textOf(renderer)).toContain('MAIN FINAL DISTINCT')
    expect(props.renderFactorySlot).toHaveBeenCalledWith('conversation.chat.reasoning.content', { text: '**Arbiter stage decision**', running: false })
    act(() => reviewer.update(guarded({ kind: 'tool-result', name: 'structured_output', call: { name: 'structured_output', argsRaw: JSON.stringify({ ...review, consensus: ['Review settled update'] }) }, isError: false })))
    expect(subtreeText(reviewSection)).toContain('Review settled update')
    expect(subtreeText(arbiterSection)).not.toContain('Review settled update')
    expect(subtreeText(arbiterSection)).toContain('Arbiter stage decision')
    expect(textOf(renderer)).not.toContain('SECRET')
    expect(textOf(renderer)).not.toContain('No public reasoning')
    for (const child of children) {
      expect(child.target.listeners.size).toBe(1)
      for (const source of child.sources.values()) expect(source.listeners.size).toBe(1)
    }
    act(() => reviewSection.findByType('button').props.onClick())
    expect(reviewer.release).toHaveBeenCalledOnce()
    expect(arbitrator.release).not.toHaveBeenCalled()
    expect(reviewer.target.listeners.size).toBe(0)
    for (const source of reviewer.sources.values()) expect(source.listeners.size).toBe(0)
    expect(arbitrator.target.listeners.size).toBe(1)
    expect(subtreeText(arbiterSection)).toContain('Arbiter stage decision')
    act(() => renderer.unmount())
    expect(arbitrator.release).toHaveBeenCalledOnce()
    expect(arbitrator.target.listeners.size).toBe(0)
    for (const source of arbitrator.sources.values()) expect(source.listeners.size).toBe(0)
  })

  it.each([
    { name: 'preparing review', stage: 'review', root: { name: 'structured_output', phase: 'preparing' }, expected: 'Submitting peer review', structured: true },
    { name: 'partial review JSON', stage: 'review', root: { name: 'structured_output', phase: 'start', argsRaw: '{"evaluations":' }, expected: 'Submitting peer review', structured: true },
    { name: 'preparing arbitration', stage: 'arbiter', root: { name: 'structured_output', phase: 'preparing' }, expected: 'Submitting arbitration', structured: true },
    { name: 'started arbitration', stage: 'arbiter', root: { name: 'structured_output', phase: 'start', argsRaw: JSON.stringify(arbiter) }, expected: 'Arbiter stage decision', structured: true },
    { name: 'malformed settled JSON', stage: 'review', root: { kind: 'tool-result', name: 'structured_output', call: { name: 'structured_output', argsRaw: 'SECRET MALFORMED RAW' }, isError: false }, expected: 'recorded structured output could not be read', structured: true },
    { name: 'failed tool submission', stage: 'arbiter', root: { kind: 'tool-result', name: 'structured_output', call: { name: 'structured_output', argsRaw: JSON.stringify(arbiter) }, isError: true }, expected: 'structured submission failed', structured: true },
    { name: 'wrong stage shape', stage: 'review', root: { kind: 'tool-result', name: 'structured_output', call: { name: 'structured_output', argsRaw: JSON.stringify(arbiter) }, isError: false }, expected: 'recorded structured output could not be read', structured: true },
    { name: 'unrelated root tool', stage: 'review', root: { name: 'other_tool', phase: 'start', argsRaw: 'SECRET OTHER TOOL PARAMS' }, expected: 'No public output', structured: false },
    { name: 'missing public call arguments', stage: 'arbiter', root: { kind: 'tool-result', name: 'structured_output', call: null, isError: false }, expected: 'recorded structured output could not be read', structured: true },
  ])('handles $name without reading partial arguments, raw errors or unrelated tool data', async ({ stage, root, expected, structured }) => {
    const test = harness()
    const child = childCache('child', guarded(root))
    test.ctx.sessions.retain.mockReturnValue(child.reference)
    test.ctx.uiConversation.binding.mockReturnValue({ target: () => child.target })
    const Progress = test.component('dsh-council-progress')
    const props = propsFor(test.t, { data: snapshot({ participants: [participant({ key: stage + ':1', stage, childId: 'child', status: 'running' })] }) })
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(React.createElement(Progress, props)) })
    await act(async () => { renderer.root.findByType('button').props.onClick(); await Promise.resolve() })
    expect(textOf(renderer)).toContain(expected)
    expect(textOf(renderer)).not.toContain('SECRET')
    if (structured) {
      expect(textOf(renderer)).not.toContain('No public output')
      expect(textOf(renderer)).not.toContain('No public reasoning')
      expect(renderer.root.findAllByProps({ 'data-council-stage-output': stage })).toHaveLength(1)
    }
    if (root.isError || expected.includes('could not be read')) expect(textOf(renderer)).not.toContain('Arbiter stage decision')
    act(() => renderer.unmount())
    expect(child.release).toHaveBeenCalledOnce()
    expect(child.target.listeners.size).toBe(0)
    for (const source of child.sources.values()) expect(source.listeners.size).toBe(0)
  })
})


describe('Final decision has one visible arbitration-card owner', () => {
  function fixture(uiChange: Bag = {}, resultChange: Bag = {}) {
    const test = harness()
    const ui = snapshot({ status: 'success', participants: [participant({ key: 'arbiter:1', stage: 'arbiter',
      status: 'completed', childId: 'final-child' })], ...uiChange })
    const result: Bag = { commandId: 'command-1', status: 'success', text: 'CANONICAL_REPORT', presentation: {
      answerMarkdown: 'ONLY_FINAL_BODY', auditMarkdown: 'ONLY_AUDIT_BODY',
    }, ...resultChange }
    const nodes = new Map<string, Bag>([['progress', { kind: 'dsh-council-progress', data: ui }],
      ['answer', { kind: 'dsh-council-answer', data: result }]])
    const parent = new Source({ order: [...nodes.keys()], nodes: { get: (key: string) => nodes.get(key) } })
    const useChat = (select: (chat: Bag) => unknown) => select(React.useSyncExternalStore(parent.subscribe, parent.getSnapshot, parent.getSnapshot))
    const Progress = test.component('dsh-council-progress')
    const Answer = test.component('dsh-council-answer')
    const progressProps = { ...propsFor(test.t, { data: ui }), useChat }
    const answerProps = { ...propsFor(test.t, { data: result }), useChat }
    const render = () => React.createElement(React.Fragment, null, React.createElement(Progress, progressProps), React.createElement(Answer, answerProps))
    return { ...test, ui, result, nodes, parent, useChat, Progress, Answer, progressProps, answerProps, render }
  }
  function detailsWith(renderer: ReactTestRenderer, label: string) {
    return renderer.root.findAllByType('details').find(node => node.children.some(child => typeof child !== 'string'
      && child.type === 'summary' && child.children.includes(label)))!
  }
  const occurrences = (renderer: ReactTestRenderer, value: string) => textOf(renderer).split(value).length - 1

  it('shows the final body once inside the expanded arbiter and moves folded audit into that card', () => {
    const f = fixture()
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(f.render()) })
    expect(occurrences(renderer, 'ONLY_FINAL_BODY')).toBe(1)
    expect(renderer.root.findByType(f.Answer).findAllByType('article')).toHaveLength(0)
    const arbiter = renderer.root.findAllByType('section').find(node => node.props['aria-label'] === 'Arbitration')!
    expect(arbiter.findAllByType('article')).toHaveLength(1)
    expect(detailsWith(renderer, 'Audit details').props.open).toBe(false)
    expect(textOf(renderer)).not.toContain('ONLY_AUDIT_BODY')
    act(() => detailsWith(renderer, 'Audit details').props.onToggle({ currentTarget: { open: true } }))
    expect(occurrences(renderer, 'ONLY_AUDIT_BODY')).toBe(1)
    expect(f.ctx.sessions.retain).not.toHaveBeenCalled()
    expect(f.result.text).toBe('CANONICAL_REPORT')
    act(() => renderer.unmount())
  })

  it('keeps the persisted result readable when the child history cannot be opened', async () => {
    const f = fixture()
    const release = vi.fn()
    f.ctx.sessions.retain.mockReturnValue({ binding: openBinding(), ready: Promise.reject(new Error('private failure')), release })
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(f.render()) })
    await act(async () => { detailsWith(renderer, 'Public arbitration process').props.onToggle({ currentTarget: { open: true } }); await Promise.resolve() })
    expect(occurrences(renderer, 'ONLY_FINAL_BODY')).toBe(1)
    expect(textOf(renderer)).toContain('Public output is unavailable')
    expect(textOf(renderer)).not.toContain('private failure')
    act(() => renderer.unmount())
    expect(release).toHaveBeenCalledOnce()
  })

  it('opens on final completion but respects later manual panel and participant collapses', () => {
    const f = fixture({ status: 'running', participants: [participant({ key: 'arbiter:1', stage: 'arbiter', status: 'running', childId: 'final-child' })] })
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(React.createElement(f.Progress, f.progressProps)) })
    const ui = { ...f.ui, status: 'success', participants: [participant({ key: 'arbiter:1', stage: 'arbiter', status: 'completed', childId: 'final-child' })] }
    f.nodes.set('progress', { kind: 'dsh-council-progress', data: ui })
    const props = { ...f.progressProps, node: { data: ui } }
    act(() => renderer.update(React.createElement(f.Progress, props)))
    expect(occurrences(renderer, 'ONLY_FINAL_BODY')).toBe(1)
    const panel = renderer.root.findByProps({ 'data-council-status': 'success' })
    act(() => panel.props.onToggle({ currentTarget: { open: false } }))
    act(() => f.parent.publish({ ...f.parent.value }))
    expect(panel.props.open).toBe(false)
    act(() => panel.props.onToggle({ currentTarget: { open: true } }))
    act(() => renderer.root.findByType('button').props.onClick())
    f.nodes.set('answer', { kind: 'dsh-council-answer', data: { ...f.result, presentation: { ...f.result.presentation } } })
    act(() => f.parent.publish({ ...f.parent.value }))
    expect(renderer.root.findByType('button').props['aria-expanded']).toBe(false)
    act(() => renderer.unmount())
  })

  it.each(['no-progress', 'other-command', 'missing-child', 'unfinished-arbiter', 'failed-run', 'legacy-presentation'])('preserves an outside fallback for %s', kind => {
    const f = fixture()
    if (kind === 'no-progress') { f.nodes.delete('progress'); f.parent.value.order = ['answer'] }
    if (kind === 'other-command') f.ui.commandId = 'another-command'
    if (kind === 'missing-child') delete f.ui.participants[0].childId
    if (kind === 'unfinished-arbiter') f.ui.participants[0].status = 'error'
    if (kind === 'failed-run') { f.ui.status = 'error'; f.result.status = 'error' }
    if (kind === 'legacy-presentation') delete f.result.presentation
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(React.createElement(f.Answer, f.answerProps)) })
    expect(renderer.root.findAllByType('article')).toHaveLength(1)
    expect(textOf(renderer)).toContain(kind === 'legacy-presentation' ? 'CANONICAL_REPORT' : 'ONLY_FINAL_BODY')
    act(() => renderer.unmount())
  })

  it('does not move a different run result or audit into the current arbiter card', () => {
    const f = fixture()
    f.nodes.set('answer', { kind: 'dsh-council-answer', data: { ...f.result, commandId: 'other-command',
      presentation: { answerMarkdown: 'OTHER_FINAL_BODY', auditMarkdown: 'OTHER_AUDIT_BODY' } } })
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(React.createElement(f.Progress, f.progressProps)) })
    expect(textOf(renderer)).not.toContain('OTHER_FINAL_BODY')
    expect(textOf(renderer)).not.toContain('OTHER_AUDIT_BODY')
    act(() => renderer.unmount())
  })

  it('keeps public arbitration reasoning without repeating its structured decision body', async () => {
    const f = fixture()
    const sources = new Map<string, Source<Bag>>([
      ['reason', new Source({ kind: 'assistant-step', data: { status: 'settled', blocks: [{ kind: 'reasoning', text: 'PUBLIC_REASONING' }] } })],
      ['tool', new Source({ kind: 'tool-call', data: { root: { kind: 'tool-result', name: 'structured_output', isError: false,
        call: { name: 'structured_output', argsRaw: JSON.stringify({ answerMarkdown: 'ONLY_FINAL_BODY', consensus: [], contradictions: [], blindSpots: [], confidenceNotes: 'PUBLIC_CONFIDENCE' }) } } } })],
    ])
    const target = new Source({ order: [...sources.keys()], nodes: { get: (key: string) => sources.get(key)?.value, source: (key: string) => sources.get(key)! } })
    const release = vi.fn()
    f.ctx.sessions.retain.mockReturnValue({ binding: openBinding(), ready: Promise.resolve(), release })
    f.ctx.uiConversation.binding.mockReturnValue({ target: () => target })
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(f.render()) })
    await act(async () => { detailsWith(renderer, 'Public arbitration process').props.onToggle({ currentTarget: { open: true } }); await Promise.resolve() })
    expect(occurrences(renderer, 'ONLY_FINAL_BODY')).toBe(1)
    expect(textOf(renderer)).toContain('PUBLIC_REASONING')
    expect(textOf(renderer)).toContain('PUBLIC_CONFIDENCE')
    act(() => renderer.unmount())
    expect(release).toHaveBeenCalledOnce()
    for (const source of sources.values()) expect(source.listeners.size).toBe(0)
  })
})

describe('P6 strict v1/v2 readers and conservative command fallback (RET-01/03)', () => {
  it('matches the Host v2 result contract and joins inbox/admitted identities without copying audit into text', () => {
    const test = harness()
    const definition = test.definition('dsh-council-answer')
    const event = answerV2()
    expect(councilResultV2Schema.safeParse(event.data.source.result).success).toBe(true)
    expect(matchOf(definition, event)).toEqual(matchOf(definition, inbox(event)))
    const context = start(definition, inbox(event))
    const original = context.state
    context.state = definition.update(context, { event: { ...event, seq: 32 } })
    expect(context.state).toBe(original)
    const data = definition.buildViewNode(context).data
    expect(data).toMatchObject({ version: 2, runId: 'command-1', commandId: 'command-1', parentSessionId: 'parent-1', mode: 'chat', locale: 'en' })
    expect(data.modelReturn).toEqual(modelReturn())
    expect(data.text).toBe(renderModelReturn(modelReturnSchema.parse(modelReturn()), 'en'))
    expect(data.text).not.toContain('FULL_AUDIT_ONLY')
    expect(data.presentation.auditMarkdown).toContain('FULL_AUDIT_ONLY')
    expect(definition.buildViewNode(start(definition, event)).data).toEqual(data)
  })

  it('keeps valid internationalized URL spelling and rejects topic-only background aliases', () => {
    const definition = harness().definition('dsh-council-answer')
    const url = 'HTTPS://例子.测试/路径?值=保留#锚点'
    const event = answerV2({ modelReturn: modelReturn({ citations: [{ sourceAliases: [], url, verification: 'reported' }] }) })
    expect(councilResultV2Schema.safeParse(event.data.source.result).success).toBe(true)
    expect(definition.buildViewNode(start(definition, event)).data.modelReturn.citations[0].url).toBe(url)
    const topic = answerV2({ mode: 'topic-only', modelReturn: modelReturn({ packetHash: undefined }) })
    expect(councilResultV2Schema.safeParse(topic.data.source.result).success).toBe(false)
    expect(matchOf(definition, topic)).toBeNull()
  })

  it.each(['success', 'error', 'canceled'])('accepts topic-only %s without inventing a packet', status => {
    const definition = harness().definition('dsh-council-answer')
    const value = modelReturn({ decisionDeltas: [{ sourceAliases: [], disposition: 'unresolved', text: 'No background was used.' }],
      citations: [{ sourceAliases: [], url: 'https://example.com', verification: 'reported' }] })
    delete value.packetHash
    const event = answerV2({ mode: 'topic-only', status, modelReturn: value, locale: 'zh' })
    if (status !== 'success') delete event.data.source.result.modelReturn
    expect(councilResultV2Schema.safeParse(event.data.source.result).success).toBe(true)
    expect(matchOf(definition, event)).not.toBeNull()
    expect(definition.buildViewNode(start(definition, event)).data.mode).toBe('topic-only')
  })

  const invalidReturns: Array<{ name: string; change: Bag }> = [
    { name: 'unknown ModelReturn version', change: { version: 2 } },
    { name: 'unknown ModelReturn field', change: { providerMetadata: 'SECRET_SENTINEL' } },
    { name: 'wrong run', change: { runId: 'other-run' } },
    { name: 'bad hash', change: { packetHash: 'a'.repeat(64) } },
    { name: 'blank answer', change: { answerMarkdown: '  ' } },
    { name: 'multibyte answer overflow', change: { answerMarkdown: '中'.repeat(22000) } },
    { name: 'blank confidence', change: { confidenceNotes: '' } },
    { name: 'too many notes', change: { limitations: Array.from({ length: 33 }, () => 'Note') } },
    { name: 'oversized note', change: { limitations: ['x'.repeat(8193)] } },
    { name: 'invalid notes', change: { consensus: [1] } },
    { name: 'aggregate byte overflow', change: { consensus: Array.from({ length: 32 }, () => 'x'.repeat(8192)) } },
    { name: 'extra delta field', change: { decisionDeltas: [{ sourceAliases: ['S1'], disposition: 'revised', text: 'Change', provider: 'SECRET_SENTINEL' }] } },
    { name: 'unknown disposition', change: { decisionDeltas: [{ sourceAliases: ['S1'], disposition: 'accepted', text: 'Change' }] } },
    { name: 'duplicate aliases', change: { decisionDeltas: [{ sourceAliases: ['S1', 'S1'], disposition: 'revised', text: 'Change' }] } },
    { name: 'invalid alias', change: { decisionDeltas: [{ sourceAliases: ['S65'], disposition: 'revised', text: 'Change' }] } },
    { name: 'extra citation field', change: { citations: [{ sourceAliases: ['S1'], verification: 'reported', verifiedBy: 'Host' }] } },
    { name: 'forged citation verification', change: { citations: [{ sourceAliases: ['S1'], verification: 'verified' }] } },
    { name: 'empty citation', change: { citations: [{ sourceAliases: [], verification: 'reported' }] } },
    { name: 'unsafe URL scheme', change: { citations: [{ sourceAliases: [], url: 'javascript:alert(1)', verification: 'reported' }] } },
    { name: 'URL credentials', change: { citations: [{ sourceAliases: [], url: 'https://user:pass@example.com', verification: 'reported' }] } },
    { name: 'URL whitespace', change: { citations: [{ sourceAliases: [], url: 'https://example.com/a b', verification: 'reported' }] } },
    { name: 'URL leading whitespace', change: { citations: [{ sourceAliases: [], url: ' https://example.com', verification: 'reported' }] } },
    { name: 'URL NUL', change: { citations: [{ sourceAliases: [], url: 'https://example.com/a\u0000b', verification: 'reported' }] } },
    { name: 'URL control', change: { citations: [{ sourceAliases: [], url: 'https://example.com/a\u007fb', verification: 'reported' }] } },
    { name: 'URL backslash', change: { citations: [{ sourceAliases: [], url: 'https://example.com/a\\b', verification: 'reported' }] } },
    { name: 'URL missing slashes', change: { citations: [{ sourceAliases: [], url: 'https:example.com', verification: 'reported' }] } },
    { name: 'extra coverage field', change: { coverage: { answerersRequested: 3, answerersSucceeded: 2, reviewersRequested: 2, reviewersSucceeded: 1, model: 'SECRET_SENTINEL' } } },
    { name: 'impossible coverage', change: { coverage: { answerersRequested: 2, answerersSucceeded: 3, reviewersRequested: 1, reviewersSucceeded: 1 } } },
    { name: 'fractional coverage', change: { coverage: { answerersRequested: 2.5, answerersSucceeded: 2, reviewersRequested: 1, reviewersSucceeded: 1 } } },
    { name: 'no successful reviewer', change: { coverage: { answerersRequested: 2, answerersSucceeded: 1, reviewersRequested: 1, reviewersSucceeded: 0 } } },
  ]
  it.each(invalidReturns)('rejects $name without claiming its result', ({ change }) => {
    const definition = harness().definition('dsh-council-answer')
    const event = answerV2({ modelReturn: modelReturn(change) })
    expect(councilResultV2Schema.safeParse(event.data.source.result).success).toBe(false)
    expect(matchOf(definition, event)).toBeNull()
    expect(matchOf(definition, inbox(event))).toBeNull()
  })

  it('requires every required ModelReturn and outer result field and rejects unknown or conflicting variants', () => {
    const definition = harness().definition('dsh-council-answer')
    for (const field of Object.keys(modelReturn()).filter(key => key !== 'packetHash')) {
      const event = answerV2()
      delete event.data.source.result.modelReturn[field]
      expect(matchOf(definition, event), field).toBeNull()
    }
    for (const field of ['version', 'commandId', 'runId', 'parentSessionId', 'status', 'mode', 'locale', 'modelReturn']) {
      const event = answerV2()
      delete event.data.source.result[field]
      expect(matchOf(definition, event), field).toBeNull()
    }
    for (const change of [
      { version: 3 }, { locale: 'fr' }, { commandId: 'another' }, { runId: '' }, { parentSessionId: '' }, { mode: 'automatic' },
      { extra: 'SECRET_SENTINEL' }, { status: 'error' }, { status: 'canceled' }, { mode: 'topic-only' },
      { modelReturn: modelReturn({ packetHash: undefined }) },
      { presentation: { answerMarkdown: 'REPLACED ANSWER', auditMarkdown: 'Audit' } },
      { presentation: { answerMarkdown: modelReturn().answerMarkdown, auditMarkdown: 'Audit', extra: 'SECRET_SENTINEL' } },
    ]) {
      const event = answerV2(change)
      expect(councilResultV2Schema.safeParse(event.data.source.result).success).toBe(false)
      expect(matchOf(definition, event)).toBeNull()
    }
    const success = answerV2()
    delete success.data.source.result.presentation
    expect(matchOf(definition, success)).not.toBeNull()
    for (const change of [{ sourceExtra: true }, { question: { version: 1, commandId: 'command-1', text: 'Question' } }]) {
      const event = answerV2()
      Object.assign(event.data.source, change)
      expect(matchOf(definition, event)).toBeNull()
    }
    for (const content of [[], [{ type: 'text', text: 'Valid', extra: true }], [{ type: 'text', text: 'Valid' }, { type: 'text', text: 'Second' }],
      [{ type: 'text', text: 'Valid' }, { type: 'image', url: 'SECRET_SENTINEL' }]]) {
      const event = answerV2()
      event.data.content = content
      expect(matchOf(definition, event)).toBeNull()
    }
  })

  it('rejects additional v1 source fields instead of silently stripping malformed records', () => {
    const test = harness()
    const cases = [
      { kind: 'dsh-council-question', event: question({ extra: true }) },
      { kind: 'dsh-council-progress', event: progress(snapshot({ extra: true })) },
      { kind: 'dsh-council-progress', event: progress(snapshot({ participants: [participant({ providerMetadata: 'SECRET_SENTINEL' })] })) },
      { kind: 'dsh-council-progress', event: progress(snapshot({ participants: [participant({ diagnostic: 'SECRET_SENTINEL' })] })) },
      { kind: 'dsh-council-answer', event: answer({ extra: true }) },
      { kind: 'dsh-council-answer', event: answer({ presentation: { answerMarkdown: 'Body', auditMarkdown: 'Audit', extra: true } }) },
    ]
    for (const { kind, event } of cases) expect(matchOf(test.definition(kind), event)).toBeNull()
    for (const { kind, event } of [{ kind: 'dsh-council-question', event: question() }, { kind: 'dsh-council-progress', event: progress() },
      { kind: 'dsh-council-answer', event: inbox(answer()) }]) {
      event.data.inserted[0].source.extra = true
      expect(matchOf(test.definition(kind), event)).toBeNull()
    }
  })

  it('keeps the native command report until this run has its own visible ANSWER, never just QUESTION/PROGRESS/seq', () => {
    const test = harness()
    const Command = test.component('council')
    const nodes = new Map<string, Bag>()
    const parent = new Source({ order: ['row'], nodes })
    const props = { ...propsFor(test.t, { commandId: 'command-1', outcome: { kind: 'error', sourceEventSeq: 20, text: 'PRE_HANDOFF_FAILURE' } }),
      useChat: (select: (chat: Bag) => unknown) => select(React.useSyncExternalStore(parent.subscribe, parent.getSnapshot, parent.getSnapshot)) }
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(React.createElement(Command, props)) })
    expect(textOf(renderer)).toContain('PRE_HANDOFF_FAILURE')
    for (const node of [
      { kind: 'dsh-council-question', data: { commandId: 'command-1', text: 'Question' } },
      { kind: 'dsh-council-progress', data: snapshot() },
      { kind: 'dsh-council-answer', data: { commandId: 'command-1', status: 'success', text: '' } },
      { kind: 'dsh-council-answer', visibility: 'hidden', data: { commandId: 'command-1', status: 'error', text: 'Hidden error' } },
    ]) {
      nodes.set('row', node)
      act(() => parent.publish({ ...parent.value }))
      expect(textOf(renderer)).toContain('PRE_HANDOFF_FAILURE')
    }
    const definition = test.definition('dsh-council-answer')
    const own = definition.buildViewNode(start(definition, answerV2()))
    for (const data of [{ ...own.data, commandId: 'other' }, { ...own.data, runId: 'other' }, { ...own.data, parentSessionId: 'other' }]) {
      nodes.set('row', { ...own, data })
      act(() => parent.publish({ ...parent.value }))
      expect(textOf(renderer)).toContain('PRE_HANDOFF_FAILURE')
    }
    nodes.set('row', own)
    act(() => parent.publish({ ...parent.value }))
    expect(renderer.toJSON()).toBeNull()
    nodes.clear()
    act(() => parent.publish({ ...parent.value }))
    expect(textOf(renderer)).toContain('PRE_HANDOFF_FAILURE')
    for (const event of [answerV2({ version: 99 }), answerV2({ unknown: true })]) {
      expect(matchOf(definition, event)).toBeNull()
      expect(textOf(renderer)).toContain('PRE_HANDOFF_FAILURE')
    }
    act(() => renderer.unmount())
    expect(parent.listeners.size).toBe(0)
  })
})

describe('P6 visible ModelReturn, observation failure and wrapping (UI-01)', () => {
  it.each(['en', 'zh'])('shows background mode, anonymous coverage, limitations and delta sources with the full audit folded (%s)', language => {
    const test = harness()
    const t = (key: string, values: Bag = {}) => test.t(key, values, language)
    const definition = test.definition('dsh-council-answer')
    const data = definition.buildViewNode(start(definition, answerV2())).data
    const props = propsFor(t, { data })
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(React.createElement(test.component('dsh-council-answer'), props)) })
    const rendered = textOf(renderer)
    for (const value of [t('chat'), t('chatPolicy'), t('incompleteCoverage'), t('decisionDeltas'), 'S1, S3', 'Use the corrected deadline.',
      'Surface-only background', 'Shared conclusion', 'Unresolved disagreement', 'Missing measurement', 'Limited supporting evidence.']) expect(rendered).toContain(value)
    expect(rendered).toContain(t('coverage', { answers: 2, answerers: 3, reviews: 1, reviewers: 2 }))
    expect(props.renderFactorySlot).toHaveBeenCalledWith('conversation.chat.reasoning.content', { text: data.modelReturn.answerMarkdown, running: false })
    expect(rendered).toContain('This heading is part of the answer.')
    expect(rendered).toContain('Keep this too.')
    expect(rendered).not.toContain('FULL_AUDIT_ONLY')
    expect(rendered).not.toContain('PRIVATE_MODEL_MAPPING')
    expect(renderer.root.findByType('details').props.open).toBe(false)
    act(() => renderer.root.findByType('details').props.onToggle({ currentTarget: { open: true } }))
    expect(textOf(renderer)).toContain('FULL_AUDIT_ONLY')
    expect(test.ctx.sessions.retain).not.toHaveBeenCalled()
    act(() => renderer.unmount())
  })

  it('renders v1 audit-like answer headings literally and never guesses a split from mixed historical text', () => {
    const test = harness()
    const body = '## 审计\nANSWER_BODY\n## Ranking\nSTILL_ANSWER'
    const definition = test.definition('dsh-council-answer')
    for (const presentation of [undefined, { answerMarkdown: body, auditMarkdown: 'FULL_AUDIT_ONLY' }]) {
      const event = answer({ presentation })
      event.data.content[0].text = body
      const data = definition.buildViewNode(start(definition, event)).data
      const props = propsFor(test.t, { data })
      let renderer!: ReactTestRenderer
      act(() => { renderer = create(React.createElement(test.component('dsh-council-answer'), props)) })
      expect(props.renderFactorySlot).toHaveBeenCalledWith('conversation.chat.reasoning.content', { text: body, running: false })
      expect(textOf(renderer)).toContain('STILL_ANSWER')
      expect(textOf(renderer)).not.toContain('FULL_AUDIT_ONLY')
      act(() => renderer.unmount())
    }
  })

  it('handles ready-resolved openState:error and later loading/open/error updates without starting any Host operation', async () => {
    const test = harness()
    const session = new Source<Bag>({ openState: 'error', openError: new Error('SECRET_SENTINEL') })
    const forbidden = { prompt: vi.fn(), command: vi.fn(), open: vi.fn(), cancel: vi.fn() }
    Object.assign(session, forbidden)
    const binding = openBinding({ session })
    const target = new Source({ order: [], nodes: { get: () => undefined } })
    const release = vi.fn()
    test.ctx.sessions.retain.mockReturnValue({ binding, ready: Promise.resolve(binding), release })
    test.ctx.uiConversation.binding.mockReturnValue({ target: () => target })
    const props = propsFor(test.t, { data: snapshot({ participants: [participant({ childId: 'child-1' })] }) })
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(React.createElement(test.component('dsh-council-progress'), props)) })
    await act(async () => { renderer.root.findByType('button').props.onClick(); await Promise.resolve() })
    expect(textOf(renderer)).toContain('Public output is unavailable')
    expect(textOf(renderer)).not.toContain('SECRET_SENTINEL')
    expect(test.ctx.uiConversation.binding).not.toHaveBeenCalled()
    expect(target.listeners.size).toBe(0)
    expect(session.listeners.size).toBe(1)
    act(() => session.publish({ openState: 'loading' }))
    expect(textOf(renderer)).toContain('Loading public output')
    act(() => session.publish({ openState: 'open' }))
    expect(textOf(renderer)).toContain('No public output')
    expect(target.listeners.size).toBe(1)
    act(() => session.publish({ openState: 'error', openError: 'SECRET_SENTINEL' }))
    expect(textOf(renderer)).toContain('Public output is unavailable')
    expect(target.listeners.size).toBe(0)
    act(() => session.publish({ openState: 'open' }))
    expect(target.listeners.size).toBe(1)
    act(() => renderer.root.findByType('button').props.onClick())
    expect(session.listeners.size).toBe(0)
    expect(target.listeners.size).toBe(0)
    expect(release).toHaveBeenCalledOnce()
    for (const action of Object.values(forbidden)) expect(action).not.toHaveBeenCalled()
    act(() => renderer.unmount())
    expect(release).toHaveBeenCalledOnce()
  })

  it('fails closed for an unsupported binding and converges references after rapid child replacement and late readiness', async () => {
    const test = harness()
    let settle!: () => void
    const ready = new Promise<void>(resolve => { settle = resolve })
    const first = { binding: openBinding(), ready, release: vi.fn() }
    const second = { binding: {}, ready: Promise.resolve(), release: vi.fn() }
    test.ctx.sessions.retain.mockReturnValueOnce(first).mockReturnValueOnce(second)
    const Progress = test.component('dsh-council-progress')
    const props = propsFor(test.t, { data: snapshot({ participants: [participant({ childId: 'first' })] }) })
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(React.createElement(Progress, props)) })
    act(() => renderer.root.findByType('button').props.onClick())
    await act(async () => { renderer.update(React.createElement(Progress, { ...props,
      node: { data: snapshot({ participants: [participant({ childId: 'second' })] }) } })); await Promise.resolve() })
    expect(first.release).toHaveBeenCalledOnce()
    expect(textOf(renderer)).toContain('Public output is unavailable')
    await act(async () => { settle(); await ready })
    expect(test.ctx.uiConversation.binding).not.toHaveBeenCalled()
    expect(first.binding.session.listeners.size).toBe(0)
    act(() => renderer.unmount())
    expect(second.release).toHaveBeenCalledOnce()
  })

  it('preserves full long literals and opts into shrink/wrap instead of clipping in narrow containers', () => {
    const test = harness()
    const long = 'LONG_TOKEN_' + 'x'.repeat(64000) + '\nFINAL_SENTINEL'
    const props = propsFor(test.t, { data: { text: long } })
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(React.createElement(test.component('dsh-council-question'), props)) })
    const bubble = renderer.root.findAllByType('div')[1]!
    expect(bubble.props.style).toMatchObject({ minWidth: 0, maxWidth: '88%', boxSizing: 'border-box', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' })
    expect(bubble.children).toEqual([long])
    act(() => renderer.unmount())
    act(() => { renderer = create(React.createElement(test.component('dsh-council-answer'), { ...props, renderFactorySlot: undefined })) })
    expect(renderer.root.findByType('article').props.style).toMatchObject({ minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere' })
    expect(renderer.root.findAllByType('div').find(node => node.children.includes(long))!.props.style.whiteSpace).toBe('pre-wrap')
    expect(textOf(renderer)).toContain('FINAL_SENTINEL')
    act(() => renderer.unmount())
    act(() => { renderer = create(React.createElement(test.component('dsh-council-progress'), propsFor(test.t,
      { data: snapshot({ participants: [participant({ childId: 'child-1' })] }) }))) })
    expect(renderer.root.findByType('button').props.style).toMatchObject({ minWidth: 0, flexWrap: 'wrap', overflowWrap: 'anywhere' })
    expect(renderer.root.findByType('details').props.style).toMatchObject({ minWidth: 0, maxWidth: '100%', boxSizing: 'border-box', overflowWrap: 'anywhere' })
    act(() => renderer.unmount())
    // React renderer asserts layout intent/content preservation only, not browser pixel layout.
  })
})
