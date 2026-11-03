import { describe, expect, it, vi } from 'vitest'
import { chooseContextMode, prepareContextExport, type ContextAsk } from '../src/context-preparation.js'
import { ContextCaptureError, type ContextCapture } from '../src/context-capture.js'
import { normalizeContextConfig } from '../src/context-budget.js'
import { hashText, serializePublicPacket } from '../src/context-packet.js'
import type { CouncilQuestion } from '../src/council.js'
import type { CouncilSelection } from '../src/types.js'

const config = normalizeContextConfig()
const model = (id: string) => ({ key: `p/${id}`, provider: 'p', model: id, providerName: 'Provider', modelName: id, optionLabel: id })
const selection: CouncilSelection = { answerers: [model('a'), model('b')], reviewers: [model('r')], arbiter: model('a'), question: '  原始议题 e\u0301  ' }
const capture: ContextCapture = {
  capturedThroughSeq: 9, pendingPolicy: 'included', omissions: [], attachments: [{ name: 'reference.txt', disposition: 'reference-only' }],
  candidates: [
    { source: { alias: 'S1', kind: 'user-text', epistemic: 'user-asserted', text: '完整背景\n  保留代码空白 e\u0301' }, privateRef: { alias: 'S1', parentSessionId: 'parent', origin: 'surface', messageId: 'u', blockIndex: 0, textHash: hashText('完整背景\n  保留代码空白 e\u0301') }, defaultSelected: true },
    { source: { alias: 'S2', kind: 'tool-evidence', epistemic: 'tool-observed', text: 'TOOL_OPT_IN_SENTINEL' }, privateRef: { alias: 'S2', parentSessionId: 'parent', origin: 'surface', messageId: 't', blockIndex: 0, textHash: hashText('TOOL_OPT_IN_SENTINEL') }, defaultSelected: false },
  ],
}
function pick(question: CouncilQuestion, index: number) { return [{ id: question.id, selected: [question.options![index]!.label] }] }
function askScript(indices: readonly number[], visits: CouncilQuestion[] = []): ContextAsk {
  let call = 0
  return async questions => {
    visits.push(...questions)
    const question = questions[0]!
    return pick(question, indices[call++] ?? 0)
  }
}
const signal = () => new AbortController().signal
function prepare(ask: ContextAsk, extra: Partial<Parameters<typeof prepareContextExport<number>>[0]> = {}) {
  return prepareContextExport({ runId: 'run', selection, capture, config, ask, signal: signal(), locale: 'zh', plan: async () => 42, currentCapture: () => capture, ...extra })
}
describe('native context preparation', () => {
  it('ASK-02 forced topic-only never reads history or asks a mode question', async () => {
    const read = vi.fn(() => capture), ask = vi.fn<ContextAsk>()
    expect(await chooseContextMode({ config: { ...config, contextMode: 'topic-only' }, ask, capture: read, signal: signal(), locale: 'en' })).toBeUndefined()
    expect(read).not.toHaveBeenCalled(); expect(ask).not.toHaveBeenCalled()
  })
  it('captures immediately after explicit chat selection, before roster work', async () => {
    const read = vi.fn(() => capture)
    const result = await chooseContextMode({ config, ask: askScript([0]), capture: read, signal: signal(), locale: 'zh' })
    expect(result).toBe(capture); expect(read).toHaveBeenCalledWith(false)
  })
  it('busy/capability failures offer explicit topic-only instead of silent success', async () => {
    const visits: CouncilQuestion[] = []
    const read = vi.fn(() => { throw new ContextCaptureError('PARENT_BUSY', 'Claim before admission') })
    expect(await chooseContextMode({ config, ask: askScript([0, 1], visits), capture: read, signal: signal(), locale: 'en' })).toBeUndefined()
    expect(visits[1]!.detail).toContain('PARENT_BUSY'); expect(read).toHaveBeenCalledTimes(1)
  })
  it('requires explicit surface-only consent and records the limited pending policy', async () => {
    const read = vi.fn((surface = false) => { if (!surface) throw new ContextCaptureError('INBOX_UNAVAILABLE', 'No inbox'); return { ...capture, pendingPolicy: 'surface-only-user-approved' as const } })
    const result = await chooseContextMode({ config, ask: askScript([0, 1]), capture: read, signal: signal(), locale: 'zh' })
    expect(result?.pendingPolicy).toBe('surface-only-user-approved'); expect(read.mock.calls).toEqual([[false], [true]])
  })
  it('ASK-01 exports only after complete preview, preserving all text and every exact route', async () => {
    const visits: CouncilQuestion[] = []
    let exported = 0
    const result = await prepare(askScript([0, 0], visits))
    if (result) exported += 1
    expect(exported).toBe(1)
    expect(result!.record.packet.topicOriginal).toBe(selection.question)
    expect(result!.record.packet.sources.map(source => source.alias)).toEqual(['S1'])
    expect(visits[1]!.id).toBe('context-confirm')
    expect(visits[1]!.detail).toContain('~~~json\n' + serializePublicPacket(result!.record.packet) + '\n~~~')
    expect(visits[1]!.detail).toContain('p/a\np/b\np/r')
    expect(visits[1]!.detail).not.toContain('TOOL_OPT_IN_SENTINEL')
    expect(result!.record.consent.webAllowed).toBe(false)
  })
  it('returning to material selection invalidates old consent and repeats the full confirmation', async () => {
    const visits: CouncilQuestion[] = []
    const planned = vi.fn(async () => 42)
    const result = await prepare(askScript([0, 1, 0, 0], visits), { plan: planned })
    expect(result!.record.packet.sources).toHaveLength(1)
    expect(visits.map(question => question.id)).toEqual(['context-source-mode', 'context-confirm', 'context-source-mode', 'context-confirm'])
    expect(planned).toHaveBeenCalledTimes(2)
  })
  it('individual tool evidence selection is explicit, and aliases must be unique/current/nonempty', async () => {
    const custom: ContextAsk = async questions => questions[0]!.id === 'context-sources'
      ? [{ id: 'context-sources', selected: ['S2'] }] : pick(questions[0]!, questions[0]!.id === 'context-source-mode' ? 1 : 0)
    expect((await prepare(custom))!.record.packet.sources.map(source => source.alias)).toEqual(['S2'])
    for (const selected of [[], ['S99'], ['S1', 'S1']]) {
      const invalid: ContextAsk = async questions => questions[0]!.id === 'context-sources'
        ? [{ id: 'context-sources', selected }] : pick(questions[0]!, 1)
      await expect(prepare(invalid)).rejects.toThrow('Invalid or empty context source selection')
    }
  })
  it('ASK-02 native custom text and unknown question ids never become implicit agreement', async () => {
    const invalid: ContextAsk = async () => [{ id: 'context-source-mode', selected: [], custom: 'yes' }]
    await expect(prepare(invalid)).rejects.toThrow('Invalid context selection')
    const other: ContextAsk = async () => [{ id: 'answerers', selected: ['S1'] }]
    await expect(prepare(other)).rejects.toThrow('Invalid context selection')
  })
  it('unknown windows and oversize material can only fallback after an explicit decision', async () => {
    const visits: CouncilQuestion[] = []
    const result = await prepare(askScript([0, 1], visits), { plan: async () => { throw new Error('UNKNOWN_CONTEXT_WINDOW') } })
    expect(result).toBeUndefined()
    expect(visits.map(question => question.id)).toEqual(['context-source-mode', 'context-budget-fallback'])
    expect(visits[1]!.detail).toBe('UNKNOWN_CONTEXT_WINDOW')
  })
  it('preparation waiting does not consume a human-selection deadline', async () => {
    const controller = new AbortController()
    const ask: ContextAsk = async questions => {
      await new Promise<void>(resolve => setTimeout(resolve, 5))
      return pick(questions[0]!, 0)
    }
    expect(await prepare(ask, { config: { ...config, contextCaptureTimeoutMs: 1, contextPreparationTimeoutMs: 1 }, signal: controller.signal })).toBeDefined()
  })
  it('cancellation and a late confirmation never permit export', async () => {
    const controller = new AbortController()
    const ask: ContextAsk = async questions => {
      if (questions[0]!.id === 'context-confirm') controller.abort(new Error('cancel before agreement'))
      return pick(questions[0]!, 0)
    }
    await expect(prepare(ask, { signal: controller.signal })).rejects.toThrow('cancel before agreement')
    await expect(prepare(askScript([0, 3]))).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
  })
  it('source withdrawal during human confirmation revokes the old export', async () => {
    await expect(prepare(askScript([0, 0]), { currentCapture: () => ({ ...capture, candidates: [] }) })).rejects.toMatchObject({ code: 'SOURCE_WITHDRAWN' })
  })
})


it('ASK-01 attachment-reference withdrawal invalidates a still-unchanged text selection', async () => {
  await expect(prepare(askScript([0, 0]), { currentCapture: () => ({ ...capture, attachments: [] }) })).rejects.toMatchObject({ code: 'SOURCE_WITHDRAWN' })
})
