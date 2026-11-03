import { describe, expect, it } from 'vitest'
import { createModelReturn, parseArbiterDecision, parseModelReturn, renderModelReturn } from '../src/handoff.js'
import { hashText } from '../src/context-packet.js'
import { localeCopies } from '../src/locales.js'
import { renderCouncilAudit } from '../src/protocol.js'
import type { ArbiterDecision } from '../src/context-types.js'
import type { CouncilResult, ModelRef } from '../src/types.js'

const body = '  # 审计\n\n## Aggregate Ranking\n\n```ts\n  keepWhitespace()\n```\n\ne\u0301 😀\n'
const decision: ArbiterDecision = {
  answerMarkdown: body,
  decisionDeltas: [{ sourceAliases: ['S1'], disposition: 'revised', text: 'The earlier proposal needs validation.' }],
  consensus: ['Keep the user constraint.'], contradictions: ['Evidence conflicts.'], blindSpots: ['No benchmark.'],
  confidenceNotes: 'Advice remains uncertain.', citations: [{ sourceAliases: ['S1'], url: 'https://example.com/evidence', verification: 'reported' }],
}
const coverage = { answerersRequested: 3, answerersSucceeded: 2, reviewersRequested: 2, reviewersSucceeded: 1 }
function returned() {
  return createModelReturn({ runId: 'run', packetHash: hashText('packet'), decision, coverage,
    limitations: ['Chat mode did not use Web.', 'Attachments were not read.'], sourceAliases: ['S1'] })
}

const model = (key: string): ModelRef => ({ provider: 'PRIVATE_PROVIDER_SENTINEL', providerName: 'Private', model: key, modelName: key, key, optionLabel: key })
const auditResult: CouncilResult = {
  selection: { answerers: [model('PRIVATE_ANSWER_A'), model('PRIVATE_ANSWER_B')], reviewers: [model('PRIVATE_REVIEW')], arbiter: model('PRIVATE_ARBITER'), question: 'PRIVATE_TOPIC_SENTINEL' },
  directoryFailures: [],
  answers: [{ answerId: 'Answer A', model: model('PRIVATE_ANSWER_A'), text: 'RAW_CHILD_OUTPUT_SENTINEL' }],
  reviews: [], aggregateRanking: [{ answerId: 'Answer A', averageRank: 1, votes: 1 }],
  arbiter: { answerMarkdown: body, consensus: [], contradictions: [], blindSpots: [], confidenceNotes: 'note' },
  failures: [{ stage: 'answer', model: model('PRIVATE_FAILED_MODEL'), message: 'PRIVATE_DIAGNOSTIC_SENTINEL' }],
}

