use axum::{Extension, Json};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Clone)]
pub(crate) struct Runtime(
    pub Arc<Mutex<Value>>,
    pub Arc<Mutex<Option<crate::router::RouterProcess>>>,
    pub Arc<std::sync::atomic::AtomicU64>,
    pub Arc<tokio::sync::watch::Sender<u64>>,
    pub Arc<std::sync::atomic::AtomicBool>,
);
impl Runtime {
    pub fn new() -> Self {
        Self(
            Arc::new(Mutex::new(json!({
                "session_id": uuid::Uuid::new_v4().to_string(), "state": "empty", "active_instance": null,
                "target": null, "current_operation_id": null, "current_build_id": null,
                "last_selected_preset_id": null, "inflight_requests": 0, "recovery": [], "revision": 1
            }))),
            Arc::new(Mutex::new(None)),
            Arc::new(std::sync::atomic::AtomicU64::new(0)),
            Arc::new(tokio::sync::watch::channel(0).0),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
        )
    }
}
pub(crate) async fn snapshot(Extension(runtime): Extension<Runtime>) -> Json<Value> {
    let mut snapshot = runtime.0.lock().await.clone();
    snapshot["inflight_requests"] = json!(runtime.2.load(std::sync::atomic::Ordering::SeqCst));
    Json(snapshot)
}

