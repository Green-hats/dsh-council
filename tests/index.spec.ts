import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import { SessionLogOffset, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition, SessionProjectionStateMap } from '@deepseek-ai/dsh-session-projection'
import type { SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, type Config } from '../src/index.js'
import type { ActivationSpec } from '../src/subagents.js'

const config: Config = {
  answerMaxTokens: 16_384,
  reviewMaxTokens: 16_384,
  arbiterMaxTokens: 16_384,
  childTimeoutMs: 300_000,
  runTimeoutMs: 900_000,
  subagentProvider: 'spawn',
  contextMode: 'topic-only',
}

const pickerAnswers = {
  answers: [
    { id: 'answerers', selected: ['A — Provider [p/a]', 'B — Provider [p/b]'] },
    { id: 'reviewers', selected: ['C — Provider [p/c]'] },
    { id: 'arbiter', selected: ['A — Provider [p/a]'] },
    { id: 'question', selected: [], custom: 'Question' },
  ],
}

const review = {
  evaluations: [
    { answerId: 'Answer A', strengths: ['good'], weaknesses: [] },
    { answerId: 'Answer B', strengths: ['good'], weaknesses: [] },
  ],
  consensus: ['common'],
  contradictions: [],
  coverageGaps: [],
  uniqueInsights: [],
  blindSpots: [],
  ranking: ['Answer A', 'Answer B'],
}

const arbiter = {
  answerMarkdown: 'Final answer',
  consensus: ['common'],
  contradictions: [],
  blindSpots: [],
  confidenceNotes: 'High confidence',
}

type PreStepListener = (
  payload: { agent: Agent; messages: Array<{ id?: string }> },
  next: () => Promise<{ kind: 'enter'; messages: Array<{ id?: string }> }>,
) => Promise<{ kind: string; messages?: Array<{ id?: string }> }>
type SettingsListener = (namespace: string) => void
interface TestProvider {
  inheritsParentContext?: boolean
  capabilities: { agentOptions?: boolean; outputSchema?: boolean; depthLimit?: boolean; toolFilter?: boolean; persona?: boolean; agentPreset?: boolean }
  prepareContinuable?: () => Promise<object>
}
type TestAgent = Agent & {
  readonly recordedEvents: Array<{ type: string; data?: Record<string, unknown> }>
  session: Agent['session'] & { blank: boolean }
}

const persistedParents = new Map<string, Agent>()
afterEach(() => { persistedParents.clear() })

