/**
 * domain/loop —— helix 自有 agent loop 核心域（helix-loop L0 批）。
 *
 * 零 pi import（AG-02 白名单 @helix/common 之外全禁——本域零包外 import）；
 * StreamFn 以结构兼容（duck-typed）契约声明（LoopTypes.LoopStreamFn），pi-ai
 * 真体在 adapters/driven/loop 装配注入。设计锚：docs/temp/helix-loop-design.md。
 */
export * from "./LoopTypes";
export * from "./LoopEvent";
export * from "./ToolRegistry";
export * from "./LoopCompaction";
export * from "./LoopEngine";
