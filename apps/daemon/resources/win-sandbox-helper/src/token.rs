//! token.rs——受限 token 构造（helix 裁剪版，参照 codex windows-sandbox-rs token.rs）。
//!
//! 机制：CreateRestrictedToken(DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED)
//! + restricting SIDs = [随机 capability SID, user SID, logon SID, everyone SID]
//! + default DACL（新建对象可建管道/IPC 不炸）+ SeChangeNotifyPrivilege（遍历目录）。
//!
//! 写访问检查语义（WRITE_RESTRICTED）：grant 当且仅当**全部** restricting SIDs
//! 都被对象 ACL grant 写。随机 capability SID 在普通文件 ACL 里不存在 grant
//! → 全盘写拒；acl.rs 对 writableRoots 预写 grant(cap SID) ACE → 范围内放行。
//! 残留 ACE 指向死 SID 无害（SID 随机不复用）。

use std::ffi::c_void;

use anyhow::Result;
use anyhow::anyhow;
use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::Foundation::ERROR_SUCCESS;
use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::Foundation::HLOCAL;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Foundation::LUID;
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Authorization::EXPLICIT_ACCESS_W;
use windows_sys::Win32::Security::Authorization::GRANT_ACCESS;
use windows_sys::Win32::Security::Authorization::SetEntriesInAclW;
use windows_sys::Win32::Security::Authorization::TRUSTEE_IS_SID;
use windows_sys::Win32::Security::Authorization::TRUSTEE_IS_UNKNOWN;
use windows_sys::Win32::Security::Authorization::TRUSTEE_W;
use windows_sys::Win32::Security::CopySid;
use windows_sys::Win32::Security::CreateRestrictedToken;
use windows_sys::Win32::Security::CreateWellKnownSid;
use windows_sys::Win32::Security::GetLengthSid;
use windows_sys::Win32::Security::GetTokenInformation;
use windows_sys::Win32::Security::LookupPrivilegeValueW;
use windows_sys::Win32::Security::SetTokenInformation;
use windows_sys::Win32::Security::ACL;
use windows_sys::Win32::Security::SID_AND_ATTRIBUTES;
use windows_sys::Win32::Security::TOKEN_DUPLICATE;
use windows_sys::Win32::Security::TOKEN_QUERY;
use windows_sys::Win32::Security::TOKEN_USER;
use windows_sys::Win32::Security::TokenDefaultDacl;
use windows_sys::Win32::Security::TokenGroups;
use windows_sys::Win32::Security::TokenUser;

const DISABLE_MAX_PRIVILEGE: u32 = 0x01;
const LUA_TOKEN: u32 = 0x04;
const WRITE_RESTRICTED: u32 = 0x08;
const GENERIC_ALL: u32 = 0x1000_0000;
const WIN_WORLD_SID: i32 = 1;
const SE_GROUP_LOGON_ID: u32 = 0xC000_0000;

/// SetTokenInformation(TokenDefaultDacl) 载荷（windows-sys 未导出的内部结构形态）。
#[repr(C)]
struct TokenDefaultDaclInfo {
    default_dacl: *mut ACL,
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 宽供给权限（permissive default DACL：受限进程可建管道/IPC 对象——PowerShell 管道等不炸）。
unsafe fn set_default_dacl(h_token: HANDLE, sids: &[*mut c_void]) -> Result<()> {
    if sids.is_empty() {
        return Ok(());
    }
    let entries: Vec<EXPLICIT_ACCESS_W> = sids
        .iter()
        .map(|sid| EXPLICIT_ACCESS_W {
            grfAccessPermissions: GENERIC_ALL,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: 0,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: std::ptr::null_mut(),
                MultipleTrusteeOperation: 0,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: *sid as *mut u16,
            },
        })
        .collect();
    let mut p_new_dacl: *mut ACL = std::ptr::null_mut();
    let res = SetEntriesInAclW(
        entries.len() as u32,
        entries.as_ptr(),
        std::ptr::null_mut(),
        &mut p_new_dacl,
    );
    if res != ERROR_SUCCESS {
        return Err(anyhow!("SetEntriesInAclW failed: {res}"));
    }
    let mut info = TokenDefaultDaclInfo { default_dacl: p_new_dacl };
    let ok = SetTokenInformation(
        h_token,
        TokenDefaultDacl,
        &mut info as *mut _ as *mut c_void,
        std::mem::size_of::<TokenDefaultDaclInfo>() as u32,
    );
    let err = if ok == 0 { Some(GetLastError()) } else { None };
    if !p_new_dacl.is_null() {
        LocalFree(p_new_dacl as HLOCAL);
    }
    match err {
        None => Ok(()),
        Some(e) => Err(anyhow!("SetTokenInformation(TokenDefaultDacl) failed: {e}")),
    }
}

