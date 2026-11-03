import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { abortable, withDeadline } from './async.js'
import { createCouncilChat, type CouncilUiSnapshot, type CouncilResultSource, type CouncilChatPresentation, type CouncilQuestionSource, isCouncilUiMarker } from './chat.js'
import { readCouncilChildPolicy, recordCouncilChildPolicy, recordCouncilChildPolicyV2, registerCouncilChildPolicy, isCouncilChildPolicyMarker, childBindingForPolicy, councilChildPolicyV2Schema, type CouncilChildPolicy } from './child-policy.js'
import { normalizeContextConfig, planContextBudgets, assertGenerateOptionsBudget, type ContextConfig, type ContextRequestPolicy, type ContextTokenEstimator, type ReadonlyGenerateOptions } from './context-budget.js'
import { captureCurrentContext, contextEstimator, resolveContextWindows, restoredContextWindow, findPersistedChildBinding } from './context-host.js'
import { chooseContextMode, prepareContextExport } from './context-preparation.js'
import { assertSelectedSourcesCurrent, type ContextCapture } from './context-capture.js'
import { serializePublicPacket, validatePacketRecord, computeExportHash, canonicalJson } from './context-packet.js'
import { createModelReturn, renderModelReturn } from './handoff.js'
import type { ModelReturn } from './context-types.js'
import { createRunRecords, registerCouncilRunRecords, isCouncilRunRecordMarker, type CouncilRunRecord, type CouncilRunRecords } from './run-records.js'
import {
  CouncilRunError,
  runCouncil,
  type ChildOutcome,
  type ChildRequest,
  type CouncilAnswer,
  type CouncilConfig,
  type CouncilQuestion,
  type CouncilRuntime,
} from './council.js'
import { copyForSettings, type CouncilCopy } from './locales.js'
import { renderCouncilResult, renderCouncilAudit, renderFailureAudit } from './protocol.js'
import { councilSubagentApi, startCouncilChild, type CouncilChildRun, type SubagentApi } from './subagents.js'
import type { CatalogFailure, ModelDirectory, ModelRef } from './types.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-council': { readonly kind: 'dsh-council'; readonly childPolicy?: CouncilChildPolicy; readonly ui?: CouncilUiSnapshot; readonly question?: CouncilQuestionSource; readonly result?: CouncilResultSource['result']; readonly runRecord?: CouncilRunRecord; readonly childBinding?: import('./run-records.js').CouncilChildBinding }
  }
}

export const name = 'dsh-council'
export const inject = [
  'commands',
  'llm',
  'userQuestions',
  'sessionProjections',
  'sessionTitle',
  'settings',
  'subagents',
  'tools',
]

export interface Config extends CouncilConfig, Partial<ContextConfig> {}
type RuntimeConfig = Config & ContextConfig

export const Config: z<Config> = z.object({
  answerMaxTokens: z.number().step(1).min(1).default(16_384),
  reviewMaxTokens: z.number().step(1).min(1).default(16_384),
  arbiterMaxTokens: z.number().step(1).min(1).default(16_384),
  childTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(300_000),
  runTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(900_000),
  subagentProvider: z.string().default('spawn'),
  contextMode: z.union(['chat', 'topic-only']).default('chat'),
  contextCaptureAttempts: z.number().step(1).min(1).max(3).default(3),
  contextCaptureTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(5_000),
  contextPreparationTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(30_000),
  contextMaxSources: z.number().step(1).min(1).max(64).default(64),
  contextCandidateMaxBytes: z.number().step(1).min(1).max(524_288).default(524_288),
  contextPacketMaxBytes: z.number().step(1).min(1).max(65_536).default(65_536),
  contextMaxTokens: z.number().step(1).min(1).default(4_096),
  contextAnswerArtifactTokens: z.number().step(1).min(1).default(2_048),
  contextReviewArtifactTokens: z.number().step(1).min(1).default(2_048),
  contextArbiterOutputTokens: z.number().step(1).min(1).default(4_096),
  contextEnvelopeReserveTokens: z.number().step(1).min(0).default(8_192),
  contextSafetyMarginTokens: z.number().step(1).min(0).default(2_048),
  contextWindowOverrides: z.dict(z.number().step(1).min(1)).default({}),
})

const WEB_TOOLS = ['web_search', 'web_fetch'] as const

/**
 * Read the UI locale preference in a version-tolerant way.
 *
 * DSH 0.1.x exposes `ctx.settings.get('locale')` returning `{ preference }`.
 * DSH 0.2.x replaced that SettingsProvider with SettingsForms (no `.get()`);
 * the locale value now lives on the `locale` patch entry's config, reachable
 * through `ctx.configEditor.configuration()`.
 *
 * Returns the raw settings-shaped value `{ preference?: string }` or
 * `undefined` when no source knows the locale, letting `copyForSettings`
 * fall back to English.
 */
