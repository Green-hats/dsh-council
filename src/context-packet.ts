import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  CONTEXT_LIMITS,
  answerCorpusSchema,
  answerPayloadSchema,
  arbiterPayloadSchema,
  contextAttachmentSchema,
  contextCandidateSchema,
  contextOmissionSchema,
  contextPacketSchema,
  packetRecordSchema,
  providerRouteSchema,
  providerSetSchema,
  reviewCorpusSchema,
  reviewPayloadSchema,
  sha256Schema,
  sourceAliasSchema,
  stageMaterialSchema,
  type AnswerCorpus,
  type ContextAttachment,
  type ContextCandidate,
  type ContextOmission,
  type ContextPacket,
  type PacketRecord,
  type PrivateSourceRef,
  type ProviderRoute,
  type ReviewCorpus,
  type StageMaterial,
} from './context-types.js'
import type { AnswerRecord, ReviewRecord } from './types.js'

/** Canonical JSON v1: lexicographic UTF-16 key order, ordered arrays, unchanged strings. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>()
  const encode = (current: unknown, depth: number): string => {
    if (depth > 128) throw new TypeError('Canonical JSON nesting limit exceeded')
    if (current === null) return 'null'
    if (typeof current === 'string' || typeof current === 'boolean') return JSON.stringify(current)
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new TypeError('Canonical JSON requires finite numbers')
      return JSON.stringify(current)
    }
    if (typeof current !== 'object') throw new TypeError('Canonical JSON requires JSON values')
    if (ancestors.has(current)) throw new TypeError('Canonical JSON cannot contain cycles')
    ancestors.add(current)
    try {
      if (Array.isArray(current)) {
        const keys = Reflect.ownKeys(current)
        if (keys.length !== current.length + 1) throw new TypeError('Canonical JSON requires dense arrays without extra properties')
        const values: string[] = []
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index))
          if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
            throw new TypeError('Canonical JSON rejects sparse arrays and accessors')
          }
          values.push(encode(descriptor.value, depth + 1))
        }
        return `[${values.join(',')}]`
      }
      const prototype: unknown = Object.getPrototypeOf(current)
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Canonical JSON requires plain objects')
      const keys = Reflect.ownKeys(current)
      if (keys.some(key => typeof key !== 'string')) throw new TypeError('Canonical JSON rejects symbol keys')
      const properties = (keys as string[]).sort().map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(current, key)
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
          throw new TypeError('Canonical JSON rejects accessors and hidden properties')
        }
        return `${JSON.stringify(key)}:${encode(descriptor.value, depth + 1)}`
      })
      return `{${properties.join(',')}}`
    } finally {
      ancestors.delete(current)
    }
  }
  return encode(value, 0)
}

/** Text hashes use its exact UTF-8 bytes, not whitespace or Unicode normalization. */
export function hashText(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}
export function sha256Canonical(value: unknown): string {
  return hashText(canonicalJson(value))
}

function freezeTree<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freezeTree(child)
    Object.freeze(value)
  }
  return value
}

/** Accept only a public DTO. Passing a PacketRecord or hidden metadata fails closed. */
export function serializePublicPacket(packet: ContextPacket): string {
  return canonicalJson(contextPacketSchema.parse(packet))
}

/** Sort by exact provider then model code units; never locale-sort or normalize route strings. */
export function normalizeProviderSet(routes: readonly ProviderRoute[]): ProviderRoute[] {
  if (routes.length < 1 || routes.length > CONTEXT_LIMITS.maxRoutes) throw new Error('Invalid provider route count')
  const parsed = routes.map(route => providerRouteSchema.parse(route))
  const byKey = new Map(parsed.map(route => [canonicalJson(route), route]))
  const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0
  return providerSetSchema.parse([...byKey.values()].sort((left, right) => compare(left.provider, right.provider) || compare(left.model, right.model)))
}

export function computeExportHash(packetHash: string, providerSet: readonly ProviderRoute[]): string {
  return sha256Canonical({ mode: 'chat', packetHash: sha256Schema.parse(packetHash), providerSet: normalizeProviderSet(providerSet), webAllowed: false })
}

