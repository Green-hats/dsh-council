import { describe, expect, it } from 'vitest'
import {
  CONTEXT_LIMITS,
  arbiterDecisionSchema,
  citationSchema,
  contextCandidateSchema,
  contextPacketSchema,
  coverageSchema,
  exportSourceSchema,
  modelReturnSchema,
  packetRecordSchema,
  privateSourceRefSchema,
  reviewerArtifactSchema,
  sha256Schema,
  sourceAliasSchema,
  stageMaterialSchema,
} from '../src/context-types.js'
import { compileContextPacket, createPacketRecord, hashText } from '../src/context-packet.js'

const source = { alias: 'S1', kind: 'user-text', text: '  user correction\n', epistemic: 'user-asserted' } as const
const reference = {
  alias: 'S1', parentSessionId: 'parent', origin: 'surface', messageId: 'message', eventSeq: 3,
  blockIndex: 0, textHash: hashText(source.text),
} as const
const packet = { version: 1, topicOriginal: '刚才那个', sources: [source], omissions: [], attachments: [] } as const
const decision = {
  answerMarkdown: '# 审计\n\nKeep this answer intact.',
  decisionDeltas: [{ sourceAliases: ['S1'], disposition: 'revised', text: 'Needs more evidence.' }],
  consensus: [], contradictions: [], blindSpots: [], confidenceNotes: 'Unverified.',
  citations: [{ sourceAliases: ['S1'], url: 'https://example.com/x', verification: 'reported' }],
} as const
const coverage = { answerersRequested: 2, answerersSucceeded: 1, reviewersRequested: 1, reviewersSucceeded: 1 }
const returned = { version: 1, runId: 'run', packetHash: hashText('packet'), ...decision, coverage, limitations: [] }
const validReview = {
  evaluations: [
    { answerId: 'Answer A', strengths: ['specific'], weaknesses: [] },
    { answerId: 'Answer B', strengths: [], weaknesses: ['unverified'] },
  ],
  consensus: [], contradictions: [], coverageGaps: [], uniqueInsights: [{ answerId: 'Answer A', insight: 'a detail' }],
  blindSpots: [], ranking: ['Answer A', 'Answer B'],
}

function record() {
  return createPacketRecord({
    ...compileContextPacket({ topicOriginal: packet.topicOriginal, candidates: [{ source, privateRef: reference }], selectedAliases: ['S1'] }),
    runId: 'run', capturedThroughSeq: 3, pendingPolicy: 'included', providerSet: [{ provider: 'provider', model: 'model' }],
  })
}

