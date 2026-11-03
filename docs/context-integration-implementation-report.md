# 上下文融合 MVP 施工报告

> 本文保留实现完成时的验证与授权边界；用户随后授权将 0.1.3 发布到 GitHub/npm。发布进展以[发布记录](release-readiness.md)和公共 registry 为准，不代表真实 profile 已安装或真机已验收。

> **最终结论（2026-11-03 23:08）**：本地工程验证完成，真机验收待做。446 单测、typecheck/docs/build/diff 检查全部 exit 0；固定旧/新 Host 隔离 smoke 均 exit 0，新 Host 确实覆盖三轮 chat。未安装、重启、发布或调用真实模型。

## 基线与施工纪律

- 开工 HEAD：`bc8afc579e6d4dc62fabcac40668aa04c75285e2`，分支 main（ahead 2）。
- 开工 dirty：未跟踪 artifacts/、docs/ai-context-integration-build.md、docs/context-integration-article/、docs/context-integration-design/；原样保留。不提交、不切分支、不修改 DSH 源码。
- 包：@greenhats/dsh-council 0.1.3；开发 SDK 0.1.2-rc.1；当前桌面 Host 0.2.1-rc.5（与开发 SDK 分开适配）。
- 工具链：Harness dependency discovery 提供 Node v24.21.0、pnpm 11.7.0；使用绝对 Node 可执行文件和 pnpm 脚本，不修改全局 PATH。
- 本次授权范围：实现、测试、构建、隔离 fake-adapter Host smoke；未授权安装真实 profile、重启、发布或真实业务模型费用。
- 子 agent 所有权：A 仅 context-types/context-packet/handoff 与测试；B 仅 context-budget 与测试；主 agent 捕获、契约、入口和后续整合。后续重新分派必须明确文件范围，避免共享文件并写。以此报告作为唯一阶段交接，不复制真实聊天到 fixture。

## 能力核对

已通过 Inspect discovery 后定向读取当前 Host 的 agents、agentLoop、sessionProjections、userQuestions、subagents 和 agent/pre-step；预算 agent 另核对 llm/tokenMeter/llm/stream。

| 能力 | 核对结果与约束 |
|---|---|
| live Session | Session.deriveMessages() 同步；seq 为下一 offset。只读有效历史，不重放 Surface 旧版本。 |
| root/owner | agents.get 精确实例 + roots 当前 runtime ownership；不能用 durable parentSession 代替 root 判据。 |
| Inbox | snapshot 同步同 cut，asOfSeq 为末事件 cursor，空日志 -1；安装包 inbox 为 next-turn/next-step 当前队列。cachedSnapshot 不用于围栏。 |
| 原生询问 | userQuestions.ask 支持 detail/owner/signal；与 answer/askTimed 的持久 continued question 区分。真实 Client 完整预览尚未验收。 |
| subagent | 0.2 caller activation、精确 receipt.dispose；兼容既有 legacy fresh 路径。 |
| request guard | llm/stream 为同步返回 AsyncIterable 的 waterfall；先检查后 next，不返回 Promise<AsyncIterable>。 |
| pre-step | 改写 enter decision 必须 spread 保留 startsRequestSeries。 |
| Client/真实模型 | 未安装本次代码，未执行真机或真实模型验收。 |

## 阶段状态

| 阶段 | 状态 | 证据 |
|---|---|---|
| P0 | done | 基线179 tests/typecheck，capture只读契约fixture已落地。 |
| P1 | done | 严格DTO/规范JSON SHA256/公开私有分层/独立ModelReturn renderer，58 tests。 |
| P2 | done | live同步cut、精确root、白名单、当前Inbox、去重/清除/撤回，12 capture tests。 |
| P3 | done | 预算52 + 编排25 + 协议17 tests；未知窗口拒绝、匿名corpus同版、实际产物/请求守门。 |
| P4 | done | 原生选择/完整literal预览、撤回复查、独立父子绑定、首await前quarantine；新Host实际拒绝探针通过。 |
| P5 | done | packet/material/child-binding/state实体Projection，唯一真实terminal先写后UI；取消/late startup/错误提交/冷重开回归通过。 |
| P6 | done（组件） | 严格v1/v2、正文/审计分离、命令fallback、openState错误与引用释放，80组件tests通过；真机未做。 |
| P7 | done（本地/隔离Host） | 446单测、types/docs/build通过；两个固定版本Host均exit0，含三轮chat；README/安全/聊天文档及本报告更新。 |