const boundedLimit = (maximum: number) => z.number().int().min(1).max(maximum)
const compileInputSchema = z.strictObject({
  topicOriginal: z.string(),
  candidates: z.array(contextCandidateSchema).max(CONTEXT_LIMITS.maxSources),
  selectedAliases: z.array(sourceAliasSchema).max(CONTEXT_LIMITS.maxSources)
    .refine(value => new Set(value).size === value.length, 'Duplicate selection alias'),
  omissions: z.array(contextOmissionSchema).max(CONTEXT_LIMITS.maxOmissions).default([]),
  attachments: z.array(contextAttachmentSchema).max(CONTEXT_LIMITS.maxAttachments).default([]),
  maxSources: boundedLimit(CONTEXT_LIMITS.maxSources).default(CONTEXT_LIMITS.maxSources),
  maxCandidateBytes: boundedLimit(CONTEXT_LIMITS.candidateMaxBytes).default(CONTEXT_LIMITS.candidateMaxBytes),
  maxPacketBytes: boundedLimit(CONTEXT_LIMITS.packetMaxBytes).default(CONTEXT_LIMITS.packetMaxBytes),
})
export interface CompileContextPacketInput {
  readonly topicOriginal: string
  readonly candidates: readonly ContextCandidate[]
  readonly selectedAliases: readonly string[]
  readonly omissions?: readonly ContextOmission[]
  readonly attachments?: readonly ContextAttachment[]
  readonly maxSources?: number
  readonly maxCandidateBytes?: number
  readonly maxPacketBytes?: number
}
export interface CompiledContextPacket {
  readonly packet: ContextPacket
  readonly packetHash: string
  readonly privateSources: PrivateSourceRef[]
}

/** Select exact aliases, retain capture order, validate provenance, and freeze the detached DTOs. */
export function compileContextPacket(input: CompileContextPacketInput): CompiledContextPacket {
  const parsed = compileInputSchema.parse(input)
  if (parsed.candidates.length > parsed.maxSources
    || Buffer.byteLength(canonicalJson(parsed.candidates), 'utf8') > parsed.maxCandidateBytes) {
    throw new Error('CONTEXT_TOO_LARGE: captured candidates exceed the configured limit')
  }
  const aliases = parsed.candidates.map(candidate => candidate.source.alias)
  if (new Set(aliases).size !== aliases.length) throw new Error('Duplicate candidate alias')
  const parents = new Set(parsed.candidates.map(candidate => candidate.privateRef.parentSessionId))
  if (parents.size > 1) throw new Error('Candidate sources cannot cross parent sessions')
  const positions = parsed.candidates.map(candidate => canonicalJson([
    candidate.privateRef.parentSessionId, candidate.privateRef.messageId, candidate.privateRef.blockIndex,
  ]))
  if (new Set(positions).size !== positions.length) throw new Error('Duplicate candidate position')
  for (const candidate of parsed.candidates) {
    if (candidate.privateRef.textHash !== hashText(candidate.source.text)) throw new Error('Candidate text hash mismatch')
  }
  if (parsed.selectedAliases.some(alias => !aliases.includes(alias))) throw new Error('Unknown selection alias')
  const selected = new Set(parsed.selectedAliases)
  const candidates = parsed.candidates.filter(candidate => selected.has(candidate.source.alias))
  const packet = contextPacketSchema.parse({
    version: 1,
    topicOriginal: parsed.topicOriginal,
    sources: candidates.map(candidate => candidate.source),
    omissions: parsed.omissions,
    attachments: parsed.attachments,
  })
  const serialized = serializePublicPacket(packet)
  if (Buffer.byteLength(serialized, 'utf8') > parsed.maxPacketBytes) {
    throw new Error('CONTEXT_TOO_LARGE: selected public packet exceeds its byte limit')
  }
  return freezeTree({ packet, packetHash: hashText(serialized), privateSources: candidates.map(candidate => candidate.privateRef) })
}

export interface CreatePacketRecordInput extends CompiledContextPacket {
  readonly runId: string
  readonly capturedThroughSeq: number
  readonly pendingPolicy: PacketRecord['pendingPolicy']
  readonly providerSet: readonly ProviderRoute[]
}

