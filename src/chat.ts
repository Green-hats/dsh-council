import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ChildRequest } from './council.js'
import type { CouncilSelection, CouncilStage } from './types.js'
import { z } from 'zod'
import type { ModelReturn } from './context-types.js'
import type { CouncilLocale } from './locales.js'
import { councilResultV2Schema, type CouncilResultV2, type CouncilRunRecords } from './run-records.js'

export type CouncilChatStatus = 'selecting' | 'running' | 'success' | 'error' | 'canceled'
export type CouncilChatFinalStatus = Exclude<CouncilChatStatus, 'selecting' | 'running'>
export type CouncilChatParticipantStatus = 'queued' | 'starting' | 'running' | 'completed' | 'error'

/** Public role ordinal, deliberately unrelated to shuffled Answer A/B identities. */
export interface CouncilChatParticipant {
  readonly key: string
  readonly stage: CouncilStage
  readonly index: number
  readonly status: CouncilChatParticipantStatus
  readonly childId?: string
  readonly diagnostic?: string
}

/** Complete anonymous state, never a delta, model identity, prompt or child output. */
export interface CouncilUiSnapshot {
  readonly version: 1
  readonly commandId: string
  readonly status: CouncilChatStatus
  readonly question: string
  readonly participants: readonly CouncilChatParticipant[]
}

export type CouncilChatSnapshot = CouncilUiSnapshot

export interface CouncilUiSource {
  readonly kind: 'dsh-council'
  readonly ui: CouncilUiSnapshot
}

/** The real picker question, durably queued without preempting the loop's head. */
export interface CouncilQuestionSource {
  readonly version: 1
  readonly commandId: string
  readonly text: string
}

export interface CouncilQuestionMessageSource {
  readonly kind: 'dsh-council'
  readonly question: CouncilQuestionSource
}

export interface CouncilChatPresentation {
  readonly answerMarkdown: string
  readonly auditMarkdown: string
}

export interface CouncilChatResultSourceV1 {
  readonly version: 1
  readonly commandId: string
  readonly status: CouncilChatFinalStatus
  readonly presentation?: CouncilChatPresentation
}

export type CouncilChatResultSource = CouncilChatResultSourceV1 | CouncilResultV2

export interface CouncilResultSource {
  readonly kind: 'dsh-council'
  readonly result: CouncilChatResultSource
}

export interface CouncilChat {
  selected(selection: CouncilSelection): void
  start(request: Pick<ChildRequest, 'stage' | 'model'>): string
  created(key: string, childId: string): void
  settled(key: string, outcome: unknown): void
  finish(status: CouncilChatFinalStatus, text: string, presentation?: CouncilChatPresentation, handoff?: { mode: 'chat' | 'topic-only'; modelReturn?: ModelReturn }): SessionSeq
}

type ChatAgent = Pick<Agent, 'inject' | 'session'>

/**
 * The entry module owns the MessageSourceMap augmentation (including childPolicy).
 * Keep the cast at this boundary so importing this module alone also type-checks.
 * Both supported SDKs accept producer sources on ordinary user-role messages.
 */
function producerMessage(content: UserMessage['content'], source: CouncilUiSource | CouncilQuestionMessageSource | CouncilResultSource): UserMessage {
  return createUserMessage({ content, source: source as unknown as UserMessage['source'] })
}

/**
 * Persist the real picker question, UI snapshots and final producer context via
 * the existing durable inbox vocabulary, without waking the parent. Only the
 * AgentLoop may admit question/result onto the model surface: a new Session's
 * protected system head must be established before its first user-role message.
 * Empty progress metadata is removed by the parent's pre-step filter.
 */
