```kg-node
id: TR-TEST-1
kind: rule
graph: tech
layer: convention
scope: domain
stack: shared
name: 测试运行器与四层测试分层
status: active
digest: 写任何测试、选测试层级、配 test 脚本时
derivedFrom:
  - AD-12
anchors:
  testedBy:
    - apps/daemon/test/unit/domain-agent.test.ts
    - apps/daemon/test/integration/
    - e2e/
relations:
  governs:
    - E-AgentRuntime
updatedIn: iter-20260815-6tss
```

## 规则
测试按运行器分轨：daemon 测试统一 bun test（unit/integration）；shell 单测 vitest；浏览器表现验证（fidelity/e2e）用 Playwright。四层组织、逐层收窄：unit——模块纯单测（domain 纯单测 framework-free：无 IO、无 pi、无 DB；含 infrastructure/adapter 模块单测如 config/paths/dev-token/mapper roundtrip）；integration——application+adapters 组装测试（真 SQLite 于 tmp 目录 + FakeAgentEngine 替身引擎）；fidelity——浏览器 mock mode 链路（F 层：fake WebSocket 剧本注入，生产连接状态机/退避/握手全真跑，无 daemon，装配纪律见 TR-TEST-5）；e2e——真 daemon 闭环（E 层：真 daemon + FakeLLM 剧本 + 真 WS + 真持久化；迭代六步总验收口径：起 daemon → 打开 → 多轮对话 → 工具渲染 → steer → 重启恢复）。层级选择：能 unit 不 integration，能 integration 不 fidelity，能 fidelity 不 e2e；e2e 只验总口径不验细节。

## 理由
分层与架构对齐：domain framework-free（AD-12）才能零依赖单测；六步口径即迭代总验收（清单〇），测试金字塔下宽上窄反馈最快。

## 适用范围
helix 全部测试代码的落层决策；package.json test 脚本与 CI 配置；评审测试是否落在恰当层级。

## 反例
为测 ChatService 轮次流转起真 WS server + 真 pi 引擎跑浏览器（一切皆 e2e）——慢且脆弱；正确做法是 unit 测 domain 轮次语义 + integration 用 FakeAgentEngine。

```kg-node
id: TR-TEST-2
kind: rule
graph: tech
layer: convention
scope: domain
stack: backend
name: 架构守护测试
status: active
digest: 改分层、加 port/profile、动状态写路径时
derivedFrom:
  - AD-12
  - AD-15
  - AD-16
  - AD-17
anchors:
  implementedBy:
    - apps/daemon/test/arch-guard/arch-guard.test.ts
    - apps/daemon/test/integration/session-projection.test.ts
relations:
  governs:
    - E-AgentRuntime
    - E-领域事件与单写队列
updatedIn: iter-20260820-qhv8
```

## 规则
AD 架构纪律以自动化守护测试固化，随代码同仓、破坏即红：①依赖方向扫描——domain 不 import application/adapters/infrastructure 与 pi 库；application 不 import adapters 与 pi 库；pi 库 import 仅出现在 adapters/driven/pi-engine、adapters/driven/tools（工具接线域）与 adapters/driven/subagent（SubAgent 子进程形态：launcher 透传 Model、child 复用 pi-engine 防腐墙、剧本引擎用 pi-ai 流原语；T2.2 新增，与 TR-AD-7 三根同口径）；②port 零实现——application/ports/ 文件静态检查不得含实现代码、工厂或实例化；③写路径唯一——领域事件落盘仅经单写队列，扫描绕过队列的 SQLite 直写；④扩展公式验证——用一个 TestProfile（模拟 M2 SubAgent 形态：不同钩子装配 + 单轮收敛策略）验证不改 AgentRuntime 源码即可装配并跑通。⑤守护面随迁——源码路径字符串型守护断言（直读源码断言型，如 session-projection 零聚合写守护）在守护对象拆分/迁移时必须随迁扩展至全部产物（守护面 = 目录全部产物），防「拆分绕过守护」——守护语义跟随被守护代码，而非跟随文件名（iter-20260820-qhv8 scheduler/ 三分实证：事件翻译逻辑拆出后守护圈同步扩展至三文件）。

## 理由
分层、port 零实现、单写路径、扩展公式是 AD-12/15/16/17 的机械可判纪律，人审会漏、测试不会；TestProfile 是「新增 profile 不改 runtime」公式的回归锚点。

## 适用范围
守护测试自身的维护；新增层/adapter/port 或动状态写路径后跑守护；CI 门禁。

## 反例
守护测试扫到 service import pi-agent-core，作者加一行 `// helix-disable-next-line` 豁注释绕过扫描，而不是改走 AgentEnginePort——守护红灯被人为涂绿。