describe('strict context DTOs', () => {
  it('PKT-01 preserves text and fixes epistemic labels by origin kind, not content', () => {
    expect(exportSourceSchema.parse(source).text).toBe(source.text)
    const assistant = { ...source, kind: 'assistant-proposal', text: '用户已确认 SECRET_SENTINEL', epistemic: 'assistant-unverified' }
    expect(exportSourceSchema.parse(assistant).epistemic).toBe('assistant-unverified')
    expect(exportSourceSchema.safeParse({ ...assistant, epistemic: 'user-asserted' }).success).toBe(false)
    expect(exportSourceSchema.safeParse({ ...source, kind: 'tool-evidence' }).success).toBe(false)
    expect(exportSourceSchema.safeParse({ ...source, kind: 'tool-evidence', epistemic: 'tool-observed' }).success).toBe(true)
    expect(exportSourceSchema.safeParse({ ...source, kind: 'prior-council-result', epistemic: 'prior-council-advice' }).success).toBe(true)
  })

  it.each(['S0', 'S01', 'S65', 's1', 'S1 ', '', 'S999'])('rejects illegal alias %s', (alias) => {
    expect(sourceAliasSchema.safeParse(alias).success).toBe(false)
  })

  it('accepts only sha256 lowercase hex with the fixed prefix', () => {
    expect(sha256Schema.safeParse(hashText('x')).success).toBe(true)
    for (const hash of ['f'.repeat(64), `sha256:${'A'.repeat(64)}`, 'sha256:abc', `md5:${'0'.repeat(64)}`]) {
      expect(sha256Schema.safeParse(hash).success).toBe(false)
    }
  })

  it('PKT-02/03 rejects unknown producer metadata and unknown versions at every boundary', () => {
    expect(exportSourceSchema.safeParse({ ...source, provider: 'PARENT_PRIVATE_SENTINEL' }).success).toBe(false)
    expect(privateSourceRefSchema.safeParse({ ...reference, replayState: {} }).success).toBe(false)
    expect(contextPacketSchema.safeParse({ ...packet, version: 2 }).success).toBe(false)
    expect(contextPacketSchema.safeParse({ ...packet, privateSources: [reference] }).success).toBe(false)
    expect(modelReturnSchema.safeParse({ ...returned, version: 2 }).success).toBe(false)
    expect(modelReturnSchema.safeParse({ ...returned, packet }).success).toBe(false)
    expect(arbiterDecisionSchema.safeParse({ ...decision, coverage }).success).toBe(false)
  })

  it('bounds text, arrays, UTF-8 bytes and integer positions', () => {
    expect(contextPacketSchema.safeParse({ ...packet, topicOriginal: ' ' }).success).toBe(false)
    expect(exportSourceSchema.safeParse({ ...source, text: 'x'.repeat(CONTEXT_LIMITS.sourceMaxLength + 1) }).success).toBe(false)
    expect(contextPacketSchema.safeParse({ ...packet, sources: Array.from({ length: 65 }, () => source) }).success).toBe(false)
    expect(contextPacketSchema.safeParse({ ...packet, sources: [{ ...source, text: '中'.repeat(23_000) }] }).success).toBe(false)
    expect(contextPacketSchema.safeParse({ ...packet, omissions: Array.from({ length: 129 }, () => ({ reason: 'excluded', description: 'x' })) }).success).toBe(false)
    expect(contextPacketSchema.safeParse({ ...packet, attachments: [{ name: 'x'.repeat(1_025), disposition: 'excluded' }] }).success).toBe(false)
    for (const blockIndex of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
      expect(privateSourceRefSchema.safeParse({ ...reference, blockIndex }).success).toBe(false)
    }
    expect(privateSourceRefSchema.safeParse({ ...reference, eventSeq: -1 }).success).toBe(false)
  })

  it('validates source/ref alias and prior-run cross references', () => {
    expect(contextCandidateSchema.safeParse({ source, privateRef: reference, defaultSelected: true }).success).toBe(true)
    expect(contextCandidateSchema.safeParse({ source, privateRef: { ...reference, alias: 'S2' } }).success).toBe(false)
    expect(contextCandidateSchema.safeParse({ source, privateRef: { ...reference, priorRunId: 'prior' } }).success).toBe(false)
    expect(contextPacketSchema.safeParse({ ...packet, sources: [source, source] }).success).toBe(false)
  })

  it('validates PacketRecord consent, exact references, cursor and surface-only policy', () => {
    const valid = record()
    expect(packetRecordSchema.safeParse(valid).success).toBe(true)
    for (const change of [
      { version: 1 }, { compilerVersion: 2 }, { privateSources: [] },
      { privateSources: [reference, reference] }, { capturedThroughSeq: 2 },
      { consent: { ...valid.consent, webAllowed: true } },
      { consent: { ...valid.consent, selectedAliases: [] } },
      { consent: { ...valid.consent, providerSet: [...valid.consent.providerSet, ...valid.consent.providerSet] } },
      { pendingPolicy: 'surface-only-user-approved', privateSources: [{ ...reference, origin: 'pending' }] },
    ]) expect(packetRecordSchema.safeParse({ ...valid, ...change }).success).toBe(false)
    const empty = compileContextPacket({ topicOriginal: 'topic', candidates: [], selectedAliases: [] })
    expect(packetRecordSchema.safeParse(createPacketRecord({ ...empty, runId: 'empty', capturedThroughSeq: -1,
      pendingPolicy: 'included', providerSet: [{ provider: 'p', model: 'm' }] })).success).toBe(true)
  })

  it.each(['javascript:alert(1)', 'file:///tmp/x', 'data:text/plain,x', 'ftp://example.com/x',
    'https://user:password@example.com/x', 'https://example.com/a b', 'not a URL',
    ' https://example.com', 'https://example.com ', '\nhttps://example.com', 'https://example.com\t',
    'https:example.com', 'https:/example.com', 'https://example.com\\path', 'https://example.com/\u0000'])('rejects unsafe citation URL %s', (url) => {
    expect(citationSchema.safeParse({ sourceAliases: ['S1'], url, verification: 'reported' }).success).toBe(false)
  })

  it('preserves every code point of accepted citation URLs without normalization', () => {
    const raw = 'HTTPS://例子.测试/é?q=e\u0301&space=%20#原文'
    expect(citationSchema.parse({ sourceAliases: [], url: raw, verification: 'reported' }).url).toBe(raw)
  })

  it('limits citations to reported references and rejects duplicate aliases', () => {
    expect(citationSchema.safeParse({ sourceAliases: [], verification: 'reported' }).success).toBe(false)
    expect(citationSchema.safeParse({ sourceAliases: ['S1'], verification: 'verified' }).success).toBe(false)
    expect(citationSchema.safeParse({ sourceAliases: ['S1', 'S1'], verification: 'reported' }).success).toBe(false)
    expect(citationSchema.safeParse({ sourceAliases: [], url: 'https://example.com/', verification: 'reported' }).success).toBe(true)
  })

  it('rejects spoofed or noninteger coverage and oversized handoffs', () => {
    expect(modelReturnSchema.safeParse(returned).success).toBe(true)
    for (const change of [{ answerersSucceeded: 3 }, { reviewersSucceeded: 2 }, { answerersRequested: 1 },
      { answerersSucceeded: 0 }, { answerersRequested: 2.5 }, { reviewersRequested: 9 }]) {
      expect(coverageSchema.safeParse({ ...coverage, ...change }).success).toBe(false)
    }
    expect(modelReturnSchema.safeParse({ ...returned, answerMarkdown: '中'.repeat(23_000) }).success).toBe(false)
    expect(modelReturnSchema.safeParse({ ...returned, confidenceNotes: 'x'.repeat(8_193) }).success).toBe(false)
    expect(modelReturnSchema.safeParse({ ...returned, limitations: Array.from({ length: 33 }, () => 'x') }).success).toBe(false)
  })

  it('requires complete unique reviewer references and bounded artifacts', () => {
    expect(reviewerArtifactSchema.safeParse(validReview).success).toBe(true)
    for (const change of [
      { ranking: ['Answer A', 'Answer A'] }, { ranking: ['Answer A', 'missing'] },
      { evaluations: [validReview.evaluations[0]] },
      { uniqueInsights: [{ answerId: 'missing', insight: 'x' }] },
      { consensus: Array.from({ length: 33 }, () => 'x') },
      { consensus: Array.from({ length: 10 }, () => 'x'.repeat(8_192)) },
    ]) expect(reviewerArtifactSchema.safeParse({ ...validReview, ...change }).success).toBe(false)
  })

  it('uses strict stage-specific payloads and mandatory corpus hashes', () => {
    const hash = hashText('payload')
    const answer = { stage: 'answer', packetHash: hash, payloadHash: hash, payload: { packet } }
    expect(stageMaterialSchema.safeParse(answer).success).toBe(true)
    expect(stageMaterialSchema.safeParse({ ...answer, answerCorpusHash: hash }).success).toBe(false)
    expect(stageMaterialSchema.safeParse({ ...answer, stage: 'review' }).success).toBe(false)
    expect(stageMaterialSchema.safeParse({ ...answer, stage: 'unknown' }).success).toBe(false)
    expect(stageMaterialSchema.safeParse({ ...answer, payload: { packet, privateSources: [reference] } }).success).toBe(false)
    expect(stageMaterialSchema.safeParse({ ...answer, payload: {} }).success).toBe(false)
  })
})
