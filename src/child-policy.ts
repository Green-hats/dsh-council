import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { canonicalJson, sha256Canonical } from './context-packet.js'
import { sha256Schema, providerRouteSchema } from './context-types.js'
import { councilChildBindingSchema, type CouncilChildBinding } from './run-records.js'

const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const identifier = z.string().min(1).max(512)
const personaSchema = z.string().min(1).max(32_768).refine(value => value.trim() !== '')
const legacyPolicySchema = z.object({
  version: z.literal(1), childId: identifier, parentId: identifier, persona: personaSchema, maxTokens: positive.optional(),
}).strict()
export const childBudgetPolicySchema = z.object({
  contextWindow: positive, maxOutputTokens: positive,
  safetyMarginTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  estimatorVersion: z.string().min(1).max(128),
}).strict().refine(value => value.maxOutputTokens + value.safetyMarginTokens < value.contextWindow, 'Invalid persisted request budget')
const commonV2 = {
  version: z.literal(2), policyVersion: z.literal(2), childId: identifier, parentId: identifier,
  runId: identifier, persona: personaSchema, maxTokens: positive,
  approvedRoute: providerRouteSchema,
  // Activation-scoped structured_output is deliberately not a permanent global permission.
  allowedGlobalTools: z.array(z.enum(['web_search', 'web_fetch'])).max(2).refine(value => new Set(value).size === value.length),
}
export const councilChildPolicyV2Schema = z.discriminatedUnion('mode', [
  z.object({ ...commonV2, mode: z.literal('chat'), packetHash: sha256Schema, budgetPolicy: childBudgetPolicySchema }).strict()
    .refine(value => value.allowedGlobalTools.length === 0 && value.maxTokens <= value.budgetPolicy.maxOutputTokens, 'Chat policy cannot expand tools or output'),
  z.object({ ...commonV2, mode: z.literal('topic-only'), budgetPolicy: childBudgetPolicySchema.optional() }).strict()
    .refine(value => value.budgetPolicy === undefined || value.maxTokens <= value.budgetPolicy.maxOutputTokens, 'Invalid output cap'),
])
export const councilChildPolicySchema = z.union([legacyPolicySchema, councilChildPolicyV2Schema])
export type CouncilChildPolicyV2 = z.infer<typeof councilChildPolicyV2Schema>
export type CouncilChildPolicy = z.infer<typeof councilChildPolicySchema>
interface CouncilChildPolicyState {
  readonly childId: string
  readonly parentId: string | null
  readonly inheritedCount: number
  readonly policy: CouncilChildPolicy | null
  readonly binding: CouncilChildBinding | null
  readonly bad: boolean
}
declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap { 'dsh-council:child-policy': CouncilChildPolicyState }
}
const POLICY_KEY = 'dsh-council:child-policy'
const POLICY_ERROR = 'dsh-council: invalid persisted child policy'
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function policyFromMessage(value: unknown): CouncilChildPolicy | null | 'bad' {
  if (!record(value) || !record(value.source) || value.source.kind !== 'dsh-council' || !Object.hasOwn(value.source, 'childPolicy')) return null
  if (Object.keys(value.source).some(key => !['kind', 'childPolicy'].includes(key))
    || value.role !== 'user' || !Array.isArray(value.content) || value.content.length !== 0) return 'bad'
  const parsed = councilChildPolicySchema.safeParse(value.source.childPolicy)
  return parsed.success ? parsed.data : 'bad'
}
function bindingFromMessage(value: unknown): CouncilChildBinding | null | 'bad' {
  if (!record(value) || !record(value.source) || value.source.kind !== 'dsh-council' || !Object.hasOwn(value.source, 'childBinding')) return null
  if (Object.keys(value.source).some(key => !['kind', 'childBinding'].includes(key)) || value.role !== 'user' || !Array.isArray(value.content) || value.content.length !== 0) return 'bad'
  const parsed = councilChildBindingSchema.safeParse(value.source.childBinding)
  return parsed.success ? parsed.data : 'bad'
}
export function childBindingForPolicy(policy: CouncilChildPolicyV2): CouncilChildBinding {
  return councilChildBindingSchema.parse({ version: 2, runId: policy.runId, parentSessionId: policy.parentId, childId: policy.childId,
    mode: policy.mode, policyVersion: 2, policyHash: sha256Canonical(policy), ...('packetHash' in policy ? { packetHash: policy.packetHash } : {}) })
}
function accept(state: CouncilChildPolicyState, message: unknown): CouncilChildPolicyState {
  const policy = policyFromMessage(message)
  const binding = bindingFromMessage(message)
  if (policy === null && binding === null) return state
  if (policy === 'bad' || binding === 'bad') return { ...state, bad: true }
  let next = state
  if (binding !== null) {
    if (binding.childId !== state.childId || binding.parentSessionId !== state.parentId
      || state.binding !== null && canonicalJson(state.binding) !== canonicalJson(binding)) return { ...state, bad: true }
    if (state.binding === null) next = { ...next, binding }
  }
  if (policy !== null) {
    if (policy.childId !== state.childId || policy.parentId !== state.parentId
      || state.policy !== null && canonicalJson(policy) !== canonicalJson(state.policy)) return { ...state, bad: true }
    if (state.policy === null) next = { ...next, policy }
  }
  if (next.binding !== null && next.policy !== null && (next.policy.version !== 2 || canonicalJson(childBindingForPolicy(next.policy)) !== canonicalJson(next.binding))) return { ...state, bad: true }
  return next
}
const projection: ProjectionDefinition<typeof POLICY_KEY> = {
  key: POLICY_KEY, stateVersion: 3,
  stateSchema: z.object({ childId: identifier, parentId: identifier.nullable(), inheritedCount: z.number().int().min(0), policy: councilChildPolicySchema.nullable(), binding: councilChildBindingSchema.nullable(), bad: z.boolean() }).strict(),
  init: (header, inheritedCount) => ({ childId: String(header.id), parentId: header.parentSession === undefined ? null : String(header.parentSession), inheritedCount, policy: null, binding: null, bad: false }),
  apply(state, event) {
    if (state.bad || event.seq < state.inheritedCount) return state
    if (event.type === 'user/message') return accept(state, event.data)
    if (event.type !== 'agent/inbox/spliced' || !Array.isArray(event.data.inserted)) return state
    let next = state
    for (const message of event.data.inserted) { next = accept(next, message); if (next.bad) break }
    return next
  },
}
export function registerCouncilChildPolicy(ctx: Context): void { ctx.sessionProjections.register(projection) }
export function readCouncilChildPolicy(ctx: Context, agent: Pick<Agent, 'session'>): CouncilChildPolicy | undefined {
  const state = ctx.sessionProjections.stateOf(agent.session, POLICY_KEY)
  if (state === undefined) throw new Error('dsh-council: child policy projection unavailable')
  if (state.bad || state.binding !== null && state.policy === null || state.policy?.version === 2 && state.binding === null) throw new Error(POLICY_ERROR)
  return state.policy ?? undefined
}
export function recordCouncilChildPolicy(agent: Pick<Agent, 'id' | 'session' | 'inject'>, persona: string, maxTokens?: number): void {
  const parsed = legacyPolicySchema.safeParse({ version: 1, childId: String(agent.id), parentId: agent.session.header.parentSession, persona, ...(maxTokens === undefined ? {} : { maxTokens }) })
  if (!parsed.success) throw new Error(POLICY_ERROR)
  agent.inject(createUserMessage({ content: [], source: { kind: 'dsh-council', childPolicy: parsed.data } }))
}
type CouncilPolicyInput<T> = T extends object ? Omit<T, 'childId' | 'parentId'> : never
export function recordCouncilChildPolicyV2(agent: Pick<Agent, 'id' | 'session' | 'inject'>, policy: CouncilPolicyInput<CouncilChildPolicyV2>): void {
  const parsed = councilChildPolicyV2Schema.safeParse({ ...policy, childId: String(agent.id), parentId: agent.session.header.parentSession })
  if (!parsed.success) throw new Error(POLICY_ERROR)
  agent.inject(createUserMessage({ content: [], source: { kind: 'dsh-council', childBinding: childBindingForPolicy(parsed.data) } }))
  agent.inject(createUserMessage({ content: [], source: { kind: 'dsh-council', childPolicy: parsed.data } }))
}
/** Empty policy records never become ordinary model input. Unknown metadata is not swallowed. */
export function isCouncilChildPolicyMarker(value: unknown): boolean { const policy = policyFromMessage(value); const binding = bindingFromMessage(value); return policy !== null && policy !== 'bad' || binding !== null && binding !== 'bad' }
