import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseSelection,
  runCouncil,
  selectionQuestions,
  type ChildOutcome,
  type ChildRequest,
  type CouncilAnswer,
  type CouncilConfig,
  type CouncilRuntime,
} from '../src/council.js'
import { localeCopies } from '../src/locales.js'
import type { ModelDirectory, ModelRef } from '../src/types.js'
import { normalizeContextConfig, planContextBudgets, type ContextTokenEstimator } from '../src/context-budget.js'
import { compileContextPacket, createPacketRecord, hashText, serializePublicPacket } from '../src/context-packet.js'
import type { StageMaterial } from '../src/context-types.js'

const config: CouncilConfig = {
  answerMaxTokens: 16_384,
  reviewMaxTokens: 16_384,
  arbiterMaxTokens: 16_384,
  childTimeoutMs: 300_000,
  runTimeoutMs: 900_000,
  subagentProvider: 'spawn',
}
const copy = localeCopies.en

function model(key: string): ModelRef {
  const [provider = '', id = ''] = key.split('/')
  return { provider, providerName: provider, model: id, modelName: id, key, optionLabel: key }
}

const models = [model('p/a'), model('p/b'), model('p/c'), model('p/d')]
const directory: ModelDirectory = { models, failures: [] }
const pickerAnswers: CouncilAnswer[] = [
  { id: 'answerers', selected: ['p/a', 'p/b'] },
  { id: 'reviewers', selected: ['p/c', 'p/d'] },
  { id: 'arbiter', selected: ['p/a'] },
  { id: 'question', selected: [], custom: 'What is the answer?' },
]

const review = (ranking: string[]) => ({
  evaluations: ranking.map(answerId => ({ answerId, strengths: ['good'], weaknesses: [] })),
  consensus: ['common'],
  contradictions: [],
  coverageGaps: [],
  uniqueInsights: [],
  blindSpots: [],
  ranking,
})

const arbiter = {
  answerMarkdown: 'Council answer',
  consensus: ['common'],
  contradictions: [],
  blindSpots: [],
  confidenceNotes: 'High confidence',
}

function successfulRuntime(overrides: Partial<CouncilRuntime> = {}) {
  const calls: ChildRequest[] = []
  const stageCounts = { answer: 0, review: 0 }
  let releaseAnswers: (() => void) | undefined
  let releaseReviews: (() => void) | undefined
  const answerBarrier = new Promise<void>(resolve => { releaseAnswers = resolve })
  const reviewBarrier = new Promise<void>(resolve => { releaseReviews = resolve })
  const runtime: CouncilRuntime = {
    discover: async () => directory,
    ask: async () => pickerAnswers,
    random: () => 0.999,
    async runChild(request) {
      calls.push(request)
      if (request.stage === 'answer') {
        stageCounts.answer += 1
        if (stageCounts.answer === 2) releaseAnswers?.()
        await answerBarrier
        return { stopReason: 'completed', text: `Answer from ${request.model.model}`, childId: request.model.key }
      }
      if (request.stage === 'review') {
        stageCounts.review += 1
        if (stageCounts.review === 2) releaseReviews?.()
        await reviewBarrier
        return {
          stopReason: 'completed',
          text: '',
          structured: review(request.model.model === 'c'
            ? ['Answer A', 'Answer B']
            : ['Answer B', 'Answer A']),
          childId: request.model.key,
        }
      }
      return { stopReason: 'completed', text: '', structured: arbiter, childId: request.model.key }
    },
    ...overrides,
  }
  return { runtime, calls }
}

function chatPreparation(selected: Parameters<NonNullable<CouncilRuntime['prepare']>>[0], estimator: ContextTokenEstimator) {
  const source = 'User background: keep the exact code whitespace.'
  const compiled = compileContextPacket({ topicOriginal: selected.question,
    candidates: [{ source: { alias: 'S1', kind: 'user-text', text: source, epistemic: 'user-asserted' },
      privateRef: { alias: 'S1', parentSessionId: 'parent', origin: 'surface', messageId: 'message', blockIndex: 0, textHash: hashText(source) } }],
    selectedAliases: ['S1'] })
  const packetRecord = createPacketRecord({ ...compiled, runId: 'run-chat', capturedThroughSeq: 1, pendingPolicy: 'included',
    providerSet: [...selected.answerers, ...selected.reviewers, selected.arbiter].map(route => ({ provider: route.provider, model: route.model })) })
  const budgets = planContextBudgets({ selection: selected, config: normalizeContextConfig(config),
    windows: new Map(directory.models.map(route => [route.key, 100_000])), serializedPacket: serializePublicPacket(packetRecord.packet),
    estimator, outputCaps: { answer: config.answerMaxTokens, review: config.reviewMaxTokens, arbiter: config.arbiterMaxTokens } })
  return { packetRecord, budgets, estimator }
}

