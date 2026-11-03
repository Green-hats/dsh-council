import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionSeq } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import {
  createCouncilChat,
  type CouncilQuestionMessageSource,
  type CouncilResultSource,
  type CouncilUiSnapshot,
  type CouncilUiSource,
} from '../src/chat.js'
import type { CouncilSelection, ModelRef } from '../src/types.js'

function model(name: string): ModelRef {
  return {
    provider: 'private-provider',
    providerName: 'Private Provider',
    model: `private-model-${name}`,
    modelName: `Private Model ${name}`,
    key: `private-provider/private-model-${name}`,
    optionLabel: `Private Model ${name} — Private Provider`,
  }
}

const a = model('a')
const b = model('b')
const c = model('c')
const selection: CouncilSelection = {
  answerers: [b, a],
  reviewers: [a, c],
  arbiter: a,
  question: '用户确实通过 picker 提供的问题？\nKeep this text exactly.',
}

function uiMessages(inbox: Inbox): UserMessage[] {
  return inbox.nextStep.filter(message => (message.source as unknown as Partial<CouncilUiSource>).ui !== undefined)
}

function canonicalMessages(inbox: Inbox): UserMessage[] {
  return inbox.nextStep.filter(message => message.content.length > 0)
}

function latest(inbox: Inbox): CouncilUiSnapshot {
  const message = uiMessages(inbox).at(-1)
  if (message === undefined) throw new Error('Expected a Council UI message')
  return (message.source as unknown as CouncilUiSource).ui
}

function insertedAt(session: Session, seq: SessionSeq): UserMessage {
  const event = session.eventAt(seq)
  if (event?.type !== 'agent/inbox/spliced' || event.data.inserted[0] === undefined) {
    throw new Error('Expected the real durable inbox insertion')
  }
  return event.data.inserted[0]
}

function harness() {
  // Real SDK objects enforce the durable event and immutable snapshot contract;
  // no fake append, inbox event vocabulary, system head or turn construction.
  const session = Session.create(SessionId('council-chat-parent'))
  const notifications = { inserted: vi.fn(), discarded: vi.fn(), claimed: vi.fn() }
  const inbox = new Inbox(session, notifications)
  const inject = vi.fn((message: UserMessage) => inbox.append('next-step', message))
  const followup = vi.fn()
  const steer = vi.fn()
  const send = vi.fn()
  const agent = { session, inject, followup, steer, send } satisfies Pick<Agent, 'session' | 'inject' | 'followup' | 'steer' | 'send'>
  const append = vi.spyOn(session, 'append')
  const chat = createCouncilChat(agent, 'command-council-1')
  return { session, inbox, notifications, inject, followup, steer, send, append, chat }
}

function participant(snapshot: CouncilUiSnapshot, key: string) {
  const row = snapshot.participants.find(row => row.key === key)
  if (row === undefined) throw new Error(`Missing participant ${key}`)
  return row
}

function expectNoSurface(session: Session): void {
  expect(session.surface.nodes).toEqual([])
  expect(session.deriveMessages()).toEqual([])
  // Reopening may add the SDK's own end-seed marker; neither it nor inbox
  // mutations may reserve a surface node before the real AgentLoop starts.
  expect(session.snapshotEvents().every(event => event.type === 'agent/inbox/spliced' || event.type === 'session/end-seed')).toBe(true)
  expect(session.snapshotEvents().every(event => !('surfaceOp' in event))).toBe(true)
}

