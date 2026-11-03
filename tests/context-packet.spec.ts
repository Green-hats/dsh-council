import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ContextCandidate, ContextPacket } from '../src/context-types.js'
import {
  canonicalJson,
  compileContextPacket,
  computeExportHash,
  createAnswerCorpus,
  createPacketRecord,
  createReviewCorpus,
  createStageMaterial,
  hashText,
  normalizeProviderSet,
  serializePublicPacket,
  sha256Canonical,
  validatePacketRecord,
  validateStageMaterial,
} from '../src/context-packet.js'

function candidate(alias = 'S1', text = '  原文 e\u0301 😀\n```ts\n  x()\n```\n', messageId = alias): ContextCandidate {
  return {
    source: { alias, kind: 'user-text', text, epistemic: 'user-asserted' },
    privateRef: { alias, parentSessionId: 'PARENT_PRIVATE_SENTINEL', origin: 'surface', messageId, eventSeq: 3,
      blockIndex: 0, textHash: hashText(text) },
    defaultSelected: true,
  }
}
const providerSet = [{ provider: 'PRIVATE_PROVIDER_SENTINEL', model: 'PRIVATE_MODEL_SENTINEL' }]
const compile = () => compileContextPacket({ topicOriginal: '  刚才那个\n', candidates: [candidate()], selectedAliases: ['S1'] })
const record = () => createPacketRecord({ ...compile(), runId: 'run', capturedThroughSeq: 3, pendingPolicy: 'included', providerSet })
const validReview = {
  evaluations: [{ answerId: 'Answer A', strengths: ['specific'], weaknesses: [] }, { answerId: 'Answer B', strengths: [], weaknesses: ['thin'] }],
  consensus: [], contradictions: [], coverageGaps: [], uniqueInsights: [], blindSpots: [], ranking: ['Answer B', 'Answer A'],
}

describe('canonical JSON and hashes', () => {
  it('sorts nested object keys but preserves array order, whitespace and Unicode code points', () => {
    const left = { b: [{ z: '  x\n', a: 'e\u0301' }], a: '😀' }
    const right = { a: '😀', b: [{ a: 'e\u0301', z: '  x\n' }] }
    expect(canonicalJson(left)).toBe(canonicalJson(right))
    expect(sha256Canonical(left)).toBe(sha256Canonical(right))
    expect(canonicalJson(left)).toBe('{"a":"😀","b":[{"a":"é","z":"  x\\n"}]}')
    expect(sha256Canonical({ a: 'é' })).not.toBe(sha256Canonical({ a: 'e\u0301' }))
    expect(sha256Canonical(['a', 'b'])).not.toBe(sha256Canonical(['b', 'a']))
    expect(sha256Canonical({ text: 'x' })).not.toBe(sha256Canonical({ text: 'x ' }))
    expect(hashText('abc')).toBe(`sha256:${createHash('sha256').update('abc').digest('hex')}`)
  })

  it.each([undefined, NaN, Infinity, -Infinity, 1n, () => 1, Symbol('x'), new Date(), new Map(), /x/,
    { x: undefined }, [undefined], new Array(2)])('rejects non-JSON values rather than losing them: %s', (value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError)
  })

  it('rejects cycles, accessors, hidden/symbol fields and decorated arrays without invoking getters', () => {
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    let getterCalled = false
    const accessor = Object.defineProperty({}, 'x', { enumerable: true, get: () => { getterCalled = true; return 1 } })
    const hidden = Object.defineProperty({}, 'hidden', { value: 1 })
    const symbol = { [Symbol('x')]: 1 }
    const decorated = Object.assign([1], { extra: 2 })
    for (const value of [cycle, accessor, hidden, symbol, decorated]) expect(() => canonicalJson(value)).toThrow(TypeError)
    expect(getterCalled).toBe(false)
    const shared = { x: 1 }
    expect(canonicalJson([shared, shared])).toBe('[{"x":1},{"x":1}]')
  })
})

