use crate::{commands, operations, presets::Directory, settings::ApiError};
use axum::{
    Extension, Json,
    http::{HeaderMap, StatusCode},
};
use sea_orm::{DatabaseConnection, TransactionTrait};
use serde_json::{Value, json};

pub(crate) async fn list(
    Extension(db): Extension<DatabaseConnection>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        json!({"builds": operations::all(&db, "builds").await?}),
    ))
}
pub(crate) async fn create(
    Extension(directory): Extension<Directory>,
    Extension(db): Extension<DatabaseConnection>,
    Extension(runtime): Extension<crate::runtime::Runtime>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    accept_build(directory, db, runtime, headers, body, false).await
}

async fn accept_build(
    directory: Directory,
    db: DatabaseConnection,
    runtime: crate::runtime::Runtime,
    headers: HeaderMap,
    body: Value,
    automatic: bool,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let key = commands::key(&headers)?;
    if !matches!(body["profile"].as_str(), Some("cuda" | "cpu"))
        || !body["jobs"].as_u64().is_some_and(|n| n > 0)
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Choose cuda/cpu and positive compiler jobs".into(),
        ));
    }
    let tx = db.begin().await?;
    if let Some(response) = commands::replay(&tx, &key, "POST /builds", &body).await? {
        tx.commit().await?;
        return Ok((StatusCode::ACCEPTED, Json(response)));
    }
    let snapshot = runtime.0.lock().await;
    if snapshot["state"] == "recovery_required" || (automatic && snapshot["state"] != "empty") {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "state_conflict",
            "Automatic builds wait for an empty runtime; resolve recovery before new work".into(),
        ));
    }
    if operations::all(&tx, "operations")
        .await?
        .iter()
        .any(|op| op["type"] == "build" && op["status"] == "running")
    {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "state_conflict",
            "A build is already running".into(),
        ));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let build_id = uuid::Uuid::new_v4().to_string();
    let operation = json!({"id": id, "type": "build", "status": "running", "phase": "configure", "resource_id": build_id, "created_at": chrono::Utc::now().to_rfc3339(), "updated_at": chrono::Utc::now().to_rfc3339(), "progress": null, "error": null, "allowed_actions": ["cancel"]});
    let build = json!({"id": build_id, "profile": body["profile"], "jobs": body["jobs"], "status": "building", "checks": [], "current": false, "previous": false});
    operations::save(&tx, "operations", &id, &operation).await?;
    operations::save(&tx, "builds", &build_id, &build).await?;
    let response = json!({"operation_id": id});
    commands::remember(&tx, &key, "POST /builds", &body, &response).await?;
    tx.commit().await?;
    drop(snapshot);
    tokio::spawn(async move {
        let mut operation = operation;
        let mut build = build;
        let result = compile(
            directory.0.parent().unwrap(),
            &db,
            &mut operation,
            &mut build,
        )
        .await;
        match result {
            Ok(()) => {
                operation["status"] = json!("succeeded");
                build["status"] = json!("ready");
            }
            Err(message) if message == "cancelled" => {
                operation["status"] = json!("cancelled");
                build["status"] = json!("cancelled");
            }
            Err(message) => {
                operation["status"] = json!("failed");
                build["status"] = json!("failed");
                operation["error"] = json!({"code": "build_failed", "message": message, "retryable": true, "details": null});
            }
        }
        operation["allowed_actions"] = json!([]);
        operation["updated_at"] = json!(chrono::Utc::now().to_rfc3339());
        let published: Result<(), ApiError> = async {
            let tx = db.begin().await?;
            let latest = operations::find(&tx, "operations", &id).await?;
            if latest["status"] != "running" {
                return Ok(());
            }
            if latest["cancel_requested"] == true {
                operation["status"] = json!("cancelled");
                build["status"] = json!("cancelled");
            }
            operations::save(&tx, "builds", &build_id, &build).await?;
            operations::save(&tx, "operations", &id, &operation).await?;
            tx.commit().await?;
            Ok(())
        }
        .await;
        if let Err(error) = published {
            operation["status"] = json!("failed");
            operation["error"] =
                json!({"code":"storage_error","message":error.2,"retryable":true,"details":null});
            build["status"] = json!("failed");
            if let Ok(tx) = db.begin().await {
                let saved = async {
                    operations::save(&tx, "builds", &build_id, &build).await?;
                    operations::save(&tx, "operations", &id, &operation).await
                }
                .await;
                if saved.is_ok() {
                    let _ = tx.commit().await;
                }
            }
        }
    });
    Ok((StatusCode::ACCEPTED, Json(response)))
}

