import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { CouncilCopy } from './locales.js'
import { withDeadline } from './async.js'
import {
  assertArtifactBudget, assertStageMaterialBudget, normalizeContextConfig, planContextBudgets,
  type ContextBudgetPlan, type ContextConfig, type ContextMaterialBinding,
  type ContextStageBudget, type ContextTokenEstimator,
} from './context-budget.js'
import {
  canonicalJson, createAnswerCorpus, createReviewCorpus, createStageMaterial,
  normalizeProviderSet, serializePublicPacket, validatePacketRecord,
} from './context-packet.js'
import type { ArbiterDecision, PacketRecord, StageMaterial } from './context-types.js'
import { createModelReturn, parseArbiterDecision } from './handoff.js'
import {
  aggregateRankings,
  answerPrompt,
  arbiterPrompt,
  arbiterSchema,
  chatArbiterSchema,
  chatReviewerSchema,
  chatStagePersona,
  chatStagePrompt,
  parseChatReviewerOutput,
  parseArbiterOutput,
  parseReviewerOutput,
  reviewPrompt,
  reviewerSchema,
  shuffle,
} from './protocol.js'
import type {
  AnswerRecord,
  ArbiterOutput,
  CallFailure,
  CouncilResult,
  CouncilSelection,
  CouncilStage,
  ModelDirectory,
  ModelRef,
  ReviewRecord,
} from './types.js'

export interface CouncilConfig extends Partial<ContextConfig> {
  readonly answerMaxTokens: number
  readonly reviewMaxTokens: number
  readonly arbiterMaxTokens: number
  readonly childTimeoutMs: number
  readonly runTimeoutMs: number
  readonly subagentProvider: string
}

export interface CouncilQuestion {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly detail?: string
  readonly options?: readonly { readonly label: string; readonly description?: string }[]
  readonly multiSelect?: boolean
}

export interface CouncilAnswer {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

export interface ChatPreparation {
  readonly packetRecord: PacketRecord
  readonly budgets: ContextBudgetPlan
  readonly estimator: ContextTokenEstimator
}

export interface ChildContext {
  readonly packetRecord: PacketRecord
  readonly material: ContextMaterialBinding
  readonly budget: ContextStageBudget
  readonly estimator: ContextTokenEstimator
}

export interface ChildRequest {
  readonly stage: CouncilStage
  readonly label: string
  readonly model: ModelRef
  readonly prompt: string
  readonly persona: string
  readonly maxTokens: number
  readonly outputSchema?: ObjectJsonSchema
  readonly timeoutMs: number
  readonly signal: AbortSignal
  readonly context?: ChildContext
}

export interface ChildOutcome {
  readonly stopReason: string
  readonly text: string
  readonly structured?: unknown
  readonly diagnostic?: string
  readonly childId?: string
}

export interface CouncilRuntime {
  discover(signal: AbortSignal): Promise<ModelDirectory>
  ask(questions: readonly CouncilQuestion[], signal: AbortSignal): Promise<readonly CouncilAnswer[]>
  runChild(request: ChildRequest): Promise<ChildOutcome>
  /** Host owns capture, selection, full preview and consent; no model calls here. */
  prepare?(selection: CouncilSelection, signal: AbortSignal): Promise<ChatPreparation | undefined>
  /** Persist each already-frozen stage exactly once before its children start. */
  material?(material: StageMaterial): void
  selected?(selection: CouncilSelection): void
  random(): number
}

export class CouncilRunError extends Error {
  constructor(
    message: string,
    readonly directoryFailures: ModelDirectory['failures'],
    readonly failures: readonly CallFailure[],
  ) {
    super(message)
    this.name = 'CouncilRunError'
  }
}

function messageOf(error: unknown, copy: CouncilCopy): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message
  return copy.unknownFailure
}

function childFailure(
  stage: CouncilStage,
  model: ModelRef,
  outcome: ChildOutcome,
  copy: CouncilCopy,
): CallFailure {
  const detail = outcome.diagnostic?.trim()
  return {
    stage,
    model,
    message: detail === undefined || detail === '' ? copy.childStopped(outcome.stopReason) : detail,
  }
}

function thrownFailure(stage: CouncilStage, model: ModelRef, error: unknown, copy: CouncilCopy): CallFailure {
  return { stage, model, message: messageOf(error, copy) }
}