```kg-node
id: TR-TEST-3
kind: rule
graph: tech
layer: common
scope: domain
stack: shared
name: Mock 契约等价原则
status: active
digest: 写 FakeAgentEngine、mock LLM 剧本、定保真度时
derivedFrom:
  - AD-12
  - AD-15
  - AD-16
anchors:
  implementedBy:
    - e2e/harness/protocol.ts
    - apps/daemon/test/mocks/FakeAgentEngine.ts
    - apps/shell/src/shared/api/fake-transport.ts#buildTraceReply
  testedBy:
    - apps/daemon/test/integration/test-profile.test.ts
    - apps/daemon/test/integration/tools-loop.test.ts
    - apps/shell/src/shared/api/fake-transport.test.ts
relations:
  governs:
    - E-AgentRuntime
updatedIn: iter-20260821-dg90
```

## 规则
mock 与真实实现保持契约等价：FakeAgentEngine 等 outbound port 替身必须与真实 driven adapter（adapters/driven/pi-engine）实现同一 AgentEnginePort 接口与事件语义（编译期同 interface 强制，port 变更则 mock 同步变更）；LLM 剧本 mock 只 mock 模型响应层，必须保留真实 runtime 钩子链、WS 协议、持久化链路（fidelity/e2e 层的存在意义即链路保真）。禁止为方便测试在 mock 里放宽契约（少发事件、改字段名、吞错误）。fake-transport 等契约 mock 的校验口径（过滤维、枚举、交叉校验、必发字段）对齐真实 daemon normalize 实现，不弱于、也不私设口径（iter-20260820-qhv8 TR-AD-26 ④律同源；iter-20260821-dg90 T3.1 起对齐方式升级为同引 protocol projection 单源）。fixture 注入规约（iter-20260821-dg90 AF-10 终验沉淀）：测试 fixture 优先走 port 真实路径注入（如 ClockPort 经组合根/工厂注入口）；白盒内部状态构造仅限全库 grep 实证的唯一访问点并需显式标注。

## 理由
契约漂移的 mock 会让测试全绿而线上炸；port 是唯一契约（AD-12/AD-17），mock 与真实实现同源于此；统一 runtime 与持久化链路正是 fidelity 层要保真的对象（AD-15/AD-16）。

## 适用范围
写或改任何测试替身（FakeAgentEngine、FakeRepository、LLM 剧本、fake-transport 契约 mock）；评审 mock 是否放宽契约。

## 反例
FakeAgentEngine 漏发 toolCallEnd 事件「因为测试用不到」——前端工具卡片在真引擎下有、测试替身下没有，工具调用渲染回归漏检。或 mock 的 trace.query 忽略 agentKind 过滤维只回显（mock 与 daemon normalize 口径分裂，iter-20260820-qhv8 F(2).7 登记在案反例）。或测试 fixture 直接构造内部状态绕过 port 注入面（session-registry-draft.test.ts 白盒 fixture，iter-20260821-dg90 AF-10——全库 grep 实证唯一访问点并显式标注才得以保留，非可复用写法）。

```kg-node
id: TR-TEST-4
kind: rule
graph: tech
layer: common
scope: domain
stack: backend
name: 测试隔离：--home 注入 tmp
status: active
digest: 测试要落盘、起 daemon、碰配置或 token 时
derivedFrom:
  - AD-13
  - AD-14
anchors:
  implementedBy:
    - e2e/harness/daemon-fixture.ts
    - apps/daemon/test/integration/sqlite-persistence.test.ts
  testedBy:
    - apps/daemon/test/integration/restore-restart.test.ts
relations:
  governs:
    - E-会话聚合
updatedIn: iter-20260815-6tss
```

## 规则
任何会落盘或起 daemon 的测试（integration/fidelity/e2e）一律以 `--home <tmp目录>` 注入独立 home：dev token、helix.db、logs 全部落 tmp，绝不触碰真实 ~/.helix；SQLite 用 tmp 目录内文件且保持 WAL 模式与生产一致；测试结束清理 tmp；禁止依赖环境变量传配置（测试配置进 tmp home 的 config.json）。

## 理由
AD-13/14 把全部自有状态收进 ~/.helix 并提供 --home 覆盖，测试隔离因此有单点开关；碰真实 home 会污染或删除开发者本地会话数据。

## 适用范围
integration/fidelity/e2e 测试的 setup/teardown；测试内任何路径拼接与配置读取。

## 反例
integration 测试忘了传 --home，直接把开发机 ~/.helix/helix.db 里的真实会话写花——本地数据被测试污染。

