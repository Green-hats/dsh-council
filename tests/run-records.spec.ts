import type { Context } from '@deepseek-ai/cordis'
import { Inbox } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, vi } from 'vitest'
import { compileContextPacket, createAnswerCorpus, createPacketRecord, createReviewCorpus, createStageMaterial, hashText, sha256Canonical } from '../src/context-packet.js'
import type { CouncilChildPolicyV2 } from '../src/child-policy.js'
import { createModelReturn, renderModelReturn } from '../src/handoff.js'
import {
  COUNCIL_RUN_RECORDS_KEY,
  councilResultV2Schema,
  councilRunStateSchema,
  councilRunRecordSchema,
  councilChildBindingSchema,
  findChildBindingInState,
  findCouncilChildBinding,
  createRunRecords,
  isCouncilRunRecordMarker,
  readCouncilRunRecord,
  registerCouncilRunRecords,
  type CouncilResultV2,
} from '../src/run-records.js'

const notifications = { inserted() {}, discarded() {}, claimed() {} }
const fresh = (id = 'records-parent') => Session.create(SessionId(id))
function harness(session = fresh()) {
  let definition: ProjectionDefinition<typeof COUNCIL_RUN_RECORDS_KEY> | undefined
  const stateOf = vi.fn((current: Session, key: string) => {
    if (definition === undefined || key !== definition.key) return undefined
    return definition.stateSchema.parse(current.snapshotEvents().reduce(definition.apply,
      definition.init(current.header, current.inheritedEventCount)))
  })
  const ctx = { sessionProjections: {
    register(unit: ProjectionDefinition<typeof COUNCIL_RUN_RECORDS_KEY>) { definition = unit; return () => {} }, stateOf,
  } } as unknown as Context
  registerCouncilRunRecords(ctx)
  const inbox = new Inbox(session, notifications)
  const inject = vi.fn((message: UserMessage) => inbox.append('next-step', message))
  const parent = { session, inject }
  return { ctx, session, inbox, inject, parent, records: createRunRecords(ctx, parent), stateOf,
    definition: () => { if (definition === undefined) throw new Error('Missing projection'); return definition } }
}
function packet(runId = 'run', parentSessionId = 'records-parent') {
  const text = 'user condition'
  return createPacketRecord({ ...compileContextPacket({ topicOriginal: 'topic', candidates: [{
    source: { alias: 'S1', kind: 'user-text', epistemic: 'user-asserted', text },
    privateRef: { alias: 'S1', parentSessionId, messageId: 'source-message', blockIndex: 0, origin: 'surface', textHash: hashText(text) },
  }], selectedAliases: ['S1'] }), runId, capturedThroughSeq: -1, pendingPolicy: 'included', providerSet: [{ provider: 'p', model: 'm' }] })
}
function prepareChat(h: ReturnType<typeof harness>, runId = 'run') {
  h.records.transition({ version: 2, runId, mode: 'chat', status: 'CREATED' })
  const value = packet(runId, String(h.session.id))
  h.records.commitPacket(value)
  return value
}
function success(h: ReturnType<typeof harness>, mode: 'chat' | 'topic-only' = 'chat', runId = 'run', locale: 'en' | 'zh' = 'en'): Extract<CouncilResultV2, { status: 'success' }> {
  const packetHash = h.records.read(runId)?.packet?.record.packetHash
  const modelReturn = createModelReturn({ runId, ...(packetHash === undefined ? {} : { packetHash }),
    decision: { answerMarkdown: '## 审计\n\nCanonical final answer.', decisionDeltas: [], consensus: [], contradictions: [], blindSpots: [], confidenceNotes: 'Uncertain.', citations: [] },
    coverage: { answerersRequested: 2, answerersSucceeded: 1, reviewersRequested: 1, reviewersSucceeded: 1 },
    limitations: [], sourceAliases: mode === 'chat' ? ['S1'] : [],
  })
  return { version: 2, commandId: runId, runId, parentSessionId: String(h.session.id), mode, locale, status: 'success', modelReturn,
    presentation: { answerMarkdown: modelReturn.answerMarkdown, auditMarkdown: 'PRIVATE_AUDIT_SENTINEL' } }
}
function producer(source: unknown, text?: string): UserMessage {
  return createUserMessage({ content: text === undefined ? [] : [{ type: 'text', text }], source: source as UserMessage['source'] })
}
function insert(h: ReturnType<typeof harness>, message: UserMessage) { h.inbox.append('next-step', message) }