async fn execute(
    command: &mut tokio::process::Command,
    log: &std::path::Path,
    db: &DatabaseConnection,
    id: &str,
    root: &std::path::Path,
) -> Result<(), String> {
    let token = uuid::Uuid::new_v4().to_string();
    command.env("DAEVOX_PROCESS_TOKEN", &token);
    let mut child = command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    let build_id = log
        .parent()
        .unwrap()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .to_string();
    let context = json!({"build_id":build_id,"operation_id":id});
    crate::logs::capture(
        root,
        "build",
        context.clone(),
        "stdout",
        child.stdout.take().unwrap(),
    );
    crate::logs::capture(
        root,
        "build",
        context,
        "stderr",
        child.stderr.take().unwrap(),
    );
    let identity = match crate::processes::record(root, child.id().ok_or("Child exited")?, &token) {
        Ok(identity) => identity,
        Err(error) => match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) if status.success() => return Ok(()),
            Some(status) => return Err(format!("Command failed ({status})")),
            None => return Err(error),
        },
    };
    let mut tick = tokio::time::interval(std::time::Duration::from_millis(25));
    let status = loop {
        tokio::select! {
            status = child.wait() => break status.map_err(|e| e.to_string())?,
            _ = tick.tick() => {
                let operation = operations::find(db, "operations", id).await.map_err(|e| e.2)?;
                if operation["cancel_requested"] == true {
                    if let Some(pid) = child.id() {
                        // The live child is the leader of the group created by this command.
                        unsafe { libc::kill(-(pid as i32), libc::SIGKILL); }
                    }
                    let _ = child.wait().await;
                    let _ = std::fs::remove_file(&identity);
                    return Err("cancelled".into());
                }
            }
        }
    };
    let _ = std::fs::remove_file(&identity);
    if status.success() {
        Ok(())
    } else {
        let bytes = std::fs::read(log).unwrap_or_default();
        Err(format!(
            "Command failed ({status}): {}",
            String::from_utf8_lossy(&bytes[bytes.len().saturating_sub(4096)..])
        ))
    }
}