function chatRuntime(estimator: ContextTokenEstimator = { version: 'fixture', estimateMessage: () => 10 }) {
  const base = successfulRuntime()
  const material: StageMaterial[] = []
  const original = base.runtime.runChild
  base.runtime.prepare = async selected => chatPreparation(selected, estimator)
  base.runtime.material = value => { material.push(value) }
  base.runtime.runChild = async request => {
    const outcome = await original(request)
    return request.stage !== 'arbiter' ? outcome : { ...outcome, structured: { ...arbiter,
      decisionDeltas: [{ sourceAliases: ['S1'], disposition: 'revised', text: 'Revise the earlier proposal.' }],
      citations: [{ sourceAliases: ['S1'], verification: 'reported' }] } }
  }
  return { ...base, material }
}

describe('selection', () => {
  it('builds four questions and reports failed provider catalogs', () => {
    const questions = selectionQuestions({
      models,
      failures: [{ provider: 'broken', message: 'offline' }],
    }, copy)
    expect(questions.map(question => question.id)).toEqual(['answerers', 'reviewers', 'arbiter', 'question'])
    expect(questions[0]?.detail).toContain('broken')
  })

  it('allows cross-role reuse but rejects custom model routes', () => {
    expect(parseSelection(directory, pickerAnswers, copy).arbiter.key).toBe('p/a')
    expect(() => parseSelection(directory, pickerAnswers.map(answer => answer.id === 'reviewers'
      ? { ...answer, custom: 'p/unknown' }
      : answer), copy)).toThrow(/custom routes/)
  })

  it.each([
    pickerAnswers.filter(answer => answer.id !== 'question'),
    [...pickerAnswers, pickerAnswers[0]!],
    [...pickerAnswers, { id: 'unknown', selected: [] }],
    pickerAnswers.map(answer => answer.id === 'answerers' ? { ...answer, selected: ['p/a', 'p/a'] } : answer),
    pickerAnswers.map(answer => answer.id === 'answerers' ? { ...answer, selected: ['p/a', 'p/missing'] } : answer),
    pickerAnswers.map(answer => answer.id === 'arbiter' ? { ...answer, selected: ['p/a', 'p/b'] } : answer),
    pickerAnswers.map(answer => answer.id === 'question' ? { ...answer, custom: '   ' } : answer),
    pickerAnswers.map(answer => answer.id === 'question' ? { ...answer, selected: ['unexpected'] } : answer),
  ])('rejects malformed or incomplete selections: %o', (...answers) => {
    expect(() => parseSelection(directory, answers as CouncilAnswer[], copy)).toThrow()
  })
})

