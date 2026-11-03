import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { canonicalJson, hashText, sha256Canonical, validatePacketRecord, validateStageMaterial } from './context-packet.js'
import { CONTEXT_LIMITS, modelReturnSchema, packetRecordSchema, sha256Schema, stageMaterialSchema, type PacketRecord, type StageMaterial } from './context-types.js'
import { parseModelReturn, renderModelReturn } from './handoff.js'
import type { CouncilLocale } from './locales.js'
import type { CouncilChildPolicyV2 } from './child-policy.js'

const identifier = z.string().min(1).max(512).refine(value => value.trim() !== '')
const seqSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const stateBase = { version: z.literal(2), runId: identifier }
const terminalStatuses = z.enum(['HANDOFF_COMMITTED', 'SUCCEEDED'])
const failureStatuses = z.enum(['FAILED', 'CANCELED', 'INTERRUPTED'])

/** Mode and status together determine which references may or must exist. */
export const councilRunStateSchema = z.discriminatedUnion('mode', [
  z.discriminatedUnion('status', [
    z.strictObject({ ...stateBase, mode: z.literal('chat'), status: z.enum(['CREATED', 'CAPTURED', 'CONSENTED', 'PREPARING']), packetHash: sha256Schema.optional() }),
    z.strictObject({ ...stateBase, mode: z.literal('chat'), status: z.enum(['PACKET_COMMITTED', 'ANSWERING', 'REVIEWING', 'ARBITRATING']), packetHash: sha256Schema }),
    z.strictObject({ ...stateBase, mode: z.literal('chat'), status: terminalStatuses, packetHash: sha256Schema, terminalSeq: seqSchema }),
    z.strictObject({ ...stateBase, mode: z.literal('chat'), status: failureStatuses, packetHash: sha256Schema.optional(), terminalSeq: seqSchema.optional() }),
  ]),
  z.discriminatedUnion('status', [
    z.strictObject({ ...stateBase, mode: z.literal('topic-only'), status: z.enum(['CREATED', 'PREPARING', 'ANSWERING', 'REVIEWING', 'ARBITRATING']) }),
    z.strictObject({ ...stateBase, mode: z.literal('topic-only'), status: terminalStatuses, terminalSeq: seqSchema }),
    z.strictObject({ ...stateBase, mode: z.literal('topic-only'), status: failureStatuses, terminalSeq: seqSchema.optional() }),
  ]),
])
export type CouncilRunState = z.infer<typeof councilRunStateSchema>

const presentationSchema = z.strictObject({
  answerMarkdown: z.string().max(65_536),
  auditMarkdown: z.string().max(1_048_576),
})
const resultBase = {
  version: z.literal(2), commandId: identifier, runId: identifier, parentSessionId: identifier,
  mode: z.enum(['chat', 'topic-only']), locale: z.enum(['en', 'zh']), presentation: presentationSchema.optional(),
}
export const councilResultV2Schema = z.discriminatedUnion('status', [
  z.strictObject({ ...resultBase, status: z.literal('success'), modelReturn: modelReturnSchema }),
  z.strictObject({ ...resultBase, status: z.enum(['error', 'canceled']) }),
]).superRefine((value, ctx) => {
  if (value.commandId !== value.runId) ctx.addIssue({ code: 'custom', path: ['commandId'], message: 'Command and run identities must match' })
  if (value.status !== 'success') return
  if (value.modelReturn.runId !== value.runId) ctx.addIssue({ code: 'custom', path: ['modelReturn', 'runId'], message: 'Result run identity mismatch' })
  if ((value.mode === 'chat') !== (value.modelReturn.packetHash !== undefined)) ctx.addIssue({ code: 'custom', path: ['modelReturn', 'packetHash'], message: 'Packet identity must match the context mode' })
  if (value.presentation !== undefined && value.presentation.answerMarkdown !== value.modelReturn.answerMarkdown) {
    ctx.addIssue({ code: 'custom', path: ['presentation', 'answerMarkdown'], message: 'Presentation cannot replace the canonical answer' })
  }
})
export type CouncilResultV2 = z.infer<typeof councilResultV2Schema>