async fn compile(
    root: &std::path::Path,
    db: &DatabaseConnection,
    operation: &mut Value,
    build: &mut Value,
) -> Result<(), String> {
    use tokio::process::Command;
    let source = root.join("vendor/llama.cpp");
    let build_id = build["id"].as_str().unwrap().to_string();
    let id = operation["id"].as_str().unwrap().to_string();
    let path = root.join("data/builds").join(&build_id);
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    let git = Command::new("git")
        .arg("-C")
        .arg(&source)
        .args(["rev-parse", "HEAD"])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !git.status.success() {
        return Err(
            "Pinned llama.cpp submodule is unavailable; initialize the repository submodule".into(),
        );
    }
    build["commit"] = json!(String::from_utf8_lossy(&git.stdout).trim());
    let log = path.join("build.log");
    let cuda = build["profile"] == "cuda";
    let mut configure = Command::new("cmake");
    configure.arg("-S").arg(&source).arg("-B").arg(&path).args([
        "-DLLAMA_CURL=OFF",
        if cuda {
            "-DGGML_CUDA=ON"
        } else {
            "-DGGML_CUDA=OFF"
        },
    ]);
    if cuda {
        configure.arg("-DCMAKE_CUDA_ARCHITECTURES=native");
    }
    execute(&mut configure, &log, db, &id, root).await?;
    operation["phase"] = json!("compile");
    operations::save(db, "operations", &id, operation)
        .await
        .map_err(|e| e.2)?;
    execute(
        Command::new("cmake")
            .arg("--build")
            .arg(&path)
            .args(["--target", "llama-server", "-j"])
            .arg(build["jobs"].as_u64().unwrap().to_string()),
        &log,
        db,
        &id,
        root,
    )
    .await?;
    operation["phase"] = json!("check");
    operations::save(db, "operations", &id, operation)
        .await
        .map_err(|e| e.2)?;
    let binary = path.join("bin/llama-server");
    let devices = Command::new(&binary)
        .arg("--list-devices")
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !devices.status.success() {
        return Err("Candidate device check failed".into());
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    drop(listener);
    let preset = path.join("probe.ini");
    std::fs::write(&preset, "version = 1\n").map_err(|e| e.to_string())?;
    let token = uuid::Uuid::new_v4().to_string();
    let mut router = Command::new(&binary)
        .args([
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--models-preset",
        ])
        .arg(&preset)
        .args(["--no-models-autoload", "--models-max", "1"])
        .env("DAEVOX_PROCESS_TOKEN", &token)
        .process_group(0)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    let probe_pid = router.id().ok_or("Candidate exited")?;
    let identity = crate::processes::record(root, probe_pid, &token)?;
    let context = json!({"build_id":build_id,"operation_id":id});
    crate::logs::capture(
        root,
        "build",
        context.clone(),
        "stdout",
        router.stdout.take().unwrap(),
    );
    crate::logs::capture(
        root,
        "build",
        context,
        "stderr",
        router.stderr.take().unwrap(),
    );
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(1))
        .build()
        .map_err(|e| e.to_string())?;
    let check = tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
            if operations::find(db, "operations", &id)
                .await
                .map_err(|e| e.2)?["cancel_requested"]
                == true
            {
                return Err("cancelled".to_string());
            }
            if router.try_wait().map_err(|e| e.to_string())?.is_some() {
                return Err("Candidate router exited before readiness".to_string());
            }
            if let Ok(response) = client
                .get(format!("http://127.0.0.1:{port}/health"))
                .send()
                .await
                && response.status().is_success()
            {
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    })
    .await
    .map_err(|_| "Candidate router readiness timed out".to_string());
    unsafe {
        libc::kill(-(probe_pid as i32), libc::SIGKILL);
    }
    let _ = router.wait().await;
    let _ = std::fs::remove_file(identity);
    check??;
    let cmake = Command::new("cmake")
        .arg("--version")
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let compiler = Command::new("c++")
        .arg("--version")
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let fingerprint = json!({"commit": build["commit"], "profile": build["profile"], "cmake": String::from_utf8_lossy(&cmake.stdout), "compiler": String::from_utf8_lossy(&compiler.stdout), "cache": std::fs::read_to_string(path.join("CMakeCache.txt")).unwrap_or_default(), "devices": String::from_utf8_lossy(&devices.stdout)});
    build["fingerprint"] = json!(crate::presets::revision(&fingerprint.to_string()));
    build["configuration"] = fingerprint;
    build["checks"] = json!({"router_health": true, "devices": String::from_utf8_lossy(&devices.stdout), "inference": "not_checked", "driver_version":driver_version(), "driver_compatibility":"passed"});
    Ok(())
}

