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
    - apps/shell/src/tests/ag-scans.test.ts
relations:
  governs:
    - E-AgentRuntime
    - E-领域事件与单写队列
updatedIn: iter-20260815-6tss
```

## 规则
AD 架构纪律以自动化守护测试固化，随代码同仓、破坏即红：①依赖方向扫描——domain 不 import application/adapters/infrastructure 与 pi 库；application 不 import adapters 与 pi 库；pi 库 import 仅出现在 adapters/driven/pi-engine 与 adapters/driven/tools（工具接线域，与 TR-AD-7 同口径）；②port 零实现——application/ports/ 文件静态检查不得含实现代码、工厂或实例化；③写路径唯一——领域事件落盘仅经单写队列，扫描绕过队列的 SQLite 直写；④扩展公式验证——用一个 TestProfile（模拟 M2 SubAgent 形态：不同钩子装配 + 单轮收敛策略）验证不改 AgentRuntime 源码即可装配并跑通。

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
  testedBy:
    - apps/daemon/test/integration/test-profile.test.ts
    - apps/daemon/test/integration/tools-loop.test.ts
relations:
  governs:
    - E-AgentRuntime
updatedIn: iter-20260815-6tss
```

## 规则
mock 与真实实现保持契约等价：FakeAgentEngine 等 outbound port 替身必须与真实 driven adapter（adapters/driven/pi-engine）实现同一 AgentEnginePort 接口与事件语义（编译期同 interface 强制，port 变更则 mock 同步变更）；LLM 剧本 mock 只 mock 模型响应层，必须保留真实 runtime 钩子链、WS 协议、持久化链路（fidelity/e2e 层的存在意义即链路保真）。禁止为方便测试在 mock 里放宽契约（少发事件、改字段名、吞错误）。

## 理由
契约漂移的 mock 会让测试全绿而线上炸；port 是唯一契约（AD-12/AD-17），mock 与真实实现同源于此；统一 runtime 与持久化链路正是 fidelity 层要保真的对象（AD-15/AD-16）。

## 适用范围
写或改任何测试替身（FakeAgentEngine、FakeRepository、LLM 剧本）；评审 mock 是否放宽契约。

## 反例
FakeAgentEngine 漏发 toolCallEnd 事件「因为测试用不到」——前端工具卡片在真引擎下有、测试替身下没有，工具调用渲染回归漏检。

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
name: 表现验证双层装配纪律（F 层 mock 挂点 + E 层真 daemon）
status: active
digest: 写表现验证 e2e、mock WebSocket 挂点、装配真 daemon 测试时
derivedFrom:
  - AD-12
  - AD-13
  - AD-14
anchors:
  implementedBy:
    - e2e/harness/mock-init.ts
    - e2e/harness/protocol.ts
    - e2e/harness/daemon-fixture.ts
    - e2e/harness/daemon-script.ts
    - apps/daemon/test/e2e/launcher.ts
    - playwright.e2e.config.ts
  testedBy:
    - e2e/CL-7-fidelity-layout-theme.spec.ts
    - e2e/CL-7-fidelity-toolcard.spec.ts
    - e2e/CL-7-e2e-chat.spec.ts
    - e2e/CL-7-CL-8-restart-recovery.spec.ts
relations:
  governs:
    - E-会话聚合
updatedIn: iter-20260815-6tss
```

## 规则
浏览器表现验证固定双层装配，后续迭代同构迁移（换剧本即扩展）：F 层（mock mode）——page.addInitScript 替换 window.WebSocket 实现剧本回放注入（连接状态机/退避/握手生产代码全真跑）；替换实现必须保留 WebSocket.OPEN/CONNECTING 等静态常量（browserTransportFactory.send 以 readyState 门控，缺失静默吞帧）；vite HMR 的 WebSocket 透传原生；帧构造类型直引 @helix/protocol（与真实协议零漂移）。E 层（真 daemon）——bun 子进程 launcher（stdout 控制行协议 + SIGTERM 优雅停机）；DaemonProcess fixture 以 --home mkdtemp tmp 隔离（真实 ~/.helix 零触碰）、端口预检 fail-fast、全 argv 传参零 env 配置；剧本 JSON 契约（reply/replyFromResult/tool + 流式分片可打入窗口）；globalSetup 端口预检 + VITE_HELIX_PORT 烘焙 dist。真实 LLM 联调形态换 streamFnOverride 实现即可。

## 理由
F 层给前端投影与还原度最快反馈（无 daemon），E 层验证真 daemon 全链路闭环（持久化/恢复语义）；两层共享协议类型面与剧本形态，TR-TEST-3 契约等价贯穿；静态常量坑与隔离纪律是两轮实测提炼。

## 适用范围
e2e/harness 维护；新表现验证场景接入；真实 LLM 联调；M2+ 任何浏览器级 E2E 扩展。

## 反例
fake WebSocket 忘带 WebSocket.OPEN 静态常量——readyState 门控静默吞帧，剧本回放失灵且无报错；或 E 层 fixture 不传 --home——污染开发者真实 ~/.helix。