describe('packet compiler', () => {
  it('PKT-01 retains topic, code whitespace and exact source text in a detached frozen packet', () => {
    const input = candidate()
    const compiled = compileContextPacket({ topicOriginal: '  刚才那个\n', candidates: [input], selectedAliases: ['S1'] })
    expect(compiled.packet.topicOriginal).toBe('  刚才那个\n')
    expect(compiled.packet.sources[0]?.text).toBe(input.source.text)
    input.source.text = 'changed later'
    expect(compiled.packet.sources[0]?.text).not.toBe(input.source.text)
    expect(compiled.packetHash).toBe(hashText(serializePublicPacket(compiled.packet)))
    expect(Object.isFrozen(compiled.packet.sources[0])).toBe(true)
    expect(Object.isFrozen(compiled.privateSources[0])).toBe(true)
  })

  it('PKT-03 public serialization contains no private provenance or receiving routes', () => {
    const persisted = record()
    const serialized = serializePublicPacket(persisted.packet)
    for (const secret of ['PARENT_PRIVATE_SENTINEL', 'PRIVATE_PROVIDER_SENTINEL', 'PRIVATE_MODEL_SENTINEL', 'privateSources', 'messageId', 'eventSeq', 'textHash']) {
      expect(serialized).not.toContain(secret)
    }
    expect(() => serializePublicPacket(persisted as unknown as ContextPacket)).toThrow()
    expect(() => serializePublicPacket({ ...persisted.packet, provider: 'SECRET_SENTINEL' } as ContextPacket)).toThrow()
  })

  it('selects exact aliases in stable capture order and never implicitly selects tools or all sources', () => {
    const tool = candidate('S3', 'TOOL_EVIDENCE_SENTINEL')
    tool.source.kind = 'tool-evidence'
    tool.source.epistemic = 'tool-observed'
    tool.defaultSelected = false
    const candidates = [candidate('S1', 'first'), candidate('S2', 'second'), tool]
    const compiled = compileContextPacket({ topicOriginal: 'q', candidates, selectedAliases: ['S2', 'S1'],
      attachments: [{ name: 'manual.pdf', disposition: 'reference-only' }, { name: 'secret.png', disposition: 'excluded' }] })
    expect(compiled.packet.sources.map(source => source.alias)).toEqual(['S1', 'S2'])
    expect(serializePublicPacket(compiled.packet)).not.toContain('TOOL_EVIDENCE_SENTINEL')
    expect(compiled.packet.attachments).toEqual([{ name: 'manual.pdf', disposition: 'reference-only' }, { name: 'secret.png', disposition: 'excluded' }])
    expect(compileContextPacket({ topicOriginal: 'q', candidates, selectedAliases: [] }).packet.sources).toEqual([])
    expect(compileContextPacket({ topicOriginal: 'q', candidates, selectedAliases: ['S3'] }).packet.sources[0]?.kind).toBe('tool-evidence')
  })

  it('rejects unknown/duplicate aliases, source mutations, cross-parent and duplicate positions', () => {
    const input = { topicOriginal: 'q', candidates: [candidate()], selectedAliases: ['S1'] }
    expect(() => compileContextPacket({ ...input, selectedAliases: ['S2'] })).toThrow(/Unknown/)
    expect(() => compileContextPacket({ ...input, selectedAliases: ['S1', 'S1'] })).toThrow()
    expect(() => compileContextPacket({ ...input, candidates: [candidate(), candidate()] })).toThrow(/Duplicate/)
    const mutated = candidate(); mutated.source.text += 'changed'
    expect(() => compileContextPacket({ ...input, candidates: [mutated] })).toThrow(/hash mismatch/)
    const cross = candidate('S2'); cross.privateRef.parentSessionId = 'other'
    expect(() => compileContextPacket({ ...input, candidates: [candidate(), cross] })).toThrow(/cross parent/)
    const duplicate = candidate('S2', 'different', 'S1')
    expect(() => compileContextPacket({ ...input, candidates: [candidate(), duplicate] })).toThrow(/position/)
  })

  it('rejects candidate, packet and UTF-8 byte overflow instead of truncating', () => {
    expect(() => compileContextPacket({ topicOriginal: 'q', candidates: [candidate()], selectedAliases: [], maxCandidateBytes: 1 })).toThrow(/CONTEXT_TOO_LARGE/)
    expect(() => compileContextPacket({ topicOriginal: 'q', candidates: [candidate()], selectedAliases: ['S1'], maxPacketBytes: 1 })).toThrow(/CONTEXT_TOO_LARGE/)
    expect(() => compileContextPacket({ topicOriginal: 'q', candidates: [candidate(), candidate('S2')], selectedAliases: ['S1'], maxSources: 1 })).toThrow(/CONTEXT_TOO_LARGE/)
    expect(() => compileContextPacket({ topicOriginal: 'q', candidates: [candidate('S1', '中'.repeat(23_000))], selectedAliases: ['S1'] })).toThrow()
    for (const maximum of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => compileContextPacket({ topicOriginal: 'q', candidates: [], selectedAliases: [], maxPacketBytes: maximum })).toThrow()
    }
  })

  it('canonicalizes only provider set order/duplicates, and invalidates consent on any public or route change', () => {
    const routes = [{ provider: 'b', model: '2' }, { provider: 'a', model: '3' }, { provider: 'a', model: '3' }, { provider: 'a', model: '1' }]
    expect(normalizeProviderSet(routes)).toEqual([{ provider: 'a', model: '1' }, { provider: 'a', model: '3' }, { provider: 'b', model: '2' }])
    const hash = compile().packetHash
    expect(computeExportHash(hash, routes)).toBe(computeExportHash(hash, [...routes].reverse()))
    expect(computeExportHash(hash, routes)).not.toBe(computeExportHash(hash, [{ provider: 'other', model: '2' }]))
    expect(computeExportHash(hash, routes)).not.toBe(computeExportHash(hashText('other'), routes))
    expect(normalizeProviderSet([{ provider: ' a ', model: 'm' }])[0]?.provider).toBe(' a ')
    expect(() => normalizeProviderSet([])).toThrow()
  })

  it('revalidates persisted public/private/consent hashes and version before reuse', () => {
    const persisted = record()
    expect(validatePacketRecord(persisted)).toEqual(persisted)
    expect(() => validatePacketRecord({ ...persisted, packetHash: hashText('other') })).toThrow(/Packet hash/)
    expect(() => validatePacketRecord({ ...persisted, packet: { ...persisted.packet, topicOriginal: 'other' } })).toThrow(/Packet hash/)
    expect(() => validatePacketRecord({ ...persisted, consent: { ...persisted.consent, exportHash: hashText('other') } })).toThrow(/export hash/)
    expect(() => validatePacketRecord({ ...persisted, privateSources: [{ ...persisted.privateSources[0], textHash: hashText('other') }] })).toThrow(/text hash/)
  })
})

