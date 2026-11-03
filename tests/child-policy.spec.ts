import type { Context } from '@deepseek-ai/cordis'
import { Inbox } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it } from 'vitest'
import {
  childBudgetPolicySchema,
  childBindingForPolicy,
  isCouncilChildPolicyMarker,
  councilChildPolicySchema,
  councilChildPolicyV2Schema,
  readCouncilChildPolicy,
  recordCouncilChildPolicy,
  recordCouncilChildPolicyV2,
  registerCouncilChildPolicy,
  type CouncilChildPolicyV2,
} from '../src/child-policy.js'
import { hashText, sha256Canonical } from '../src/context-packet.js'
import { COUNCIL_RUN_RECORDS_KEY, createRunRecords, findCouncilChildBinding, registerCouncilRunRecords } from '../src/run-records.js'

const persona = 'Independent Council answerer'
const notifications = { inserted() {}, discarded() {}, claimed() {} }
const fresh = () => Session.create(SessionId('policy-child'), undefined, {
  version: SESSION_FORMAT_VERSION, id: SessionId('policy-child'), createdAt: 1, parentSession: SessionId('policy-parent'), isSeeded: false,
})
const policy = { version: 1, childId: 'policy-child', parentId: 'policy-parent', persona }

function harness() {
  let definition: ProjectionDefinition<'dsh-council:child-policy'> | undefined
  const ctx = {
    sessionProjections: {
      register(unit: ProjectionDefinition<'dsh-council:child-policy'>) { definition = unit; return () => {} },
      stateOf(session: Session, key: string) {
        if (definition === undefined || key !== definition.key) return undefined
        const state = session.snapshotEvents().reduce(definition.apply, definition.init(session.header, session.inheritedEventCount))
        return definition.stateSchema.parse(state)
      },
    },
  } as unknown as Context
  registerCouncilChildPolicy(ctx)
  return {
    ctx,
    read: (session: Session) => readCouncilChildPolicy(ctx, { session }),
    definition: () => definition!,
  }
}

function insert(session: Session, message: UserMessage): Inbox {
  const inbox = new Inbox(session, notifications)
  inbox.append('next-step', message)
  return inbox
}

function marker(childPolicy: unknown): UserMessage {
  return {
    ...createUserMessage({ content: [], source: { kind: 'user' } }),
    source: { kind: 'dsh-council', childPolicy },
  } as UserMessage
}

function record(session: Session, text = persona): void {
  recordCouncilChildPolicy({
    id: session.id, session,
    inject(message) { insert(session, message) },
  }, text)
}

