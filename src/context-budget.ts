import { createHash } from 'node:crypto'
import type { CouncilSelection, CouncilStage, ModelRef } from './types.js'

const MAX_INTEGER = Number.MAX_SAFE_INTEGER
const MAX_TIMEOUT = 2_147_483_647

export interface ContextConfig {
  readonly contextMode: 'chat' | 'topic-only'
  readonly contextCaptureAttempts: number
  readonly contextCaptureTimeoutMs: number
  readonly contextPreparationTimeoutMs: number
  readonly contextMaxSources: number
  readonly contextCandidateMaxBytes: number
  readonly contextPacketMaxBytes: number
  readonly contextMaxTokens: number
  readonly contextAnswerArtifactTokens: number
  readonly contextReviewArtifactTokens: number
  readonly contextArbiterOutputTokens: number
  readonly contextEnvelopeReserveTokens: number
  readonly contextSafetyMarginTokens: number
  readonly contextWindowOverrides: Readonly<Record<string, number>>
}

export const DEFAULT_CONTEXT_CONFIG: ContextConfig = Object.freeze({
  contextMode: 'chat',
  contextCaptureAttempts: 3,
  contextCaptureTimeoutMs: 5_000,
  contextPreparationTimeoutMs: 30_000,
  contextMaxSources: 64,
  contextCandidateMaxBytes: 524_288,
  contextPacketMaxBytes: 65_536,
  contextMaxTokens: 4_096,
  contextAnswerArtifactTokens: 2_048,
  contextReviewArtifactTokens: 2_048,
  contextArbiterOutputTokens: 4_096,
  contextEnvelopeReserveTokens: 8_192,
  contextSafetyMarginTokens: 2_048,
  contextWindowOverrides: Object.freeze({}),
})

export type ContextBudgetErrorCode =
  | 'INVALID_CONTEXT_CONFIG' | 'INVALID_CONTEXT_WINDOW' | 'UNKNOWN_CONTEXT_WINDOW'
  | 'INVALID_BUDGET' | 'INVALID_ESTIMATE' | 'ESTIMATOR_UNAVAILABLE'
  | 'CONTEXT_TOO_LARGE' | 'CONTEXT_BUDGET_EXCEEDED' | 'ARTIFACT_TOO_LARGE'
  | 'INVALID_REQUEST' | 'REQUEST_ROUTE_MISMATCH' | 'REQUEST_OUTPUT_EXCEEDED'
  | 'REQUEST_TOOL_DENIED' | 'REQUEST_MATERIAL_MISMATCH' | 'REQUEST_SESSION_MISMATCH'

export class ContextBudgetError extends Error {
  constructor(readonly code: ContextBudgetErrorCode, message: string) {
    super(`dsh-council: ${message}`)
    this.name = 'ContextBudgetError'
  }
}

function fail(code: ContextBudgetErrorCode, message: string): never {
  throw new ContextBudgetError(code, message)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function integer(value: unknown, name: string, minimum = 0, maximum = MAX_INTEGER,
  code: ContextBudgetErrorCode = 'INVALID_BUDGET'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(code, `${name} must be a safe integer in [${minimum}, ${maximum}]`)
  }
  return value
}

function sum(values: readonly number[], name: string): number {
  return integer(values.reduce((total, value) => total + integer(value, name), 0), name)
}

function exactKey(key: string): boolean {
  const slash = key.indexOf('/')
  return slash > 0 && slash < key.length - 1 && key === key.trim() && !/[\s*?\u0000-\u001f\u007f]/u.test(key)
}

