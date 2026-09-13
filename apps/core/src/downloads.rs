use crate::{
    commands,
    hub::Hub,
    operations,
    presets::{Directory, revision},
    settings::ApiError,
};
use axum::{
    Extension, Json,
    http::{HeaderMap, StatusCode},
};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement, TransactionTrait};
use serde_json::{Value, json};
use std::collections::HashMap;

pub(crate) async fn list(
    Extension(db): Extension<DatabaseConnection>,
    Extension(directory): Extension<Directory>,
) -> Result<Json<Value>, ApiError> {
    let mut sets = operations::all(&db, "model_sets").await?;
    for set in &mut sets {
        let preview = reference_preview(&db, &directory, set["id"].as_str().unwrap()).await?;
        set["preset_ids"] = preview["preset_ids"].clone();
        let mut missing = false;
        for file in set["files"].as_array_mut().unwrap() {
            if file["availability"] == "available" {
                let path = directory
                    .0
                    .parent()
                    .unwrap()
                    .join("data/models")
                    .join(file["local_path"].as_str().unwrap());
                if !std::fs::metadata(path).is_ok_and(|m| {
                    m.is_file()
                        && file["size_bytes"]
                            .as_u64()
                            .is_none_or(|size| m.len() == size)
                }) {
                    file["availability"] = json!("missing");
                    file["downloaded_bytes"] = json!(0);
                    missing = true;
                }
            }
        }
        if missing {
            set["availability"] = json!("missing");
        }
    }
    Ok(Json(json!({"model_sets":sets})))
}
pub(crate) async fn create(
    Extension(db): Extension<DatabaseConnection>,
    Extension(hub): Extension<Hub>,
    Extension(directory): Extension<Directory>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let key = commands::key(&headers)?;
    let prior = db.begin().await?;
    let replay = commands::replay(&prior, &key, "POST /downloads", &body).await?;
    prior.commit().await?;
    if let Some(response) = replay {
        return Ok((StatusCode::ACCEPTED, Json(response)));
    }
    let commit = body["commit"]
        .as_str()
        .filter(|s| s.len() == 40 && s.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| {
            ApiError(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "Select an exact commit".into(),
            )
        })?;
    let repo = body["repo_id"].as_str().ok_or_else(|| {
        ApiError(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "repo_id is required".into(),
        )
    })?;
    let requested = body["files"]
        .as_array()
        .filter(|f| !f.is_empty())
        .ok_or_else(|| {
            ApiError(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "Select model files".into(),
            )
        })?;
    let metadata = crate::hub::files(
        Extension(hub.clone()),
        axum::extract::Query(HashMap::from([
            ("repo".into(), repo.into()),
            ("revision".into(), commit.into()),
        ])),
    )
    .await?
    .0;
    let mut files = vec![];
    for selection in requested {
        let path = selection["path"]
            .as_str()
            .filter(|path| {
                !path.starts_with('/')
                    && path.split('/').all(|part| !matches!(part, "" | "." | ".."))
            })
            .ok_or_else(|| {
                ApiError(
                    StatusCode::BAD_REQUEST,
                    "invalid_request",
                    "Invalid model path".into(),
                )
            })?;
        let found = metadata["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["path"] == path && f["role"] == selection["role"])
            .ok_or_else(|| {
                ApiError(
                    StatusCode::BAD_REQUEST,
                    "invalid_request",
                    "File is not in the selected revision".into(),
                )
            })?;
        let id = revision(&json!([repo, commit, path]).to_string());
        let mut url = reqwest::Url::parse(&hub.endpoint()).map_err(|_| {
            ApiError(
                StatusCode::BAD_GATEWAY,
                "invalid_metadata",
                "Invalid Hub endpoint".into(),
            )
        })?;
        url.path_segments_mut()
            .map_err(|_| {
                ApiError(
                    StatusCode::BAD_GATEWAY,
                    "invalid_metadata",
                    "Invalid Hub endpoint".into(),
                )
            })?
            .extend(repo.split('/'))
            .extend(["resolve", commit])
            .extend(path.split('/'));
        files.push(json!({"id":id,"path":path,"role":found["role"],"size_bytes":found["size_bytes"],"downloaded_bytes":0,"availability":"downloading","url":url.as_str(),"local_path":format!("{}/{path}",revision(&json!([repo,commit]).to_string()))}));
    }
    files.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    files.dedup_by(|a, b| a["id"] == b["id"]);
    validate_selection(&files)?;
    let set_id = revision(
        &json!([
            repo,
            commit,
            files.iter().map(|f| &f["path"]).collect::<Vec<_>>()
        ])
        .to_string(),
    );
    let tx = db.begin().await?;
    if let Some(response) = commands::replay(&tx, &key, "POST /downloads", &body).await? {
        tx.commit().await?;
        return Ok((StatusCode::ACCEPTED, Json(response)));
    }
    if let Ok(existing) = operations::find(&tx, "model_sets", &set_id).await
        && let Some(previous_id) = existing["download_operation_id"].as_str()
    {
        let previous = operations::find(&tx, "operations", previous_id).await?;
        let missing = existing["files"].as_array().unwrap().iter().any(|file| {
            let path = directory
                .0
                .parent()
                .unwrap()
                .join("data/models")
                .join(file["local_path"].as_str().unwrap());
            !std::fs::metadata(path).is_ok_and(|metadata| {
                metadata.is_file()
                    && file["size_bytes"]
                        .as_u64()
                        .is_none_or(|size| size == metadata.len())
            })
        });
        if previous["status"] != "cancelled" && !(previous["status"] == "succeeded" && missing) {
            let response =
                json!({"operation_id":existing["download_operation_id"],"model_set_id":set_id});
            commands::remember(&tx, &key, "POST /downloads", &body, &response).await?;
            tx.commit().await?;
            return Ok((StatusCode::ACCEPTED, Json(response)));
        }
    }
    for file in &mut files {
        if let Ok(saved) = operations::find(&tx, "model_files", file["id"].as_str().unwrap()).await
        {
            file["local_path"] = saved["local_path"].clone();
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let set = json!({"id":set_id,"repo_id":repo,"commit":commit,"files":files,"availability":"downloading","download_operation_id":id,"preset_ids":[]});
    for file in &files {
        let file_id = file["id"].as_str().unwrap();
        tx.execute(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            "INSERT OR IGNORE INTO model_files(id,body) VALUES(?,?)",
            [file_id.into(), file.to_string().into()],
        ))
        .await?;
        tx.execute(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            "INSERT OR IGNORE INTO model_set_files(model_set_id,file_id) VALUES(?,?)",
            [set_id.clone().into(), file_id.into()],
        ))
        .await?;
    }
    operations::save(&tx, "model_sets", &set_id, &set).await?;
    operations::save(&tx,"operations",&id,&json!({"id":id,"type":"download","status":"queued","phase":"queued","queued_at":chrono::Utc::now().timestamp_micros(),"resource_id":set_id,"created_at":chrono::Utc::now().to_rfc3339(),"updated_at":chrono::Utc::now().to_rfc3339(),"progress":null,"error":null,"allowed_actions":["pause","cancel"]})).await?;
    let response = json!({"operation_id":id,"model_set_id":set_id});
    commands::remember(&tx, &key, "POST /downloads", &body, &response).await?;
    tx.commit().await?;
    Ok((StatusCode::ACCEPTED, Json(response)))
}

pub(crate) fn start_queue(
    directory: Directory,
    db: DatabaseConnection,
    runtime: crate::runtime::Runtime,
) {
    tokio::spawn(async move {
        loop {
            if runtime.4.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }
            if runtime.0.lock().await["state"] == "recovery_required" {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                continue;
            }
            let mut queue = operations::all(&db, "operations").await.unwrap_or_default();
            queue.sort_by_key(|o| o["queued_at"].as_i64().unwrap_or(0));
            if let Some(mut operation) = queue
                .into_iter()
                .find(|o| o["type"] == "download" && o["status"] == "queued")
            {
                let id = operation["id"].as_str().unwrap().to_string();
                let set_id = operation["resource_id"].as_str().unwrap().to_string();
                let result = transfer(directory.0.parent().unwrap(), &db, &mut operation).await;
                let mut set = match operations::find(&db, "model_sets", &set_id).await {
                    Ok(set) => set,
                    Err(_) => continue,
                };
                match result {
                    Ok(()) => continue,
                    Err(message) if message == "skipped" => continue,
                    Err(message) if message == "cancelled" => {
                        operation["status"] = json!("cancelled");
                        operation["phase"] = json!("cancelled");
                        set["availability"] = json!("missing");
                    }
                    Err(message) if message == "paused" => {
                        operation["status"] = json!("paused");
                        operation["phase"] = json!("paused");
                    }
                    Err(message) => {
                        operation["status"] = json!("failed");
                        operation["error"] = json!({"code":"download_failed","message":message,"retryable":true,"details":null});
                        set["availability"] = json!("failed");
                    }
                }
                operation["allowed_actions"] =
                    if matches!(operation["status"].as_str(), Some("paused" | "failed")) {
                        json!(["resume", "cancel", "restart-file"])
                    } else {
                        json!([])
                    };
                let _ = operations::save(&db, "model_sets", &set_id, &set).await;
                let _ = operations::save(&db, "operations", &id, &operation).await;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    });
}

async fn transfer(
    root: &std::path::Path,
    db: &DatabaseConnection,
    operation: &mut Value,
) -> Result<(), String> {
    let id = operation["id"].as_str().unwrap().to_string();
    let mut set = operations::find(db, "model_sets", operation["resource_id"].as_str().unwrap())
        .await
        .map_err(|e| e.2)?;
    let claim = db.begin().await.map_err(|e| e.to_string())?;
    *operation = operations::find(&claim, "operations", &id)
        .await
        .map_err(|e| e.2)?;
    if operation["status"] != "queued" {
        return Err("skipped".into());
    }
    operation["status"] = json!("running");
    operation["phase"] = json!("running");
    operation["allowed_actions"] = json!(["pause", "cancel"]);
    operations::save(&claim, "operations", &id, operation)
        .await
        .map_err(|e| e.2)?;
    claim.commit().await.map_err(|e| e.to_string())?;
    let directory = root.join("data/downloads").join(&id);
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    for file in set["files"].as_array_mut().unwrap() {
        if let Ok(saved) = operations::find(db, "model_files", file["id"].as_str().unwrap()).await {
            let path = root
                .join("data/models")
                .join(file["local_path"].as_str().unwrap());
            if saved["availability"] == "available"
                && std::fs::metadata(&path)
                    .is_ok_and(|m| Some(m.len()) == saved["downloaded_bytes"].as_u64())
            {
                *file = saved;
                file["shared"] = json!(true);
            }
        }
    }
    let manifest = directory.join("manifest.json");
    std::fs::write(&manifest, set["files"].to_string()).map_err(|e| e.to_string())?;
    let token = uuid::Uuid::new_v4().to_string();
    let mut child = tokio::process::Command::new("/proc/self/exe")
        .arg("download-worker")
        .arg(&manifest)
        .env("DAEVOX_PROCESS_TOKEN", &token)
        .process_group(0)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    let identity = crate::processes::record(root, child.id().ok_or("Worker exited")?, &token)?;
    let initial_bytes: u64 = set["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            if f["shared"] == true {
                f["downloaded_bytes"].as_u64().unwrap_or(0)
            } else {
                std::fs::metadata(directory.join(format!("{}.partial", f["id"].as_str().unwrap())))
                    .map(|m| m.len())
                    .unwrap_or(0)
            }
        })
        .sum();
    let started = std::time::Instant::now();
    let mut tick = tokio::time::interval(std::time::Duration::from_millis(25));
    let status = loop {
        tokio::select! {
            status = child.wait() => break status.map_err(|e| e.to_string())?,
            _ = tick.tick() => {
                *operation = operations::find(db,"operations",&id).await.map_err(|e|e.2)?;
                let done: u64 = set["files"].as_array().unwrap().iter().map(|f| if f["shared"] == true { f["downloaded_bytes"].as_u64().unwrap_or(0) } else { std::fs::metadata(directory.join(format!("{}.partial",f["id"].as_str().unwrap()))).map(|m|m.len()).unwrap_or(0) }).sum();
                let total: Option<u64> = set["files"].as_array().unwrap().iter().map(|f|f["size_bytes"].as_u64()).sum();
                operation["progress"] = json!({"bytes_done":done,"bytes_total":total,"bytes_per_second":done.saturating_sub(initial_bytes) as f64/started.elapsed().as_secs_f64().max(0.001),"percent": total.filter(|t|*t>0).map(|total|done as f64*100.0/total as f64),"file_id":null});
                operations::save(db,"operations",&id,operation).await.map_err(|e|e.2)?;
                if operation["cancel_requested"] == true {
                    child.kill().await.map_err(|e|e.to_string())?;
                    let _ = std::fs::remove_file(&identity);
                    std::fs::remove_dir_all(&directory).map_err(|e|e.to_string())?;
                    return Err("cancelled".into());
                }
                if operation["pause_requested"] == true {
                    child.kill().await.map_err(|e| e.to_string())?;
                    let _ = std::fs::remove_file(&identity);
                    return Err("paused".into());
                }
            }
        }
    };
    let _ = std::fs::remove_file(identity);
    if !status.success() {
        use tokio::io::AsyncReadExt;
        let mut message = vec![];
        if let Some(stderr) = child.stderr.take() {
            let _ = stderr.take(4096).read_to_end(&mut message).await;
        }
        return Err(format!(
            "Download worker failed: {}",
            String::from_utf8_lossy(&message)
        ));
    }
    let publish = db.begin().await.map_err(|e| e.to_string())?;
    *operation = operations::find(&publish, "operations", &id)
        .await
        .map_err(|e| e.2)?;
    if operation["cancel_requested"] == true {
        return Err("cancelled".into());
    }
    if operation["pause_requested"] == true {
        return Err("paused".into());
    }
    let mut links = PublicationLinks(Vec::new());
    for file in set["files"].as_array_mut().unwrap() {
        if file["shared"] != true {
            let partial = directory.join(format!("{}.partial", file["id"].as_str().unwrap()));
            let destination = root
                .join("data/models")
                .join(file["local_path"].as_str().unwrap());
            std::fs::create_dir_all(destination.parent().unwrap()).map_err(|e| e.to_string())?;
            if !same_file(&partial, &destination) {
                // hard_link fails if the destination exists: no existing artifact is replaced.
                std::fs::hard_link(&partial, &destination).map_err(|e| e.to_string())?;
                links.0.push((partial.clone(), destination.clone()));
            }
            std::fs::File::open(destination.parent().unwrap())
                .and_then(|f| f.sync_all())
                .map_err(|e| e.to_string())?;
            file["size_bytes"] = json!(
                std::fs::metadata(&partial)
                    .map_err(|e| e.to_string())?
                    .len()
            );
        }
        file["availability"] = json!("available");
        file["downloaded_bytes"] = file["size_bytes"].clone();
        operations::save(&publish, "model_files", file["id"].as_str().unwrap(), file)
            .await
            .map_err(|e| e.2)?;
    }
    set["availability"] = json!("available");
    operations::save(&publish, "model_sets", set["id"].as_str().unwrap(), &set)
        .await
        .map_err(|e| e.2)?;
    let total: u64 = set["files"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|f| f["size_bytes"].as_u64())
        .sum();
    operation["status"] = json!("succeeded");
    operation["phase"] = json!("completed");
    operation["allowed_actions"] = json!([]);
    operation["progress"] = json!({"bytes_done":total,"bytes_total":total,"bytes_per_second":null,"percent":100,"file_id":null});
    operations::save(&publish, "operations", &id, operation)
        .await
        .map_err(|e| e.2)?;
    publish.commit().await.map_err(|e| e.to_string())?;
    links.0.clear();
    cleanup_published(root, &id, &set);
    Ok(())
}

