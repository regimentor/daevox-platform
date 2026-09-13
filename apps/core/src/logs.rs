use crate::{presets::Directory, settings::ApiError};
use axum::{
    Extension, Json,
    extract::{Path, Query},
    http::StatusCode,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, Write},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::io::{AsyncRead, AsyncReadExt};

const SEGMENT_LIMIT: u64 = 1024 * 1024;
const TOTAL_LIMIT: u64 = 200 * 1024 * 1024;
static DISK: Mutex<()> = Mutex::new(());
static ORDER: AtomicU64 = AtomicU64::new(0);
static LIVE: std::sync::LazyLock<Mutex<HashMap<PathBuf, tokio::sync::broadcast::Sender<Value>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
fn live(root: &std::path::Path) -> tokio::sync::broadcast::Sender<Value> {
    LIVE.lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(root.to_path_buf())
        .or_insert_with(|| tokio::sync::broadcast::channel(128).0)
        .clone()
}
pub(crate) fn subscribe(root: &std::path::Path) -> tokio::sync::broadcast::Receiver<Value> {
    live(&root.join("data/logs")).subscribe()
}

fn segments(root: &std::path::Path) -> std::io::Result<Vec<(PathBuf, u64)>> {
    let mut files = vec![];
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_type()?.is_file() && entry.path().extension().is_some_and(|s| s == "jsonl") {
            files.push((entry.path(), entry.metadata()?.len()));
        }
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(files)
}

pub(crate) fn capture<R: AsyncRead + Unpin + Send + 'static>(
    root: &std::path::Path,
    source: &str,
    context: Value,
    stream: &str,
    mut reader: R,
) {
    let root = root.join("data/logs");
    let source = source.to_string();
    let stream = stream.to_string();
    let (sender, mut receiver) = tokio::sync::mpsc::channel::<Value>(128);
    let lost = Arc::new(AtomicU64::new(0));
    let dropped = lost.clone();
    tokio::spawn(async move {
        let mut buffer = [0u8; 4096];
        let mut line = Vec::with_capacity(8192);
        let send = |line: &[u8], truncated: bool| {
            let message = String::from_utf8_lossy(line);
            // The pinned router forwards child output as "[port] timestamp level ...".
            let child = message
                .strip_prefix('[')
                .and_then(|s| s.split_once("] "))
                .filter(|(port, _)| port.trim().parse::<u16>().is_ok());
            let actual_source = if source == "router" && child.is_some() {
                "model"
            } else {
                &source
            };
            let content = child.map(|(_, content)| content).unwrap_or(&message);
            let level = match content.split_whitespace().nth(1) {
                Some("I") => Some("info"),
                Some("W") => Some("warning"),
                Some("E") => Some("error"),
                Some("D") => Some("debug"),
                _ => None,
            };
            let entry = json!({"id":uuid::Uuid::new_v4().to_string(),"source":actual_source,"stream":stream,"timestamp":chrono::Utc::now().to_rfc3339(),"level":level,"build_id":context["build_id"],"operation_id":context["operation_id"],"instance_id":context["instance_id"],"message":message,"truncated":truncated});
            if sender.try_send(entry).is_err() {
                dropped.fetch_add(1, Ordering::Relaxed);
            }
        };
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) | Err(_) => {
                    if !line.is_empty() {
                        send(&line, false);
                    }
                    break;
                }
                Ok(n) => {
                    for byte in &buffer[..n] {
                        if *byte == b'\n' {
                            send(&line, false);
                            line.clear();
                        } else {
                            line.push(*byte);
                            if line.len() == 8192 {
                                send(&line, true);
                                line.clear();
                            }
                        }
                    }
                }
            }
        }
    });
    tokio::task::spawn_blocking(move || {
        let mut current: Option<(PathBuf, fs::File, u64)> = None;
        while let Some(mut entry) = receiver.blocking_recv() {
            let count = lost.swap(0, Ordering::Relaxed);
            entry["dropped_before"] = json!(count);
            let _lock = DISK.lock().unwrap_or_else(|e| e.into_inner());
            let order = ORDER
                .load(Ordering::Relaxed)
                .max(chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0) as u64);
            ORDER.store(order + 1, Ordering::Relaxed);
            entry["id"] = json!(format!("{order:020}-{}", uuid::Uuid::new_v4()));
            let mut bytes = entry.to_string().into_bytes();
            bytes.push(b'\n');
            if current.as_ref().is_none_or(|(path, _, size)| {
                !path.exists() || size + bytes.len() as u64 > SEGMENT_LIMIT
            }) {
                let path = root.join(format!(
                    "{:020}-{}.jsonl",
                    chrono::Utc::now().timestamp_micros(),
                    uuid::Uuid::new_v4()
                ));
                current = fs::OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&path)
                    .ok()
                    .map(|file| (path, file, 0));
            }
            if let Some((_, file, size)) = &mut current
                && file.write_all(&bytes).is_ok()
            {
                *size += bytes.len() as u64;
                let _ = live(&root).send(entry);
            }

            if let Ok(files) = segments(&root) {
                let mut total: u64 = files.iter().map(|f| f.1).sum();
                for (path, size) in files {
                    if total <= TOTAL_LIMIT {
                        break;
                    }
                    if fs::remove_file(path).is_ok() {
                        total -= size;
                    }
                }
            }
        }
        if let Some((_, file, _)) = current {
            let _ = file.sync_all();
        }
    });
}