/** Persist only after the caller has obtained consent to this exact exportHash. */
export function createPacketRecord(input: CreatePacketRecordInput): PacketRecord {
  const providerSet = normalizeProviderSet(input.providerSet)
  return validatePacketRecord({
    version: 2,
    runId: input.runId,
    capturedThroughSeq: input.capturedThroughSeq,
    pendingPolicy: input.pendingPolicy,
    packet: input.packet,
    packetHash: input.packetHash,
    privateSources: input.privateSources,
    consent: {
      exportHash: computeExportHash(input.packetHash, providerSet),
      providerSet,
      selectedAliases: input.packet.sources.map(source => source.alias),
      webAllowed: false,
    },
    compilerVersion: 1,
  })
}

/** Structural schemas are necessary but persisted hashes must also be recomputed. */
export function validatePacketRecord(value: unknown): PacketRecord {
  const record = packetRecordSchema.parse(value)
  if (record.packetHash !== sha256Canonical(record.packet)) throw new Error('Packet hash mismatch')
  if (record.consent.exportHash !== computeExportHash(record.packetHash, record.consent.providerSet)) throw new Error('Consent export hash mismatch')
  if (canonicalJson(record.consent.providerSet) !== canonicalJson(normalizeProviderSet(record.consent.providerSet))) throw new Error('Provider set must be canonical')
  for (const source of record.packet.sources) {
    const reference = record.privateSources.find(candidate => candidate.alias === source.alias)
    if (reference?.textHash !== hashText(source.text)) throw new Error('Private source text hash mismatch')
  }
  return freezeTree(record)
}

/** Deliberately project records rather than serializing model routes or child metadata. */
export function createAnswerCorpus(answers: readonly Pick<AnswerRecord, 'answerId' | 'text'>[]): AnswerCorpus {
  return freezeTree(answerCorpusSchema.parse({ version: 1, answers: answers.map(answer => ({ id: answer.answerId, text: answer.text })) }))
}
export function createReviewCorpus(reviews: readonly Pick<ReviewRecord, 'reviewId' | 'output'>[]): ReviewCorpus {
  return freezeTree(reviewCorpusSchema.parse({ version: 1, reviews: reviews.map(review => ({ id: review.reviewId, output: review.output })) }))
}

export type CreateStageMaterialInput =
  | { readonly stage: 'answer'; readonly payload: z.input<typeof answerPayloadSchema> }
  | { readonly stage: 'review'; readonly payload: z.input<typeof reviewPayloadSchema> }
  | { readonly stage: 'arbiter'; readonly payload: z.input<typeof arbiterPayloadSchema> }

/** One immutable material per stage: hash only shared public evidence, not persona or route. */
export function createStageMaterial(input: CreateStageMaterialInput): StageMaterial {
  const payload = input.stage === 'answer' ? answerPayloadSchema.parse(input.payload)
    : input.stage === 'review' ? reviewPayloadSchema.parse(input.payload) : arbiterPayloadSchema.parse(input.payload)
  const shared = { stage: input.stage, packetHash: sha256Canonical(payload.packet), payloadHash: sha256Canonical(payload), payload }
  if (input.stage === 'answer') return validateStageMaterial(shared)
  if (!('answerCorpus' in payload)) throw new Error('Answer corpus is required')
  const withAnswers = { ...shared, answerCorpusHash: sha256Canonical(payload.answerCorpus) }
  if (input.stage === 'review') return validateStageMaterial(withAnswers)
  if (!('reviewCorpus' in payload)) throw new Error('Review corpus is required')
  return validateStageMaterial({ ...withAnswers, reviewCorpusHash: sha256Canonical(payload.reviewCorpus) })
}

export function validateStageMaterial(value: unknown): StageMaterial {
  const material = stageMaterialSchema.parse(value)
  if (material.packetHash !== sha256Canonical(material.payload.packet)) throw new Error('Stage packet hash mismatch')
  if (material.payloadHash !== sha256Canonical(material.payload)) throw new Error('Stage payload hash mismatch')
  if (material.stage !== 'answer' && material.answerCorpusHash !== sha256Canonical(material.payload.answerCorpus)) throw new Error('Answer corpus hash mismatch')
  if (material.stage === 'arbiter' && material.reviewCorpusHash !== sha256Canonical(material.payload.reviewCorpus)) throw new Error('Review corpus hash mismatch')
  return freezeTree(material)
}
