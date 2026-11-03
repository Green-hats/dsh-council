import type { SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { CouncilCopy } from './locales.js'

export type SubagentApi = 'legacy' | 'activation'
export type CouncilChildRun = Pick<SubagentRun, 'id' | 'result' | 'dispose'>

interface CompatibleProvider {
  readonly inheritsParentContext?: boolean
  readonly capabilities?: {
    readonly agentOptions?: boolean
    readonly outputSchema?: boolean
    readonly persona?: boolean
    readonly toolFilter?: boolean
  }
  readonly prepareContinuable?: unknown
}

export interface ActivationSpec {
  readonly provider: string
  readonly label: string
  readonly request: Omit<SubagentStartRequest, 'label' | 'signal' | 'persona' | 'toolFilter'>
  readonly signal: AbortSignal
  readonly delivery: 'caller'
}

interface CompatibleSubagents {
  getProvider(name: string): CompatibleProvider | undefined
  start?(name: string, request: SubagentStartRequest): Promise<CouncilChildRun>
  startActivation?(spec: ActivationSpec): Promise<{
    readonly childId: CouncilChildRun['id']
    readonly result: CouncilChildRun['result']
    dispose(): Promise<void>
  }>
}

/** Detect the execution seam, not a package version or a provider name. */
export function councilSubagentApi(service: unknown, name: string, copy: CouncilCopy): SubagentApi {
  const subagents = service as CompatibleSubagents
  const provider = subagents.getProvider(name)
  if (provider === undefined) throw new Error(copy.providerMissing(name))
  const api = typeof subagents.startActivation === 'function' ? 'activation' : 'legacy'
  const capabilities = provider.capabilities
  const supported = provider.inheritsParentContext === false
    && capabilities?.agentOptions === true
    && capabilities.outputSchema === true
    && (api === 'activation'
      // Only managed local children expose the pre-prompt creation window in
      // which Council installs its own persona and monotonic tool restrictions.
      ? typeof provider.prepareContinuable === 'function'
      : typeof subagents.start === 'function'
        && capabilities.persona === true
        && capabilities.toolFilter === true)
  if (!supported) throw new Error(copy.providerCapabilities(name))
  return api
}

/** Adapt DSH 0.2's activation receipt without leaking notifications to the parent. */
export async function startCouncilChild(
  service: unknown,
  api: SubagentApi,
  name: string,
  request: SubagentStartRequest,
): Promise<CouncilChildRun> {
  const subagents = service as CompatibleSubagents
  if (api === 'legacy') return subagents.start!(name, request)
  const { label, signal, persona: _persona, toolFilter: _toolFilter, ...activationRequest } = request
  const activation = await subagents.startActivation!({
    provider: name,
    label: label ?? 'Council',
    request: activationRequest,
    signal,
    delivery: 'caller',
  })
  return {
    id: activation.childId,
    result: activation.result,
    dispose: () => activation.dispose(),
  }
}
