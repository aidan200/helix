# ADR：daemon 组合根演进（无容器版 / 四命名装配 / 事件化刷新 / 显式模式）

> 来源：`apps/daemon/src/infrastructure/container.ts` 文件头考古迁档 + `infrastructure/assembly/` 各文件头。
> 活规则锚：AG-02④（组合根豁免面）、TR-AD-11/16（调度预算全局一份）、TR-AD-25（守护式拆分）。

## 背景

daemon 采用「无容器组合根」：`createDaemon` 是整个进程唯一允许 new 具体实现的地方（AG-02④ 豁免面 = container.ts + infrastructure/assembly/**）。依赖图在此闭合：driven adapter → service → driving adapter 接线，四层内部只见接口。

## 取舍

- **组合根工厂化（AD-4）**：会话相关件（Session 聚合 + ChatService 族 + 会话投影 + 会话绑定引擎/工具）经 SessionRegistry 按需创建/卸载（buildSessionStack 的 buildRuntime/engineFor 工厂是唯一 new 面）；会话无关全局件（调度器/事件总线/存储/WS 服务器/静态服务）保持单例——调度预算 daemon 全局一份不随会话数分裂（TR-AD-11/16）。
- **不引入 DI 容器**：typed 回填面（构造早期声明、initialize 前闭合）取代运行期字符串图——编译期类型约束、可 grep；环依赖（scheduler↔registry）四面统一走回填闭包，不靠运行期服务定位器。
- **fan-out 带名注册表**：六目标（cli-stdout/cli-current-session-feedback/ws-event-stream/event-row-persistence/session-projection/directory-runstate-bridge）显式 push 全序——注册表序即语义唯一权威，先建稳定引用再挂 targets 读面。
- **资源事件总线不进 WS/不落盘**：resources.changed 只在组合根内刷新装配快照（refreshAssembly），是装配级事件不是领域事件。

## 演进史

1. **初版单体组合根**：container.ts 内联全部装配（~750 行），TDZ/晚绑 let 蔓延——「晚绑」词面成为安全声明的遮羞布。
2. **机械拆分（TR-AD-25④ 守护式）**：四命名装配函数落 `infrastructure/assembly/`（buildPersistence 持久化件 / buildModelStack 模型目录件 / buildSessionStack 会话栈+晚绑回填闭包 completeLateBinding / wireEventFanout 六目标全序）。仅机械代换 options.X→deps 切片字段，行为零变化。
3. **事件化刷新**：ResourceService deps 的 onApplied 回调 → publishResourceChanged 事件（签名 void|Promise<void 保持 await 收口链行为等价）；新增零依赖资源事件总线，容器订阅 handler 触发 refreshAssembly，「定义先于订阅注册」。
4. **晚绑收口 typed 化**：AssemblyBackfill{currentModelOf/computeSpawnAnchor/spawnModelSource} 构造早期声明、initialize 前闭合；bindSpawnModelSource 调用点式晚绑方法删除。
5. **显式模式分离**：生产 DaemonOptions 瘦身为 {home,port,cliInput,cliOutput} 四字段；11 个测试注入口（engine/skipLock/skipConfig/staticDir/toolCwd/builtinSkillsDir/subagentRunner/browser/sessionTailSize/sessionIdle*）全部摘除生产面，测试形态收进 test/helpers/createTestDaemon.ts（TestDaemonOptions）；共享装配核心 assembleDaemon 以 engineMode 判别字段显式声明引擎装配形态（production 真体 / override 工厂注入），「engine === undefined 即生产」类隐式分支与 skipConfig/skipLock 词面在组合根锚面零残留——skip 语义溶解为工厂内部决断（跳锁 = undefined lock；跳配置读面 = 硬编码缺省 config + 空 legacy）。
6. **锚扫描基元单源化（投影收敛）**：lastMainAnchorId 等锚计算迁 @helix/protocol projection，组合根改引协议导出。
