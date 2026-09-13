mod support;
use serde_json::Value;

#[tokio::test]
async fn openapi_exposes_the_management_contract_and_referenced_event_schemas() {
    let root = tempfile::tempdir().unwrap();
    let core = support::Core::start(root.path()).await;
    let response = reqwest::get(format!("{}/openapi.json", core.url))
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let api: Value = response.json().await.unwrap();
    assert_eq!(api["openapi"], "3.1.0");
    for path in [
        "/health",
        "/runtime",
        "/settings",
        "/hub/models",
        "/hub/files",
        "/model-sets",
        "/model-sets/{id}/references",
        "/model-sets/{id}",
        "/downloads",
        "/downloads/{id}/pause",
        "/downloads/{id}/resume",
        "/downloads/{id}/cancel",
        "/downloads/{id}/restart-file",
        "/presets",
        "/preset-files",
        "/preset-files/{id}",
        "/runtime/switch",
        "/operations",
        "/operations/{id}",
        "/operations/{id}/cancel",
        "/operations/{id}/force",
        "/builds",
        "/builds/{id}",
        "/builds/{id}/apply",
        "/recovery/{id}/stop",
        "/metrics",
        "/logs",
        "/logs/{id}/download",
        "/events",
        "/openapi.json",
    ] {
        assert!(api["paths"][path].is_object(), "Missing route {path}");
    }
    let runtime: Value = reqwest::get(format!("{}/runtime", core.url))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    for field in api["components"]["schemas"]["RuntimeSnapshot"]["required"]
        .as_array()
        .unwrap()
    {
        assert!(runtime.get(field.as_str().unwrap()).is_some(), "{field}");
    }
    assert!(api["components"]["schemas"]["EventEnvelope"].is_object());
    assert!(
        api["components"]["schemas"]["ManagementError"]["properties"]["request_id"].is_object()
    );
}

#[tokio::test]
async fn event_contract_discriminates_payloads_by_their_event_type() {
    let root = tempfile::tempdir().unwrap();
    let core = support::Core::start(root.path()).await;
    let api: Value = reqwest::get(format!("{}/openapi.json", core.url))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let variants = api["components"]["schemas"]["EventEnvelope"]["oneOf"]
        .as_array()
        .expect("Events must expose typed variants, not an arbitrary payload");
    for kind in [
        "snapshot",
        "runtime.changed",
        "operation.changed",
        "catalog.changed",
        "preset.changed",
        "build.changed",
        "metric.sample",
        "log.append",
        "gap",
    ] {
        let variant = variants
            .iter()
            .find(|v| v["properties"]["type"]["enum"][0] == kind)
            .expect(kind);
        assert_ne!(
            variant["properties"]["payload"],
            serde_json::json!({}),
            "{kind} must have a concrete payload schema"
        );
    }
}
