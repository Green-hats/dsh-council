import { z } from 'zod'
import type { ExportSource, PrivateSourceRef, ContextPacket } from './context-types.js'
import { hashText } from './context-packet.js'
import { renderModelReturn } from './handoff.js'
import { councilResultV2Schema } from './run-records.js'

export type CaptureErrorCode = 'CAPABILITY_UNAVAILABLE' | 'INBOX_UNAVAILABLE' | 'PARENT_BUSY' | 'CONTEXT_UNSTABLE' | 'CONTEXT_TOO_LARGE' | 'SOURCE_CONFLICT' | 'SOURCE_WITHDRAWN'
export class ContextCaptureError extends Error {
  constructor(readonly code: CaptureErrorCode, message: string) { super(message); this.name = 'ContextCaptureError' }
}
export interface CaptureCandidate {
  readonly source: ExportSource
  readonly privateRef: PrivateSourceRef
  readonly defaultSelected: boolean
}
export interface ContextCapture {
  readonly capturedThroughSeq: number
  readonly pendingPolicy: 'included' | 'surface-only-user-approved'
  readonly candidates: readonly CaptureCandidate[]
  readonly omissions: ContextPacket['omissions']
  readonly attachments: ContextPacket['attachments']
}
export interface CaptureLimits {
  readonly contextCaptureAttempts: number
  readonly contextMaxSources: number
  readonly contextCandidateMaxBytes: number
}
/** Compatibility stays here: callers pass public services, never framework internals. */
export interface CaptureParent {
  readonly id: string
  readonly status?: unknown
  readonly session: { readonly seq: number; deriveMessages?: () => unknown }
}
export interface CaptureRegistry {
  get(id: string): unknown
  roots(): readonly unknown[]
}
export interface CaptureProjections {
  snapshot(session: CaptureParent['session'], keys: readonly string[]): unknown
}
const shortId = z.string().min(1).max(1024)
const questionSchema = z.object({ version: z.literal(1), commandId: shortId, text: z.string().min(1).max(65_536) }).strict()
const presentationSchema = z.object({ answerMarkdown: z.string().min(1).max(65_536), auditMarkdown: z.string().max(524_288) }).strict()
const v1ResultSchema = z.object({ version: z.literal(1), commandId: shortId, status: z.enum(['success', 'error', 'canceled']), presentation: presentationSchema.optional() }).strict()
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function fail(code: CaptureErrorCode, message: string): never { throw new ContextCaptureError(code, message) }
function exactRoot(parent: CaptureParent, registry: CaptureRegistry | undefined): void {
  if (!registry || typeof registry.get !== 'function' || typeof registry.roots !== 'function') fail('CAPABILITY_UNAVAILABLE', 'Exact live root registry is unavailable')
  if (registry.get(parent.id) !== parent || !registry.roots().includes(parent)) fail('PARENT_BUSY', 'The parent is not the exact live runtime root')
}
function assertIdle(parent: CaptureParent): void {
  if (parent.status !== 'idle' && parent.status !== 'running') fail('CAPABILITY_UNAVAILABLE', 'Live parent status is unavailable')
  if (parent.status !== 'idle') fail('PARENT_BUSY', 'The main session is running; complete capture is not currently safe')
}
interface PlainMessage { id: string; role: string; content: readonly unknown[]; source: Record<string, unknown> }
function message(value: unknown, pending: boolean): PlainMessage {
  if (!record(value) || typeof value.id !== 'string' || !shortId.safeParse(value.id).success
    || typeof value.role !== 'string' || !Array.isArray(value.content) || !record(value.source)
    || typeof value.source.kind !== 'string' || (pending && value.role !== 'user')) {
    return fail(pending ? 'INBOX_UNAVAILABLE' : 'CAPABILITY_UNAVAILABLE', 'Invalid message envelope in live capture')
  }
  return { id: value.id, role: value.role, content: value.content, source: value.source }
}
function parseInbox(value: unknown): PlainMessage[] {
  if (!record(value) || Object.keys(value).length !== 2 || !Array.isArray(value['next-turn']) || !Array.isArray(value['next-step'])) {
    return fail('INBOX_UNAVAILABLE', 'The authoritative Inbox projection is unavailable or malformed')
  }
  const messages = [...value['next-turn'], ...value['next-step']].map(item => message(item, true))
  if (new Set(messages.map(item => item.id)).size !== messages.length) fail('INBOX_UNAVAILABLE', 'Duplicate pending message IDs')
  return messages
}
interface Extracted {
  kind: ExportSource['kind']; epistemic: ExportSource['epistemic']; blocks: { text: string; blockIndex: number }[]; priorRunId?: string; recordKind?: 'question' | 'result'
}
/** Never parse a combined historical audit by Markdown headings. */
function councilText(msg: PlainMessage): Extracted | undefined {
  const source = msg.source
  if (msg.role !== 'user' || Object.keys(source).some(key => !['kind', 'question', 'result'].includes(key))) return undefined
  if (source.question !== undefined && source.result === undefined) {
    const parsed = questionSchema.safeParse(source.question)
    if (!parsed.success) return undefined
    const actual = msg.content.filter(block => record(block) && block.type === 'text').map(block => record(block) ? block.text : '').join('')
    if (actual !== parsed.data.text) fail('SOURCE_CONFLICT', 'Council question content does not match its source')
    return { kind: 'user-text', epistemic: 'user-asserted', blocks: [{ text: parsed.data.text, blockIndex: 0 }], priorRunId: parsed.data.commandId, recordKind: 'question' }
  }
  if (source.result === undefined || source.question !== undefined) return undefined
  const legacy = v1ResultSchema.safeParse(source.result)
  if (legacy.success) {
    if (legacy.data.status !== 'success' || !legacy.data.presentation) return undefined
    return { kind: 'prior-council-result', epistemic: 'prior-council-advice', blocks: [{ text: legacy.data.presentation.answerMarkdown, blockIndex: 0 }], priorRunId: legacy.data.commandId, recordKind: 'result' }
  }
  const parsed = councilResultV2Schema.safeParse(source.result)
  if (!parsed.success || parsed.data.status !== 'success') return undefined
  const result = parsed.data.modelReturn
  const block = msg.content[0]
  if (msg.content.length !== 1 || !record(block) || block.type !== 'text' || block.text !== renderModelReturn(result, parsed.data.locale)) fail('SOURCE_CONFLICT', 'Council result content does not match its ModelReturn')
  return { kind: 'prior-council-result', epistemic: 'prior-council-advice', blocks: [{ text: renderModelReturn(result, parsed.data.locale), blockIndex: 0 }], priorRunId: result.runId, recordKind: 'result' }
}
function ordinaryText(msg: PlainMessage): Extracted | undefined {
  const kind = msg.role === 'user' && msg.source.kind === 'user' ? 'user-text'
    : msg.role === 'assistant' && msg.source.kind === 'model' ? 'assistant-proposal'
      : msg.role === 'tool' && msg.source.kind === 'tool' ? 'tool-evidence' : undefined
  if (!kind) return undefined
  const epistemic = kind === 'user-text' ? 'user-asserted' : kind === 'assistant-proposal' ? 'assistant-unverified' : 'tool-observed'
  const blocks: Extracted['blocks'] = []
  msg.content.forEach((block, blockIndex) => {
    if (record(block) && block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') blocks.push({ text: block.text, blockIndex })
  })
  return { kind, epistemic, blocks }
}
function extract(parentId: string, admitted: readonly PlainMessage[], pending: readonly PlainMessage[], limits: CaptureLimits): Omit<ContextCapture, 'capturedThroughSeq' | 'pendingPolicy'> {
  const candidates: CaptureCandidate[] = []
  const omissions = new Map<string, string>()
  const attachments: ContextPacket['attachments'] = []
  const seenMessages = new Map<string, string>()
  const logical = new Map<string, string>()
  let bytes = 0
  const addBytes = (text: string): void => {
    bytes += Buffer.byteLength(text, 'utf8')
    if (bytes > limits.contextCandidateMaxBytes) fail('CONTEXT_TOO_LARGE', 'Local context candidates exceed the byte limit; choose topic-only or supply shorter background')
  }
  for (const [origin, messages] of [['surface', admitted], ['pending', pending]] as const) {
    for (const msg of messages) {
      // Council gets a dedicated reader first; an unknown variant never falls through.
      if (origin === 'pending' && msg.source.kind !== 'dsh-council') {
        omissions.set('pending-unselected', 'Ordinary queued input and other producers are not exported')
        continue
      }
      if (record(msg.source.result) && msg.source.result.version === 2 && msg.source.result.parentSessionId !== parentId) {
        omissions.set('cross-session', 'A Council source bound to another parent was excluded')
        continue
      }
      const selected = msg.source.kind === 'dsh-council' ? councilText(msg) : ordinaryText(msg)
      if (!selected) {
        omissions.set('excluded-source', 'System/developer/runtime context, unknown producers, policy/progress markers and inseparable legacy audits are excluded')
        continue
      }
      // Detect reused identities without copying private source/provider metadata.
      const signature = hashText(JSON.stringify({ role: msg.role, kind: selected.kind, blocks: selected.blocks }))
      const previous = seenMessages.get(msg.id)
      if (previous !== undefined) {
        if (previous !== signature) fail('SOURCE_CONFLICT', 'One message ID has conflicting content')
        continue
      }
      seenMessages.set(msg.id, signature)
      if (selected.priorRunId !== undefined && selected.recordKind !== undefined) {
        const key = JSON.stringify([parentId, selected.priorRunId, selected.recordKind])
        const prior = logical.get(key)
        if (prior !== undefined) {
          if (prior !== signature) fail('SOURCE_CONFLICT', 'One Council logical record has conflicting content')
          continue
        }
        logical.set(key, signature)
      }
      for (const block of msg.content) {
        if (record(block) && ['image', 'file'].includes(String(block.type))) {
          const name = record(block.attachment) && typeof block.attachment.name === 'string' ? block.attachment.name : 'unnamed attachment'
          addBytes(name)
          if (name.length > 256 || attachments.length >= 64) fail('CONTEXT_TOO_LARGE', 'Attachment reference metadata exceeds capture limits')
          attachments.push({ name, disposition: 'reference-only' })
          omissions.set('attachments', 'Attachment bodies are not read, OCRed or exported')
        } else if (record(block) && block.type !== 'text') omissions.set('non-text', 'Reasoning, tool arguments and other non-text blocks are excluded')
      }
      for (const block of selected.blocks) {
        if (candidates.length >= limits.contextMaxSources) fail('CONTEXT_TOO_LARGE', 'Too many context sources; choose topic-only or supply shorter background')
        addBytes(block.text)
        const alias = `S${candidates.length + 1}`
        candidates.push({
          source: { alias, kind: selected.kind, epistemic: selected.epistemic, text: block.text },
          privateRef: { alias, parentSessionId: parentId, origin, messageId: msg.id, blockIndex: block.blockIndex, textHash: hashText(block.text), ...(selected.kind !== 'prior-council-result' || selected.priorRunId === undefined ? {} : { priorRunId: selected.priorRunId }) },
          defaultSelected: selected.kind !== 'tool-evidence',
        })
      }
    }
  }
  return { candidates, attachments, omissions: [...omissions].map(([reason, description]) => ({ reason, description })) }
}
/** One synchronous capture attempt: no await, persistence, model call or Inbox writes. */
function captureOnce(parent: CaptureParent, registry: CaptureRegistry | undefined, projections: CaptureProjections | undefined, signal: AbortSignal, limits: CaptureLimits, surfaceOnly: boolean): ContextCapture {
  signal.throwIfAborted()
  exactRoot(parent, registry)
  assertIdle(parent)
  const session = parent.session
  if (typeof session.deriveMessages !== 'function') fail('CAPABILITY_UNAVAILABLE', 'Live Session.deriveMessages is unavailable')
  const before = Number(session.seq)
  if (!Number.isSafeInteger(before) || before < 0) fail('CAPABILITY_UNAVAILABLE', 'Invalid live Session offset')
  const raw = session.deriveMessages()
  if (!Array.isArray(raw)) fail('CAPABILITY_UNAVAILABLE', 'Invalid effective message list')
  let cut = before - 1
  let pending: PlainMessage[] = []
  if (!surfaceOnly) {
    if (!projections || typeof projections.snapshot !== 'function') fail('INBOX_UNAVAILABLE', 'Authoritative Inbox snapshots are unavailable')
    const snap = projections.snapshot(session, ['inbox'])
    if (!record(snap) || !record(snap.values) || !Number.isSafeInteger(snap.asOfSeq)) fail('INBOX_UNAVAILABLE', 'Invalid authoritative Inbox snapshot')
    cut = Number(snap.asOfSeq)
    pending = parseInbox(snap.values.inbox)
  }
  const extracted = extract(parent.id, raw.map(item => message(item, false)), pending, limits)
  const detached = structuredClone(extracted)
  const after = Number(session.seq)
  exactRoot(parent, registry)
  assertIdle(parent)
  if (parent.session !== session) fail('PARENT_BUSY', 'The parent Session instance changed')
  if (before !== after || cut !== before - 1) fail('CONTEXT_UNSTABLE', 'Session and Inbox did not form a stable cut')
  signal.throwIfAborted()
  return { capturedThroughSeq: cut, pendingPolicy: surfaceOnly ? 'surface-only-user-approved' : 'included', ...detached }
}
/** Only unstable cuts retry, without sleep. Surface-only requires an explicit caller consent. */
export function captureLiveContext(parent: CaptureParent, registry: CaptureRegistry | undefined, projections: CaptureProjections | undefined, signal: AbortSignal, limits: CaptureLimits, surfaceOnlyUserApproved = false): ContextCapture {
  if (!Number.isSafeInteger(limits.contextCaptureAttempts) || limits.contextCaptureAttempts < 1 || limits.contextCaptureAttempts > 3
    || !Number.isSafeInteger(limits.contextMaxSources) || limits.contextMaxSources < 1 || limits.contextMaxSources > 64
    || !Number.isSafeInteger(limits.contextCandidateMaxBytes) || limits.contextCandidateMaxBytes < 1 || limits.contextCandidateMaxBytes > 524_288) throw new Error('Invalid capture limits')
  for (let attempt = 0; attempt < limits.contextCaptureAttempts; attempt += 1) {
    try { return captureOnce(parent, registry, projections, signal, limits, surfaceOnlyUserApproved) }
    catch (error) { if (!(error instanceof ContextCaptureError) || error.code !== 'CONTEXT_UNSTABLE' || attempt + 1 === limits.contextCaptureAttempts) throw error }
  }
  throw new Error('Unreachable capture attempt')
}
/** Re-capture current effective state before export, but never append new sources to the frozen packet. */
export function assertSelectedSourcesCurrent(selected: readonly PrivateSourceRef[], current: ContextCapture, exportedSources?: readonly ExportSource[], attachments?: ContextPacket['attachments']): void {
  const remaining = current.attachments.map(attachment => JSON.stringify([attachment.name, attachment.disposition]))
  for (const attachment of attachments ?? []) {
    const position = remaining.indexOf(JSON.stringify([attachment.name, attachment.disposition]))
    if (position < 0) fail('SOURCE_WITHDRAWN', 'An attachment reference was removed or changed; capture and confirm again')
    remaining.splice(position, 1)
  }
  for (const reference of selected) {
    const candidate = current.candidates.find(item => item.privateRef.parentSessionId === reference.parentSessionId
      && item.privateRef.messageId === reference.messageId && item.privateRef.blockIndex === reference.blockIndex
      && item.privateRef.priorRunId === reference.priorRunId)
    const exported = exportedSources?.find(source => source.alias === reference.alias)
    if (!candidate || candidate.privateRef.textHash !== reference.textHash || exported !== undefined && (exported.kind !== candidate.source.kind || exported.epistemic !== candidate.source.epistemic)) fail('SOURCE_WITHDRAWN', 'A selected source was removed or changed; capture and confirm again')
  }
}