/// Everyone SID（world）。
pub unsafe fn world_sid() -> Result<Vec<u8>> {
    let mut size: u32 = 0;
    CreateWellKnownSid(WIN_WORLD_SID, std::ptr::null_mut(), std::ptr::null_mut(), &mut size);
    let mut buf: Vec<u8> = vec![0u8; size as usize];
    let ok = CreateWellKnownSid(
        WIN_WORLD_SID,
        std::ptr::null_mut(),
        buf.as_mut_ptr() as *mut c_void,
        &mut size,
    );
    if ok == 0 {
        return Err(anyhow!("CreateWellKnownSid(world) failed: {}", GetLastError()));
    }
    buf.truncate(size as usize);
    Ok(buf)
}

/// token 的用户 SID（TOKEN_USER → CopySid）。
unsafe fn user_sid_bytes(base_token: HANDLE) -> Result<Vec<u8>> {
    let mut len: u32 = 0;
    GetTokenInformation(base_token, TokenUser, std::ptr::null_mut(), 0, &mut len);
    let mut buf = vec![0u8; len as usize];
    let ok = GetTokenInformation(
        base_token,
        TokenUser,
        buf.as_mut_ptr() as *mut c_void,
        len,
        &mut len,
    );
    if ok == 0 {
        return Err(anyhow!("GetTokenInformation(TokenUser) failed: {}", GetLastError()));
    }
    let user = &*(buf.as_ptr() as *const TOKEN_USER);
    let sid_len = GetLengthSid(user.User.Sid);
    let mut out = vec![0u8; sid_len as usize];
    if CopySid(sid_len, out.as_mut_ptr() as *mut c_void, user.User.Sid) == 0 {
        return Err(anyhow!("CopySid(user) failed: {}", GetLastError()));
    }
    Ok(out)
}

/// token 的 logon SID（TOKEN_GROUPS 中 SE_GROUP_LOGON_ID 属性组）。
unsafe fn logon_sid_bytes(base_token: HANDLE) -> Result<Vec<u8>> {
    let mut len: u32 = 0;
    GetTokenInformation(base_token, TokenGroups, std::ptr::null_mut(), 0, &mut len);
    let mut buf = vec![0u8; len as usize];
    let ok = GetTokenInformation(
        base_token,
        TokenGroups,
        buf.as_mut_ptr() as *mut c_void,
        len,
        &mut len,
    );
    if ok == 0 {
        return Err(anyhow!("GetTokenInformation(TokenGroups) failed: {}", GetLastError()));
    }
    let groups = &*(buf.as_ptr() as *const windows_sys::Win32::Security::TOKEN_GROUPS);
    for i in 0..groups.GroupCount {
        let g = &*groups.Groups.as_ptr().add(i as usize);
        if g.Attributes & SE_GROUP_LOGON_ID != 0 {
            let sid_len = GetLengthSid(g.Sid);
            let mut out = vec![0u8; sid_len as usize];
            if CopySid(sid_len, out.as_mut_ptr() as *mut c_void, g.Sid) == 0 {
                return Err(anyhow!("CopySid(logon) failed: {}", GetLastError()));
            }
            return Ok(out);
        }
    }
    Err(anyhow!("logon SID not found in token groups"))
}