const recordBase = { version: z.literal(2), runId: identifier, parentSessionId: identifier }
const childBindingFields = { childId: identifier, policyVersion: z.literal(2), policyHash: sha256Schema }
/** Independent ownership evidence; never duplicates the full child policy or its persona. */
export const councilChildBindingSchema = z.discriminatedUnion('mode', [
  z.strictObject({ ...recordBase, ...childBindingFields, mode: z.literal('chat'), packetHash: sha256Schema }),
  z.strictObject({ ...recordBase, ...childBindingFields, mode: z.literal('topic-only') }),
]).refine(value => value.childId !== value.parentSessionId, 'A parent cannot bind itself as a child')
export type CouncilChildBinding = z.infer<typeof councilChildBindingSchema>
export const councilRunRecordSchema = z.discriminatedUnion('recordKind', [
  z.strictObject({ ...recordBase, recordKind: z.literal('packet'), packet: packetRecordSchema }),
  z.strictObject({ ...recordBase, recordKind: z.literal('material'), material: stageMaterialSchema }),
  z.strictObject({ ...recordBase, recordKind: z.literal('state'), state: councilRunStateSchema }),
  z.strictObject({ ...recordBase, ...childBindingFields, recordKind: z.literal('child-binding'),
    mode: z.enum(['chat', 'topic-only']), packetHash: sha256Schema.optional() }),
]).superRefine((value, ctx) => {
  if (value.recordKind === 'child-binding') {
    const { recordKind: _kind, ...binding } = value
    if (!councilChildBindingSchema.safeParse(binding).success) ctx.addIssue({ code: 'custom', message: 'Invalid child ownership binding' })
  }
  if (value.recordKind === 'packet' && value.packet.runId !== value.runId) ctx.addIssue({ code: 'custom', message: 'Packet run mismatch' })
  if (value.recordKind === 'state' && value.state.runId !== value.runId) ctx.addIssue({ code: 'custom', message: 'State run mismatch' })
})
export type CouncilRunRecord = z.infer<typeof councilRunRecordSchema>

const storedPacketSchema = z.strictObject({ record: packetRecordSchema, sourceEventSeq: seqSchema })
const storedMaterialSchema = z.strictObject({ material: stageMaterialSchema, sourceEventSeq: seqSchema })
const TERMINAL_TEXT_MAX_BYTES = CONTEXT_LIMITS.modelReturnMaxBytes + 8_192
const terminalTextSchema = z.string().min(1).max(TERMINAL_TEXT_MAX_BYTES)
  .refine(value => value.trim() !== '' && Buffer.byteLength(value, 'utf8') <= TERMINAL_TEXT_MAX_BYTES, 'Terminal text exceeds its UTF-8 byte ceiling')
