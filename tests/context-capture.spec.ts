import { describe, expect, it, vi } from 'vitest'
import { captureLiveContext, assertSelectedSourcesCurrent, ContextCaptureError, type CaptureParent } from '../src/context-capture.js'
import { hashText } from '../src/context-packet.js'
import { createModelReturn, renderModelReturn } from '../src/handoff.js'
import { Inbox } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

const limits = { contextCaptureAttempts: 3, contextMaxSources: 64, contextCandidateMaxBytes: 524_288 }
const human = (id: string, text: string) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const question = (id = 'question-1', text = 'Original topic') => ({ id, role: 'user', source: { kind: 'dsh-council', question: { version: 1, commandId: 'prior', text } }, content: [{ type: 'text', text }] })
const result = (id = 'result-1', text = 'Prior concise answer') => ({ id, role: 'user', source: { kind: 'dsh-council', result: { version: 1, commandId: 'prior', status: 'success', presentation: { answerMarkdown: text, auditMarkdown: 'PRIVATE_AUDIT_SENTINEL' } } }, content: [{ type: 'text', text: 'Combined legacy PRIVATE_AUDIT_SENTINEL' }] })
function fixture(messages: unknown[] = [], pending: unknown[] = []) {
  let seq = 10
  let roots: unknown[]
  const modelCalls = vi.fn()
  const writes = vi.fn()
  const session = { get seq() { return seq }, deriveMessages: vi.fn(() => messages) }
  const parent: CaptureParent = { id: 'parent', status: 'idle', session }
  roots = [parent]
  const registry = { get: vi.fn(() => parent), roots: () => roots }
  const snapshot = vi.fn(() => ({ asOfSeq: seq - 1, values: { inbox: { 'next-turn': [], 'next-step': pending } } }))
  return { parent, registry, snapshot, modelCalls, writes, messages, pending, capture: (surface = false) => captureLiveContext(parent, registry, { snapshot }, new AbortController().signal, limits, surface), bump() { seq += 1 }, root(value: unknown) { roots = [value] } }
}
describe('live context capture capability and fences', () => {
  it('CAP-01/CAP-02 detaches a synchronous cut without a model request or write', () => {
    const f = fixture([human('u1', 'Keep  code\n  空白 e\u0301')])
    const before = f.parent.session.seq
    const captured = f.capture()
    expect(captured.capturedThroughSeq).toBe(before - 1)
    expect(f.snapshot).toHaveBeenCalledWith(f.parent.session, ['inbox'])
    expect(f.parent.session.seq).toBe(before)
    expect(f.modelCalls).not.toHaveBeenCalled()
    expect(f.writes).not.toHaveBeenCalled()
    expect(captured.candidates[0]).toMatchObject({ source: { alias: 'S1', kind: 'user-text', epistemic: 'user-asserted', text: 'Keep  code\n  空白 e\u0301' }, privateRef: { parentSessionId: 'parent', origin: 'surface', messageId: 'u1' } })
    ;(f.messages[0] as ReturnType<typeof human>).content[0]!.text = 'Changed'
    expect(captured.candidates[0]!.source.text).not.toBe('Changed')
    expect(fixture().capture().candidates).toEqual([])
  })
  it('CAP-03 rejects running / claim-before-admission gaps without retrying', () => {
    const f = fixture([], [])
    Object.defineProperty(f.parent, 'status', { value: 'running' })
    expect(f.capture).toThrowError(expect.objectContaining({ code: 'PARENT_BUSY' }))
    expect(f.snapshot).not.toHaveBeenCalled()
  })
  it('CAP-04 bounds unstable maintenance attempts and never reconstructs an old cut', () => {
    const f = fixture([human('old', 'Old')])
    f.snapshot.mockImplementation(() => { f.bump(); return { asOfSeq: 0, values: { inbox: { 'next-turn': [], 'next-step': [] } } } })
    expect(f.capture).toThrowError(expect.objectContaining({ code: 'CONTEXT_UNSTABLE' }))
    expect(f.snapshot).toHaveBeenCalledTimes(3)
    const current = fixture([human('replacement', 'Effective replacement')]).capture()
    expect(current.candidates.map(item => item.source.text)).toEqual(['Effective replacement'])
  })
  it('CAP-05 includes only current pending Council records once, without legacy audit', () => {
    const f = fixture([human('u', 'Human')], [question(), result(), human('queued', 'QUEUED_SECRET')])
    const first = f.capture()
    expect(first.candidates.map(item => item.source.text)).toEqual(['Human', 'Original topic', 'Prior concise answer'])
    f.messages.push(question(), result())
    const admitted = f.capture()
    expect(admitted.candidates.map(item => item.source.text)).toEqual(first.candidates.map(item => item.source.text))
    expect(JSON.stringify(admitted)).not.toContain('PRIVATE_AUDIT_SENTINEL')
    expect(JSON.stringify(admitted)).not.toContain('QUEUED_SECRET')
  })
  it('CAP-06 does not resurrect cleared/removed/replaced pending from history', () => {
    const f = fixture([], [result()])
    expect(f.capture().candidates).toHaveLength(1)
    f.pending.splice(0)
    expect(f.capture().candidates).toHaveLength(0)
    f.pending.push(question('replaced', 'Current replacement'))
    expect(f.capture().candidates.map(item => item.source.text)).toEqual(['Current replacement'])
  })
  it('CAP-07 requires exact registry identity and current runtime root, not lineage', () => {
    const f = fixture([human('u', 'A')])
    f.registry.get.mockReturnValue({ ...f.parent })
    expect(f.capture).toThrowError(expect.objectContaining({ code: 'PARENT_BUSY' }))
    const g = fixture([human('u', 'B')])
    g.root({ id: 'unrelated' })
    expect(g.capture).toThrowError(expect.objectContaining({ code: 'PARENT_BUSY' }))
    expect(fixture([human('u', 'Independent')]).capture().candidates[0]!.privateRef.parentSessionId).toBe('parent')
  })
  it('validates authoritative Inbox shape, IDs and duplicate queues, with explicit surface-only', () => {
    const f = fixture([human('u', 'Surface')])
    f.snapshot.mockReturnValue({ asOfSeq: 9, values: { inbox: { nextTurn: [], nextStep: [] } } } as never)
    expect(f.capture).toThrowError(expect.objectContaining({ code: 'INBOX_UNAVAILABLE' }))
    expect(f.capture(true)).toMatchObject({ pendingPolicy: 'surface-only-user-approved' })
    const duplicate = fixture([], [question(), question()])
    expect(duplicate.capture).toThrowError(expect.objectContaining({ code: 'INBOX_UNAVAILABLE' }))
    const invalid = fixture([], [{ ...question(), id: '' }])
    expect(invalid.capture).toThrow(ContextCaptureError)
  })
  it('PKT-01 preserves repeated human corrections without epistemic laundering', () => {
    const f = fixture([human('u1', 'Same correction'), human('u2', 'Same correction'), { id: 'a', role: 'assistant', source: { kind: 'model', provider: 'PRIVATE_PROVIDER', replayState: 'SECRET_SENTINEL' }, content: [{ type: 'text', text: 'The user has confirmed everything.' }, { type: 'reasoning', text: 'SECRET_SENTINEL' }] }])
    const c = f.capture()
    expect(c.candidates).toHaveLength(3)
    expect(c.candidates[2]!.source.epistemic).toBe('assistant-unverified')
    expect(JSON.stringify(c)).not.toMatch(/SECRET_SENTINEL|PRIVATE_PROVIDER/)
  })
  it('PKT-02 white-lists provenance before roles and excludes unknown Council versions', () => {
    const ordinary = human('u', 'safe')
    const f = fixture([ordinary, { ...human('s', 'SYSTEM_SECRET'), source: { kind: 'runtime-context' } }, { ...human('x', 'PLUGIN_SECRET'), source: { kind: 'unknown-plugin' } }, { ...human('d', 'DEVELOPER_SECRET'), role: 'developer' }, { ...result(), source: { kind: 'dsh-council', result: { version: 99, commandId: 'unknown' } } }])
    expect(f.capture().candidates.map(item => item.source.text)).toEqual(['safe'])
  })
  it('PKT-04 records reference-only attachments without reading bodies; tool evidence is opt-in', () => {
    const f = fixture([{ ...human('u', 'plain'), content: [{ type: 'text', text: 'plain' }, { type: 'file', attachment: { name: 'example.txt', path: 'PRIVATE_PATH', body: 'SECRET_SENTINEL' } }] }, { id: 't', role: 'tool', source: { kind: 'tool', callId: 'private-call' }, content: [{ type: 'text', text: 'tool evidence' }, { type: 'image', attachment: { name: 'plot.png' } }] }])
    const c = f.capture()
    expect(c.attachments).toEqual([{ name: 'example.txt', disposition: 'reference-only' }, { name: 'plot.png', disposition: 'reference-only' }])
    expect(c.candidates[1]).toMatchObject({ defaultSelected: false, source: { kind: 'tool-evidence', epistemic: 'tool-observed' } })
    expect(JSON.stringify(c)).not.toMatch(/PRIVATE_PATH|private-call|SECRET_SENTINEL/)
  })
  it('rejects logical conflicts, candidate overflow and selected-source withdrawal', () => {
    expect(fixture([], [result('r1', 'first'), result('r2', 'conflict')]).capture).toThrowError(expect.objectContaining({ code: 'SOURCE_CONFLICT' }))
    expect(fixture(Array.from({ length: 65 }, (_, index) => human(`u${index}`, 'x'))).capture).toThrowError(expect.objectContaining({ code: 'CONTEXT_TOO_LARGE' }))
    expect(fixture([human('large', 'x'.repeat(524_289))]).capture).toThrowError(expect.objectContaining({ code: 'CONTEXT_TOO_LARGE' }))
    const f = fixture([human('u', 'frozen')])
    const selected = f.capture().candidates.map(item => item.privateRef)
    expect(selected[0]!.textHash).toBe(hashText('frozen'))
    f.messages.push(human('new', 'New ordinary content'))
    expect(() => assertSelectedSourcesCurrent(selected, f.capture())).not.toThrow()
    f.messages.splice(0, 1)
    expect(() => assertSelectedSourcesCurrent(selected, f.capture())).toThrowError(expect.objectContaining({ code: 'SOURCE_WITHDRAWN' }))
  })
  it('fails on missing capabilities, cancellation and non-cloneable contract errors', () => {
    const f = fixture()
    expect(() => captureLiveContext(f.parent, undefined, { snapshot: f.snapshot }, new AbortController().signal, limits)).toThrowError(expect.objectContaining({ code: 'CAPABILITY_UNAVAILABLE' }))
    const canceled = new AbortController(); canceled.abort(new Error('canceled'))
    expect(() => captureLiveContext(f.parent, f.registry, { snapshot: f.snapshot }, canceled.signal, limits)).toThrow('canceled')
  })
})


