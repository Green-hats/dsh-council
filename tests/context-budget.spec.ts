import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  ContextBudgetError,
  DEFAULT_CONTEXT_CONFIG,
  assertArtifactBudget,
  assertGenerateOptionsBudget,
  assertStageMaterialBudget,
  normalizeContextConfig,
  planContextBudgets,
  resolveContextWindow,
  stageOutputTokens,
  type BudgetMessage,
  type ContextBudgetErrorCode,
  type ContextConfig,
  type ContextMaterialBinding,
  type ContextRequestPolicy,
  type ContextTokenEstimator,
  type ReadonlyGenerateOptions,
} from '../src/context-budget.js'
import type { CouncilSelection, ModelRef } from '../src/types.js'

function model(id: string): ModelRef {
  return { provider: 'p', providerName: 'P', model: id, modelName: id, key: `p/${id}`, optionLabel: id }
}
const a = model('a')
const b = model('b')
const r = model('r')
const selection: CouncilSelection = { answerers: [a, b], reviewers: [r], arbiter: a, question: '题目 🧪' }
const caps = { answer: 100, review: 100, arbiter: 100 }

/** Deliberately independent of character/byte counts: these are fixture prices. */
function flatEstimator(tokens = 13): ContextTokenEstimator {
  return { version: 'fixture-v1', estimateMessage: vi.fn(() => tokens) }
}
function config(overrides: Partial<ContextConfig> = {}): ContextConfig {
  return normalizeContextConfig({
    contextAnswerArtifactTokens: 20,
    contextReviewArtifactTokens: 30,
    contextArbiterOutputTokens: 40,
    contextEnvelopeReserveTokens: 10,
    contextSafetyMarginTokens: 5,
    ...overrides,
  })
}
function plan(overrides: Partial<Parameters<typeof planContextBudgets>[0]> = {}) {
  return planContextBudgets({
    selection, config: config(), windows: new Map([[a.key, 500], [b.key, 500], [r.key, 500]]),
    serializedPacket: '{"topicOriginal":"题目 🧪","sources":[]}', estimator: flatEstimator(), outputCaps: caps,
    ...overrides,
  })
}
function expectCode(operation: () => unknown, code: ContextBudgetErrorCode): void {
  try {
    operation()
    throw new Error(`expected ${code}`)
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ContextBudgetError)
    expect((error as ContextBudgetError).code).toBe(code)
  }
}
function binding(serializedPayload = '{"topic":"题目 🧪"}'): ContextMaterialBinding {
  return {
    packetHash: `sha256:${'a'.repeat(64)}`,
    payloadHash: `sha256:${createHash('sha256').update(serializedPayload, 'utf8').digest('hex')}`,
    serializedPayload,
  }
}
function policy(overrides: Partial<ContextRequestPolicy> = {}): ContextRequestPolicy {
  return { sessionId: 'child-1', model: a, contextWindow: 100, maxOutputTokens: 20,
    safetyMarginTokens: 5, estimatorVersion: 'fixture-v1', allowStructuredOutput: false, ...overrides }
}
function options(overrides: Partial<ReadonlyGenerateOptions> = {}): ReadonlyGenerateOptions {
  return { sessionId: 'child-1', provider: 'p', model: 'a', maxTokens: 20,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], ...overrides }
}
const structured = { name: 'structured_output', description: 'submit the JSON result', parameters: { type: 'object', properties: {} } }

function freeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return
  Object.freeze(value)
  for (const item of Object.values(value)) freeze(item)
}