describe('durable Council child policy', () => {
  it('registers a host-only versioned projection and has no policy without a marker', () => {
    const test = harness()
    expect(test.definition()).toMatchObject({ key: 'dsh-council:child-policy', stateVersion: 3 })
    expect(test.definition()).not.toHaveProperty('wire')
    expect(test.read(fresh())).toBeUndefined()
  })

  it('records an empty immutable message through the existing inbox event', () => {
    const session = fresh()
    const test = harness()
    record(session)
    const event = session.ownEvents()[0]
    expect(event?.type).toBe('agent/inbox/spliced')
    if (event?.type !== 'agent/inbox/spliced') throw new Error('missing marker')
    const message = event.data.inserted[0]!
    expect(message.content).toEqual([])
    expect(message.source).toEqual({ kind: 'dsh-council', childPolicy: policy })
    expect(Object.isFrozen(message.source)).toBe(true)
    expect(test.read(session)).toEqual(policy)
  })

  it('persists the exact token cap and rejects a later conflicting budget', () => {
    const session = fresh()
    const test = harness()
    recordCouncilChildPolicy({ id: session.id, session, inject(message) { insert(session, message) } }, persona, 16384)
    expect(test.read(session)).toEqual({ ...policy, maxTokens: 16384 })
    const restored = Session.create(session.id, session.snapshotEvents(), session.header)
    expect(test.read(restored)?.maxTokens).toBe(16384)
    insert(session, marker({ ...policy, maxTokens: 32768 }))
    expect(() => test.read(session)).toThrow('invalid persisted child policy')
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid persisted token budget %s', maxTokens => {
    const session = fresh()
    expect(() => recordCouncilChildPolicy({ id: session.id, session, inject(message) { insert(session, message) } }, persona, maxTokens))
      .toThrow('invalid persisted child policy')
    expect(session.snapshotEvents()).toEqual([])
  })

  it('restores policy after the marker left the inbox and all stored events became seed', () => {
    const test = harness()
    const session = fresh()
    record(session)
    new Inbox(session, notifications).clear()
    const restored = Session.create(session.id, session.snapshotEvents(), session.header)
    expect(new Inbox(restored, notifications).hasPending).toBe(false)
    expect(restored.firstLiveSeq).toBeGreaterThan(0)
    expect(test.read(restored)).toEqual(policy)
  })

  it('also reads an admitted user/message and tolerates the same policy twice', () => {
    const test = harness()
    const session = fresh()
    const message = marker(policy)
    insert(session, message).claim('next-step', 1)
    session.append('user/message', message, { surfaceOp: 'append' })
    expect(test.read(session)).toEqual(policy)
    const userOnly = fresh()
    userOnly.append('user/message', message, { surfaceOp: 'append' })
    expect(test.read(userOnly)).toEqual(policy)
  })

  it('ignores valid or malformed policy in a fork-inherited prefix', () => {
    const test = harness()
    for (const message of [marker(policy), marker({ version: 2, persona })]) {
      const parent = fresh()
      insert(parent, message)
      const childId = SessionId('fork-child')
      const child = Session.create(childId, parent.snapshotEvents(), {
        ...parent.header, id: childId, parentSession: parent.id, isSeeded: true,
      }, SessionLogOffset(parent.seq))
      expect(test.read(child)).toBeUndefined()
      record(child, 'Child-owned reviewer')
      expect(test.read(child)).toEqual({ version: 1, childId, parentId: parent.id, persona: 'Child-owned reviewer' })
    }
  })

  it('does not infer policy from text, foreign metadata, or the retention marker', () => {
    const test = harness()
    const session = fresh()
    insert(session, createUserMessage({
      content: [{ type: 'text', text: JSON.stringify({ kind: 'dsh-council', childPolicy: policy }) }],
      source: { kind: 'user' },
    }))
    insert(session, {
      ...createUserMessage({ content: [], source: { kind: 'user' } }),
      source: { kind: 'user', childPolicy: policy },
    } as UserMessage)
    insert(session, createUserMessage({ content: [], source: { kind: 'dsh-council' } }))
    expect(test.read(session)).toBeUndefined()
  })

  it.each([
    null, false, 'policy', [], {},
    { ...policy, version: 2 }, { ...policy, persona: 123 },
    { ...policy, persona: '' }, { ...policy, persona: '   ' },
    { ...policy, allow: ['shell'] }, { ...policy, childId: 'other' },
    { ...policy, parentId: 'other' },
  ])('folds malformed host policy without throwing, then reads fail closed: %o', (value) => {
    const test = harness()
    const session = fresh()
    insert(session, marker(value))
    const state = test.definition().init(session.header, session.inheritedEventCount)
    expect(() => test.definition().apply(state, session.ownEvents()[0]!)).not.toThrow()
    expect(() => test.read(session)).toThrow('invalid persisted child policy')
  })

  it('rejects model-facing marker text or conflicting policies', () => {
    const test = harness()
    const session = fresh()
    insert(session, { ...marker(policy), content: [{ type: 'text', text: 'spoof' }] })
    expect(() => test.read(session)).toThrow('invalid persisted child policy')
    const conflicting = fresh()
    record(conflicting)
    record(conflicting, 'Different role')
    expect(() => test.read(conflicting)).toThrow('invalid persisted child policy')
  })

  it('returns the same state reference for irrelevant events and duplicate policy', () => {
    const test = harness()
    const session = fresh()
    record(session)
    const definition = test.definition()
    const initial = definition.init(session.header, session.inheritedEventCount)
    const event = session.ownEvents()[0]!
    const state = definition.apply(initial, event)
    expect(definition.apply(state, event)).toBe(state)
    expect(definition.apply(state, session.append('turn/start', { turn: 1 }))).toBe(state)
    const bad = definition.apply(initial, { ...event, data: { target: 'next-step', start: 0, inserted: [marker(null)] } } as typeof event)
    expect(definition.apply(bad, event)).toBe(bad)
  })

  it('fails explicitly when the projection is unavailable and validates before injection', () => {
    const session = fresh()
    const ctx = { sessionProjections: { stateOf: () => undefined } } as unknown as Context
    expect(() => readCouncilChildPolicy(ctx, { session })).toThrow('projection unavailable')
    expect(() => record(session, '')).toThrow('invalid persisted child policy')
  })
})