function normalizeOverrides(value: unknown): Readonly<Record<string, number>> {
  if (!record(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Reflect.ownKeys(value).some(key => typeof key !== 'string')) {
    fail('INVALID_CONTEXT_CONFIG', 'contextWindowOverrides must be an exact-key record')
  }
  const entries = Object.entries(value).map(([key, window]): [string, number] => {
    if (!exactKey(key)) fail('INVALID_CONTEXT_CONFIG', `invalid exact model key: ${key}`)
    return [key, integer(window, `contextWindowOverrides[${key}]`, 1, MAX_INTEGER, 'INVALID_CONTEXT_CONFIG')]
  })
  return Object.freeze(Object.fromEntries(entries))
}

/** Accept omitted new fields on old Config fixtures; never mutate the caller. */
export function normalizeContextConfig(input: unknown = {}): ContextConfig {
  if (!record(input)) fail('INVALID_CONTEXT_CONFIG', 'context configuration must be an object')
  const mode = input.contextMode === undefined ? DEFAULT_CONTEXT_CONFIG.contextMode : input.contextMode
  if (mode !== 'chat' && mode !== 'topic-only') fail('INVALID_CONTEXT_CONFIG', 'contextMode must be chat or topic-only')
  const number = (key: Exclude<keyof ContextConfig, 'contextMode' | 'contextWindowOverrides'>,
    minimum = 1, maximum = MAX_INTEGER): number => integer(
    input[key] === undefined ? DEFAULT_CONTEXT_CONFIG[key] : input[key], key, minimum, maximum, 'INVALID_CONTEXT_CONFIG',
  )
  const config: ContextConfig = {
    contextMode: mode,
    contextCaptureAttempts: number('contextCaptureAttempts', 1, 3),
    contextCaptureTimeoutMs: number('contextCaptureTimeoutMs', 1, MAX_TIMEOUT),
    contextPreparationTimeoutMs: number('contextPreparationTimeoutMs', 1, MAX_TIMEOUT),
    contextMaxSources: number('contextMaxSources', 1, 64),
    contextCandidateMaxBytes: number('contextCandidateMaxBytes', 1, 524_288),
    contextPacketMaxBytes: number('contextPacketMaxBytes', 1, 65_536),
    contextMaxTokens: number('contextMaxTokens'),
    contextAnswerArtifactTokens: number('contextAnswerArtifactTokens'),
    contextReviewArtifactTokens: number('contextReviewArtifactTokens'),
    contextArbiterOutputTokens: number('contextArbiterOutputTokens'),
    contextEnvelopeReserveTokens: number('contextEnvelopeReserveTokens', 0),
    contextSafetyMarginTokens: number('contextSafetyMarginTokens', 0),
    contextWindowOverrides: normalizeOverrides(input.contextWindowOverrides === undefined ? {} : input.contextWindowOverrides),
  }
  if (config.contextPacketMaxBytes > config.contextCandidateMaxBytes) {
    fail('INVALID_CONTEXT_CONFIG', 'contextPacketMaxBytes must not exceed contextCandidateMaxBytes')
  }
  if (config.contextCaptureTimeoutMs > config.contextPreparationTimeoutMs) {
    fail('INVALID_CONTEXT_CONFIG', 'contextCaptureTimeoutMs must not exceed contextPreparationTimeoutMs')
  }
  // Reject overflowing planning arithmetic before any candidate or model work.
  const maximumEvidence = 8 * config.contextAnswerArtifactTokens + 8 * config.contextReviewArtifactTokens
  const maximumOutput = Math.max(config.contextAnswerArtifactTokens, config.contextReviewArtifactTokens, config.contextArbiterOutputTokens)
  const maximumPlan = config.contextMaxTokens + maximumEvidence + maximumOutput
    + config.contextEnvelopeReserveTokens + config.contextSafetyMarginTokens
  if (!Number.isSafeInteger(maximumPlan)) fail('INVALID_CONTEXT_CONFIG', 'context token budgets overflow safe integer arithmetic')
  return Object.freeze(config)
}

export type ContextModel = Pick<ModelRef, 'provider' | 'model' | 'key'>

function assertModel(model: ContextModel): void {
  if (!model || typeof model.provider !== 'string' || typeof model.model !== 'string'
    || typeof model.key !== 'string' || model.key !== `${model.provider}/${model.model}` || !exactKey(model.key)) {
    fail('INVALID_BUDGET', 'model must carry its exact provider/model key')
  }
}

/** resolvedInfo is the detached result of llm.resolveModelInfo, not a Service. */
export function resolveContextWindow(model: ContextModel, resolvedInfo: unknown,
  overrides: Readonly<Record<string, number>> = {}): number {
  assertModel(model)
  const normalized = normalizeOverrides(overrides)
  if (resolvedInfo !== undefined) {
    if (!record(resolvedInfo) || resolvedInfo.provider !== model.provider || resolvedInfo.id !== model.model) {
      fail('INVALID_CONTEXT_WINDOW', `resolved model identity does not match ${model.key}`)
    }
    if (resolvedInfo.context !== undefined) {
      if (!record(resolvedInfo.context)) fail('INVALID_CONTEXT_WINDOW', `invalid context metadata for ${model.key}`)
      if (resolvedInfo.context.contextWindow !== undefined) {
        return integer(resolvedInfo.context.contextWindow, `${model.key} contextWindow`, 1, MAX_INTEGER, 'INVALID_CONTEXT_WINDOW')
      }
    }
  }
  if (Object.hasOwn(normalized, model.key)) return normalized[model.key] as number
  return fail('UNKNOWN_CONTEXT_WINDOW', `unknown context window for ${model.key}; an exact-key override is required`)
}

/** Minimal read-only face shared by old Message and modern RequestUserInput. */
export interface BudgetMessage {
  readonly role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'
  readonly content: readonly unknown[]
}

/** The entry point adapts this face to tokenMeter. No character/token fallback. */
export interface ContextTokenEstimator {
  readonly version: string
  estimateMessage(message: BudgetMessage, model: ContextModel): number
}

function estimate(message: BudgetMessage, model: ContextModel, estimator: ContextTokenEstimator): number {
  if (!estimator || typeof estimator.estimateMessage !== 'function' || typeof estimator.version !== 'string' || !estimator.version.trim()) {
    fail('ESTIMATOR_UNAVAILABLE', 'a versioned message token estimator is required')
  }
  let value: number
  try {
    value = estimator.estimateMessage(message, model)
  } catch (error: unknown) {
    fail('ESTIMATOR_UNAVAILABLE', `token estimation failed${error instanceof Error ? `: ${error.message}` : ''}`)
  }
  return integer(value, 'estimated tokens', 0, MAX_INTEGER, 'INVALID_ESTIMATE')
}

function estimateText(text: string, model: ContextModel, estimator: ContextTokenEstimator): number {
  if (typeof text !== 'string') fail('INVALID_BUDGET', 'serialized material must be a string')
  return estimate({ role: 'user', content: [{ type: 'text', text }] }, model, estimator)
}

export interface ContextOutputCaps {
  readonly answer: number
  readonly review: number
  readonly arbiter: number
}

export function stageOutputTokens(stage: CouncilStage, config: ContextConfig, caps: ContextOutputCaps): number {
  const artifact = stage === 'answer' ? config.contextAnswerArtifactTokens
    : stage === 'review' ? config.contextReviewArtifactTokens : config.contextArbiterOutputTokens
  return Math.min(integer(artifact, 'artifact output tokens', 1), integer(caps[stage], `${stage} output cap`, 1))
}

export interface ContextStageBudget {
  readonly stage: CouncilStage
  readonly model: ContextModel
  readonly contextWindow: number
  readonly packetTokens: number
  readonly evidenceTokens: number
  readonly envelopeReserveTokens: number
  readonly maxOutputTokens: number
  readonly safetyMarginTokens: number
  readonly totalTokens: number
  readonly estimatorVersion: string
}

export interface ContextBudgetPlan {
  readonly packetBytes: number
  readonly estimatorVersion: string
  readonly requests: readonly ContextStageBudget[]
}

export interface ContextBudgetPlanInput {
  readonly selection: CouncilSelection
  readonly config: ContextConfig
  readonly windows: ReadonlyMap<string, number>
  /** Full serializePublicPacket result, including topicOriginal exactly once. */
  readonly serializedPacket: string
  readonly estimator: ContextTokenEstimator
  readonly outputCaps: ContextOutputCaps
}

export function planContextBudgets(input: ContextBudgetPlanInput): ContextBudgetPlan {
  const config = normalizeContextConfig(input.config)
  const packetBytes = Buffer.byteLength(input.serializedPacket, 'utf8')
  if (packetBytes > config.contextPacketMaxBytes) fail('CONTEXT_TOO_LARGE', 'public packet exceeds the UTF-8 byte ceiling')
  const { selection } = input
  integer(selection.answerers.length, 'answerer count', 2, 8)
  integer(selection.reviewers.length, 'reviewer count', 1, 8)
  const requests: ContextStageBudget[] = []
  const stages: readonly [CouncilStage, readonly ContextModel[]][] = [
    ['answer', selection.answerers], ['review', selection.reviewers], ['arbiter', [selection.arbiter]],
  ]
  for (const [stage, models] of stages) {
    if (new Set(models.map(model => model.key)).size !== models.length) fail('INVALID_BUDGET', `duplicate ${stage} model`)
    for (const model of models) {
      assertModel(model)
      const window = input.windows.get(model.key)
      if (window === undefined) fail('UNKNOWN_CONTEXT_WINDOW', `unknown context window for ${model.key}`)
      const contextWindow = integer(window, 'context window', 1)
      const packetTokens = estimateText(input.serializedPacket, model, input.estimator)
      if (packetTokens > config.contextMaxTokens) fail('CONTEXT_TOO_LARGE', `public packet exceeds token ceiling for ${model.key}`)
      const evidenceTokens = sum([
        stage === 'answer' ? 0 : selection.answerers.length * config.contextAnswerArtifactTokens,
        stage === 'arbiter' ? selection.reviewers.length * config.contextReviewArtifactTokens : 0,
      ], 'stage evidence')
      const maxOutputTokens = stageOutputTokens(stage, config, input.outputCaps)
      const totalTokens = sum([packetTokens, evidenceTokens, config.contextEnvelopeReserveTokens,
        maxOutputTokens, config.contextSafetyMarginTokens], 'planned input and output')
      if (totalTokens > contextWindow) fail('CONTEXT_BUDGET_EXCEEDED', `${stage} plan exceeds ${model.key} context window (${totalTokens} > ${contextWindow})`)
      requests.push(Object.freeze({
        stage, model: Object.freeze({ provider: model.provider, model: model.model, key: model.key }), contextWindow,
        packetTokens, evidenceTokens, envelopeReserveTokens: config.contextEnvelopeReserveTokens,
        maxOutputTokens, safetyMarginTokens: config.contextSafetyMarginTokens, totalTokens,
        estimatorVersion: input.estimator.version,
      }))
    }
  }
  return Object.freeze({ packetBytes, estimatorVersion: input.estimator.version, requests: Object.freeze(requests) })
}

export interface MaterialBudgetMeasurement {
  readonly bytes: number
  readonly inputTokens: number
  readonly totalTokens: number
}

/** Recheck the whole actual public stage payload, not the initial count formula. */
export function assertStageMaterialBudget(input: {
  readonly budget: ContextStageBudget
  readonly serializedMaterial: string
  readonly estimator: ContextTokenEstimator
}): MaterialBudgetMeasurement {
  const { budget, estimator } = input
  assertModel(budget.model)
  if (budget.estimatorVersion !== estimator.version) fail('ESTIMATOR_UNAVAILABLE', 'stage estimator version changed')
  const inputTokens = estimateText(input.serializedMaterial, budget.model, estimator)
  const totalTokens = sum([inputTokens, budget.envelopeReserveTokens, budget.maxOutputTokens, budget.safetyMarginTokens], 'actual stage budget')
  if (totalTokens > integer(budget.contextWindow, 'context window', 1)) {
    fail('CONTEXT_BUDGET_EXCEEDED', `actual ${budget.stage} material exceeds ${budget.model.key} context window`)
  }
  return Object.freeze({ bytes: Buffer.byteLength(input.serializedMaterial, 'utf8'), inputTokens, totalTokens })
}

/** Caller serializes review/arbiter JSON once; never shorten an oversized result. */
export function assertArtifactBudget(input: {
  readonly stage: CouncilStage
  readonly serializedArtifact: string
  readonly config: ContextConfig
  readonly estimator: ContextTokenEstimator
  readonly model: ContextModel
  readonly maxOutputTokens?: number
}): MaterialBudgetMeasurement {
  const config = normalizeContextConfig(input.config)
  assertModel(input.model)
  const bytes = Buffer.byteLength(input.serializedArtifact, 'utf8')
  const configuredTokens = input.stage === 'answer' ? config.contextAnswerArtifactTokens
    : input.stage === 'review' ? config.contextReviewArtifactTokens : config.contextArbiterOutputTokens
  const maxTokens = Math.min(configuredTokens, input.maxOutputTokens === undefined
    ? configuredTokens : integer(input.maxOutputTokens, 'artifact output cap', 1))
  // A separate byte ceiling, intentionally not a token-to-byte conversion.
  if (bytes > config.contextPacketMaxBytes) fail('ARTIFACT_TOO_LARGE', `${input.stage} artifact exceeds UTF-8 byte ceiling`)
  const inputTokens = estimateText(input.serializedArtifact, input.model, input.estimator)
  if (inputTokens > maxTokens) fail('ARTIFACT_TOO_LARGE', `${input.stage} artifact exceeds token ceiling`)
  return Object.freeze({ bytes, inputTokens, totalTokens: inputTokens })
}

/** The modern GenerateOptions shape, kept local for the older development SDK. */
export interface ReadonlyGenerateOptions {
  readonly provider: string
  readonly model: string
  readonly sessionId?: string
  readonly maxTokens?: number
  readonly system?: string
  readonly messages: readonly BudgetMessage[]
  readonly tools?: readonly unknown[]
  readonly toolHistory?: {
    readonly tools: readonly unknown[]
    readonly updates: readonly { readonly messageId: string; readonly additions: readonly unknown[] }[]
  }
}

export interface ContextMaterialBinding {
  readonly packetHash: string
  readonly payloadHash: string
  readonly serializedPayload: string
}

export interface ContextRequestPolicy {
  /** Registry/ownership scoping remains the entry point's responsibility. */
  readonly sessionId: string
  readonly model: ContextModel
  readonly contextWindow: number
  readonly maxOutputTokens: number
  readonly safetyMarginTokens: number
  readonly estimatorVersion: string
  readonly allowStructuredOutput: boolean
  /** Omit only on a cold continuation; do not claim to restore its old schema. */
  readonly material?: ContextMaterialBinding
}

function materialHash(serialized: string): string {
  return `sha256:${createHash('sha256').update(serialized, 'utf8').digest('hex')}`
}

function assertMaterial(binding: ContextMaterialBinding): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(binding.packetHash)
    || !/^sha256:[a-f0-9]{64}$/u.test(binding.payloadHash)
    || typeof binding.serializedPayload !== 'string' || binding.serializedPayload.length === 0
    || materialHash(binding.serializedPayload) !== binding.payloadHash) {
    fail('REQUEST_MATERIAL_MISMATCH', 'invalid public stage material binding')
  }
}

