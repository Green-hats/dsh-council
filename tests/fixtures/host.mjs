import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'

export const name = 'council-smoke'
export const inject = ['commands', 'agents', 'agentPresets', 'llm', 'sessions', 'sessionPersistence', 'sessionProjections', 'userQuestions', 'subagents']
const calls = []
const guardChecks = []
let forbiddenExecutions = 0
let activeLocale = 'en'
let allowParentNotice = false
let continuations = 0
let activeParent
let activeMode = 'topic-only'
let activeChatRun = 0
let coldProbe
let chatContinuations = 0
let chatParentFollowups = 0
const chatCalls = []
const chatMaterials = new Map()
const confirmedChatRuns = new Set()
const chatDeniedProbes = []
const coldErrors = []
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value)
const hash = value => `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`

function visibleInput(options) {
  return JSON.stringify({ system: options.system, messages: options.messages.map(message => ({ role: message.role, content: message.content })), tools: options.tools })
}
function textOf(message) { return message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') }
function payloadOf(options) {
  const text = options.messages.map(textOf).find(text => text.includes('"topicOriginal":'))
  assert(text, 'Chat request is missing the complete public payload')
  return JSON.parse(text.slice(text.indexOf('{"')))
}
async function setLocale(ctx, locale) {
  const settings = ctx.get('settings', false)
  if (typeof settings?.update === 'function') return settings.update('locale', { preference: locale })
  const editor = ctx.get('configEditor', false)
  assert(editor, 'Modern locale updates require ConfigEditor')
  const entry = editor.entries().find(entry => entry.options.id === 'locale')
  assert(entry, 'Locale configuration entry is missing')
  await editor.edit(entry, current => ({ ...current, preference: locale }))
}

class TestAdapter extends LlmAdapter {
  async listModels(provider) {
    const ids = provider === 'council-parent' ? ['parent'] : provider === 'council-review' ? ['c'] : ['a', 'b']
    return ids.map(id => ({ provider, id, name: id }))
  }
  async resolveModel(provider, model, signal) {
    signal?.throwIfAborted()
    return { provider, id: model, name: model, context: { contextWindow: 131_072 } }
  }
  async *stream(options) {
    options.signal?.throwIfAborted()
    const input = visibleInput(options)
    const parentId = String(activeParent?.id)
    if (options.sessionId === parentId) {
      assert(input.includes('PARENT_HISTORY_SENTINEL') || input.includes('CHAT_BACKGROUND_SENTINEL') || allowParentNotice, 'Unexpected parent model completion')
      assert.equal(options.provider, 'council-parent')
      assert.equal(options.model, 'parent')
      if (input.includes('CHAT_PARENT_FOLLOWUP_SENTINEL') && !allowParentNotice) {
        chatParentFollowups += 1
        assert(input.includes('HOST_CHAT_FINAL_3'), 'Ordinary parent followup lost the canonical ModelReturn')
        assert(!input.includes('HOST_CHAT_FINAL_1') && !input.includes('HOST_CHAT_FINAL_2'), 'Cleared pending results were resurrected')
        assert(!input.includes('# Council Audit') && !input.includes('council-test/') && !input.includes('averageRank'), 'Full audit leaked into parent model content')
        assert(!options.messages.some(message => message.source?.runRecord || message.source?.ui || message.source?.childPolicy), 'Run/policy/UI markers leaked into parent model request')
      }
      if (activeMode === 'topic-only' && input.includes('PARENT_FOLLOWUP_SENTINEL')) {
        assert(input.includes('Compare two independent solutions.') && input.includes('HOST_VERIFIED_FINAL'), 'Later parent turn lost Council question or final context')
        assert(!options.messages.some(message => message.source?.ui), 'UI-only manifests leaked into the parent model request')
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Parent fixture acknowledged.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (activeMode === 'chat') { yield* this.streamChat(options, input); return }
    assert(!input.includes('PARENT_HISTORY_SENTINEL'), 'Children must start without parent history')
    const allowed = new Set(['web_search', 'web_fetch', 'structured_output'])
    assert((options.tools ?? []).every(tool => allowed.has(tool.name)), 'Unexpected child tool access')
    const tool = options.tools?.find(tool => tool.name === 'structured_output')
    const ranking = tool?.parameters.properties.ranking?.items.enum
    const system = typeof options.system === 'string' ? options.system
      : JSON.stringify(options.messages.filter(message => message.role === 'system'))
    const personas = activeLocale === 'zh'
      ? { answer: '匿名回答人', review: '匿名评审人', arbiter: '匿名最终裁决人' }
      : { answer: 'anonymous answerer', review: 'anonymous reviewer', arbiter: 'anonymous final arbiter' }
    if (input.includes('COUNCIL_CONTINUATION_SENTINEL')) {
      continuations += 1
      assert.equal(tool, undefined, 'A cold continuation must not retain the structured submission tool')
      assert.equal(options.provider, 'council-test', 'Cold resume lost its selected provider')
      assert.equal(options.model, 'b', 'Cold resume lost its selected model')
      assert.equal(options.maxTokens, 16384, 'Cold resume lost its token budget')
      assert(system.includes(personas.answer), 'Cold resume lost its Council persona')
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Cold continuation verified.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const linked = activeParent.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.source?.kind === 'dsh-council'
        && message.source.ui?.participants.some(child => child.childId === options.sessionId && child.status === 'running')))
    assert(linked, 'A child must be linked into main-chat progress before its first model request')
    calls.push(options)
    assert.equal(options.provider, ranking ? 'council-review' : 'council-test')
    assert.equal(options.maxTokens, 16384, 'Selected token budget must reach the child model')
    if (tool) assert.equal(options.model, ranking ? 'c' : 'a', 'Review/arbiter route override lost')
    else assert(['a', 'b'].includes(options.model), 'Answerer route override lost')
    const role = tool ? (ranking ? 'review' : 'arbiter') : 'answer'
    assert(system.includes(personas[role]), 'Selected Council persona must reach the system prompt')
    assert(!input.includes('council-test/') && !input.includes('council-review/'), 'Model routing metadata leaked into deliberation input')
    let block
    if (!tool) block = { type: 'text', text: 'Independent test answer.' }
    else {
      const output = ranking ? {
        evaluations: ranking.map(answerId => ({ answerId, strengths: ['supported'], weaknesses: [] })),
        consensus: ['shared evidence'], contradictions: [], coverageGaps: [], uniqueInsights: [], blindSpots: [], ranking,
      } : {
        answerMarkdown: 'HOST_VERIFIED_FINAL', consensus: ['shared evidence'], contradictions: [],
        blindSpots: [], confidenceNotes: 'Deterministic fixture; not a model quality benchmark.',
      }
      block = { type: 'tool-call', id: `call-${calls.length}`, name: 'structured_output', arguments: JSON.stringify(output) }
    }
    yield { type: 'block-start', index: 0, blockType: block.type }
    yield { type: 'block-end', index: 0, block }
    yield { type: 'finish', reason: { kind: tool ? 'tool-calls' : 'stop' } }
  }
  async *streamChat(options, input) {
    assert.equal(coldProbe, undefined, 'A denied cold request reached the adapter')
    assert((options.tools ?? []).every(tool => tool.name === 'structured_output'), 'Chat must not expose Web/file/Shell/delegation tools')
    const tool = options.tools?.find(tool => tool.name === 'structured_output')
    if (input.includes('CHAT_COLD_VALID')) {
      chatContinuations += 1
      assert.equal(tool, undefined, 'Cold chat continuation must not restore structured_output')
      assert.equal(options.provider, 'council-test')
      assert.equal(options.model, 'b')
      assert.equal(options.maxTokens, 2_048)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Chat cold continuation verified.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    assert(confirmedChatRuns.has(activeChatRun), 'Chat model work started before final consent')
    const ranking = tool?.parameters.properties.ranking?.items.enum
    const stage = tool ? (ranking ? 'review' : 'arbiter') : 'answer'
    assert.equal(options.maxTokens, stage === 'arbiter' ? 4_096 : 2_048)
    const payload = payloadOf(options)
    assert(JSON.stringify(payload.packet).includes('CHAT_BACKGROUND_SENTINEL'), 'Selected live background was not exported')
    assert(!JSON.stringify(payload).includes('council-test/') && !JSON.stringify(payload).includes('parentSessionId'), 'Private route/provenance leaked into public material')
    const key = `${activeChatRun}/${stage}`
    if (chatMaterials.has(key)) assert.deepEqual(payload, chatMaterials.get(key), 'Same-stage evidence changed between participants')
    else chatMaterials.set(key, payload)
    if (stage === 'arbiter') assert.deepEqual(payload.answerCorpus, chatMaterials.get(`${activeChatRun}/review`).answerCorpus, 'Arbiter saw a different AnswerCorpus')
    const linked = activeParent.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.source?.ui?.participants.some(child => child.childId === options.sessionId && child.status === 'running')))
    assert(linked, 'Chat child was not linked before dispatch')
    chatCalls.push(options)
    let block
    if (!tool) block = { type: 'text', text: `CHAT_ANSWER_${activeChatRun}: independent complete answer.` }
    else {
      const output = ranking ? {
        evaluations: ranking.map(answerId => ({ answerId, strengths: ['supported'], weaknesses: [] })),
        consensus: ['shared evidence'], contradictions: [], coverageGaps: [], uniqueInsights: [], blindSpots: [], ranking,
      } : {
        answerMarkdown: `HOST_CHAT_FINAL_${activeChatRun}`, consensus: ['shared evidence'], contradictions: [], blindSpots: [],
        confidenceNotes: 'Fixture only; sources are not independently verified.',
        decisionDeltas: [{ sourceAliases: [payload.packet.sources[0].alias], disposition: 'revised', text: 'Preserve the constraint and revise the proposal.' }],
        citations: [{ sourceAliases: [payload.packet.sources[0].alias], verification: 'reported' }],
      }
      block = { type: 'tool-call', id: `chat-call-${chatCalls.length}`, name: 'structured_output', arguments: JSON.stringify(output) }
    }
    yield { type: 'block-start', index: 0, blockType: block.type }
    yield { type: 'block-end', index: 0, block }
    yield { type: 'finish', reason: { kind: tool ? 'tool-calls' : 'stop' } }
  }
}

export function apply(ctx) {
  ctx.on('agent/error', ({ error }) => { if (activeMode === 'chat' && coldProbe !== undefined) coldErrors.push(error) }, { global: true })
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'turn/end' && event.data.reason.kind === 'error') process.stderr.write(`${JSON.stringify(event)}\n`)
  }, { global: true })
  ctx.on('agent/created', ({ agent }) => {
    if (!agent.session.header.parentSession?.startsWith('session-council-host-')) return
    if (activeMode === 'chat' && coldProbe !== undefined) {
      const probe = coldProbe
      if (probe === 'huge-system') agent.ctx.systemPrompt.section({ name: 'council-smoke-overflow', order: 100_000,
        text: 'BUDGET_OVERFLOW_SENTINEL '.repeat(100_000), interpolate: false })
      else agent.ctx.on('agent/request', async (_payload, next) => {
        const request = await next()
        return probe === 'route' ? { ...request, model: request.model === 'a' ? 'b' : 'a' }
          : { ...request, maxTokens: 16_384 }
      })
    }
    const schema = { type: 'object', additionalProperties: false, properties: {}, required: [] }
    agent.ctx.tools.register({
      name: 'council_forbidden_probe', description: 'Verify that child-local tools cannot bypass Council.',
      parameters: schema,
      output: { schema, render: () => [] },
      async execute() { forbiddenExecutions += 1; return {} },
    })
    const probeIndex = guardChecks.length
    guardChecks.push(agent.ctx.tools.execute({
      name: 'council_forbidden_probe', arguments: {}, agent,
      callId: `guard-${probeIndex}`, signal: new AbortController().signal,
    }).then(result => assert.equal(result.isError, true, JSON.stringify({ probeIndex, mode: activeMode, locale: activeLocale,
      childId: String(agent.id), forbiddenExecutions, policyMarkerPresent: agent.session.snapshotEvents().some(event =>
        event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.source?.childPolicy)) }))))
  }, { global: true })
  ctx.llm.registerAdapter(['council-test', 'council-review', 'council-parent'], new TestAdapter())
  ctx.on('user-questions/request', async ({ questions }) => {
    const id = questions[0]?.id
    const choose = index => ({ answers: [{ id, selected: [questions[0].options[index].label] }] })
    if (id === 'context-mode') return choose(activeMode === 'chat' ? 0 : 1)
    if (id === 'context-source-mode') {
      assert.equal(chatCalls.length, (activeChatRun - 1) * 4, 'Model work occurred before source selection/consent')
      return choose(0)
    }
    if (id === 'context-confirm') {
      assert.equal(chatCalls.length, (activeChatRun - 1) * 4, 'Model work occurred before final consent')
      assert(questions[0].detail.includes('CHAT_BACKGROUND_SENTINEL'), 'Final preview omitted actual public background')
      assert(questions[0].detail.includes('council-test/a') && questions[0].detail.includes('council-review/c'), 'Final preview omitted a recipient route')
      confirmedChatRuns.add(activeChatRun)
      return choose(0)
    }
    assert.deepEqual(questions.map(question => question.id), ['answerers', 'reviewers', 'arbiter', 'question'], questions[0]?.detail)
    assert.equal(ctx.sessionProjections.snapshot(activeParent.session).values.sessionListMetadata.blank, false,
      'A new session must be retained before the picker opens')
    const select = (id, provider = 'council-test') => questions[0].options.find(option => option.label.endsWith(`[${provider}/${id}]`)).label
    return { answers: [
      { id: 'answerers', selected: [select('a'), select('b')] },
      { id: 'reviewers', selected: [select('c', 'council-review')] },
      { id: 'arbiter', selected: [select('a')] },
      { id: 'question', selected: [], custom: 'Compare two independent solutions.' },
    ] }
  }, { global: true, prepend: true })
  const exit = ctx.get('appExit')
  void (async () => {
    await ctx.get('loader').await()
    const activationApi = typeof ctx.subagents.startActivation === 'function'
    if (SESSION_FORMAT_VERSION >= 4) {
      const modules = ctx.get('clientModules')
      assert(modules, 'Modern host must provide the Client module graph')
      const councilClient = modules.graph().entries.find(entry => entry.id === '@greenhats/dsh-council')
      assert(councilClient?.immediately && councilClient.inject.includes('@deepseek-ai/dsh-client-ui-chat'),
        'A fresh process must advertise the Council Client half, not merely its Host command')
    }
    for (const locale of ['en', 'zh']) {
      activeLocale = locale
      await setLocale(ctx, locale)
      const handle = await ctx.agents.create({
        sessionId: `session-council-host-${locale}`,
        meta: { cwd: process.cwd() }, agentOptions: { provider: 'council-parent', model: 'parent' },
        setup: async agentContext => { await ctx.agentPresets.mount(agentContext) },
      })
      const { agent } = handle
      activeParent = agent
      await agent.whenIdle()
      if (locale === 'zh') {
        agent.followup(createUserMessage({ content: [{ type: 'text', text: 'PARENT_HISTORY_SENTINEL' }], source: { kind: 'user' } }))
        await agent.whenIdle()
      }
      const stepsBefore = agent.session.snapshotEvents().filter(event => event.type === 'step/start').length
      const callsBefore = calls.length
      const execution = await ctx.commands.execute(agent, '/council', [], new AbortController().signal)
      assert.equal(execution?.result.kind, 'success', execution?.result.text)
      assert(execution.result.text.includes('HOST_VERIFIED_FINAL'))
      assert(execution.result.text.includes(locale === 'en' ? '# Council Decision' : '# 议会裁决'))
      assert.equal(ctx.sessionProjections.snapshot(agent.session).values.sessionListMetadata.blank, false)
      const events = agent.session.snapshotEvents()
      assert(events.some(event => event.type === 'command/done' && event.data.text.includes('HOST_VERIFIED_FINAL')))
      assert.equal(events.filter(event => event.type === 'step/start').length, stepsBefore, 'Unexpected parent model completion')
      const producerEvents = events.filter(event => event.type === 'agent/inbox/spliced')
        .flatMap(event => event.data.inserted.map(message => ({ event, message })))
      const question = producerEvents.find(({ message }) => message.source?.kind === 'dsh-council' && message.source.question)
      const decision = producerEvents.find(({ message }) => message.source?.kind === 'dsh-council' && message.source.result)
      assert(question && decision && question.event.seq < decision.event.seq, 'Question must precede the persisted Council response')
      assert.equal(question.message.source.question.text, 'Compare two independent solutions.')
      assert.equal(decision.message.source.result.presentation.answerMarkdown, 'HOST_VERIFIED_FINAL')
      assert(decision.message.source.result.presentation.auditMarkdown.includes('council-test/'))
      assert.equal(execution.result.sourceEventSeq, decision.event.seq, 'Command outcome must reference its authoritative response')
      assert(agent.inbox.nextStep.some(message => message.source?.result?.presentation?.answerMarkdown === 'HOST_VERIFIED_FINAL'),
        'The final response must be durably queued for a later ordinary parent turn')
      assert(!events.some(event => event.type === 'user/message' && event.data.source?.kind === 'dsh-council' && (event.data.source.question || event.data.source.result)),
        'Producer context must not preempt the first protected system head')
      const progress = events.filter(event => event.type === 'agent/inbox/spliced')
        .flatMap(event => event.data.inserted).filter(message => message.source?.kind === 'dsh-council' && message.source.ui)
      assert(progress.length > 0 && progress.at(-1).source.ui.status === 'success')
      assert(!JSON.stringify(progress.map(message => message.source.ui)).includes('council-test/'), 'Progress metadata must remain anonymous')
      assert(!events.some(event => event.type === 'assistant/message' && event.seq > (question?.event.seq ?? Infinity)), 'Council must not fabricate a parent assistant response')
      const currentCalls = calls.slice(callsBefore)
      assert.deepEqual(currentCalls.map(call => `${call.provider}/${call.model}`).sort(), [
        'council-review/c', 'council-test/a', 'council-test/a', 'council-test/b',
      ])
      assert.equal(ctx.agents.list().filter(child => child.session.header.parentSession === agent.id).length, 0, 'Collected children must release live Agents')
      // This is an explicit later user request, not a Council-generated completion.
      // It must let AgentLoop establish its first protected head before admission.
      allowParentNotice = true
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'PARENT_FOLLOWUP_SENTINEL' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      allowParentNotice = false
      const headSeq = agent.session.surface.nodes[0]
      if (SESSION_FORMAT_VERSION >= 4) assert.equal(agent.session.snapshotEvents().find(event => event.seq === headSeq)?.type, 'system/message', 'First parent request must keep the protected system head')
      if (activationApi) {
        const childId = currentCalls.find(call => call.model === 'b').sessionId
        // The Council receipt is disposed. Messaging must cold-materialize a new
        // Agent, replay its persisted policy, and reject child-local tools again.
        allowParentNotice = true
        await ctx.subagents.sendMessage(agent, childId, [{ type: 'text', text: 'COUNCIL_CONTINUATION_SENTINEL' }], { signal: new AbortController().signal })
        await ctx.subagents.waitForChildren(agent)
        await agent.whenIdle()
        allowParentNotice = false
        assert.equal(ctx.agents.list().filter(child => child.session.header.parentSession === agent.id).length, 0)
      }
      await ctx.sessions.flush(agent.session)
      await handle.dispose()
      let reloaded
      if (typeof ctx.sessionPersistence.load === 'function') reloaded = await ctx.sessionPersistence.load(agent.id)
      else {
        const stored = await ctx.sessionPersistence.open(agent.id, 'read')
        try { reloaded = await stored.read() } finally { await stored.close() }
      }
      assert(reloaded.events.some(event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.source?.result?.presentation?.answerMarkdown === 'HOST_VERIFIED_FINAL')),
        'The rendered final-response metadata must survive cold reload')
      assert(reloaded.events.some(event => event.type === 'command/done' && event.data.text?.includes('HOST_VERIFIED_FINAL')), 'Final result must survive cold reload')
    }
    await Promise.all(guardChecks)
    const topicGuardChecks = guardChecks.length
    assert.equal(topicGuardChecks, activationApi ? 10 : 8)
    assert.equal(forbiddenExecutions, 0)
    assert.equal(calls.length, 8)
    assert.equal(continuations, activationApi ? 2 : 0)
    const chat = { supported: SESSION_FORMAT_VERSION >= 4, calls: 0, runs: 0, continuations: 0, deniedProbes: [], guardChecks: 0, parentFollowups: 0 }
    if (chat.supported) {
      activeMode = 'chat'
      activeLocale = 'en'
      await setLocale(ctx, 'en')
      const handle = await ctx.agents.create({ sessionId: 'session-council-host-chat', meta: { cwd: process.cwd() },
        agentOptions: { provider: 'council-parent', model: 'parent' }, setup: async agentContext => { await ctx.agentPresets.mount(agentContext) } })
      const { agent } = handle
      activeParent = agent
      await agent.whenIdle()
      assert.equal(typeof agent.session.deriveMessages, 'function')
      assert.equal(typeof agent.inbox.clear, 'function')
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'CHAT_BACKGROUND_SENTINEL: preserve this hard constraint.' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      const stepsBefore = agent.session.snapshotEvents().filter(event => event.type === 'step/start').length
      for (const run of [1, 2, 3]) {
        activeChatRun = run
        if (run === 3) {
          agent.inbox.clear()
          assert.equal(agent.inbox.nextStep.length, 0)
          assert.equal(agent.inbox.nextTurn.length, 0)
        }
        const execution = await ctx.commands.execute(agent, '/council', [], new AbortController().signal)
        assert.equal(execution?.result.kind, 'success', execution?.result.text)
        assert(execution.result.text.includes(`HOST_CHAT_FINAL_${run}`))
        assert.equal(chatCalls.length, run * 4)
        assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'step/start').length, stepsBefore, 'Council must not wake the parent for a summary')
        const packet = chatMaterials.get(`${run}/answer`).packet
        if (run === 2) assert.equal(packet.sources.filter(source => source.text.includes('HOST_CHAT_FINAL_1')).length, 1, 'Active pending prior result must enter the next packet exactly once')
        if (run === 3) assert(!JSON.stringify(packet).includes('HOST_CHAT_FINAL_1') && !JSON.stringify(packet).includes('HOST_CHAT_FINAL_2'), 'Clear must prevent historical insert resurrection')
        chat.runs += 1
      }
      const producerMessages = agent.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced').flatMap(event => event.data.inserted)
      const packets = producerMessages.map(message => message.source?.runRecord).filter(record => record?.recordKind === 'packet')
      const materials = producerMessages.map(message => message.source?.runRecord).filter(record => record?.recordKind === 'material')
      assert.equal(packets.length, 3, 'Persist exactly one packet per run')
      assert.equal(materials.length, 9, 'Persist exactly one material per stage/run')
      for (const record of packets) assert.equal(record.packet.packetHash, hash(record.packet.packet))
      for (const record of materials) {
        assert.equal(record.material.payloadHash, hash(record.material.payload))
        assert.equal(record.material.packetHash, packets.find(packet => packet.runId === record.runId).packet.packetHash)
      }
      for (const terminal of producerMessages.filter(message => message.source?.result?.mode === 'chat' && message.source.result.status === 'success')) {
        assert(!textOf(terminal).includes('# Council Audit') && !textOf(terminal).includes('council-test/'), 'Canonical result body must not contain audit/model mappings')
        assert.equal(terminal.source.result.modelReturn.coverage.answerersSucceeded, 2)
      }
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'CHAT_PARENT_FOLLOWUP_SENTINEL: continue the recommended plan.' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      assert.equal(chatParentFollowups, 1)
      const third = chatCalls.slice(8)
      const validChildId = third.find(call => !call.tools?.some(tool => tool.name === 'structured_output') && call.model === 'b').sessionId
      allowParentNotice = true
      await ctx.subagents.sendMessage(agent, validChildId, [{ type: 'text', text: 'CHAT_COLD_VALID' }], { signal: new AbortController().signal })
      await ctx.subagents.waitForChildren(agent)
      await agent.whenIdle()
      allowParentNotice = false
      assert.equal(chatContinuations, 1, 'Cold resume must restore route/output/no-Web policy')
      const probes = [
        ['route', third.find(call => !call.tools?.length && call.model === 'a').sessionId, 'approved route'],
        ['max-tokens', validChildId, 'output cap'],
        ['huge-system', chatCalls.find(call => !call.tools?.length && call.model === 'a').sessionId, 'context window'],
      ]
      for (const [probe, childId, diagnostic] of probes) {
        const before = chatCalls.length + chatContinuations
        const errorStart = coldErrors.length
        coldProbe = probe
        allowParentNotice = true
        await ctx.subagents.sendMessage(agent, childId, [{ type: 'text', text: `CHAT_COLD_DENIED_${probe}` }], { signal: new AbortController().signal })
        await ctx.subagents.waitForChildren(agent)
        await agent.whenIdle()
        assert.equal(chatCalls.length + chatContinuations, before, `${probe} must fail before adapter dispatch`)
        assert(coldErrors.slice(errorStart).some(error => String(error.message).includes(diagnostic)), `Missing explicit ${probe} guard failure: ${coldErrors.slice(errorStart).map(error => error.message).join('; ')}`)
        chatDeniedProbes.push(probe)
        coldProbe = undefined
        allowParentNotice = false
      }
      await Promise.all(guardChecks)
      assert.equal(forbiddenExecutions, 0)
      await ctx.sessions.flush(agent.session)
      await handle.dispose()
      Object.assign(chat, { calls: chatCalls.length, continuations: chatContinuations, deniedProbes: chatDeniedProbes,
        guardChecks: guardChecks.length - topicGuardChecks, parentFollowups: chatParentFollowups })
    }
    writeFileSync('report.json', JSON.stringify({ calls: calls.length, guardChecks: topicGuardChecks, coldReloads: 2, continuations,
      api: activationApi ? 'activation' : 'legacy', locales: ['en', 'zh'], chat }))
    process.stdout.write('COUNCIL_HOST_OK\n')
    exit(0)
  })().catch(error => { process.stderr.write(`${error.stack}\n`); exit(1) })
}
