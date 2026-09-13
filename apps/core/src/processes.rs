use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};

fn start_time(pid: u32) -> Option<String> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let fields: Vec<_> = stat.rsplit_once(") ")?.1.split_whitespace().collect();
    if fields.first() == Some(&"Z") {
        return None;
    }
    fields.get(19).map(|s| s.to_string())
}
fn boot_id() -> String {
    fs::read_to_string("/proc/sys/kernel/random/boot_id")
        .unwrap_or_default()
        .trim()
        .to_string()
}

pub(crate) fn record(root: &Path, pid: u32, token: &str) -> Result<PathBuf, String> {
    let directory = root.join("data/runtime/processes");
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let path = directory.join(format!("{token}.json"));
    let start = start_time(pid).ok_or("Process exited before identity was recorded")?;
    let executable = fs::read_link(format!("/proc/{pid}/exe")).map_err(|e| e.to_string())?;
    let identity = json!({"id":token,"pid":pid,"start_time":start,"boot_id":boot_id(),"executable":executable,"token":token,"group_id":pid});
    fs::write(&path, identity.to_string()).map_err(|e| e.to_string())?;
    Ok(path)
}

pub(crate) fn recovery(root: &Path) -> Vec<Value> {
    let mut result = vec![];
    if let Ok(entries) = fs::read_dir(root.join("data/runtime/releases")) {
        for entry in entries.flatten() {
            let processes = fs::read(entry.path())
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Vec<(u32, String)>>(&bytes).ok());
            if processes
                .as_ref()
                .is_some_and(|processes| resources_released(processes))
            {
                let _ = fs::remove_file(entry.path());
            } else {
                result.push(json!({"id":entry.file_name().to_string_lossy(),"reason":"Waiting for owned model resources to be released","allowed_actions":[]}));
            }
        }
    }
    let Ok(entries) = fs::read_dir(root.join("data/runtime/processes")) else {
        return result;
    };
    for entry in entries.flatten() {
        let Ok(bytes) = fs::read(entry.path()) else {
            continue;
        };
        let Ok(identity) = serde_json::from_slice::<Value>(&bytes) else {
            result.push(json!({"id": entry.file_name().to_string_lossy(), "reason":"Unreadable ownership record", "allowed_actions":[]}));
            continue;
        };
        let pid = identity["pid"].as_u64().unwrap_or(0) as u32;
        if identity["boot_id"] != boot_id() {
            let _ = fs::remove_file(entry.path());
            continue;
        }
        if start_time(pid).as_deref() != identity["start_time"].as_str() {
            // A surviving group member inherits both the private launch marker and
            // the group created by core. Record its own identity before dropping the leader.
            let group = identity["group_id"].as_u64().unwrap_or(pid as u64);
            if let (Some(token), Ok(processes)) =
                (identity["token"].as_str(), fs::read_dir("/proc"))
            {
                for process in processes.flatten() {
                    let Ok(child) = process.file_name().to_string_lossy().parse::<u32>() else {
                        continue;
                    };
                    let Some(start) = start_time(child) else {
                        continue;
                    };
                    let Ok(stat) = fs::read_to_string(process.path().join("stat")) else {
                        continue;
                    };
                    if stat
                        .rsplit_once(") ")
                        .and_then(|(_, s)| s.split_whitespace().nth(2))
                        .and_then(|s| s.parse::<u64>().ok())
                        != Some(group)
                    {
                        continue;
                    }
                    if !fs::read(process.path().join("environ")).is_ok_and(|bytes| {
                        bytes.split(|b| *b == 0).any(|field| {
                            field == format!("DAEVOX_PROCESS_TOKEN={token}").as_bytes()
                        })
                    }) {
                        continue;
                    }
                    let Ok(executable) = fs::read_link(process.path().join("exe")) else {
                        continue;
                    };
                    let id = uuid::Uuid::new_v4().to_string();
                    let record = json!({"id":id,"pid":child,"start_time":start,"boot_id":boot_id(),"executable":executable,"token":token,"group_id":group});
                    let path = root
                        .join("data/runtime/processes")
                        .join(format!("{id}.json"));
                    if fs::write(path, record.to_string()).is_ok() {
                        result.push(json!({"id":id,"pid":child,"reason":"Owned descendant survived its leader","allowed_actions":["stop"]}));
                    }
                }
            }
            let _ = fs::remove_file(entry.path());
            continue;
        }
        result.push(json!({"id":identity["id"],"pid":pid,"reason":"Owned process survived core shutdown","allowed_actions":if verified(&identity) { vec!["stop"] } else { vec![] }}));
    }
    result
}