function selectedModels(
  answer: CouncilAnswer | undefined,
  byLabel: ReadonlyMap<string, ModelRef>,
  minimum: number,
  maximum: number,
  role: string,
  copy: CouncilCopy,
): ModelRef[] {
  if (answer?.custom?.trim()) throw new Error(copy.customModel(role))
  const labels = answer?.selected ?? []
  const models = labels.map(label => byLabel.get(label))
  if (models.some(model => model === undefined)) throw new Error(copy.unknownModel(role))
  const resolved = models as ModelRef[]
  if (resolved.length < minimum || resolved.length > maximum) {
    throw new Error(copy.selectionCount(role, minimum, maximum))
  }
  if (new Set(resolved.map(model => model.key)).size !== resolved.length) {
    throw new Error(copy.duplicateModel(role))
  }
  return resolved
}

export function parseSelection(
  directory: ModelDirectory,
  answers: readonly CouncilAnswer[],
  copy: CouncilCopy,
): CouncilSelection {
  if (new Set(answers.map(answer => answer.id)).size !== answers.length
    || answers.some(answer => !['answerers', 'reviewers', 'arbiter', 'question'].includes(answer.id))) {
    throw new Error(copy.invalidSelection)
  }
  const byId = new Map(answers.map(answer => [answer.id, answer]))
  const byLabel = new Map(directory.models.map(model => [model.optionLabel, model]))
  const answerers = selectedModels(byId.get('answerers'), byLabel, 2, 8, copy.answererRole, copy)
  const reviewers = selectedModels(byId.get('reviewers'), byLabel, 1, 8, copy.reviewerRole, copy)
  const arbiters = selectedModels(byId.get('arbiter'), byLabel, 1, 1, copy.arbiterRole, copy)
  const promptAnswer = byId.get('question')
  if ((promptAnswer?.selected.length ?? 0) > 0) throw new Error(copy.questionTextOnly)
  const question = promptAnswer?.custom ?? ''
  if (question.trim() === '') throw new Error(copy.questionRequired)
  return { answerers, reviewers, arbiter: arbiters[0] as ModelRef, question }
}

export function selectionQuestions(directory: ModelDirectory, copy: CouncilCopy): CouncilQuestion[] {
  const options = directory.models.map(model => ({
    label: model.optionLabel,
    description: model.key,
  }))
  const detail = directory.failures.length === 0
    ? undefined
    : copy.unavailableCatalogs(directory.failures.map(failure => failure.provider))
  return [
    {
      id: 'answerers',
      header: copy.answererHeader,
      question: copy.answererQuestion,
      options,
      multiSelect: true,
      ...(detail === undefined ? {} : { detail }),
    },
    {
      id: 'reviewers',
      header: copy.reviewerHeader,
      question: copy.reviewerQuestion,
      options,
      multiSelect: true,
    },
    {
      id: 'arbiter',
      header: copy.arbiterHeader,
      question: copy.arbiterQuestion,
      options,
    },
    {
      id: 'question',
      header: copy.topicHeader,
      question: copy.topicQuestion,
    },
  ]
}

async function runStage(
  runtime: CouncilRuntime,
  requests: readonly ChildRequest[],
  copy: CouncilCopy,
): Promise<readonly PromiseSettledResult<ChildOutcome>[]> {
  return Promise.allSettled(requests.map(request => runChild(runtime, request, copy)))
}

function runChild(runtime: CouncilRuntime, request: ChildRequest, copy: CouncilCopy): Promise<ChildOutcome> {
  return withDeadline(request.signal, request.timeoutMs, copy.childTimedOut,
    signal => runtime.runChild({ ...request, signal }))
}

function validatePreparation(prepared: ChatPreparation, selection: CouncilSelection, config: CouncilConfig): ChatPreparation {
  const normalized = normalizeContextConfig(config)
  if (normalized.contextMode === 'topic-only') throw new Error('Chat preparation is disabled by contextMode')
  const packetRecord = validatePacketRecord(prepared.packetRecord)
  if (packetRecord.packet.topicOriginal !== selection.question) throw new Error('Prepared topic differs from the selected original topic')
  const routes = normalizeProviderSet([...selection.answerers, ...selection.reviewers, selection.arbiter]
    .map(model => ({ provider: model.provider, model: model.model })))
  if (canonicalJson(routes) !== canonicalJson(packetRecord.consent.providerSet)) throw new Error('Selected routes differ from consent')
  const windows = new Map<string, number>()
  for (const budget of prepared.budgets.requests) {
    const previous = windows.get(budget.model.key)
    if (previous !== undefined && previous !== budget.contextWindow) throw new Error('Inconsistent context windows for an exact model')
    windows.set(budget.model.key, budget.contextWindow)
  }
  const budgets = planContextBudgets({
    selection, config: normalized, windows, serializedPacket: serializePublicPacket(packetRecord.packet), estimator: prepared.estimator,
    outputCaps: { answer: config.answerMaxTokens, review: config.reviewMaxTokens, arbiter: config.arbiterMaxTokens },
  })
  if (canonicalJson(budgets) !== canonicalJson(prepared.budgets)) throw new Error('Prepared budgets differ from the current exact selection and caps')
  return Object.freeze({ packetRecord, budgets, estimator: prepared.estimator })
}