## 测试记录

| 命令（均用 discovery Node + pnpm） | exit code | 结果 |
|---|---|---|
| 基线 pnpm typecheck | 0 | 原有类型检查通过。 |
| 基线 pnpm test | 0 | 8 文件、179 单测通过。 |

后台 job bash-261ba0c7ef83447f 已收集，exit 0。未发现基线失败。

## 当前边界与未验证项

不新增云摘要、附件读取/OCR、chat Web、fork/agent 复用、自动整轮恢复。能力/窗口不可信应显式拒绝或人工选仅议题，不冒充携带背景。真机安装与 UI/真实模型质量验收仍未做；最终报告将按实际结果更新，不将组件/Host fake 测试等同上线。

## 中途验证与修复（22:10）

- P1定向3文件58 tests exit0；加run-records后4文件77 tests exit0；加v2 child-policy后5文件117 tests exit0。预算/编排/协议94 tests exit0（其中预算52）。原生准备交互12 tests exit0。
- 主整合第一次capture/typecheck：capture12通过，typecheck exit2发现预算callback隐式类型和同步deadline callback类型，均已修复。
- 集成typecheck过程中发现深readonly DTO与exactOptionalPropertyTypes、stage联合窄化等错误，已修复；22:08 typecheck exit0（之后仍在继续整合，最终需重跑）。
- 既有Host unit harness新增多Projection、Session eventAt/identity和v2冷恢复路由后，43个入口tests已有42通过；剩1项fixture仍把首条empty runRecord/最后progress误认question/result的旧位置假设，待改为严格来源/唯一性断言，不删除断言。capture12与chat旧18通过。
- 已修复安全review发现的异步授权窗口：prepare返回后、commitPacket前同步复查；每个initial child的llm/stream adapter前再次复查来源撤回；重新比对实际roster的exportHash；v2结果正文必须精确匹配ModelReturn；同ID/同正文但来源认知标签变化也撤销授权。
- 当前Host/SDK structured-output JSON Schema为受限subset，不接受maxLength/maxItems。实际outputSchema使用合法strict object/enum；Host严格Zod parser和byte/token产物守门执行这些上限，不硬塞不支持字段。
- v2策略采用mode判别联合：chat必须持久route/window/estimator/output/packetHash且global tools=[]；topic-only可没有窗口政策（保留旧Host/未知窗口路径），但仍保存确切route/output/真实Web工具集合；不伪造topic窗口或声称有窗口守门。旧v1原样可读。
- Client服务/Slots Inspect均超时。已从安装包确认ready可以resolve但binding.session.getSnapshot().openState仍为error，需session.subscribe观察；原生detail完整传入MarkdownText无JS主动截断，滚动/窄屏仍需继续核对和授权后真机验收。

### 当前子agent所有权

- A：context-types/context-packet/handoff/run-records与相关测试，随后独占child-policy测试、只读安全review。
- B：context-budget/council/protocol/types与相关测试，随后独占Host fixture和runner。
- C：仅client.js与client组件测试。
- 主agent：context-capture/context-preparation/context-host、index/chat/child-policy生产接线与入口fixture、报告/文档。禁止交叉覆盖；未动开工前未跟踪材料。

## 安全复核、Host 实测与继续施工检查点（22:56）

### 已修复且有回归的实质问题

1. SEC-03：整条 v2 policy 丢失原先会被误认普通 agent。新增父 run `child-binding` manifest（完整 policy 的 canonical hash）及子日志独立 `source.childBinding`；两个 Projection 的 stateVersion 提升 3，producer 仍为 v2。冷恢复必须同时核对父绑定/完整策略；仅 policy、仅子 binding、冲突或两子 marker 都丢而父 manifest 尚在均失败关闭。live 父优先；离线用公共 `sessionQuery.observeSession` + `sessionProjections.restore` 取 host checkpoint，finally 释放观察 lease，不自行重放业务日志，不给 live 捕获加 SessionQuery 强依赖。
2. RUN-01：blank retention 原无界 whenIdle 可阻塞取消/卸载。现按 command+lifecycle signal 可取消；精确 Inbox.remove 清除未消费 marker；已 claim/无法证明移除的 marker 保留 parent-owned exact-ID veto 至父 driver 收敛，不取消无关父任务、不提前卸 guard。新增 pending/claimed 两种延迟 fixture。
3. RUN-02：canonical 写入失败必须返回 error；写入后 UI publish 失败/晚到取消仍按已提交 canonical 的状态、正文和真实 seq 返回，不写相反结果。error 冷重开保留原正文，不冒充 canceled。
4. SEC-01：第二轮真实 Host smoke 揭示 cold restore 在异步 manifest/window 查询前存在早期工具窗口。现首个 await 前安装 agent-owned deny-all quarantine；永久策略/角色/预算/绑定完成后才释放，失败留到 factory rollback。严格 native tools.execute probe 不推迟、不放宽。新增同步 cold 创建窗口单测；需 GO3 新 Host smoke 复验。
5. ASK-01：最终确认以 fenced literal JSON 展示，避免背景文本被 Markdown 折叠/解释；附件引用名称/处置撤回同样使旧同意失效。不读任何附件正文。

