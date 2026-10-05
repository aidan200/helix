/**
 * bun test preload：宿主 HELIX_* 注入剥离（CAND-581 结构性解）。
 *
 * 机制：daemon 给 SubAgent 会话进程注入全套 HELIX_* 环境变量；在会话内跑
 * daemon 测试时，宿主注入经 ①被测代码进程内直读 process.env、②测试 spawn
 * 被测子进程经 {...process.env} 展开两个污染面泄漏进断言「键缺席/默认值」
 * 的用例，造成与代码无关的假红（TR-62/TR-186）。本 preload 在测试进程最早期
 * （所有测试文件 import 之前）delete 全部 HELIX_ 前缀键——两个污染面同时免疫。
 *
 * 时序契约：preload 先于一切测试文件执行；测试体内自设的
 * `process.env.HELIX_X = ...` 发生在 preload 之后，不受影响。
 *
 * 守护面：env-preload-guard.test.ts 断言探针键（证明本文件在位）+ env 零
 * HELIX_ 残留（证明剥离生效）——本文件被删/失效时守护测试红。
 */
for (const key of Object.keys(process.env)) {
  if (key.startsWith("HELIX_")) delete process.env[key];
}
// 非 HELIX_ 前缀探针键：守护测试断言其存在，防 preload 被删而无感。
process.env.__HELIX_TEST_ENV_PRELOADED__ = "1";