pub(crate) async fn apply(
    Extension(directory): Extension<Directory>,
    Extension(db): Extension<DatabaseConnection>,
    Extension(runtime): Extension<crate::runtime::Runtime>,
    axum::extract::Path(build_id): axum::extract::Path<String>,
    headers: HeaderMap,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let key = commands::key(&headers)?;
    let action = format!("POST /builds/{build_id}/apply");
    let settings = crate::settings::read(Extension(db.clone())).await?.0;
    let timeout_ms = settings["drain_timeout_ms"].as_u64().unwrap();
    let tx = db.begin().await?;
    if let Some(response) = commands::replay(&tx, &key, &action, &json!({})).await? {
        tx.commit().await?;
        return Ok((StatusCode::ACCEPTED, Json(response)));
    }
    let candidate = operations::find(&tx, "builds", &build_id).await?;
    if candidate["status"] != "ready" || candidate["checks"]["driver_compatibility"] == "failed" {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "state_conflict",
            "Build is not a checked candidate".into(),
        ));
    }
    let mut snapshot = runtime.0.lock().await;
    if snapshot["state"] == "error" {
        let recovery = crate::processes::recovery(directory.0.parent().unwrap());
        if !recovery.is_empty() {
            snapshot["state"] = json!("recovery_required");
            snapshot["recovery"] = json!(recovery);
        }
    }
    if !matches!(
        snapshot["state"].as_str(),
        Some("empty" | "ready" | "error")
    ) || !snapshot["current_operation_id"].is_null()
    {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "state_conflict",
            "Runtime is busy".into(),
        ));
    }
    let previous = snapshot["current_build_id"].clone();
    let id = uuid::Uuid::new_v4().to_string();
    let mut operation = json!({"id":id,"type":"build_apply","status":"running","phase":"waiting","resource_id":build_id,"created_at":chrono::Utc::now().to_rfc3339(),"updated_at":chrono::Utc::now().to_rfc3339(),"progress":null,"error":null,"allowed_actions":["cancel","force"]});
    operations::save(&tx, "operations", &id, &operation).await?;
    let response = json!({"operation_id":id});
    commands::remember(&tx, &key, &action, &json!({}), &response).await?;
    tx.commit().await?;
    snapshot["current_operation_id"] = json!(id);
    snapshot["state"] = json!("waiting");
    drop(snapshot);
    tokio::spawn(async move {
        let root = directory.0.parent().unwrap();
        let result = async {
            tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), async {
                while runtime.2.load(std::sync::atomic::Ordering::SeqCst) > 0 {
                    if operations::find(&db, "operations", &id)
                        .await
                        .map_err(|e| e.2)?["cancel_requested"]
                        == true
                    {
                        return Err("cancelled_waiting".to_string());
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
                Ok::<_, String>(())
            })
            .await
            .map_err(|_| "drain_timeout".to_string())??;
            let tx = db.begin().await.map_err(|e| e.to_string())?;
            let mut saved = operations::find(&tx, "operations", &id)
                .await
                .map_err(|e| e.2)?;
            if saved["cancel_requested"] == true {
                return Err("cancelled_waiting".to_string());
            }
            saved["phase"] = json!("unloading");
            saved["allowed_actions"] = json!(["cancel"]);
            operations::save(&tx, "operations", &id, &saved)
                .await
                .map_err(|e| e.2)?;
            tx.commit().await.map_err(|e| e.to_string())?;
            runtime.0.lock().await["state"] = json!("unloading");
            let old_name = runtime.0.lock().await["active_instance"]["preset_id"]
                .as_str()
                .map(str::to_owned);
            if let Some(old_name) = old_name {
                let routers = runtime.1.lock().await;
                if let Some(router) = routers.as_ref() {
                    let client = reqwest::Client::new();
                    let children =
                        crate::processes::children(router.child.id().ok_or("Router exited")?);
                    client
                        .post(format!("{}/models/unload", router.url))
                        .json(&json!({"model":old_name}))
                        .send()
                        .await
                        .map_err(|e| e.to_string())?
                        .error_for_status()
                        .map_err(|e| e.to_string())?;
                    tokio::time::timeout(std::time::Duration::from_secs(300), async {
                        loop {
                            let models: Value = client
                                .get(format!("{}/models", router.url))
                                .send()
                                .await
                                .map_err(|e| e.to_string())?
                                .json()
                                .await
                                .map_err(|e| e.to_string())?;
                            let unloaded = models["data"].as_array().is_some_and(|models| {
                                models.iter().all(|m| {
                                    m["id"] != old_name || m["status"]["value"] == "unloaded"
                                })
                            });
                            if unloaded && crate::processes::resources_released(&children) {
                                break Ok::<_, String>(());
                            }
                            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                        }
                    })
                    .await
                    .map_err(|_| "Old model has not exited".to_string())??;
                }
            }
            runtime.0.lock().await["active_instance"] = Value::Null;
            if let Some(router) = runtime.1.lock().await.take() {
                router.stop().await?;
            }
            if operations::find(&db, "operations", &id)
                .await
                .map_err(|e| e.2)?["cancel_requested"]
                == true
            {
                return Err("cancelled_after_stop".to_string());
            }
            let ini = root.join("data/generated/empty.ini");
            std::fs::write(&ini, "version = 1\n").map_err(|e| e.to_string())?;
            crate::router::RouterProcess::start(root, &build_id, &ini).await
        }
        .await;
        let mut candidate = None;
        let finish = async {
            let tx = db.begin().await.map_err(|e|e.to_string())?;
            let latest = operations::find(&tx,"operations",&id).await.map_err(|e|e.2)?;
            let result = match result {
                Ok(router) if latest["cancel_requested"] == true => {
                    router.stop().await?;
                    Err("cancelled_after_stop".to_string())
                }
                other => other,
            };
            let mut snapshot = runtime.0.lock().await;
            let mut next = snapshot.clone();
            match result {
                Ok(router) => {
                    candidate = Some(router);
                    for mut build in operations::all(&tx,"builds").await.map_err(|e|e.2)? {
                        build["current"] = json!(build["id"] == build_id);
                        build["previous"] = json!(build["id"] == previous && build["id"] != build_id);
                        operations::save(&tx,"builds",build["id"].as_str().unwrap(),&build).await.map_err(|e|e.2)?;
                    }
                    next["current_build_id"] = json!(build_id);
                    next["state"] = json!("empty");
                    operation["status"] = json!("succeeded");
                }
                Err(message) if message == "cancelled_waiting" || message == "cancelled_after_stop" || message == "drain_timeout" => {
                    next["state"] = json!(if next["active_instance"].is_null() {"empty"} else {"ready"});
                    operation["status"] = json!(if message == "drain_timeout" {"failed"} else {"cancelled"});
                    if message == "drain_timeout" {
                        operation["error"] = json!({"code":"drain_timeout","message":"Accepted requests did not finish before the drain timeout","retryable":true,"details":null});
                    }
                }
                Err(message) => {
                    next["state"] = json!("error");
                    operation["status"] = json!("failed");
                    operation["error"] = json!({"code":"apply_failed","message":message,"retryable":true,"details":null});
                }
            }
            next["current_operation_id"] = Value::Null;
            next["revision"] = json!(next["revision"].as_u64().unwrap_or(0)+1);
            next["error"] = operation["error"].clone();
            operation["allowed_actions"] = json!([]);
            operations::save(&tx,"operations",&id,&operation).await.map_err(|e|e.2)?;
            tx.commit().await.map_err(|e|e.to_string())?;
            if let Some(router) = candidate.take() { *runtime.1.lock().await = Some(router); }
            *snapshot = next;
            Ok::<(),String>(())
        }.await;
        if let Err(error) = finish {
            if let Some(router) = candidate {
                let _ = router.stop().await;
            }
            let mut snapshot = runtime.0.lock().await;
            snapshot["state"] = json!("error");
            snapshot["current_operation_id"] = Value::Null;
            snapshot["error"] =
                json!({"code":"apply_failed","message":error,"retryable":true,"details":null});
        }
    });
    Ok((StatusCode::ACCEPTED, Json(response)))
}