describe('normalizeContextConfig', () => {
  it('fills every omitted new field without breaking legacy Config objects', () => {
    expect(normalizeContextConfig()).toEqual(DEFAULT_CONTEXT_CONFIG)
    expect(normalizeContextConfig({ answerMaxTokens: 16_384, childTimeoutMs: 300_000 })).toEqual(DEFAULT_CONTEXT_CONFIG)
    expect(normalizeContextConfig({ contextMode: undefined, contextMaxTokens: undefined })).toEqual(DEFAULT_CONTEXT_CONFIG)
    expect(normalizeContextConfig({ contextMode: 'topic-only' }).contextMode).toBe('topic-only')
  })

  it('makes a detached immutable exact-key override record', () => {
    const source = { contextWindowOverrides: { 'p/org/model': 32_768 } }
    const result = normalizeContextConfig(source)
    source.contextWindowOverrides['p/org/model'] = 1
    expect(result.contextWindowOverrides['p/org/model']).toBe(32_768)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.contextWindowOverrides)).toBe(true)
  })

  it.each([null, [], true, 'config'])('rejects non-object configuration %j', input => {
    expectCode(() => normalizeContextConfig(input), 'INVALID_CONTEXT_CONFIG')
  })

  it.each(['invalid', null, 0])('rejects invalid contextMode %j', contextMode => {
    expectCode(() => normalizeContextConfig({ contextMode }), 'INVALID_CONTEXT_CONFIG')
  })

  const positiveKeys = [
    'contextCaptureAttempts', 'contextCaptureTimeoutMs', 'contextPreparationTimeoutMs', 'contextMaxSources',
    'contextCandidateMaxBytes', 'contextPacketMaxBytes', 'contextMaxTokens', 'contextAnswerArtifactTokens',
    'contextReviewArtifactTokens', 'contextArbiterOutputTokens',
  ] as const
  it.each(positiveKeys)('strictly checks positive safe integer bounds for %s', key => {
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '3', null]) {
      expectCode(() => normalizeContextConfig({ [key]: value }), 'INVALID_CONTEXT_CONFIG')
    }
  })

  it('permits zero reserves but rejects fractions, negatives, overflow and oversized timers/retries', () => {
    expect(normalizeContextConfig({ contextEnvelopeReserveTokens: 0, contextSafetyMarginTokens: 0 }).contextSafetyMarginTokens).toBe(0)
    for (const key of ['contextEnvelopeReserveTokens', 'contextSafetyMarginTokens']) {
      for (const value of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER]) {
        expectCode(() => normalizeContextConfig({ [key]: value }), 'INVALID_CONTEXT_CONFIG')
      }
    }
    expectCode(() => normalizeContextConfig({ contextCaptureAttempts: 4 }), 'INVALID_CONTEXT_CONFIG')
    for (const key of ['contextCaptureTimeoutMs', 'contextPreparationTimeoutMs']) {
      expectCode(() => normalizeContextConfig({ [key]: 2_147_483_648 }), 'INVALID_CONTEXT_CONFIG')
    }
  })

  it('checks byte/time relationships and worst-case 8+8 stage arithmetic', () => {
    expectCode(() => normalizeContextConfig({ contextPacketMaxBytes: 524_289 }), 'INVALID_CONTEXT_CONFIG')
    expectCode(() => normalizeContextConfig({ contextCaptureTimeoutMs: 30_001 }), 'INVALID_CONTEXT_CONFIG')
    expectCode(() => normalizeContextConfig({ contextAnswerArtifactTokens: Number.MAX_SAFE_INTEGER }), 'INVALID_CONTEXT_CONFIG')
    expect(normalizeContextConfig({ contextCaptureTimeoutMs: 30_000 }).contextCaptureTimeoutMs).toBe(30_000)
    expect(normalizeContextConfig({ contextPacketMaxBytes: 32_768, contextCandidateMaxBytes: 32_768 }).contextPacketMaxBytes).toBe(32_768)
    expectCode(() => normalizeContextConfig({ contextCandidateMaxBytes: 32_768 }), 'INVALID_CONTEXT_CONFIG')
    expectCode(() => normalizeContextConfig({ contextMaxSources: 65 }), 'INVALID_CONTEXT_CONFIG')
    expectCode(() => normalizeContextConfig({ contextCandidateMaxBytes: 524_289 }), 'INVALID_CONTEXT_CONFIG')
  })

  it.each(['*', 'p/*', 'p/a?', 'p/', '/a', ' p/a', 'p/a ', 'p/\na'])('rejects non-exact override key %j', key => {
    expectCode(() => normalizeContextConfig({ contextWindowOverrides: { [key]: 32_768 } }), 'INVALID_CONTEXT_CONFIG')
  })

  it('rejects unsafe override values and container shapes', () => {
    for (const value of [0, -1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '32000', null]) {
      expectCode(() => normalizeContextConfig({ contextWindowOverrides: { 'p/a': value } }), 'INVALID_CONTEXT_CONFIG')
    }
    for (const value of [null, [], new Map(), new Date(), { [Symbol('p/a')]: 20_000 }]) {
      expectCode(() => normalizeContextConfig({ contextWindowOverrides: value }), 'INVALID_CONTEXT_CONFIG')
    }
  })
})