pub(crate) async fn switch(
    Extension(runtime): Extension<Runtime>,
    Extension(directory): Extension<crate::presets::Directory>,
    Extension(db): Extension<sea_orm::DatabaseConnection>,
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> Result<(axum::http::StatusCode, Json<Value>), crate::settings::ApiError> {
    use crate::{commands, operations, settings::ApiError};
    use axum::http::StatusCode;
    use sea_orm::{ConnectionTrait, DbBackend, Statement, TransactionTrait};
    let key = commands::key(&headers)?;
    let tx = db.begin().await?;
    if let Some(response) = commands::replay(&tx, &key, "POST /runtime/switch", &body).await? {
        tx.commit().await?;
        return Ok((StatusCode::ACCEPTED, Json(response)));
    }
    let unload = body.get("preset_id") == Some(&Value::Null);
    let name = if unload {
        String::new()
    } else {
        body["preset_id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                ApiError(
                    StatusCode::BAD_REQUEST,
                    "invalid_request",
                    "A preset_id or null is required".into(),
                )
            })?
            .to_string()
    };
    let revision = if unload {
        String::new()
    } else {
        body["preset_revision"]
            .as_str()
            .ok_or_else(|| {
                ApiError(
                    StatusCode::BAD_REQUEST,
                    "invalid_request",
                    "A preset_revision is required".into(),
                )
            })?
            .to_string()
    };
    let (ini, model_set_id) = if unload {
        ("version = 1\n".to_string(), String::new())
    } else {
        crate::presets::compile_target(&directory.0, &name, &revision)?
    };
    let model_set_id = crate::presets::model_set_for(
        &directory.0,
        &operations::all(&tx, "model_sets").await?,
        &ini,
    )
    .unwrap_or(model_set_id);
    let settings = tx
        .query_one(Statement::from_string(
            DbBackend::Sqlite,
            "SELECT body FROM settings WHERE id=1",
        ))
        .await?
        .unwrap();
    let settings: String = settings.try_get("", "body")?;
    let settings: Value = serde_json::from_str(&settings).unwrap();
    let timeout_ms = settings["drain_timeout_ms"].as_u64().unwrap();
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
    let build_id = snapshot["current_build_id"]
        .as_str()
        .ok_or_else(|| {
            ApiError(
                StatusCode::CONFLICT,
                "state_conflict",
                "Apply a checked build first".into(),
            )
        })?
        .to_string();
    if operations::find(&tx, "builds", &build_id).await?["checks"]["driver_compatibility"]
        == "failed"
    {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "state_conflict",
            "The current build is incompatible with the detected driver; apply a checked build"
                .into(),
        ));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let mut operation = json!({"id":id,"type":"runtime_switch","status":"running","phase":"waiting","resource_id":name,"created_at":chrono::Utc::now().to_rfc3339(),"updated_at":chrono::Utc::now().to_rfc3339(),"progress":null,"error":null,"allowed_actions":["cancel","force"]});
    operations::save(&tx, "operations", &id, &operation).await?;
    let response = json!({"operation_id":id});
    commands::remember(&tx, &key, "POST /runtime/switch", &body, &response).await?;
    if !unload {
        operations::save(
            &tx,
            "runtime_preferences",
            "selection",
            &json!({"preset_id":name}),
        )
        .await?;
    }
    tx.commit().await?;
    snapshot["state"] = json!("waiting");
    snapshot["target"] = body.clone();
    snapshot["current_operation_id"] = json!(id);
    if !unload {
        snapshot["last_selected_preset_id"] = json!(name);
    }
    drop(snapshot);
    tokio::spawn(async move {
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
            let transition = db.begin().await.map_err(|e| e.to_string())?;
            let mut saved = operations::find(&transition, "operations", &id)
                .await
                .map_err(|e| e.2)?;
            if saved["cancel_requested"] == true {
                return Err("cancelled_waiting".to_string());
            }
            saved["phase"] = json!("unloading");
            saved["allowed_actions"] = json!(["cancel"]);
            let mut state = runtime.0.lock().await;
            operations::save(&transition, "operations", &id, &saved)
                .await
                .map_err(|e| e.2)?;
            transition.commit().await.map_err(|e| e.to_string())?;
            state["state"] = json!("unloading");
            drop(state);
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
            let tx = db.begin().await.map_err(|e| e.to_string())?;
            let mut latest = operations::find(&tx, "operations", &id)
                .await
                .map_err(|e| e.2)?;
            latest["phase"] = json!("loading");
            operations::save(&tx, "operations", &id, &latest)
                .await
                .map_err(|e| e.2)?;
            runtime.0.lock().await["state"] = json!("loading");
            tx.commit().await.map_err(|e| e.to_string())?;
            operation["phase"] = json!("loading");
            let root = directory.0.parent().unwrap();
            let path = root.join("data/generated").join(format!("{id}.ini"));
            std::fs::write(&path, ini).map_err(|e| e.to_string())?;
            let router = crate::router::RouterProcess::start(root, &build_id, &path).await?;
            if operations::find(&db, "operations", &id)
                .await
                .map_err(|e| e.2)?["cancel_requested"]
                == true
            {
                router.stop().await?;
                return Err("cancelled_after_stop".to_string());
            }
            if unload {
                return Ok::<_, String>(router);
            }
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .map_err(|e| e.to_string())?;
            let load = client
                .post(format!("{}/models/load", router.url))
                .json(&json!({"model":name}))
                .send()
                .await
                .and_then(reqwest::Response::error_for_status);
            if let Err(error) = load {
                router.stop().await?;
                return Err(error.to_string());
            }
            let readiness = tokio::time::timeout(std::time::Duration::from_secs(300), async {
                loop {
                    if operations::find(&db, "operations", &id)
                        .await
                        .map_err(|e| e.2)?["cancel_requested"]
                        == true
                    {
                        return Err("cancelled_after_stop".to_string());
                    }
                    let models: Value = client
                        .get(format!("{}/models", router.url))
                        .send()
                        .await
                        .map_err(|e| e.to_string())?
                        .json()
                        .await
                        .map_err(|e| e.to_string())?;
                    if models["data"].as_array().is_some_and(|models| {
                        models
                            .iter()
                            .any(|m| m["id"] == name && m["status"]["value"] == "loaded")
                    }) {
                        return Ok::<_, String>(());
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                }
            })
            .await
            .unwrap_or_else(|_| Err("Model readiness timed out".to_string()));
            if let Err(message) = readiness {
                router.stop().await?;
                return Err(message);
            }
            Ok::<_, String>(router)
        }
        .await;
        let tx = match db.begin().await {
            Ok(tx) => tx,
            Err(error) => {
                if let Ok(router) = result {
                    let _ = router.stop().await;
                }
                let mut state = runtime.0.lock().await;
                state["state"] = json!("error");
                state["error"] = json!({"code":"storage_error","message":error.to_string(),"retryable":true,"details":null});
                return;
            }
        };
        let latest = operations::find(&tx, "operations", &id)
            .await
            .unwrap_or_else(|_| operation.clone());
        let result = match result {
            Ok(router) if latest["cancel_requested"] == true => match router.stop().await {
                Ok(()) => Err("cancelled_after_stop".to_string()),
                Err(error) => Err(error),
            },
            result => result,
        };
        let mut snapshot = runtime.0.lock().await;
        match result {
            Ok(router) => {
                let instance_id = router.instance_id.clone();
                *runtime.1.lock().await = Some(router);
                snapshot["state"] = json!(if unload { "empty" } else { "ready" });
                snapshot["active_instance"] = json!({"id":instance_id,"model_set_id":model_set_id,"preset_id":name,"applied_preset_revision":revision,"build_id":build_id,"started_at":chrono::Utc::now().to_rfc3339(),"ready_at":chrono::Utc::now().to_rfc3339(),"status":"ready"});
                if unload {
                    snapshot["active_instance"] = Value::Null;
                }
                operation["status"] = json!("succeeded");
                operation["phase"] = json!("completed");
            }
            Err(message) if message == "cancelled_after_stop" => {
                snapshot["state"] = json!("empty");
                snapshot["active_instance"] = Value::Null;
                operation["status"] = json!("cancelled");
            }
            Err(message) if message == "cancelled_waiting" => {
                snapshot["state"] = json!(if snapshot["active_instance"].is_null() {
                    "empty"
                } else {
                    "ready"
                });
                operation["status"] = json!("cancelled");
            }
            Err(message) if message == "drain_timeout" => {
                snapshot["state"] = json!(if snapshot["active_instance"].is_null() {
                    "empty"
                } else {
                    "ready"
                });
                operation["status"] = json!("failed");
                operation["error"] = json!({"code":"drain_timeout","message":"Accepted requests did not finish before the drain timeout","retryable":true,"details":null});
            }
            Err(message) => {
                snapshot["state"] = json!("error");
                snapshot["active_instance"] = Value::Null;
                operation["status"] = json!("failed");
                operation["error"] =
                    json!({"code":"load_failed","message":message,"retryable":true,"details":null});
            }
        }
        snapshot["target"] = Value::Null;
        snapshot["current_operation_id"] = Value::Null;
        operation["allowed_actions"] = json!([]);
        operation["updated_at"] = json!(chrono::Utc::now().to_rfc3339());
        snapshot["revision"] = json!(snapshot["revision"].as_u64().unwrap_or(0) + 1);
        snapshot["error"] = operation["error"].clone();
        let saved = operations::save(&tx, "operations", &id, &operation).await;
        let committed = if saved.is_ok() {
            tx.commit().await.map_err(|e| e.to_string())
        } else {
            Err("Cannot persist operation result".into())
        };
        if let Err(error) = committed {
            if let Some(router) = runtime.1.lock().await.take() {
                let _ = router.stop().await;
            }
            snapshot["state"] = json!("error");
            snapshot["active_instance"] = Value::Null;
            snapshot["error"] =
                json!({"code":"storage_error","message":error,"retryable":true,"details":null});
        }
    });
    Ok((StatusCode::ACCEPTED, Json(response)))
}