fn verified(identity: &Value) -> bool {
    let Some(pid) = identity["pid"].as_u64() else {
        return false;
    };
    let Some(token) = identity["token"].as_str() else {
        return false;
    };
    let executable = fs::read_link(format!("/proc/{pid}/exe")).ok();
    identity["boot_id"] == boot_id()
        && start_time(pid as u32).as_deref() == identity["start_time"].as_str()
        && executable.as_ref().map(|p| p.to_string_lossy()).as_deref()
            == identity["executable"].as_str()
        && fs::read(format!("/proc/{pid}/environ")).is_ok_and(|bytes| {
            bytes
                .split(|b| *b == 0)
                .any(|field| field == format!("DAEVOX_PROCESS_TOKEN={token}").as_bytes())
        })
}

pub(crate) async fn stop(
    axum::Extension(directory): axum::Extension<crate::presets::Directory>,
    axum::Extension(runtime): axum::Extension<crate::runtime::Runtime>,
    axum::Extension(db): axum::Extension<sea_orm::DatabaseConnection>,
    axum::extract::Path(id): axum::extract::Path<String>,
    headers: axum::http::HeaderMap,
) -> Result<(axum::http::StatusCode, axum::Json<Value>), crate::settings::ApiError> {
    use crate::{commands, operations, settings::ApiError};
    use axum::http::StatusCode;
    use sea_orm::TransactionTrait;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    let key = commands::key(&headers)?;
    let action = format!("POST /recovery/{id}/stop");
    let tx = db.begin().await?;
    if let Some(response) = commands::replay(&tx, &key, &action, &json!({})).await? {
        tx.commit().await?;
        return Ok((StatusCode::ACCEPTED, axum::Json(response)));
    }
    uuid::Uuid::parse_str(&id).map_err(|_| {
        ApiError(
            StatusCode::NOT_FOUND,
            "unknown_resource",
            "Unknown process record".into(),
        )
    })?;
    let root = directory.0.parent().unwrap();
    let path = root
        .join("data/runtime/processes")
        .join(format!("{id}.json"));
    let identity: Value = serde_json::from_slice(&fs::read(&path)?).map_err(|_| {
        ApiError(
            StatusCode::CONFLICT,
            "state_conflict",
            "Invalid ownership record".into(),
        )
    })?;
    let pid = identity["pid"].as_u64().unwrap_or(0) as u32;
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) } as i32;
    if fd < 0 {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "state_conflict",
            "Process changed; reload recovery".into(),
        ));
    }
    let handle = unsafe { OwnedFd::from_raw_fd(fd) };
    if !verified(&identity) {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "state_conflict",
            "Process ownership cannot be proven".into(),
        ));
    }
    let result = unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            handle.as_raw_fd(),
            libc::SIGKILL,
            std::ptr::null::<libc::siginfo_t>(),
            0,
        )
    };
    if result < 0 {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "state_conflict",
            "Cannot stop the owned process".into(),
        ));
    }
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while start_time(pid).is_some() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .map_err(|_| {
        ApiError(
            StatusCode::CONFLICT,
            "state_conflict",
            "Owned process has not exited".into(),
        )
    })?;
    let remaining = recovery(root);
    let _ = fs::remove_file(path);
    let mut snapshot = runtime.0.lock().await;
    snapshot["state"] = json!(if remaining.is_empty() {
        "empty"
    } else {
        "recovery_required"
    });
    snapshot["recovery"] = json!(remaining);
    let operation_id = uuid::Uuid::new_v4().to_string();
    operations::save(&tx, "operations", &operation_id, &json!({"id":operation_id,"type":"recovery","status":"succeeded","phase":"stopped","resource_id":id,"created_at":chrono::Utc::now().to_rfc3339(),"updated_at":chrono::Utc::now().to_rfc3339(),"progress":null,"error":null,"allowed_actions":[]})).await?;
    let response = json!({"operation_id":operation_id});
    commands::remember(&tx, &key, &action, &json!({}), &response).await?;
    tx.commit().await?;
    Ok((StatusCode::ACCEPTED, axum::Json(response)))
}

