import type { CouncilAnswer, CouncilQuestion } from './council.js'
import type { CouncilSelection } from './types.js'
import type { CouncilLocale } from './locales.js'
import type { ContextPacket, PacketRecord } from './context-types.js'
import { packetRecordSchema } from './context-types.js'
import { compileContextPacket, computeExportHash, normalizeProviderSet, serializePublicPacket } from './context-packet.js'
import { assertSelectedSourcesCurrent, ContextCaptureError, type ContextCapture, type CaptureLimits } from './context-capture.js'
import { withDeadline } from './async.js'

export interface PreparationConfig extends CaptureLimits {
  readonly contextMode: 'chat' | 'topic-only'
  readonly contextCaptureTimeoutMs: number
  readonly contextPreparationTimeoutMs: number
  readonly contextPacketMaxBytes: number
}
export type ContextAsk = (questions: readonly CouncilQuestion[], signal: AbortSignal) => Promise<readonly CouncilAnswer[]>
export class ContextPreparationCanceled extends Error { readonly code = 'ASK_CANCELLED' }
function canceled(): never { throw new ContextPreparationCanceled('Council context preparation canceled') }
function one(answers: readonly CouncilAnswer[], id: string, options: readonly string[]): string {
  const answer = answers[0]
  if (answers.length !== 1 || !answer || answer.id !== id || answer.custom !== undefined || answer.selected.length !== 1
    || !options.includes(answer.selected[0] ?? '')) throw new Error('Invalid context selection')
  return answer.selected[0]!
}
function language(locale: CouncilLocale, en: string, zh: string): string { return locale === 'zh' ? zh : en }
function options(labels: readonly string[]): { label: string }[] { return labels.map(label => ({ label })) }
/** Executed before the roster picker. A capture is never delayed until after model selection. */
export async function chooseContextMode(input: {
  config: PreparationConfig; ask: ContextAsk; capture(surfaceOnlyUserApproved?: boolean): ContextCapture; signal: AbortSignal; locale: CouncilLocale
}): Promise<ContextCapture | undefined> {
  const { config, ask, signal, locale } = input
  signal.throwIfAborted()
  if (config.contextMode === 'topic-only') return undefined
  const labels = [language(locale, 'Use current chat background', '使用当前聊天背景'), language(locale, 'Topic only', '仅议题'), language(locale, 'Cancel', '取消')]
  const picked = one(await ask([{ id: 'context-mode', question: language(locale, 'Choose the context for this Council run.', '选择本轮议会使用的背景。'), options: options(labels) }], signal), 'context-mode', labels)
  signal.throwIfAborted()
  if (picked === labels[2]) canceled()
  if (picked === labels[1]) return undefined
  let surfaceOnly = false
  while (true) {
    try {
      return await withDeadline(signal, config.contextCaptureTimeoutMs, 'Context capture timed out', async () => input.capture(surfaceOnly))
    } catch (error) {
      signal.throwIfAborted()
      if (!(error instanceof ContextCaptureError)) throw error
      const fallback = [language(locale, 'Retry capture', '重新捕获'), ...(error.code === 'INBOX_UNAVAILABLE' ? [language(locale, 'Surface only: pending results may be missing', '仅已准入历史：可能遗漏待处理结果')] : []), labels[1]!, labels[2]!]
      const selected = one(await ask([{ id: 'context-fallback', question: language(locale, 'Chat background could not be captured safely.', '无法安全捕获聊天背景。'), detail: `${error.code}: ${error.message}`, options: options(fallback) }], signal), 'context-fallback', fallback)
      signal.throwIfAborted()
      if (selected === labels[2]) canceled()
      if (selected === labels[1]) return undefined
      surfaceOnly = selected === fallback[1] && error.code === 'INBOX_UNAVAILABLE'
    }
  }
}
async function aliases(capture: ContextCapture, ask: ContextAsk, signal: AbortSignal, locale: CouncilLocale): Promise<string[]> {
  const defaults = capture.candidates.filter(candidate => candidate.defaultSelected).map(candidate => candidate.source.alias)
  const labels = [language(locale, `Use all ${defaults.length} exportable texts (no tool evidence)`, `使用全部 ${defaults.length} 条可导出文本（不含工具证据）`), language(locale, 'Select individual sources', '逐条选择'), language(locale, 'Cancel', '取消')]
  const branch = one(await ask([{ id: 'context-source-mode', question: language(locale, 'Choose the material to export.', '选择将要导出的材料。'), options: options(labels) }], signal), 'context-source-mode', labels)
  signal.throwIfAborted()
  if (branch === labels[2]) canceled()
  if (branch === labels[0]) return defaults
  if (capture.candidates.length === 0) throw new Error('There are no sources to select')
  const rows = capture.candidates.map(({ source }) => ({ label: source.alias, description: `[${source.kind}; ${source.epistemic}] ${source.text.slice(0, 180)}` }))
  const answers = await ask([{ id: 'context-sources', question: language(locale, 'Select source aliases; tool evidence is opt-in. Empty is not all.', '选择来源编号；工具证据须额外勾选。空选择不代表全选。'), options: rows, multiSelect: true }], signal)
  signal.throwIfAborted()
  const selected = answers[0]
  const known = new Set(rows.map(row => row.label))
  if (answers.length !== 1 || !selected || selected.id !== 'context-sources' || selected.custom !== undefined || selected.selected.length === 0
    || selected.selected.some(alias => !known.has(alias)) || new Set(selected.selected).size !== selected.selected.length) throw new Error('Invalid or empty context source selection')
  return [...selected.selected]
}
/** Human waiting is excluded from preparation deadlines. No model or persistence is called before agreement. */
export async function prepareContextExport<T>(input: {
  runId: string; selection: CouncilSelection; capture: ContextCapture; config: PreparationConfig; ask: ContextAsk
  signal: AbortSignal; locale: CouncilLocale
  plan(packet: ContextPacket, signal: AbortSignal): Promise<T>
  currentCapture(surfaceOnlyUserApproved: boolean): ContextCapture
}): Promise<{ record: PacketRecord; prepared: T } | undefined> {
  const { config, signal, locale, capture, selection, ask } = input
  const providerSet = normalizeProviderSet([...selection.answerers, ...selection.reviewers, selection.arbiter].map(({ provider, model }) => ({ provider, model })))
  while (true) {
    const selectedAliases = await aliases(capture, ask, signal, locale)
    signal.throwIfAborted()
    let compiled: ReturnType<typeof compileContextPacket>
    let prepared: T
    try {
      const result = await withDeadline(signal, config.contextPreparationTimeoutMs, 'Context preparation timed out', async preparationSignal => {
        const compiled = compileContextPacket({ topicOriginal: selection.question, candidates: [...capture.candidates], selectedAliases,
          omissions: capture.omissions, attachments: capture.attachments,
          maxSources: config.contextMaxSources, maxCandidateBytes: config.contextCandidateMaxBytes, maxPacketBytes: config.contextPacketMaxBytes })
        const prepared = await input.plan(compiled.packet, preparationSignal)
        preparationSignal.throwIfAborted()
        return { compiled, prepared }
      })
      compiled = result.compiled; prepared = result.prepared
    } catch (error) {
      signal.throwIfAborted()
      const fallback = [language(locale, 'Select fewer sources', '减少选择'), language(locale, 'Topic only', '仅议题'), language(locale, 'Cancel', '取消')]
      const chosen = one(await ask([{ id: 'context-budget-fallback', question: language(locale, 'Background preparation failed before any export.', '背景准备失败，尚未外发。'), detail: error instanceof Error ? error.message : 'Context preparation unavailable', options: options(fallback) }], signal), 'context-budget-fallback', fallback)
      signal.throwIfAborted()
      if (chosen === fallback[2]) canceled()
      if (chosen === fallback[1]) return undefined
      continue
    }
    const labels = [language(locale, 'Agree and freeze this export', '同意并冻结本次导出'), language(locale, 'Return to material selection', '返回重选材料'), language(locale, 'Topic only', '仅议题'), language(locale, 'Cancel', '取消')]
    const disclosure = language(locale,
      'The COMPLETE public JSON below will be sent to every selected route listed here. Chat mode has no Web, file reading, OCR, Shell or delegation. Attachments are reference-only. Copies already sent to providers or child sessions cannot be recalled by editing the original. Automated redaction does not guarantee secret detection.',
      '下方为将实际发送的完整公开 JSON，接收方为列出的所有模型路由。聊天背景模式不联网、不读取文件、不 OCR、不运行 Shell 或再委派；附件仅为引用。已发往服务商或子会话的副本无法通过编辑原消息撤回。自动脱敏不保证发现所有秘密。')
    const detail = `${disclosure}\n\n${providerSet.map(route => `${route.provider}/${route.model}`).join('\n')}\n\npacketHash: ${compiled.packetHash}\n\n~~~json\n${serializePublicPacket(compiled.packet)}\n~~~`
    const answer = one(await ask([{ id: 'context-confirm', question: language(locale, 'Review the complete material and all recipients before agreeing.', '请完整检查导出材料和全部接收方后再同意。'), detail, options: options(labels) }], signal), 'context-confirm', labels)
    signal.throwIfAborted()
    if (answer === labels[3]) canceled()
    if (answer === labels[2]) return undefined
    if (answer === labels[1]) continue
    const record = packetRecordSchema.parse({ version: 2, runId: input.runId, capturedThroughSeq: capture.capturedThroughSeq,
      pendingPolicy: capture.pendingPolicy, packet: compiled.packet, packetHash: compiled.packetHash, privateSources: compiled.privateSources,
      consent: { exportHash: computeExportHash(compiled.packetHash, providerSet), providerSet,
        selectedAliases: compiled.packet.sources.map(source => source.alias), webAllowed: false }, compilerVersion: 1 })
    // Caller must repeat this synchronous check after awaiting us and immediately before committing/exporting.
    assertSelectedSourcesCurrent(record.privateSources, input.currentCapture(capture.pendingPolicy === 'surface-only-user-approved'), record.packet.sources, record.packet.attachments)
    signal.throwIfAborted()
    return { record, prepared }
  }
}
