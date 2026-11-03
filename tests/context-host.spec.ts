import type { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SessionLogOffset, SESSION_FORMAT_VERSION, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, vi } from 'vitest'
import { findPersistedChildBinding } from '../src/context-host.js'
import { COUNCIL_RUN_RECORDS_KEY, createRunRecords, registerCouncilRunRecords } from '../src/run-records.js'
import { councilChildPolicyV2Schema } from '../src/child-policy.js'

function fixture() {
  const session = Session.create(SessionId('manifest-parent'))
  const childSession = Session.create(SessionId('manifest-child'), undefined, { version: SESSION_FORMAT_VERSION, id: SessionId('manifest-child'), parentSession: session.id, createdAt: 1, isSeeded: false })
  const inbox = new Inbox(session, { inserted() {}, discarded() {}, claimed() {} })
  const parent = { id: session.id, session, inject: (message: Parameters<Inbox['append']>[1]) => inbox.append('next-step', message) }
  const child = { id: childSession.id, session: childSession }
  let unit: ProjectionDefinition<'dsh-council:run-records'>
  let live = false
  let malformedCheckpoint = false
  const released = vi.fn()
  function observation() { return { header: session.header, inheritedEventCount: 0, events: session.snapshotEvents(), [Symbol.dispose]: released } }
  const observe = vi.fn(async (_id: string, _options: unknown) => observation())
  const state = (events: readonly SessionEvent[], header = session.header, inherited = SessionLogOffset(0)) => events.reduce(unit.apply, unit.init(header, inherited))
  const restore = vi.fn((_checkpoint: unknown, events: SessionEvent[], base: number, header: SessionHeader, inherited: SessionLogOffset) => {
    expect(base).toBe(0)
    return { snapshot: { asOfSeq: events.length - 1, values: {} }, checkpoint: { [COUNCIL_RUN_RECORDS_KEY]: { ver: 3, seq: events.length - 1, val: malformedCheckpoint ? { bad: true } : state(events, header, inherited) } } }
  })
  const get = vi.fn((name: string) => name === 'agents' ? { get: () => live ? parent as unknown as Agent : undefined }
    : name === 'sessionQuery' ? { observeSession: observe } : undefined)
  const ctx = { get, sessionProjections: {
    register(definition: typeof unit) { unit = definition; return () => {} },
    stateOf: (value: Session) => state(value.snapshotEvents(), value.header, value.inheritedEventCount), restore,
  } } as unknown as Context
  registerCouncilRunRecords(ctx)
  const records = createRunRecords(ctx, parent)
  records.transition({ version: 2, runId: 'run', mode: 'topic-only', status: 'CREATED' })
  records.commitChildBinding('run', councilChildPolicyV2Schema.parse({ version: 2, policyVersion: 2, mode: 'topic-only', runId: 'run', childId: child.id, parentId: parent.id, persona: 'Fixture answerer', maxTokens: 100, approvedRoute: { provider: 'p', model: 'a' }, allowedGlobalTools: [] }))
  return { ctx, child, session, records, observe, restore, released, get, observation, live() { live = true }, malformed() { malformedCheckpoint = true } }
}
describe('cold Council parent binding capability', () => {
  it('SEC-03 reads the exact live parent projection without an observation or new Agent', async () => {
    const f = fixture(); f.live()
    const binding = await findPersistedChildBinding(f.ctx, f.child, new AbortController().signal)
    expect(binding).toEqual(f.records.findChildBinding(String(f.child.id)))
    expect(f.observe).not.toHaveBeenCalled(); expect(f.restore).not.toHaveBeenCalled()
  })
  it('REC-01 folds an offline lease with the public registry and always releases it', async () => {
    const f = fixture()
    const binding = await findPersistedChildBinding(f.ctx, f.child, new AbortController().signal)
    expect(binding?.runId).toBe('run')
    expect(Object.isFrozen(binding)).toBe(true)
    expect(f.observe).toHaveBeenCalledWith('manifest-parent', expect.objectContaining({ projectionMode: 'none' }))
    expect(f.restore).toHaveBeenCalledTimes(1)
    expect(f.released).toHaveBeenCalledTimes(1)
  })
  it('SEC-03 fails closed on a malformed parent checkpoint and releases the lease', async () => {
    const f = fixture(); f.malformed()
    await expect(findPersistedChildBinding(f.ctx, f.child, new AbortController().signal)).rejects.toThrow()
    expect(f.released).toHaveBeenCalledTimes(1)
  })
  it('RUN-01 disposes a late observation even if its provider ignored cancellation', async () => {
    const f = fixture()
    const deferred = Promise.withResolvers<ReturnType<typeof f.observation>>()
    f.observe.mockImplementation(() => deferred.promise)
    const controller = new AbortController()
    const read = findPersistedChildBinding(f.ctx, f.child, controller.signal)
    controller.abort(new Error('CANCELED_OWNERSHIP_LOOKUP'))
    const rejected = expect(read).rejects.toThrow('CANCELED_OWNERSHIP_LOOKUP')
    deferred.resolve(f.observation())
    await rejected
    expect(f.restore).not.toHaveBeenCalled()
    expect(f.released).toHaveBeenCalledTimes(1)
  })
  it('does not silently claim a binding when the optional cold query capability is absent', async () => {
    const f = fixture()
    f.get.mockImplementation(() => undefined)
    expect(await findPersistedChildBinding(f.ctx, f.child, new AbortController().signal)).toBeUndefined()
    expect(f.observe).not.toHaveBeenCalled()
    // The owning agent/created adapter rejects undefined binding for every v2 policy.
  })
})