function readLocaleSettings(ctx: Context): unknown {
  // 0.1.x path: simple key/value settings service.
  const settings = ctx.settings as { get?: (ns: string) => unknown } | undefined
  if (settings && typeof settings.get === 'function') {
    try {
      return settings.get('locale')
    } catch {
      // fall through to the 0.2.x reader
    }
  }

  // 0.2.x path: the locale entry's config carries `preference`. Volatile
  // fields live on the runtime fiber config (`entry.fiber.config`); persisted
  // layers surface on `override` / `inherited` / `entry.options.config`.
  // `ctx.get` reads a service without requiring an `inject` declaration, so
  // the plugin does not have to list `configEditor` (absent on 0.1.x).
  interface ConfigEditorRow {
    entry?: {
      options?: { id?: string; config?: Record<string, unknown> }
      fiber?: { config?: Record<string, unknown> }
    }
    inherited?: Record<string, unknown>
    override?: Record<string, unknown>
  }
  // `strict=false` so a still-initialising ConfigEditor is not missed.
  const configEditor = ctx.get('configEditor', false) as
    | { configuration?: () => ConfigEditorRow[] }
    | undefined
  if (configEditor && typeof configEditor.configuration === 'function') {
    try {
      const rows = configEditor.configuration()
      const localeRow = rows.find((row) => row?.entry?.options?.id === 'locale')
      if (localeRow) {
        // Parsed volatile fields are live cells, not plain configuration values.
        const live = localeRow.entry?.fiber?.config?.preference
        const cell = live as { get?: () => unknown } | null | undefined
        const preference = (typeof cell?.get === 'function' ? cell.get() : live)
          ?? localeRow.entry?.options?.config?.preference
          ?? localeRow.override?.preference
          ?? localeRow.inherited?.preference
        return { preference }
      }
    } catch {
      // fall through: no locale source available
    }
  }

  return undefined
}

interface BlankRetention {
  readonly messageId: string
  consumed: boolean
}

interface ChildStart {
  readonly api: SubagentApi
  readonly parent: Agent
  readonly request: ChildRequest
  readonly runId: string
  readonly copy: CouncilCopy
  readonly onCreated?: (childId: string) => void
}

/** Read the same blank-session projection that drives DSH's session list. */
function isBlankSession(ctx: Context, agent: Agent, copy: CouncilCopy): boolean {
  const values = ctx.sessionProjections.snapshot(agent.session).values as Record<string, unknown>
  const metadata = values.sessionListMetadata
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)
    || typeof (metadata as Record<string, unknown>).blank !== 'boolean') {
    throw new Error(copy.projectionMissing)
  }
  return (metadata as { blank: boolean }).blank
}