describe('chat three-stage material and budgets', () => {
  it('freezes one packet and one shared anonymous corpus per stage (MAT-01)', async () => {
    const { runtime, calls, material } = chatRuntime()
    const result = await runCouncil(runtime, config, new AbortController().signal, copy)
    expect(material.map(value => value.stage)).toEqual(['answer', 'review', 'arbiter'])
    expect(new Set(material.map(value => value.packetHash)).size).toBe(1)
    const reviewMaterial = material[1]
    const arbiterMaterial = material[2]
    if (reviewMaterial?.stage !== 'review' || arbiterMaterial?.stage !== 'arbiter') throw new Error('missing shared material')
    expect(reviewMaterial.answerCorpusHash).toBe(arbiterMaterial.answerCorpusHash)
    expect(reviewMaterial.payload.answerCorpus).toEqual(arbiterMaterial.payload.answerCorpus)
    for (const stage of ['answer', 'review', 'arbiter']) {
      const requests = calls.filter(request => request.stage === stage)
      expect(new Set(requests.map(request => request.context?.material.payloadHash)).size).toBe(1)
      expect(new Set(requests.map(request => request.prompt)).size).toBe(1)
      for (const request of requests) {
        expect(request.context?.packetRecord.packetHash).toBe(result.packetRecord?.packetHash)
        expect(request.prompt).toContain(request.context?.material.serializedPayload)
        expect(request.persona).toContain('Do not browse')
        expect(request.maxTokens).toBe(stage === 'arbiter' ? 4_096 : 2_048)
        expect(request.prompt).not.toContain('parent')
        expect(request.prompt).not.toContain('p/a')
        expect(request.prompt).not.toContain('p/b')
        expect(request.prompt).not.toContain('p/c')
      }
    }
    expect(Object.isFrozen(reviewMaterial.payload.answerCorpus)).toBe(true)
    expect(result.modelReturn).toMatchObject({ runId: 'run-chat', packetHash: result.packetRecord?.packetHash,
      coverage: { answerersRequested: 2, answerersSucceeded: 2, reviewersRequested: 2, reviewersSucceeded: 2 } })
    expect(result.arbiter.decisionDeltas?.[0]?.disposition).toBe('revised')
  })

  it('records overlong participant artifacts as failures without truncating or leaking them onward', async () => {
    const { runtime, material } = chatRuntime()
    const oversized = '🧪'.repeat(20_000)
    const seen: ChildRequest[] = []
    runtime.runChild = async request => {
      seen.push(request)
      if (request.stage === 'answer') return { stopReason: 'completed', text: request.model.model === 'a' ? oversized : '  valid code\n    keep indentation\n' }
      if (request.stage === 'review') return request.model.model === 'c'
        ? { stopReason: 'completed', text: '', structured: review(['Answer A']) }
        : { stopReason: 'error', text: '', diagnostic: 'review failed' }
      return { stopReason: 'completed', text: '', structured: { ...arbiter, decisionDeltas: [], citations: [] } }
    }
    const result = await runCouncil(runtime, config, new AbortController().signal, copy)
    expect(result.answers[0]?.text).toBe('  valid code\n    keep indentation\n')
    expect(result.answers).toHaveLength(1)
    expect(result.reviews).toHaveLength(1)
    expect(result.failures).toHaveLength(2)
    expect(result.failures[0]?.message).toContain('UTF-8 byte ceiling')
    expect(result.modelReturn?.coverage).toEqual({ answerersRequested: 2, answerersSucceeded: 1, reviewersRequested: 2, reviewersSucceeded: 1 })
    expect(material[1]?.payload).not.toEqual(expect.objectContaining({ text: oversized }))
    expect(seen.filter(request => request.stage !== 'answer').every(request => !request.prompt.includes(oversized))).toBe(true)
  })

  it('rejects an otherwise valid over-token review as that reviewer failure, without passing partial JSON', async () => {
    const estimator: ContextTokenEstimator = { version: 'fixture', estimateMessage: message => message.content.some(block =>
      typeof block === 'object' && block !== null && 'text' in block && typeof block.text === 'string' && block.text.includes('TOKEN_OVERFLOW_SENTINEL')) ? 3_000 : 10 }
    const { runtime, calls } = chatRuntime(estimator)
    const run = runtime.runChild
    runtime.runChild = async request => {
      const outcome = await run(request)
      return request.stage === 'review' && request.model.model === 'd'
        ? { ...outcome, structured: { ...review(['Answer A', 'Answer B']), blindSpots: ['TOKEN_OVERFLOW_SENTINEL'] } } : outcome
    }
    const result = await runCouncil(runtime, config, new AbortController().signal, copy)
    expect(result.reviews).toHaveLength(1)
    expect(result.failures).toMatchObject([{ stage: 'review', message: expect.stringContaining('token ceiling') }])
    expect(calls.at(-1)?.prompt).not.toContain('TOKEN_OVERFLOW_SENTINEL')
  })

  it('rechecks actual stage material for all participants before starting any reviewer', async () => {
    const estimator: ContextTokenEstimator = { version: 'fixture', estimateMessage: message => message.content.some(block =>
      typeof block === 'object' && block !== null && 'text' in block && typeof block.text === 'string' && block.text.includes('"answerCorpus"')) ? 100_000 : 10 }
    const { runtime, calls, material } = chatRuntime(estimator)
    await expect(runCouncil(runtime, config, new AbortController().signal, copy)).rejects.toThrow('actual review material')
    expect(calls.map(request => request.stage)).toEqual(['answer', 'answer'])
    expect(material.map(value => value.stage)).toEqual(['answer'])
  })

  it('requires the new strict arbiter fields and rejects Host-owned claims', async () => {
    for (const structured of [arbiter, { ...arbiter, decisionDeltas: [], citations: [], coverage: { answerersSucceeded: 99 } },
      { ...arbiter, decisionDeltas: [{ sourceAliases: ['S2'], disposition: 'supported', text: 'wrong alias' }], citations: [] }]) {
      const { runtime } = chatRuntime()
      const run = runtime.runChild
      runtime.runChild = request => request.stage === 'arbiter' ? Promise.resolve({ stopReason: 'completed', text: '', structured }) : run(request)
      await expect(runCouncil(runtime, config, new AbortController().signal, copy)).rejects.toThrow(copy.arbiterInvalid)
    }
  })

  it('prepares after roster but before selected/model work, preserving original topic whitespace', async () => {
    const { runtime, calls } = chatRuntime()
    const events: string[] = []
    const prepare = runtime.prepare
    runtime.prepare = async (selected, signal) => {
      events.push('prepare')
      expect(calls).toHaveLength(0)
      expect(selected.question).toBe('  What is the answer?\n')
      return prepare?.(selected, signal)
    }
    runtime.selected = () => { events.push('selected') }
    runtime.ask = async () => pickerAnswers.map(answer => answer.id === 'question' ? { ...answer, custom: '  What is the answer?\n' } : answer)
    const result = await runCouncil(runtime, config, new AbortController().signal, copy)
    expect(events).toEqual(['prepare', 'selected'])
    expect(result.packetRecord?.packet.topicOriginal).toBe('  What is the answer?\n')
  })

  it('rejects stale consent/plan and cancellation before any child starts', async () => {
    const { runtime, calls } = chatRuntime()
    const estimator = { version: 'fixture', estimateMessage: () => 10 }
    runtime.prepare = async selected => ({ ...chatPreparation(selected, estimator), packetRecord: chatPreparation({ ...selected, question: 'changed' }, estimator).packetRecord })
    await expect(runCouncil(runtime, config, new AbortController().signal, copy)).rejects.toThrow('Prepared topic differs')
    expect(calls).toHaveLength(0)
    const controller = new AbortController()
    runtime.prepare = async selected => {
      controller.abort(new Error('cancelled while confirming'))
      return chatPreparation(selected, estimator)
    }
    await expect(runCouncil(runtime, config, controller.signal, copy)).rejects.toThrow('cancelled while confirming')
    expect(calls).toHaveLength(0)
  })
})