const storedTerminalSchema = z.strictObject({
  result: councilResultV2Schema, sourceEventSeq: seqSchema, text: terminalTextSchema, textHash: sha256Schema, resultHash: sha256Schema,
})
const runEntrySchema = z.strictObject({
  runId: identifier,
  mode: z.enum(['chat', 'topic-only']),
  state: councilRunStateSchema,
  stateSeq: seqSchema,
  packet: storedPacketSchema.optional(),
  materials: z.array(storedMaterialSchema).max(3),
  childBindings: z.array(councilChildBindingSchema).max(17),
  terminal: storedTerminalSchema.optional(),
  records: z.array(z.strictObject({ hash: sha256Schema, sourceEventSeq: seqSchema })).max(32),
})
type CouncilRunRecordEntry = z.infer<typeof runEntrySchema>
export type CouncilRunRecordView = Omit<CouncilRunRecordEntry, 'terminal'> & {
  readonly terminal?: Omit<NonNullable<CouncilRunRecordEntry['terminal']>, 'sourceEventSeq'> & { readonly sourceEventSeq: SessionSeq }
}
const projectionStateSchema = z.strictObject({
  parentSessionId: identifier,
  inheritedCount: seqSchema,
  runs: z.array(runEntrySchema).max(10_000),
  bad: z.boolean(),
})
export type CouncilRunRecordsState = z.infer<typeof projectionStateSchema>

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap { 'dsh-council:run-records': CouncilRunRecordsState }
}
export const COUNCIL_RUN_RECORDS_KEY = 'dsh-council:run-records'
const RECORD_ERROR = 'dsh-council: invalid persisted run record'
const order = ['CREATED', 'CAPTURED', 'CONSENTED', 'PREPARING', 'PACKET_COMMITTED', 'ANSWERING', 'REVIEWING', 'ARBITRATING', 'HANDOFF_COMMITTED', 'SUCCEEDED'] as const
const isStopped = (state: CouncilRunState): boolean => ['SUCCEEDED', 'FAILED', 'CANCELED', 'INTERRUPTED'].includes(state.status)
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function freezeTree<T>(value: T): T {
  if (typeof value === 'object' && value !== null) { Object.values(value).forEach(freezeTree); Object.freeze(value) }
  return value
}
function publicPacketHash(state: CouncilRunState): string | undefined { return 'packetHash' in state ? state.packetHash : undefined }
function terminalSeq(state: CouncilRunState): number | undefined { return 'terminalSeq' in state ? state.terminalSeq : undefined }
function withRun(state: CouncilRunRecordsState, entry: CouncilRunRecordEntry): CouncilRunRecordsState {
  const found = state.runs.some(run => run.runId === entry.runId)
  if (!found && state.runs.length >= 10_000) throw new Error(RECORD_ERROR)
  return { ...state, runs: found ? state.runs.map(run => run.runId === entry.runId ? entry : run) : [...state.runs, entry] }
}
function initialEntry(runState: CouncilRunState, seq: number): CouncilRunRecordEntry {
  if (runState.status !== 'CREATED') throw new Error(RECORD_ERROR)
  return { runId: runState.runId, mode: runState.mode, state: runState, stateSeq: seq, materials: [], childBindings: [], records: [] }
}
function checkState(entry: CouncilRunRecordEntry, state: CouncilRunState): void {
  if (entry.runId !== state.runId) throw new Error(RECORD_ERROR)
  // Explicit user-approved fallback before any packet was exported. Never reverse it.
  if (entry.mode === 'chat' && state.mode === 'topic-only' && state.status === 'CREATED'
    && entry.packet === undefined && entry.materials.length === 0 && entry.childBindings.length === 0 && entry.terminal === undefined
    && ['CREATED', 'CAPTURED', 'CONSENTED', 'PREPARING'].includes(entry.state.status)) return
  if (entry.mode !== state.mode) throw new Error(RECORD_ERROR)
  const hash = publicPacketHash(state)
  if (hash !== undefined && hash !== entry.packet?.record.packetHash) throw new Error(RECORD_ERROR)
  if (entry.packet !== undefined && hash !== entry.packet.record.packetHash) throw new Error(RECORD_ERROR)
  const reference = terminalSeq(state)
  if (reference !== undefined && reference !== entry.terminal?.sourceEventSeq) throw new Error(RECORD_ERROR)
  if (state.status === 'HANDOFF_COMMITTED' || state.status === 'SUCCEEDED') {
    if (entry.terminal?.result.status !== 'success') throw new Error(RECORD_ERROR)
  }
  if (entry.terminal !== undefined) {
    const expected = entry.terminal.result.status === 'success' ? ['HANDOFF_COMMITTED', 'SUCCEEDED']
      : entry.terminal.result.status === 'error' ? ['FAILED'] : ['CANCELED']
    if (!expected.includes(state.status)) throw new Error(RECORD_ERROR)
  } else if (isStopped(entry.state)) throw new Error(RECORD_ERROR)
  const before = order.indexOf(entry.state.status as typeof order[number])
  const after = order.indexOf(state.status as typeof order[number])
  if (after >= 0 && before >= 0 && after < before) throw new Error(RECORD_ERROR)
}