/// SID 字符串（S-1-5-21-...）→ 二进制 SID（ConvertStringSidToSidW）。
pub unsafe fn sid_from_string(s: &str) -> Result<Vec<u8>> {
    use windows_sys::Win32::Security::Authorization::ConvertStringSidToSidW;
    let mut sid: *mut c_void = std::ptr::null_mut();
    let w = wide(s);
    if ConvertStringSidToSidW(w.as_ptr(), &mut sid) == 0 {
        return Err(anyhow!("ConvertStringSidToSidW({s}) failed: {}", GetLastError()));
    }
    let len = GetLengthSid(sid);
    let mut out = vec![0u8; len as usize];
    let copied = CopySid(len, out.as_mut_ptr() as *mut c_void, sid);
    LocalFree(sid as HLOCAL);
    if copied == 0 {
        return Err(anyhow!("CopySid(from string) failed: {}", GetLastError()));
    }
    Ok(out)
}

/// 启用单权限（SeChangeNotifyPrivilege——目录遍历所需，照 codex）。
unsafe fn enable_single_privilege(h_token: HANDLE, name: &str) -> Result<()> {
    let mut luid = LUID { LowPart: 0, HighPart: 0 };
    let w = wide(name);
    if LookupPrivilegeValueW(std::ptr::null(), w.as_ptr(), &mut luid) == 0 {
        return Err(anyhow!("LookupPrivilegeValueW({name}) failed: {}", GetLastError()));
    }
    #[repr(C)]
    struct TokPrivs1 {
        count: u32,
        luid: LUID,
        attrs: u32,
    }
    const SE_PRIVILEGE_ENABLED: u32 = 0x2;
    let tp = TokPrivs1 { count: 1, luid, attrs: SE_PRIVILEGE_ENABLED };
    let ok = AdjustTokenPrivileges(
        h_token,
        0,
        &tp as *const _ as *const windows_sys::Win32::Security::TOKEN_PRIVILEGES,
        std::mem::size_of::<TokPrivs1>() as u32,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
    );
    if ok == 0 {
        return Err(anyhow!("AdjustTokenPrivileges({name}) failed: {}", GetLastError()));
    }
    Ok(())
}
use windows_sys::Win32::Security::AdjustTokenPrivileges;

/// 构造受限 token：restricting SIDs = [cap, user, logon, everyone]（codex 同序）。
///
/// # Safety
/// 调用方负责关闭返回句柄；base_token 须为有效 primary token。
pub unsafe fn create_sandbox_token(base_token: HANDLE, cap_sid: &[u8]) -> Result<HANDLE> {
    let user = user_sid_bytes(base_token)?;
    let logon = logon_sid_bytes(base_token)?;
    let everyone = world_sid()?;

    // 顺序照 codex：cap → user → logon → everyone（顺序影响 DACL/继承语义）
    let sids: [Vec<u8>; 4] = [cap_sid.to_vec(), user, logon, everyone];
    let mut entries: Vec<SID_AND_ATTRIBUTES> = sids
        .iter()
        .map(|s| SID_AND_ATTRIBUTES { Sid: s.as_ptr() as *mut c_void, Attributes: 0 })
        .collect();

    let mut new_token: HANDLE = std::ptr::null_mut();
    let flags = DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED;
    let ok = CreateRestrictedToken(
        base_token,
        flags,
        0,
        std::ptr::null(),
        0,
        std::ptr::null(),
        entries.len() as u32,
        entries.as_mut_ptr(),
        &mut new_token,
    );
    if ok == 0 {
        return Err(anyhow!("CreateRestrictedToken failed: {}", GetLastError()));
    }

    // default DACL：logon + everyone + cap（新建管道/IPC 对象放行）
    let dacl_sids: Vec<*mut c_void> = vec![
        sids[2].as_ptr() as *mut c_void,
        sids[3].as_ptr() as *mut c_void,
        sids[0].as_ptr() as *mut c_void,
    ];
    if let Err(e) = set_default_dacl(new_token, &dacl_sids) {
        CloseHandle(new_token);
        return Err(e);
    }
    enable_single_privilege(new_token, "SeChangeNotifyPrivilege")?;
    Ok(new_token)
}

/// 当前进程 token（helper 自身——daemon 以用户身份 spawn）。
/// # Safety
/// 调用方负责关闭返回句柄。
pub unsafe fn current_process_token() -> Result<HANDLE> {
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    use windows_sys::Win32::System::Threading::OpenProcessToken;
    let mut token: HANDLE = std::ptr::null_mut();
    if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &mut token) == 0 {
        return Err(anyhow!("OpenProcessToken failed: {}", GetLastError()));
    }
    Ok(token)
}