describe('strict Host-owned ModelReturn construction', () => {
  it('binds actual Host provenance and coverage without changing the arbiter answer', () => {
    const value = returned()
    expect(value.answerMarkdown).toBe(body)
    expect(value.coverage).toEqual(coverage)
    expect(value.runId).toBe('run')
    expect(value.packetHash).toBe(hashText('packet'))
    expect(value.limitations).toContain('Chat mode did not use Web.')
    expect(parseModelReturn(value, ['S1'])).toEqual(value)
  })

  it('rejects model attempts to supply Host-owned facts', () => {
    expect(parseArbiterDecision({ ...decision, coverage })).toBeUndefined()
    expect(parseArbiterDecision({ ...decision, runId: 'forged' })).toBeUndefined()
    expect(parseArbiterDecision({ ...decision, limitations: ['fake'] })).toBeUndefined()
    expect(parseArbiterDecision({ ...decision, packetHash: hashText('fake') })).toBeUndefined()
  })

  it('checks references against the packet when supplied, and reads historical aliases independently', () => {
    expect(parseModelReturn(returned())).toBeDefined()
    expect(parseModelReturn(returned(), ['S2'])).toBeUndefined()
    expect(parseArbiterDecision(decision, [])).toBeUndefined()
    expect(parseModelReturn(returned(), ['S1', 'S1'])).toBeUndefined()
    expect(() => createModelReturn({ runId: 'r', packetHash: hashText('p'), decision, coverage, limitations: [], sourceAliases: ['S2'] })).toThrow(/alias/)
    expect(parseModelReturn({ ...returned(), citations: [{ sourceAliases: ['S65'], verification: 'reported' }] })).toBeUndefined()
  })

  it('supports topic-only without inventing a packet or background aliases', () => {
    const value = createModelReturn({ runId: 'topic', decision: { ...decision, decisionDeltas: [],
      citations: [{ sourceAliases: [], url: 'https://example.com/', verification: 'reported' }] },
    coverage, limitations: [], sourceAliases: [] })
    expect(value).not.toHaveProperty('packetHash')
    expect(parseModelReturn(value, [])).toEqual(value)
    expect(() => createModelReturn({ runId: 'topic', decision, coverage, limitations: [], sourceAliases: ['S1'] })).toThrow(/Topic-only/)
  })

  it('fails closed on unknown versions, loose objects and unsafe URLs', () => {
    expect(parseModelReturn({ ...returned(), version: 2 })).toBeUndefined()
    const { packetHash: _packetHash, ...unboundAliases } = returned()
    expect(parseModelReturn(unboundAliases)).toBeUndefined()
    expect(parseModelReturn({ ...returned(), presentation: { auditMarkdown: 'SECRET_SENTINEL' } })).toBeUndefined()
    expect(parseArbiterDecision({ ...decision, citations: [{ sourceAliases: [], url: 'file:///private/path', verification: 'reported' }] })).toBeUndefined()
    expect(parseModelReturn(null)).toBeUndefined()
    expect(parseModelReturn([])).toBeUndefined()
  })
})

describe('independent concise handoff renderer', () => {
  it.each(['en', 'zh'] as const)('RET-01 preserves headings/code/Unicode in %s answer, without Markdown boundary guessing', (locale) => {
    const value = returned()
    const text = renderModelReturn(value, localeCopies[locale])
    expect(text).toContain(body)
    expect(text.match(/keepWhitespace/g)).toHaveLength(1)
    expect(text).toContain(value.confidenceNotes)
    expect(text).toContain('https://example.com/evidence')
    expect(text).toContain('S1')
    expect(text).toContain('2/3')
    expect(text).toContain('1/2')
    expect(text).toContain('Chat mode did not use Web.')
  })

  it('RET-02 excludes full audit, routing, raw child outputs, packet and provenance', () => {
    const text = renderModelReturn(returned(), 'en')
    const audit = renderCouncilAudit(auditResult, localeCopies.en)
    expect(audit).toContain('PRIVATE_ANSWER_A')
    expect(audit).toContain('PRIVATE_ARBITER')
    expect(audit).toContain('PRIVATE_DIAGNOSTIC_SENTINEL')
    for (const hidden of ['PRIVATE_ANSWER_A', 'PRIVATE_PROVIDER_SENTINEL', 'PRIVATE_REVIEW', 'PRIVATE_ARBITER',
      'PRIVATE_DIAGNOSTIC_SENTINEL', 'RAW_CHILD_OUTPUT_SENTINEL', 'PRIVATE_TOPIC_SENTINEL', 'privateSources',
      'packetHash', 'runId', 'Anonymous Mapping', hashText('packet')]) expect(text).not.toContain(hidden)
    expect(text).toContain('Council advice, not a user decision.')
    expect(text).toContain('not independently verified')
  })

  it('omits empty optional sections without compressing or trimming the answer', () => {
    const value = returned()
    const text = renderModelReturn({ ...value, decisionDeltas: [], consensus: [], contradictions: [], blindSpots: [], citations: [], limitations: [] })
    expect(text).toContain(body)
    expect(text).not.toContain('Changes relative')
    expect(text).not.toContain('### Limitations')
    expect(text).toContain('Anonymous coverage')
  })
})