function acceptRecord(state: CouncilRunRecordsState, value: CouncilRunRecord, seq: number): CouncilRunRecordsState {
  if (value.parentSessionId !== state.parentSessionId) throw new Error(RECORD_ERROR)
  const hash = sha256Canonical(value)
  let entry = state.runs.find(run => run.runId === value.runId)
  if (entry?.records.some(item => item.hash === hash)) return state
  if (entry === undefined) {
    if (value.recordKind !== 'state') throw new Error(RECORD_ERROR)
    entry = initialEntry(value.state, seq)
  }
  if (entry.terminal !== undefined || isStopped(entry.state)) throw new Error(RECORD_ERROR)
  if (entry.records.length >= 32) throw new Error(RECORD_ERROR)
  let next = entry
  if (value.recordKind === 'state') {
    checkState(entry, value.state)
    next = { ...entry, mode: value.state.mode, state: value.state, stateSeq: seq }
  } else if (value.recordKind === 'packet') {
    const packet = validatePacketRecord(value.packet)
    if (entry.mode !== 'chat' || entry.packet !== undefined
      || packet.privateSources.some(source => source.parentSessionId !== state.parentSessionId)) throw new Error(RECORD_ERROR)
    if (order.indexOf(entry.state.status as typeof order[number]) > order.indexOf('PACKET_COMMITTED')) throw new Error(RECORD_ERROR)
    next = { ...entry, packet: { record: packet, sourceEventSeq: seq }, stateSeq: seq,
      state: { version: 2, runId: entry.runId, mode: 'chat', status: 'PACKET_COMMITTED', packetHash: packet.packetHash } }
  } else if (value.recordKind === 'child-binding') {
    const { recordKind: _kind, ...fields } = value
    const binding = councilChildBindingSchema.parse(fields)
    if (binding.mode !== entry.mode || entry.childBindings.length >= 17
      || state.runs.some(run => run.childBindings.some(existing => existing.childId === binding.childId))) throw new Error(RECORD_ERROR)
    if (binding.mode === 'chat' && binding.packetHash !== entry.packet?.record.packetHash) throw new Error(RECORD_ERROR)
    next = { ...entry, childBindings: [...entry.childBindings, binding] }
  } else {
    const material = validateStageMaterial(value.material)
    if (entry.mode !== 'chat' || entry.packet?.record.packetHash !== material.packetHash) throw new Error(RECORD_ERROR)
    if (entry.materials.some(item => item.material.stage === material.stage)) throw new Error(RECORD_ERROR)
    const preceding = { answer: 0, review: 1, arbiter: 2 }[material.stage]
    if (entry.materials.length !== preceding) throw new Error(RECORD_ERROR)
    const reviewed = entry.materials.find(item => item.material.stage === 'review')?.material
    if (material.stage === 'arbiter' && (reviewed?.stage !== 'review' || reviewed.answerCorpusHash !== material.answerCorpusHash)) throw new Error(RECORD_ERROR)
    const stageStatus = { answer: 'ANSWERING', review: 'REVIEWING', arbiter: 'ARBITRATING' } as const
    next = { ...entry, materials: [...entry.materials, { material, sourceEventSeq: seq }], stateSeq: seq,
      state: { version: 2, runId: entry.runId, mode: 'chat', status: stageStatus[material.stage], packetHash: material.packetHash } }
  }
  return withRun(state, { ...next, records: [...entry.records, { hash, sourceEventSeq: seq }] })
}

