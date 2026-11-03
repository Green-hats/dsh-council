import { z } from 'zod'

/** Hard DTO ceilings, independent of (possibly smaller) per-run budgets. */
export const CONTEXT_LIMITS = Object.freeze({
  maxSources: 64,
  candidateMaxBytes: 524_288,
  packetMaxBytes: 65_536,
  topicMaxLength: 65_536,
  sourceMaxLength: 524_288,
  artifactMaxBytes: 65_536,
  stageMaxBytes: 2_097_152,
  modelReturnMaxBytes: 262_144,
  maxParticipants: 8,
  maxRoutes: 17,
  maxNotes: 32,
  noteMaxLength: 8_192,
  maxOmissions: 128,
  maxAttachments: 64,
} as const)

const identifier = z.string().min(1).max(512).refine(value => value.trim().length > 0, 'Identifier cannot be blank')
const nonblank = (maximum: number) => z.string().min(1).max(maximum)
  .refine(value => value.trim().length > 0, 'Text cannot be blank')
const note = nonblank(CONTEXT_LIMITS.noteMaxLength)
const notes = z.array(note).max(CONTEXT_LIMITS.maxNotes)
const safeIndex = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const cursor = z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER)
const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')
const unique = (values: readonly string[]): boolean => new Set(values).size === values.length
const sameSet = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length
  && left.every(value => right.includes(value))

export const modeSchema = z.enum(['chat', 'topic-only'])
export const originSchema = z.enum(['surface', 'pending'])
export const sourceAliasSchema = z.string().regex(/^S(?:[1-9]|[1-5][0-9]|6[0-4])$/)
export const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/)
export const sourceKindSchema = z.enum(['user-text', 'assistant-proposal', 'tool-evidence', 'prior-council-result'])
export const epistemicSchema = z.enum(['user-asserted', 'assistant-unverified', 'tool-observed', 'prior-council-advice'])

const epistemicByKind = {
  'user-text': 'user-asserted',
  'assistant-proposal': 'assistant-unverified',
  'tool-evidence': 'tool-observed',
  'prior-council-result': 'prior-council-advice',
} as const

export const exportSourceSchema = z.strictObject({
  alias: sourceAliasSchema,
  kind: sourceKindSchema,
  text: nonblank(CONTEXT_LIMITS.sourceMaxLength),
  epistemic: epistemicSchema,
}).refine(value => value.epistemic === epistemicByKind[value.kind], {
  path: ['epistemic'], message: 'Epistemic label must match the source kind',
})

export const privateSourceRefSchema = z.strictObject({
  alias: sourceAliasSchema,
  parentSessionId: identifier,
  origin: originSchema,
  messageId: identifier,
  eventSeq: safeIndex.optional(),
  blockIndex: safeIndex,
  textHash: sha256Schema,
  priorRunId: identifier.optional(),
})

export const contextCandidateSchema = z.strictObject({
  source: exportSourceSchema,
  privateRef: privateSourceRefSchema,
  defaultSelected: z.boolean().optional(),
}).superRefine((value, ctx) => {
  if (value.source.alias !== value.privateRef.alias) {
    ctx.addIssue({ code: 'custom', path: ['privateRef', 'alias'], message: 'Candidate aliases must match' })
  }
  if (value.privateRef.priorRunId !== undefined && value.source.kind !== 'prior-council-result') {
    ctx.addIssue({ code: 'custom', path: ['privateRef', 'priorRunId'], message: 'Only prior Council results may reference a run' })
  }
})

export const contextOmissionSchema = z.strictObject({
  reason: nonblank(128),
  description: nonblank(2_048),
})
export const contextAttachmentSchema = z.strictObject({
  name: nonblank(1_024),
  disposition: z.enum(['reference-only', 'excluded']),
})

export const contextPacketSchema = z.strictObject({
  version: z.literal(1),
  topicOriginal: nonblank(CONTEXT_LIMITS.topicMaxLength),
  sources: z.array(exportSourceSchema).max(CONTEXT_LIMITS.maxSources),
  omissions: z.array(contextOmissionSchema).max(CONTEXT_LIMITS.maxOmissions),
  attachments: z.array(contextAttachmentSchema).max(CONTEXT_LIMITS.maxAttachments),
}).superRefine((value, ctx) => {
  if (!unique(value.sources.map(source => source.alias))) {
    ctx.addIssue({ code: 'custom', path: ['sources'], message: 'Source aliases must be unique' })
  }
  if (byteLength(value) > CONTEXT_LIMITS.packetMaxBytes) {
    ctx.addIssue({ code: 'custom', message: 'Public packet exceeds its UTF-8 byte ceiling' })
  }
})

