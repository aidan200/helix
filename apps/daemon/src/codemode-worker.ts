/**
 * codemode worker 入口（pi-codemode 接入批）——desktop 编译形态专用。
 *
 * bun build --compile 把本文件作为**额外 entrypoint** 嵌入（compile-daemon.ts），
 * 运行时 CodemodeTool 在编译形态下以相对字符串指定符
 * "./apps/daemon/src/codemode-worker.ts"（resolveCodemodeWorkerUrl）拉起 worker
 * ——pi-codemode 默认 worker 文件不在磁盘上，这是 README 契约的 Bun 编译
 * 可执行体方案（pi 官方 Bun binary 同款）。
 *
 * dev 形态（源码直跑）不 import 本文件——CodemodeSandbox 用包自带 worker。
 */
import "@earendil-works/pi-codemode/worker";