```kg-node
id: TR-TEST-5
kind: rule
graph: tech
layer: common
scope: domain
stack: shared
name: 表现验证双层装配纪律（F 层标准化注入点 + E 层真 daemon）
status: active
digest: 写表现验证 e2e、接 mock 注入点、装配真 daemon 测试时
derivedFrom:
  - F4.4
  - F-6
relations:
  governs:
    - E-会话聚合
updatedIn: iter-20260816-uzvg
```

## 规则
浏览器表现验证固定双层装配，后续迭代同构迁移（换剧本即扩展）：
F 层（mock mode）——经 SessionProvider 标准化注入点切换 fake transport（env VITE_HELIX_FAKE_TRANSPORT / URL 参数，F4.4）：产品代码内一等注入点，F 层纯浏览器跑、无 daemon，生产连接代码（连接状态机/退避/握手）全真跑；替换实现必须保留 WebSocket.OPEN/CONNECTING 等静态常量（browserTransportFactory.send 以 readyState 门控，缺失静默吞帧）；vite HMR 的 WebSocket 透传原生；帧构造类型直引 @helix/protocol（与真实协议零漂移）。
E 层（真 daemon）——bun 子进程 launcher（stdout 控制行协议 + SIGTERM 优雅停机）；DaemonProcess fixture 以 --home mkdtemp tmp 隔离（真实 ~/.helix 零触碰）、端口占用重试缓冲、全 argv 传参零 env 配置，并负责 SubAgent 子进程树与端口的彻底清理（与 TR-TEST-6 teardown 纪律联动；端口预检 fail-fast 在 globalSetup）；剧本 JSON 契约（reply/replyFromResult/tool + 流式分片可打入窗口）；globalSetup 端口预检 fail-fast + VITE_HELIX_PORT 烘焙 dist。真实 LLM 联调形态换 streamFnOverride 实现即可。

## 理由
F 层给前端投影与还原度最快反馈（无 daemon），E 层验证真 daemon 全链路闭环（持久化/恢复语义）；两层共享协议类型面与剧本形态，TR-TEST-3 契约等价贯穿。F4.4 裁决：SessionProvider env/URL 注入点使 mock 形态成为产品代码的可寻址能力而非 harness 侧 hack（F-6 首迭代建议的兑现），F 层剧本服务 CL-1/2/3 三类新 UI 验证。静态常量坑与隔离纪律是两轮实测提炼。

## 适用范围
e2e/harness 维护；新表现验证场景接入（M2 SubAgent 卡片/抽屉、thinking 块、usage popover 的 F 层剧本）；真实 LLM 联调；M2+ 任何浏览器级 E2E 扩展。

## 反例
fake transport 忘带 WebSocket.OPEN 静态常量——readyState 门控静默吞帧，剧本回放失灵且无报错；或 E 层 fixture 不传 --home——污染开发者真实 ~/.helix；或 F 层剧本绕过注入点直接在 spec 里猴补 window.WebSocket——注入点标准化失效，每个剧本自带挂点副本漂移。

```kg-node
id: TR-TEST-6
kind: rule
graph: tech
layer: common
scope: domain
stack: shared
name: e2e/integration teardown 纪律（零残留）
status: active
digest: 写 e2e harness 或 fixture、配 CI 连跑、排查测试残留时
derivedFrom:
  - F4.3
  - F4.5
  - CL-7（M4 环境治理，Q-5 全收）
anchors:
  implementedBy:
    - e2e/harness/daemon-fixture.ts
    - playwright.e2e.config.ts
    - e2e/harness/tmp-hygiene.ts
    - e2e/harness/e2e-global-setup.ts
    - e2e/harness/evidence.ts
  testedBy:
    - e2e/CL-4-teardown-residue.spec.ts
relations:
  dependsOn:
    - TR-TEST-4
    - TR-TEST-5
updatedIn: iter-20260821-dg90
```