export const providerRouteSchema = z.strictObject({ provider: nonblank(256), model: identifier })
export const providerSetSchema = z.array(providerRouteSchema).min(1).max(CONTEXT_LIMITS.maxRoutes)
  .refine(value => unique(value.map(route => JSON.stringify([route.provider, route.model]))), 'Duplicate provider route')

export const packetRecordSchema = z.strictObject({
  version: z.literal(2),
  runId: identifier,
  capturedThroughSeq: cursor,
  pendingPolicy: z.enum(['included', 'surface-only-user-approved']),
  packet: contextPacketSchema,
  packetHash: sha256Schema,
  privateSources: z.array(privateSourceRefSchema).max(CONTEXT_LIMITS.maxSources),
  consent: z.strictObject({
    exportHash: sha256Schema,
    providerSet: providerSetSchema,
    selectedAliases: z.array(sourceAliasSchema).max(CONTEXT_LIMITS.maxSources),
    webAllowed: z.literal(false),
  }),
  compilerVersion: z.literal(1),
}).superRefine((value, ctx) => {
  const aliases = value.packet.sources.map(source => source.alias)
  const privateAliases = value.privateSources.map(source => source.alias)
  if (!unique(privateAliases) || !sameSet(aliases, privateAliases)) {
    ctx.addIssue({ code: 'custom', path: ['privateSources'], message: 'Exactly one private reference is required per public source' })
  }
  if (aliases.length !== value.consent.selectedAliases.length
    || aliases.some((alias, index) => value.consent.selectedAliases[index] !== alias)) {
    ctx.addIssue({ code: 'custom', path: ['consent', 'selectedAliases'], message: 'Consent must bind the complete ordered selection' })
  }
  if (new Set(value.privateSources.map(source => source.parentSessionId)).size > 1) {
    ctx.addIssue({ code: 'custom', path: ['privateSources'], message: 'Sources cannot cross parent sessions' })
  }
  const positions = value.privateSources.map(source => JSON.stringify([source.parentSessionId, source.messageId, source.blockIndex]))
  if (!unique(positions)) {
    ctx.addIssue({ code: 'custom', path: ['privateSources'], message: 'Duplicate source position' })
  }
  value.privateSources.forEach((source, index) => {
    if (source.eventSeq !== undefined && source.eventSeq > value.capturedThroughSeq) {
      ctx.addIssue({ code: 'custom', path: ['privateSources', index, 'eventSeq'], message: 'Source is after the captured cursor' })
    }
    const exported = value.packet.sources.find(candidate => candidate.alias === source.alias)
    if (source.priorRunId !== undefined && exported?.kind !== 'prior-council-result') {
      ctx.addIssue({ code: 'custom', path: ['privateSources', index, 'priorRunId'], message: 'Prior run reference has the wrong source kind' })
    }
    if (value.pendingPolicy === 'surface-only-user-approved' && source.origin === 'pending') {
      ctx.addIssue({ code: 'custom', path: ['privateSources', index, 'origin'], message: 'Surface-only consent cannot contain pending material' })
    }
  })
})

const answerIdSchema = nonblank(64)
const reviewIdSchema = nonblank(64)
export const anonymousAnswerSchema = z.strictObject({
  id: answerIdSchema,
  text: nonblank(CONTEXT_LIMITS.artifactMaxBytes).refine(value => Buffer.byteLength(value, 'utf8') <= CONTEXT_LIMITS.artifactMaxBytes, 'Answer exceeds UTF-8 byte ceiling'),
})
export const answerCorpusSchema = z.strictObject({
  version: z.literal(1),
  answers: z.array(anonymousAnswerSchema).min(1).max(CONTEXT_LIMITS.maxParticipants),
}).refine(value => unique(value.answers.map(answer => answer.id)), 'Duplicate answer ID')