fn driver_version() -> Option<String> {
    nvml_wrapper::Nvml::init().ok()?.sys_driver_version().ok()
}

pub(crate) async fn recheck_driver(
    root: &std::path::Path,
    db: &DatabaseConnection,
) -> Result<(), ApiError> {
    use tokio::io::AsyncReadExt;
    let driver = driver_version();
    for mut build in operations::all(db, "builds").await? {
        if build["profile"] != "cuda"
            || build["status"] != "ready"
            || build["checks"]["driver_version"] == json!(driver)
        {
            continue;
        }
        let id = build["id"].as_str().unwrap().to_string();
        let checked = async {
            if driver.is_none() {
                return Err("CUDA driver is unavailable".to_string());
            }
            let token = uuid::Uuid::new_v4().to_string();
            let mut child = tokio::process::Command::new(
                root.join("data/builds").join(&id).join("bin/llama-server"),
            )
            .arg("--list-devices")
            .env("DAEVOX_PROCESS_TOKEN", &token)
            .process_group(0)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| e.to_string())?;
            let pid = child.id().ok_or("Device check exited")?;
            let identity = crate::processes::record(root, pid, &token).ok();
            let mut out = child.stdout.take().unwrap().take(65536);
            let mut err = child.stderr.take().unwrap().take(65536);
            let result = tokio::time::timeout(std::time::Duration::from_secs(10), async {
                let mut stdout = vec![];
                let mut stderr = vec![];
                let (_, _, status) = tokio::try_join!(
                    out.read_to_end(&mut stdout),
                    err.read_to_end(&mut stderr),
                    child.wait()
                )
                .map_err(|e| e.to_string())?;
                if !status.success() {
                    return Err(format!("CUDA compatibility check failed ({status})"));
                }
                Ok(String::from_utf8_lossy(&stdout).to_string())
            })
            .await
            .unwrap_or_else(|_| Err("CUDA compatibility check timed out".into()));
            if child.id().is_some() {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
                let _ = child.wait().await;
            }
            if let Some(path) = identity {
                let _ = std::fs::remove_file(path);
            }
            result
        }
        .await;
        build["checks"]["driver_version"] = json!(driver);
        match checked {
            Ok(devices) => {
                build["checks"]["driver_compatibility"] = json!("passed");
                build["checks"]["devices"] = json!(devices);
                build["checks"]["compatibility_error"] = Value::Null;
            }
            Err(error) => {
                build["checks"]["driver_compatibility"] = json!("failed");
                build["checks"]["compatibility_error"] = json!(error);
            }
        }
        operations::save(db, "builds", &id, &build).await?;
    }
    Ok(())
}

