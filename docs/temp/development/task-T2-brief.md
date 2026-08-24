# T2 Brief: protocol 模式注册表 + 帧字段 additive

## 背景定位

helix 协议包 `packages/protocol`（daemon/前端共享契约）。本期为「会话模式」P1 打协议地基：session 一对一绑定模式，草稿态可切、建会话定格锁定。本期注册表只有 default 一条，但 schema 必须能表达后续两模式不返工：phase（staged：design/build/verify 三阶段 agent）、workflow（orchestrated：编排者 agent）。

## 任务目标

1. protocol 包内新增模式注册表常量与类型（位置自选，建议 events/commands 同级新文件 `modes.ts` 或类似）：

```ts
interface ModeSpec {
  id: string;                    // "default" | ...
  kind: "single" | "staged" | "orchestrated";
  profileKind: string;           // single/orchestrated 的绑定
  stages?: readonly StageSpec[]; // staged 模式预留
}
interface StageSpec { id: string; profileKind: string; welcomeKey?: string }
MODES: readonly ModeSpec[] = [{ id: "default", kind: "single", profileKind: "main-session" }]
```

加类型级保障（如 mode id 联合类型）+ 单测（MODES 完整性、唯一性）。
2. `chat.send` payload 增可选 `mode?: string`（draft 建会话链透传；缺省 = "default"，旧客户端兼容）。找到 payload 定义位置（`packages/protocol/src/commands/` 下 chat 相关）additive 扩展 + 校验规则若有 zod/手写校验需同步。
3. `session.snapshot` 与 `connection.welcome` payload 增可选 `mode?: string`（additive；快照回带已定格的会话模式；welcome 的 mode 表 daemon 当前模式面——若 welcome 场景不合适，报告里说明取舍）。协议版本号处理遵循包内既有 additive 惯例。
4. 相关单测更新。

## 边界（不要做）

- 不动 daemon/shell 业务代码（T3/T4 消费）。
- 不设计阶段切换/交接/workflow 编排协议（P2/P3）。
- 不加 `mode.set` 命令（设计决策：无第二条写路径，锁定 = 结构不可能）。

## 全局约束

- protocol 包是纯契约（无 IO/无 React）；DTO additive 兼容旧版本。
- 测试先行（TDD）。

## 验收标准（闭环逐条应答）

1. ModeSpec/StageSpec/MODES 类型+常量+单测就位，TS 编译零错。
2. chat.send payload.mode 可选字段 + 校验/类型同步，单测覆盖（携带/缺省两形态）。
3. 快照与 welcome 帧 additive mode 字段 + 单测。
4. packages/protocol 测试全绿。

## 报告要求

submit_result 含 acceptance 逐条应答 + findings（文件清单、welcome 是否带 mode 的取舍说明、协议版本处理方式）。
