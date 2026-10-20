//! 横切评审 F5（B29）——win-sandbox-helper 注释/死计算口径契约断言。
//!
//! acl/token/spawn 三模块被 `#[cfg(target_os = "windows")]` 门化（非 Windows
//! host 不参与编译，行为断言只能在 CI windows runner 跑），因此「注释承诺
//! 与代码现实对齐」类条目无法用行为测试表达，改用源码定式断言钉住——
//! 仓库先例：apps/daemon/test/unit/adapter-contract-notes.test.ts（同型
//! 「注释承诺超出实现」缺陷的源码定式断言）。
//!
//! 本文件在非 Windows host 上照常编译运行（include_str! 只读源码文本），
//! 是 macOS 本地唯一的红→绿证据面。

/// 评审 F5 #1（token.rs:244 create_sandbox_token）：
/// 旧实现算出 user SID 后只用 `let _ = (&user, ...)` 吞掉，dacl_sids 实为
/// logon/everyone/cap——注释却称「default DACL 与 user/logon/everyone 仍需其
/// SID 本体」。定案：删死计算（user_sid_bytes 无其他消费点），注释改与
/// 代码一致（DACL 组成不含 user）。
#[test]
fn token_default_dacl_composition_excludes_user_sid() {
    let src = include_str!("../src/token.rs");
    assert!(
        !src.contains("user_sid_bytes"),
        "token.rs 不得保留无消费点的 user SID 计算（死计算，评审 F5 #1）"
    );
    assert!(
        !src.contains("let _ = (&user"),
        "token.rs 不得再用 let _ 吞掉未参与 DACL 的 SID（评审 F5 #1）"
    );
    assert!(
        src.contains("default DACL = logon + everyone + cap"),
        "token.rs 注释须明记 default DACL 组成 = logon + everyone + cap（无 user）"
    );
}