function harness(
  ask = async () => pickerAnswers,
  provider: TestProvider | null = {
    inheritsParentContext: false,
    capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    prepareContinuable: () => Promise.resolve({}),
  },
  initialLocale: 'en' | 'zh' = 'en',
  configuration = config,
  settingsApi: 'legacy' | 'config-editor' = 'legacy',
) {
  let command: CommandDefinition | undefined
  let preStep: PreStepListener | undefined
  let settingsUpdated: SettingsListener | undefined
  let settingsDocumentUpdated: SettingsListener | undefined
  let agentCreated: ((payload: { agent: Agent }) => void | Promise<void>) | undefined
  const guards: Array<(execution: { name: string }) => string | undefined> = []
  const assemblies: Array<(assembly: unknown, context: unknown, next: () => Promise<{ tools: Array<{ name: string }> }>) => Promise<{ tools: Array<{ name: string }> }>> = []
  let locale = initialLocale
  const childRequests: SubagentStartRequest[] = []
  const activationSpecs: ActivationSpec[] = []
  const restrictions: Array<{ allow: readonly string[] }> = []
  const personas: Array<{ name: string; order: number; text: string; interpolate: boolean }> = []
  const disposed: string[] = []
  const renamed: string[] = []
  const cleanups: Array<() => unknown> = []
  const projections = new Map<string, (session: { header: SessionHeader; events?: SessionEvent[]; recordedEvents?: SessionEvent[] }) => unknown>()
  const children: Agent[] = []
  const policyDisposals: string[] = []
  const childReleases = new Map<Agent, () => Promise<void>>()
  let completePrompt = false
  function childAgent(id: string, parentId: string, events: SessionEvent[] = []): Agent {
    let personaSection: typeof personas[number] | undefined
    const child = {
      id,
      options: (() => {
        const policy = events.flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted : []).map(message => message.source.kind === 'dsh-council' ? message.source.childPolicy : undefined).find(value => value?.version === 2)
        return policy?.version === 2 ? { provider: policy.approvedRoute.provider, model: policy.approvedRoute.model } : {}
      })(),
      session: { id, header: { id, parentSession: parentId }, events },
      cancel() {},
      whenIdle: () => Promise.resolve(),
      inject(message: unknown) {
        events.push({ type: 'agent/inbox/spliced', seq: events.length, time: 0,
          data: { target: 'next-step', start: 0, inserted: [message] } } as SessionEvent)
      },
      ctx: {
        effect(factory: () => Generator<() => unknown, void, unknown>, label?: string) {
          const releases = [...factory()]
          let disposed = false
          const dispose = async () => {
            if (disposed) return
            disposed = true
            for (const release of releases.reverse()) await release()
            if (label === 'dsh-council child policy') policyDisposals.push(id)
          }
          const earlier = childReleases.get(child)
          childReleases.set(child, earlier === undefined ? dispose : async () => { await dispose(); await earlier() })
          return dispose
        },
        tools: {
          presentAs(mode: string) { expect(mode).toBe('native'); return () => {} },
          guard(callback: typeof guards[number]) { guards.push(callback); return () => { const index = guards.indexOf(callback); if (index >= 0) guards.splice(index, 1) } },
          restrict(filter: typeof restrictions[number]) { restrictions.push(filter); return () => {} },
        },
        systemPrompt: {
          getSectionOrder: () => 50,
          section(section: typeof personas[number]) { personaSection = section; personas.push(section); return () => {} },
          async assemble() { return { sections: completePrompt ? [] : [personaSection].filter(Boolean) } },
        },
        on(event: string, listener: typeof assemblies[number]) { if (event === 'system-prompt/assemble') assemblies.push(listener); return () => {} },
      },
    } as unknown as Agent
    children.push(child)
    return child
  }
  const ctx = {
    commands: {
      register(definition: CommandDefinition) {
        command = { ...definition, handler(invocation) {
          persistedParents.set(String(invocation.agent.id), invocation.agent)
          return definition.handler(invocation)
        } }
        return () => {}
      },
    },
    llm: {
      listProviders: () => [{ id: 'p', name: 'Provider' }],
      listModels: async () => [
        { provider: 'p', id: 'a', name: 'A' },
        { provider: 'p', id: 'b', name: 'B' },
        { provider: 'p', id: 'c', name: 'C' },
      ],
    },
    userQuestions: { ask },
    sessionTitle: {
      rename(_session: unknown, title: string) { renamed.push(title) },
    },
    settings: settingsApi === 'legacy' ? { get: () => ({ preference: locale }) } : {},
    get(name: string) {
      if (name === 'agents') return { get: (id: string) => children.find(child => String(child.id) === id) ?? persistedParents.get(id), roots: () => [...persistedParents.values()] }
      if (name !== 'configEditor') return undefined
      return { configuration: () => [{ entry: { options: { id: 'locale' }, fiber: { config: { preference: { get: () => locale } } } } }] }
    },
    sessionProjections: {
      register<K extends keyof SessionProjectionStateMap>(definition: ProjectionDefinition<K>) {
        projections.set(definition.key, session => (session.events ?? session.recordedEvents ?? []).reduce(definition.apply, definition.init(session.header, SessionLogOffset(0))))
        return () => { projections.delete(definition.key) }
      },
      stateOf(session: { header: SessionHeader; events?: SessionEvent[]; recordedEvents?: SessionEvent[] }, key: string) {
        return projections.get(key)?.(session)
      },
      snapshot: (session: { blank: boolean }) => ({
        asOfSeq: -1,
        values: { sessionListMetadata: { blank: session.blank, lastPromptAt: null } },
      }),
    },
    subagents: {
      getProvider: () => provider ?? undefined,
      async start(_provider: string, request: SubagentStartRequest): Promise<SubagentRun> {
        childRequests.push(request)
        const properties = request.outputSchema?.properties
        const ranking = properties?.ranking?.items?.enum?.filter((item): item is string => typeof item === 'string')
        const structured = ranking !== undefined
          ? {
              ...review,
              evaluations: ranking.map(answerId => ({ answerId, strengths: ['good'], weaknesses: [] })),
              ranking,
            }
          : properties?.answerMarkdown === undefined ? undefined : arbiter
        const id = `child-${childRequests.length}`
        const child = childAgent(id, String(request.parent.id))
        Object.assign(child.options, request.agentOptions)
        try {
          await agentCreated?.({ agent: child })
        } catch (error) {
          // The real serial Agent factory rolls back failed unpublished setup.
          // A late canceled start now fails manifest binding before any prompt;
          // its exact scope still has to unwind before startup can settle.
          await childReleases.get(child)?.()
          disposed.push(id)
          throw error
        }
        return {
          id: id as SubagentRun['id'],
          localAgent: undefined,
          result: Promise.resolve({
            stopReason: 'completed',
            output: structured === undefined ? [{ type: 'text', text: `Answer ${id}` }] : [],
            ...(structured === undefined ? {} : { structured }),
          }),
          async dispose() { disposed.push(id) },
        }
      },
    },
    on(event: string, listener: PreStepListener | SettingsListener | typeof agentCreated) {
      if (event === 'agent/created') agentCreated = listener as typeof agentCreated
      if (event === 'agent/pre-step') preStep = listener as PreStepListener
      if (event === 'settings/updated') settingsUpdated = listener as SettingsListener
      if (event === 'settings/document-updated') settingsDocumentUpdated = listener as SettingsListener
      return () => {
        if (event === 'agent/pre-step') preStep = undefined
        if (event === 'settings/updated') settingsUpdated = undefined
        if (event === 'settings/document-updated') settingsDocumentUpdated = undefined
      }
    },
    effect(factory: () => Generator<unknown, void, unknown>) {
      const iterator = factory()
      for (let step = iterator.next(); !step.done; step = iterator.next()) {
        if (typeof step.value === 'function') cleanups.push(step.value as () => unknown)
      }
      return () => {}
    },
  } as unknown as Context
  apply(ctx, configuration)
  return {
    ctx,
    async dispose() { for (const cleanup of cleanups.reverse()) await cleanup() },
    command: () => command,
    childRequests,
    children,
    policyDisposals,
    childAgent,
    disposeChildPolicy(agent: Agent) { return childReleases.get(agent)?.() },
    suppressPersona() { completePrompt = true },
    emitCreated(agent: Agent) { return agentCreated?.({ agent }) },
    activationSpecs,
    restrictions,
    personas,
    useActivations() {
      const runtime = ctx.subagents as unknown as {
        start?: (provider: string, request: SubagentStartRequest) => Promise<SubagentRun>
        startActivation?: (spec: ActivationSpec) => Promise<{ childId: SubagentRun['id']; result: SubagentRun['result']; dispose(): Promise<void> }>
      }
      const start = runtime.start!
      delete runtime.start
      runtime.startActivation = async spec => {
        activationSpecs.push(spec)
        const run = await start(spec.provider, { ...spec.request, label: spec.label, signal: spec.signal })
        return { childId: run.id, result: run.result, dispose: () => run.dispose() }
      }
    },
    guards,
    assemblies,
    disposed,
    renamed,
    preStep: () => preStep,
    setLocale(next: 'en' | 'zh') {
      locale = next
      if (settingsApi === 'legacy') settingsUpdated?.('locale')
      else settingsDocumentUpdated?.('locale')
    },
  }
}

