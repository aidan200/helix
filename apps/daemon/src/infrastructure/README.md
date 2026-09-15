# infrastructure/ — 组合根（§3.6）

DI 装配（container.ts + assembly/ 命名装配函数族切片，T2.2 无容器版重构
architecture §4.2：typed 回返面 + 显式命名函数，无 DI 容器；函数全集随
切片演进，单源见知识图谱节点 TR-78，文件以 assembly/ 目录为准）、
配置加载（config.ts）、
路径解析单点（paths.ts，AD-14）、日志（logging.ts）、进程生命周期
（lifecycle.ts）。infrastructure 依赖所有层，没有任何层依赖它
（AG-02④：组合根锚面 = container.ts + assembly/**）。