function assertTool(tool: unknown, allowStructuredOutput: boolean): void {
  if (!record(tool) || typeof tool.name !== 'string' || typeof tool.description !== 'string' || !record(tool.parameters)) {
    fail('INVALID_REQUEST', 'invalid tool schema in request')
  }
  if (!allowStructuredOutput || tool.name !== 'structured_output') fail('REQUEST_TOOL_DENIED', `chat request contains unauthorized tool ${tool.name}`)
}

function assertMessage(message: BudgetMessage, allowStructuredOutput: boolean): void {
  if (!record(message) || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role) || !Array.isArray(message.content)) {
    fail('INVALID_REQUEST', 'invalid request message')
  }
  for (const block of message.content) {
    if (!record(block) || typeof block.type !== 'string') fail('INVALID_REQUEST', 'invalid request content block')
    if (block.type === 'tool-call' || block.type === 'tool-addition' || block.type === 'tool-removal') {
      const name = block.type === 'tool-call' ? block.name : block.toolName
      if (typeof name !== 'string') fail('INVALID_REQUEST', 'invalid tool content block')
      if (!allowStructuredOutput || name !== 'structured_output') fail('REQUEST_TOOL_DENIED', `chat history contains unauthorized tool ${name}`)
    } else if ((block.type === 'text' || block.type === 'reasoning') && typeof block.text === 'string') {
      // All content, including reasoning, is forwarded to the estimator.
    } else if (block.type !== 'image' && block.type !== 'file') {
      fail('INVALID_REQUEST', `unsupported request content block ${block.type}`)
    }
  }
}