function agentWithHistory(blank = false, listener?: () => PreStepListener | undefined): TestAgent {
  const events: Array<{ type: string; data?: Record<string, unknown> }> = blank ? [] : [{ type: 'turn/start' }]
  let idle = Promise.resolve()
  const agent = {
    id: blank ? 'blank-root' : 'root',
    session: {
      id: blank ? 'blank-root' : 'root',
      header: { id: blank ? 'blank-root' : 'root', version: 3, createdAt: 0, isSeeded: false },
      events,
      blank,
      get seq() { return events.length },
      eventAt(seq: number) { return events[seq] },
      append(type: string, data: Record<string, unknown>) {
        const event = { type, data: structuredClone(data), seq: events.length, time: Date.now() }
        events.push(event)
        return event
      },
    },
    inject(message: unknown) {
      agent.session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [message] })
    },
    recordedEvents: events,
    ctx: {},
    followup(message: unknown) {
      events.push({ type: 'turn/start' })
      agent.session.blank = false
      idle = Promise.resolve(listener?.()?.(
        { agent: agent as unknown as Agent, messages: [message as { id?: string }] },
        () => Promise.resolve({ kind: 'enter', messages: [message as { id?: string }] }),
      )).then((decision) => {
        if (decision?.kind !== 'reject' && (decision?.kind !== 'enter' || decision.messages?.length !== 0)) {
          throw new Error('blank-session pre-step was not consumed')
        }
        events.push({ type: 'turn/end' })
      })
    },
    whenIdle: () => idle,
  }
  return agent as unknown as TestAgent
}

const existingAgent = agentWithHistory()
const invocation = (rawInput = '', agent: Agent = agentWithHistory()) => ({
  commandId: 'command-1',
  agent,
  rawInput,
  attachments: [],
  signal: new AbortController().signal,
}) as unknown as CommandInvocation