pub(crate) async fn list(
    Extension(directory): Extension<Directory>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let root = directory.0.parent().unwrap().join("data/logs");
    tokio::task::spawn_blocking(move || {
        let files = segments(&root)?;
        let mut entries = std::collections::BTreeMap::new();
        let mut cursor_order = None;
        let mut discarded_order = None;
        let mut available = vec![];
        let cursor = query.get("cursor");
        let mut found = cursor.is_none();
        let mut gap = false;
        for (path, size) in files {
            let id = path.file_stem().unwrap().to_string_lossy().to_string();
            available.push(json!({"id":id,"size_bytes":size}));
            let Ok(file) = fs::File::open(&path) else {
                gap = true;
                continue;
            };
            for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
                let Ok(entry) = serde_json::from_str::<Value>(&line) else {
                    gap = true;
                    continue;
                };
                if cursor.is_some_and(|c| entry["id"] == c.as_str()) {
                    found = true;
                    cursor_order = Some(entry_order(&entry));
                    continue;
                }
                if entry["dropped_before"].as_u64().unwrap_or(0) > 0 {
                    gap = true;
                }
                if query
                    .get("source")
                    .is_some_and(|s| s != "all" && entry["source"] != s.as_str())
                    || query
                        .get("query")
                        .is_some_and(|q| !entry["message"].as_str().unwrap_or("").contains(q))
                {
                    continue;
                }
                entries.insert(entry_order(&entry), entry);
                if entries.len() > 500
                    && let Some((order, _)) = entries.pop_first()
                {
                    discarded_order = Some(order);
                }
            }
        }
        gap |= !found
            || discarded_order
                .is_some_and(|order| cursor_order.is_some_and(|cursor| order > cursor));
        if let Some(cursor) = cursor_order {
            entries.retain(|order, _| *order > cursor);
        }
        let entries: Vec<_> = entries.into_values().collect();
        let cursor = entries
            .last()
            .map(|e| e["id"].clone())
            .or_else(|| cursor.map(|c| json!(c)));
        Ok(Json(
            json!({"entries":entries,"segments":available,"cursor":cursor,"gap":gap}),
        ))
    })
    .await
    .map_err(|e| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "log_error",
            e.to_string(),
        )
    })?
}

pub(crate) async fn download(
    Extension(directory): Extension<Directory>,
    Path(id): Path<String>,
) -> Result<impl axum::response::IntoResponse, ApiError> {
    if id.contains(['/', '\\', '.']) {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "unknown_resource",
            "Unknown segment".into(),
        ));
    }
    let path = directory
        .0
        .parent()
        .unwrap()
        .join("data/logs")
        .join(format!("{id}.jsonl"));
    let bytes = fs::read(path).map_err(|_| {
        ApiError(
            StatusCode::NOT_FOUND,
            "log_unavailable",
            "Segment is unavailable or was rotated".into(),
        )
    })?;
    Ok((
        [
            (axum::http::header::CONTENT_TYPE, "application/x-ndjson"),
            (
                axum::http::header::CONTENT_DISPOSITION,
                "attachment; filename=core-log.jsonl",
            ),
        ],
        bytes,
    ))
}

fn entry_order(entry: &Value) -> u64 {
    entry["id"]
        .as_str()
        .and_then(|id| id.split_once('-'))
        .filter(|(prefix, _)| prefix.len() == 20)
        .and_then(|(prefix, _)| prefix.parse().ok())
        .or_else(|| {
            entry["timestamp"]
                .as_str()
                .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
                .and_then(|t| t.timestamp_nanos_opt())
                .map(|n| n as u64)
        })
        .unwrap_or(0)
}