const reviewOutput = { evaluations: [{ answerId: 'Answer A', strengths: ['clear'], weaknesses: [] }], consensus: [], contradictions: [], coverageGaps: [], uniqueInsights: [], blindSpots: [], ranking: ['Answer A'] }

describe('strict versioned run contracts', () => {
  it('discriminates context mode and status without fabricating missing packet or terminal references', () => {
    const base = { version: 2, runId: 'r' }
    expect(councilRunStateSchema.safeParse({ ...base, mode: 'chat', status: 'CREATED' }).success).toBe(true)
    expect(councilRunStateSchema.safeParse({ ...base, mode: 'chat', status: 'ANSWERING' }).success).toBe(false)
    expect(councilRunStateSchema.safeParse({ ...base, mode: 'topic-only', status: 'ANSWERING' }).success).toBe(true)
    expect(councilRunStateSchema.safeParse({ ...base, mode: 'topic-only', status: 'PACKET_COMMITTED' }).success).toBe(false)
    expect(councilRunStateSchema.safeParse({ ...base, mode: 'topic-only', status: 'CAPTURED' }).success).toBe(false)
    expect(councilRunStateSchema.safeParse({ ...base, mode: 'topic-only', status: 'SUCCEEDED' }).success).toBe(false)
    expect(councilRunStateSchema.safeParse({ ...base, mode: 'chat', status: 'FAILED' }).success).toBe(true)
    expect(councilRunStateSchema.safeParse({ ...base, mode: 'topic-only', status: 'CANCELED', terminalSeq: 2 }).success).toBe(true)
  })

  it('requires locale, consistent run IDs and mode-compatible ModelReturn on successful v2 results', () => {
    const h = harness(); prepareChat(h)
    const valid = success(h)
    expect(councilResultV2Schema.safeParse(valid).success).toBe(true)
    const { locale: _locale, ...withoutLocale } = valid
    expect(councilResultV2Schema.safeParse(withoutLocale).success).toBe(false)
    for (const change of [{ version: 3 }, { commandId: 'other' }, { mode: 'topic-only' },
      { modelReturn: { ...valid.modelReturn, runId: 'other' } },
      { presentation: { answerMarkdown: 'replacement', auditMarkdown: '' } }]) {
      expect(councilResultV2Schema.safeParse({ ...valid, ...change }).success).toBe(false)
    }
    expect(councilResultV2Schema.safeParse({ ...valid, status: 'error' }).success).toBe(false)
  })
})

