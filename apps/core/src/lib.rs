mod access;
mod builds;
mod commands;
pub mod download_worker;
mod downloads;
mod events;
mod file_removal;
mod hub;
mod inference;
mod ini;
mod logs;
mod metrics;
mod operations;
mod presets;
mod processes;
mod router;
mod runtime;
mod source_change;
mod telemetry;
use axum::{
    Router,
    routing::{get, post},
};
use serde_json::json;

pub fn app() -> Router {
    Router::new()
        .route("/v1/models", get(inference::models))
        .route("/v1/chat/completions", post(inference::chat))
}

mod migration;
mod settings;
pub mod storage;

pub async fn app_at(root: &std::path::Path) -> Result<Router, Box<dyn std::error::Error>> {
    Ok(controlled_app(root).await?.0)
}

pub async fn controlled_app(
    root: &std::path::Path,
) -> Result<(Router, Shutdown), Box<dyn std::error::Error>> {
    let db = storage::open(root).await?;
    logs::capture(
        root,
        "core",
        json!({}),
        "event",
        std::io::Cursor::new(
            format!("{} I Core started\n", chrono::Utc::now().to_rfc3339()).into_bytes(),
        ),
    );
    let hub = hub::Hub::new(root)?;
    let runtime = runtime::Runtime::new();
    {
        let builds = operations::all(&db, "builds").await.map_err(|e| e.2)?;
        let selection = operations::all(&db, "runtime_preferences")
            .await
            .map_err(|e| e.2)?;
        let mut snapshot = runtime.0.lock().await;
        if let Some(current) = builds.iter().find(|b| b["current"] == true) {
            snapshot["current_build_id"] = current["id"].clone();
        }
        if let Some(selected) = selection.first() {
            snapshot["last_selected_preset_id"] = selected["preset_id"].clone();
        }
    }
    let recovery = processes::recovery(root);
    if recovery.is_empty() {
        builds::recheck_driver(root, &db).await.map_err(|e| e.2)?;
    }
    if !recovery.is_empty() {
        let mut snapshot = runtime.0.lock().await;
        snapshot["state"] = json!("recovery_required");
        snapshot["recovery"] = json!(recovery);
    }
    let telemetry = telemetry::Telemetry::new();
    let metrics = metrics::Metrics::start(
        runtime.0.lock().await["session_id"]
            .as_str()
            .unwrap()
            .to_string(),
        telemetry.clone(),
        root.to_path_buf(),
    );
    downloads::start_queue(
        presets::Directory(root.join("presets")),
        db.clone(),
        runtime.clone(),
    );
    builds::prepare_if_missing(
        presets::Directory(root.join("presets")),
        db.clone(),
        runtime.clone(),
    );
    runtime::monitor(runtime.clone(), root.to_path_buf());
    let events = events::Events::start(
        db.clone(),
        runtime.clone(),
        presets::Directory(root.join("presets")),
        metrics.clone(),
    )
    .await;
    let shutdown = Shutdown {
        runtime: runtime.clone(),
        db: db.clone(),
        root: root.to_path_buf(),
    };
    Ok((
        app()
            .route(
                "/openapi.json",
                get(|| async {
                    axum::Json(
                        serde_json::from_str::<serde_json::Value>(include_str!(
                            "../resources/openapi.json"
                        ))
                        .expect("compiled OpenAPI"),
                    )
                }),
            )
            .route(
                "/health",
                get(|| async { axum::Json(json!({"status":"ok"})) }),
            )
            .route("/events", get(events::subscribe))
            .route("/metrics", get(metrics::list))
            .route("/downloads/{id}/{action}", post(downloads::control))
            .route("/downloads", post(downloads::create))
            .route("/model-sets", get(downloads::list))
            .route("/model-sets/{id}/references", get(downloads::references))
            .route("/model-sets/{id}", axum::routing::delete(downloads::delete))
            .route("/hub/files", get(hub::files))
            .route("/hub/models", get(hub::search))
            .route("/runtime/switch", post(runtime::switch))
            .route("/runtime", get(runtime::snapshot))
            .route("/recovery/{id}/stop", post(processes::stop))
            .route("/logs", get(logs::list))
            .route("/logs/{id}/download", get(logs::download))
            .route("/builds/{id}/apply", post(builds::apply))
            .route("/builds/{id}", axum::routing::delete(builds::delete))
            .route("/builds", get(builds::list).post(builds::create))
            .route("/operations", get(operations::list))
            .route("/operations/{id}/force", post(operations::force))
            .route("/operations/{id}/cancel", post(operations::cancel))
            .route("/operations/{id}", get(operations::read))
            .route("/presets", get(presets::catalog))
            .route("/preset-files", post(presets::create))
            .route(
                "/preset-files/{id}",
                get(presets::read)
                    .put(presets::update)
                    .delete(presets::delete),
            )
            .layer(axum::Extension(presets::Directory(root.join("presets"))))
            .route("/settings", get(settings::read).put(settings::update))
            .layer(axum::Extension(runtime))
            .layer(axum::Extension(metrics))
            .layer(axum::Extension(telemetry))
            .layer(axum::Extension(events))
            .layer(axum::Extension(hub))
            .layer(axum::Extension(db))
            .layer(axum::middleware::from_fn(access::local_only)),
        shutdown,
    ))
}

pub struct Shutdown {
    runtime: runtime::Runtime,
    db: sea_orm::DatabaseConnection,
    root: std::path::PathBuf,
}
impl Shutdown {
    pub async fn stop(self) -> Result<(), String> {
        use std::sync::atomic::Ordering;
        self.runtime.4.store(true, Ordering::SeqCst);
        self.runtime.3.send_modify(|n| *n += 1);
        self.runtime.0.lock().await["state"] = json!("recovery_required");
        let mut interrupted = Vec::new();
        for mut op in operations::all(&self.db, "operations")
            .await
            .map_err(|e| e.2)?
        {
            if matches!(op["status"].as_str(), Some("queued" | "running")) {
                op["cancel_requested"] = json!(true);
                operations::save(&self.db, "operations", op["id"].as_str().unwrap(), &op)
                    .await
                    .map_err(|e| e.2)?;
                interrupted.push(op);
            }
        }
        // Kill by verified pidfd, discover surviving marked descendants after
        // leaders exit, and wait for their identities to disappear before success.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            processes::stop_owned(&self.root)?;
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            if processes::recovery(&self.root).is_empty() {
                break;
            }
            if std::time::Instant::now() >= deadline {
                return Err("Owned processes remain; recovery is required".into());
            }
        }
        for mut op in interrupted {
            op["status"] = json!(if op["type"] == "download" {
                "paused"
            } else {
                "interrupted"
            });
            op["phase"] = op["status"].clone();
            op["allowed_actions"] = if op["type"] == "download" {
                json!(["resume", "cancel", "restart-file"])
            } else {
                json!([])
            };
            op["cancel_requested"] = json!(false);
            op["updated_at"] = json!(chrono::Utc::now().to_rfc3339());
            operations::save(&self.db, "operations", op["id"].as_str().unwrap(), &op)
                .await
                .map_err(|e| e.2)?;
        }
        Ok(())
    }
}