describe('frozen anonymous stage material', () => {
  it('MAT-01 keeps one packet and one answer corpus across review/arbiter, with deterministic stage hashes', () => {
    const { packet, packetHash } = compile()
    const answers = createAnswerCorpus([
      { answerId: 'Answer A', text: 'A' }, { answerId: 'Answer B', text: 'B' },
    ])
    const reviews = createReviewCorpus([{ reviewId: 'Review 1', output: validReview }])
    const answer = createStageMaterial({ stage: 'answer', payload: { packet } })
    const review = createStageMaterial({ stage: 'review', payload: { packet, answerCorpus: answers } })
    const arbiter = createStageMaterial({ stage: 'arbiter', payload: { packet, answerCorpus: answers, reviewCorpus: reviews,
      aggregateRanking: [{ answerId: 'Answer B', averageRank: 1, votes: 1 }, { answerId: 'Answer A', averageRank: 2, votes: 1 }] } })
    expect([answer.packetHash, review.packetHash, arbiter.packetHash]).toEqual([packetHash, packetHash, packetHash])
    if (review.stage !== 'review' || arbiter.stage !== 'arbiter') throw new Error('Wrong stage')
    expect(review.answerCorpusHash).toBe(arbiter.answerCorpusHash)
    expect(createStageMaterial({ stage: 'review', payload: { answerCorpus: answers, packet } }).payloadHash).toBe(review.payloadHash)
    expect(Object.isFrozen(arbiter.payload.reviewCorpus.reviews)).toBe(true)
    for (const key of ['packetHash', 'payloadHash', 'answerCorpusHash', 'reviewCorpusHash']) {
      expect(() => validateStageMaterial({ ...arbiter, [key]: hashText('other') })).toThrow(/hash mismatch/)
    }
  })

  it('projects full records to public corpora and refuses hidden payload metadata', () => {
    const answers = [{ answerId: 'Answer A', text: 'public', model: { provider: 'SECRET_PROVIDER' }, childId: 'SECRET_CHILD' }]
    const corpus = createAnswerCorpus(answers)
    expect(canonicalJson(corpus)).not.toContain('SECRET_')
    const reviews = [{ reviewId: 'Review 1', output: validReview, model: { provider: 'SECRET_PROVIDER' } }]
    expect(canonicalJson(createReviewCorpus(reviews))).not.toContain('SECRET_')
    const hiddenCorpus = { ...corpus, provider: 'SECRET' }
    expect(() => createStageMaterial({ stage: 'review', payload: { packet: compile().packet, answerCorpus: hiddenCorpus } })).toThrow()
  })

  it('rejects corpus swaps, unknown answer references, fabricated aggregate ranks and oversized artifacts', () => {
    const packet = compile().packet
    const answerCorpus = createAnswerCorpus([{ answerId: 'different', text: 'x' }])
    const reviewCorpus = createReviewCorpus([{ reviewId: 'Review 1', output: validReview }])
    expect(() => createStageMaterial({ stage: 'arbiter', payload: { packet, answerCorpus, reviewCorpus,
      aggregateRanking: [{ answerId: 'different', averageRank: 1, votes: 1 }] } })).toThrow()
    const two = createAnswerCorpus([{ answerId: 'Answer A', text: 'A' }, { answerId: 'Answer B', text: 'B' }])
    expect(() => createStageMaterial({ stage: 'arbiter', payload: { packet, answerCorpus: two, reviewCorpus,
      aggregateRanking: [{ answerId: 'Answer A', averageRank: 1, votes: 1 }, { answerId: 'Answer B', averageRank: 2, votes: 1 }] } })).toThrow()
    expect(() => createAnswerCorpus([{ answerId: 'Answer A', text: '中'.repeat(23_000) }])).toThrow()
    expect(() => createAnswerCorpus([{ answerId: 'same', text: 'a' }, { answerId: 'same', text: 'b' }])).toThrow()
  })
})