function resultTextMatches(value: CouncilResultV2, text: string): boolean {
  return value.status !== 'success' || text === renderModelReturn(value.modelReturn, value.locale)
}
function acceptTerminal(state: CouncilRunRecordsState, result: CouncilResultV2, text: string, seq: number): CouncilRunRecordsState {
  if (!terminalTextSchema.safeParse(text).success || (result.status !== 'success' && Buffer.byteLength(text, 'utf8') > 65_536)
    || result.parentSessionId !== state.parentSessionId || !resultTextMatches(result, text)) throw new Error(RECORD_ERROR)
  const entry = state.runs.find(run => run.runId === result.runId)
  if (entry === undefined || entry.mode !== result.mode) throw new Error(RECORD_ERROR)
  const textHash = hashText(text)
  const resultHash = sha256Canonical(result)
  if (entry.terminal !== undefined) {
    if (entry.terminal.resultHash === resultHash && entry.terminal.textHash === textHash) return state
    throw new Error(RECORD_ERROR)
  }
  if (isStopped(entry.state)) throw new Error(RECORD_ERROR)
  if (result.status === 'success') {
    const aliases = entry.packet?.record.packet.sources.map(source => source.alias) ?? []
    if (parseModelReturn(result.modelReturn, aliases) === undefined
      || result.modelReturn.packetHash !== entry.packet?.record.packetHash) throw new Error(RECORD_ERROR)
  }
  const hash = entry.packet?.record.packetHash
  const status = result.status === 'success' ? 'SUCCEEDED' : result.status === 'error' ? 'FAILED' : 'CANCELED'
  const runState = councilRunStateSchema.parse({ version: 2, runId: entry.runId, mode: entry.mode, status,
    ...(hash === undefined ? {} : { packetHash: hash }), terminalSeq: seq })
  return withRun(state, { ...entry, terminal: { result, sourceEventSeq: seq, text, textHash, resultHash }, state: runState, stateSeq: seq })
}

/** Pure fold over legal producer records; it never reconstructs or reinserts pending messages. */
function acceptMessage(state: CouncilRunRecordsState, message: unknown, seq: number): CouncilRunRecordsState {
  if (!record(message) || !record(message.source) || message.source.kind !== 'dsh-council') return state
  const source = message.source
  const isRunRecord = Object.hasOwn(source, 'runRecord')
  const isResult = Object.hasOwn(source, 'result')
  if (!isRunRecord && !isResult) return state
  if (isResult && !isRunRecord && record(source.result) && source.result.version === 1) return state
  try {
    if (message.role !== 'user' || !Array.isArray(message.content)
      || Object.keys(source).some(key => !['kind', isRunRecord ? 'runRecord' : 'result'].includes(key))) throw new Error(RECORD_ERROR)
    if (isRunRecord) {
      if (message.content.length !== 0) throw new Error(RECORD_ERROR)
      return acceptRecord(state, councilRunRecordSchema.parse(source.runRecord), seq)
    }
    if (message.content.length !== 1) throw new Error(RECORD_ERROR)
    const block: unknown = message.content[0]
    if (!record(block) || block.type !== 'text' || typeof block.text !== 'string' || block.text.trim() === ''
      || Buffer.byteLength(block.text, 'utf8') > 524_288 || Object.keys(block).some(key => !['type', 'text'].includes(key))) throw new Error(RECORD_ERROR)
    return acceptTerminal(state, councilResultV2Schema.parse(source.result), block.text, seq)
  } catch {
    return { ...state, bad: true }
  }
}

const projection: ProjectionDefinition<typeof COUNCIL_RUN_RECORDS_KEY> = {
  key: COUNCIL_RUN_RECORDS_KEY,
  stateVersion: 3,
  stateSchema: projectionStateSchema,
  init: (header, inheritedCount) => ({ parentSessionId: String(header.id), inheritedCount: Number(inheritedCount), runs: [], bad: false }),
  apply(state, event) {
    if (state.bad || Number(event.seq) < state.inheritedCount) return state
    if (event.type === 'user/message') return acceptMessage(state, event.data, Number(event.seq))
    if (event.type !== 'agent/inbox/spliced' || !Array.isArray(event.data.inserted)) return state
    let next = state
    for (const message of event.data.inserted) { next = acceptMessage(next, message, Number(event.seq)); if (next.bad) break }
    return next
  },
}

