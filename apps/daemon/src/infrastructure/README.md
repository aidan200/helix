# infrastructure/ — 组合根（§3.6）

DI 装配（container.ts + assembly/ 四命名装配函数族，T2.2 无容器版重构
architecture §4.2：buildPersistence/buildModelStack/buildSessionStack/
wireEventFanout + resource-events 装配级事件总线）、配置加载（config.ts）、
路径解析单点（paths.ts，AD-14）、日志（logging.ts）、进程生命周期
（lifecycle.ts）。infrastructure 依赖所有层，没有任何层依赖它
（AG-02④：组合根锚面 = container.ts + assembly/**）。