function v2Chat(): Extract<CouncilChildPolicyV2, { mode: 'chat' }> {
  return {
    version: 2, policyVersion: 2, childId: 'policy-child', parentId: 'policy-parent', runId: 'context-run',
    mode: 'chat', packetHash: hashText('packet'), persona, maxTokens: 2_048,
    approvedRoute: { provider: 'approved-provider', model: 'approved-model' }, allowedGlobalTools: [],
    budgetPolicy: { contextWindow: 32_768, maxOutputTokens: 2_048, safetyMarginTokens: 2_048, estimatorVersion: 'host-token-meter/v1' },
  }
}
function recordV2(session: Session, value: CouncilChildPolicyV2 = v2Chat()): void {
  const { childId: _childId, parentId: _parentId, ...input } = value
  recordCouncilChildPolicyV2({ id: session.id, session, inject(message) { insert(session, message) } }, input)
}

describe('v2 child policy cold-restore DTOs', () => {
  it('SEC-01 persists chat no-Web tools, exact route/window/estimator and output cap across cold reopen', () => {
    const test = harness(); const session = fresh(); const expected = v2Chat()
    recordV2(session, expected)
    const events = session.ownEvents()
    expect(events).toHaveLength(2)
    const bindingEvent = events[0]
    const policyEvent = events[1]
    if (bindingEvent?.type !== 'agent/inbox/spliced' || policyEvent?.type !== 'agent/inbox/spliced') throw new Error('Missing independent producers')
    expect(bindingEvent.data.inserted[0]?.content).toEqual([])
    expect(bindingEvent.data.inserted[0]?.source).toEqual({ kind: 'dsh-council', childBinding: childBindingForPolicy(expected) })
    expect(policyEvent.data.inserted[0]?.content).toEqual([])
    expect(policyEvent.data.inserted[0]?.source).toEqual({ kind: 'dsh-council', childPolicy: expected })
    expect(Object.isFrozen(bindingEvent.data.inserted[0]?.source)).toBe(true)
    expect(Object.isFrozen(policyEvent.data.inserted[0]?.source)).toBe(true)
    expect(isCouncilChildPolicyMarker(bindingEvent.data.inserted[0])).toBe(true)
    expect(isCouncilChildPolicyMarker(policyEvent.data.inserted[0])).toBe(true)
    new Inbox(session, notifications).clear()
    const restored = Session.create(session.id, session.snapshotEvents(), session.header)
    const value = test.read(restored)
    expect(value).toEqual(expected)
    expect(value?.version).toBe(2)
    if (value?.version !== 2 || value.mode !== 'chat') throw new Error('Missing v2 chat policy')
    expect(value.allowedGlobalTools).toEqual([])
    expect(value.approvedRoute).toEqual(expected.approvedRoute)
    expect(value.budgetPolicy).toEqual(expected.budgetPolicy)
    expect(value.maxTokens).toBe(2_048)
    expect(new Inbox(restored, notifications).hasPending).toBe(false)
  })

  it('keeps v1 historical policy readable without pretending it has v2 route/budget approval', () => {
    const test = harness(); const session = fresh()
    record(session)
    const restored = Session.create(session.id, session.snapshotEvents(), session.header)
    const value = test.read(restored)
    expect(value?.version).toBe(1)
    expect(value).not.toHaveProperty('approvedRoute')
    expect(value).not.toHaveProperty('budgetPolicy')
    expect(value).not.toHaveProperty('allowedGlobalTools')
    expect(councilChildPolicySchema.safeParse(value).success).toBe(true)
    expect(councilChildPolicyV2Schema.safeParse(value).success).toBe(false)
  })

  it('topic-only v2 can preserve the real Web subset without fabricating an unknown window', () => {
    const { packetHash: _packetHash, budgetPolicy: _budgetPolicy, ...base } = v2Chat()
    for (const allowedGlobalTools of [[], ['web_fetch'], ['web_search', 'web_fetch']]) {
      const value = { ...base, mode: 'topic-only', allowedGlobalTools }
      expect(councilChildPolicyV2Schema.safeParse(value).success).toBe(true)
      const test = harness(); const session = fresh()
      recordV2(session, councilChildPolicyV2Schema.parse(value))
      const restored = Session.create(session.id, session.snapshotEvents(), session.header)
      const policy = test.read(restored)
      expect(policy).toEqual(value)
      expect(policy).not.toHaveProperty('budgetPolicy')
      expect(policy).not.toHaveProperty('packetHash')
    }
  })

  it.each(['approvedRoute', 'budgetPolicy', 'maxTokens', 'runId', 'packetHash', 'policyVersion', 'allowedGlobalTools'] as const)(
    'SEC-03 missing required chat field %s fails closed rather than falling back to legacy', (key) => {
      const value: Record<string, unknown> = { ...v2Chat() }
      delete value[key]
      expect(councilChildPolicySchema.safeParse(value).success).toBe(false)
      const test = harness(); const session = fresh()
      insert(session, marker(value))
      const definition = test.definition()
      expect(() => definition.apply(definition.init(session.header, session.inheritedEventCount), session.ownEvents()[0]!)).not.toThrow()
      expect(() => test.read(session)).toThrow('invalid persisted child policy')
    },
  )

  it('rejects unknown versions, permanent structured_output/global escalation and routing/budget extras', () => {
    const expected = v2Chat()
    for (const change of [
      { version: 3 }, { policyVersion: 3 }, { mode: 'unknown' },
      { allowedGlobalTools: ['web_search'] }, { allowedGlobalTools: ['web_fetch'] },
      { allowedGlobalTools: ['shell'] }, { allowedGlobalTools: ['structured_output'] },
      { allowedGlobalTools: ['web_search', 'web_search'] },
      { approvedRoute: { ...expected.approvedRoute, fallback: 'other' } },
      { approvedRoute: { provider: '', model: 'model' } },
      { budgetPolicy: { ...expected.budgetPolicy, contextWindow: 0 } },
      { budgetPolicy: { ...expected.budgetPolicy, estimatorVersion: '' } },
      { budgetPolicy: { ...expected.budgetPolicy, hidden: 'SECRET_SENTINEL' } },
      { maxTokens: 2_049 }, { maxTokens: 0 }, { maxTokens: 1.5 },
    ]) expect(councilChildPolicySchema.safeParse({ ...expected, ...change }).success).toBe(false)
    expect(childBudgetPolicySchema.safeParse({ contextWindow: 4_096, maxOutputTokens: 2_048, safetyMarginTokens: 2_048, estimatorVersion: 'v1' }).success).toBe(false)
  })

  it('SEC-02 rejects conflicting approved routes, packet identity, windows and tool policies after restore', () => {
    const expected = v2Chat()
    for (const change of [
      { approvedRoute: { provider: 'other-provider', model: 'other-model' } },
      { packetHash: hashText('different-packet') }, { runId: 'different-run' },
      { budgetPolicy: { ...expected.budgetPolicy, contextWindow: 65_536 } },
      { budgetPolicy: { ...expected.budgetPolicy, estimatorVersion: 'changed-estimator' } },
      { childId: 'different-child' }, { parentId: 'different-parent' },
    ]) {
      const test = harness(); const session = fresh()
      recordV2(session, expected)
      const restored = Session.create(session.id, session.snapshotEvents(), session.header)
      insert(restored, marker({ ...expected, ...change }))
      expect(() => test.read(restored)).toThrow('invalid persisted child policy')
    }
  })

  it('does not upgrade or replace a persisted v1 policy with a v2 policy on the same child', () => {
    const test = harness(); const session = fresh()
    record(session)
    insert(session, marker(v2Chat()))
    expect(() => test.read(session)).toThrow('invalid persisted child policy')
  })

  it('validates v2 before injection and derives child/parent binding from the real Session', () => {
    const session = fresh()
    const invalid = { ...v2Chat(), maxTokens: 4_096 }
    expect(() => recordV2(session, invalid)).toThrow('invalid persisted child policy')
    expect(session.snapshotEvents()).toEqual([])
    const { childId: _childId, parentId: _parentId, ...input } = v2Chat()
    const test = harness()
    recordCouncilChildPolicyV2({ id: session.id, session, inject(message) { insert(session, message) } }, input)
    expect(test.read(session)).toMatchObject({ childId: 'policy-child', parentId: 'policy-parent' })
  })

  it.each(['binding-only', 'policy-only'] as const)('SEC-03 rejects cold restore retaining only %s', (retained) => {
    const test = harness(); const session = fresh(); const expected = v2Chat()
    const message = retained === 'binding-only'
      ? createUserMessage({ content: [], source: { kind: 'dsh-council', childBinding: childBindingForPolicy(expected) } })
      : marker(expected)
    insert(session, message)
    const definition = test.definition()
    expect(() => session.snapshotEvents().reduce(definition.apply, definition.init(session.header, session.inheritedEventCount))).not.toThrow()
    new Inbox(session, notifications).clear()
    const restored = Session.create(session.id, session.snapshotEvents(), session.header)
    expect(() => test.read(restored)).toThrow('invalid persisted child policy')
    expect(new Inbox(restored, notifications).hasPending).toBe(false)
  })

  it('rejects independent binding hash/run/packet/parent conflicts while preserving the full policy hash contract', () => {
    const expected = v2Chat()
    const binding = childBindingForPolicy(expected)
    expect(binding.policyHash).toBe(sha256Canonical(expected))
    for (const change of [{ policyHash: hashText('wrong-policy') }, { runId: 'wrong-run' },
      { packetHash: hashText('wrong-packet') }, { parentSessionId: 'wrong-parent' }, { childId: 'wrong-child' }]) {
      const test = harness(); const session = fresh()
      insert(session, createUserMessage({ content: [], source: { kind: 'dsh-council', childBinding: { ...binding, ...change } } }))
      insert(session, marker(expected))
      expect(() => test.read(session)).toThrow('invalid persisted child policy')
    }
  })

  it('deduplicates admitted independent markers and never restores a permanent structured tool', () => {
    const test = harness(); const session = fresh()
    recordV2(session)
    const inbox = new Inbox(session, notifications)
    const messages = [...inbox.nextStep]
    inbox.clear()
    for (const message of messages) session.append('user/message', message, { surfaceOp: 'append' })
    expect(test.read(session)).toEqual(v2Chat())
    expect(new Inbox(session, notifications).hasPending).toBe(false)
    const definition = test.definition()
    const state = session.snapshotEvents().reduce(definition.apply, definition.init(session.header, session.inheritedEventCount))
    expect(definition.apply(state, session.ownEvents().at(-1)!)).toBe(state)
    const restored = test.read(session)
    if (restored?.version !== 2) throw new Error('Missing v2 policy')
    expect(restored.allowedGlobalTools).toEqual([])
    expect(restored.allowedGlobalTools).not.toContain('structured_output')
  })
})