pub(crate) fn monitor(runtime: Runtime, root: std::path::PathBuf) {
    let state = Arc::downgrade(&runtime.0);
    let routers = Arc::downgrade(&runtime.1);
    let stopping = runtime.4.clone();
    drop(runtime);
    tokio::spawn(async move {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(1))
            .build()
            .expect("local health client");
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let (Some(state), Some(routers)) = (state.upgrade(), routers.upgrade()) else {
                break;
            };
            let captured = {
                let mut snapshot = state.lock().await;
                if snapshot["state"] == "recovery_required"
                    && !stopping.load(std::sync::atomic::Ordering::SeqCst)
                {
                    let recovery = crate::processes::recovery(&root);
                    if recovery.is_empty() {
                        snapshot["state"] = json!("empty");
                    }
                    if snapshot["recovery"] != json!(recovery) {
                        snapshot["recovery"] = json!(recovery);
                        snapshot["revision"] =
                            json!(snapshot["revision"].as_u64().unwrap_or(0) + 1);
                    }
                    continue;
                }
                if !snapshot["current_operation_id"].is_null() {
                    continue;
                }
                let mut router = routers.lock().await;
                if router.as_ref().is_some_and(|r| r.exited()) {
                    snapshot["state"] = json!("error");
                    snapshot["active_instance"] = Value::Null;
                    snapshot["error"] = json!({"code":"router_exited","message":"Router exited; model was not restarted","retryable":true,"details":null});
                    if let Some(process) = router.take() {
                        let _ = process.stop().await;
                    }
                    None
                } else if snapshot["state"] == "ready" {
                    router
                        .as_ref()
                        .map(|router| (router.url.clone(), snapshot["active_instance"].clone()))
                } else {
                    None
                }
            };
            let Some((url, instance)) = captured else {
                continue;
            };
            let Ok(response) = client.get(format!("{url}/models")).send().await else {
                continue;
            };
            let Ok(models) = response.json::<Value>().await else {
                continue;
            };
            let stopped = models["data"].as_array().is_some_and(|models| {
                models.iter().any(|model| {
                    model["id"] == instance["preset_id"] && model["status"]["value"] == "unloaded"
                })
            });
            if stopped {
                let mut snapshot = state.lock().await;
                if snapshot["state"] == "ready"
                    && snapshot["active_instance"]["id"] == instance["id"]
                    && snapshot["current_operation_id"].is_null()
                {
                    snapshot["state"] = json!("error");
                    snapshot["active_instance"] = Value::Null;
                    snapshot["error"] = json!({"code":"model_exited","message":"Model process exited; it was not restarted","retryable":true,"details":null});
                    if let Some(process) = routers.lock().await.take() {
                        let _ = process.stop().await;
                    }
                }
            }
        }
    });
}