export function registerCouncilRunRecords(ctx: Context): void { ctx.sessionProjections.register(projection) }
type RecordParent = Pick<Agent, 'session' | 'inject'>
function readState(ctx: Context, parent: Pick<Agent, 'session'>): CouncilRunRecordsState {
  const state = ctx.sessionProjections.stateOf(parent.session, COUNCIL_RUN_RECORDS_KEY)
  if (state === undefined) throw new Error('dsh-council: run records projection unavailable')
  if (state.bad || state.parentSessionId !== String(parent.session.id)) throw new Error(RECORD_ERROR)
  return state
}
export function readCouncilRunRecord(ctx: Context, parent: Pick<Agent, 'session'>, runId: string): CouncilRunRecordView | undefined {
  identifier.parse(runId)
  const entry = readState(ctx, parent).runs.find(run => run.runId === runId)
  if (entry === undefined) return undefined
  if (entry.packet !== undefined) validatePacketRecord(entry.packet.record)
  entry.materials.forEach(item => validateStageMaterial(item.material))
  if (entry.terminal !== undefined && (entry.terminal.resultHash !== sha256Canonical(entry.terminal.result)
    || entry.terminal.textHash !== hashText(entry.terminal.text)
    || !resultTextMatches(entry.terminal.result, entry.terminal.text))) throw new Error(RECORD_ERROR)
  // The number was schema-validated and originates from the committed Session event.
  return freezeTree(structuredClone(entry)) as CouncilRunRecordView
}

/** Read a public registry-restored Host checkpoint, never a Client wire projection. */
export function findChildBindingInState(value: unknown, parentSessionId: string, childId: string): CouncilChildBinding | undefined {
  identifier.parse(parentSessionId)
  identifier.parse(childId)
  const state = projectionStateSchema.parse(value)
  if (state.bad || state.parentSessionId !== parentSessionId) throw new Error(RECORD_ERROR)
  const seen = new Set<string>()
  let found: CouncilChildBinding | undefined
  for (const run of state.runs) {
    if (run.runId !== run.state.runId || run.mode !== run.state.mode) throw new Error(RECORD_ERROR)
    for (const binding of run.childBindings) {
      if (seen.has(binding.childId) || binding.parentSessionId !== parentSessionId || binding.runId !== run.runId
        || binding.mode !== run.mode || (binding.mode === 'chat' && binding.packetHash !== run.packet?.record.packetHash)) throw new Error(RECORD_ERROR)
      seen.add(binding.childId)
      if (binding.childId === childId) found = binding
    }
  }
  return found === undefined ? undefined : freezeTree(structuredClone(found))
}
export function findCouncilChildBinding(ctx: Context, parent: Pick<Agent, 'session'>, childId: string): CouncilChildBinding | undefined {
  return findChildBindingInState(readState(ctx, parent), String(parent.session.id), childId)
}

/** Only strict, empty domain records qualify for the parent's pre-step marker filter. */
export function isCouncilRunRecordMarker(value: unknown): boolean {
  if (!record(value) || value.role !== 'user' || !Array.isArray(value.content) || value.content.length !== 0
    || !record(value.source) || value.source.kind !== 'dsh-council'
    || Object.keys(value.source).some(key => !['kind', 'runRecord'].includes(key))) return false
  const parsed = councilRunRecordSchema.safeParse(value.source.runRecord)
  if (!parsed.success) return false
  try {
    if (parsed.data.recordKind === 'packet') validatePacketRecord(parsed.data.packet)
    if (parsed.data.recordKind === 'material') validateStageMaterial(parsed.data.material)
    return true
  } catch { return false }
}