### 当前本地完整验证

- 22:19：typecheck=0、15文件417 tests=0、build=0。
- 22:43：独立 parent/child 绑定、retention 修复后，typecheck=0、16文件444 tests=0、build=0。
- 22:55：quarantine、literal preview、附件引用撤回后，**typecheck=0，16文件446 tests=0，build=0**；生成 JS 188.31 kB。后台主 job `bash-235644378a3d47f3` 已收集。
- docs:check=0、git diff --check=0（22:20；最终还会重跑）。入口 fixture 对真实 serial factory 的 failed-unpublished setup 增加 scope rollback，而非放宽 late-start 清理断言；旧两项 late-start 测试现仍通过。

### 隔离 Host smoke 结果（不等于 profile 安装）

| 轮次/运行时 | Host | exit | 结论 |
|---|---|---|---|
| GO1，Harness 提供 Node v24.21.0 ABI137 | 0.1.2-rc.1 | 1 | 未入业务：sharp/koffi native Team-ID mismatch、pty 缺构件等。临时目录已清理。 |
| GO1，同上 | 0.2.1-rc.5 | 1 | 未入业务：require-builtin native 无可用 binding。临时目录已清理。 |
| GO2，系统普通 Node v24.21.0 ABI137 | 0.1.2-rc.1 | 0 | 22:43 构建的 legacy/topic 路径：严格8 calls、8 guards、2 cold reloads，无 chat（旧 Host 能力范围）。 |
| GO2，同上 | 0.2.1-rc.5 | 1 | 已入业务；严格 forbidden probe 返回成功，揭示上述 cold 早期工具窗口。已修，未将这次计作通过。 |
| GO3，同上，22:55构建 | 0.1.2-rc.1 | 0 | legacy/topic严格8 calls、8 guards、2 cold reloads；临时目录已清理。 |
| GO3，同上，22:55构建 | 0.2.1-rc.5 | 0 | topic 8 calls/10 guards/2冷恢复；另chat三轮12 calls、16 guards、1合法cold、3类adapter前拒绝、1父跟进；临时目录已清理。 |

使用系统普通 Node 是选择项目 engines 允许的兼容测试运行时，未剥签名、重签、关闭 Library Validation、修改全局 PATH 或扩大 sandbox 权限。单测/构建仍使用 Harness discovery 提供的 Node/pnpm。runner 仅改临时 runtime 根解析到同一 profile 安装 artifact（校验name/version/bytes），不修改提供的缓存树或真实用户 profile；固定版本，拒绝 latest/range，失败输出 native 版本诊断。GO1/GO2 的四个子 job 均已收集，四个临时 HOME/DSH_HOME 均确认清除；GO3 两个 job 亦已回报、收集并核对清理，详细结果见最终证据。

### 22:56 时接续点（历史检查点，现已完成）

- 生产 source/lib 暂冻结在22:55构建，等待 B 的 GO3 严格新 Host chat smoke + 最终旧 Host复验。若失败先定位，不削弱权限/路由/人数/请求计数断言。
- A、C 已收尾，B 仅负责两个 smoke 与临时 runner/fixture 诊断；主 agent负责必要生产修复、文档和最终全量验收。
- 待完成：GO3 业务验收、最终 docs/typecheck/tests/build/diff 检查、用例ID映射/施工报告收尾、任务/goal完结。真机仍未授权且未验证。
- 开工前用户未跟踪 artifacts/、施工单、article/design 目录没有被清理或改写；没有提交、安装、重启、发布或真实模型请求。

## 最终工程交付（本地工程验证完成，真机验收待做）

### 最终隔离 Host 证据