pub(crate) async fn control(
    Extension(db): Extension<DatabaseConnection>,
    Extension(directory): Extension<Directory>,
    axum::extract::Path((id, action)): axum::extract::Path<(String, String)>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if !matches!(
        action.as_str(),
        "pause" | "resume" | "cancel" | "restart-file"
    ) {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "unknown_resource",
            "Unknown download action".into(),
        ));
    }
    let body = body.map(|b| b.0).unwrap_or_else(|| json!({}));
    let key = commands::key(&headers)?;
    let command = format!("POST /downloads/{id}/{action}");
    let tx = db.begin().await?;
    if let Some(response) = commands::replay(&tx, &key, &command, &body).await? {
        tx.commit().await?;
        return Ok((StatusCode::ACCEPTED, Json(response)));
    }
    let mut op = operations::find(&tx, "operations", &id).await?;
    if op["type"] != "download" {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "state_conflict",
            "This is not a download".into(),
        ));
    }
    match action.as_str() {
        "restart-file" if matches!(op["status"].as_str(), Some("paused" | "failed")) => {
            let set =
                operations::find(&tx, "model_sets", op["resource_id"].as_str().unwrap()).await?;
            let file_id = body["file_id"].as_str().ok_or_else(|| {
                ApiError(
                    StatusCode::BAD_REQUEST,
                    "invalid_request",
                    "file_id is required".into(),
                )
            })?;
            if !set["files"]
                .as_array()
                .unwrap()
                .iter()
                .any(|f| f["id"] == file_id && f["availability"] != "available")
            {
                return Err(ApiError(
                    StatusCode::CONFLICT,
                    "state_conflict",
                    "Only an unfinished file belonging to this download may be restarted".into(),
                ));
            }
            let partial = directory
                .0
                .parent()
                .unwrap()
                .join("data/downloads")
                .join(&id);
            for suffix in ["partial", "identity.json", "completed.json"] {
                let path = partial.join(format!("{file_id}.{suffix}"));
                if path.exists() {
                    std::fs::remove_file(path)?;
                }
            }
            op["status"] = json!("queued");
            op["phase"] = json!("queued");
            op["pause_requested"] = json!(false);
            op["cancel_requested"] = json!(false);
            op["error"] = Value::Null;
            op["queued_at"] = json!(chrono::Utc::now().timestamp_micros());
        }
        "cancel" if op["status"] == "running" => {
            op["cancel_requested"] = json!(true);
            op["phase"] = json!("cancelling");
        }
        "cancel" if matches!(op["status"].as_str(), Some("queued" | "paused" | "failed")) => {
            let partial = directory
                .0
                .parent()
                .unwrap()
                .join("data/downloads")
                .join(&id);
            if partial.exists() {
                std::fs::remove_dir_all(partial)?;
            }
            op["status"] = json!("cancelled");
            op["phase"] = json!("cancelled");
            op["allowed_actions"] = json!([]);
        }
        "pause" if op["status"] == "running" => {
            op["pause_requested"] = json!(true);
            op["phase"] = json!("pausing");
        }
        "pause" if op["status"] == "queued" => {
            op["status"] = json!("paused");
            op["phase"] = json!("paused");
        }
        "resume" if matches!(op["status"].as_str(), Some("paused" | "failed")) => {
            op["status"] = json!("queued");
            op["phase"] = json!("queued");
            op["pause_requested"] = json!(false);
            op["error"] = Value::Null;
            op["queued_at"] = json!(chrono::Utc::now().timestamp_micros());
        }
        _ => {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "state_conflict",
                "Download action is unavailable in this state".into(),
            ));
        }
    }
    op["allowed_actions"] = match op["status"].as_str() {
        Some("queued" | "running") => json!(["pause", "cancel"]),
        Some("paused" | "failed") => json!(["resume", "cancel", "restart-file"]),
        _ => json!([]),
    };
    operations::save(&tx, "operations", &id, &op).await?;
    let response = json!({"operation_id":id});
    commands::remember(&tx, &key, &command, &body, &response).await?;
    tx.commit().await?;
    Ok((StatusCode::ACCEPTED, Json(response)))
}

