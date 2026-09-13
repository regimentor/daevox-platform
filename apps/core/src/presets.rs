use crate::{commands, settings::ApiError};
use axum::{
    Extension, Json,
    extract::Path as UrlPath,
    http::{HeaderMap, StatusCode},
};
use sea_orm::{DatabaseConnection, TransactionTrait};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Clone)]
pub(crate) struct Directory(pub PathBuf);

pub(crate) fn revision(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
fn id(path: &Path) -> String {
    revision(&path.file_name().unwrap_or_default().to_string_lossy())
}
fn source(path: &Path) -> Result<Value, ApiError> {
    let text = fs::read_to_string(path)?;
    Ok(
        json!({"id": id(path), "name": path.file_name().unwrap_or_default().to_string_lossy(), "revision": revision(&text), "text": text, "diagnostics": crate::ini::parse(&text).diagnostics}),
    )
}
fn resolve(directory: &Path, wanted: &str) -> Result<PathBuf, ApiError> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if entry.file_type()?.is_file()
            && entry.path().extension().is_some_and(|s| s == "ini")
            && id(&entry.path()) == wanted
        {
            return Ok(entry.path());
        }
    }
    Err(ApiError(
        StatusCode::NOT_FOUND,
        "unknown_resource",
        "Preset source does not exist".into(),
    ))
}

impl From<std::io::Error> for ApiError {
    fn from(error: std::io::Error) -> Self {
        let _ = writeln!(std::io::stderr(), "File error: {error}");
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "storage_error",
            "Cannot access core files".into(),
        )
    }
}

pub(crate) async fn read(
    Extension(directory): Extension<Directory>,
    UrlPath(id): UrlPath<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(source(&resolve(&directory.0, &id)?)?))
}

pub(crate) async fn create(
    Extension(directory): Extension<Directory>,
    Extension(db): Extension<DatabaseConnection>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let key = commands::key(&headers)?;
    let name = body["name"]
        .as_str()
        .filter(|n| {
            n.ends_with(".ini") && !n.contains(['/', '\\']) && !n.starts_with('.') && n.len() <= 200
        })
        .ok_or_else(|| {
            ApiError(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "A plain .ini filename is required".into(),
            )
        })?;
    let text = body["text"].as_str().ok_or_else(|| {
        ApiError(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Text is required".into(),
        )
    })?;
    let tx = db.begin().await?;
    if let Some(response) = commands::replay(&tx, &key, "POST /preset-files", &body).await? {
        tx.commit().await?;
        return Ok((StatusCode::CREATED, Json(response)));
    }
    let path = directory.0.join(name);
    if path.exists() {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "conflict",
            "Preset source already exists".into(),
        ));
    }
    let mut change = crate::source_change::SourceChange::apply(
        directory.0.parent().unwrap(),
        &key,
        &path,
        Some(text),
    )?;
    let response = source(&path)?;
    commands::remember(&tx, &key, "POST /preset-files", &body, &response).await?;
    tx.commit().await?;
    change.finish();
    Ok((StatusCode::CREATED, Json(response)))
}

pub(crate) async fn update(
    Extension(directory): Extension<Directory>,
    Extension(db): Extension<DatabaseConnection>,
    UrlPath(id): UrlPath<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let key = commands::key(&headers)?;
    let text = body["text"].as_str().ok_or_else(|| {
        ApiError(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Text is required".into(),
        )
    })?;
    let action = format!("PUT /preset-files/{id}");
    let tx = db.begin().await?;
    if let Some(response) = commands::replay(&tx, &key, &action, &body).await? {
        tx.commit().await?;
        return Ok(Json(response));
    }
    let path = resolve(&directory.0, &id)?;
    let current = source(&path)?;
    if body["base_revision"] != current["revision"] && body["overwrite"] != true {
        return Err(ApiError(
            StatusCode::PRECONDITION_FAILED,
            "revision_conflict",
            "Source changed; reload or explicitly overwrite".into(),
        ));
    }
    let mut change = crate::source_change::SourceChange::apply(
        directory.0.parent().unwrap(),
        &key,
        &path,
        Some(text),
    )?;
    let response = source(&path)?;
    commands::remember(&tx, &key, &action, &body, &response).await?;
    tx.commit().await?;
    change.finish();
    Ok(Json(response))
}