pub(crate) fn children(pid: u32) -> Vec<(u32, String)> {
    let mut children = std::collections::BTreeSet::new();
    if let Ok(tasks) = fs::read_dir(format!("/proc/{pid}/task")) {
        for task in tasks.flatten() {
            if let Ok(list) = fs::read_to_string(task.path().join("children")) {
                children.extend(
                    list.split_whitespace()
                        .filter_map(|p| p.parse::<u32>().ok()),
                );
            }
        }
    }
    children
        .into_iter()
        .filter_map(|pid| start_time(pid).map(|start| (pid, start)))
        .collect()
}
pub(crate) fn still_alive(pid: u32, start: &str) -> bool {
    start_time(pid).as_deref() == Some(start)
}

pub(crate) fn resources_released(processes: &[(u32, String)]) -> bool {
    if processes
        .iter()
        .any(|(pid, start)| still_alive(*pid, start))
    {
        return false;
    }
    if let Ok(nvml) = nvml_wrapper::Nvml::init() {
        for index in 0..nvml.device_count().unwrap_or(0) {
            if let Ok(device) = nvml.device_by_index(index)
                && let Ok(allocations) = device.running_compute_processes()
                && allocations
                    .iter()
                    .any(|allocation| processes.iter().any(|(pid, _)| *pid == allocation.pid))
            {
                return false;
            }
        }
    }
    true
}

pub(crate) fn stop_owned(root: &Path) -> Result<(), String> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    for process in recovery(root) {
        let Some(id) = process["id"].as_str() else {
            continue;
        };
        let path = root
            .join("data/runtime/processes")
            .join(format!("{id}.json"));
        let Ok(bytes) = fs::read(path) else {
            continue;
        };
        let Ok(identity) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        let Some(pid) = identity["pid"].as_u64() else {
            continue;
        };
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) } as i32;
        if fd < 0 {
            continue;
        }
        let handle = unsafe { OwnedFd::from_raw_fd(fd) };
        if !verified(&identity) {
            continue;
        }
        if unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                handle.as_raw_fd(),
                libc::SIGKILL,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        } < 0
        {
            return Err("Cannot stop verified owned process".into());
        }
    }
    Ok(())
}

pub(crate) fn owned_pids(root: &Path) -> Vec<u32> {
    let mut owned = std::collections::BTreeSet::from([std::process::id()]);
    if let Ok(entries) = fs::read_dir(root.join("data/runtime/processes")) {
        for entry in entries.flatten() {
            if let Ok(bytes) = fs::read(entry.path())
                && let Ok(identity) = serde_json::from_slice::<Value>(&bytes)
                && verified(&identity)
            {
                let mut pending = vec![identity["pid"].as_u64().unwrap() as u32];
                while let Some(pid) = pending.pop() {
                    if owned.insert(pid) {
                        pending.extend(children(pid).into_iter().map(|(pid, _)| pid));
                    }
                }
            }
        }
    }
    owned.into_iter().collect()
}