async fn reference_preview<C: ConnectionTrait>(
    db: &C,
    directory: &Directory,
    id: &str,
) -> Result<Value, ApiError> {
    let set = operations::find(db, "model_sets", id).await?;
    let sets = operations::all(db, "model_sets").await?;
    let root = directory.0.parent().unwrap();
    let mut presets = std::collections::BTreeSet::new();
    let mut sources = std::collections::BTreeMap::new();
    let local_files: Vec<_> = set["files"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|f| f["local_path"].as_str())
        .map(|p| root.join("data/models").join(p))
        .collect();
    for entry in std::fs::read_dir(&directory.0)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() || !entry.path().extension().is_some_and(|e| e == "ini") {
            continue;
        }
        let text = std::fs::read_to_string(entry.path())?;
        sources.insert(
            entry.file_name().to_string_lossy().to_string(),
            revision(&text),
        );
        let parsed = crate::ini::parse(&text);
        for (name, options) in &parsed.sections {
            if name == "*" {
                continue;
            }
            let mut effective = parsed.sections.get("*").cloned().unwrap_or_default();
            effective.extend(options.clone());
            for key in ["model", "mmproj"] {
                if let Some(value) = effective.get(key) {
                    let candidate = directory.0.join(value);
                    let candidate = candidate.canonicalize().unwrap_or(candidate);
                    if local_files
                        .iter()
                        .any(|f| f.canonicalize().unwrap_or(f.clone()) == candidate)
                    {
                        presets.insert(name.clone());
                    }
                }
            }
        }
    }
    let files: Vec<_> = set["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| {
            let shared: Vec<_> = sets
                .iter()
                .filter(|s| {
                    s["id"] != id
                        && s["files"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|f| f["id"] == file["id"])
                })
                .map(|s| s["id"].clone())
                .collect();
            json!({"file_id":file["id"],"shared_with":shared,"will_delete":shared.is_empty()})
        })
        .collect();
    let revision = revision(&json!([sets, sources]).to_string());
    Ok(json!({"model_set_id":id,"revision":revision,"preset_ids":presets,"files":files}))
}
pub(crate) async fn references(
    Extension(db): Extension<DatabaseConnection>,
    Extension(directory): Extension<Directory>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(reference_preview(&db, &directory, &id).await?))
}
pub(crate) async fn delete(
    Extension(db): Extension<DatabaseConnection>,
    Extension(directory): Extension<Directory>,
    Extension(runtime): Extension<crate::runtime::Runtime>,
    axum::extract::Path(id): axum::extract::Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let key = commands::key(&headers)?;
    let action = format!("DELETE /model-sets/{id}");
    let tx = db.begin().await?;
    if let Some(response) = commands::replay(&tx, &key, &action, &body).await? {
        tx.commit().await?;
        return Ok((StatusCode::ACCEPTED, Json(response)));
    }
    let preview = reference_preview(&tx, &directory, &id).await?;
    if !body["revision"].is_string() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "A reference preview revision is required".into(),
        ));
    }
    if body["revision"] != preview["revision"] {
        return Err(ApiError(
            StatusCode::PRECONDITION_FAILED,
            "revision_conflict",
            "References changed; preview deletion again".into(),
        ));
    }
    let set = operations::find(&tx, "model_sets", &id).await?;
    let snapshot = runtime.0.lock().await;
    let root = directory.0.parent().unwrap();
    let active = &snapshot["active_instance"];
    let used = set["files"].as_array().unwrap().iter().any(|f| {
        let path = root
            .join("data/models")
            .join(f["local_path"].as_str().unwrap());
        active["model_set_id"] == revision(&path.to_string_lossy())
    });
    let busy = operations::all(&tx, "operations").await?.iter().any(|o| {
        o["resource_id"] == id
            && matches!(o["status"].as_str(), Some("queued" | "running" | "paused"))
    });
    if used || active["model_set_id"] == id || busy || !snapshot["current_operation_id"].is_null() {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "state_conflict",
            "Model set is active, targeted, or has an unfinished download".into(),
        ));
    }
    let mut removal = crate::file_removal::FileRemoval::new(root, &key)?;
    for file in preview["files"].as_array().unwrap() {
        if file["will_delete"] == true {
            let original = set["files"]
                .as_array()
                .unwrap()
                .iter()
                .find(|f| f["id"] == file["file_id"])
                .unwrap();
            let path = root
                .join("data/models")
                .join(original["local_path"].as_str().unwrap());
            if path.is_file() {
                removal.stage(&path)?;
            }
            tx.execute(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                "DELETE FROM model_files WHERE id=?",
                [file["file_id"].as_str().unwrap().into()],
            ))
            .await?;
        }
    }
    tx.execute(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "DELETE FROM model_set_files WHERE model_set_id=?",
        [id.clone().into()],
    ))
    .await?;
    tx.execute(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "DELETE FROM model_sets WHERE id=?",
        [id.clone().into()],
    ))
    .await?;
    let operation_id = uuid::Uuid::new_v4().to_string();
    let time = chrono::Utc::now().to_rfc3339();
    operations::save(&tx,"operations",&operation_id,&json!({"id":operation_id,"type":"model_set_delete","status":"succeeded","phase":"completed","resource_id":id,"created_at":time,"updated_at":time,"progress":null,"error":null,"allowed_actions":[]})).await?;
    let response = json!({"operation_id":operation_id});
    commands::remember(&tx, &key, &action, &body, &response).await?;
    tx.commit().await?;
    removal.finish();
    Ok((StatusCode::ACCEPTED, Json(response)))
}

