import { z } from 'zod'
import {
  CONTEXT_LIMITS,
  arbiterDecisionSchema,
  coverageSchema,
  modelReturnSchema,
  sha256Schema,
  sourceAliasSchema,
  type ArbiterDecision,
  type Coverage,
  type ModelReturn,
} from './context-types.js'
import { localeCopies, type CouncilCopy, type CouncilLocale } from './locales.js'

const allowedAliasesSchema = z.array(sourceAliasSchema).max(CONTEXT_LIMITS.maxSources)
  .refine(value => new Set(value).size === value.length, 'Duplicate allowed alias')

/** Omit aliases only when reading a historical return without its original packet. */
function aliasesMatch(value: ArbiterDecision, allowedAliases?: readonly string[]): boolean {
  if (allowedAliases === undefined) return true
  const parsed = allowedAliasesSchema.safeParse(allowedAliases)
  if (!parsed.success) return false
  const allowed = new Set(parsed.data)
  return [...value.decisionDeltas, ...value.citations].every(entry => entry.sourceAliases.every(alias => allowed.has(alias)))
}

export function parseArbiterDecision(value: unknown, allowedAliases?: readonly string[]): ArbiterDecision | undefined {
  const result = arbiterDecisionSchema.safeParse(value)
  return result.success && aliasesMatch(result.data, allowedAliases) ? result.data : undefined
}

/** Strict v1 ModelReturn reader; a v2 producer source wraps this v1 DTO. */
export function parseModelReturn(value: unknown, allowedAliases?: readonly string[]): ModelReturn | undefined {
  const result = modelReturnSchema.safeParse(value)
  return result.success && aliasesMatch(result.data, allowedAliases) ? result.data : undefined
}

const createModelReturnInputSchema = z.strictObject({
  runId: modelReturnSchema.shape.runId,
  packetHash: sha256Schema.optional(),
  decision: arbiterDecisionSchema,
  coverage: coverageSchema,
  limitations: modelReturnSchema.shape.limitations,
  sourceAliases: allowedAliasesSchema,
})
type ReadonlyDto<T> = T extends readonly (infer Item)[] ? readonly ReadonlyDto<Item>[]
  : T extends object ? { readonly [Key in keyof T]: ReadonlyDto<T[Key]> } : T
export interface CreateModelReturnInput {
  readonly runId: string
  readonly packetHash?: string
  readonly decision: ReadonlyDto<ArbiterDecision>
  readonly coverage: Coverage
  readonly limitations: readonly string[]
  readonly sourceAliases: readonly string[]
}

/** Host provides provenance, measured coverage and limitations; none come from model output. */
export function createModelReturn(input: CreateModelReturnInput): ModelReturn {
  const parsed = createModelReturnInputSchema.parse(input)
  if (!aliasesMatch(parsed.decision, parsed.sourceAliases)) throw new Error('Unknown ModelReturn source alias')
  if (parsed.packetHash === undefined && parsed.sourceAliases.length > 0) throw new Error('Topic-only returns cannot reference a background packet')
  return modelReturnSchema.parse({
    version: 1,
    runId: parsed.runId,
    ...(parsed.packetHash === undefined ? {} : { packetHash: parsed.packetHash }),
    ...parsed.decision,
    coverage: parsed.coverage,
    limitations: parsed.limitations,
  })
}

const handoffCopy = {
  en: {
    attribution: 'Council advice, not a user decision.',
    deltas: '### Changes relative to background',
    citations: '### Reported sources (not independently verified)',
    coverage: '### Anonymous coverage',
    limitations: '### Limitations',
    disposition: { supported: 'supported', revised: 'revised', rejected: 'rejected', unresolved: 'unresolved' },
    counts: (answerSucceeded: number, answerRequested: number, reviewSucceeded: number, reviewRequested: number) =>
      `Answerers: ${answerSucceeded}/${answerRequested}; reviewers: ${reviewSucceeded}/${reviewRequested}.`,
  },
  zh: {
    attribution: '以下为议会建议，不代表用户已作决定。',
    deltas: '### 相对背景的关键变化',
    citations: '### 报告的来源（未独立核验）',
    coverage: '### 匿名覆盖情况',
    limitations: '### 限制',
    disposition: { supported: '支持', revised: '修订', rejected: '否定', unresolved: '未解决' },
    counts: (answerSucceeded: number, answerRequested: number, reviewSucceeded: number, reviewRequested: number) =>
      `回答人：${answerSucceeded}/${answerRequested}；评审人：${reviewSucceeded}/${reviewRequested}。`,
  },
} as const

/** Independent model-facing renderer. Never accepts or splits the complete UI audit. */
export function renderModelReturn(value: ModelReturn, copyOrLocale: CouncilCopy | CouncilLocale = 'en'): string {
  const result = modelReturnSchema.parse(value)
  const copy = typeof copyOrLocale === 'string' ? localeCopies[copyOrLocale] : copyOrLocale
  const labels = handoffCopy[copy.locale]
  const sections = [copy.decisionHeading, labels.attribution, result.answerMarkdown]
  const listSection = (heading: string, items: readonly string[]): void => {
    if (items.length > 0) sections.push(heading, items.map(item => `- ${item}`).join('\n'))
  }
  listSection(labels.deltas, result.decisionDeltas.map(delta =>
    `[${labels.disposition[delta.disposition]}]${delta.sourceAliases.length > 0 ? ` (${delta.sourceAliases.join(', ')})` : ''} ${delta.text}`))
  listSection(copy.consensusHeading, result.consensus)
  listSection(copy.contradictionsHeading, result.contradictions)
  listSection(copy.blindSpotsHeading, result.blindSpots)
  sections.push(copy.confidenceHeading, result.confidenceNotes)
  listSection(labels.citations, result.citations.map(citation =>
    [citation.sourceAliases.join(', '), citation.url].filter(part => part !== undefined && part !== '').join(' — ')))
  sections.push(labels.coverage, labels.counts(result.coverage.answerersSucceeded, result.coverage.answerersRequested,
    result.coverage.reviewersSucceeded, result.coverage.reviewersRequested))
  listSection(labels.limitations, result.limitations)
  return sections.join('\n\n')
}
