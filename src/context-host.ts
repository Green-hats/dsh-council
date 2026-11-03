import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionLogOffset, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { COUNCIL_RUN_RECORDS_KEY, findCouncilChildBinding, findChildBindingInState, type CouncilChildBinding } from './run-records.js'
import { captureLiveContext, type CaptureParent, type CaptureProjections, type CaptureRegistry, type ContextCapture } from './context-capture.js'
import { resolveContextWindow, type ContextConfig, type ContextModel, type ContextTokenEstimator } from './context-budget.js'
import type { CouncilSelection } from './types.js'

/** Optional modern capabilities are narrowed once, rather than asserted throughout the plugin. */
export function captureCurrentContext(ctx: Context, parent: Agent, config: ContextConfig, signal: AbortSignal, surfaceOnlyUserApproved = false): ContextCapture {
  const agents = ctx.get('agents', false) as unknown as CaptureRegistry | undefined
  const projections = ctx.sessionProjections as unknown as CaptureProjections
  return captureLiveContext(parent as unknown as CaptureParent, agents, projections, signal, config, surfaceOnlyUserApproved)
}
export function contextEstimator(ctx: Context): ContextTokenEstimator {
  const meter = ctx.get('tokenMeter', false) as { estimateMessage?: (message: unknown) => number } | undefined
  if (!meter || typeof meter.estimateMessage !== 'function') throw new Error('dsh-council: reliable token estimation capability is unavailable')
  return {
    version: 'dsh-token-meter:v1',
    estimateMessage(message) {
      // TokenMeter reads the message envelope; no history or provider metadata is exported.
      return meter.estimateMessage!({ id: 'council-token-estimate', ...message })
    },
  }
}
interface ModelInfoResolver { resolveModelInfo?: (provider: string, model: string, signal?: AbortSignal) => Promise<unknown> }
export async function resolveContextWindows(ctx: Context, selection: CouncilSelection, config: ContextConfig, signal: AbortSignal): Promise<ReadonlyMap<string, number>> {
  const resolver = ctx.llm as unknown as ModelInfoResolver
  const models = [...new Map([...selection.answerers, ...selection.reviewers, selection.arbiter].map(model => [model.key, model])).values()]
  const resolved = await Promise.all(models.map(async model => {
    signal.throwIfAborted()
    const info = typeof resolver.resolveModelInfo === 'function' ? await resolver.resolveModelInfo(model.provider, model.model, signal) : undefined
    signal.throwIfAborted()
    return [model.key, resolveContextWindow(model, info, config.contextWindowOverrides)] as const
  }))
  return new Map(resolved)
}
/** A valid persisted window remains a ceiling, never a license to use a new route. */
export async function restoredContextWindow(ctx: Context, model: ContextModel, storedWindow: number, config: ContextConfig, signal: AbortSignal): Promise<number> {
  const resolver = ctx.llm as unknown as ModelInfoResolver
  signal.throwIfAborted()
  const info = typeof resolver.resolveModelInfo === 'function' ? await resolver.resolveModelInfo(model.provider, model.model, signal) : undefined
  signal.throwIfAborted()
  const configured = config.contextWindowOverrides[model.key]
  const override = { [model.key]: Math.min(storedWindow, configured ?? storedWindow) }
  return Math.min(storedWindow, resolveContextWindow(model, info, override))
}

interface BindingObservation {
  readonly header: SessionHeader
  readonly inheritedEventCount: number
  readonly events: readonly SessionEvent[]
  [Symbol.dispose](): void
}
interface BindingQueries {
  observeSession?(id: string, options: { signal: AbortSignal; projectionMode: 'none' }): Promise<BindingObservation>
}
/** Optional query is only for cold ownership, never an extra capture dependency. */
export async function findPersistedChildBinding(ctx: Context, child: Pick<Agent, 'id' | 'session'>, signal: AbortSignal): Promise<CouncilChildBinding | undefined> {
  signal.throwIfAborted()
  const parentId = child.session.header.parentSession
  if (parentId === undefined) return undefined
  const parent = ctx.get('agents', false)?.get(parentId)
  if (parent !== undefined) return findCouncilChildBinding(ctx, parent, String(child.id))
  const queries = ctx.get('sessionQuery', false) as unknown as BindingQueries | undefined
  if (typeof queries?.observeSession !== 'function') return undefined
  // The public registry, not plugin log scanning, owns the authoritative fold.
  const observation = await queries.observeSession(String(parentId), { signal, projectionMode: 'none' })
  try {
    signal.throwIfAborted()
    if (String(observation.header.id) !== String(parentId) || !Array.isArray(observation.events)
      || typeof observation[Symbol.dispose] !== 'function') throw new Error('dsh-council: invalid parent ownership observation')
    const restored = ctx.sessionProjections.restore({}, [...observation.events], SessionLogOffset(0), observation.header, SessionLogOffset(observation.inheritedEventCount))
    const value = restored.checkpoint[COUNCIL_RUN_RECORDS_KEY]?.val
    return findChildBindingInState(value, String(parentId), String(child.id))
  } finally {
    observation[Symbol.dispose]()
  }
}
