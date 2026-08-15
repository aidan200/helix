# adapters/ — 适配层

driving（驱动侧：cli、ws-server——外部输入翻译成 port 调用）与 driven（被驱动侧：
pi-engine、sqlite-session、tools、static-serve——实现 outbound port）物理分列，
互不相见，由组合根（infrastructure/container.ts）接线（AD-12/AD-17）。
