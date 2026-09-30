/**
 * domain/loop —— helix 自有 agent loop 通用子域（helix-loop L0 批；
 * Phase 0a 起四层洋葱：contracts（L0 契约）→ kernel（L1 内核）→
 * policy（L2 策略）→ runtime（L3 运行时，Phase 2 落位）——依赖单向
 * 向内，设计锚 docs/temp/helix-loop-foundation-design.md §2）。
 *
 * 零 pi import（AG-02 白名单 @helix/common 之外全禁——本域零包外 import）；
 * StreamFn 以结构兼容（duck-typed）契约声明（contracts/stream.LoopStreamFn），
 * pi-ai 真体在 adapters/driven/loop 装配注入。本 barrel 为消费者兼容门面
 * （全符号集与拆分前等价——消费者 import 面零漂移）。
 */
export * from "./contracts";
export * from "./kernel";
export * from "./policy";
export * from "./LoopEngine";