- `DSH_TEST_VERSION=0.1.2-rc.1`：GO3 job `bash-e46e033aa1cb4609`，exit 0；en/zh、calls=8、guardChecks=8、coldReloads=2、continuations=0、api=legacy、chat.supported=false（不为旧 Host 伪造新能力）。
- `DSH_TEST_VERSION=0.2.1-rc.5`：GO3 job `bash-0c94877e54e847b1`，exit 0；topic calls=8、guardChecks=10、coldReloads=2、continuations=2、api=activation、en/zh。新增 chat calls=12、runs=3、guardChecks=16、合法cold=1、deniedProbes=[route,max-tokens,huge-system]、parentFollowups=1。
- 新 Host 真实 GenerateOptions/原生工具管线已验证：同意前业务调用0；chat无Web；packet/material/corpus hash固定；第二轮当前pending结果恰一次；第三轮clear后不复活；父普通跟进content只有议题和精简结果，没有full audit/空marker/raw child reasoning；cold路由/输出/巨大system在adapter调用计数增加前拒绝；所有 forbidden 执行体计数0。
- 两个 GO3 jobs 已收集；各自临时 HOME/profile 已由 runner finally 删除并核对不存在。没有遗留子 agent 验证 job 或替代 Web 服务。

### 回归用例映射与验证层级