pub(crate) async fn catalog(
    Extension(directory): Extension<Directory>,
    Extension(runtime): Extension<crate::runtime::Runtime>,
    Extension(db): Extension<DatabaseConnection>,
) -> Result<Json<Value>, ApiError> {
    let mut files = vec![];
    let mut presets = vec![];
    for entry in fs::read_dir(&directory.0)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() || !entry.path().extension().is_some_and(|s| s == "ini") {
            continue;
        }
        let file = source(&entry.path())?;
        let parsed = crate::ini::parse(file["text"].as_str().unwrap_or(""));
        for name in parsed.sections.keys().filter(|name| name.as_str() != "*") {
            presets.push(json!({"id": name, "source_file_id": file["id"], "model_set_id": null, "saved_revision": file["revision"], "applied_revision": null, "can_launch": false, "diagnostics": parsed.diagnostics}));
        }
        files.push(file);
    }
    let sets = crate::operations::all(&db, "model_sets").await?;
    let builds = crate::operations::all(&db, "builds").await?;
    let snapshot = runtime.0.lock().await;
    let compatible = builds
        .iter()
        .find(|build| build["id"] == snapshot["current_build_id"])
        .is_some_and(|build| build["checks"]["driver_compatibility"] != "failed");
    for preset in &mut presets {
        let name = preset["id"].as_str().unwrap();
        if snapshot["active_instance"]["preset_id"] == name {
            preset["applied_revision"] =
                snapshot["active_instance"]["applied_preset_revision"].clone();
        }
        match compile_target(
            &directory.0,
            preset["id"].as_str().unwrap(),
            preset["saved_revision"].as_str().unwrap(),
        ) {
            Ok((ini, model_set_id)) => {
                let model_set_id = model_set_for(&directory.0, &sets, &ini).unwrap_or(model_set_id);
                preset["model_set_id"] = json!(model_set_id);
                preset["can_launch"] = json!(
                    compatible
                        && !snapshot["current_build_id"].is_null()
                        && snapshot["current_operation_id"].is_null()
                        && matches!(snapshot["state"].as_str(), Some("empty" | "ready"))
                );
            }
            Err(error) => preset["diagnostics"].as_array_mut().unwrap().push(
                json!({"severity":"error","code":error.1,"message":error.2,"line":null,"key":null}),
            ),
        }
    }
    let revision = revision(
        &json!(
            files
                .iter()
                .map(|f| (&f["id"], &f["revision"]))
                .collect::<Vec<_>>()
        )
        .to_string(),
    );
    Ok(Json(
        json!({"files": files, "presets": presets,"revision":revision}),
    ))
}

pub(crate) fn compile_target(
    directory: &Path,
    name: &str,
    expected: &str,
) -> Result<(String, String), ApiError> {
    let mut matches = vec![];
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() || !entry.path().extension().is_some_and(|s| s == "ini") {
            continue;
        }
        let text = fs::read_to_string(entry.path())?;
        let parsed = crate::ini::parse(&text);
        if parsed.sections.contains_key(name) {
            matches.push((text, parsed));
        }
    }
    if matches.len() != 1 {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_preset",
            "Preset must exist with a unique name".into(),
        ));
    }
    let (text, parsed) = matches.pop().unwrap();
    if revision(&text) != expected {
        return Err(ApiError(
            StatusCode::PRECONDITION_FAILED,
            "revision_conflict",
            "Preset revision changed".into(),
        ));
    }
    if parsed.diagnostics.iter().any(|d| d["severity"] == "error") {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_preset",
            "Resolve preset diagnostics before loading".into(),
        ));
    }
    let mut options = parsed.sections.get("*").cloned().unwrap_or_default();
    options.extend(parsed.sections[name].clone());
    if !options.contains_key("model") {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_preset",
            "A local model file is required".into(),
        ));
    }
    for key in [
        "model",
        "mmproj",
        "grammar-file",
        "json-schema-file",
        "chat-template-file",
        "lora",
        "lora-scaled",
        "control-vector",
        "control-vector-scaled",
    ] {
        if let Some(value) = options.get_mut(key) {
            let multiple = matches!(
                key,
                "lora" | "lora-scaled" | "control-vector" | "control-vector-scaled"
            );
            let entries = if multiple {
                csv_paths(value)?
            } else {
                vec![value.clone()]
            };
            let mut resolved_entries = Vec::new();
            for entry in entries {
                let (filename, scale) = if key.ends_with("-scaled") {
                    let (filename, scale) = entry.split_once(':').ok_or_else(|| {
                        ApiError(
                            StatusCode::UNPROCESSABLE_ENTITY,
                            "invalid_preset",
                            format!("Expected FILE:SCALE for {key}"),
                        )
                    })?;
                    if !scale.parse::<f32>().is_ok_and(f32::is_finite) {
                        return Err(ApiError(
                            StatusCode::UNPROCESSABLE_ENTITY,
                            "invalid_preset",
                            format!("Invalid scale for {key}"),
                        ));
                    }
                    (filename, Some(scale))
                } else {
                    (entry.as_str(), None)
                };
                let path = PathBuf::from(filename);
                let path = if path.is_absolute() {
                    path
                } else {
                    directory.join(path)
                };
                let resolved = path.canonicalize().map_err(|_| {
                    ApiError(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "invalid_preset",
                        format!("Missing file for {key}"),
                    )
                })?;
                let models = directory
                    .parent()
                    .unwrap()
                    .join("data/models")
                    .canonicalize()?;
                let sources = directory.canonicalize()?;
                if !resolved.is_file()
                    || !(resolved.starts_with(models) || resolved.starts_with(sources))
                {
                    return Err(ApiError(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "invalid_preset",
                        format!("{key} must reference a file within core models or presets"),
                    ));
                }
                let mut resolved = resolved.to_string_lossy().into_owned();
                if let Some(scale) = scale {
                    resolved.push(':');
                    resolved.push_str(scale);
                }
                if multiple && resolved.contains([',', '"']) {
                    resolved = format!("\"{}\"", resolved.replace('"', "\"\""));
                }
                resolved_entries.push(resolved);
            }
            *value = resolved_entries.join(",");
        }
    }
    let model_set_id = revision(&options["model"]);
    let mut ini = format!("version = 1\n[{name}]\n");
    for (key, value) in options {
        ini.push_str(&format!("{key} = {value}\n"));
    }
    Ok((ini, model_set_id))
}

