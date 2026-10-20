//! privileges.rs——AdjustTokenPrivileges 的结果判定（纯逻辑，非 Windows 宿主可单测）。
//!
//! 为什么单独成模块：Win32 语义陷阱——AdjustTokenPrivileges 返回 TRUE 只代表
//! 「调用被接受」，**不代表权限已启用**；须再查 GetLastError() 是否为
//! ERROR_NOT_ALL_ASSIGNED（调用 token 未持该权限/被 LUA 剥离时的静默半成功）。
//! 旧实现只看返回值，权限没拿到却报成功（评审 F5 #2 ①，codex 同款检查缺失）。
//!
//! 判定与系统调用分离：本模块不碰 win32（无 cfg 门），因此可在非 Windows 宿主
//! 上跑单测——token.rs（`#[cfg(target_os = "windows")]` 门化，本地不参与编译）
//! 只负责取 ok/last_error 两个数并交本模块判定。

use anyhow::Result;
use anyhow::anyhow;

/// Win32 ERROR_NOT_ALL_ASSIGNED（windows-sys 同名常量；此处字面钉值避免
/// 纯逻辑模块对 win32 绑定面的编译期依赖）。
pub(crate) const ERROR_NOT_ALL_ASSIGNED: u32 = 1300;

/// 判定一次 AdjustTokenPrivileges 的返回值。
///
/// - `ok == 0`：调用失败，错误码来自 `last_error`；
/// - `ok != 0` 且 `last_error == ERROR_NOT_ALL_ASSIGNED`：调用被接受但权限未授
///   （原状态未变），按失败上抛——refusing-to-run-unsandboxed 纪律不降级；
/// - `ok != 0` 且其他：权限已启用（getLastError 未被设置/仍为首调前的 0）。
pub(crate) fn check_adjust_privileges(ok: i32, last_error: u32, name: &str) -> Result<()> {
    if ok == 0 {
        return Err(anyhow!("AdjustTokenPrivileges({name}) failed: {last_error}"));
    }
    if last_error == ERROR_NOT_ALL_ASSIGNED {
        return Err(anyhow!(
            "AdjustTokenPrivileges({name}) 未获授（ERROR_NOT_ALL_ASSIGNED {last_error}）——\
             权限未启用，不降级未沙箱执行"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NAME: &str = "SeChangeNotifyPrivilege";

    #[test]
    fn ok_and_no_error_is_success() {
        assert!(check_adjust_privileges(1, 0, NAME).is_ok());
    }

    #[test]
    fn call_failure_surfaces_system_error() {
        let err = check_adjust_privileges(0, 5, NAME).unwrap_err().to_string();
        assert!(err.contains("failed: 5"), "错误文案须带系统错误码：{err}");
    }

    #[test]
    fn accepted_but_not_assigned_is_failure() {
        // 关键回归：返回值非零但 GetLastError()==ERROR_NOT_ALL_ASSIGNED 必须判失败
        let err = check_adjust_privileges(1, ERROR_NOT_ALL_ASSIGNED, NAME)
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("ERROR_NOT_ALL_ASSIGNED"),
            "半成功态文案须点名 ERROR_NOT_ALL_ASSIGNED：{err}"
        );
    }
}