describe('DSH command integration', () => {
  afterEach(() => vi.useRealTimers())
  it('registers /council and runs children with the selected routes and Web-only filter', async () => {
    const test = harness()
    const command = test.command()
    expect(command).toMatchObject({ name: 'council', recordInput: false })
    const result = await command?.handler(invocation())
    expect(result?.kind).toBe('success')
    expect(result?.text).toContain('Final answer')
    expect(test.renamed).toEqual([])
    expect(test.childRequests).toHaveLength(4)
    expect(test.childRequests.every(request => request.toolFilter?.allow?.join(',') === 'web_search,web_fetch')).toBe(true)
    expect(test.childRequests.map(request => request.agentOptions)).toEqual([
      { provider: 'p', model: 'a', maxTokens: 16_384 },
      { provider: 'p', model: 'b', maxTokens: 16_384 },
      { provider: 'p', model: 'c', maxTokens: 16_384 },
      { provider: 'p', model: 'a', maxTokens: 16_384 },
    ])
    expect(test.disposed).toHaveLength(4)
  })

  it('runs DSH 0.2 activations with local roles, Web-only policy, and exact child disposal', async () => {
    const test = harness(undefined, {
      inheritsParentContext: false,
      capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, agentPreset: true },
      prepareContinuable: () => Promise.resolve({}),
    }, 'zh', config, 'config-editor')
    test.useActivations()
    const result = await test.command()!.handler(invocation())
    expect(result).toMatchObject({ kind: 'success' })
    expect(result.text).toContain('Final answer')
    expect(result.text).toContain('# 议会裁决')
    expect(test.command()?.description).toBe('运行匿名多模型议会')
    expect(test.activationSpecs).toHaveLength(4)
    for (const spec of test.activationSpecs) {
      expect(spec).toMatchObject({ provider: 'spawn', delivery: 'caller' })
      expect(spec.request).not.toHaveProperty('persona')
      expect(spec.request).not.toHaveProperty('toolFilter')
      expect(spec.request).not.toHaveProperty('signal')
      expect(spec.request).not.toHaveProperty('label')
    }
    expect(test.activationSpecs.map(spec => spec.request.agentOptions?.model)).toEqual(['a', 'b', 'c', 'a'])
    expect(test.restrictions).toEqual(Array.from({ length: 4 }, () => ({ allow: ['web_search', 'web_fetch'] })))
    expect(test.personas).toHaveLength(4)
    expect(test.personas.every(section => section.name === 'deployment:persona-prefix' && section.text.length > 0 && section.interpolate === false)).toBe(true)
    expect(new Set(test.personas.map(section => section.text)).size).toBe(3)
    expect(test.guards).toHaveLength(4)
    expect(test.guards.every(guard => guard({ name: 'shell' }) !== undefined)).toBe(true)
    expect(test.guards[0]!({ name: 'structured_output' })).toBeDefined()
    expect(test.guards[2]!({ name: 'structured_output' })).toBeUndefined()
    expect(test.disposed).toEqual(['child-1', 'child-2', 'child-3', 'child-4'])
    test.setLocale('en')
    expect(test.command()?.description).toBe('Run an anonymous multi-model council')
  })

  it('rejects arguments and overlapping runs in the same session', async () => {
    let release: ((value: typeof pickerAnswers) => void) | undefined
    const waiting = new Promise<typeof pickerAnswers>(resolve => { release = resolve })
    const test = harness(() => waiting)
    const command = test.command()
    await expect(command?.handler(invocation(' unexpected'))).resolves.toMatchObject({ kind: 'error' })
    const first = command?.handler(invocation())
    await expect(command?.handler(invocation())).resolves.toMatchObject({
      kind: 'error',
      text: 'A Council run is already active in this session.',
    })
    release?.(pickerAnswers)
    await expect(first).resolves.toMatchObject({ kind: 'success' })
  })

  it('blocks child-local tools and removes them from prompt assembly', async () => {
    const test = harness()
    await test.command()!.handler(invocation())
    expect(test.guards).toHaveLength(4)
    for (const guard of test.guards) {
      expect(guard({ name: 'subagent' })).toContain('Council participants')
      expect(guard({ name: 'shell' })).toContain('Council participants')
      expect(guard({ name: 'web_search' })).toBeUndefined()
    }
    expect(test.guards[0]!({ name: 'structured_output' })).toBeDefined()
    expect(test.guards[2]!({ name: 'structured_output' })).toBeUndefined()
    const assembly = { tools: [{ name: 'web_search' }, { name: 'subagent' }, { name: 'structured_output' }] }
    expect(await test.assemblies[0]!(assembly, {}, async () => assembly)).toEqual({ tools: [{ name: 'web_search' }] })
    expect(await test.assemblies[2]!(assembly, {}, async () => assembly)).toEqual({ tools: [
      { name: 'web_search' }, { name: 'structured_output' },
    ] })
  })

  it('registers during boot and reports a missing runtime provider only when invoked', async () => {
    const test = harness(async () => pickerAnswers, null)
    await expect(test.command()?.handler(invocation())).resolves.toMatchObject({
      kind: 'error',
      text: 'Council failed: subagent provider "spawn" is not registered',
    })
  })

  it('retains a command started on a blank session without making another model call', async () => {
    const test = harness()
    const blankAgent = agentWithHistory(true, test.preStep)
    const followup = vi.spyOn(blankAgent, 'followup')
    const result = await test.command()?.handler(invocation('', blankAgent))
    expect(result).toMatchObject({ kind: 'success' })
    expect(followup).toHaveBeenCalledWith(expect.objectContaining({ source: { kind: 'dsh-council' }, content: [] }))
    expect(test.renamed).toEqual(['Council'])
    expect(blankAgent.recordedEvents.some(event => event.type === 'turn/start')).toBe(true)
    expect(blankAgent.recordedEvents.some(event => event.type === 'step/start')).toBe(false)
    expect(test.childRequests).toHaveLength(4)
  })

  it('uses the live DSH locale for command metadata, workflow copy, and blank-session title', async () => {
    const test = harness(async () => pickerAnswers, undefined, 'zh')
    expect(test.command()?.description).toBe('运行匿名多模型议会')
    const blankAgent = agentWithHistory(true, test.preStep)
    const result = await test.command()?.handler(invocation('', blankAgent))
    expect(result?.text).toContain('# 议会裁决')
    expect(test.childRequests[0]?.label).toContain('议会回答')
    expect(test.childRequests[0]?.persona).toContain('简体中文')
    expect(test.renamed).toEqual(['议会'])

    test.setLocale('en')
    expect(test.command()?.description).toBe('Run an anonymous multi-model council')
  })

  it.each([
    ['en' as const, 'Council was canceled.'],
    ['zh' as const, '议会已取消。'],
  ])('localizes DSH question cancellation in %s', async (locale, expected) => {
    const cancelled = Object.assign(new Error('the user cancelled ask_user_question'), { code: 'ASK_CANCELLED' })
    const test = harness(async () => Promise.reject(cancelled), undefined, locale)
    await expect(test.command()?.handler(invocation())).resolves.toMatchObject({ kind: 'error', text: expected })
  })

  it('does not clear a user message batched with the blank-session marker', async () => {
    const test = harness()
    const userMessage = { id: 'ordinary-message' }
    const mixedAgent = agentWithHistory(true, () => async (payload, next) => {
      const decision = await next()
      const result = await test.preStep()?.({ ...payload, messages: [...payload.messages, userMessage] }, async () => ({
        ...decision, messages: [...decision.messages, userMessage],
      }))
      expect(result?.messages).toEqual([userMessage])
      return { kind: 'enter', messages: [] }
    })
    expect(await test.command()?.handler(invocation('', mixedAgent))).toMatchObject({ kind: 'success' })
  })

  it('promotes a new session before the model picker and starts no parent model step', async () => {
    let blankAgent: TestAgent
    const test = harness(async () => {
      expect(blankAgent.session.blank).toBe(false)
      expect(blankAgent.recordedEvents.filter(event => event.type === 'turn/start')).toHaveLength(1)
      return pickerAnswers
    })
    blankAgent = agentWithHistory(true, test.preStep)
    const result = await test.command()!.handler(invocation('', blankAgent))
    expect(result).toMatchObject({ kind: 'success' })
    expect(test.renamed).toEqual(['Council'])
    expect(blankAgent.recordedEvents.filter(event => event.type === 'step/start')).toHaveLength(0)
    const pending = blankAgent.recordedEvents.filter(event => event.type === 'agent/inbox/spliced')
      .flatMap(event => event.data?.inserted as ReturnType<typeof createUserMessage>[])
    const questions = pending.filter(message => message.source.kind === 'dsh-council' && message.source.question !== undefined)
    const results = pending.filter(message => message.source.kind === 'dsh-council' && message.source.result !== undefined)
    expect(questions).toHaveLength(1)
    expect(results).toHaveLength(1)
    expect(questions[0]).toMatchObject({ source: { kind: 'dsh-council', question: { commandId: 'command-1', text: 'Question' } }, content: [{ type: 'text', text: 'Question' }] })
    expect(results[0]).toMatchObject({ source: { kind: 'dsh-council', result: { version: 2, commandId: 'command-1', status: 'success', modelReturn: { answerMarkdown: 'Final answer' }, presentation: { answerMarkdown: 'Final answer' } } } })
    expect(pending.indexOf(questions[0]!)).toBeLessThan(pending.indexOf(results[0]!))
    expect(results[0]!.content).not.toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('p/a') })]))
    expect(blankAgent.recordedEvents.filter(event => event.type === 'user/message')).toHaveLength(0)
    expect(result).toHaveProperty('sourceEventSeq')
  })

  it('removes UI-only markers without dropping real user input, result context, or request-series flags', async () => {
    const test = harness()
    const marker = createUserMessage({ content: [], source: { kind: 'dsh-council', ui: {
      version: 1, commandId: 'ui-admission', status: 'running', question: 'Q', participants: [],
    } } })
    const ordinary = createUserMessage({ content: [{ type: 'text', text: 'Continue this conversation.' }], source: { kind: 'user' } })
    const result = createUserMessage({ content: [{ type: 'text', text: 'Final Council context' }], source: {
      kind: 'dsh-council', result: { version: 1, commandId: 'ui-admission', status: 'success' },
    } })
    const messages = [marker, ordinary, result]
    const decision = await test.preStep()!({ agent: existingAgent, messages }, async () => ({
      kind: 'enter', messages, startsRequestSeries: true,
    }))
    expect(decision).toMatchObject({ kind: 'enter', messages: [ordinary, result], startsRequestSeries: true })
    const injectSynthetic = vi.fn(async () => ({ kind: 'enter' as const, messages: [ordinary] }))
    expect(await test.preStep()!({ agent: existingAgent, messages: [marker] }, injectSynthetic)).toEqual({ kind: 'reject' })
    expect(injectSynthetic).not.toHaveBeenCalled()
  })

  it('does not let prompt injectors turn marker-only retention into a model completion', async () => {
    const test = harness()
    const injectPrompt = vi.fn(async () => ({ kind: 'enter' as const, messages: [{ id: 'injected-context' }] }))
    const blankAgent = agentWithHistory(true, () => async (payload) => test.preStep()!(payload, injectPrompt))
    expect(await test.command()!.handler(invocation('', blankAgent))).toMatchObject({ kind: 'success' })
    expect(injectPrompt).not.toHaveBeenCalled()
    expect(test.childRequests).toHaveLength(4)
  })

  it('vetoes marker-only retention even when outer preset listeners inject context', async () => {
    const test = harness()
    const injected = { id: 'time-or-skills-context' }
    const blankAgent = agentWithHistory(true, () => async (payload, next) => {
      const decision = await test.preStep()!(payload, next)
      if (decision.kind === 'reject') return decision
      return { ...decision, messages: [...(decision.messages ?? []), injected] }
    })
    expect(await test.command()!.handler(invocation('', blankAgent))).toMatchObject({ kind: 'success' })
    expect(test.renamed).toEqual(['Council'])
    expect(test.childRequests).toHaveLength(4)
    expect(blankAgent.recordedEvents.filter(event => event.type.startsWith('turn/'))).toEqual([{ type: 'turn/start' }, { type: 'turn/end' }])
  })

  it('keeps the final answer when retaining the session fails', async () => {
    const test = harness()
    const blankAgent = agentWithHistory(true, test.preStep)
    blankAgent.followup = () => { throw new Error('session closed') }
    const result = await test.command()?.handler(invocation('', blankAgent))
    expect(result?.text).toContain('Final answer')
    expect(result?.text).toContain('session closed')
  })

  it('returns a localized command error when the projection is missing', async () => {
    const test = harness(undefined, undefined, 'zh')
    test.ctx.sessionProjections.snapshot = () => ({ asOfSeq: -1, values: {} })
    expect(await test.command()?.handler(invocation())).toMatchObject({
      kind: 'error', text: '议会失败：DSH 会话元数据不可用。',
    })
    expect(test.childRequests).toHaveLength(0)
  })

  it('bounds a hung provider catalog while preserving the healthy provider', async () => {
    vi.useFakeTimers()
    const test = harness(undefined, undefined, 'en', { ...config, childTimeoutMs: 20 })
    test.ctx.llm.listProviders = () => [{ id: 'p', name: 'Provider' }, { id: 'hung', name: 'Hung' }]
    const listModels = test.ctx.llm.listModels
    test.ctx.llm.listModels = provider => provider === 'hung' ? new Promise(() => {}) : listModels(provider)
    const result = test.command()!.handler(invocation())
    await vi.advanceTimersByTimeAsync(21)
    expect(await result).toMatchObject({ kind: 'success' })
    expect((await result).text).toContain('Provider model discovery timed out.')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases session admission after cancellation during catalog discovery', async () => {
    const test = harness()
    const listModels = test.ctx.llm.listModels
    test.ctx.llm.listModels = () => new Promise(() => {})
    const controller = new AbortController()
    const pending = test.command()!.handler({ ...invocation(), signal: controller.signal })
    controller.abort()
    expect(await pending).toMatchObject({ kind: 'error', text: 'Council was canceled.' })
    test.ctx.llm.listModels = listModels
    expect(await test.command()!.handler(invocation())).toMatchObject({ kind: 'success' })
  })

  it.each(['legacy', 'activation'] as const)('disposes a %s child whose result never settles when cancelled', async (api) => {
    const test = harness()
    const controller = new AbortController()
    const disposed: string[] = []
    test.ctx.subagents.start = async () => ({
      id: 'pending-child' as SubagentRun['id'],
      localAgent: undefined,
      result: new Promise(() => {}),
      async dispose() { disposed.push('done') },
    })
    const started = vi.spyOn(test.ctx.subagents, 'start')
    if (api === 'activation') test.useActivations()
    const pending = test.command()!.handler({ ...invocation(), signal: controller.signal })
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(2))
    controller.abort()
    expect(await pending).toMatchObject({ kind: 'error', text: 'Council was canceled.' })
    await vi.waitFor(() => expect(disposed).toHaveLength(2))
  })

  it.each(['legacy', 'activation'] as const)('unloads promptly on %s while a question provider ignores cancellation', async (api) => {
    const test = harness(async () => new Promise(() => {}))
    if (api === 'activation') test.useActivations()
    const pending = test.command()!.handler(invocation())
    await test.dispose()
    expect(await pending).toMatchObject({ kind: 'error', text: 'Council was canceled.' })
    expect(test.childRequests).toHaveLength(0)
  })

  it.each([undefined, 8000, 32768])('restores durable activation policy and never widens a cold child budget (%s)', async (requestedCap) => {
    const first = harness()
    first.useActivations()
    expect(await first.command()!.handler(invocation())).toMatchObject({ kind: 'success' })
    const original = first.children[2]!
    const events = (original.session as unknown as { events: SessionEvent[] }).events
    await first.dispose()
    const restarted = harness()
    const resumed = restarted.childAgent(String(original.id), String(existingAgent.id), structuredClone(events))
    if (requestedCap !== undefined) resumed.options.maxTokens = requestedCap
    await restarted.emitCreated(resumed)
    expect(resumed.options.maxTokens).toBe(requestedCap === 8000 ? 8000 : 16384)
    expect(restarted.restrictions).toEqual([{ allow: ['web_search', 'web_fetch'] }])
    expect(restarted.personas[0]?.text).toBe(first.personas[2]?.text)
    expect(restarted.guards[0]!({ name: 'shell' })).toBeDefined()
    expect(restarted.guards[0]!({ name: 'subagent' })).toBeDefined()
    expect(restarted.guards[0]!({ name: 'structured_output' })).toBeDefined()
    expect(restarted.guards[0]!({ name: 'web_fetch' })).toBeUndefined()
    expect(restarted.childRequests).toHaveLength(0)
    await restarted.dispose()
    expect(restarted.policyDisposals).toEqual([])
    await restarted.disposeChildPolicy(resumed)
    expect(restarted.policyDisposals).toEqual([original.id])
  })

  it('fails closed when an old child policy and the provider both lack a token budget', async () => {
    const test = harness()
    const message = createUserMessage({ content: [], source: { kind: 'dsh-council', childPolicy: {
      version: 1, childId: 'legacy-cold', parentId: 'root', persona: 'Old Council persona',
    } } })
    const child = test.childAgent('legacy-cold', 'root', [{ type: 'agent/inbox/spliced', seq: 0, time: 0,
      data: { target: 'next-step', start: 0, inserted: [message] } } as SessionEvent])
    await expect(test.emitCreated(child)).rejects.toThrow('token budget is unavailable')
    expect(test.childRequests).toHaveLength(0)
    expect(test.guards[0]!({ name: 'shell' })).toBeDefined()
    await test.disposeChildPolicy(child)
    await test.dispose()
  })

  it.each([false, true])('keeps cold-resumed guards until their own scope closes during unload (managed=%s)', async (managed) => {
    const first = harness()
    first.useActivations()
    await first.command()!.handler(invocation())
    const original = first.children[0]!
    const events = structuredClone((original.session as unknown as { events: SessionEvent[] }).events)
    await first.dispose()
    const test = harness()
    const child = test.childAgent(String(original.id), String(existingAgent.id), events)
    const idle = Promise.withResolvers<void>()
    child.cancel = vi.fn()
    child.whenIdle = () => idle.promise
    const drain = vi.fn(async () => { await idle.promise })
    if (managed) {
      const get = test.ctx.get.bind(test.ctx)
      test.ctx.get = ((key: string, strict?: boolean) => key === 'agents'
        ? { get: () => first.childRequests[0]!.parent } : get(key, strict)) as Context['get']
      Object.assign(test.ctx.subagents, { drainChildren: drain })
    }
    await test.emitCreated(child)
    let unloaded = false
    const unload = test.dispose().then(() => { unloaded = true })
    await Promise.resolve()
    expect(child.cancel).toHaveBeenCalledWith({ kind: 'disposed' })
    expect(unloaded).toBe(false)
    expect(test.policyDisposals).toEqual([])
    expect(test.guards[0]!({ name: 'shell' })).toBeDefined()
    if (managed) expect(drain).toHaveBeenCalledWith(first.childRequests[0]!.parent, [child.id])
    // No new restored creation is admitted after teardown starts.
    await expect(test.emitCreated(test.childAgent(String(child.id), String(existingAgent.id), events)))
      .rejects.toThrow('plugin disposed')
    idle.resolve()
    await unload
    // A successful drain can be a no-op; only the child's own scope proves it
    // safe to release policy, even after the plugin's teardown has completed.
    expect(test.policyDisposals).toEqual([])
    expect(test.guards[0]!({ name: 'subagent' })).toBeDefined()
    await test.disposeChildPolicy(child)
    expect(test.policyDisposals).toEqual([child.id])
  })

  it('vetoes a restoring child if unload races its asynchronous prompt assembly', async () => {
    const first = harness()
    first.useActivations()
    await first.command()!.handler(invocation())
    const original = first.children[0]!
    const events = structuredClone((original.session as unknown as { events: SessionEvent[] }).events)
    await first.dispose()
    const test = harness()
    const child = test.childAgent(String(original.id), String(existingAgent.id), events)
    const gate = Promise.withResolvers<void>()
    const assemble = child.ctx.systemPrompt.assemble.bind(child.ctx.systemPrompt)
    child.ctx.systemPrompt.assemble = async (...args) => { await gate.promise; return assemble(...args) }
    const creating = test.emitCreated(child)
    await test.dispose()
    expect(test.policyDisposals).toEqual([])
    const rejected = expect(creating).rejects.toThrow('plugin disposed')
    gate.resolve()
    await rejected
    await test.disposeChildPolicy(child)
  })

  it('does not restrict unrelated agents or conflate concurrent parent starts', async () => {
    const test = harness()
    await test.emitCreated(test.childAgent('unrelated', 'root'))
    expect(test.guards).toHaveLength(0)
    test.useActivations()
    const another = agentWithHistory()
    Object.assign(another, { id: 'another-parent' })
    Object.assign(another.session, { id: 'another-parent', header: { ...another.session.header, id: 'another-parent' } })
    const results = await Promise.all([
      test.command()!.handler(invocation()), test.command()!.handler(invocation('', another)),
    ])
    expect(results.every(result => result.kind === 'success')).toBe(true)
    expect(test.childRequests).toHaveLength(8)
    for (const child of test.children.slice(1)) {
      const state = test.ctx.sessionProjections.stateOf(child.session, 'dsh-council:child-policy')
      expect(state?.policy?.childId).toBe(child.id)
      expect(state?.policy?.parentId).toBe(child.session.header.parentSession)
    }
    await test.dispose()
    expect(test.policyDisposals).toHaveLength(8)
  })

  it('fails creation rather than running without a persona under a complete child preset', async () => {
    const test = harness()
    test.useActivations()
    test.suppressPersona()
    const result = await test.command()!.handler(invocation())
    expect(result.kind).toBe('error')
    expect(result.text).toContain('child preset suppresses the Council persona')
    expect(test.activationSpecs).toHaveLength(2)
    await test.dispose()
  })

  it.each(['legacy', 'activation'] as const)('joins late %s startup receipts on unload after command cancellation', async (api) => {
    const test = harness()
    const gate = Promise.withResolvers<void>()
    const start = test.ctx.subagents.start.bind(test.ctx.subagents)
    const pendingStart = vi.fn(async (...args: Parameters<typeof start>) => { await gate.promise; return start(...args) })
    test.ctx.subagents.start = pendingStart
    if (api === 'activation') test.useActivations()
    const controller = new AbortController()
    const pending = test.command()!.handler({ ...invocation(), signal: controller.signal })
    await vi.waitFor(() => expect(pendingStart).toHaveBeenCalledTimes(2))
    controller.abort()
    expect(await pending).toMatchObject({ kind: 'error', text: 'Council was canceled.' })
    let unloaded = false
    const unload = test.dispose().then(() => { unloaded = true })
    await Promise.resolve()
    expect(unloaded).toBe(false)
    gate.resolve()
    await unload
    expect(test.disposed).toHaveLength(2)
    expect(test.policyDisposals).toHaveLength(2)
  })

  it.each(['legacy', 'activation'] as const)('keeps %s guards until delayed child disposal finishes on unload', async (api) => {
    const test = harness()
    const gate = Promise.withResolvers<void>()
    const start = test.ctx.subagents.start.bind(test.ctx.subagents)
    let disposing = 0
    test.ctx.subagents.start = async (...args) => {
      const run = await start(...args)
      return { ...run, result: new Promise(() => {}), async dispose() {
        disposing += 1
        await gate.promise
        await run.dispose()
      } }
    }
    if (api === 'activation') test.useActivations()
    const controller = new AbortController()
    const pending = test.command()!.handler({ ...invocation(), signal: controller.signal })
    await vi.waitFor(() => expect(test.childRequests).toHaveLength(2))
    controller.abort()
    expect(await pending).toMatchObject({ kind: 'error' })
    await vi.waitFor(() => expect(disposing).toBe(2))
    let unloaded = false
    const unload = test.dispose().then(() => { unloaded = true })
    await Promise.resolve()
    expect(unloaded).toBe(false)
    expect(test.policyDisposals).toHaveLength(0)
    expect(test.guards.every(guard => guard({ name: 'shell' }) !== undefined)).toBe(true)
    gate.resolve()
    await unload
    expect(test.disposed).toHaveLength(2)
    expect(test.policyDisposals).toHaveLength(2)
  })

  it('keeps an in-progress run in its original language while later invocations use the new language', async () => {
    const test = harness(async () => { test.setLocale('zh'); return pickerAnswers })
    expect((await test.command()!.handler(invocation())).text).toContain('# Council Decision')
    expect(test.command()?.description).toBe('运行匿名多模型议会')
    expect((await test.command()!.handler(invocation())).text).toContain('# 议会裁决')
  })

  it.each([
    { childTimeoutMs: 0 }, { runTimeoutMs: 2 ** 31 }, { answerMaxTokens: NaN },
    { reviewMaxTokens: 1.5 }, { arbiterMaxTokens: Infinity }, { subagentProvider: ' ' },
    { runTimeoutMs: 1 },
  ])('rejects invalid configuration before registering the command: %o', (override) => {
    expect(() => harness(undefined, undefined, 'en', { ...config, ...override })).toThrow('dsh-council:')
  })
})