/** Synchronous writers read the authoritative projection again before each durable injection. */
export function createRunRecords(ctx: Context, parent: RecordParent) {
  const parentSessionId = String(parent.session.id)
  const read = (runId: string) => readCouncilRunRecord(ctx, parent, runId)
  const inject = (message: UserMessage): SessionSeq => {
    const seq = Number(parent.session.seq) as SessionSeq
    parent.inject(message)
    const event = parent.session.eventAt(seq)
    if (event?.type !== 'agent/inbox/spliced' || !event.data.inserted.some(item => item.id === message.id)) {
      throw new Error('dsh-council: producer commit outcome is unknown; do not retry automatically')
    }
    readState(ctx, parent)
    return seq
  }
  const commitRecord = (value: CouncilRunRecord): SessionSeq => {
    const parsed = councilRunRecordSchema.parse(value)
    const state = readState(ctx, parent)
    const hash = sha256Canonical(parsed)
    const existing = state.runs.find(run => run.runId === parsed.runId)?.records.find(item => item.hash === hash)
    if (existing !== undefined) return existing.sourceEventSeq as SessionSeq
    // Validate the complete proposed fold before committing anything.
    acceptRecord(state, parsed, Number(parent.session.seq))
    const source = { kind: 'dsh-council', runRecord: parsed } as unknown as UserMessage['source']
    return inject(createUserMessage({ content: [], source }))
  }
  return {
    read,
    findChildBinding: (childId: string) => findCouncilChildBinding(ctx, parent, childId),
    /** The caller must first validate the full DTO with councilChildPolicyV2Schema. */
    commitChildBinding(runId: string, policy: CouncilChildPolicyV2): SessionSeq {
      if (policy.version !== 2 || policy.policyVersion !== 2 || policy.runId !== runId || policy.parentId !== parentSessionId) throw new Error(RECORD_ERROR)
      const entry = read(runId)
      if (entry === undefined || entry.mode !== policy.mode) throw new Error(RECORD_ERROR)
      if (policy.mode === 'chat' && (entry.packet?.record.packetHash !== policy.packetHash
        || !entry.packet.record.consent.providerSet.some(route => route.provider === policy.approvedRoute.provider && route.model === policy.approvedRoute.model))) throw new Error(RECORD_ERROR)
      const binding = councilChildBindingSchema.parse({ version: 2, runId, parentSessionId, childId: policy.childId,
        mode: policy.mode, policyVersion: 2, policyHash: sha256Canonical(policy),
        ...(policy.mode === 'chat' ? { packetHash: policy.packetHash } : {}) })
      return commitRecord({ ...binding, recordKind: 'child-binding' })
    },
    transition(state: CouncilRunState): SessionSeq {
      return commitRecord({ version: 2, runId: state.runId, parentSessionId, recordKind: 'state', state })
    },
    commitPacket(packet: PacketRecord): SessionSeq {
      return commitRecord({ version: 2, runId: packet.runId, parentSessionId, recordKind: 'packet', packet })
    },
    commitMaterial(runId: string, material: StageMaterial): SessionSeq {
      return commitRecord({ version: 2, runId, parentSessionId, recordKind: 'material', material })
    },
    commitTerminal(value: CouncilResultV2, text: string, locale?: CouncilLocale): SessionSeq {
      const result = councilResultV2Schema.parse(value)
      if (result.parentSessionId !== parentSessionId) throw new Error(RECORD_ERROR)
      const state = readState(ctx, parent)
      const run = state.runs.find(entry => entry.runId === result.runId)
      if (run !== undefined && run.mode !== result.mode) throw new Error(RECORD_ERROR)
      const existing = run?.terminal
      // A committed terminal wins over late cancellation or late child completion.
      if (existing !== undefined) return existing.sourceEventSeq as SessionSeq
      if (locale !== undefined && locale !== result.locale) throw new Error('dsh-council: terminal locale differs from result')
      if (result.status === 'success' && text !== renderModelReturn(result.modelReturn, result.locale)) throw new Error('dsh-council: terminal text differs from ModelReturn')
      terminalTextSchema.parse(text)
      acceptTerminal(state, result, text, Number(parent.session.seq))
      const source = { kind: 'dsh-council', result } as unknown as UserMessage['source']
      return inject(createUserMessage({ content: [{ type: 'text', text }], source }))
    },
  }
}
export type CouncilRunRecords = ReturnType<typeof createRunRecords>