| 施工单 ID | 自动证据 | 边界 |
|---|---|---|
| CAP-01 | [入口测试](https://github.com/Green-hats/dsh-council/blob/v0.1.3/tests/index.spec.ts)、隔离Host blank-session | 无父额外completion，原生零步骤retention。 |
| CAP-02 | [捕获测试](https://github.com/Green-hats/dsh-council/blob/v0.1.3/tests/context-capture.spec.ts)、新Host packet cut | 同步seq/inbox围栏、detached文本。 |
| CAP-03 | 捕获测试的真实SDK Inbox claim→admit fixture | running时Inbox已claim而surface尚空仍拒绝；不是只按消息空缺假装成功。 |
| CAP-04 | 捕获fixture的maintenance/seq变化及有效replace | 不用旧seq过滤当前Surface；未做真实长会话compaction压力测试。 |
| CAP-05 / CAP-06 | 捕获fixture、三轮新Host chat | active pending去重、admitted去重、clear/remove/replace不复活。 |
| CAP-07 | 入口双父并发、DTO跨父拒绝、v2来源父绑定 | 两父真实chat同时跑的真机场景未验。 |
| PKT-01 / PKT-02 | 捕获/DTO/packet/撤回测试 | 原文与认知标签不洗白，来源白名单，不复制provider/replay/系统资料。 |
| PKT-03 / PKT-04 | [packet测试](https://github.com/Green-hats/dsh-council/blob/v0.1.3/tests/context-packet.spec.ts)、预算/来源测试 | 公共payload无私有路由/引用，工具opt-in，附件正文不读；reference撤回失效。 |
| ASK-01 / ASK-02 | [原生准备测试](https://github.com/Green-hats/dsh-council/blob/v0.1.3/tests/context-preparation.spec.ts)、新Host原生ask fixture | 独立ID解析，空/自定义/未知/重复拒绝，取消晚到不发，完整literal JSON与路由；真Client64KiB滚动未验。 |
| BUD-01 / BUD-03 | [预算测试](https://github.com/Green-hats/dsh-council/blob/v0.1.3/tests/context-budget.spec.ts) | 未知/小窗口、8×产物、真实序列化Unicode/byte/token分别检查，无裁剪。 |
| BUD-02 | 预算fake GenerateOptions、新Host huge-system cold probe | adapter前拒绝；仍为TokenMeter启发式，不是provider精确tokenizer。 |
| MAT-01 | [编排测试](https://github.com/Green-hats/dsh-council/blob/v0.1.3/tests/council.spec.ts)、新Host材料实体/hash复核 | 同阶段payload同版，review/arbiter共用匿名AnswerCorpus。 |
| SEC-01 / SEC-02 | 新Host原生tools.execute、首次/冷恢复真实请求 | 禁文件/Shell/Web/再委派；quarantine覆盖异步验证前窗口；route drift拒绝。 |
| SEC-03 | [policy测试](https://github.com/Green-hats/dsh-council/blob/v0.1.3/tests/child-policy.spec.ts)、[run-records测试](https://github.com/Green-hats/dsh-council/blob/v0.1.3/tests/run-records.spec.ts)、入口毁损fixture、[cold桥测试](https://github.com/Green-hats/dsh-council/blob/v0.1.3/tests/context-host.spec.ts) | policy字段/整条/两子marker缺失均有独立父证据拒绝；native cold正常路径另有Host实测。 |
| RUN-01 | 入口late startup/dispose/unload/retention pending+claimed fixture | 精确清理不取消无关父任务，guard不早撤；Host验证子Agents释放。 |
| RUN-02 | 入口canonical write failure/UI failure/cancel race，run-record跨实例测试 | 首个逻辑terminal、真实source seq；旧SDK error outcome无sourceEventSeq字段，canonical error仍有日志引用。 |
| RET-01 / RET-03 | [handoff测试](https://github.com/Green-hats/dsh-council/blob/v0.1.3/tests/handoff.spec.ts)、[协议测试](https://github.com/Green-hats/dsh-council/blob/v0.1.3/tests/protocol.spec.ts)、Client测试 | 不按标题切正文，v1可靠presentation专用reader，未知版本保守回退。 |
| RET-02 | 入口pre-step与新Host下一次正常父请求 | 保留request-series flags；只准入真实question/ModelReturn，无额外总结请求。 |
| UI-01 | [Client组件测试](https://github.com/Green-hats/dsh-council/blob/v0.1.3/tests/client.spec.ts) 80项、安装包公开契约只读核对 | retain/openState error/订阅释放/unknown fallback；真机light/dark/窄宽/交互未验。 |
| REC-01 | run-records真实Session/Inbox冷重开、policy/native cold、入口同command重放 | 重开读原packet、不补pending、不自动续跑整轮；崩溃UI最终视觉状态仍在真机清单。 |

### 配置与使用

默认 `contextMode: chat` 先询问本轮是否携带背景；`contextMode: topic-only` 完全跳过捕获。来源选择/完整确认与原四项模型阵容分开。未知窗口必须来自可信模型元数据或用户核实的 exact-key override，否则显式选择仅议题或取消。预算默认值集中归一化，旧Config省略字段兼容；chat阶段output为原cap与产物预算的较小值。Web仅保留在仅议题模式。

只把同意后的公开packet和必要私有定位持久化；没有云摘要、附件读取/OCR、自动联网、agent池/fork或自动整轮恢复。命令完整报告与注入ModelReturn不再两用。旧v1已准入审计不迁移、不宣称从历史消失。详情观察不启动模型。

源码模块、双语README、安全文档、聊天集成说明、测试和本报告均已交付；包版本仍0.1.3本地开发版，npm安装说明仍指已发布0.1.2。报告加入package文件白名单以免README相对链接缺失，但本任务未发布任何包、未更改真实profile或要求重启。

### 尚未验证 / 不在本次授权内

1. 当前真实GUI安装后原生完整预览（含64KiB/换行/滚动）、窄宽与light/dark、连续两轮真人交互、取消/重开视觉结果。Client Inspect查询超时；源码和组件证据不替代真机。
2. 真实云模型质量、费用、服务商实际tokenizer；只用fake adapters，不用真实敏感聊天。
3. 长会话真实compaction压力、其他OS/CPU平台；本次隔离Host平台为macOS arm64。
4. 安装到真实profile、完整重启与npm发布均需用户另行同意；没有自动做这些动作。

### 最后一轮命令结果（23:08）

| 命令 | exit | 最终结果 |
|---|---|---|
| pnpm typecheck | 0 | 全树类型通过。 |
| pnpm test | 0 | 16 文件、446 tests 全通过；基线为8文件179项。 |
| pnpm docs:check | 0 | 已把聊天说明和本报告纳入相对链接/私有路径检查。 |
| pnpm build | 0 | JS 188.31 kB，含所有安全修复，与GO3测试代码一致。 |
| git diff --check | 0 | 无空白错误。 |
| 固定版本隔离 Host 两轮 GO3 | 0 / 0 | 旧 topic/legacy 与新 chat/activation 分别通过，不混淆为真实模型质量验收。 |

最终主验证 job `bash-924d8e0fddf340d5` 已收集，五个 FINAL exit 标志均为0。三个子 agent 均 inactive 并已交回结果；子 agent 所有测试/Host jobs 均已收集，临时 profile 已清理。进程只读核对未发现本任务临时 Host 残留。HEAD 仍为开工原值，未提交/切分支；原有未跟踪材料保留。