export async function runCouncil(
  runtime: CouncilRuntime,
  config: CouncilConfig,
  commandSignal: AbortSignal,
  copy: CouncilCopy,
): Promise<CouncilResult> {
  commandSignal.throwIfAborted()
  const directory = await runtime.discover(commandSignal)
  if (directory.models.length < 2) {
    throw new CouncilRunError(copy.noModels, directory.failures, [])
  }
  const selection = parseSelection(
    directory,
    await runtime.ask(selectionQuestions(directory, copy), commandSignal),
    copy,
  )
  commandSignal.throwIfAborted()
  const preparation = await runtime.prepare?.(selection, commandSignal)
  commandSignal.throwIfAborted()
  const prepared = preparation === undefined ? undefined : validatePreparation(preparation, selection, config)
  runtime.selected?.(selection)
  const failures: CallFailure[] = []
  try {
    return await withDeadline(commandSignal, config.runTimeoutMs, copy.runTimedOut,
      signal => deliberate(runtime, config, directory, selection, failures, signal, copy, prepared))
  } catch (error: unknown) {
    commandSignal.throwIfAborted()
    if (error instanceof CouncilRunError) throw error
    throw new CouncilRunError(messageOf(error, copy), directory.failures, failures)
  }
}

async function deliberate(
  runtime: CouncilRuntime,
  config: CouncilConfig,
  directory: ModelDirectory,
  selection: CouncilSelection,
  failures: CallFailure[],
  runSignal: AbortSignal,
  copy: CouncilCopy,
  prepared?: ChatPreparation,
): Promise<CouncilResult> {
  runSignal.throwIfAborted()
  const contextConfig = normalizeContextConfig(config)
  const stageMaterials: StageMaterial[] = []
  const prepareStage = (material: StageMaterial, models: readonly ModelRef[]): ReadonlyMap<string, ChildContext> => {
    if (prepared === undefined) throw new Error('Chat preparation is required')
    if (material.packetHash !== prepared.packetRecord.packetHash) throw new Error('Stage packet identity changed')
    const serializedPayload = canonicalJson(material.payload)
    const binding = Object.freeze({ packetHash: material.packetHash, payloadHash: material.payloadHash, serializedPayload })
    const contexts = new Map<string, ChildContext>()
    // Every participant passes with the same actual payload before ANY starts.
    for (const model of models) {
      const budget = prepared.budgets.requests.find(row => row.stage === material.stage && row.model.key === model.key)
      if (budget === undefined) throw new Error('Stage model has no approved budget')
      assertStageMaterialBudget({ budget, serializedMaterial: serializedPayload, estimator: prepared.estimator })
      contexts.set(model.key, Object.freeze({ packetRecord: prepared.packetRecord, material: binding, budget, estimator: prepared.estimator }))
    }
    runSignal.throwIfAborted()
    runtime.material?.(material)
    stageMaterials.push(material)
    return contexts
  }
  const chatFields = (material: StageMaterial | undefined, contexts: ReadonlyMap<string, ChildContext> | undefined, model: ModelRef):
    Partial<Pick<ChildRequest, 'context' | 'prompt' | 'persona' | 'maxTokens'>> => {
    if (material === undefined) return {}
    const context = contexts?.get(model.key)
    if (context === undefined) throw new Error('Missing stage context binding')
    return { context, prompt: chatStagePrompt(material, copy), persona: chatStagePersona(material.stage, copy), maxTokens: context.budget.maxOutputTokens }
  }
  const answerMaterial = prepared === undefined ? undefined : createStageMaterial({ stage: 'answer', payload: { packet: prepared.packetRecord.packet } })
  const answerContexts = answerMaterial === undefined ? undefined : prepareStage(answerMaterial, selection.answerers)

  const answerRequests = selection.answerers.map((model, index): ChildRequest => ({
    stage: 'answer',
    label: copy.childAnswer(index, model.key),
    model,
    prompt: answerPrompt(selection.question, copy),
    persona: copy.answerPersona,
    maxTokens: config.answerMaxTokens,
    timeoutMs: config.childTimeoutMs,
    signal: runSignal,
    ...chatFields(answerMaterial, answerContexts, model),
  }))
  const answerSettlements = await runStage(runtime, answerRequests, copy)
  runSignal.throwIfAborted()
  const successfulAnswers: { model: ModelRef; outcome: ChildOutcome }[] = []
  answerSettlements.forEach((settlement, index) => {
    const model = selection.answerers[index] as ModelRef
    if (settlement.status === 'rejected') failures.push(thrownFailure('answer', model, settlement.reason, copy))
    else if (settlement.value.stopReason !== 'completed' || settlement.value.text.trim() === '') {
      failures.push(childFailure('answer', model, {
        ...settlement.value,
        ...(settlement.value.stopReason === 'completed' ? { diagnostic: copy.emptyAnswer } : {}),
      }, copy))
    } else {
      try {
        if (prepared !== undefined) assertArtifactBudget({
          stage: 'answer', serializedArtifact: settlement.value.text, config: contextConfig,
          estimator: prepared.estimator, model, maxOutputTokens: answerRequests[index]?.maxTokens ?? config.answerMaxTokens,
        })
        successfulAnswers.push({ model, outcome: settlement.value })
      } catch (error: unknown) {
        failures.push(thrownFailure('answer', model, error, copy))
      }
    }
  })
  if (successfulAnswers.length === 0) {
    throw new CouncilRunError(copy.noAnswers, directory.failures, failures)
  }

  const answers: AnswerRecord[] = shuffle(successfulAnswers, () => runtime.random()).map((entry, index) => ({
    answerId: copy.answerId(index),
    model: entry.model,
    text: prepared === undefined ? entry.outcome.text.trim() : entry.outcome.text,
    ...(entry.outcome.childId === undefined ? {} : { childId: entry.outcome.childId }),
  }))
  const answerIds = answers.map(answer => answer.answerId)
  const answerCorpus = prepared === undefined ? undefined : createAnswerCorpus(answers)
  const reviewMaterial = prepared === undefined || answerCorpus === undefined ? undefined : createStageMaterial({
    stage: 'review', payload: { packet: prepared.packetRecord.packet, answerCorpus },
  })
  const reviewContexts = reviewMaterial === undefined ? undefined : prepareStage(reviewMaterial, selection.reviewers)
  const reviewRequests = selection.reviewers.map((model, index): ChildRequest => ({
    stage: 'review',
    label: copy.childReview(index, model.key),
    model,
    prompt: reviewPrompt(selection.question, answers, copy),
    persona: copy.reviewPersona,
    maxTokens: config.reviewMaxTokens,
    outputSchema: prepared === undefined ? reviewerSchema(answerIds) : chatReviewerSchema(answerIds),
    timeoutMs: config.childTimeoutMs,
    signal: runSignal,
    ...chatFields(reviewMaterial, reviewContexts, model),
  }))
  const reviewSettlements = await runStage(runtime, reviewRequests, copy)
  runSignal.throwIfAborted()
  const reviews: ReviewRecord[] = []
  reviewSettlements.forEach((settlement, index) => {
    const model = selection.reviewers[index] as ModelRef
    if (settlement.status === 'rejected') {
      failures.push(thrownFailure('review', model, settlement.reason, copy))
      return
    }
    const output = settlement.value.stopReason === 'completed'
      ? (prepared === undefined ? parseReviewerOutput(settlement.value.structured, answerIds) : parseChatReviewerOutput(settlement.value.structured, answerIds))
      : undefined
    if (output === undefined) {
      failures.push(childFailure('review', model, {
        ...settlement.value,
        ...(settlement.value.stopReason === 'completed' ? { diagnostic: copy.invalidReview } : {}),
      }, copy))
      return
    }
    if (prepared !== undefined) {
      try {
        assertArtifactBudget({ stage: 'review', serializedArtifact: canonicalJson(output), config: contextConfig,
          estimator: prepared.estimator, model, maxOutputTokens: reviewRequests[index]?.maxTokens ?? config.reviewMaxTokens })
      } catch (error: unknown) {
        failures.push(thrownFailure('review', model, error, copy))
        return
      }
    }
    reviews.push({
      reviewId: copy.reviewId(index),
      model,
      output,
      ...(settlement.value.childId === undefined ? {} : { childId: settlement.value.childId }),
    })
  })
  if (reviews.length === 0) {
    throw new CouncilRunError(copy.noReviews, directory.failures, failures)
  }

  const aggregateRanking = aggregateRankings(reviews)
  const arbiterMaterial = prepared === undefined || answerCorpus === undefined ? undefined : createStageMaterial({
    stage: 'arbiter', payload: { packet: prepared.packetRecord.packet, answerCorpus, reviewCorpus: createReviewCorpus(reviews), aggregateRanking },
  })
  const arbiterContexts = arbiterMaterial === undefined ? undefined : prepareStage(arbiterMaterial, [selection.arbiter])
  const arbiterRequest: ChildRequest = {
    stage: 'arbiter',
    label: copy.childArbiter(selection.arbiter.key),
    model: selection.arbiter,
    prompt: arbiterPrompt(selection.question, answers, reviews, aggregateRanking, copy),
    persona: copy.arbiterPersona,
    maxTokens: config.arbiterMaxTokens,
    outputSchema: prepared === undefined ? arbiterSchema : chatArbiterSchema(prepared.packetRecord.packet.sources.map(source => source.alias)),
    timeoutMs: config.childTimeoutMs,
    signal: runSignal,
    ...chatFields(arbiterMaterial, arbiterContexts, selection.arbiter),
  }
  let arbiterOutcome: ChildOutcome
  try {
    arbiterOutcome = await runChild(runtime, arbiterRequest, copy)
  } catch (error: unknown) {
    failures.push(thrownFailure('arbiter', selection.arbiter, error, copy))
    throw new CouncilRunError(copy.arbiterFailed, directory.failures, failures)
  }
  runSignal.throwIfAborted()
  const decision: ArbiterDecision | undefined = prepared !== undefined && arbiterOutcome.stopReason === 'completed'
    ? parseArbiterDecision(arbiterOutcome.structured, prepared.packetRecord.packet.sources.map(source => source.alias)) : undefined
  const arbiter: ArbiterOutput | undefined = prepared === undefined
    ? (arbiterOutcome.stopReason === 'completed' ? parseArbiterOutput(arbiterOutcome.structured) : undefined) : decision
  if (arbiter === undefined) {
    failures.push(childFailure('arbiter', selection.arbiter, {
      ...arbiterOutcome,
      ...(arbiterOutcome.stopReason === 'completed' ? { diagnostic: copy.invalidArbiter } : {}),
    }, copy))
    throw new CouncilRunError(copy.arbiterInvalid, directory.failures, failures)
  }

  if (prepared !== undefined) {
    try {
      assertArtifactBudget({ stage: 'arbiter', serializedArtifact: canonicalJson(arbiter), config: contextConfig,
        estimator: prepared.estimator, model: selection.arbiter, maxOutputTokens: arbiterRequest.maxTokens })
    } catch (error: unknown) {
      failures.push(thrownFailure('arbiter', selection.arbiter, error, copy))
      throw new CouncilRunError(copy.arbiterInvalid, directory.failures, failures)
    }
  }
  runSignal.throwIfAborted()
  const modelReturn = prepared === undefined || decision === undefined ? undefined : createModelReturn({
    runId: prepared.packetRecord.runId,
    packetHash: prepared.packetRecord.packetHash,
    decision,
    sourceAliases: prepared.packetRecord.packet.sources.map(source => source.alias),
    coverage: { answerersRequested: selection.answerers.length, answerersSucceeded: answers.length,
      reviewersRequested: selection.reviewers.length, reviewersSucceeded: reviews.length },
    limitations: [
      copy.locale === 'zh' ? '本轮未联网，未读取文件或附件正文；来源引用仅为 reported，未独立核验。' : 'No Web access or file/attachment reading in this run. Citations are reported, not independently verified.',
      ...(prepared.packetRecord.pendingPolicy === 'surface-only-user-approved' ? [copy.locale === 'zh' ? '用户同意仅使用已准入历史；当前待准入结果可能遗漏。' : 'User approved surface-only history; pending results may be missing.'] : []),
      ...(prepared.packetRecord.packet.omissions.length > 0 ? [copy.locale === 'zh' ? `有 ${prepared.packetRecord.packet.omissions.length} 项材料省略说明，背景不代表全部历史。` : `${prepared.packetRecord.packet.omissions.length} material omission notices; background does not represent the entire history.`] : []),
      ...(failures.length > 0 ? [copy.locale === 'zh' ? '部分参与者失败；以上覆盖人数按实际成功产物计算。' : 'Some participants failed; coverage counts only successful artifacts.'] : []),
    ],
  })
  return {
    selection,
    directoryFailures: directory.failures,
    answers,
    reviews,
    aggregateRanking,
    arbiter,
    failures,
    ...(prepared === undefined ? {} : { packetRecord: prepared.packetRecord, stageMaterials: Object.freeze(stageMaterials) }),
    ...(modelReturn === undefined ? {} : { modelReturn }),
  }
}