describe('durable producer records and pure projection', () => {
  it('registers a host-only stateVersion 3 projection and reads only through stateOf', () => {
    const h = harness()
    expect(h.definition()).toMatchObject({ key: COUNCIL_RUN_RECORDS_KEY, stateVersion: 3 })
    expect(h.definition()).not.toHaveProperty('wire')
    expect(h.records.read('absent')).toBeUndefined()
    expect(h.stateOf).toHaveBeenCalled()
    expect(h.inject).not.toHaveBeenCalled()
    expect(h.session.deriveMessages()).toEqual([])
  })

  it('RUN/REC stores packet entities only once and progress only references their hash', () => {
    const h = harness()
    const value = prepareChat(h)
    const first = h.records.commitPacket(value)
    const again = createRunRecords(h.ctx, h.parent).commitPacket(value)
    expect(again).toBe(first)
    expect(h.inject).toHaveBeenCalledTimes(2)
    const view = h.records.read('run')
    expect(view?.state).toMatchObject({ mode: 'chat', status: 'PACKET_COMMITTED', packetHash: value.packetHash })
    expect(view?.packet?.record).toEqual(value)
    expect(view?.state).not.toHaveProperty('packet')
    expect(Object.isFrozen(view?.packet?.record.packet)).toBe(true)
    expect(h.inbox.nextStep.every(message => message.content.length === 0)).toBe(true)
    expect(h.inbox.nextStep.every(isCouncilRunRecordMarker)).toBe(true)
    expect(h.session.surface.nodes).toEqual([])
  })

  it('MAT-01 persists stage entities once and rejects different versions or corpus swaps', () => {
    const h = harness(); const saved = prepareChat(h)
    const answer = createStageMaterial({ stage: 'answer', payload: { packet: saved.packet } })
    const corpus = createAnswerCorpus([{ answerId: 'Answer A', text: 'A' }])
    const review = createStageMaterial({ stage: 'review', payload: { packet: saved.packet, answerCorpus: corpus } })
    const arbiter = createStageMaterial({ stage: 'arbiter', payload: { packet: saved.packet, answerCorpus: corpus,
      reviewCorpus: createReviewCorpus([{ reviewId: 'Review 1', output: reviewOutput }]), aggregateRanking: [{ answerId: 'Answer A', averageRank: 1, votes: 1 }] } })
    expect(() => h.records.commitMaterial('run', review)).toThrow()
    const seq = h.records.commitMaterial('run', answer)
    expect(h.records.commitMaterial('run', answer)).toBe(seq)
    h.records.commitMaterial('run', review)
    const changed = createStageMaterial({ stage: 'review', payload: { packet: saved.packet,
      answerCorpus: createAnswerCorpus([{ answerId: 'Answer A', text: 'changed' }]) } })
    expect(() => h.records.commitMaterial('run', changed)).toThrow()
    if (arbiter.stage !== 'arbiter') throw new Error('Wrong stage')
    const swapped = createStageMaterial({ stage: 'arbiter', payload: { ...arbiter.payload, answerCorpus: createAnswerCorpus([{ answerId: 'Answer A', text: 'swapped' }]) } })
    expect(() => h.records.commitMaterial('run', swapped)).toThrow()
    h.records.commitMaterial('run', arbiter)
    expect(h.records.read('run')?.materials).toHaveLength(3)
    expect(h.records.read('run')?.state.status).toBe('ARBITRATING')
  })

  it('RUN-02 uses one canonical real Inbox seq across instances, late cancellation and late completion', () => {
    const h = harness(); prepareChat(h)
    const result = success(h)
    const text = renderModelReturn(result.modelReturn, result.locale)
    const before = Number(h.session.seq)
    const seq = h.records.commitTerminal(result, text)
    expect(Number(seq)).toBe(before)
    const event = h.session.eventAt(seq)
    expect(event?.type).toBe('agent/inbox/spliced')
    if (event?.type !== 'agent/inbox/spliced') throw new Error('Missing real producer event')
    expect(event.data.inserted[0]?.content).toEqual([{ type: 'text', text }])
    expect(text).not.toContain('PRIVATE_AUDIT_SENTINEL')
    expect(h.records.read('run')?.terminal).toMatchObject({ sourceEventSeq: seq, text, textHash: hashText(text), result })
    expect(h.records.read('run')?.state).toMatchObject({ status: 'SUCCEEDED', terminalSeq: seq })
    const count = h.inject.mock.calls.length
    const other = createRunRecords(h.ctx, h.parent)
    expect(other.commitTerminal(result, text)).toBe(seq)
    expect(() => other.commitTerminal({ ...result, parentSessionId: 'other-parent' }, text)).toThrow(/invalid persisted/)
    expect(other.commitTerminal({ version: 2, runId: 'run', commandId: 'run', parentSessionId: String(h.session.id), mode: 'chat', locale: 'en', status: 'canceled' }, 'Canceled late')).toBe(seq)
    expect(h.inject).toHaveBeenCalledTimes(count)
    expect(h.session.surface.nodes).toEqual([])
  })

  it('reopen reads original packet/terminal but never reinserts cleared pending or starts a model', () => {
    const h = harness(); const original = prepareChat(h)
    const result = success(h, 'chat', 'run', 'zh')
    const seq = h.records.commitTerminal(result, renderModelReturn(result.modelReturn, 'zh'))
    h.inbox.clear()
    const restored = Session.create(h.session.id, h.session.snapshotEvents(), h.session.header)
    const reopened = harness(restored)
    expect(reopened.inbox.hasPending).toBe(false)
    expect(reopened.records.read('run')?.packet?.record.packetHash).toBe(original.packetHash)
    expect(reopened.records.read('run')?.terminal?.sourceEventSeq).toBe(seq)
    expect(reopened.records.commitTerminal(result, renderModelReturn(result.modelReturn, 'zh'))).toBe(seq)
    expect(reopened.inject).not.toHaveBeenCalled()
    expect(reopened.inbox.hasPending).toBe(false)
  })

  it('deduplicates inbox-to-admission copies and stable duplicate records without regressing state', () => {
    const h = harness(); prepareChat(h)
    const older = h.inbox.nextStep[0]
    if (older === undefined) throw new Error('Missing created marker')
    const stateBefore = h.records.read('run')?.state
    h.session.append('user/message', older, { surfaceOp: 'append' })
    expect(h.records.read('run')?.state).toEqual(stateBefore)
    const result = success(h)
    const seq = h.records.commitTerminal(result, renderModelReturn(result.modelReturn))
    const terminal = h.inbox.nextStep.at(-1)!
    h.session.append('user/message', terminal, { surfaceOp: 'append' })
    expect(h.records.read('run')?.terminal?.sourceEventSeq).toBe(seq)
  })

  it('supports topic-only stages and terminal without a synthetic packet/hash', () => {
    const h = harness()
    h.records.transition({ version: 2, runId: 'run', mode: 'topic-only', status: 'CREATED' })
    h.records.transition({ version: 2, runId: 'run', mode: 'topic-only', status: 'ANSWERING' })
    const result = success(h, 'topic-only')
    h.records.commitTerminal(result, renderModelReturn(result.modelReturn))
    const view = h.records.read('run')
    expect(view?.state.status).toBe('SUCCEEDED')
    expect(view?.packet).toBeUndefined()
    expect(view?.state).not.toHaveProperty('packetHash')
    expect(view?.terminal?.result).toEqual(result)
  })

  it('allows explicit chat-to-topic fallback only before any packet/material/terminal was committed', () => {
    const h = harness()
    h.records.transition({ version: 2, runId: 'run', mode: 'chat', status: 'CREATED' })
    h.records.transition({ version: 2, runId: 'run', mode: 'chat', status: 'CAPTURED' })
    h.records.transition({ version: 2, runId: 'run', mode: 'topic-only', status: 'CREATED' })
    expect(h.records.read('run')?.mode).toBe('topic-only')
    expect(h.records.read('run')?.packet).toBeUndefined()
    expect(() => h.records.transition({ version: 2, runId: 'run', mode: 'chat', status: 'PREPARING' })).toThrow()
    const committed = harness(); prepareChat(committed)
    expect(() => committed.records.transition({ version: 2, runId: 'run', mode: 'topic-only', status: 'CREATED' })).toThrow()
  })

  it('prevents cancellation from being resurrected by a late success', () => {
    const h = harness(); prepareChat(h)
    const lateSuccess = success(h)
    const canceled: CouncilResultV2 = { version: 2, runId: 'run', commandId: 'run', parentSessionId: String(h.session.id), mode: 'chat', locale: 'en', status: 'canceled' }
    const seq = h.records.commitTerminal(canceled, 'Canceled')
    expect(h.records.commitTerminal(lateSuccess, renderModelReturn(lateSuccess.modelReturn))).toBe(seq)
    expect(h.records.read('run')?.terminal?.result.status).toBe('canceled')
    expect(h.records.read('run')?.state.status).toBe('CANCELED')
  })

  it('reopens the exact first error body and keeps it canonical against late opposite results', () => {
    const h = harness(); prepareChat(h)
    const lateSuccess = success(h)
    const error: CouncilResultV2 = { version: 2, runId: 'run', commandId: 'run', parentSessionId: String(h.session.id), mode: 'chat', locale: 'en', status: 'error' }
    const text = '  Specific failure, not cancellation.\n诊断保持原样 e\u0301\n'
    const seq = h.records.commitTerminal(error, text)
    h.inbox.clear()
    const restored = Session.create(h.session.id, h.session.snapshotEvents(), h.session.header)
    const reopened = harness(restored)
    expect(reopened.records.read('run')?.terminal).toMatchObject({ result: error, text, sourceEventSeq: seq })
    expect(reopened.records.commitTerminal({ ...error, status: 'canceled' }, 'Opposite late cancellation')).toBe(seq)
    expect(reopened.records.commitTerminal(lateSuccess, renderModelReturn(lateSuccess.modelReturn))).toBe(seq)
    expect(reopened.records.read('run')?.terminal?.text).toBe(text)
    expect(reopened.records.read('run')?.state.status).toBe('FAILED')
    expect(Object.isFrozen(reopened.records.read('run')?.terminal)).toBe(true)
    expect(reopened.inject).not.toHaveBeenCalled()
    expect(reopened.inbox.hasPending).toBe(false)
    const tooLarge = harness(); prepareChat(tooLarge)
    expect(() => tooLarge.records.commitTerminal(error, '中'.repeat(22_000))).toThrow()
  })

  it('validates text, language, aliases, packet binding and chronology before injection', () => {
    const h = harness(); const saved = prepareChat(h)
    const result = success(h)
    const before = h.inject.mock.calls.length
    expect(() => h.records.commitTerminal(result, 'full audit instead of handoff')).toThrow(/differs/)
    expect(() => h.records.commitTerminal(result, renderModelReturn(result.modelReturn, 'zh'))).toThrow(/differs/)
    expect(() => h.records.commitTerminal({ ...result, modelReturn: { ...result.modelReturn, packetHash: hashText('other') } },
      renderModelReturn({ ...result.modelReturn, packetHash: hashText('other') }))).toThrow()
    const badAlias = { ...result.modelReturn, decisionDeltas: [{ sourceAliases: ['S2'], disposition: 'revised' as const, text: 'x' }] }
    expect(() => h.records.commitTerminal({ ...result, modelReturn: badAlias }, renderModelReturn(badAlias))).toThrow()
    expect(() => h.records.transition({ version: 2, runId: 'run', mode: 'chat', status: 'CAPTURED' })).toThrow()
    expect(() => h.records.transition({ version: 2, runId: 'run', mode: 'chat', status: 'SUCCEEDED', packetHash: saved.packetHash, terminalSeq: 0 })).toThrow()
    expect(h.inject).toHaveBeenCalledTimes(before)
  })

  it('ignores inherited producer history, foreign sources, ordinary JSON text and legacy v1 results', () => {
    const parent = harness(); prepareChat(parent)
    const childId = SessionId('fork-child')
    const child = Session.create(childId, parent.session.snapshotEvents(), { ...parent.session.header, id: childId, parentSession: parent.session.id, isSeeded: true }, SessionLogOffset(parent.session.seq))
    const h = harness(child)
    expect(h.records.read('run')).toBeUndefined()
    insert(h, producer({ kind: 'user' }, '{"kind":"dsh-council","runRecord":{}}'))
    insert(h, producer({ kind: 'user', runRecord: {} }))
    insert(h, producer({ kind: 'dsh-council', result: { version: 1, commandId: 'legacy', status: 'success' } }, 'legacy full audit'))
    expect(h.records.read('run')).toBeUndefined()
    h.records.transition({ version: 2, runId: 'own', mode: 'topic-only', status: 'CREATED' })
    expect(h.records.read('own')?.mode).toBe('topic-only')
  })

  it.each([
    { version: 3, recordKind: 'packet' },
    { version: 2, runId: 'run', parentSessionId: 'other', recordKind: 'state', state: { version: 2, runId: 'run', mode: 'topic-only', status: 'CREATED' } },
    { version: 2, runId: 'run', parentSessionId: 'records-parent', recordKind: 'state', state: { version: 2, runId: 'other', mode: 'topic-only', status: 'CREATED' } },
    { version: 2, runId: 'run', parentSessionId: 'records-parent', recordKind: 'state', state: { version: 2, runId: 'run', mode: 'topic-only', status: 'ANSWERING' } },
  ])('bad producer data marks state bad without throwing in shared fold: %o', (runRecord) => {
    const h = harness()
    insert(h, producer({ kind: 'dsh-council', runRecord }))
    const definition = h.definition()
    const initial = definition.init(h.session.header, h.session.inheritedEventCount)
    const event = h.session.ownEvents()[0]!
    expect(() => definition.apply(initial, event)).not.toThrow()
    expect(definition.apply(initial, event).bad).toBe(true)
    expect(() => h.records.read('run')).toThrow(/invalid persisted/)
    // Marker recognition checks the local DTO; lifecycle/parent binding is projection-owned.
    if (runRecord.version !== 2) expect(isCouncilRunRecordMarker(h.inbox.nextStep[0])).toBe(false)
  })

  it('rejects conflicting records/terminals, nonempty markers, unknown result versions and hash tampering', () => {
    for (const scenario of ['packet-hash', 'marker-text', 'terminal-conflict', 'result-version', 'metadata-extra']) {
      const h = harness(); const saved = prepareChat(h)
      if (scenario === 'packet-hash') insert(h, producer({ kind: 'dsh-council', runRecord: { version: 2, runId: 'run', parentSessionId: String(h.session.id), recordKind: 'packet', packet: { ...saved, packetHash: hashText('changed') } } }))
      if (scenario === 'marker-text') insert(h, producer({ kind: 'dsh-council', runRecord: { version: 2, runId: 'other', parentSessionId: String(h.session.id), recordKind: 'state', state: { version: 2, runId: 'other', mode: 'topic-only', status: 'CREATED' } } }, 'spoof'))
      if (scenario === 'terminal-conflict') {
        const result = success(h)
        h.records.commitTerminal(result, renderModelReturn(result.modelReturn))
        insert(h, producer({ kind: 'dsh-council', result: { version: 2, runId: 'run', commandId: 'run', parentSessionId: String(h.session.id), mode: 'chat', locale: 'en', status: 'canceled' } }, 'Conflicting cancellation'))
      }
      if (scenario === 'result-version') insert(h, producer({ kind: 'dsh-council', result: { version: 99 } }, 'unknown'))
      if (scenario === 'metadata-extra') insert(h, producer({ kind: 'dsh-council', result: success(h), private: 'SECRET_SENTINEL' }, 'spoof'))
      expect(() => h.records.read('run')).toThrow(/invalid persisted/)
    }
  })

  it('preserves state identity for irrelevant/duplicate events and refuses unavailable projection', () => {
    const h = harness(); prepareChat(h)
    const definition = h.definition()
    const initial = definition.init(h.session.header, h.session.inheritedEventCount)
    const event = h.session.ownEvents()[0]!
    const once = definition.apply(initial, event)
    expect(definition.apply(once, event)).toBe(once)
    expect(definition.apply(once, h.session.append('turn/start', { turn: 1 }))).toBe(once)
    const missing = { sessionProjections: { stateOf: () => undefined } } as unknown as Context
    expect(() => readCouncilRunRecord(missing, h.parent, 'run')).toThrow(/projection unavailable/)
  })
})