/**
 * Read-only synchronous pre-dispatch guard. Register only for the exact owned
 * child; call this before next(), whose contract is AsyncIterable, not Promise.
 * Estimates include system, every message, current tools and ALL tool history.
 */
export function assertGenerateOptionsBudget(options: ReadonlyGenerateOptions, policy: ContextRequestPolicy,
  estimator: ContextTokenEstimator, material?: ContextMaterialBinding): MaterialBudgetMeasurement {
  assertModel(policy.model)
  const contextWindow = integer(policy.contextWindow, 'context window', 1)
  const maxOutputTokens = integer(policy.maxOutputTokens, 'approved output cap', 1)
  const safetyMarginTokens = integer(policy.safetyMarginTokens, 'safety margin')
  if (!policy.sessionId || options.sessionId !== policy.sessionId) fail('REQUEST_SESSION_MISMATCH', 'request is not for the exact owned child')
  if (options.provider !== policy.model.provider || options.model !== policy.model.model) fail('REQUEST_ROUTE_MISMATCH', 'request route differs from the approved route')
  if (policy.estimatorVersion !== estimator.version) fail('ESTIMATOR_UNAVAILABLE', 'request estimator version differs from approved policy')
  const maxTokens = integer(options.maxTokens, 'request maxTokens', 1, MAX_INTEGER, 'REQUEST_OUTPUT_EXCEEDED')
  if (maxTokens > maxOutputTokens) fail('REQUEST_OUTPUT_EXCEEDED', 'request maxTokens exceeds the approved output cap')
  if (!Array.isArray(options.messages) || (options.system !== undefined && typeof options.system !== 'string')
    || (options.tools !== undefined && !Array.isArray(options.tools))) fail('INVALID_REQUEST', 'invalid GenerateOptions inputs')
  if (typeof policy.allowStructuredOutput !== 'boolean') fail('INVALID_BUDGET', 'structured-output permission must be explicit')
  if (policy.material !== undefined) {
    assertMaterial(policy.material)
    if (material === undefined) fail('REQUEST_MATERIAL_MISMATCH', 'initial activation requires its public material binding')
    assertMaterial(material)
    if (policy.material.packetHash !== material.packetHash || policy.material.payloadHash !== material.payloadHash
      || policy.material.serializedPayload !== material.serializedPayload) fail('REQUEST_MATERIAL_MISMATCH', 'public material identity differs from the approved binding')
    const included = options.messages.some(message => Array.isArray(message.content) && message.content.some((block: unknown) =>
      record(block) && block.type === 'text' && typeof block.text === 'string' && block.text.includes(material.serializedPayload)))
    if (!included) fail('REQUEST_MATERIAL_MISMATCH', 'request does not contain the complete approved public material')
  } else if (material !== undefined) {
    fail('REQUEST_MATERIAL_MISMATCH', 'request material has no approved initial binding')
  }
  // A cold reviewer/arbiter may retain old structured submissions and schema
  // history. Pricing those is not restoring a callable current tool schema.
  const allowHistoricalStructured = policy.allowStructuredOutput || policy.material === undefined
  const parts: number[] = []
  if (options.system !== undefined) parts.push(estimate({ role: 'system', content: [{ type: 'text', text: options.system }] }, policy.model, estimator))
  for (const message of options.messages) {
    assertMessage(message, allowHistoricalStructured)
    parts.push(estimate(message, policy.model, estimator))
  }
  for (const tool of options.tools ?? []) {
    assertTool(tool, policy.allowStructuredOutput)
    parts.push(estimateText(serializeRequestInput(tool), policy.model, estimator))
  }
  if (options.toolHistory !== undefined) {
    const history = options.toolHistory
    if (!record(history) || !Array.isArray(history.tools) || !Array.isArray(history.updates)) fail('INVALID_REQUEST', 'invalid toolHistory')
    for (const tool of history.tools) assertTool(tool, allowHistoricalStructured)
    for (const update of history.updates) {
      if (!record(update) || typeof update.messageId !== 'string' || !Array.isArray(update.additions)) fail('INVALID_REQUEST', 'invalid toolHistory update')
      for (const tool of update.additions) assertTool(tool, allowHistoricalStructured)
    }
    // Includes schema names/descriptions/parameters and update IDs/framing. May
    // conservatively double-count current schemas also present in history.
    parts.push(estimateText(serializeRequestInput(history), policy.model, estimator))
  }
  const inputTokens = sum(parts, 'real request input')
  const totalTokens = sum([inputTokens, maxTokens, safetyMarginTokens], 'real request budget')
  if (totalTokens > contextWindow) fail('CONTEXT_BUDGET_EXCEEDED', `real request exceeds approved context window (${totalTokens} > ${contextWindow})`)
  return Object.freeze({ bytes: Buffer.byteLength(serializeRequestInput({
    system: options.system ?? null, messages: options.messages.map(message => ({ role: message.role, content: message.content })),
    tools: options.tools ?? [], toolHistory: options.toolHistory ?? null,
  }), 'utf8'), inputTokens, totalTokens })
}

/** Strict JSON for schema/history estimation: never silently drop unsafe data. */
function serializeRequestInput(value: unknown): string {
  const visiting = new Set<object>()
  const validate = (item: unknown): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (typeof item !== 'object' || item === null || visiting.has(item)) fail('INVALID_REQUEST', 'request input is not lossless JSON')
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) fail('INVALID_REQUEST', 'request input must contain plain JSON records')
    visiting.add(item)
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index += 1) validate(item[index])
    } else {
      for (const key of Reflect.ownKeys(item)) {
        if (typeof key !== 'string') fail('INVALID_REQUEST', 'request input contains symbol keys')
        validate((item as Record<string, unknown>)[key])
      }
    }
    visiting.delete(item)
  }
  validate(value)
  return JSON.stringify(value)
}