pub(crate) async fn delete(
    Extension(directory): Extension<Directory>,
    Extension(db): Extension<DatabaseConnection>,
    UrlPath(id): UrlPath<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<StatusCode, ApiError> {
    let key = commands::key(&headers)?;
    let action = format!("DELETE /preset-files/{id}");
    let tx = db.begin().await?;
    if commands::replay(&tx, &key, &action, &body).await?.is_some() {
        tx.commit().await?;
        return Ok(StatusCode::NO_CONTENT);
    }
    let path = resolve(&directory.0, &id)?;
    if !body["revision"].is_string() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "revision is required".into(),
        ));
    }
    if source(&path)?["revision"] != body["revision"] {
        return Err(ApiError(
            StatusCode::PRECONDITION_FAILED,
            "revision_conflict",
            "Source changed; reload before deleting".into(),
        ));
    }
    let mut change = crate::source_change::SourceChange::apply(
        directory.0.parent().unwrap(),
        &key,
        &path,
        None,
    )?;
    commands::remember(&tx, &key, &action, &body, &json!({})).await?;
    tx.commit().await?;
    change.finish();
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) fn model_set_for(directory: &Path, sets: &[Value], ini: &str) -> Option<String> {
    let parsed = crate::ini::parse(ini);
    let options = parsed.sections.values().next()?;
    let required: Vec<_> = ["model", "mmproj"]
        .iter()
        .filter_map(|key| options.get(*key))
        .map(PathBuf::from)
        .collect();
    if required.is_empty() {
        return None;
    }
    sets.iter()
        .filter(|set| {
            required.iter().all(|path| {
                set["files"].as_array().is_some_and(|files| {
                    files.iter().any(|f| {
                        directory
                            .parent()
                            .unwrap()
                            .join("data/models")
                            .join(f["local_path"].as_str().unwrap_or(""))
                            == *path
                    })
                })
            })
        })
        .min_by_key(|set| set["files"].as_array().map(Vec::len).unwrap_or(usize::MAX))
        .and_then(|set| set["id"].as_str().map(str::to_owned))
}

// Same quoted-field/escaped-quote rules as pinned common/arg.cpp::parse_csv_row.
fn csv_paths(input: &str) -> Result<Vec<String>, ApiError> {
    let mut result = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '"' if quoted => {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    quoted = false;
                }
            }
            '"' if field.is_empty() => quoted = true,
            ',' if !quoted => result.push(std::mem::take(&mut field)),
            ch => field.push(ch),
        }
    }
    if quoted {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_preset",
            "Unclosed quote in file list".into(),
        ));
    }
    result.push(field);
    Ok(result)
}
