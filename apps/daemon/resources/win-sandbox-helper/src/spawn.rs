//! spawn.rs——受限 token 下 CreateProcessAsUser + stdio 继承 + 退出码透传。
//!
//! stdio 三件套：STARTF_USESTDHANDLES + GetStdHandle——helper 自身的
//! stdio（daemon 管道）直传被沙箱进程，输出流式回 daemon 不缓冲。


use anyhow::Result;
use anyhow::anyhow;
use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
use windows_sys::Win32::System::Threading::CreateProcessAsUserW;
use windows_sys::Win32::System::Threading::GetExitCodeProcess;
use windows_sys::Win32::System::Threading::INFINITE;
use windows_sys::Win32::System::Threading::PROCESS_INFORMATION;
use windows_sys::Win32::System::Threading::STARTUPINFOW;
use windows_sys::Win32::System::Threading::STARTF_USESTDHANDLES;
use windows_sys::Win32::System::Threading::WaitForSingleObject;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 以受限 token 起 command line（cwd 继承 helper 当前目录），等待结束返回退出码。
///
/// # Safety
/// h_token 须为 CreateRestrictedToken 产出的有效 primary token。
pub unsafe fn spawn_as_user_and_wait(h_token: HANDLE, command_line: &str) -> Result<i32> {
    let mut si: STARTUPINFOW = std::mem::zeroed();
    si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = get_std_handle(0xFFFF_FFF6); // STD_INPUT_HANDLE
    si.hStdOutput = get_std_handle(0xFFFF_FFF5); // STD_OUTPUT_HANDLE
    si.hStdError = get_std_handle(0xFFFF_FFF4); // STD_ERROR_HANDLE

    let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
    let mut cmdline = wide(command_line);
    let ok = CreateProcessAsUserW(
        h_token,
        std::ptr::null(), // 应用程序名从命令行解析
        cmdline.as_mut_ptr(),
        std::ptr::null(),
        std::ptr::null(),
        1, // bInheritHandles——stdio 直传
        0, // CREATE_NO_WINDOW 不设：继承 helper 的控制台语境
        std::ptr::null(),
        std::ptr::null(), // cwd 继承
        &si,
        &mut pi,
    );
    if ok == 0 {
        return Err(anyhow!("CreateProcessAsUserW failed: {}", GetLastError()));
    }

    let wait = WaitForSingleObject(pi.hProcess, INFINITE);
    let mut exit_code: u32 = 0;
    let got = GetExitCodeProcess(pi.hProcess, &mut exit_code);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    if wait != WAIT_OBJECT_0 {
        return Err(anyhow!("WaitForSingleObject failed: {wait}"));
    }
    if got == 0 {
        return Err(anyhow!("GetExitCodeProcess failed: {}", GetLastError()));
    }
    Ok(exit_code as i32)
}

unsafe fn get_std_handle(which: u32) -> HANDLE {
    windows_sys::Win32::System::Console::GetStdHandle(which)
}