fn validate_selection(files: &[Value]) -> Result<(), ApiError> {
    let fail = || {
        ApiError(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Select one complete GGUF quantization and at most one matching projector".into(),
        )
    };
    if files.iter().filter(|f| f["role"] == "projector").count() > 1 {
        return Err(fail());
    }
    let weights: Vec<_> = files.iter().filter(|f| f["role"] != "projector").collect();
    if weights.len() == 1 && weights[0]["role"] == "weights" {
        return Ok(());
    }
    if weights.is_empty() || weights.iter().any(|f| f["role"] != "shard") {
        return Err(fail());
    }
    let mut group = None;
    let mut indices = std::collections::BTreeSet::new();
    let mut total = 0;
    for file in &weights {
        let path = file["path"].as_str().ok_or_else(fail)?;
        let stem = path.strip_suffix(".gguf").ok_or_else(fail)?;
        let (prefix, count) = stem.rsplit_once("-of-").ok_or_else(fail)?;
        let (base, index) = prefix.rsplit_once('-').ok_or_else(fail)?;
        if index.len() != 5 || count.len() != 5 {
            return Err(fail());
        }
        let count: usize = count.parse().map_err(|_| fail())?;
        let index: usize = index.parse().map_err(|_| fail())?;
        if count == 0 || index == 0 || index > count || group.is_some_and(|g| g != (base, count)) {
            return Err(fail());
        }
        group = Some((base, count));
        total = count;
        indices.insert(index);
    }
    if indices.len() != total {
        return Err(fail());
    }
    Ok(())
}