function childPolicy(h: ReturnType<typeof harness>, childId = 'council-child', runId = 'run'): CouncilChildPolicyV2 {
  const entry = h.records.read(runId)
  if (entry === undefined) throw new Error('Missing test run')
  const common = { version: 2 as const, policyVersion: 2 as const, childId, parentId: String(h.session.id), runId,
    persona: 'PRIVATE_PERSONA_SENTINEL', maxTokens: 2_048, approvedRoute: { provider: 'p', model: 'm' } }
  if (entry.mode === 'chat') {
    if (entry.packet === undefined) throw new Error('Missing test packet')
    return { ...common, mode: 'chat', packetHash: entry.packet.record.packetHash, allowedGlobalTools: [],
      budgetPolicy: { contextWindow: 32_768, maxOutputTokens: 2_048, safetyMarginTokens: 2_048, estimatorVersion: 'test-meter:v1' } }
  }
  return { ...common, mode: 'topic-only', allowedGlobalTools: ['web_fetch'] }
}
function projected(h: ReturnType<typeof harness>) {
  const definition = h.definition()
  return h.session.snapshotEvents().reduce(definition.apply, definition.init(h.session.header, h.session.inheritedEventCount))
}

describe('independent parent run child ownership binding', () => {
  it('SEC-03 commits an empty independent manifest and hashes the entire v2 policy, not a subset', () => {
    const h = harness(); const saved = prepareChat(h)
    const policy = childPolicy(h)
    const seq = h.records.commitChildBinding('run', policy)
    const binding = h.records.findChildBinding(policy.childId)
    expect(binding).toEqual({ version: 2, runId: 'run', parentSessionId: String(h.session.id), childId: policy.childId,
      mode: 'chat', policyVersion: 2, policyHash: sha256Canonical(policy), packetHash: saved.packetHash })
    const event = h.session.eventAt(seq)
    if (event?.type !== 'agent/inbox/spliced') throw new Error('Missing durable binding')
    const message = event.data.inserted[0]
    expect(message?.content).toEqual([])
    expect(message?.source).toEqual({ kind: 'dsh-council', runRecord: { ...binding, recordKind: 'child-binding' } })
    const sourceText = JSON.stringify(message?.source)
    for (const hidden of ['PRIVATE_PERSONA_SENTINEL', 'approvedRoute', 'budgetPolicy', 'maxTokens', 'allowedGlobalTools']) expect(sourceText).not.toContain(hidden)
    expect(isCouncilRunRecordMarker(message)).toBe(true)
    expect(Object.isFrozen(binding)).toBe(true)
    expect(h.session.deriveMessages()).toEqual([])
    expect(h.records.read('run')?.state.status).toBe('PACKET_COMMITTED')
  })

  it('deduplicates the same full-policy hash across instances and inbox admission', () => {
    const h = harness(); prepareChat(h)
    const policy = childPolicy(h)
    const seq = h.records.commitChildBinding('run', policy)
    const count = h.inject.mock.calls.length
    expect(createRunRecords(h.ctx, h.parent).commitChildBinding('run', { ...policy })).toBe(seq)
    expect(h.inject).toHaveBeenCalledTimes(count)
    const message = h.inbox.nextStep.at(-1)!
    const before = projected(h)
    h.session.append('user/message', message, { surfaceOp: 'append' })
    expect(h.records.read('run')?.childBindings).toHaveLength(1)
    expect(h.definition().apply(before, h.session.ownEvents().at(-1)!)).toBe(before)
    expect(findCouncilChildBinding(h.ctx, h.parent, policy.childId)).toEqual(h.records.findChildBinding(policy.childId))
  })

  it('keeps the independent ownership evidence after child policy loss, parent pending clear and cold reopen', () => {
    const h = harness(); prepareChat(h)
    const policy = childPolicy(h)
    h.records.commitChildBinding('run', policy)
    const childId = SessionId(policy.childId)
    const child = Session.create(childId, undefined, { ...h.session.header, id: childId, parentSession: h.session.id, isSeeded: false })
    const childInbox = new Inbox(child, notifications)
    childInbox.append('next-step', createUserMessage({ content: [{ type: 'text', text: 'BACKGROUND_WITHOUT_CHILD_POLICY_SENTINEL' }], source: { kind: 'user' } }))
    expect(child.snapshotEvents().some(event => JSON.stringify(event).includes('childPolicy'))).toBe(false)
    h.inbox.clear()
    const restored = Session.create(h.session.id, h.session.snapshotEvents(), h.session.header)
    const reopened = harness(restored)
    expect(reopened.records.findChildBinding(policy.childId)?.policyHash).toBe(sha256Canonical(policy))
    expect(reopened.records.read('run')?.childBindings).toHaveLength(1)
    expect(reopened.inbox.hasPending).toBe(false)
    expect(reopened.inject).not.toHaveBeenCalled()
    // Agent creation must now reject the missing policy using this parent-owned evidence.
  })

  it('validates registry-restored offline state and fails closed for bad/cross-parent/duplicate bindings', () => {
    const h = harness(); prepareChat(h)
    const policy = childPolicy(h)
    h.records.commitChildBinding('run', policy)
    const state = projected(h)
    expect(findChildBindingInState(state, String(h.session.id), policy.childId)).toEqual(h.records.findChildBinding(policy.childId))
    expect(findChildBindingInState(state, String(h.session.id), 'ordinary-unowned-child')).toBeUndefined()
    expect(() => findChildBindingInState(state, 'different-parent', policy.childId)).toThrow()
    expect(() => findChildBindingInState({ ...state, bad: true }, String(h.session.id), policy.childId)).toThrow()
    const run = state.runs[0]!
    const binding = run.childBindings[0]!
    expect(() => findChildBindingInState({ ...state, runs: [{ ...run, childBindings: [binding, binding] }] }, String(h.session.id), policy.childId)).toThrow()
    expect(() => findChildBindingInState({ ...state, runs: [{ ...run, childBindings: [{ ...binding, runId: 'wrong' }] }] }, String(h.session.id), policy.childId)).toThrow()
    expect(() => findChildBindingInState({ ...state, runs: [{ ...run, childBindings: [{ ...binding, packetHash: hashText('wrong') }] }] }, String(h.session.id), policy.childId)).toThrow()
    const { childBindings: _oldMissingField, ...oldCheckpointRun } = run
    expect(() => findChildBindingInState({ ...state, runs: [oldCheckpointRun] }, String(h.session.id), policy.childId)).toThrow()
  })

  it('rejects policy identity/route/packet/mode conflicts before any binding injection', () => {
    const h = harness(); prepareChat(h)
    const policy = childPolicy(h)
    if (policy.mode !== 'chat') throw new Error('Wrong test mode')
    const count = h.inject.mock.calls.length
    for (const changed of [
      { ...policy, parentId: 'other-parent' }, { ...policy, runId: 'other-run' },
      { ...policy, childId: String(h.session.id) }, { ...policy, packetHash: hashText('other-packet') },
      { ...policy, approvedRoute: { provider: 'unapproved', model: 'route' } },
    ]) expect(() => h.records.commitChildBinding('run', changed)).toThrow()
    expect(h.inject).toHaveBeenCalledTimes(count)
    h.records.commitChildBinding('run', policy)
    for (const changed of [
      { ...policy, persona: 'changed persona' }, { ...policy, maxTokens: 1_024 },
      { ...policy, budgetPolicy: { ...policy.budgetPolicy, estimatorVersion: 'changed:v2' } },
    ]) expect(() => h.records.commitChildBinding('run', changed)).toThrow()
    expect(h.records.findChildBinding(policy.childId)?.policyHash).toBe(sha256Canonical(policy))
  })

  it('binds a child ID to at most one run and caps the run at the full 8+8+1 roster', () => {
    const h = harness()
    h.records.transition({ version: 2, runId: 'run', mode: 'topic-only', status: 'CREATED' })
    for (let index = 0; index < 17; index += 1) h.records.commitChildBinding('run', childPolicy(h, `child-${index}`))
    expect(h.records.read('run')?.childBindings).toHaveLength(17)
    expect(() => h.records.commitChildBinding('run', childPolicy(h, 'one-too-many'))).toThrow()
    h.records.transition({ version: 2, runId: 'other', mode: 'topic-only', status: 'CREATED' })
    expect(() => h.records.commitChildBinding('other', childPolicy(h, 'child-0', 'other'))).toThrow()
    expect(h.records.findChildBinding('child-0')?.runId).toBe('run')
  })

  it('keeps topic-only bindings free of synthetic packets, and closes binding writes after terminal', () => {
    const h = harness()
    h.records.transition({ version: 2, runId: 'run', mode: 'topic-only', status: 'CREATED' })
    const policy = childPolicy(h)
    const seq = h.records.commitChildBinding('run', policy)
    expect(h.records.findChildBinding(policy.childId)).not.toHaveProperty('packetHash')
    const result = success(h, 'topic-only')
    h.records.commitTerminal(result, renderModelReturn(result.modelReturn))
    expect(h.records.commitChildBinding('run', policy)).toBe(seq)
    expect(() => h.records.commitChildBinding('run', childPolicy(h, 'late-new-child'))).toThrow()
    expect(h.records.read('run')?.state.status).toBe('SUCCEEDED')
  })

  it('uses strict mode/version/hash schemas for both parent record and standalone child marker DTO', () => {
    const binding = { version: 2, runId: 'run', parentSessionId: 'parent', childId: 'child', mode: 'chat',
      policyVersion: 2, policyHash: hashText('full-policy'), packetHash: hashText('packet') }
    expect(councilChildBindingSchema.safeParse(binding).success).toBe(true)
    expect(councilRunRecordSchema.safeParse({ ...binding, recordKind: 'child-binding' }).success).toBe(true)
    for (const changed of [{ version: 3 }, { policyVersion: 1 }, { policyHash: 'not-a-hash' },
      { childId: 'parent' }, { mode: 'topic-only' }, { persona: 'must-not-duplicate-policy' }, { recordKind: 'child-binding' }]) {
      expect(councilChildBindingSchema.safeParse({ ...binding, ...changed }).success).toBe(false)
    }
    const { packetHash: _packetHash, ...missingPacket } = binding
    expect(councilChildBindingSchema.safeParse(missingPacket).success).toBe(false)
    expect(councilRunRecordSchema.safeParse({ ...missingPacket, recordKind: 'child-binding' }).success).toBe(false)
  })

  it('folds an already-committed conflicting binding into bad without throwing or silently reauthorizing', () => {
    const h = harness(); prepareChat(h)
    const policy = childPolicy(h)
    h.records.commitChildBinding('run', policy)
    const binding = h.records.findChildBinding(policy.childId)!
    const before = projected(h)
    insert(h, producer({ kind: 'dsh-council', runRecord: { ...binding, recordKind: 'child-binding', policyHash: hashText('conflicting-policy') } }))
    const event = h.session.ownEvents().at(-1)!
    expect(() => h.definition().apply(before, event)).not.toThrow()
    expect(h.definition().apply(before, event).bad).toBe(true)
    expect(() => h.records.findChildBinding(policy.childId)).toThrow(/invalid persisted/)
    expect(() => h.records.read('run')).toThrow(/invalid persisted/)
  })
})