describe('canonical terminal integration', () => {
  function ownResults(parent: TestAgent) {
    return parent.recordedEvents.filter(event => event.type === 'agent/inbox/spliced')
      .flatMap(event => event.data?.inserted as ReturnType<typeof createUserMessage>[])
      .filter(message => message.source.kind === 'dsh-council' && message.source.result !== undefined)
  }
  it('RUN-02/REC-01 replays an existing canonical terminal without injecting or rerunning children', async () => {
    const test = harness()
    const parent = agentWithHistory()
    const first = await test.command()!.handler(invocation('', parent))
    const eventCount = parent.recordedEvents.length
    const replay = await test.command()!.handler(invocation('', parent))
    expect(first.kind).toBe('success')
    if (first.kind !== 'success') throw new Error('Expected successful canonical result')
    expect(replay).toMatchObject({ kind: 'success', sourceEventSeq: first.sourceEventSeq })
    expect(test.childRequests).toHaveLength(4)
    expect(ownResults(parent)).toHaveLength(1)
    expect(parent.recordedEvents).toHaveLength(eventCount)
  })
  it('RUN-02 cannot report successful completion when the canonical write fails', async () => {
    const test = harness()
    const parent = agentWithHistory()
    const inject = parent.inject.bind(parent)
    parent.inject = message => {
      if (message.source.kind === 'dsh-council' && message.source.result !== undefined) throw new Error('TERMINAL_WRITE_FAILED')
      return inject(message)
    }
    const result = await test.command()!.handler(invocation('', parent))
    expect(result).toMatchObject({ kind: 'error', text: expect.stringContaining('TERMINAL_WRITE_FAILED') })
    expect(ownResults(parent)).toHaveLength(0)
    const successUi = parent.recordedEvents.filter(event => event.type === 'agent/inbox/spliced')
      .flatMap(event => event.data?.inserted as ReturnType<typeof createUserMessage>[])
      .some(message => message.source.kind === 'dsh-council' && message.source.ui?.status === 'success')
    expect(successUi).toBe(false)
  })
  it('RUN-02 cancellation after the canonical append cannot create an opposite terminal', async () => {
    const test = harness()
    const controller = new AbortController()
    const parent = agentWithHistory()
    const inject = parent.inject.bind(parent)
    parent.inject = message => {
      const result = inject(message)
      if (message.source.kind === 'dsh-council' && message.source.result !== undefined) controller.abort(new Error('LATE_CALLER_CANCEL'))
      return result
    }
    const result = await test.command()!.handler({ ...invocation('', parent), signal: controller.signal })
    expect(result.kind).toBe('success')
    expect(ownResults(parent)).toHaveLength(1)
    expect(ownResults(parent)[0]).toMatchObject({ source: { result: { status: 'success' } } })
  })
  it('RUN-02 a failed final UI publish does not turn a committed success into an error', async () => {
    const test = harness()
    const parent = agentWithHistory()
    const inject = parent.inject.bind(parent)
    parent.inject = message => {
      if (message.source.kind === 'dsh-council' && message.source.ui?.status === 'success') throw new Error('UI_PUBLISH_FAILED')
      return inject(message)
    }
    const result = await test.command()!.handler(invocation('', parent))
    expect(result.kind).toBe('success')
    expect(result).toHaveProperty('sourceEventSeq')
    expect(ownResults(parent)).toHaveLength(1)
  })
  it('RET-02 only admits the question and compact ModelReturn, never the full audit or empty records', async () => {
    const test = harness()
    const parent = agentWithHistory()
    await test.command()!.handler(invocation('', parent))
    const messages = parent.recordedEvents.filter(event => event.type === 'agent/inbox/spliced')
      .flatMap(event => event.data?.inserted as ReturnType<typeof createUserMessage>[])
    const decision = await test.preStep()!({ agent: parent, messages }, async () => ({ kind: 'enter', messages, startsRequestSeries: true }))
    expect(decision).toMatchObject({ kind: 'enter', startsRequestSeries: true })
    expect(decision.messages).toHaveLength(2)
    const text = decision.messages?.map(message => (message as ReturnType<typeof createUserMessage>).content.map(block => block.type === 'text' ? block.text : '').join('')).join('\n')
    expect(text).toContain('Question')
    expect(text).toContain('Final answer')
    expect(text).not.toMatch(/p\/a|Anonymous Mapping|Aggregate Ranking|runRecord|childPolicy/)
  })
})