/** Promote a provisional New Session without issuing another model request. */
async function retainBlankCommandSession(
  ctx: Context,
  agent: Agent,
  pending: Map<string, BlankRetention>,
  copy: CouncilCopy,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  const message = createUserMessage({ content: [], source: { kind: name } })
  const retention: BlankRetention = { messageId: String(message.id), consumed: false }
  const agentId = String(agent.id)
  pending.set(agentId, retention)
  // A claimed marker can outlive command cancellation and plugin unload. Keep
  // its exact-id veto on the parent scope until removal or driver quiescence,
  // without waiting for or canceling unrelated long-running parent work.
  const disposeVeto = typeof agent.ctx?.on !== 'function' ? undefined : agent.ctx.on('agent/pre-step', async (payload, next) => {
    if (payload.agent !== agent || !payload.messages.some(item => String(item.id) === retention.messageId)) return next()
    retention.consumed = true
    if (pending.get(agentId) === retention) pending.delete(agentId)
    if (payload.messages.every(item => String(item.id) === retention.messageId)) return { kind: 'reject' }
    const decision = await next()
    return decision.kind === 'reject' ? decision : { ...decision, messages: decision.messages.filter(item => String(item.id) !== retention.messageId) }
  }, { prepend: true })
  const cleanup = (): void => {
    if (pending.get(agentId) === retention) pending.delete(agentId)
    disposeVeto?.()
  }
  let idle: Promise<void> | undefined
  try {
    agent.followup(message)
    idle = agent.whenIdle()
    await abortable(idle, signal)
    signal.throwIfAborted()
  } finally {
    if (retention.consumed) cleanup()
    else {
      const inbox = (agent as unknown as { inbox?: { remove?: (id: typeof message.id) => boolean } }).inbox
      let removed = false
      try { removed = inbox?.remove?.(message.id) === true } catch { /* Keep the exact-id veto if cleanup could not prove removal. */ }
      if (removed) cleanup()
      else if (idle !== undefined) void idle.then(cleanup, cleanup)
      // If followup itself threw after acceptance, the parent scope retains its
      // tiny veto until its own disposal rather than risking a late model wake.
    }
  }
  if (!retention.consumed) throw new Error(copy.retentionFailed)
  ctx.sessionTitle.rename(agent.session, copy.sessionTitle)
}

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message
  return fallback
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function textOf(result: SubagentResult): string {
  return result.output
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

async function discover(ctx: Context, signal: AbortSignal, timeoutMs: number, copy: CouncilCopy): Promise<ModelDirectory> {
  signal.throwIfAborted()
  const providers = ctx.llm.listProviders()
  const settlements = await Promise.allSettled(providers.map(provider =>
    withDeadline(signal, timeoutMs, copy.catalogTimedOut, () => ctx.llm.listModels(provider.id))))
  signal.throwIfAborted()
  const models: ModelRef[] = []
  const failures: CatalogFailure[] = []
  settlements.forEach((settlement, index) => {
    const provider = providers[index]
    if (provider === undefined) return
    if (settlement.status === 'rejected') {
      failures.push({ provider: provider.id, message: messageOf(settlement.reason, copy.unknownFailure) })
      return
    }
    for (const model of settlement.value) {
      const key = `${provider.id}/${model.id}`
      models.push({
        provider: provider.id,
        providerName: provider.name,
        model: model.id,
        modelName: model.name,
        key,
        optionLabel: `${model.name} — ${provider.name} [${key}]`,
      })
    }
  })
  models.sort((left, right) => left.providerName.localeCompare(right.providerName)
    || left.modelName.localeCompare(right.modelName)
    || left.key.localeCompare(right.key))
  return { models, failures }
}

function answersFromDsh(
  answers: readonly { readonly id: string; readonly selected: readonly string[]; readonly custom?: string }[],
): CouncilAnswer[] {
  return answers.map(answer => ({
    id: answer.id,
    selected: answer.selected,
    ...(answer.custom === undefined ? {} : { custom: answer.custom }),
  }))
}

function questionsForDsh(questions: readonly CouncilQuestion[]): AskUserQuestionItem[] {
  return questions.map(question => ({
    id: question.id,
    question: question.question,
    ...(question.header === undefined ? {} : { header: question.header }),
    ...(question.detail === undefined ? {} : { detail: question.detail }),
    ...(question.options === undefined ? {} : { options: [...question.options] }),
    ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
  }))
}

async function settleRun(run: CouncilChildRun, signal: AbortSignal): Promise<ChildOutcome> {
  try {
    const result = await abortable(run.result, signal)
    signal.throwIfAborted()
    return {
      stopReason: result.stopReason,
      text: textOf(result),
      ...(result.structured === undefined ? {} : { structured: result.structured }),
      ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
      childId: String(run.id),
    }
  } finally {
    await run.dispose()
  }
}

function runtimeFor(
  ctx: Context, parent: Agent, config: RuntimeConfig, copy: CouncilCopy,
  childStarts: AsyncLocalStorage<ChildStart>, api: SubagentApi,
  childOperations: Set<Promise<ChildOutcome>>,
  chat: ReturnType<typeof createCouncilChat>,
  captured: ContextCapture | undefined, runId: string, records: CouncilRunRecords,
): CouncilRuntime {
  const ask: CouncilRuntime['ask'] = async (questions, signal) => {
    const result = await abortable(ctx.userQuestions.ask({ agent: parent, questions: questionsForDsh(questions), signal }), signal)
    signal.throwIfAborted()
    return answersFromDsh(result.answers)
  }
  let exportStarted = false
  return {
    selected: selection => chat.selected(selection),
    discover: signal => discover(ctx, signal, config.childTimeoutMs, copy),
    ask,
    material: material => { records.commitMaterial(runId, material) },
    async prepare(selection, signal) {
      if (captured === undefined) return undefined
      records.transition({ version: 2, runId, mode: 'chat', status: 'PREPARING' })
      const result = await prepareContextExport({ runId, selection, capture: captured, config, ask, signal, locale: copy.locale,
        plan: async (packet, preparationSignal) => {
          const estimator = contextEstimator(ctx)
          const budgets = planContextBudgets({ selection, config,
            windows: await resolveContextWindows(ctx, selection, config, preparationSignal), serializedPacket: serializePublicPacket(packet), estimator,
            outputCaps: { answer: config.answerMaxTokens, review: config.reviewMaxTokens, arbiter: config.arbiterMaxTokens } })
          return { budgets, estimator }
        },
        currentCapture: surfaceOnly => captureCurrentContext(ctx, parent, config, signal, surfaceOnly),
      })
      signal.throwIfAborted()
      if (result === undefined) {
        records.transition({ version: 2, runId, mode: 'topic-only', status: 'CREATED' })
        return undefined
      }
      const packetRecord = validatePacketRecord(result.record)
      assertSelectedSourcesCurrent(packetRecord.privateSources, captureCurrentContext(ctx, parent, config, signal, packetRecord.pendingPolicy === 'surface-only-user-approved'), packetRecord.packet.sources, packetRecord.packet.attachments)
      if (computeExportHash(packetRecord.packetHash, [...selection.answerers, ...selection.reviewers, selection.arbiter].map(({ provider, model }) => ({ provider, model }))) !== packetRecord.consent.exportHash) throw new Error('Council routes changed after consent')
      records.commitPacket(packetRecord)
      return { packetRecord, ...result.prepared }
    },
    runChild(request: ChildRequest) {
      // A deadline releases the caller, not ownership of a late startup or its
      // disposal. Keep the entire lifetime so unload is a quiescence barrier.
      const operation = (async () => {
        request.signal.throwIfAborted()
        if (request.context !== undefined) {
          const record = validatePacketRecord(request.context.packetRecord)
          if (!record.consent.providerSet.some(route => route.provider === request.model.provider && route.model === request.model.model)) throw new Error('Council child route was not approved')
          if (!exportStarted) {
            assertSelectedSourcesCurrent(record.privateSources, captureCurrentContext(ctx, parent, config, request.signal, record.pendingPolicy === 'surface-only-user-approved'), record.packet.sources, record.packet.attachments)
            exportStarted = true
          }
        }
        if (request.context === undefined) records.transition({ version: 2, runId, mode: 'topic-only', status: ({ answer: 'ANSWERING', review: 'REVIEWING', arbiter: 'ARBITRATING' } as const)[request.stage] })
        const key = chat.start(request)
        try {
          const run = await childStarts.run({ api, parent, request, runId, copy, onCreated: childId => chat.created(key, childId) }, () => startCouncilChild(ctx.subagents, api, config.subagentProvider, {
            label: request.label,
            prompt: [{ type: 'text', text: request.prompt }],
            parent,
            signal: request.signal,
            agentOptions: {
              provider: request.model.provider,
              model: request.model.model,
              maxTokens: request.maxTokens,
            },
            persona: request.persona,
            toolFilter: { allow: request.context === undefined ? WEB_TOOLS : [] },
            ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
          }))
          chat.created(key, String(run.id))
          const outcome = await settleRun(run, request.signal)
          chat.settled(key, outcome)
          return outcome
        } catch (error: unknown) {
          chat.settled(key, error instanceof Error ? error : new Error(copy.unknownFailure))
          throw error
        }
      })()
      childOperations.add(operation)
      const retire = (): void => { childOperations.delete(operation) }
      void operation.then(retire, retire)
      return operation
    },
    random: Math.random,
  }
}

async function executeCouncil(
  ctx: Context,
  config: RuntimeConfig,
  invocation: CommandInvocation,
  lifecycleSignal: AbortSignal,
  blankRetentions: Map<string, BlankRetention>,
  copy: CouncilCopy,
  childStarts: AsyncLocalStorage<ChildStart>,
  childOperations: Set<Promise<ChildOutcome>>,
): Promise<CommandResult> {
  if (invocation.rawInput.trim() !== '') return { kind: 'error', text: copy.usage }
  const signal = AbortSignal.any([invocation.signal, lifecycleSignal])
  const runId = String(invocation.commandId)
  const records = createRunRecords(ctx, invocation.agent)
  const prior = records.read(runId)
  if (prior !== undefined) {
    if (prior.terminal !== undefined) return prior.terminal.result.status === 'success'
      ? { kind: 'success', text: prior.terminal.text, sourceEventSeq: prior.terminal.sourceEventSeq }
      : { kind: 'error', text: prior.terminal.text }
    return { kind: 'error', text: copy.locale === 'zh' ? '此轮议会已中断，不会自动续跑；请以新命令重新开始。' : 'This Council run was interrupted; start a new command instead of automatically replaying it.' }
  }
  const chat = createCouncilChat(invocation.agent, runId, records, copy.locale)
  let result: CommandResult
  let status: CouncilUiSnapshot['status'] = 'error'
  let retentionWarning: string | undefined
  let presentation: CouncilChatPresentation | undefined
  let modelReturn: ModelReturn | undefined
  let mode: 'chat' | 'topic-only' = 'topic-only'
  try {
    signal.throwIfAborted()
    const startedBlank = isBlankSession(ctx, invocation.agent, copy)
    const api = councilSubagentApi(ctx.subagents, config.subagentProvider, copy)
    if (startedBlank && isBlankSession(ctx, invocation.agent, copy)) {
      try {
        // Make the actual session durable before asking or launching children,
        // without invoking the parent model or forging turn boundaries.
        await retainBlankCommandSession(ctx, invocation.agent, blankRetentions, copy, signal)
      } catch (error: unknown) {
        retentionWarning = copy.failed(messageOf(error, copy.unknownFailure))
      }
    }
    signal.throwIfAborted()
    const ask: CouncilRuntime['ask'] = async (questions, askSignal) => {
      const answer = await abortable(ctx.userQuestions.ask({ agent: invocation.agent, questions: questionsForDsh(questions), signal: askSignal }), askSignal)
      askSignal.throwIfAborted()
      return answersFromDsh(answer.answers)
    }
    const captured = await chooseContextMode({ config, ask, signal, locale: copy.locale,
      capture: surfaceOnly => captureCurrentContext(ctx, invocation.agent, config, signal, surfaceOnly) })
    mode = captured === undefined ? 'topic-only' : 'chat'
    records.transition({ version: 2, runId, mode, status: 'CREATED' })
    if (captured !== undefined) records.transition({ version: 2, runId, mode: 'chat', status: 'CAPTURED' })
    const council = await runCouncil(
      runtimeFor(ctx, invocation.agent, config, copy, childStarts, api, childOperations, chat, captured, runId, records),
      config,
      signal,
      copy,
    )
    mode = council.packetRecord === undefined ? 'topic-only' : 'chat'
    modelReturn = createModelReturn({ runId: String(invocation.commandId),
      ...(council.packetRecord === undefined ? {} : { packetHash: council.packetRecord.packetHash }),
      decision: { ...council.arbiter, consensus: [...council.arbiter.consensus], contradictions: [...council.arbiter.contradictions], blindSpots: [...council.arbiter.blindSpots], decisionDeltas: council.arbiter.decisionDeltas ?? [], citations: council.arbiter.citations ?? [] },
      coverage: { answerersRequested: council.selection.answerers.length, answerersSucceeded: council.answers.length, reviewersRequested: council.selection.reviewers.length, reviewersSucceeded: council.reviews.length },
      sourceAliases: council.packetRecord?.packet.sources.map(source => source.alias) ?? [],
      limitations: [
        ...(council.modelReturn?.limitations ?? []),
        ...(council.packetRecord === undefined ? [copy.locale === 'zh' ? '本轮仅使用议题，未携带聊天背景。' : 'Topic-only run; chat background was not exported.'] : []),
        ...(council.packetRecord === undefined && council.failures.length > 0 ? [copy.locale === 'zh' ? '部分参与者失败；覆盖人数按实际成功产物计算。' : 'Some participants failed; coverage counts only successful artifacts.'] : []),
        ...(retentionWarning === undefined ? [] : [retentionWarning]),
      ],
    })
    result = { kind: 'success', text: renderCouncilResult(council, copy) }
    status = 'success'
    presentation = { answerMarkdown: council.arbiter.answerMarkdown, auditMarkdown: renderCouncilAudit(council, copy) }
  } catch (error: unknown) {
    const code = errorCode(error)
    if (signal.aborted || code === 'ASK_CANCELLED' || code === 'ASK_ABORTED') {
      status = 'canceled'
      result = { kind: 'error', text: copy.canceled }
    } else if (error instanceof CouncilRunError) {
      result = { kind: 'error', text: renderFailureAudit(error.message, error.directoryFailures, error.failures, copy) }
    } else {
      result = { kind: 'error', text: copy.failed(messageOf(error, copy.unknownFailure)) }
    }
  }
  if (signal.aborted) {
    status = 'canceled'
    result = { kind: 'error', text: copy.canceled }
  }
  if (retentionWarning !== undefined) {
    result = { ...result, text: `${result.text ?? ''}\n\n${retentionWarning}` }
    if (presentation !== undefined) presentation = { ...presentation, auditMarkdown: `${presentation.auditMarkdown}\n\n${retentionWarning}` }
  }
  mode = records.read(runId)?.mode ?? mode
  if (status !== 'success') presentation = undefined
  try {
    // This is a producer-owned context record, never a synthetic model reply.
    // The Client renders its own Council row. Inbox admission leaves the first
    // protected system head to AgentLoop; future parent turns see the
    // question and final decision, not the children’s raw reasoning streams.
    const sourceEventSeq = chat.finish(status, status === 'success' && modelReturn !== undefined ? renderModelReturn(modelReturn, copy) : result.text ?? '', presentation,
      { mode, ...(status === 'success' && modelReturn !== undefined ? { modelReturn } : {}) })
    const canonical = records.read(runId)?.terminal
    if (canonical === undefined) throw new Error('Council terminal commit is unavailable')
    return canonical.result.status === 'success'
      ? { kind: 'success', sourceEventSeq, text: result.kind === 'success' ? result.text ?? canonical.text : canonical.text }
      : { kind: 'error', text: canonical.text }
  } catch (error: unknown) {
    const canonical = records.read(runId)?.terminal
    if (canonical !== undefined) return canonical.result.status === 'success'
      ? { kind: 'success', text: canonical.text, sourceEventSeq: canonical.sourceEventSeq }
      : { kind: 'error', text: canonical.text }
    return { kind: 'error', text: `${result.text ?? ''}\n\n${copy.failed(messageOf(error, copy.unknownFailure))}` }
  }
}

export function apply(ctx: Context, inputConfig: Config): void {
  const config: RuntimeConfig = { ...inputConfig, ...normalizeContextConfig(inputConfig) }
  for (const key of ['answerMaxTokens', 'reviewMaxTokens', 'arbiterMaxTokens', 'childTimeoutMs', 'runTimeoutMs'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1
      || (key.endsWith('TimeoutMs') && config[key] > 2_147_483_647)) {
      throw new Error(`dsh-council: ${key} must be a positive integer within the supported range`)
    }
  }
  if (!config.subagentProvider.trim()) throw new Error('dsh-council: subagentProvider must not be empty')
  if (config.runTimeoutMs < config.childTimeoutMs) {
    throw new Error('dsh-council: runTimeoutMs must be greater than or equal to childTimeoutMs')
  }
  const activeAgents = new Set<string>()
  const activeOperations = new Set<Promise<CommandResult>>()
  const childOperations = new Set<Promise<ChildOutcome>>()
  const childPolicies = new Map<Agent, () => Promise<void>>()
  const initializingPolicies = new Map<Agent, () => Promise<void>>()
  const restoredChildren = new Set<Agent>()
  const blankRetentions = new Map<string, BlankRetention>()
  const lifecycle = new AbortController()
  const childStarts = new AsyncLocalStorage<ChildStart>()
  registerCouncilChildPolicy(ctx)
  registerCouncilRunRecords(ctx)
  // Creation is held before the first prompt. Restriction alone preserves
  // scoped tools, so the final guard and prompt filter are both necessary.
  ctx.on('agent/created', async ({ agent }) => {
    const pending = childStarts.getStore()
    const start = pending !== undefined && agent.session.header.parentSession === pending.parent.id ? pending : undefined
    // Other creation listeners can already have started an async tools.execute
    // pipeline. Quarantine synchronously, BEFORE any ownership/window await.
    // Failed setup retains this child-owned guard until factory rollback.
    const quarantine = start !== undefined || agent.session.header.parentSession !== undefined ? agent.ctx.effect(function* () {
      yield () => { initializingPolicies.delete(agent) }
      yield agent.ctx.tools.guard(() => 'Council child authorization is not complete')
    }, 'dsh-council authorization quarantine') : undefined
    if (quarantine !== undefined) initializingPolicies.set(agent, quarantine)
    const restored = start === undefined ? readCouncilChildPolicy(ctx, agent) : undefined
    const binding = start === undefined && agent.session.header.parentSession !== undefined
      ? await withDeadline(lifecycle.signal, config.contextPreparationTimeoutMs, 'Council child ownership lookup timed out', signal => findPersistedChildBinding(ctx, agent, signal)) : undefined
    if (binding !== undefined && (restored?.version !== 2 || canonicalJson(childBindingForPolicy(restored)) !== canonicalJson(binding))) throw new Error('dsh-council: Council child policy is missing or conflicts with its parent manifest')
    if (restored?.version === 2 && binding === undefined) throw new Error('dsh-council: persisted Council parent binding is unavailable')
    if (start === undefined && restored === undefined) { await quarantine?.(); return }
    if (restored !== undefined) lifecycle.signal.throwIfAborted()
    const copy = start?.copy ?? copyForSettings(readLocaleSettings(ctx))
    const persona = start?.api === 'activation' ? start.request.persona : restored?.persona
    const context = start?.request.context
    const globalTools = context !== undefined ? [] : restored?.version === 2 ? restored.allowedGlobalTools.filter(tool => WEB_TOOLS.includes(tool)) : [...WEB_TOOLS]
    const allowed = new Set<string>(globalTools)
    // A cold continuation has no activation-scoped structured schema.
    if (start?.request.outputSchema !== undefined) allowed.add('structured_output')
    let initialDispatchChecked = false
    let requestPolicy: ContextRequestPolicy | undefined
    let estimator: ContextTokenEstimator | undefined
    if (context !== undefined) {
      estimator = context.estimator
      requestPolicy = { sessionId: String(agent.id), model: context.budget.model, contextWindow: context.budget.contextWindow,
        maxOutputTokens: context.budget.maxOutputTokens, safetyMarginTokens: context.budget.safetyMarginTokens,
        estimatorVersion: context.budget.estimatorVersion, allowStructuredOutput: start?.request.outputSchema !== undefined, material: context.material }
    } else if (restored?.version === 2) {
      if (agent.options.provider !== restored.approvedRoute.provider || agent.options.model !== restored.approvedRoute.model) throw new Error('dsh-council: restored route differs from approved route')
      if (restored.mode === 'chat') {
        estimator = contextEstimator(ctx)
        const model = { ...restored.approvedRoute, key: `${restored.approvedRoute.provider}/${restored.approvedRoute.model}` }
        const contextWindow = await withDeadline(lifecycle.signal, config.contextPreparationTimeoutMs, 'Restored context preparation timed out',
          signal => restoredContextWindow(ctx, model, restored.budgetPolicy.contextWindow, config, signal))
        requestPolicy = { sessionId: String(agent.id), model, contextWindow,
          maxOutputTokens: Math.min(restored.maxTokens, restored.budgetPolicy.maxOutputTokens, config.answerMaxTokens, config.reviewMaxTokens, config.arbiterMaxTokens, config.contextAnswerArtifactTokens, config.contextReviewArtifactTokens, config.contextArbiterOutputTokens),
          safetyMarginTokens: Math.max(restored.budgetPolicy.safetyMarginTokens, config.contextSafetyMarginTokens),
          estimatorVersion: restored.budgetPolicy.estimatorVersion, allowStructuredOutput: false }
        if (estimator.version !== requestPolicy.estimatorVersion) throw new Error('dsh-council: persisted estimator version is unavailable')
      }
    }
    const dispose = agent.ctx.effect(function* () {
      yield () => { childPolicies.delete(agent); restoredChildren.delete(agent) }
      if (persona !== undefined) {
        // The baseline SDK predates literal sections and the prefix/suffix split.
        const prompt = agent.ctx.systemPrompt as unknown as {
          getSectionOrder(name: string): number
          section(section: { name: string; order: number; text: string; interpolate: boolean }): () => void
        }
        yield prompt.section({
          name: 'deployment:persona-prefix',
          order: prompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
          text: persona,
          interpolate: false,
        })
      }
      yield agent.ctx.tools.restrict({ allow: globalTools })
      yield agent.ctx.tools.presentAs('native')
      yield agent.ctx.tools.guard(execution => allowed.has(execution.name) ? undefined : context !== undefined || restored?.version === 2 && restored.mode === 'chat'
        ? copy.locale === 'zh' ? '聊天背景议会禁止文件、Shell、Web 和再委派。' : 'Chat-background Council denies files, Shell, Web and delegation.' : copy.toolDenied)
      if (requestPolicy !== undefined && estimator !== undefined) {
        const policy = requestPolicy
        const meter = estimator
        yield agent.ctx.on('llm/stream', (options, next) => {
          const agents = ctx.get('agents', false)
          const initiator = (agents as unknown as { currentInitiator?: () => Agent | undefined } | undefined)?.currentInitiator?.()
          if (String(options.sessionId) !== String(agent.id) && initiator !== agent) return next()
          if (agents?.get(agent.id) !== agent) throw new Error('dsh-council: request does not belong to the exact live child')
          if (start !== undefined && typeof agents.isOwnedBy === 'function' && !agents.isOwnedBy(agent.id, start.parent)) throw new Error('dsh-council: child runtime owner changed')
          if (context !== undefined && start !== undefined && !initialDispatchChecked) {
            start.request.signal.throwIfAborted()
            const packet = validatePacketRecord(context.packetRecord)
            assertSelectedSourcesCurrent(packet.privateSources, captureCurrentContext(ctx, start.parent, config, start.request.signal, packet.pendingPolicy === 'surface-only-user-approved'), packet.packet.sources, packet.packet.attachments)
            initialDispatchChecked = true
          }
          assertGenerateOptionsBudget(options as unknown as ReadonlyGenerateOptions, policy, meter, context?.material)
          return next()
        }, { prepend: true })
      } else if (restored?.version === 2 || start !== undefined) {
        const route = restored?.version === 2 ? restored.approvedRoute : { provider: start!.request.model.provider, model: start!.request.model.model }
        const outputCap = restored?.maxTokens ?? start!.request.maxTokens
        yield agent.ctx.on('llm/stream', (options, next) => {
          if (String(options.sessionId) !== String(agent.id)) return next()
          if (options.provider !== route.provider || options.model !== route.model
            || options.maxTokens === undefined || options.maxTokens > outputCap) throw new Error('dsh-council: restored topic route/output authorization mismatch')
          return next()
        }, { prepend: true })
      }
      yield agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const assembly = await next()
        return { ...assembly, tools: assembly.tools.filter(tool => allowed.has(tool.name)) }
      }, { prepend: true })
    }, 'dsh-council child policy')
    childPolicies.set(agent, dispose)
    if (restored !== undefined) {
      restoredChildren.add(agent)
      // The desktop local provider persists routing but omits maxTokens on a
      // cold continuation. Restore the durable cap before any request is built.
      const cap = Math.min(restored.maxTokens ?? agent.options.maxTokens ?? NaN, requestPolicy?.maxOutputTokens ?? Number.MAX_SAFE_INTEGER)
      if (!Number.isSafeInteger(cap) || cap === undefined || cap < 1) {
        throw new Error('dsh-council: persisted child token budget is unavailable')
      }
      const current = agent.options.maxTokens
      if (current === undefined || !Number.isSafeInteger(current) || current < 1 || current > cap) agent.options.maxTokens = cap
      if (agent.options.maxTokens === undefined || agent.options.maxTokens > cap) throw new Error('dsh-council: child token budget could not be restored')
    }
    // Managed activations remain continuable after collection. Persist only
    // host-authored policy metadata so cold resume reinstalls the same limits.
    if (start !== undefined) {
      const common = { version: 2, policyVersion: 2, childId: String(agent.id), parentId: String(start.parent.id),
        runId: start.runId, persona: start.request.persona, maxTokens: start.request.maxTokens,
        approvedRoute: { provider: start.request.model.provider, model: start.request.model.model } }
      const policy = councilChildPolicyV2Schema.parse(context === undefined ? { ...common, mode: 'topic-only', allowedGlobalTools: [...WEB_TOOLS] }
        : { ...common, mode: 'chat', allowedGlobalTools: [], packetHash: context.packetRecord.packetHash,
          budgetPolicy: { contextWindow: context.budget.contextWindow, maxOutputTokens: context.budget.maxOutputTokens,
            safetyMarginTokens: context.budget.safetyMarginTokens, estimatorVersion: context.budget.estimatorVersion } })
      createRunRecords(ctx, start.parent).commitChildBinding(start.runId, policy)
      recordCouncilChildPolicyV2(agent, policy)
    }
    if (persona !== undefined) {
      const assembly = await agent.ctx.systemPrompt.assemble({ scope: agent })
      if (!assembly.sections.some(section => section.name === 'deployment:persona-prefix' && section.text === persona)) {
        throw new Error('dsh-council: child preset suppresses the Council persona')
      }
    }
    if (restored !== undefined) lifecycle.signal.throwIfAborted()
    start?.onCreated?.(String(agent.id))
    await quarantine?.()
  }, { global: true })
  // Register at the root so retention is covered in every session. Preset
  // listeners can wrap this callback, so marker-only retention must veto.
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const uiOnly = (message: typeof messages[number]): boolean => {
      return isCouncilUiMarker(message) || isCouncilRunRecordMarker(message) || isCouncilChildPolicyMarker(message)
    }
    const hasUi = messages.some(uiOnly)
    if (hasUi && messages.every(uiOnly)) return { kind: 'reject' }
    const retention = blankRetentions.get(String(agent.id))
    if (retention === undefined) {
      const decision = await next()
      return !hasUi || decision.kind === 'reject' ? decision : { ...decision, messages: decision.messages.filter(message => !uiOnly(message)) }
    }
    // A marker-only turn must not acquire synthetic prompt/skill messages:
    // those would turn session retention into an unintended model request.
    if (messages.length === 1 && String(messages[0]?.id) === retention.messageId) {
      retention.consumed = true
      blankRetentions.delete(String(agent.id))
      // Outer preset listeners may repopulate an empty enter decision. A veto
      // is terminal, so this zero-step retention turn cannot become an LLM call.
      return { kind: 'reject' }
    }
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (!decision.messages.some(message => String(message.id) === retention.messageId)) return decision
    retention.consumed = true
    blankRetentions.delete(String(agent.id))
    return { ...decision, messages: decision.messages.filter(message => String(message.id) !== retention.messageId && !uiOnly(message)) }
  }, { global: true, prepend: true })
  const handler = (invocation: CommandInvocation): Promise<CommandResult> => {
    const copy = copyForSettings(readLocaleSettings(ctx))
    const agentId = String(invocation.agent.id)
    if (activeAgents.has(agentId)) {
      return Promise.resolve({ kind: 'error', text: copy.alreadyRunning })
    }
    activeAgents.add(agentId)
    const operation = executeCouncil(ctx, config, invocation, lifecycle.signal, blankRetentions, copy, childStarts, childOperations)
    activeOperations.add(operation)
    const retire = (): void => {
      activeAgents.delete(agentId)
      activeOperations.delete(operation)
    }
    void operation.then(retire, retire)
    return operation
  }

  ctx.effect(function* () {
    yield async () => {
      lifecycle.abort(new Error('dsh-council plugin disposed'))
      const managed = ctx.subagents as unknown as {
        drainChildren?(parent: Agent, ids: readonly Agent['id'][]): Promise<void>
      }
      const restoredDrains = [...restoredChildren].map(async agent => {
        agent.cancel({ kind: 'disposed' })
        try {
          const parentId = agent.session.header.parentSession
          const parent = parentId === undefined ? undefined : ctx.get('agents', false)?.get(parentId)
          if (parent !== undefined && typeof managed.drainChildren === 'function') {
            await managed.drainChildren(parent, [agent.id])
          }
        } finally {
          await agent.whenIdle()
        }
      })
      await Promise.allSettled(activeOperations)
      await Promise.allSettled(childOperations)
      await Promise.allSettled(restoredDrains)
      // Initial receipts own exact teardown. A restored Agent may instead be
      // independently materializing: keep its policy child-owned until that
      // scope closes, rather than widening it across a publication/idle race.
      await Promise.allSettled([...childPolicies].filter(([agent]) => !restoredChildren.has(agent))
        .map(([, dispose]) => dispose()))
      // Never lift a publishing child's quarantine merely because the plugin
      // unloaded. Its own factory scope closes after rejected initialization.
      await Promise.allSettled([...initializingPolicies].filter(([agent]) => ctx.get('agents', false)?.get(agent.id) !== agent)
        .map(([, dispose]) => dispose()))
    }
    let disposeCommand = (): void => {}
    const registerCommand = (): void => {
      disposeCommand()
      const copy = copyForSettings(readLocaleSettings(ctx))
      disposeCommand = ctx.commands.register({
        name: 'council',
        description: copy.commandDescription,
        recordInput: false,
        handler,
      })
    }
    registerCommand()
    // 0.1.x: the settings service emits `settings/updated` with the namespace.
    // 0.2.x: SettingsForms emits `settings/document-updated` with the entry id.
    // Listening to both keeps the localized command description fresh across
    // runtimes; `ctx.on` returns a disposer regardless of whether the event
    // is ever emitted.
    const refreshOnLocale = (identifier: unknown): void => {
      if (String(identifier) === 'locale') registerCommand()
    }
    const disposeUpdatedWatch = ctx.on('settings/updated', refreshOnLocale)
    const disposeDocumentWatch = ctx.on('settings/document-updated', refreshOnLocale)
    yield () => {
      disposeUpdatedWatch()
      disposeDocumentWatch()
      disposeCommand()
    }
  }, 'dsh-council lifecycle')
}

export type {
  ArbiterOutput,
  CouncilResult,
  CouncilSelection,
  ModelDirectory,
  ModelRef,
  ReviewerOutput,
} from './types.js'
