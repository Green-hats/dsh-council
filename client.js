window.__ModuleLoader__.load({
  id: '@greenhats/dsh-council',
  factory(require) {
    'use strict';
    const React = require('react');
    const h = React.createElement;
    const NS = 'dsh-council';
    const QUESTION = 'dsh-council-question';
    const PROGRESS = 'dsh-council-progress';
    const ANSWER = 'dsh-council-answer';
    const EMPTY_ORDER = Object.freeze([]);
    const absent = { getSnapshot: () => undefined, subscribe: () => () => {} };
    const stages = ['answer', 'review', 'arbiter'];
    const statuses = ['selecting', 'running', 'success', 'error', 'canceled'];
    const participantStatuses = ['queued', 'starting', 'running', 'completed', 'error'];
    const en = {
      title: 'Council', result: 'Final decision', answer: 'Independent answers', review: 'Peer reviews', arbiter: 'Arbitration',
      process: 'Execution process · {completed}/{total} complete', audit: 'Audit details', question: 'Question',
      arbiterProcess: 'Public arbitration process',
      participant: 'Participant {index}', selecting: 'Selecting', running: 'Running', success: 'Complete', error: 'Failed', canceled: 'Canceled',
      queued: 'Queued', starting: 'Starting', completed: 'Complete', skipped: 'Not run',
      expand: 'Show public output', collapse: 'Hide public output', loading: 'Loading public output…',
      unavailable: 'Public output is unavailable for this child session.', noChild: 'No child-session metadata was recorded.',
      noOutput: 'No public output has been recorded yet.', noReasoning: 'No public reasoning was provided. Models without reasoning output show text only.',
      reasoning: 'Public reasoning', text: 'Output', ordinal: 'Participant numbers identify launch order, not shuffled Answer A/B labels.',
      reviewOutput: 'Peer review output', arbiterOutput: 'Arbitration output',
      submittingReview: 'Submitting peer review…', submittingArbiter: 'Submitting arbitration…',
      structuredError: 'The structured submission failed.', structuredUnreadable: 'The recorded structured output could not be read.',
      evaluations: 'Answer evaluations', strengths: 'Strengths', weaknesses: 'Weaknesses', ranking: 'Ranking',
      consensus: 'Consensus', contradictions: 'Contradictions', coverageGaps: 'Coverage gaps',
      uniqueInsights: 'Unique insights', blindSpots: 'Blind spots', confidenceNotes: 'Confidence notes',
      contextMode: 'Background mode', chat: 'Current chat background', 'topic-only': 'Topic only',
      chatPolicy: 'No Web access; attachment contents were not read.', limitations: 'Limitations', decisionDeltas: 'Key decision changes',
      coverage: 'Anonymous coverage · answers {answers}/{answerers}; reviews {reviews}/{reviewers}',
      incompleteCoverage: 'Some requested participants did not produce a valid result.', citations: 'Reported sources (not independently verified)',
      supported: 'Supported', revised: 'Revised', rejected: 'Rejected', unresolved: 'Unresolved', noSource: 'No source alias reported',
      'child-failed': 'The participant did not complete.', 'run-canceled': 'The council was canceled.', 'run-ended': 'The council ended before this participant completed.',
    };
    const zh = {
      title: '议会', result: '最终裁决', answer: '独立作答', review: '匿名互评', arbiter: '最终仲裁',
      process: '执行过程 · {completed}/{total} 已完成', audit: '审计详情', question: '议题',
      arbiterProcess: '查看仲裁公开过程',
      participant: '参与者 {index}', selecting: '选择中', running: '进行中', success: '已完成', error: '失败', canceled: '已取消',
      queued: '等待中', starting: '启动中', completed: '已完成', skipped: '未执行',
      expand: '展开公开输出', collapse: '收起公开输出', loading: '正在加载公开输出…',
      unavailable: '无法读取此子会话的公开输出。', noChild: '此记录没有子会话元数据。',
      noOutput: '尚未记录公开输出。', noReasoning: '未提供公开推理；不支持推理输出的模型仅显示正文。',
      reasoning: '公开推理', text: '正文', ordinal: '参与者编号仅代表启动顺序，不对应打乱后的 Answer A/B。',
      reviewOutput: '互评产物', arbiterOutput: '仲裁产物',
      submittingReview: '正在提交评审…', submittingArbiter: '正在提交仲裁…',
      structuredError: '结构化产物提交失败。', structuredUnreadable: '无法读取已记录的结构化产物。',
      evaluations: '逐项评估', strengths: '优点', weaknesses: '不足', ranking: '排序',
      consensus: '共识', contradictions: '分歧', coverageGaps: '覆盖缺口',
      uniqueInsights: '独特见解', blindSpots: '盲区', confidenceNotes: '置信度说明',
      contextMode: '背景模式', chat: '使用当前聊天背景', 'topic-only': '仅议题',
      chatPolicy: '本轮不联网，未读取附件正文。', limitations: '限制说明', decisionDeltas: '关键决策变化',
      coverage: '匿名覆盖 · 回答 {answers}/{answerers}；评审 {reviews}/{reviewers}',
      incompleteCoverage: '部分已请求的参与者未提供有效结果。', citations: '报告的来源（未经独立核验）',
      supported: '支持', revised: '修订', rejected: '否决', unresolved: '未决', noSource: '未报告来源别名',
      'child-failed': '此参与者未能完成。', 'run-canceled': '议会已取消。', 'run-ended': '议会结束时，此参与者尚未完成。',
    };

    function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
    function nonempty(value) { return typeof value === 'string' && value.trim() !== ''; }
    function shape(value, required, optional = []) {
      return record(value) && required.every(key => Object.hasOwn(value, key))
        && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
    }
    function bounded(value, maximum, blank = false) {
      return typeof value === 'string' && value.length <= maximum && (blank || nonempty(value));
    }
    const identifier = value => bounded(value, 512);
    const hash = value => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
    const note = value => bounded(value, 8192);
    const notes = value => Array.isArray(value) && value.length <= 32 && value.every(note);
    function utf8Length(value) { return new TextEncoder().encode(value).length; }
    function aliases(value) {
      return Array.isArray(value) && value.length <= 64 && new Set(value).size === value.length
        && value.every(alias => typeof alias === 'string' && /^S(?:[1-9]|[1-5][0-9]|6[0-4])$/.test(alias));
    }
    function citation(value) {
      if (!shape(value, ['sourceAliases', 'verification'], ['url']) || !aliases(value.sourceAliases)
        || value.verification !== 'reported' || !value.sourceAliases.length && value.url === undefined) return false;
      if (value.url === undefined) return true;
      if (!bounded(value.url, 2048) || !/^https?:\/\//iu.test(value.url) || /\s|[\\\u0000-\u001f\u007f]/u.test(value.url)) return false;
      try {
        const url = new URL(value.url);
        return ['http:', 'https:'].includes(url.protocol) && url.hostname !== '' && url.username === '' && url.password === '';
      } catch (_) { return false; }
    }
    // Browser mirror of context-types.ts's strict ModelReturn, not a permissive
    // renderer DTO. Unknown extensions keep the ordinary history/command fallback.
    function readModelReturn(value) {
      if (!shape(value, ['version', 'runId', 'answerMarkdown', 'decisionDeltas', 'consensus', 'contradictions',
        'blindSpots', 'confidenceNotes', 'citations', 'coverage', 'limitations'], ['packetHash'])
        || value.version !== 1 || !identifier(value.runId) || value.packetHash !== undefined && !hash(value.packetHash)
        || !bounded(value.answerMarkdown, 65536) || utf8Length(value.answerMarkdown) > 65536
        || !Array.isArray(value.decisionDeltas) || value.decisionDeltas.length > 64
        || !value.decisionDeltas.every(delta => shape(delta, ['sourceAliases', 'disposition', 'text'])
          && aliases(delta.sourceAliases) && ['supported', 'revised', 'rejected', 'unresolved'].includes(delta.disposition) && note(delta.text))
        || !notes(value.consensus) || !notes(value.contradictions) || !notes(value.blindSpots) || !note(value.confidenceNotes)
        || !Array.isArray(value.citations) || value.citations.length > 64 || !value.citations.every(citation)
        || !notes(value.limitations)) return null;
      if (value.packetHash === undefined && [...value.decisionDeltas, ...value.citations].some(entry => entry.sourceAliases.length > 0)) return null;
      const coverage = value.coverage;
      const counts = ['answerersRequested', 'answerersSucceeded', 'reviewersRequested', 'reviewersSucceeded'];
      if (!shape(coverage, counts) || !counts.every(key => Number.isSafeInteger(coverage[key]) && coverage[key] >= 1 && coverage[key] <= 8)
        || coverage.answerersRequested < 2 || coverage.answerersSucceeded > coverage.answerersRequested
        || coverage.reviewersSucceeded > coverage.reviewersRequested || utf8Length(JSON.stringify(value)) > 262144) return null;
      return { ...value, coverage: { ...coverage }, decisionDeltas: value.decisionDeltas.map(delta => ({ ...delta, sourceAliases: [...delta.sourceAliases] })),
        consensus: [...value.consensus], contradictions: [...value.contradictions], blindSpots: [...value.blindSpots], limitations: [...value.limitations],
        citations: value.citations.map(entry => ({ ...entry, sourceAliases: [...entry.sourceAliases] })) };
    }
    function ownSource(source, part) {
      return shape(source, ['kind', part]) && source.kind === 'dsh-council';
    }
    function readUi(source) {
      if (!ownSource(source, 'ui')) return null;
      const ui = source.ui;
      if (!shape(ui, ['version', 'commandId', 'status', 'question', 'participants']) || ui.version !== 1
        || !identifier(ui.commandId) || !statuses.includes(ui.status) || typeof ui.question !== 'string'
        || !Array.isArray(ui.participants) || ui.participants.length > 17) return null;
      const seen = new Set();
      const participants = [];
      for (const row of ui.participants) {
        if (!shape(row, ['key', 'stage', 'index', 'status'], ['childId', 'diagnostic']) || !identifier(row.key)
          || seen.has(row.key) || !stages.includes(row.stage) || !Number.isSafeInteger(row.index) || row.index < 1 || row.index > 8
          || row.stage === 'arbiter' && row.index !== 1 || !participantStatuses.includes(row.status)
          || row.childId !== undefined && !identifier(row.childId)
          || row.diagnostic !== undefined && !['child-failed', 'run-canceled', 'run-ended'].includes(row.diagnostic)) return null;
        seen.add(row.key);
        participants.push({ ...row });
      }
      return { version: 1, commandId: ui.commandId, status: ui.status, question: ui.question, participants };
    }
    function progressOf(event) {
      if (event.type === 'user/message') {
        const ui = readUi(event.data && event.data.source);
        return ui ? { ui, authoritative: false } : null;
      }
      if (event.type !== 'agent/inbox/spliced' || !Array.isArray(event.data && event.data.inserted)) return null;
      // Each Host publish injects exactly one complete snapshot; a splice may also contain unrelated messages.
      let found = null;
      for (const message of event.data.inserted) {
        const ui = readUi(message && message.source);
        if (ui) found = { ui, authoritative: true };
      }
      return found;
    }
    function ownMessageOf(event, read) {
      const messages = event.type === 'user/message' && record(event.data) ? [event.data]
        : event.type === 'agent/inbox/spliced' && Array.isArray(event.data && event.data.inserted) ? event.data.inserted : [];
      let found = null;
      // Host injects one domain message per splice. Admission of that same message
      // later joins its existing identity; it must not create another visible row.
      for (const message of messages) {
        const value = record(message) ? read(message) : null;
        if (value) found = { value, authoritative: event.type === 'agent/inbox/spliced' };
      }
      return found;
    }
    function questionOf(event) {
      return ownMessageOf(event, message => {
        const source = message.source;
        if (!ownSource(source, 'question')) return null;
        const question = source.question;
        return shape(question, ['version', 'commandId', 'text']) && question.version === 1 && identifier(question.commandId) && nonempty(question.text)
          ? { commandId: question.commandId, text: question.text } : null;
      });
    }
    function readPresentation(value, v2) {
      return shape(value, ['answerMarkdown', 'auditMarkdown'])
        && bounded(value.answerMarkdown, 65536, v2) && bounded(value.auditMarkdown, 1048576, true)
        ? { answerMarkdown: value.answerMarkdown, auditMarkdown: value.auditMarkdown } : null;
    }
    function answerOf(event) {
      return ownMessageOf(event, message => {
        const source = message.source;
        if (!ownSource(source, 'result') || !record(source.result)) return null;
        const result = source.result;
        if (![1, 2].includes(result.version) || !identifier(result.commandId) || !['success', 'error', 'canceled'].includes(result.status)
          || !Array.isArray(message.content) || !message.content.length
          || !message.content.every(block => shape(block, ['type', 'text']) && block.type === 'text' && typeof block.text === 'string')) return null;
        const text = message.content.map(block => block.text).join('\n\n');
        if (!nonempty(text) || utf8Length(text) > 524288) return null;
        const presentation = result.presentation === undefined ? undefined : readPresentation(result.presentation, result.version === 2);
        if (result.presentation !== undefined && !presentation) return null;
        const common = { commandId: result.commandId, status: result.status, text, ...(presentation ? { presentation } : {}) };
        if (result.version === 1) return shape(result, ['version', 'commandId', 'status'], ['presentation']) ? common : null;
        // Matches run-records.ts's councilResultV2Schema. Locale is recorded by
        // the Host; no markdown-heading guessing or private audit body fallback.
        if (!shape(result, ['version', 'commandId', 'runId', 'parentSessionId', 'status', 'mode', 'locale'],
          result.status === 'success' ? ['modelReturn', 'presentation'] : ['presentation']) || !identifier(result.runId)
          || result.runId !== result.commandId || !identifier(result.parentSessionId) || !['chat', 'topic-only'].includes(result.mode)
          || !['en', 'zh'].includes(result.locale) || message.content.length !== 1) return null;
        if (result.status !== 'success') return { ...common, version: 2, runId: result.runId, parentSessionId: result.parentSessionId, mode: result.mode, locale: result.locale };
        const modelReturn = readModelReturn(result.modelReturn);
        if (!modelReturn || modelReturn.runId !== result.runId || (result.mode === 'chat') !== (modelReturn.packetHash !== undefined)
          || presentation && presentation.answerMarkdown !== modelReturn.answerMarkdown) return null;
        return { ...common, version: 2, runId: result.runId, parentSessionId: result.parentSessionId, mode: result.mode, locale: result.locale, modelReturn };
      });
    }
    function viewNode(context, kind, data) {
      if (!context.start || !context.state) return null;
      return { key: context.key, kind, id: context.id, target: 'chat', anchorSeq: context.start.event.seq,
        location: context.start.location, visibility: 'visible', data };
    }
    const progressDefinition = {
      kind: PROGRESS, target: 'chat',
      match: {
        'agent/inbox/spliced': event => {
          const value = progressOf(event);
          return value ? { id: JSON.stringify([value.ui.commandId, 'progress']), role: 'start', exclusive: true } : null;
        },
        'user/message': event => {
          const value = progressOf(event);
          return value ? { id: JSON.stringify([value.ui.commandId, 'progress']), role: 'start', exclusive: true } : null;
        },
      },
      start: (_context, match) => progressOf(match.event),
      update: (context, match) => {
        const value = progressOf(match.event);
        // An inbox admission can replay old markers after a newer splice. Claim it,
        // but never roll the authoritative progress state backwards or add a second row.
        return value && (value.authoritative || !context.state.authoritative) ? value : context.state;
      },
      buildViewNode: context => viewNode(context, PROGRESS, context.state && context.state.ui),
    };
    function messageDefinition(kind, part, read) {
      const match = event => {
        const value = read(event);
        return value ? { id: JSON.stringify([value.value.commandId, part]), role: 'start', exclusive: true } : null;
      };
      return {
        kind, target: 'chat', match: { 'agent/inbox/spliced': match, 'user/message': match },
        start: (_context, accepted) => read(accepted.event),
        update: (context, accepted) => {
          const value = read(accepted.event);
          return value && (value.authoritative || !context.state.authoritative) ? value : context.state;
        },
        buildViewNode: context => viewNode(context, kind, context.state && context.state.value),
      };
    }
    const questionDefinition = messageDefinition(QUESTION, 'question', questionOf);
    const answerDefinition = messageDefinition(ANSWER, 'answer', answerOf);

    const styles = {
      panel: { margin: '12px 0', minWidth: 0, maxWidth: '100%', boxSizing: 'border-box', overflowWrap: 'anywhere',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12,
        padding: 16, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)' },
      header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', minWidth: 0 },
      muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.6, overflowWrap: 'anywhere' },
      group: { marginTop: 16, minWidth: 0 },
      row: { borderTop: '1px solid var(--dsw-alias-border-l2)', padding: '10px 0', minWidth: 0 },
      button: { width: '100%', minWidth: 0, display: 'flex', flexWrap: 'wrap', overflowWrap: 'anywhere',
        justifyContent: 'space-between', alignItems: 'center', gap: 12,
        textAlign: 'start', border: 0, padding: '4px 0', background: 'transparent', color: 'inherit',
        font: 'inherit', cursor: 'pointer', borderRadius: 4 },
      badge: { fontSize: 12, fontWeight: 400, color: 'var(--dsw-alias-label-secondary)' },
      output: { marginTop: 12, minWidth: 0, paddingInlineStart: 12, borderInlineStart: '2px solid var(--dsw-alias-border-l2)', overflowWrap: 'anywhere' },
      question: { display: 'flex', minWidth: 0, justifyContent: 'flex-end', margin: '12px 0', color: 'var(--dsw-alias-label-primary)' },
      questionBubble: { maxWidth: '88%', minWidth: 0, boxSizing: 'border-box', borderRadius: 16, padding: '12px 16px', whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere', lineHeight: 1.65, font: 'inherit', background: 'var(--dsw-alias-bg-layer-2)' },
      answer: { margin: '16px 0', minWidth: 0, maxWidth: '100%', color: 'var(--dsw-alias-label-primary)', overflowWrap: 'anywhere' },
    };
    function markdown(props, text, running) {
      if (typeof props.renderFactorySlot === 'function') {
        return h('div', { style: { minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere' } },
          props.renderFactorySlot('conversation.chat.reasoning.content', { text, running: Boolean(running) }));
      }
      // Unsupported old renderers degrade safely to literal text, never raw HTML.
      return h('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', minWidth: 0 } }, text);
    }
    function terminal(status) { return status !== 'running' && status !== 'selecting'; }
    function statusText(row, runStatus, t) {
      return t(row.status === 'queued' && terminal(runStatus) ? 'skipped' : row.status);
    }
    function hasOwnPresentation(chat, commandId, parentSessionId) {
      return Boolean(nonempty(commandId) && chat && Array.isArray(chat.order) && chat.nodes && chat.order.some(key => {
        const node = chat.nodes.get(key);
        const data = node && node.data;
        return node && node.kind === ANSWER && node.visibility !== 'hidden' && record(data) && data.commandId === commandId
          && ['success', 'error', 'canceled'].includes(data.status) && nonempty(data.text)
          && (data.version !== 2 || data.runId === commandId && data.parentSessionId === parentSessionId);
      }));
    }
    function chatData(chat, kind, commandId) {
      if (!nonempty(commandId) || !chat || !Array.isArray(chat.order) || !chat.nodes) return null;
      for (const key of chat.order) {
        const node = chat.nodes.get(key);
        if (node && node.kind === kind && record(node.data) && node.data.commandId === commandId) return node.data;
      }
      return null;
    }
    function inlineArbiter(ui, result) {
      if (!record(ui) || !record(result) || ui.commandId !== result.commandId || ui.status !== 'success'
        || result.status !== 'success' || !record(result.presentation) || !nonempty(result.presentation.answerMarkdown)
        || typeof result.presentation.auditMarkdown !== 'string' || !Array.isArray(ui.participants)) return null;
      return ui.participants.find(row => row.stage === 'arbiter' && row.status === 'completed' && nonempty(row.childId)) || null;
    }
    function useSource(source) {
      const actual = source || absent;
      const subscribe = React.useCallback(listener => actual.subscribe(listener), [actual]);
      const getSnapshot = React.useCallback(() => actual.getSnapshot(), [actual]);
      return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    }
    function publicBlocks(node) {
      const blocks = node && node.kind === 'assistant-step' && record(node.data) && Array.isArray(node.data.blocks) ? node.data.blocks : [];
      return blocks.filter(block => record(block) && ['reasoning', 'text'].includes(block.kind) && nonempty(block.text));
    }
    function structuredRoot(node, stage) {
      if (!['review', 'arbiter'].includes(stage) || !node || node.kind !== 'tool-call' || !record(node.data) || !record(node.data.root)) return null;
      const root = node.data.root;
      return root.name === 'structured_output' || root.kind === 'tool-result' && record(root.call) && root.call.name === 'structured_output' ? root : null;
    }
    function stringArray(value) { return Array.isArray(value) && value.every(nonempty); }
    function parseStageOutput(stage, raw) {
      let value;
      try { value = JSON.parse(raw); } catch (_) { return null; }
      if (!record(value) || !stringArray(value.consensus) || !stringArray(value.contradictions) || !stringArray(value.blindSpots)) return null;
      const common = { consensus: value.consensus, contradictions: value.contradictions, blindSpots: value.blindSpots };
      if (stage === 'arbiter') return nonempty(value.answerMarkdown) && nonempty(value.confidenceNotes)
        ? { ...common, answerMarkdown: value.answerMarkdown, confidenceNotes: value.confidenceNotes } : null;
      if (stage !== 'review' || !Array.isArray(value.evaluations) || !value.evaluations.every(entry => record(entry)
        && nonempty(entry.answerId) && stringArray(entry.strengths) && stringArray(entry.weaknesses))
        || !stringArray(value.ranking) || !stringArray(value.coverageGaps) || !Array.isArray(value.uniqueInsights)
        || !value.uniqueInsights.every(entry => record(entry) && nonempty(entry.answerId) && nonempty(entry.insight))) return null;
      return { ...common, evaluations: value.evaluations.map(entry => ({ answerId: entry.answerId, strengths: entry.strengths, weaknesses: entry.weaknesses })),
        ranking: value.ranking, coverageGaps: value.coverageGaps,
        uniqueInsights: value.uniqueInsights.map(entry => ({ answerId: entry.answerId, insight: entry.insight })) };
    }
    function outputList(props, label, values, ordered) {
      if (!values.length) return null;
      return h('section', { key: label, 'aria-label': props.t(label) },
        h('h5', { style: { margin: '12px 0 4px', fontSize: 12 } }, props.t(label)),
        h(ordered ? 'ol' : 'ul', { style: { margin: '4px 0', paddingInlineStart: 22 } }, values.map((value, index) => h('li', { key: index, style: { whiteSpace: 'pre-wrap' } }, value))));
    }
    function StructuredOutput(props, root) {
      const stage = props.row.stage;
      const settled = root.kind === 'tool-result';
      // Only the public dispatched arguments belong to this root call. Preparing
      // PartialArguments, opaque result content and recursive subCalls stay unread.
      const raw = settled ? record(root.call) && root.call.argsRaw : root.phase === 'start' ? root.argsRaw : null;
      const output = typeof raw === 'string' && !root.isError ? parseStageOutput(stage, raw) : null;
      const status = settled && root.isError ? 'structuredError' : !output
        ? settled ? 'structuredUnreadable' : stage === 'review' ? 'submittingReview' : 'submittingArbiter' : null;
      return h('section', { style: styles.output, 'aria-label': props.t(stage === 'review' ? 'reviewOutput' : 'arbiterOutput'), 'data-council-stage-output': stage },
        h('strong', { style: { fontSize: 13 } }, props.t(stage === 'review' ? 'reviewOutput' : 'arbiterOutput')),
        status && h('p', { role: 'status', style: styles.muted }, props.t(status)),
        output && h(React.Fragment, null,
          stage === 'arbiter' && !props.omitFinalAnswer && markdown(props, output.answerMarkdown, !settled),
          stage === 'review' && h('section', { 'aria-label': props.t('evaluations') }, output.evaluations.map((entry, index) =>
            h('section', { key: index }, h('h5', { style: { margin: '12px 0 4px' } }, entry.answerId),
              outputList(props, 'strengths', entry.strengths), outputList(props, 'weaknesses', entry.weaknesses)))),
          stage === 'review' && outputList(props, 'ranking', output.ranking, true),
          outputList(props, 'consensus', output.consensus), outputList(props, 'contradictions', output.contradictions),
          stage === 'review' && outputList(props, 'coverageGaps', output.coverageGaps),
          stage === 'review' && outputList(props, 'uniqueInsights', output.uniqueInsights.map(entry => entry.answerId + ': ' + entry.insight)),
          outputList(props, 'blindSpots', output.blindSpots),
          stage === 'arbiter' && h('section', { 'aria-label': props.t('confidenceNotes') },
            h('h5', { style: { margin: '12px 0 4px', fontSize: 12 } }, props.t('confidenceNotes')),
            h('p', { style: { whiteSpace: 'pre-wrap' } }, output.confidenceNotes))));
    }
    function ChildOutput(props) {
      const node = useSource(props.source);
      const root = structuredRoot(node, props.row.stage);
      const visible = publicBlocks(node);
      const structured = Boolean(root);
      const hasOutput = structured || visible.length > 0;
      React.useEffect(() => {
        props.onPresence(props.nodeKey, { structured, hasOutput });
        return () => props.onPresence(props.nodeKey, null);
      }, [props.onPresence, props.nodeKey, structured, hasOutput]);
      if (root) return StructuredOutput(props, root);
      if (!visible.length) return null;
      const reasoning = visible.some(block => block.kind === 'reasoning');
      return h('div', { style: styles.output },
        !reasoning && !props.structured && h('p', { style: styles.muted }, props.t('noReasoning')),
        visible.map((block, index) => h('section', { key: index, 'aria-label': props.t(block.kind === 'reasoning' ? 'reasoning' : 'text') },
          h('div', { style: styles.muted }, props.t(block.kind === 'reasoning' ? 'reasoning' : 'text')),
          markdown(props, block.text, node.data.status === 'running'))));
    }
    function ChildTranscript(props) {
      // Topology is immutable; each child reads tokens/tool state through its
      // own existing source. Presence facts change only on empty/nonempty or
      // structured/unstructured transitions, including without target publication.
      const orderSource = React.useMemo(() => ({ subscribe: listener => props.target.subscribe(listener),
        getSnapshot: () => { const chat = props.target.getSnapshot(); return chat ? chat.order : EMPTY_ORDER; } }), [props.target]);
      const order = useSource(orderSource);
      const [presence, setPresence] = React.useState(() => new Map());
      const onPresence = React.useCallback((key, value) => setPresence(previous => {
        const old = previous.get(key);
        if (old === value || old && value && old.structured === value.structured && old.hasOutput === value.hasOutput) return previous;
        const next = new Map(previous);
        if (value) next.set(key, value); else next.delete(key);
        return next;
      }), []);
      const structured = [...presence.values()].some(value => value.structured);
      const hasOutput = [...presence.values()].some(value => value.hasOutput);
      const chat = props.target.getSnapshot();
      const keys = chat ? order.filter(key => { const node = chat.nodes.get(key); return node
        && (node.kind === 'assistant-step' || ['review', 'arbiter'].includes(props.row.stage) && node.kind === 'tool-call'); }) : EMPTY_ORDER;
      return h('div', null,
        !hasOutput && h('p', { style: styles.muted }, props.t('noOutput')),
        !hasOutput && h('p', { style: styles.muted }, props.t('noReasoning')),
        chat && keys.map(key => h(ChildOutput, { key, ...props, nodeKey: key, structured, onPresence, source: chat.nodes.source(key) })));
    }
    function BoundChild(props) {
      // Session Controller 0.2.1: binding.session is the observable SessionFace.
      // ready can resolve with openState:error; later stream failures publish here too.
      const snapshot = useSource(props.binding.session);
      const openState = snapshot && snapshot.openState;
      const target = React.useMemo(() => {
        if (openState !== 'open') return null;
        try {
          const value = props.ctx.uiConversation.binding(props.binding).target('chat');
          return value && typeof value.getSnapshot === 'function' && typeof value.subscribe === 'function' ? value : null;
        } catch (_) { return null; }
      }, [props.ctx, props.binding, openState]);
      if (target) return h(ChildTranscript, { ...props, target });
      return h('p', { style: styles.muted, role: 'status' }, props.t(['cold', 'loading'].includes(openState) ? 'loading' : 'unavailable'));
    }
    function ChildDetails(props) {
      const [state, setState] = React.useState({ binding: null, error: false });
      React.useEffect(() => {
        let live = true;
        let reference;
        setState({ binding: null, error: false });
        try {
          reference = props.ctx.sessions.retain({ parentSessionId: props.parentSessionId, childSessionId: props.childId, mode: 'continuable' }, { source: 'controllerOperation' });
          Promise.resolve(reference.ready).then(() => {
            if (!live) return;
            const binding = reference.binding;
            if (!binding || !binding.session || typeof binding.session.getSnapshot !== 'function' || typeof binding.session.subscribe !== 'function') {
              setState({ binding: null, error: true });
              return;
            }
            setState({ binding, error: false });
          }).catch(() => { if (live) setState({ binding: null, error: true }); });
        } catch (_) { setState({ binding: null, error: true }); }
        return () => { live = false; if (reference) reference.release(); };
      }, [props.ctx, props.parentSessionId, props.childId]);
      if (state.error) return h('p', { style: styles.muted, role: 'status' }, props.t('unavailable'));
      return state.binding ? h(BoundChild, { ...props, binding: state.binding })
        : h('p', { style: styles.muted, role: 'status' }, props.t('loading'));
    }
    function Participant(props) {
      const row = props.row;
      const hasFinal = Boolean(props.finalResult);
      const [expanded, setExpanded] = React.useState(hasFinal);
      const [processOpen, setProcessOpen] = React.useState(false);
      React.useEffect(() => { if (hasFinal) setExpanded(true); }, [hasFinal]);
      const id = React.useId();
      const title = props.t('participant', { index: row.index });
      const canExpand = nonempty(row.childId) && nonempty(props.parentSessionId);
      return h('div', { style: styles.row },
        canExpand ? h('button', { type: 'button', style: styles.button, 'aria-expanded': expanded,
          'aria-controls': id, 'aria-label': title + ': ' + props.t(expanded ? 'collapse' : 'expand'),
          onClick: () => setExpanded(value => !value) },
        h('span', null, (expanded ? '▾ ' : '▸ ') + title), h('span', { style: styles.badge }, statusText(row, props.status, props.t)))
          : h('div', { style: styles.header }, h('span', null, title), h('span', { style: styles.badge }, statusText(row, props.status, props.t))),
        row.diagnostic && h('p', { style: styles.muted }, props.t(row.diagnostic)),
        !canExpand && terminal(props.status) && h('p', { style: styles.muted }, props.t('noChild')),
        expanded && canExpand && h('div', { id }, hasFinal
          ? h(React.Fragment, null,
            h(DecisionContents, { ...props, data: props.finalResult }),
            h('details', { open: processOpen, style: { marginTop: 12 }, onToggle: event => setProcessOpen(event.currentTarget.open) },
              h('summary', { style: { ...styles.muted, cursor: 'pointer' } }, props.t('arbiterProcess')),
              processOpen && h(ChildDetails, { ...props, omitFinalAnswer: true, key: props.parentSessionId + ':' + row.childId, childId: row.childId })))
          : h(ChildDetails, { ...props, key: props.parentSessionId + ':' + row.childId, childId: row.childId })));

    }
    function makeProgress(ctx) {
      return function CouncilProgress(props) {
        const ui = props.node.data;
        const parentSessionId = props.useSession(session => session.sessionId);
        const t = props.t;
        const done = terminal(ui.status);
        const finalResult = typeof props.useChat === 'function' ? props.useChat(chat => chatData(chat, ANSWER, ui.commandId)) : null;
        const finalRow = inlineArbiter(ui, finalResult);
        const hasFinal = Boolean(finalRow);
        const [open, setOpen] = React.useState(!done || hasFinal);
        // Open once when the final decision arrives; later renders respect a manual collapse.
        React.useEffect(() => { setOpen(!done || hasFinal); }, [done, hasFinal]);
        const completed = ui.participants.filter(row => row.status === 'completed').length;
        return h('details', { style: styles.panel, open, onToggle: event => setOpen(event.currentTarget.open),
          'aria-label': t('title'), 'data-council-status': ui.status },
          h('summary', { style: { ...styles.header, cursor: 'pointer' } },
            h('strong', null, (open ? '▾ ' : '▸ ') + t('process', { completed, total: ui.participants.length })),
            h('span', { role: 'status', style: styles.badge }, t(ui.status))),
          open && h(React.Fragment, null, h('p', { style: styles.muted }, t('ordinal')),
          stages.map(stage => {
            const rows = ui.participants.filter(row => row.stage === stage);
            return rows.length ? h('section', { key: stage, style: styles.group, 'aria-label': t(stage) },
              h('h4', { style: { margin: '0 0 8px', fontSize: 13, fontWeight: 600 } }, t(stage)),
              rows.map(row => h(Participant, { key: row.key, ctx, row, status: ui.status, parentSessionId, t,
                finalResult: finalRow && row.key === finalRow.key ? finalResult : null, renderFactorySlot: props.renderFactorySlot }))) : null;
          })));
      };
    }
    function CouncilQuestion(props) {
      return h('div', { style: styles.question, 'aria-label': props.t('question') },
        h('div', { style: styles.questionBubble }, props.node.data.text));
    }
    function ModelReturnDetails(props) {
      const value = props.value;
      const coverage = value.coverage;
      return h(React.Fragment, null,
        h('p', { style: styles.muted, 'data-council-coverage': true }, props.t('coverage', {
          answers: coverage.answerersSucceeded, answerers: coverage.answerersRequested,
          reviews: coverage.reviewersSucceeded, reviewers: coverage.reviewersRequested })),
        (coverage.answerersSucceeded < coverage.answerersRequested || coverage.reviewersSucceeded < coverage.reviewersRequested)
          && h('p', { style: styles.muted }, props.t('incompleteCoverage')),
        outputList(props, 'limitations', value.limitations),
        value.decisionDeltas.length > 0 && h('section', { 'aria-label': props.t('decisionDeltas') },
          h('h5', { style: { margin: '12px 0 4px', fontSize: 12 } }, props.t('decisionDeltas')),
          h('ul', { style: { paddingInlineStart: 22 } }, value.decisionDeltas.map((delta, index) => h('li', { key: index, style: { whiteSpace: 'pre-wrap' } },
            h('strong', null, props.t(delta.disposition) + ' · ' + (delta.sourceAliases.join(', ') || props.t('noSource')) + ': '), delta.text)))),
        outputList(props, 'consensus', value.consensus), outputList(props, 'contradictions', value.contradictions),
        outputList(props, 'blindSpots', value.blindSpots),
        h('section', { 'aria-label': props.t('confidenceNotes') }, h('h5', { style: { margin: '12px 0 4px', fontSize: 12 } }, props.t('confidenceNotes')),
          h('p', { style: { whiteSpace: 'pre-wrap' } }, value.confidenceNotes)),
        outputList(props, 'citations', value.citations.map(entry => [entry.sourceAliases.join(', '), entry.url].filter(Boolean).join(' · '))));
    }
    function DecisionContents(props) {
      const data = props.data;
      const [auditOpen, setAuditOpen] = React.useState(false);
      const presentation = data.presentation;
      const modelReturn = data.modelReturn;
      return h('article', { style: styles.answer, 'aria-label': props.t('result') },
        h('div', { style: { ...styles.muted, marginBottom: 8 } }, props.t('result')),
        data.version === 2 && h('p', { style: styles.muted, 'data-council-mode': data.mode }, props.t('contextMode') + ': ' + props.t(data.mode)),
        data.version === 2 && data.mode === 'chat' && h('p', { style: styles.muted }, props.t('chatPolicy')),
        markdown(props, modelReturn ? modelReturn.answerMarkdown : presentation && nonempty(presentation.answerMarkdown) ? presentation.answerMarkdown : data.text, false),
        modelReturn && h(ModelReturnDetails, { ...props, value: modelReturn }),
        presentation && nonempty(presentation.auditMarkdown) && h('details', { style: { marginTop: 16, minWidth: 0 }, open: auditOpen,
          onToggle: event => setAuditOpen(event.currentTarget.open) },
          h('summary', { style: { ...styles.muted, cursor: 'pointer' } }, props.t('audit')),
          auditOpen && markdown(props, presentation.auditMarkdown, false)));
    }
    function CouncilAnswer(props) {
      const data = props.node.data;
      const ui = typeof props.useChat === 'function' ? props.useChat(chat => chatData(chat, PROGRESS, data.commandId)) : null;
      // Keep the authoritative node/context, but give its visible body one owner.
      if (inlineArbiter(ui, data)) return null;
      return h(DecisionContents, { ...props, data });
    }
    function CouncilCommand(props) {
      const node = props.node;
      const parentSessionId = typeof props.useSession === 'function' ? props.useSession(session => session.sessionId) : undefined;
      const ownPresentation = typeof props.useChat === 'function' ? props.useChat(chat => hasOwnPresentation(chat, node.commandId, parentSessionId)) : false;
      // A seq reference or a question/progress row does not prove that a result
      // renderer exists. In particular, preserve native failures before handoff.
      if (ownPresentation) return null;
      return h('section', { style: styles.panel, 'aria-label': props.t('title') },
        h('header', { style: styles.header }, h('strong', null, props.t('title')),
          h('span', { style: styles.badge, role: 'status' }, props.t(!node.outcome ? 'running' : node.outcome.kind === 'success' ? 'success' : 'error'))),
        node.outcome && typeof node.outcome.text === 'string' && markdown(props, node.outcome.text, false));
    }

    return {
      inject: ['slots', 'uiConversation', 'sessions', 'locale'],
      apply(ctx) {
        // Older Clients lack the target-neutral registry. Leave their ordinary
        // command history untouched instead of installing a partial renderer.
        if (!ctx.uiConversation || !ctx.uiConversation.events || typeof ctx.uiConversation.events.register !== 'function'
          || typeof ctx.uiConversation.binding !== 'function' || !ctx.slots || typeof ctx.slots.inject !== 'function'
          || typeof ctx.slots.register !== 'function' || !ctx.locale || typeof ctx.locale.register !== 'function'
          || !ctx.sessions || typeof ctx.sessions.retain !== 'function') return;
        ctx.effect(() => ctx.locale.register(NS, { en, zh }));
        ctx.effect(() => ctx.uiConversation.events.register(questionDefinition));
        ctx.effect(() => ctx.uiConversation.events.register(progressDefinition));
        ctx.effect(() => ctx.uiConversation.events.register(answerDefinition));
        ctx.slots.inject('conversation.chat.node', function* () {
          yield ctx.slots.register({ name: 'conversation.chat.node', key: QUESTION, locale: NS }, CouncilQuestion);
          yield ctx.slots.register({ name: 'conversation.chat.node', key: PROGRESS, locale: NS }, makeProgress(ctx));
          yield ctx.slots.register({ name: 'conversation.chat.node', key: ANSWER, locale: NS }, CouncilAnswer);
        });
        ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
          name: 'conversation.chat.commandview', key: 'council', locale: NS,
        }, CouncilCommand));
      },
    };
  },
});