describe('fail-closed child ownership and retention cancellation', () => {
  it('SEC-01 quarantines tool execution synchronously before cold ownership awaits', async () => {
    const first = harness()
    first.useActivations()
    await first.command()!.handler(invocation())
    const original = first.children[0]!
    const events = structuredClone((original.session as unknown as { events: SessionEvent[] }).events)
    await first.dispose()
    const restarted = harness()
    const child = restarted.childAgent(String(original.id), 'root', events)
    const restoring = restarted.emitCreated(child)
    expect(restarted.guards).toHaveLength(1)
    expect(restarted.guards[0]!({ name: 'web_search' })).toContain('authorization')
    await restoring
    expect(restarted.guards).toHaveLength(1)
    expect(restarted.guards[0]!({ name: 'web_search' })).toBeUndefined()
    expect(restarted.guards[0]!({ name: 'shell' })).toBeDefined()
    await restarted.disposeChildPolicy(child)
    await restarted.dispose()
  })
  it('SEC-03 rejects an owned child even after ALL its policy and child-binding markers disappear', async () => {
    const first = harness()
    first.useActivations()
    expect((await first.command()!.handler(invocation())).kind).toBe('success')
    const original = first.children[0]!
    const background = createUserMessage({ content: [{ type: 'text', text: 'FROZEN_BACKGROUND_SENTINEL' }], source: { kind: 'user' } })
    const events: SessionEvent[] = [{ type: 'user/message', seq: 0, time: 0, data: background, surfaceOp: 'append' } as SessionEvent]
    await first.dispose()
    const restarted = harness()
    const child = restarted.childAgent(String(original.id), 'root', events)
    await expect(restarted.emitCreated(child)).rejects.toThrow('policy is missing or conflicts with its parent manifest')
    expect(restarted.childRequests).toHaveLength(0)
    expect(restarted.guards.every(guard => guard({ name: 'web_search' }) !== undefined)).toBe(true)
    await restarted.disposeChildPolicy(child)
    await restarted.dispose()
  })
  it.each([true, false])('RUN-01 cancels retention without waiting for foreign parent work (pending=%s)', async pendingMarker => {
    const test = harness()
    const parent = agentWithHistory(true)
    const controller = new AbortController()
    const idle = Promise.withResolvers<void>()
    let marker: ReturnType<typeof createUserMessage> | undefined
    let scoped: PreStepListener | undefined
    let releases = 0
    const remove = vi.fn(() => pendingMarker)
    Object.assign(parent, {
      inbox: { remove },
      followup(message: ReturnType<typeof createUserMessage>) { marker = message },
      whenIdle: () => idle.promise,
      ctx: { on(event: string, listener: PreStepListener) { if (event === 'agent/pre-step') scoped = listener; return () => { releases += 1 } } },
    })
    const running = test.command()!.handler({ ...invocation('', parent), signal: controller.signal })
    await vi.waitFor(() => expect(marker).toBeDefined())
    controller.abort(new Error('CANCEL_RETENTION'))
    expect(await running).toMatchObject({ kind: 'error', text: expect.stringContaining('canceled') })
    await test.dispose()
    expect(remove).toHaveBeenCalledWith(marker!.id)
    expect(test.childRequests).toHaveLength(0)
    if (!pendingMarker) {
      // remove=false can mean already claimed. The parent-owned veto survives
      // plugin teardown until that exact late marker is rejected and drained.
      expect(releases).toBe(0)
      const next = vi.fn(async () => ({ kind: 'enter' as const, messages: [marker!] }))
      expect(await scoped!({ agent: parent, messages: [marker!] }, next)).toEqual({ kind: 'reject' })
      expect(next).not.toHaveBeenCalled()
    }
    idle.resolve()
    await Promise.resolve()
    expect(releases).toBe(1)
  })
})