// Roll back only links created by this attempt. The completed worker file
// remains an independent hard link to the same inode, so its bytes survive.
struct PublicationLinks(Vec<(std::path::PathBuf, std::path::PathBuf)>);
impl Drop for PublicationLinks {
    fn drop(&mut self) {
        for (partial, destination) in &self.0 {
            if same_file(partial, destination) {
                let _ = std::fs::remove_file(destination);
            }
        }
    }
}
fn same_file(a: &std::path::Path, b: &std::path::Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::metadata(a), std::fs::metadata(b)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
        _ => false,
    }
}

fn cleanup_published(root: &std::path::Path, id: &str, set: &Value) {
    let directory = root.join("data/downloads").join(id);
    for file in set["files"].as_array().into_iter().flatten() {
        let Some(file_id) = file["id"].as_str() else {
            continue;
        };
        let Some(local) = file["local_path"].as_str() else {
            continue;
        };
        let partial = directory.join(format!("{file_id}.partial"));
        let destination = root.join("data/models").join(local);
        // Only unlink the staging name when the committed model retains the same inode.
        if same_file(&partial, &destination) {
            let _ = std::fs::remove_file(partial);
        }
        for suffix in ["identity.json", "completed.json"] {
            let _ = std::fs::remove_file(directory.join(format!("{file_id}.{suffix}")));
        }
    }
    let _ = std::fs::remove_file(directory.join("manifest.json"));
    let _ = std::fs::remove_dir(directory);
}