export const reviewerArtifactSchema = z.strictObject({
  evaluations: z.array(z.strictObject({ answerId: answerIdSchema, strengths: notes, weaknesses: notes }))
    .min(1).max(CONTEXT_LIMITS.maxParticipants),
  consensus: notes,
  contradictions: notes,
  coverageGaps: notes,
  uniqueInsights: z.array(z.strictObject({ answerId: answerIdSchema, insight: note })).max(CONTEXT_LIMITS.maxNotes),
  blindSpots: notes,
  ranking: z.array(answerIdSchema).min(1).max(CONTEXT_LIMITS.maxParticipants),
}).superRefine((value, ctx) => {
  const evaluated = value.evaluations.map(entry => entry.answerId)
  if (!unique(evaluated) || !unique(value.ranking) || !sameSet(evaluated, value.ranking)) {
    ctx.addIssue({ code: 'custom', message: 'Ranking and evaluations must each cover the same answers exactly once' })
  }
  if (value.uniqueInsights.some(entry => !evaluated.includes(entry.answerId))) {
    ctx.addIssue({ code: 'custom', path: ['uniqueInsights'], message: 'Unknown answer reference' })
  }
  if (byteLength(value) > CONTEXT_LIMITS.artifactMaxBytes) {
    ctx.addIssue({ code: 'custom', message: 'Review exceeds UTF-8 byte ceiling' })
  }
})
export const anonymousReviewSchema = z.strictObject({ id: reviewIdSchema, output: reviewerArtifactSchema })
export const reviewCorpusSchema = z.strictObject({
  version: z.literal(1),
  reviews: z.array(anonymousReviewSchema).min(1).max(CONTEXT_LIMITS.maxParticipants),
}).superRefine((value, ctx) => {
  if (!unique(value.reviews.map(review => review.id))) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate review ID' })
  }
  const first = value.reviews[0]
  if (first !== undefined && value.reviews.some(review => !sameSet(first.output.ranking, review.output.ranking))) {
    ctx.addIssue({ code: 'custom', message: 'Reviews must cover the same answer corpus' })
  }
})
export const aggregateRankSchema = z.strictObject({
  answerId: answerIdSchema,
  averageRank: z.number().finite().min(1).max(CONTEXT_LIMITS.maxParticipants),
  votes: z.number().int().min(1).max(CONTEXT_LIMITS.maxParticipants),
})

export const answerPayloadSchema = z.strictObject({ packet: contextPacketSchema })
export const reviewPayloadSchema = z.strictObject({ packet: contextPacketSchema, answerCorpus: answerCorpusSchema })
export const arbiterPayloadSchema = z.strictObject({
  packet: contextPacketSchema,
  answerCorpus: answerCorpusSchema,
  reviewCorpus: reviewCorpusSchema,
  aggregateRanking: z.array(aggregateRankSchema).min(1).max(CONTEXT_LIMITS.maxParticipants),
}).superRefine((value, ctx) => {
  const ids = value.answerCorpus.answers.map(answer => answer.id)
  if (value.reviewCorpus.reviews.some(review => !sameSet(ids, review.output.ranking))) {
    ctx.addIssue({ code: 'custom', path: ['reviewCorpus'], message: 'Review references do not match the answer corpus' })
  }
  const ranked = value.aggregateRanking.map(rank => rank.answerId)
  if (!unique(ranked) || !sameSet(ids, ranked)) {
    ctx.addIssue({ code: 'custom', path: ['aggregateRanking'], message: 'Aggregate ranking must cover the answer corpus exactly once' })
  }
  for (const rank of value.aggregateRanking) {
    const positions = value.reviewCorpus.reviews.map(review => review.output.ranking.indexOf(rank.answerId) + 1)
    const average = positions.reduce((total, position) => total + position, 0) / positions.length
    if (rank.votes !== positions.length || rank.averageRank !== average) {
      ctx.addIssue({ code: 'custom', path: ['aggregateRanking'], message: 'Aggregate ranking must match the actual reviews' })
    }
  }
})

export const stageMaterialSchema = z.discriminatedUnion('stage', [
  z.strictObject({ stage: z.literal('answer'), packetHash: sha256Schema, payloadHash: sha256Schema, payload: answerPayloadSchema }),
  z.strictObject({ stage: z.literal('review'), packetHash: sha256Schema, answerCorpusHash: sha256Schema, payloadHash: sha256Schema, payload: reviewPayloadSchema }),
  z.strictObject({ stage: z.literal('arbiter'), packetHash: sha256Schema, answerCorpusHash: sha256Schema, reviewCorpusHash: sha256Schema, payloadHash: sha256Schema, payload: arbiterPayloadSchema }),
]).refine(value => byteLength(value) <= CONTEXT_LIMITS.stageMaxBytes, 'Stage material exceeds UTF-8 byte ceiling')

const sourceAliasesSchema = z.array(sourceAliasSchema).max(CONTEXT_LIMITS.maxSources)
  .refine(unique, 'Duplicate source alias')