describe('context windows', () => {
  it('uses only verified exact metadata or an exact-key override, never a guessed default', () => {
    expect(resolveContextWindow(a, { provider: 'p', id: 'a', context: { contextWindow: 16_000 } }, { 'p/a': 32_000 })).toBe(16_000)
    expect(resolveContextWindow(a, { provider: 'p', id: 'a' }, { 'p/a': 32_000 })).toBe(32_000)
    expect(resolveContextWindow(a, undefined, { 'p/a': Number.MAX_SAFE_INTEGER })).toBe(Number.MAX_SAFE_INTEGER)
    expectCode(() => resolveContextWindow(a, undefined), 'UNKNOWN_CONTEXT_WINDOW')
    expectCode(() => resolveContextWindow(a, undefined, { 'p/aa': 32_000 }), 'UNKNOWN_CONTEXT_WINDOW')
  })

  it('rejects invalid identity/window metadata rather than masking it with an override', () => {
    for (const info of [null, {}, { provider: 'other', id: 'a' }, { provider: 'p', id: 'b' },
      { provider: 'p', id: 'a', context: null }, { provider: 'p', id: 'a', context: { contextWindow: 0 } },
      { provider: 'p', id: 'a', context: { contextWindow: 1.5 } }]) {
      expectCode(() => resolveContextWindow(a, info, { 'p/a': 32_000 }), 'INVALID_CONTEXT_WINDOW')
    }
    expectCode(() => resolveContextWindow({ ...a, key: 'p/wrong' }, undefined), 'INVALID_BUDGET')
  })
})