// Restore the filesystem side of an interrupted publication before serving readers.
pub(crate) async fn recover_publications(
    root: &std::path::Path,
    db: &DatabaseConnection,
) -> Result<(), String> {
    for operation in operations::all(db, "operations").await.map_err(|e| e.2)? {
        if operation["type"] != "download" {
            continue;
        }
        let Some(id) = operation["id"].as_str() else {
            continue;
        };
        let Some(set_id) = operation["resource_id"].as_str() else {
            continue;
        };
        let Ok(set) = operations::find(db, "model_sets", set_id).await else {
            continue;
        };
        if operation["status"] == "succeeded" {
            cleanup_published(root, id, &set);
            continue;
        }
        for file in set["files"].as_array().into_iter().flatten() {
            let Some(file_id) = file["id"].as_str() else {
                continue;
            };
            let Some(local) = file["local_path"].as_str() else {
                continue;
            };
            let committed = operations::find(db, "model_files", file_id)
                .await
                .is_ok_and(|saved| saved["availability"] == "available");
            let partial = root
                .join("data/downloads")
                .join(id)
                .join(format!("{file_id}.partial"));
            let destination = root.join("data/models").join(local);
            // The completed staging inode must still exist. Never touch a shared
            // committed artifact or another file occupying the destination name.
            if !committed && same_file(&partial, &destination) {
                std::fs::remove_file(&destination).map_err(|e| e.to_string())?;
                std::fs::File::open(destination.parent().unwrap())
                    .and_then(|f| f.sync_all())
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}