describe('council orchestration', () => {
  afterEach(() => vi.useRealTimers())
  it('runs each stage in parallel, enforces stage barriers, and keeps final inputs anonymous', async () => {
    const { runtime, calls } = successfulRuntime()
    const result = await runCouncil(runtime, config, new AbortController().signal, copy)
    expect(calls.map(call => call.stage)).toEqual(['answer', 'answer', 'review', 'review', 'arbiter'])
    expect(calls.filter(call => call.stage === 'answer').every(call => call.maxTokens === 16_384)).toBe(true)
    expect(calls.filter(call => call.stage === 'review').every(call => call.outputSchema !== undefined)).toBe(true)
    const finalPrompt = calls.at(-1)?.prompt ?? ''
    expect(finalPrompt).not.toContain('p/a')
    expect(finalPrompt).not.toContain('p/b')
    expect(finalPrompt).not.toContain('p/c')
    expect(result.arbiter.answerMarkdown).toBe('Council answer')
    expect(result.aggregateRanking).toEqual([
      { answerId: 'Answer A', averageRank: 1.5, votes: 2 },
      { answerId: 'Answer B', averageRank: 1.5, votes: 2 },
    ])
  })

  it('continues with one successful answer and one successful review', async () => {
    const { runtime } = successfulRuntime({
      async runChild(request): Promise<ChildOutcome> {
        if (request.stage === 'answer') {
          return request.model.model === 'a'
            ? { stopReason: 'completed', text: 'Only answer' }
            : { stopReason: 'error', text: '', diagnostic: 'answer failed' }
        }
        if (request.stage === 'review') {
          return request.model.model === 'c'
            ? { stopReason: 'completed', text: '', structured: review(['Answer A']) }
            : { stopReason: 'error', text: '', diagnostic: 'review failed' }
        }
        return { stopReason: 'completed', text: '', structured: arbiter }
      },
    })
    const result = await runCouncil(runtime, config, new AbortController().signal, copy)
    expect(result.answers).toHaveLength(1)
    expect(result.reviews).toHaveLength(1)
    expect(result.failures).toHaveLength(2)
  })

  it('fails when every answerer fails', async () => {
    const { runtime } = successfulRuntime({
      runChild: async request => request.stage === 'answer'
        ? { stopReason: 'error', text: '' }
        : { stopReason: 'completed', text: '', structured: arbiter },
    })
    await expect(runCouncil(runtime, config, new AbortController().signal, copy))
      .rejects.toMatchObject({ name: 'CouncilRunError', message: 'No answerer returned a successful non-empty answer.' })
  })

  it('fails when the arbiter returns no structured result', async () => {
    const base = successfulRuntime()
    const original = base.runtime.runChild
    base.runtime.runChild = async request => request.stage === 'arbiter'
      ? { stopReason: 'completed', text: 'plain text only' }
      : original(request)
    await expect(runCouncil(base.runtime, config, new AbortController().signal, copy))
      .rejects.toMatchObject({ name: 'CouncilRunError', message: 'The arbiter did not return a valid decision.' })
  })

  it('honors cancellation even if the arbiter returns a valid result at the same time', async () => {
    const controller = new AbortController()
    const { runtime } = successfulRuntime()
    const run = runtime.runChild
    runtime.runChild = async request => {
      const result = await run(request)
      if (request.stage === 'arbiter') controller.abort(new Error('cancelled at final boundary'))
      return result
    }
    await expect(runCouncil(runtime, config, controller.signal, copy)).rejects.toThrow('cancelled at final boundary')
  })

  it('bounds unresponsive children and reports meaningful empty-answer failures', async () => {
    vi.useFakeTimers()
    const { runtime } = successfulRuntime({
      runChild: request => request.model.model === 'a'
        ? new Promise(() => {})
        : Promise.resolve({ stopReason: 'completed', text: '  ' }),
    })
    const pending = runCouncil(runtime, { ...config, childTimeoutMs: 10 }, new AbortController().signal, copy)
    const assertion = expect(pending).rejects.toMatchObject({ failures: [
      { message: copy.childTimedOut }, { message: copy.emptyAnswer },
    ] })
    await vi.advanceTimersByTimeAsync(11)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports the overall deadline and never starts a later stage after it', async () => {
    vi.useFakeTimers()
    const calls: ChildRequest[] = []
    const { runtime } = successfulRuntime({ runChild: request => {
      calls.push(request)
      return new Promise(() => {})
    } })
    const pending = runCouncil(runtime, { ...config, childTimeoutMs: 100, runTimeoutMs: 20 },
      new AbortController().signal, copy)
    const assertion = expect(pending).rejects.toMatchObject({ name: 'CouncilRunError', message: copy.runTimedOut })
    await vi.advanceTimersByTimeAsync(21)
    await assertion
    expect(calls.map(call => call.stage)).toEqual(['answer', 'answer'])
    expect(calls.every(call => call.signal.aborted)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fails after all invalid reviews without invoking the arbiter', async () => {
    const calls: string[] = []
    const { runtime } = successfulRuntime({ runChild: async request => {
      calls.push(request.stage)
      return { stopReason: 'completed', text: 'Answer', structured: {} }
    } })
    await expect(runCouncil(runtime, config, new AbortController().signal, copy))
      .rejects.toMatchObject({ message: copy.noReviews, failures: [
        { message: copy.invalidReview }, { message: copy.invalidReview },
      ] })
    expect(calls).not.toContain('arbiter')
  })

  it('preserves an arbiter refusal as a stop reason instead of a schema error', async () => {
    const { runtime } = successfulRuntime()
    const run = runtime.runChild
    runtime.runChild = request => request.stage === 'arbiter'
      ? Promise.resolve({ stopReason: 'refusal', text: '' }) : run(request)
    await expect(runCouncil(runtime, config, new AbortController().signal, copy))
      .rejects.toMatchObject({ failures: [{ stage: 'arbiter', message: 'child stopped with refusal' }] })
  })
})