function parentManifestHarness() {
  let childDefinition: ProjectionDefinition<'dsh-council:child-policy'> | undefined
  let runDefinition: ProjectionDefinition<typeof COUNCIL_RUN_RECORDS_KEY> | undefined
  const ctx = { sessionProjections: {
    register(unit: ProjectionDefinition<'dsh-council:child-policy'> | ProjectionDefinition<typeof COUNCIL_RUN_RECORDS_KEY>) {
      if (unit.key === 'dsh-council:child-policy') childDefinition = unit
      else runDefinition = unit
      return () => {}
    },
    stateOf(session: Session, key: string) {
      if (key === 'dsh-council:child-policy' && childDefinition !== undefined) return childDefinition.stateSchema.parse(
        session.snapshotEvents().reduce(childDefinition.apply, childDefinition.init(session.header, session.inheritedEventCount)))
      if (key === COUNCIL_RUN_RECORDS_KEY && runDefinition !== undefined) return runDefinition.stateSchema.parse(
        session.snapshotEvents().reduce(runDefinition.apply, runDefinition.init(session.header, session.inheritedEventCount)))
      return undefined
    },
  } } as unknown as Context
  registerCouncilChildPolicy(ctx)
  registerCouncilRunRecords(ctx)
  return ctx
}

describe('parent manifest survives whole child policy deletion', () => {
  it('keeps authoritative parent ownership while missing child policy fails closed through the surviving child marker', () => {
    const ctx = parentManifestHarness()
    const parentSession = Session.create(SessionId('policy-parent'))
    const parent = { session: parentSession, inject(message: UserMessage) { insert(parentSession, message) } }
    const records = createRunRecords(ctx, parent)
    records.transition({ version: 2, runId: 'context-run', mode: 'topic-only', status: 'CREATED' })
    const { packetHash: _packetHash, budgetPolicy: _budgetPolicy, ...common } = v2Chat()
    const fullPolicy = councilChildPolicyV2Schema.parse({ ...common, mode: 'topic-only', allowedGlobalTools: ['web_fetch'] })
    records.commitChildBinding('context-run', fullPolicy)
    const independent = childBindingForPolicy(fullPolicy)
    const child = fresh()
    // The entire childPolicy producer is absent; this is not just a malformed DTO field.
    insert(child, createUserMessage({ content: [], source: { kind: 'dsh-council', childBinding: independent } }))
    insert(child, createUserMessage({ content: [{ type: 'text', text: 'EXISTING_BACKGROUND_SENTINEL' }], source: { kind: 'user' } }))
    new Inbox(parentSession, notifications).clear()
    const restoredParent = Session.create(parentSession.id, parentSession.snapshotEvents(), parentSession.header)
    const restoredChild = Session.create(child.id, child.snapshotEvents(), child.header)
    expect(findCouncilChildBinding(ctx, { session: restoredParent }, String(child.id))).toEqual(independent)
    expect(() => readCouncilChildPolicy(ctx, { session: restoredChild })).toThrow('invalid persisted child policy')
    expect(new Inbox(restoredParent, notifications).hasPending).toBe(false)
  })

  it('still identifies ownership from the parent if both child markers are missing, so caller must reject undefined policy', () => {
    const ctx = parentManifestHarness()
    const parentSession = Session.create(SessionId('policy-parent'))
    const parent = { session: parentSession, inject(message: UserMessage) { insert(parentSession, message) } }
    const records = createRunRecords(ctx, parent)
    records.transition({ version: 2, runId: 'context-run', mode: 'topic-only', status: 'CREATED' })
    const { packetHash: _packetHash, budgetPolicy: _budgetPolicy, ...common } = v2Chat()
    const fullPolicy = councilChildPolicyV2Schema.parse({ ...common, mode: 'topic-only', allowedGlobalTools: [] })
    records.commitChildBinding('context-run', fullPolicy)
    const child = fresh()
    insert(child, createUserMessage({ content: [{ type: 'text', text: 'BACKGROUND_WITH_BOTH_MARKERS_MISSING' }], source: { kind: 'user' } }))
    expect(readCouncilChildPolicy(ctx, { session: child })).toBeUndefined()
    expect(findCouncilChildBinding(ctx, parent, String(child.id))?.policyHash).toBe(sha256Canonical(fullPolicy))
    // The entry's combined check must treat this pair as an owned child with missing policy, not an ordinary Agent.
  })
})