export const decisionDeltaSchema = z.strictObject({
  sourceAliases: sourceAliasesSchema,
  disposition: z.enum(['supported', 'revised', 'rejected', 'unresolved']),
  text: note,
})
export const citationSchema = z.strictObject({
  sourceAliases: sourceAliasesSchema,
  // z.url() may normalize input in some Zod versions. Validate the original string instead.
  url: z.string().min(1).max(2_048).refine(value => {
    if (!/^https?:\/\//iu.test(value) || /\s|[\\\u0000-\u001f\u007f]/u.test(value)) return false
    const url = URL.parse(value)
    return url !== null && (url.protocol === 'https:' || url.protocol === 'http:')
      && url.hostname !== '' && url.username === '' && url.password === ''
  }, 'Only HTTP(S) URLs without credentials, controls or whitespace are allowed').optional(),
  verification: z.literal('reported'),
}).refine(value => value.sourceAliases.length > 0 || value.url !== undefined, 'A citation must reference a source or URL')

/** The model may supply only these fields; provenance, coverage and limitations are Host-owned. */
export const arbiterDecisionSchema = z.strictObject({
  answerMarkdown: nonblank(CONTEXT_LIMITS.artifactMaxBytes).refine(value => Buffer.byteLength(value, 'utf8') <= CONTEXT_LIMITS.artifactMaxBytes, 'Answer exceeds UTF-8 byte ceiling'),
  decisionDeltas: z.array(decisionDeltaSchema).max(CONTEXT_LIMITS.maxSources),
  consensus: notes,
  contradictions: notes,
  blindSpots: notes,
  confidenceNotes: note,
  citations: z.array(citationSchema).max(CONTEXT_LIMITS.maxSources),
})
export const coverageSchema = z.strictObject({
  answerersRequested: z.number().int().min(2).max(CONTEXT_LIMITS.maxParticipants),
  answerersSucceeded: z.number().int().min(1).max(CONTEXT_LIMITS.maxParticipants),
  reviewersRequested: z.number().int().min(1).max(CONTEXT_LIMITS.maxParticipants),
  reviewersSucceeded: z.number().int().min(1).max(CONTEXT_LIMITS.maxParticipants),
}).refine(value => value.answerersSucceeded <= value.answerersRequested
  && value.reviewersSucceeded <= value.reviewersRequested, 'Successful counts cannot exceed requested counts')
export const modelReturnSchema = z.strictObject({
  version: z.literal(1),
  runId: identifier,
  packetHash: sha256Schema.optional(),
  ...arbiterDecisionSchema.shape,
  coverage: coverageSchema,
  limitations: notes,
}).superRefine((value, ctx) => {
  if (byteLength(value) > CONTEXT_LIMITS.modelReturnMaxBytes) {
    ctx.addIssue({ code: 'custom', message: 'Model return exceeds UTF-8 byte ceiling' })
  }
  if (value.packetHash === undefined && [...value.decisionDeltas, ...value.citations].some(entry => entry.sourceAliases.length > 0)) {
    ctx.addIssue({ code: 'custom', path: ['packetHash'], message: 'Background aliases require a packet identity' })
  }
})

export type Mode = z.infer<typeof modeSchema>
export type Origin = z.infer<typeof originSchema>
export type SourceKind = z.infer<typeof sourceKindSchema>
export type ExportSource = z.infer<typeof exportSourceSchema>
export type PrivateSourceRef = z.infer<typeof privateSourceRefSchema>
export type ContextCandidate = z.infer<typeof contextCandidateSchema>
export type ContextOmission = z.infer<typeof contextOmissionSchema>
export type ContextAttachment = z.infer<typeof contextAttachmentSchema>
export type ContextPacket = z.infer<typeof contextPacketSchema>
export type ProviderRoute = z.infer<typeof providerRouteSchema>
export type PacketRecord = z.infer<typeof packetRecordSchema>
export type AnswerCorpus = z.infer<typeof answerCorpusSchema>
export type ReviewCorpus = z.infer<typeof reviewCorpusSchema>
export type ReviewerArtifact = z.infer<typeof reviewerArtifactSchema>
export type StageMaterial = z.infer<typeof stageMaterialSchema>
export type StagePayload = StageMaterial['payload']
export type ArbiterDecision = z.infer<typeof arbiterDecisionSchema>
export type ModelReturn = z.infer<typeof modelReturnSchema>
export type Coverage = z.infer<typeof coverageSchema>
