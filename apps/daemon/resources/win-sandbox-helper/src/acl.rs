//! acl.rs——writableRoots 预写 grant ACE（helix 裁剪版）。
//!
//! 机制：对每个 writableRoot 目录，向其 DACL 追加 grant(cap SID) 的
//! FILE_GENERIC_WRITE | DELETE | READ_CONTROL ACE（对象+容器继承）。
//! 受限 token 的写检查（全部 restricting SIDs 须 grant）因此只在
//! 这些目录内放行。既有 DACL 不清除（合并追加）；
//! 残留 ACE 指向随机死 SID，无害且不累积（SID 随机不复用）。

use std::ffi::c_void;
use std::path::Path;

use anyhow::Result;
use anyhow::anyhow;
use windows_sys::Win32::Foundation::ERROR_SUCCESS;
use windows_sys::Win32::Foundation::HLOCAL;
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::ACL;
use windows_sys::Win32::Security::Authorization::EXPLICIT_ACCESS_W;
use windows_sys::Win32::Security::Authorization::GetNamedSecurityInfoW;
use windows_sys::Win32::Security::Authorization::GRANT_ACCESS;
use windows_sys::Win32::Security::Authorization::SE_FILE_OBJECT;
use windows_sys::Win32::Security::Authorization::SetEntriesInAclW;
use windows_sys::Win32::Security::Authorization::SetNamedSecurityInfoW;
use windows_sys::Win32::Security::Authorization::TRUSTEE_IS_SID;
use windows_sys::Win32::Security::Authorization::TRUSTEE_IS_UNKNOWN;
use windows_sys::Win32::Security::Authorization::TRUSTEE_W;
use windows_sys::Win32::Security::CONTAINER_INHERIT_ACE;
use windows_sys::Win32::Security::DACL_SECURITY_INFORMATION;
use windows_sys::Win32::Security::OBJECT_INHERIT_ACE;
use windows_sys::Win32::Storage::FileSystem::DELETE;
use windows_sys::Win32::Storage::FileSystem::FILE_GENERIC_WRITE;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 向 path 的 DACL 追加 grant(cap_sid) 写 ACE（继承到子项）。
/// # Safety
/// cap_sid 须为有效 SID 二进制。
pub unsafe fn add_allow_write_ace(path: &Path, cap_sid: &[u8]) -> Result<()> {
    let mut existing: *mut ACL = std::ptr::null_mut();
    let mut sd: *mut c_void = std::ptr::null_mut();
    let wpath = wide(&path.to_string_lossy());
    let res = GetNamedSecurityInfoW(
        wpath.as_ptr(),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        &mut existing,
        std::ptr::null_mut(),
        &mut sd,
    );
    if res != ERROR_SUCCESS {
        return Err(anyhow!("GetNamedSecurityInfoW({}) failed: {res}", path.display()));
    }

    let entry = EXPLICIT_ACCESS_W {
        // FILE_GENERIC_WRITE | DELETE | READ_CONTROL——codex 同面（写 + 删 + 读控制）
        grfAccessPermissions: FILE_GENERIC_WRITE | DELETE | 0x0002_0000,
        grfAccessMode: GRANT_ACCESS,
        grfInheritance: OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: 0,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            ptstrName: cap_sid.as_ptr() as *mut u16,
        },
    };

    let mut new_dacl: *mut ACL = std::ptr::null_mut();
    let res = SetEntriesInAclW(1, &entry, existing, &mut new_dacl);
    if res != ERROR_SUCCESS {
        if !sd.is_null() {
            LocalFree(sd as HLOCAL);
        }
        return Err(anyhow!("SetEntriesInAclW({}) failed: {res}", path.display()));
    }

    let res = SetNamedSecurityInfoW(
        wpath.as_ptr(),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        new_dacl as *const ACL,
        std::ptr::null_mut(),
    );
    if !new_dacl.is_null() {
        LocalFree(new_dacl as HLOCAL);
    }
    if !sd.is_null() {
        LocalFree(sd as HLOCAL);
    }
    if res != ERROR_SUCCESS {
        return Err(anyhow!("SetNamedSecurityInfoW({}) failed: {res}", path.display()));
    }
    Ok(())
}

/// 生成随机 capability SID 字符串（S-1-5-21-a-b-c-d——codex 同形态）。
/// 不持久化：helper 每次调用独立 SID（残留 ACE 指向死 SID 无害；helix 无跨会话
/// ACL 复用需求——codex 持久化是为跨进程一致性，helix 单次命令生命周期不需要）。
pub fn random_cap_sid() -> String {
    // 无 rand 依赖：SystemTime 熵（沙箱场景足够——SID 只需「不被既有 ACL 引用」）
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u128;
    let mut state = nanos ^ (pid << 64) ^ 0x9E37_79B9_7F4A_7C15;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state & 0xFFFF_FFFF) as u32
    };
    format!("S-1-5-21-{}-{}-{}-{}", next(), next(), next(), next())
}