describe('Council chat durable inbox and anonymous UI state', () => {
  it('constructs without an early progress anchor or any model-driving input', () => {
    const h = harness()
    expect(h.session.snapshotEvents()).toEqual([])
    expect(h.inbox.hasPending).toBe(false)
    expect(h.inject).not.toHaveBeenCalled()
    expect(h.followup).not.toHaveBeenCalled()
    expect(h.steer).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
    expect(() => createCouncilChat({ session: h.session, inject: h.inject }, '  ')).toThrow('command id')
    expect(() => h.chat.start({ stage: 'answer', model: a })).toThrow('not running')
    expect(h.session.snapshotEvents()).toEqual([])
  })

  it('durably queues the real picker question once before the first complete anonymous snapshot', () => {
    const h = harness()
    h.chat.selected(selection)
    const events = h.session.snapshotEvents()
    expect(events.map(event => event.type)).toEqual(['agent/inbox/spliced', 'agent/inbox/spliced'])
    expect(events[0]).toMatchObject({
      type: 'agent/inbox/spliced',
      data: { target: 'next-step', start: 0, inserted: [{
        role: 'user', content: [{ type: 'text', text: selection.question }],
        source: { kind: 'dsh-council', question: { version: 1, commandId: 'command-council-1', text: selection.question } },
      }] },
    })
    expect(h.inbox.nextTurn).toEqual([])
    expect(h.inbox.nextStep).toHaveLength(2)
    expect(h.inbox.nextStep[1]).toMatchObject({ role: 'user', content: [] })
    expect(latest(h.inbox)).toEqual({
      version: 1, commandId: 'command-council-1', status: 'running', question: selection.question,
      participants: [
        { key: 'answer:1', stage: 'answer', index: 1, status: 'queued' },
        { key: 'answer:2', stage: 'answer', index: 2, status: 'queued' },
        { key: 'review:1', stage: 'review', index: 1, status: 'queued' },
        { key: 'review:2', stage: 'review', index: 2, status: 'queued' },
        { key: 'arbiter:1', stage: 'arbiter', index: 1, status: 'queued' },
      ],
    })
    const question = canonicalMessages(h.inbox)[0]
    expect(Object.isFrozen(question?.source)).toBe(true)
    expect(Object.isFrozen((question?.source as unknown as CouncilQuestionMessageSource).question)).toBe(true)
    const committed = JSON.stringify(events)
    expect(committed).not.toContain('private-provider')
    expect(committed).not.toContain('Private Model')
    expect(committed).not.toContain('Answer A')
    expect(() => h.chat.selected(selection)).toThrow('already settled')
    expect(h.session.snapshotEvents()).toHaveLength(2)
    expect(canonicalMessages(h.inbox)).toHaveLength(1)
    expectNoSurface(h.session)
  })

  it('rejects blank or duplicate-role selections before committing the question', () => {
    const h = harness()
    expect(() => h.chat.selected({ ...selection, question: ' \n' })).toThrow('requires a question')
    expect(() => h.chat.selected({ ...selection, answerers: [a, a] })).toThrow('Duplicate')
    expect(h.session.snapshotEvents()).toEqual([])
    // The same model in different roles is valid; rejected selections do not
    // leave partial routing or mark the question as already recorded.
    h.chat.selected(selection)
    expect(canonicalMessages(h.inbox)).toHaveLength(1)
    expect(latest(h.inbox).participants).toHaveLength(5)
    expectNoSurface(h.session)
  })

  it('matches requests by role and private model key, not labels or shuffled answer ids', () => {
    const h = harness()
    h.chat.selected(selection)
    const answer = h.chat.start({ stage: 'answer', model: { ...a, modelName: 'changed label' } })
    expect(answer).toBe('answer:2')
    expect(h.chat.start({ stage: 'review', model: a })).toBe('review:1')
    expect(h.chat.start({ stage: 'arbiter', model: a })).toBe('arbiter:1')
    expect(() => h.chat.start({ stage: 'answer', model: c })).toThrow('Unselected')
    expect(() => h.chat.start({ stage: 'answer', model: a })).toThrow('already started')
    expect(latest(h.inbox).participants.map(row => row.status)).toEqual(['queued', 'starting', 'starting', 'queued', 'starting'])
    expect(uiMessages(h.inbox)).toHaveLength(4)
    expectNoSurface(h.session)
  })

  it('publishes immutable full snapshots throughout start, created and settled', () => {
    const h = harness()
    h.chat.selected(selection)
    const initial = latest(h.inbox)
    const initialJson = JSON.stringify(initial)
    const key = h.chat.start({ stage: 'answer', model: b })
    const starting = latest(h.inbox)
    h.chat.created(key, 'child-123')
    const running = latest(h.inbox)
    h.chat.settled(key, { stopReason: 'completed', text: 'RAW CHILD ANSWER', reasoning: 'RAW CHILD REASONING' })
    const completed = latest(h.inbox)
    expect(participant(starting, key).status).toBe('starting')
    expect(participant(running, key)).toMatchObject({ status: 'running', childId: 'child-123' })
    expect(participant(completed, key)).toEqual({ key, stage: 'answer', index: 1, status: 'completed', childId: 'child-123' })
    for (const snapshot of [initial, starting, running, completed]) {
      expect(snapshot.participants).toHaveLength(5)
      expect(snapshot.question).toBe(selection.question)
      expect(Object.isFrozen(snapshot)).toBe(true)
      expect(Object.isFrozen(snapshot.participants)).toBe(true)
      expect(snapshot.participants.every(Object.isFrozen)).toBe(true)
    }
    expect(Reflect.set(participant(initial, key), 'status', 'error')).toBe(false)
    expect(JSON.stringify(initial)).toBe(initialJson)
    expect(starting.participants).not.toBe(running.participants)
    expect(JSON.stringify(h.session.snapshotEvents())).not.toContain('RAW CHILD')
    expect(uiMessages(h.inbox).every(message => message.content.length === 0)).toBe(true)
    expect(canonicalMessages(h.inbox)).toHaveLength(1)
    expectNoSurface(h.session)
  })

  it.each([
    new Error('private-provider/private-model-a raw transport failure'),
    { stopReason: 'error', text: 'RAW CHILD OUTPUT', diagnostic: 'Private Model a failed' },
    { stopReason: 'max-tokens', structured: { reasoning: 'RAW CHILD REASONING' } },
    undefined,
  ])('sanitizes thrown or non-completed child failures without copying raw detail: %j', outcome => {
    const h = harness()
    h.chat.selected(selection)
    const key = h.chat.start({ stage: 'answer', model: a })
    h.chat.settled(key, outcome)
    expect(participant(latest(h.inbox), key)).toEqual({ key, stage: 'answer', index: 2, status: 'error', diagnostic: 'child-failed' })
    const committed = JSON.stringify(h.session.snapshotEvents())
    expect(committed).not.toContain('private-provider')
    expect(committed).not.toContain('RAW CHILD')
    expect(committed).not.toContain('Private Model')
    expectNoSurface(h.session)
  })

  it('rejects invalid lifecycle addresses without writing more metadata', () => {
    const h = harness()
    h.chat.selected(selection)
    expect(() => h.chat.created('answer:1', 'child-1')).toThrow('not started')
    expect(() => h.chat.settled('answer:1', new Error('x'))).toThrow('not started')
    expect(() => h.chat.created('unknown', 'child-1')).toThrow('Unknown')
    expect(() => h.chat.settled('unknown', undefined)).toThrow('Unknown')
    expect(() => h.chat.created('answer:1', '  ')).toThrow('child id')
    expect(uiMessages(h.inbox)).toHaveLength(1)
    const key = h.chat.start({ stage: 'answer', model: b })
    h.chat.created(key, 'child-1')
    expect(() => h.chat.created(key, 'different-child')).toThrow('already has')
    h.chat.settled(key, { stopReason: 'completed' })
    h.chat.settled(key, new Error('late duplicate error'))
    expect(participant(latest(h.inbox), key).status).toBe('completed')
  })

  it.each(['success', 'error', 'canceled'] as const)('durably injects final context and returns its real inbox event seq idempotently for %s', status => {
    const h = harness()
    h.chat.selected(selection)
    const key = h.chat.start({ stage: 'answer', model: a })
    h.chat.created(key, 'child-123')
    const text = `Council final ${status}:\nA durable result, not an assistant impersonation.`
    const seq = h.chat.finish(status, text)
    expect(h.session.eventAt(seq)).toMatchObject({
      type: 'agent/inbox/spliced', seq,
      data: { target: 'next-step', inserted: [{
        role: 'user', content: [{ type: 'text', text }], source: {
          kind: 'dsh-council', result: { version: 1, commandId: 'command-council-1', status },
        },
      }] },
    })
    expect(seq).toBe(Number(h.session.seq) - 1)
    expect(insertedAt(h.session, seq)).toEqual(h.inbox.nextStep.at(-1))
    expect(latest(h.inbox).status).toBe(status)
    expect(participant(latest(h.inbox), key)).toMatchObject({ status: 'error', diagnostic: status === 'canceled' ? 'run-canceled' : 'run-ended' })
    expect(canonicalMessages(h.inbox).map(message => message.content)).toEqual([
      [{ type: 'text', text: selection.question }], [{ type: 'text', text }],
    ])
    expect(canonicalMessages(h.inbox).map(message => message.role)).toEqual(['user', 'user'])
    const count = h.session.snapshotEvents().length
    expect(h.chat.finish('error', 'A duplicate result must not be injected')).toBe(seq)
    expect(h.session.snapshotEvents()).toHaveLength(count)
    expect(h.followup).not.toHaveBeenCalled()
    expect(h.steer).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
    expect(h.inbox.nextTurn).toEqual([])
    expect(h.append.mock.calls.every(([type]) => type === 'agent/inbox/spliced')).toBe(true)
    expectNoSurface(h.session)
  })

  it('persists immutable structured prose and audit presentation without splitting model Markdown headings', () => {
    const h = harness()
    h.chat.selected(selection)
    const presentation = {
      answerMarkdown: 'A real answer.\n\n## Audit Summary\nThis heading belongs to the model answer, not the UI audit.',
      auditMarkdown: '## Actual audit\n- Answer A → a routed model',
    }
    const canonical = `# Council Decision\n\n${presentation.answerMarkdown}\n\n${presentation.auditMarkdown}`
    const seq = h.chat.finish('success', canonical, presentation)
    const message = insertedAt(h.session, seq)
    expect(message).toMatchObject({ source: {
      kind: 'dsh-council', result: { presentation },
    }, content: [{ type: 'text', text: canonical }] })
    expect(canonicalMessages(h.inbox).at(-1)?.content).toEqual([{ type: 'text', text: canonical }])
    const source = message.source as unknown as CouncilResultSource
    expect(Object.isFrozen(source.result)).toBe(true)
    expect(Object.isFrozen(source.result.presentation)).toBe(true)
    presentation.answerMarkdown = 'mutated caller object'
    expect(source.result.presentation?.answerMarkdown).toContain('This heading belongs to the model answer')
    expectNoSurface(h.session)
  })

  it('retains completed rows while late receipts cannot revive a canceled run', () => {
    const h = harness()
    h.chat.selected(selection)
    const completed = h.chat.start({ stage: 'answer', model: b })
    h.chat.created(completed, 'completed-child')
    h.chat.settled(completed, { stopReason: 'completed' })
    const pending = h.chat.start({ stage: 'answer', model: a })
    const seq = h.chat.finish('canceled', 'Council canceled by the user.')
    h.chat.created(pending, 'late-child')
    h.chat.settled(pending, { stopReason: 'completed', text: 'late raw answer' })
    expect(latest(h.inbox).status).toBe('canceled')
    expect(participant(latest(h.inbox), completed).status).toBe('completed')
    expect(participant(latest(h.inbox), pending)).toMatchObject({ childId: 'late-child', status: 'error', diagnostic: 'run-canceled' })
    expect(() => h.chat.start({ stage: 'review', model: a })).toThrow('not running')
    expect(h.chat.finish('success', 'late success')).toBe(seq)
    expect(canonicalMessages(h.inbox)).toHaveLength(2)
    expect(JSON.stringify(h.session.snapshotEvents())).not.toContain('late raw answer')
    expectNoSurface(h.session)
  })

  it('can report selection failure without inventing a user question', () => {
    const h = harness()
    expect(() => h.chat.finish('error', ' ')).toThrow('final result')
    expect(h.session.snapshotEvents()).toEqual([])
    const seq = h.chat.finish('error', 'Picker failed before a question was supplied.')
    expect(latest(h.inbox)).toEqual({ version: 1, commandId: 'command-council-1', status: 'error', question: '', participants: [] })
    expect(h.session.eventAt(seq)?.type).toBe('agent/inbox/spliced')
    expect(canonicalMessages(h.inbox)).toHaveLength(1)
    expect((insertedAt(h.session, seq).source as unknown as CouncilResultSource).result.status).toBe('error')
    expect(() => h.chat.selected(selection)).toThrow('already settled')
    expectNoSurface(h.session)
  })

  it('replays canonical question and result as pending input without taking the first surface node from the loop', () => {
    const h = harness()
    h.chat.selected(selection)
    const key = h.chat.start({ stage: 'arbiter', model: a })
    h.chat.created(key, 'arbiter-child')
    h.chat.settled(key, { stopReason: 'completed', text: 'Raw arbiter output stays private.' })
    const seq = h.chat.finish('success', 'Council normal reply')
    const reopened = Session.create(h.session.id, h.session.snapshotEvents(), h.session.header)
    const replayNotifications = { inserted: vi.fn(), discarded: vi.fn(), claimed: vi.fn() }
    const replayInbox = new Inbox(reopened, replayNotifications)
    expect(replayInbox.nextTurn).toEqual([])
    expect(replayInbox.nextStep).toEqual(h.inbox.nextStep)
    expect(latest(replayInbox).status).toBe('success')
    expect(replayNotifications.inserted).not.toHaveBeenCalled()
    expect((insertedAt(reopened, seq).source as unknown as CouncilResultSource).result.status).toBe('success')
    expect(canonicalMessages(replayInbox).flatMap(message => message.content)).toEqual([
      { type: 'text', text: selection.question }, { type: 'text', text: 'Council normal reply' },
    ])
    expect(h.notifications.claimed).not.toHaveBeenCalled()
    expect(h.followup).not.toHaveBeenCalled()
    expectNoSurface(h.session)
    expectNoSurface(reopened)
  })

  it('respects host cancellation clearing pending input while retaining UI source events in the log', () => {
    const h = harness()
    h.chat.selected(selection)
    const seq = h.chat.finish('canceled', 'Council canceled.')
    const beforeClear = h.session.snapshotEvents()
    h.inbox.clear()
    expect(h.inbox.hasPending).toBe(false)
    expect(h.chat.finish('success', 'must not requeue cleared content')).toBe(seq)
    expect(h.inbox.hasPending).toBe(false)
    expect(h.session.snapshotEvents().slice(0, beforeClear.length)).toEqual(beforeClear)
    expect(insertedAt(h.session, seq).content).toEqual([{ type: 'text', text: 'Council canceled.' }])
    const reopened = Session.create(h.session.id, h.session.snapshotEvents(), h.session.header)
    const replayInbox = new Inbox(reopened, { inserted() {}, discarded() {}, claimed() {} })
    expect(replayInbox.hasPending).toBe(false)
    expect(insertedAt(reopened, seq)).toEqual(insertedAt(h.session, seq))
    expectNoSurface(reopened)
  })
})