describe('initial stage planning (BUD-01)', () => {
  it('includes every answer/review artifact, output, reserve and margin without double-counting the topic', () => {
    const estimator = flatEstimator()
    const result = plan({ estimator })
    expect(result.requests.map(row => [row.stage, row.evidenceTokens, row.maxOutputTokens, row.totalTokens]))
      .toEqual([['answer', 0, 20, 48], ['answer', 0, 20, 48], ['review', 40, 30, 98], ['arbiter', 70, 40, 138]])
    expect(estimator.estimateMessage).toHaveBeenCalledTimes(4)
    for (const call of vi.mocked(estimator.estimateMessage).mock.calls) {
      expect(call[0].content).toEqual([{ type: 'text', text: '{"topicOriginal":"题目 🧪","sources":[]}' }])
    }
    expect(Object.isFrozen(result.requests)).toBe(true)
  })

  it('estimates each exact model individually and applies the minimum existing output cap', () => {
    const estimator: ContextTokenEstimator = { version: 'fixture-v1', estimateMessage: (_message, route) => route.model === 'b' ? 40 : 10 }
    const result = plan({ estimator, outputCaps: { answer: 7, review: 8, arbiter: 9 } })
    expect(result.requests.map(row => row.packetTokens)).toEqual([10, 40, 10, 10])
    expect(result.requests.map(row => row.maxOutputTokens)).toEqual([7, 7, 8, 9])
    expect(stageOutputTokens('answer', config(), caps)).toBe(20)
    expectCode(() => stageOutputTokens('review', config(), { ...caps, review: 0 }), 'INVALID_BUDGET')
  })

  it('rejects unknown/small windows, invalid roster and eight long artifact participants before dispatch', () => {
    expectCode(() => plan({ windows: new Map() }), 'UNKNOWN_CONTEXT_WINDOW')
    expectCode(() => plan({ windows: new Map([[a.key, 100], [b.key, 500], [r.key, 500]]) }), 'CONTEXT_BUDGET_EXCEEDED')
    expectCode(() => plan({ selection: { ...selection, answerers: [a] } }), 'INVALID_BUDGET')
    expectCode(() => plan({ selection: { ...selection, reviewers: [r, r] } }), 'INVALID_BUDGET')
    const many = Array.from({ length: 8 }, (_, index) => model(`m${index}`))
    expectCode(() => plan({ selection: { ...selection, answerers: many, reviewers: many, arbiter: many[0] as ModelRef },
      config: normalizeContextConfig(), windows: new Map(many.map(route => [route.key, 32_768])) }), 'CONTEXT_BUDGET_EXCEEDED')
  })

  it('keeps byte/token limits independent for serialized multilingual packet (BUD-03)', () => {
    expectCode(() => plan({ serializedPacket: '🧪'.repeat(3), config: config({ contextPacketMaxBytes: 11 }), estimator: flatEstimator(1) }), 'CONTEXT_TOO_LARGE')
    expectCode(() => plan({ serializedPacket: 'a', estimator: flatEstimator(101), config: config({ contextMaxTokens: 100 }) }), 'CONTEXT_TOO_LARGE')
    expect(plan({ serializedPacket: '🧪'.repeat(3), config: config({ contextPacketMaxBytes: 12 }), estimator: flatEstimator(1) }).packetBytes).toBe(12)
  })

  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('fails closed on invalid estimator result %j', result => {
    expectCode(() => plan({ estimator: flatEstimator(result) }), 'INVALID_ESTIMATE')
  })

  it('does not fall back to characters when the estimator is missing, unversioned or throws', () => {
    expectCode(() => plan({ estimator: { version: '', estimateMessage: () => 1 } }), 'ESTIMATOR_UNAVAILABLE')
    expectCode(() => plan({ estimator: { version: 'v', estimateMessage: () => { throw new Error('unavailable') } } }), 'ESTIMATOR_UNAVAILABLE')
  })
})

describe('actual materials and artifacts', () => {
  it('rechecks the whole real material before a stage and never truncates', () => {
    const budget = plan().requests[2]
    expect(budget).toBeDefined()
    if (budget === undefined) throw new Error('missing review budget')
    expect(assertStageMaterialBudget({ budget, serializedMaterial: 'complete material', estimator: flatEstimator(400) }).totalTokens).toBe(445)
    expectCode(() => assertStageMaterialBudget({ budget, serializedMaterial: 'complete material', estimator: flatEstimator(456) }), 'CONTEXT_BUDGET_EXCEEDED')
    expectCode(() => assertStageMaterialBudget({ budget, serializedMaterial: 'complete material', estimator: { ...flatEstimator(), version: 'changed' } }), 'ESTIMATOR_UNAVAILABLE')
  })

  it.each(['answer', 'review', 'arbiter'] as const)('enforces independent byte/token limits on whole %s artifacts', stage => {
    const input = { stage, serializedArtifact: '🧪🧪🧪', config: config({ contextPacketMaxBytes: 12 }), estimator: flatEstimator(10), model: a }
    expect(assertArtifactBudget(input)).toEqual({ bytes: 12, inputTokens: 10, totalTokens: 10 })
    expectCode(() => assertArtifactBudget({ ...input, serializedArtifact: '🧪🧪🧪x' }), 'ARTIFACT_TOO_LARGE')
    expectCode(() => assertArtifactBudget({ ...input, maxOutputTokens: 9 }), 'ARTIFACT_TOO_LARGE')
    expectCode(() => assertArtifactBudget({ ...input, estimator: flatEstimator(41) }), 'ARTIFACT_TOO_LARGE')
    expect(input.serializedArtifact).toBe('🧪🧪🧪')
  })
})