export function createCouncilChat(agent: ChatAgent, commandId: string, records?: CouncilRunRecords, locale: CouncilLocale = 'en'): CouncilChat {
  if (commandId.trim() === '') throw new Error('Council chat requires a command id')
  let status: CouncilChatStatus = 'selecting'
  let question = ''
  let participants: readonly CouncilChatParticipant[] = []
  let selected = false
  let resultSeq: SessionSeq | undefined
  // Private routing only: these model keys never enter a UI snapshot.
  const byModel = new Map<CouncilStage, Map<string, string>>()

  const publish = (): void => {
    const ui: CouncilUiSnapshot = {
      version: 1,
      commandId,
      status,
      question,
      participants: participants.map(participant => ({ ...participant })),
    }
    // createUserMessage detaches and deep-freezes the complete metadata tree.
    agent.inject(producerMessage([], { kind: 'dsh-council', ui }))
  }

  const update = (key: string, change: (participant: CouncilChatParticipant) => CouncilChatParticipant): void => {
    if (!participants.some(participant => participant.key === key)) throw new Error('Unknown Council participant')
    participants = participants.map(participant => participant.key === key ? change(participant) : participant)
    publish()
  }

  // No constructor marker: the first progress anchor must follow the real question.
  return {
    selected(selection) {
      if (selected || status !== 'selecting') throw new Error('Council chat selection is already settled')
      if (selection.question.trim() === '') throw new Error('Council chat requires a question')
      const rows: CouncilChatParticipant[] = []
      const modelKeys = new Map<CouncilStage, Map<string, string>>()
      for (const [stage, models] of [
        ['answer', selection.answerers],
        ['review', selection.reviewers],
        ['arbiter', [selection.arbiter]],
      ] as const) {
        const keys = new Map<string, string>()
        models.forEach((model, index) => {
          if (keys.has(model.key)) throw new Error('Duplicate Council participant within one role')
          const key = `${stage}:${index + 1}`
          keys.set(model.key, key)
          rows.push({ key, stage, index: index + 1, status: 'queued' })
        })
        modelKeys.set(stage, keys)
      }
      // A user supplied this text in the picker. Queue it once before progress,
      // leaving first-surface creation and later admission to the real loop.
      agent.inject(producerMessage([{ type: 'text', text: selection.question }], {
        kind: 'dsh-council',
        question: { version: 1, commandId, text: selection.question },
      }))
      question = selection.question
      participants = rows
      for (const [stage, keys] of modelKeys) byModel.set(stage, keys)
      selected = true
      status = 'running'
      publish()
    },
    start(request) {
      if (status !== 'running') throw new Error('Council chat is not running')
      const key = byModel.get(request.stage)?.get(request.model.key)
      if (key === undefined) throw new Error('Unselected Council participant')
      update(key, participant => {
        if (participant.status !== 'queued') throw new Error('Council participant already started')
        return { ...participant, status: 'starting' }
      })
      return key
    },
    created(key, childId) {
      if (childId.trim() === '') throw new Error('Council participant requires a child id')
      update(key, participant => {
        if (participant.status === 'queued') throw new Error('Council participant has not started')
        if (participant.childId !== undefined && participant.childId !== childId) {
          throw new Error('Council participant already has a child id')
        }
        // A late startup receipt may add an address, but cannot resurrect a
        // settled participant or canceled run during descendant cleanup.
        const running = status === 'running' && participant.status === 'starting'
        return { ...participant, childId, ...(running ? { status: 'running' as const } : {}) }
      })
    },
    settled(key, outcome) {
      update(key, participant => {
        if (participant.status === 'queued') throw new Error('Council participant has not started')
        if (status !== 'running' || participant.status === 'completed' || participant.status === 'error') return participant
        const completed = typeof outcome === 'object' && outcome !== null
          && 'stopReason' in outcome && outcome.stopReason === 'completed'
        return {
          ...participant,
          status: completed ? 'completed' : 'error',
          // Provider errors and child diagnostics may reveal model identities.
          // Record only our finite, anonymous diagnostic vocabulary.
          ...(completed ? {} : { diagnostic: 'child-failed' }),
        }
      })
    },
    finish(next, text, presentation, handoff) {
      if (records !== undefined && handoff !== undefined) {
        if (resultSeq !== undefined) return resultSeq
        let prior = records.read(commandId)
        if (prior === undefined) {
          records.transition({ version: 2, runId: commandId, mode: handoff.mode, status: 'CREATED' })
          prior = records.read(commandId)
        }
        const existing = prior?.terminal
        const seq = existing?.sourceEventSeq ?? records.commitTerminal(councilResultV2Schema.parse({
          version: 2, commandId, runId: commandId, parentSessionId: String(agent.session.id), status: next,
          mode: handoff.mode, locale, ...(presentation === undefined ? {} : { presentation }),
          ...(handoff.modelReturn === undefined ? {} : { modelReturn: handoff.modelReturn }),
        }), text, locale)
        const canonical = records.read(commandId)?.terminal
        if (canonical === undefined) throw new Error('Council canonical terminal was not committed')
        resultSeq = seq as SessionSeq
        status = canonical.result.status
        participants = participants.map(participant => participant.status === 'starting' || participant.status === 'running'
          ? { ...participant, status: 'error', diagnostic: status === 'canceled' ? 'run-canceled' : 'run-ended' } : participant)
        // The real producer terminal is authoritative even if a later UI publish fails.
        publish()
        return resultSeq
      }
      if (resultSeq !== undefined) return resultSeq
      if (text.trim() === '') throw new Error('Council chat requires a final result')
      status = next
      participants = participants.map(participant => participant.status === 'starting' || participant.status === 'running'
        ? { ...participant, status: 'error', diagnostic: next === 'canceled' ? 'run-canceled' : 'run-ended' }
        : participant)
      publish()
      // inject synchronously commits the existing inbox splice at this seq.
      // Cite that real event, not an invented surface message. The canonical
      // result remains pending for ordinary loop admission on a later wake;
      // cancellation may clear pending input under the host's normal rules.
      const seq = Number(agent.session.seq) as SessionSeq
      agent.inject(producerMessage([{ type: 'text', text }], {
        kind: 'dsh-council',
        result: { version: 1, commandId, status: next, ...(presentation === undefined ? {} : { presentation }) },
      }))
      resultSeq = seq
      return resultSeq
    },
  }
}

const uiMarkerSchema = z.strictObject({
  version: z.literal(1), commandId: z.string().min(1).max(512), status: z.enum(['selecting', 'running', 'success', 'error', 'canceled']),
  question: z.string().max(65_536), participants: z.array(z.strictObject({
    key: z.string().min(1).max(64), stage: z.enum(['answer', 'review', 'arbiter']), index: z.number().int().min(1).max(8),
    status: z.enum(['queued', 'starting', 'running', 'completed', 'error']), childId: z.string().min(1).max(512).optional(),
    diagnostic: z.enum(['child-failed', 'run-canceled', 'run-ended']).optional(),
  })).max(17),
}).refine(value => new Set(value.participants.map(item => item.key)).size === value.participants.length)
export function isCouncilUiMarker(message: unknown): boolean {
  if (typeof message !== 'object' || message === null || !('role' in message) || message.role !== 'user'
    || !('content' in message) || !Array.isArray(message.content) || message.content.length !== 0 || !('source' in message)) return false
  return z.strictObject({ kind: z.literal('dsh-council'), ui: uiMarkerSchema }).safeParse(message.source).success
}