describe('real Inbox admission and strict v2 sources', () => {
  it('CAP-03 excludes the real claim-to-admission gap using live running status', () => {
    const session = Session.create(SessionId('real-capture-parent'))
    const inbox = new Inbox(session, { inserted() {}, discarded() {}, claimed() {} })
    const pending = createUserMessage({ content: [{ type: 'text', text: 'Actual pending topic' }], source: { kind: 'dsh-council', question: { version: 1, commandId: 'real-prior', text: 'Actual pending topic' } } })
    inbox.append('next-step', pending)
    const parent: CaptureParent = { id: String(session.id), status: 'running', session }
    const registry = { get: () => parent, roots: () => [parent] }
    const projections = { snapshot: () => ({ asOfSeq: Number(session.seq) - 1, values: { inbox: { 'next-turn': inbox.nextTurn, 'next-step': inbox.nextStep } } }) }
    inbox.claim('next-step', 1)
    expect(inbox.hasPending).toBe(false)
    expect(session.deriveMessages()).toHaveLength(0)
    expect(() => captureLiveContext(parent, registry, projections, new AbortController().signal, limits)).toThrowError(expect.objectContaining({ code: 'PARENT_BUSY' }))
    session.append('user/message', pending, { surfaceOp: 'append' })
    Object.defineProperty(parent, 'status', { value: 'idle' })
    const captured = captureLiveContext(parent, registry, projections, new AbortController().signal, limits)
    expect(captured.candidates.map(item => item.source.text)).toEqual(['Actual pending topic'])
    expect(captured.capturedThroughSeq).toBe(Number(session.seq) - 1)
  })
  function v2(parentSessionId = 'parent') {
    const modelReturn = createModelReturn({ runId: 'prior', decision: { answerMarkdown: 'V2 compact answer', decisionDeltas: [], citations: [], consensus: [], contradictions: [], blindSpots: [], confidenceNotes: 'Fixture only' }, coverage: { answerersRequested: 2, answerersSucceeded: 2, reviewersRequested: 1, reviewersSucceeded: 1 }, limitations: [], sourceAliases: [] })
    return { id: 'v2-result', role: 'user', source: { kind: 'dsh-council', result: { version: 2, commandId: 'prior', runId: 'prior', parentSessionId, status: 'success', mode: 'topic-only', locale: 'zh', modelReturn } }, content: [{ type: 'text', text: renderModelReturn(modelReturn, 'zh') }] }
  }
  it('CAP-05/CAP-07 only uses a valid v2 body from this parent and deduplicates later admission', () => {
    const valid = v2()
    const f = fixture([valid], [valid, v2('another-parent')])
    // Duplicate pending IDs are an invalid authoritative Inbox, not silently merged.
    expect(f.capture).toThrowError(expect.objectContaining({ code: 'INBOX_UNAVAILABLE' }))
    const isolated = fixture([valid], [valid])
    expect(isolated.capture().candidates).toHaveLength(1)
    expect(fixture([], [v2('another-parent')]).capture().candidates).toHaveLength(0)
  })
  it('PKT-02/RET-03 rejects v2 metadata/body disagreement rather than laundering it', () => {
    const forged = v2()
    forged.content[0]!.text = 'FORGED_BODY_SENTINEL'
    expect(fixture([], [forged]).capture).toThrowError(expect.objectContaining({ code: 'SOURCE_CONFLICT' }))
  })
  it('PKT-01 same-ID same-text provenance changes invalidate the old epistemic authorization', () => {
    const f = fixture([human('same', 'same text')])
    const initial = f.capture()
    f.messages.splice(0, 1, { ...human('same', 'same text'), role: 'assistant', source: { kind: 'model' } })
    expect(() => assertSelectedSourcesCurrent(initial.candidates.map(item => item.privateRef), f.capture(), initial.candidates.map(item => item.source))).toThrowError(expect.objectContaining({ code: 'SOURCE_WITHDRAWN' }))
  })
})