pub(crate) async fn delete(
    Extension(directory): Extension<Directory>,
    Extension(db): Extension<DatabaseConnection>,
    Extension(runtime): Extension<crate::runtime::Runtime>,
    axum::extract::Path(id): axum::extract::Path<String>,
    headers: HeaderMap,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    use sea_orm::{ConnectionTrait, DbBackend, Statement};
    let key = commands::key(&headers)?;
    let action = format!("DELETE /builds/{id}");
    let tx = db.begin().await?;
    if let Some(response) = commands::replay(&tx, &key, &action, &json!({})).await? {
        tx.commit().await?;
        return Ok((StatusCode::ACCEPTED, Json(response)));
    }
    let build = operations::find(&tx, "builds", &id).await?;
    let snapshot = runtime.0.lock().await;
    let busy = operations::all(&tx, "operations").await?.iter().any(|o| {
        o["resource_id"] == id && matches!(o["status"].as_str(), Some("running" | "queued"))
    });
    if build["current"] == true
        || build["previous"] == true
        || build["status"] == "building"
        || snapshot["current_build_id"] == id
        || busy
    {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "state_conflict",
            "Build is current, previous, or in use".into(),
        ));
    }
    let path = directory.0.parent().unwrap().join("data/builds").join(&id);
    let mut removal = crate::file_removal::FileRemoval::new(directory.0.parent().unwrap(), &key)?;
    removal.stage(&path)?;
    tx.execute(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "DELETE FROM builds WHERE id=?",
        [id.clone().into()],
    ))
    .await?;
    let operation_id = uuid::Uuid::new_v4().to_string();
    let time = chrono::Utc::now().to_rfc3339();
    operations::save(&tx,"operations",&operation_id,&json!({"id":operation_id,"type":"build_delete","status":"succeeded","phase":"completed","resource_id":id,"created_at":time,"updated_at":time,"progress":null,"error":null,"allowed_actions":[]})).await?;
    let response = json!({"operation_id":operation_id});
    commands::remember(&tx, &key, &action, &json!({}), &response).await?;
    tx.commit().await?;
    removal.finish();
    Ok((StatusCode::ACCEPTED, Json(response)))
}

pub(crate) fn prepare_if_missing(
    directory: Directory,
    db: DatabaseConnection,
    runtime: crate::runtime::Runtime,
) {
    if std::env::var("CORE_AUTO_BUILD").as_deref() == Ok("0") {
        return;
    }
    tokio::spawn(async move {
        loop {
            if runtime.4.load(std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            if runtime.0.lock().await["state"] == "empty" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        let root = directory.0.parent().unwrap();
        let commit = tokio::process::Command::new("git")
            .arg("-C")
            .arg(root.join("vendor/llama.cpp"))
            .args(["rev-parse", "HEAD"])
            .output()
            .await
            .ok()
            .filter(|r| r.status.success())
            .map(|r| String::from_utf8_lossy(&r.stdout).trim().to_string());
        let builds = operations::all(&db, "builds").await.unwrap_or_default();
        if builds.iter().any(|b| {
            b["status"] == "ready"
                && commit
                    .as_ref()
                    .is_some_and(|commit| b["commit"] == commit.as_str())
                && root
                    .join("data/builds")
                    .join(b["id"].as_str().unwrap())
                    .join("bin/llama-server")
                    .is_file()
        }) {
            return;
        }
        let Ok(settings) = crate::settings::read(Extension(db.clone())).await else {
            return;
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            "Idempotency-Key",
            format!("automatic-build-{}", uuid::Uuid::new_v4())
                .parse()
                .unwrap(),
        );
        loop {
            if runtime.4.load(std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            if runtime.0.lock().await["state"] == "empty" {
                let result = accept_build(
                    directory.clone(),
                    db.clone(),
                    runtime.clone(),
                    headers.clone(),
                    json!({"profile":"cuda","jobs":settings.0["compiler_jobs"],"clean":false}),
                    true,
                )
                .await;
                if result.is_ok() {
                    return;
                }
                // A concurrent manual build satisfies the need to prepare an artifact.
                if operations::all(&db, "operations")
                    .await
                    .unwrap_or_default()
                    .iter()
                    .any(|op| op["type"] == "build" && op["status"] == "running")
                {
                    return;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    });
}
