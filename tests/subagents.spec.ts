import type { SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { describe, expect, it, vi } from 'vitest'
import { copyForSettings } from '../src/locales.js'
import { councilSubagentApi, startCouncilChild } from '../src/subagents.js'

const copy = copyForSettings(undefined)
const legacyCapabilities = { agentOptions: true, outputSchema: true, toolFilter: true, persona: true }
const activationCapabilities = { agentOptions: true, outputSchema: true, agentPreset: true, depthLimit: true }
const request = {
  label: 'Council answer',
  prompt: [{ type: 'text', text: 'Question' }],
  parent: { id: 'parent' },
  signal: new AbortController().signal,
  agentOptions: { provider: 'p', model: 'a', maxTokens: 100 },
  persona: 'Independent answerer',
  toolFilter: { allow: ['web_search', 'web_fetch'] },
  outputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
} as unknown as SubagentStartRequest

function service(api: 'legacy' | 'activation', overrides: Record<string, unknown> = {}) {
  const provider = {
    inheritsParentContext: false,
    capabilities: api === 'legacy' ? legacyCapabilities : activationCapabilities,
    ...(api === 'activation' ? { prepareContinuable: () => Promise.resolve({}) } : {}),
    ...overrides,
  }
  return {
    getProvider: () => provider,
    ...(api === 'legacy' ? { start: vi.fn() } : { startActivation: vi.fn() }),
  }
}

describe('subagent API compatibility', () => {
  it.each(['legacy', 'activation'] as const)('detects the %s API without relying on provider names', (api) => {
    expect(apiFor(service(api), 'custom-local')).toBe(api)
  })

  it('reports missing providers before attempting execution', () => {
    expect(() => councilSubagentApi({ getProvider: () => undefined }, 'spawn', copy))
      .toThrow(copy.providerMissing('spawn'))
  })

  it.each([
    { inheritsParentContext: true },
    { inheritsParentContext: undefined },
    { capabilities: undefined },
    { capabilities: { ...legacyCapabilities, agentOptions: false } },
    { capabilities: { ...legacyCapabilities, outputSchema: false } },
    { capabilities: { ...legacyCapabilities, persona: false } },
    { capabilities: { ...legacyCapabilities, toolFilter: false } },
  ])('rejects an unsafe legacy provider: %o', (override) => {
    expect(() => apiFor(service('legacy', override))).toThrow(copy.providerCapabilities('spawn'))
  })

  it.each([
    { inheritsParentContext: true },
    { inheritsParentContext: undefined },
    { capabilities: { ...activationCapabilities, agentOptions: false } },
    { capabilities: { ...activationCapabilities, outputSchema: false } },
    { prepareContinuable: undefined },
    { prepareContinuable: true },
  ])('rejects an unsafe or external activation provider: %o', (override) => {
    expect(() => apiFor(service('activation', override))).toThrow(copy.providerCapabilities('spawn'))
  })

  it('rejects an unsupported runtime instead of assuming a usable legacy start', () => {
    const runtime = service('legacy')
    Reflect.deleteProperty(runtime, 'start')
    expect(() => apiFor(runtime)).toThrow(copy.providerCapabilities('spawn'))
  })

  it('retains the legacy request and returned run unchanged', async () => {
    const run = { id: 'legacy-child', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: vi.fn() }
    const start = vi.fn().mockResolvedValue(run)
    expect(await startCouncilChild({ start }, 'legacy', 'spawn', request)).toBe(run)
    expect(start).toHaveBeenCalledWith('spawn', request)
  })

  it('maps activation arguments, normalizes childId, and binds exact-receipt disposal', async () => {
    const activation = {
      childId: 'activation-child' as SubagentRun['id'],
      result: Promise.resolve({ output: [], stopReason: 'completed' as const }),
      dispose: vi.fn(function (this: unknown) { expect(this).toBe(activation); return Promise.resolve() }),
    }
    const startActivation = vi.fn().mockResolvedValue(activation)
    const runtime = { startActivation }
    const run = await startCouncilChild(runtime, 'activation', 'spawn', request)
    expect(startActivation).toHaveBeenCalledWith({
      provider: 'spawn', label: request.label, signal: request.signal, delivery: 'caller',
      request: { prompt: request.prompt, parent: request.parent, agentOptions: request.agentOptions, outputSchema: request.outputSchema },
    })
    expect(run.id).toBe('activation-child')
    expect(run.result).toBe(activation.result)
    await run.dispose()
    expect(activation.dispose).toHaveBeenCalledOnce()
    const { label: _label, ...unlabelled } = request
    await startCouncilChild(runtime, 'activation', 'spawn', unlabelled)
    expect(startActivation.mock.lastCall?.[0].label).toBe('Council')
  })
})

function apiFor(runtime: unknown, provider = 'spawn') {
  return councilSubagentApi(runtime, provider, copy)
}
