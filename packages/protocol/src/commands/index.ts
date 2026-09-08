/**
 * 命令目录（C→S，契约 §4 + 契约 B §1 / 契约 C §1；目录文档见同包 PROTOCOL.md）。
 *
 * 命令全集以 COMMAND_TYPES 常量为准——头注释不记硬计数（易腐，曾与实际
 * 严重漂移），计数由机械断言守护（PROTOCOL.md §17.3 断言③：文档计数声明 ==
 * 常量目录长度；catalog.test.ts：COMMAND_TYPES ↔ CommandEnvelope 双向一致）。
 * 批次演进史见 PROTOCOL-CHANGELOG.md。
 *
 * `CommandEnvelope` 为判别式联合，daemon 侧 switch(cmd.type)
 * 分发。会话作用域命令的信封 sessionId 必填（AD-4 路由位，类型层可选、
 * 客户端纪律保证）；全局命令（session.list / model.set_default /
 * model.get_default / model.catalog* / auth.*）省略。未知 type / payload
 * 不符的错误回执见 §7（command.unknown / command.invalid_payload；
 * v0.2 已登记未实现命令 → command.unimplemented，T2.x 前占位回执）。
 *
 * 域文件拆分（体量治理）：session（会话域）/ model-config（全局配置域）/
 * resource（资源与观测域）/ kg（图谱域）/ task（任务域）/ mcp（MCP 接入域）/
 * catalog（信封联合 + 命令目录常量）——桶导出面不变（index.ts 顶层
 * `export * from "./commands"` 与目录内 `from "../commands"` 均解析到本文件）。
 */
export * from "./session";
export * from "./model-config";
export * from "./resource";
export * from "./kg";
export * from "./task";
export * from "./mcp";
export * from "./catalog";
