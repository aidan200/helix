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
updatedIn: iter-20260815-6tss
```

## 规则
测试统一用 Bun test 运行器，按四层组织并逐层收窄：unit——domain 纯单测（framework-free：无 IO、无 pi、无 DB）；integration——application+adapters 组装测试（真 SQLite 于 tmp 目录 + FakeAgentEngine 替身引擎）；fidelity——Playwright mock mode 浏览器链路（mock LLM 剧本，保留真 runtime/WS/持久化链路）；e2e——迭代六步总验收口径（bun dev 起 daemon → 浏览器打开 → 多轮对话 → 工具调用渲染 → steer 打断 → 重启 daemon 后会话恢复）。层级选择规则：能 unit 不 integration，能 integration 不 fidelity；e2e 只验总口径不验细节。

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
updatedIn: iter-20260815-6tss
```

## 规则
AD 架构纪律以自动化守护测试固化，随代码同仓、破坏即红：①依赖方向扫描——domain 不 import application/adapters/infrastructure 与 pi 库；application 不 import adapters 与 pi 库；pi 库 import 仅出现在 adapters/driven/pi-engine；②port 零实现——application/ports/ 文件静态检查不得含实现代码、工厂或实例化；③写路径唯一——领域事件落盘仅经单写队列，扫描绕过队列的 SQLite 直写；④扩展公式验证——用一个 TestProfile（模拟 M2 SubAgent 形态：不同钩子装配 + 单轮收敛策略）验证不改 AgentRuntime 源码即可装配并跑通。

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
updatedIn: iter-20260815-6tss
```

## 规则
mock 与真实实现保持契约等价：FakeAgentEngine 等 outbound port 替身必须与真实 driven adapter（adapters/driven/pi-engine）实现同一 AgentEnginePort 接口与事件语义（编译期同 interface 强制，port 变更则 mock 同步变更）；LLM 剧本 mock 只 mock 模型响应层，必须保留真实 runtime 钩子链、WS 协议、持久化链路（fidelity 层的存在意义即链路保真）。禁止为方便测试在 mock 里放宽契约（少发事件、改字段名、吞错误）。

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