## 规则
任何起进程/占端口/建 tmp 的测试（integration/fidelity/e2e）teardown 三件套彻底清理：tmp 目录（--home 注入的 mkdtemp 全删）、子进程（daemon 及其派生的 SubAgent 子进程树——SIGTERM 优雅停机 + 超时升级强杀，不留孤儿进程）、端口（结束释放验证）。
以「同一套件连跑两轮零残留」断言机械化守护：残留检测任一命中即红（tmp 未删/进程存活/端口占用）；CI 必须包含连跑两轮形态。fixture（daemon-fixture/mock-init）是清理责任的唯一归属——测试用例不得自带旁路清理逻辑。
外补条目（iter-20260818-mq5a CL-7/Q-5）：E 层 globalSetup 首步执行 TMPDIR 全前缀卫生预检（helix-* 前缀残留=0 才放行，非零 fail-fast 报清单，先于端口预检与构建）；残留断言面前缀面扩至 helix-* 全前缀（不限于单一迭代前缀）；bun test 侧自建沙箱 afterAll 统一回收。EVIDENCE_DIR 迭代感知三态契约（iter-20260820-qhv8 F(5).1）：env HELIX_EVIDENCE_ITER 优先 → git 分支 dev-<iterId> → 报错兜底（无静默兜底），工作区根向上查 docs/iterations 祖先穿透 .worktrees——e2e 证据自动落当前迭代目录，单点 e2e/harness/evidence.ts；TMPDIR 预检排除表（长驻应用前缀白名单）不弱化检出力。批末/终验约定（iter-20260821-dg90 OI-4 终验沉淀）：跑 e2e 全量批次前先清 TMPDIR helix-* 残留——daemon 测试产生的 helix-* 残留会触发 globalSetup 卫生预检拦截（fail-fast 按设计生效），预清后复跑即绿；本迭代两批次兑现（T0.1 基线取得与 TS1 最终树复跑）。

## 理由
TR-TEST-4 只裁隔离注入（--home tmp），未覆盖进程/端口残留；F4.3 实锤 e2e teardown 残留（首迭代遗留项）；残留会让下一轮测试假红/假绿并污染开发机，连跑两轮断言把「零残留」从纪律变为机械判据。F4.5 裁决将本纪律落为 testing-rules.md 新 TR。M4 CL-7（Q-5）：连跑两轮断言只证本轮零残留，防不了外部残留污染断言面；跑前预检把「进入断言面前先证清白」机制化为 fail-fast，红/绿双路径已在 iter-20260818-mq5a 实证（首跑拦截 896 条开发阶段中断遗留）。

## 适用范围
e2e/harness（daemon-fixture/mock-init/tmp-hygiene）维护；新 fixture 接入；CI 配置；integration 测试 teardown；M2+ 任何新增子进程/端口资源的测试（SubAgent 子进程 fixture 同纳入）；M4+ 新临时目录前缀纳入残留预检评审面；bun test 侧自建沙箱回收模式。

## 反例
daemon-fixture 只 kill 直接子进程，SubAgent 子进程成孤儿继续占端口/预算——第二轮连跑端口冲突假红；或测试用例末尾自己 process.kill 补刀——清理责任旁路出 fixture，新用例接入时漏复制即残留复发。预检只进 spec 不进 globalSetup（spec 内预检已晚于构建，拦不住本轮污染）；afterAll 回收旁路散点化（各测试自记自删，漏一处即破坏断言面）。

```kg-node
id: TR-TEST-7
kind: rule
graph: tech
layer: common
scope: domain
stack: shared
name: 循环依赖解环验证纪律（type 回边 + 阳性对照）
status: active
digest: 解循环依赖、配 madge 环检测、宣称消环时
derivedFrom:
  - iter-20260820-qhv8 T3.2（F-8 解环实证）
  - F-11（保留作常设反向对照）
anchors:
  testedBy:
    - bunx madge --circular --extensions ts .（ad-hoc 命令口径，T3.2 钉契约；常设挂接评估见优化池 N2）
relations:
  governs:
    - E-领域事件与单写队列
updatedIn: iter-20260820-qhv8
```

## 规则
解环验证双纪律：①type 回边统计——循环依赖的回边常为 import type（编译期擦除、运行时不构成环，但静态面是环）；环检测工具必须统计 type import（madge 需 --extensions ts 且确认其含 type 边，跑全仓口径），否则「消环」声明对 type-only 环失明。②阳性对照先行——宣称消环前，先以已知环复现确认工具灵敏度（红灯基线），再验证目标环消失——未经阳性对照的「零环」输出不可信。F-11 两个域内 type-only 环保留为常设反向对照（灵敏度基准）。

## 理由
T3.2 解 F-8 环实证：madge 首跑漏 type 边险些误判消环；以三环复现（含两个 type-only 环）确认灵敏度后，「F-8 消失 / F-11 仍在」的结论才成立。解环声明 = 工具灵敏度 × 目标环消失的合取，缺一即假绿。

## 适用范围
任何循环依赖解环任务的验证设计；madge/环检测工具接入 CI 或 audit:assert（优化池 N2）时的口径评审；新依赖边引入时的环风险检查。

## 反例
用只统计值导入的工具跑出「零环」即宣称解环成功（type-only 环全程不可见——F-11 两环恰为此形态）；或工具配置变更后不重跑阳性对照直接采信零环输出（配置漂移使灵敏度静默下降）。
