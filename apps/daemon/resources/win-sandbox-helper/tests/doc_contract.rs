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

fn read_src(rel: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join(rel);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("读不到 {}：{e}", path.display()))
}

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

/// 评审 F5 #2（token.rs:217 enable_single_privilege / :284 调用点）：
/// ①AdjustTokenPrivileges 返回非零不代表权限已启用——须查
/// GetLastError()==ERROR_NOT_ALL_ASSIGNED；②该步失败经 `?` 上抛时
/// new_token 句柄泄漏；③`use AdjustTokenPrivileges` 被扔在文件中部。
#[test]
fn token_privilege_enable_checks_not_all_assigned_and_closes_handle() {
    let token = read_src("token.rs");
    assert!(
        token.contains("check_adjust_privileges("),
        "token.rs 的 AdjustTokenPrivileges 结果须经 check_adjust_privileges 判定（F5 #2 ①）"
    );
    assert!(
        token.contains("check_adjust_privileges(ok, GetLastError(), name)"),
        "enable_single_privilege 须把 ok + GetLastError() 原样交判定（F5 #2 ①）"
    );
    // ② 错误路径回收句柄：privilege 失败分支必须 CloseHandle 后再返回
    let tail = token
        .split("enable_single_privilege(new_token, \"SeChangeNotifyPrivilege\")")
        .nth(1)
        .expect("create_sandbox_token 须调用 enable_single_privilege");
    assert!(
        tail.contains("CloseHandle(new_token)"),
        "privilege 启用失败路径须 CloseHandle(new_token)（F5 #2 ② 句柄泄漏）"
    );
    // ③ use 声明归位文件头：不得出现在函数/常量定义之后（旧位在 enable_single_privilege 之后）
    let use_line = token
        .lines()
        .position(|l| l.trim() == "use windows_sys::Win32::Security::AdjustTokenPrivileges;")
        .expect("token.rs 须 use AdjustTokenPrivileges");
    let fn_line = token
        .lines()
        .position(|l| l.contains("unsafe fn enable_single_privilege"))
        .expect("token.rs 须有 enable_single_privilege");
    assert!(
        use_line < fn_line,
        "AdjustTokenPrivileges 的 use 须在文件头导入区（F5 #2 ③），实际行 {use_line} 晚于函数行 {fn_line}"
    );
}

/// 评审 F5 #2 的逻辑面单元测试在 src/privileges.rs 内（纯逻辑，非 Windows
/// host 可跑）；此处只钉 token.rs 的接线与句柄回收。
#[test]
fn privileges_module_is_the_single_source_of_the_check() {
    let privileges = read_src("privileges.rs");
    assert!(
        privileges.contains("ERROR_NOT_ALL_ASSIGNED"),
        "privileges.rs 须以 ERROR_NOT_ALL_ASSIGNED 为判定常量（F5 #2 ①）"
    );
    assert!(
        privileges.contains("pub(crate) fn check_adjust_privileges"),
        "privileges.rs 须导出 check_adjust_privileges（token.rs 单源消费）"
    );
}
