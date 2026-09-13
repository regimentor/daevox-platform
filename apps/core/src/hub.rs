use crate::settings::ApiError;
use axum::{Extension, Json, extract::Query, http::StatusCode};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{collections::HashMap, path::Path};

type Cursors = std::sync::Arc<tokio::sync::Mutex<HashMap<String, (String, usize)>>>;
#[derive(Clone)]
pub(crate) struct Hub(hf_hub::HFClient, Cursors);
impl Hub {
    pub(crate) fn endpoint(&self) -> String {
        self.0.endpoint().to_string()
    }
    pub fn new(root: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let endpoint =
            std::env::var("CORE_HUB_ENDPOINT").unwrap_or_else(|_| "https://huggingface.co".into());
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()?;
        Ok(Self(
            hf_hub::HFClient::builder()
                .endpoint(endpoint)
                .cache_dir(root.join("data/hub-cache"))
                .cache_enabled(false)
                .retry_max_attempts(1)
                .client(client)
                .build()?,
            std::sync::Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        ))
    }
}
fn failure(_: impl std::fmt::Display) -> ApiError {
    ApiError(
        StatusCode::BAD_GATEWAY,
        "hub_unavailable",
        "Public Hub metadata is unavailable".into(),
    )
}
pub(crate) async fn search(
    Extension(hub): Extension<Hub>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let (search, offset) = if let Some(cursor) = query.get("cursor") {
        let entry = hub.1.lock().await.get(cursor).cloned().ok_or_else(|| {
            ApiError(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "Search cursor expired; start the search again".into(),
            )
        })?;
        if query.get("q").is_some_and(|q| *q != entry.0) {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "Cursor belongs to a different search".into(),
            ));
        }
        entry
    } else {
        (query.get("q").cloned().unwrap_or_default(), 0)
    };
    let stream = hub
        .0
        .list_models()
        .search(&search)
        .filter("gguf")
        .limit(offset + 21)
        .send()
        .map_err(failure)?;
    futures_util::pin_mut!(stream);
    let mut models = vec![];
    let mut index = 0;
    while let Some(model) = stream.next().await {
        let model = model.map_err(failure)?;
        if index >= offset {
            models.push(serde_json::to_value(model).map_err(failure)?);
        }
        index += 1;
    }
    let cursor = if models.len() > 20 {
        models.truncate(20);
        let cursor = uuid::Uuid::new_v4().to_string();
        let mut cursors = hub.1.lock().await;
        if cursors.len() >= 1024
            && let Some(old) = cursors.keys().next().cloned()
        {
            cursors.remove(&old);
        }

        cursors.insert(cursor.clone(), (search, offset + 20));
        Some(cursor)
    } else {
        None
    };
    Ok(Json(json!({"models":models,"cursor":cursor})))
}

pub(crate) async fn files(
    Extension(hub): Extension<Hub>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let repo = query.get("repo").ok_or_else(|| {
        ApiError(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "repo is required".into(),
        )
    })?;
    let (owner, name) = repo
        .split_once('/')
        .filter(|(owner, name)| !owner.is_empty() && !name.is_empty() && !name.contains('/'))
        .ok_or_else(|| {
            ApiError(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "Use owner/repository".into(),
            )
        })?;
    let repository = hub.0.model(owner, name);
    let info = repository
        .info()
        .revision(
            query
                .get("revision")
                .cloned()
                .unwrap_or_else(|| "main".into()),
        )
        .send()
        .await
        .map_err(failure)?;
    let info = serde_json::to_value(info).map_err(failure)?;
    if info["private"] == true || !matches!(&info["gated"], Value::Null | Value::Bool(false)) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "public_models_only",
            "Private and gated models are unavailable in this version".into(),
        ));
    }
    let commit = info["sha"]
        .as_str()
        .filter(|sha| sha.len() == 40 && sha.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| {
            ApiError(
                StatusCode::BAD_GATEWAY,
                "invalid_metadata",
                "Hub did not resolve an exact commit".into(),
            )
        })?;
    let stream = repository
        .list_tree()
        .revision(commit)
        .recursive(true)
        .expand(true)
        .send()
        .map_err(failure)?;
    futures_util::pin_mut!(stream);
    let mut files = vec![];
    while let Some(entry) = stream.next().await {
        let entry = serde_json::to_value(entry.map_err(failure)?).map_err(failure)?;
        let Some(path) = entry["path"]
            .as_str()
            .filter(|path| path.to_ascii_lowercase().ends_with(".gguf"))
        else {
            continue;
        };
        let lower = path.to_ascii_lowercase();
        let role = if lower.contains("mmproj") || lower.contains("projector") {
            "projector"
        } else if lower.contains("-of-") {
            "shard"
        } else {
            "weights"
        };
        files.push(json!({"path":path,"size_bytes":if entry["lfs"].is_object(){&entry["lfs"]["size"]}else{&entry["size"]},"role":role}));
    }
    Ok(Json(json!({"repo_id":repo,"commit":commit,"files":files})))
}
