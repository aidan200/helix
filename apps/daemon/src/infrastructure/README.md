# infrastructure/ — 组合根（§3.6）

DI 装配（container.ts）、配置加载（config.ts）、路径解析单点（paths.ts，AD-14）、
日志（logging.ts）、进程生命周期（lifecycle.ts）后续任务落位；
本任务先就位 paths.ts + config.ts。infrastructure 依赖所有层，没有任何层依赖它。