describe('read-only real GenerateOptions pre-dispatch guard', () => {
  it('counts real system, ALL message content, tools and toolHistory schemas (BUD-02/BUD-03)', () => {
    const estimator = flatEstimator(10)
    const request = options({ system: 'huge preset', messages: [
      { role: 'system', content: [{ type: 'text', text: 'history system' }] },
      { role: 'developer', content: [{ type: 'text', text: 'developer' }] },
      { role: 'user', content: [{ type: 'text', text: '用户 🧪' }] },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'reasoning retained' }, { type: 'tool-call', name: 'structured_output', arguments: '{"a":1}' }] },
      { role: 'tool', content: [{ type: 'text', text: 'tool result' }] },
    ], tools: [structured], toolHistory: { tools: [structured], updates: [{ messageId: 'history-1', additions: [structured] }] } })
    freeze(request)
    const before = JSON.stringify(request)
    const measurement = assertGenerateOptionsBudget(request, policy({ allowStructuredOutput: true, contextWindow: 200 }), estimator)
    expect(measurement).toMatchObject({ inputTokens: 80, totalTokens: 105 })
    expect(estimator.estimateMessage).toHaveBeenCalledTimes(8)
    expect(vi.mocked(estimator.estimateMessage).mock.calls[0]?.[0].role).toBe('system')
    expect(vi.mocked(estimator.estimateMessage).mock.calls[7]?.[0].content).toEqual([
      { type: 'text', text: JSON.stringify(request.toolHistory) },
    ])
    expect(JSON.stringify(request)).toBe(before)
  })

  it('rejects huge preset/schema/history before next/adapter is called, returning AsyncIterable on success', async () => {
    const next = vi.fn(function* () { yield 'adapter called' })
    const listen = (request: ReadonlyGenerateOptions): AsyncIterable<string> => {
      assertGenerateOptionsBudget(request, policy({ allowStructuredOutput: true }), flatEstimator(30))
      const iterable = next()
      return (async function* () { yield* iterable })()
    }
    const initial = listen(options())
    expect('then' in initial).toBe(false)
    const chunks: string[] = []
    for await (const chunk of initial) chunks.push(chunk)
    expect(chunks).toEqual(['adapter called'])
    next.mockClear()
    expectCode(() => listen(options({ system: 'preset', tools: [structured], toolHistory: { tools: [structured], updates: [] } })), 'CONTEXT_BUDGET_EXCEEDED')
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects route/session drift, missing/oversized output caps and estimator version drift (SEC-02/03)', () => {
    for (const request of [options({ provider: 'elsewhere' }), options({ model: 'other' })]) {
      expectCode(() => assertGenerateOptionsBudget(request, policy(), flatEstimator()), 'REQUEST_ROUTE_MISMATCH')
    }
    expectCode(() => assertGenerateOptionsBudget(options({ sessionId: 'parent' }), policy(), flatEstimator()), 'REQUEST_SESSION_MISMATCH')
    for (const maxTokens of [0, 21, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expectCode(() => assertGenerateOptionsBudget(options({ maxTokens }), policy(), flatEstimator()), 'REQUEST_OUTPUT_EXCEEDED')
    }
    const { maxTokens: _omitted, ...withoutCap } = options()
    expectCode(() => assertGenerateOptionsBudget(withoutCap, policy(), flatEstimator()), 'REQUEST_OUTPUT_EXCEEDED')
    expectCode(() => assertGenerateOptionsBudget(options(), policy({ estimatorVersion: 'unknown' }), flatEstimator()), 'ESTIMATOR_UNAVAILABLE')
  })

  it('denies unauthorized tools in current schemas, historic schemas, updates and content (SEC-01)', () => {
    const web = { ...structured, name: 'web_search' }
    for (const request of [options({ tools: [web] }), options({ toolHistory: { tools: [web], updates: [] } }),
      options({ toolHistory: { tools: [], updates: [{ messageId: 'm', additions: [web] }] } }),
      options({ messages: [{ role: 'assistant', content: [{ type: 'tool-call', name: 'web_search', arguments: '{}' }] }] }),
      options({ messages: [{ role: 'assistant', content: [{ type: 'tool-addition', toolName: 'web_search' }] }] })]) {
      expectCode(() => assertGenerateOptionsBudget(request, policy({ allowStructuredOutput: true }), flatEstimator()), 'REQUEST_TOOL_DENIED')
    }
    expectCode(() => assertGenerateOptionsBudget(options({ tools: [structured] }), policy(), flatEstimator()), 'REQUEST_TOOL_DENIED')
    expectCode(() => assertGenerateOptionsBudget(options({ tools: [{ name: 'structured_output' }] }), policy(), flatEstimator()), 'INVALID_REQUEST')
  })

  it('prices cold historical structured submissions without restoring a callable current schema', () => {
    const history = { tools: [structured], updates: [] }
    const messages: BudgetMessage[] = [{ role: 'assistant', content: [{ type: 'tool-call', name: 'structured_output', arguments: '{}' }] },
      { role: 'tool', content: [{ type: 'text', text: 'historical submission accepted' }] }]
    expect(assertGenerateOptionsBudget(options({ messages, toolHistory: history }), policy(), flatEstimator(10)).inputTokens).toBe(30)
    expectCode(() => assertGenerateOptionsBudget(options({ messages, toolHistory: history, tools: [structured] }), policy(), flatEstimator(10)), 'REQUEST_TOOL_DENIED')
  })

  it('binds the public payload identity, not a hash of the whole GenerateOptions (MAT-01)', () => {
    const material = binding()
    const request = options({ messages: [{ role: 'user', content: [{ type: 'text', text: `persona-independent wrapper\n${material.serializedPayload}\nend` }] }] })
    expect(assertGenerateOptionsBudget(request, policy({ material }), flatEstimator(), material).totalTokens).toBe(38)
    expectCode(() => assertGenerateOptionsBudget(request, policy({ material }), flatEstimator()), 'REQUEST_MATERIAL_MISMATCH')
    expectCode(() => assertGenerateOptionsBudget(options(), policy({ material }), flatEstimator(), material), 'REQUEST_MATERIAL_MISMATCH')
    expectCode(() => assertGenerateOptionsBudget(request, policy({ material }), flatEstimator(), { ...material, packetHash: `sha256:${'b'.repeat(64)}` }), 'REQUEST_MATERIAL_MISMATCH')
    expectCode(() => assertGenerateOptionsBudget(request, policy({ material }), flatEstimator(), { ...material, serializedPayload: 'changed' }), 'REQUEST_MATERIAL_MISMATCH')
    expectCode(() => assertGenerateOptionsBudget(request, policy(), flatEstimator(), material), 'REQUEST_MATERIAL_MISMATCH')
  })

  it('ignores private metadata for input accounting but fails closed on invalid public JSON/schema content', () => {
    const message = { role: 'user' as const, content: [{ type: 'text', text: 'public' }], source: { kind: 'private', replayState: undefined } }
    expect(assertGenerateOptionsBudget(options({ messages: [message] }), policy(), flatEstimator()).inputTokens).toBe(13)
    const invalid = { ...structured, parameters: { unsafe: undefined } }
    expectCode(() => assertGenerateOptionsBudget(options({ tools: [invalid] }), policy({ allowStructuredOutput: true }), flatEstimator()), 'INVALID_REQUEST')
    expectCode(() => assertGenerateOptionsBudget(options({ messages: [{ role: 'user', content: [{ type: 'unknown' }] }] }), policy(), flatEstimator()), 'INVALID_REQUEST')
  })
})
