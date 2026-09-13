mod support;
use serde_json::{Value, json};

#[tokio::test]
async fn preset_source_roundtrips_comments_and_crlf_after_restart() {
    let root = tempfile::tempdir().unwrap();
    let mut core = support::Core::start(root.path()).await;
    let client = reqwest::Client::new();
    let text = "; preserve this comment\r\n[local]\r\nmodel = ../data/models/local.gguf\r\nctx-size = 4096\r\n";
    let created = client
        .post(format!("{}/preset-files", core.url))
        .header("Idempotency-Key", "create")
        .json(&json!({"name": "local.ini", "text": text}))
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), 201);
    let created: Value = created.json().await.unwrap();
    let id = created["id"].as_str().unwrap();
    core.child.kill().await.unwrap();
    let core = support::Core::start(root.path()).await;
    let response = client
        .get(format!("{}/preset-files/{id}", core.url))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let source: Value = response.json().await.unwrap();
    assert_eq!(source["text"], text);
    assert_eq!(source["revision"], created["revision"]);
}

#[tokio::test]
async fn an_external_ini_edit_requires_explicit_overwrite() {
    let root = tempfile::tempdir().unwrap();
    let core = support::Core::start(root.path()).await;
    let client = reqwest::Client::new();
    let source: Value = client
        .post(format!("{}/preset-files", core.url))
        .header("Idempotency-Key", "create")
        .json(&json!({"name": "local.ini", "text": "[local]\nctx-size=4096\n"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let url = format!(
        "{}/preset-files/{}",
        core.url,
        source["id"].as_str().unwrap()
    );
    std::fs::write(
        root.path().join("presets/local.ini"),
        "; external edit\n[local]\nctx-size=8192\n",
    )
    .unwrap();
    let draft = "; my draft\r\n[local]\r\nctx-size=2048\r\n";
    let body = json!({"text": draft, "base_revision": source["revision"], "overwrite": false});
    let response = client
        .put(&url)
        .header("Idempotency-Key", "save")
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 412);
    let current: Value = client.get(&url).send().await.unwrap().json().await.unwrap();
    assert_eq!(current["text"], "; external edit\n[local]\nctx-size=8192\n");
    let response = client
        .put(&url)
        .header("Idempotency-Key", "overwrite")
        .json(&json!({"text": draft, "base_revision": source["revision"], "overwrite": true}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let saved: Value = client.get(&url).send().await.unwrap().json().await.unwrap();
    assert_eq!(saved["text"], draft);
    assert_ne!(saved["revision"], source["revision"]);
}

#[tokio::test]
async fn invalid_drafts_are_saved_but_catalog_explains_why_they_cannot_launch() {
    let root = tempfile::tempdir().unwrap();
    let core = support::Core::start(root.path()).await;
    let client = reqwest::Client::new();
    for (name, text, code) in [
        ("unknown", "[unknown]\nunknown-key=42\n", "unknown_setting"),
        (
            "controlled",
            "[controlled]\nport=9999\n",
            "router_owned_setting",
        ),
        (
            "duplicate",
            "[duplicate]\nctx-size=512\n[duplicate]\nctx-size=1024\n",
            "duplicate_section",
        ),
        ("syntax", "[syntax]\n  ctx-size=1024\n", "invalid_syntax"),
    ] {
        let response = client
            .post(format!("{}/preset-files", core.url))
            .header("Idempotency-Key", name)
            .json(&json!({"name": format!("{name}.ini"), "text": text}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 201);
        let draft: Value = response.json().await.unwrap();
        assert_eq!(draft["text"], text);
        assert!(
            draft["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|d| d["code"] == code),
            "{draft}"
        );
    }
    let response = client
        .get(format!("{}/presets", core.url))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let catalog: Value = response.json().await.unwrap();
    assert_eq!(catalog["presets"].as_array().unwrap().len(), 4);
    assert!(
        catalog["presets"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["can_launch"] == false)
    );
}

#[tokio::test]
async fn duplicate_option_aliases_report_the_effective_last_value() {
    let root = tempfile::tempdir().unwrap();
    let core = support::Core::start(root.path()).await;
    let result: Value = reqwest::Client::new()
        .post(format!("{}/preset-files", core.url))
        .header("Idempotency-Key", "aliases")
        .json(&json!({"name": "aliases.ini", "text": "[local]\nctx-size=512\nc=2048\n"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let warning = result["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["code"] == "duplicate_key")
        .expect("Alias collision must be visible");
    assert_eq!(warning["severity"], "warning");
    assert!(warning["message"].as_str().unwrap().contains("2048"));
}

#[tokio::test]
async fn catalog_exposes_launchability_and_keeps_applied_revision_when_source_changes() {
    let root = tempfile::tempdir().unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    let source = support::ready(&core, root.path()).await;
    let client = reqwest::Client::new();
    let read = || client.get(format!("{}/presets", core.url));
    let catalog: Value = read().send().await.unwrap().json().await.unwrap();
    let a = catalog["presets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == "a")
        .unwrap();
    assert_eq!(a["can_launch"], true);
    assert_eq!(a["applied_revision"], source["revision"]);
    let saved:Value=client.put(format!("{}/preset-files/{}",core.url,source["id"].as_str().unwrap())).header("Idempotency-Key","edit-live").json(&json!({"base_revision":source["revision"],"overwrite":false,"text":"[*]\nmodel=../data/models/fixture.gguf\n[a]\nctx-size=4096\n"})).send().await.unwrap().json().await.unwrap();
    let catalog: Value = read().send().await.unwrap().json().await.unwrap();
    let a = &catalog["presets"][0];
    assert_eq!(a["saved_revision"], saved["revision"]);
    assert_eq!(a["applied_revision"], source["revision"]);
    std::fs::write(
        root.path().join("presets/duplicate.ini"),
        "[a]\nmodel=../data/models/fixture.gguf\n",
    )
    .unwrap();
    let catalog: Value = read().send().await.unwrap().json().await.unwrap();
    assert!(catalog["presets"].as_array().unwrap().iter().all(|p| {
        p["can_launch"] == false
            && p["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|d| d["code"] == "invalid_preset")
    }));
}

#[tokio::test]
async fn deleting_a_source_checks_revision_and_does_not_stop_its_applied_instance() {
    let root = tempfile::tempdir().unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    let source = support::ready(&core, root.path()).await;
    let client = reqwest::Client::new();
    let url = format!(
        "{}/preset-files/{}",
        core.url,
        source["id"].as_str().unwrap()
    );
    let stale = client
        .delete(&url)
        .header("Idempotency-Key", "delete-stale")
        .json(&json!({"revision":"stale"}))
        .send()
        .await
        .unwrap();
    assert_eq!(stale.status(), 412);
    for _ in 0..2 {
        let response = client
            .delete(&url)
            .header("Idempotency-Key", "delete-source")
            .json(&json!({"revision":source["revision"]}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 204);
    }
    assert_eq!(client.get(&url).send().await.unwrap().status(), 404);
    let answer = client
        .post(format!("{}/v1/chat/completions", core.url))
        .json(&json!({"model":"a","messages":[]}))
        .send()
        .await
        .unwrap();
    assert_eq!(answer.status(), 200);
}

#[tokio::test]
async fn negative_boolean_alias_reports_the_effective_semantic_value() {
    let root = tempfile::tempdir().unwrap();
    let core = support::Core::start(root.path()).await;
    let result: Value = reqwest::Client::new()
        .post(format!("{}/preset-files", core.url))
        .header("Idempotency-Key", "negative-alias")
        .json(&json!({"name":"negative.ini","text":"[local]\njinja=true\nno-jinja=true\n"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let warning = result["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["code"] == "duplicate_key")
        .unwrap();
    assert!(
        warning["message"]
            .as_str()
            .unwrap()
            .contains("effective last value: false")
    );
}

#[tokio::test]
async fn invalid_integer_options_are_saved_as_drafts_with_line_diagnostics() {
    let root = tempfile::tempdir().unwrap();
    let core = support::Core::start(root.path()).await;
    let result: Value = reqwest::Client::new()
        .post(format!("{}/preset-files", core.url))
        .header("Idempotency-Key", "integer-draft")
        .json(&json!({"name":"integer.ini","text":"[local]\nctx-size=banana\n"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let diagnostic = result["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["code"] == "invalid_value")
        .expect("invalid integer must be diagnosed before starting router");
    assert_eq!(diagnostic["line"], 2);
    assert_eq!(diagnostic["key"], "ctx-size");
}

#[tokio::test]
async fn preset_file_arguments_cannot_escape_core_catalogs_or_enable_external_downloads() {
    let root = tempfile::tempdir().unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    support::ready(&core, root.path()).await;
    let client = reqwest::Client::new();
    for (name, text) in [
        ("outside", "[outside]\nmodel=/etc/hosts\n"),
        (
            "projector-url",
            "[projector-url]\nmodel=../data/models/fixture.gguf\nmmproj-url=https://example.com/model.gguf\n",
        ),
        (
            "log-output",
            "[log-output]\nmodel=../data/models/fixture.gguf\nlog-file=/tmp/escape.log\n",
        ),
    ] {
        let source: Value = client
            .post(format!("{}/preset-files", core.url))
            .header("Idempotency-Key", name)
            .json(&json!({"name":format!("{name}.ini"),"text":text}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let response = client
            .post(format!("{}/runtime/switch", core.url))
            .header("Idempotency-Key", format!("launch-{name}"))
            .json(&json!({"preset_id":name,"preset_revision":source["revision"]}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 422, "{name}");
    }
    let models: Value = client
        .get(format!("{}/v1/models", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(models["data"][0]["id"], "a");
}

#[tokio::test]
async fn csv_and_scaled_file_options_are_resolved_from_the_source_directory() {
    let root = tempfile::tempdir().unwrap();
    let core = support::with_fixture_toolchain(root.path()).await;
    support::ready(&core, root.path()).await;
    for name in ["adapter.gguf", "second,adapter.gguf"] {
        std::fs::write(
            root.path().join("data/models").join(name),
            "adapter fixture",
        )
        .unwrap();
    }
    std::fs::write(root.path().join("presets/schema.json"), "{}").unwrap();
    let client = reqwest::Client::new();
    let source:Value=client.post(format!("{}/preset-files",core.url)).header("Idempotency-Key","csv-source").json(&json!({"name":"csv.ini","text":"[csv]\nmodel=../data/models/fixture.gguf\nlora=../data/models/adapter.gguf,\"../data/models/second,adapter.gguf\"\ncontrol-vector-scaled=../data/models/adapter.gguf:0.5\njf=schema.json\n"})).send().await.unwrap().json().await.unwrap();
    let response = client
        .post(format!("{}/runtime/switch", core.url))
        .header("Idempotency-Key", "csv-switch")
        .json(&json!({"preset_id":"csv","preset_revision":source["revision"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let runtime: Value = client
                .get(format!("{}/runtime", core.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if runtime["state"] == "ready" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let response: Value = client
        .post(format!("{}/v1/chat/completions", core.url))
        .json(&json!({"model":"csv","messages":[],"fixture_options":true}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        response["options"]["lora"],
        format!(
            "{}/data/models/adapter.gguf,\"{}/data/models/second,adapter.gguf\"",
            root.path().display(),
            root.path().display()
        )
    );
    assert_eq!(
        response["options"]["control-vector-scaled"],
        format!("{}/data/models/adapter.gguf:0.5", root.path().display())
    );
    assert_eq!(
        response["options"]["json-schema-file"],
        format!("{}/presets/schema.json", root.path().display())
    );
}

#[tokio::test]
async fn a_failed_command_record_does_not_leave_a_created_source_behind() {
    use sea_orm::{ConnectionTrait, Database};
    let root = tempfile::tempdir().unwrap();
    let core = support::Core::start(root.path()).await;
    // External SQLite failure at the durable command boundary.
    let db = Database::connect(format!(
        "sqlite:{}",
        root.path().join("data/core.sqlite").display()
    ))
    .await
    .unwrap();
    db.execute_unprepared("CREATE TRIGGER fail_command BEFORE INSERT ON request_keys BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END").await.unwrap();
    let client = reqwest::Client::new();
    let response = client
        .post(format!("{}/preset-files", core.url))
        .header("Idempotency-Key", "failed-create")
        .json(&json!({"name":"failed.ini","text":"[failed]\nctx-size=512\n"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 500);
    let catalog: Value = client
        .get(format!("{}/presets", core.url))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        catalog["files"].as_array().unwrap().is_empty(),
        "Rejected creation must leave no source file"
    );
    db.execute_unprepared("DROP TRIGGER fail_command")
        .await
        .unwrap();
    assert_eq!(
        client
            .post(format!("{}/preset-files", core.url))
            .header("Idempotency-Key", "failed-create")
            .json(&json!({"name":"failed.ini","text":"[failed]\nctx-size=512\n"}))
            .send()
            .await
            .unwrap()
            .status(),
        201
    );
}

#[tokio::test]
async fn a_failed_command_record_preserves_the_previous_source_revision() {
    use sea_orm::{ConnectionTrait, Database};
    let root = tempfile::tempdir().unwrap();
    let core = support::Core::start(root.path()).await;
    let client = reqwest::Client::new();
    let source: Value = client
        .post(format!("{}/preset-files", core.url))
        .header("Idempotency-Key", "original")
        .json(&json!({"name":"original.ini","text":"; original\r\n[original]\r\nctx-size=512\r\n"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let url = format!(
        "{}/preset-files/{}",
        core.url,
        source["id"].as_str().unwrap()
    );
    let db = Database::connect(format!(
        "sqlite:{}",
        root.path().join("data/core.sqlite").display()
    ))
    .await
    .unwrap();
    db.execute_unprepared("CREATE TRIGGER fail_command BEFORE INSERT ON request_keys BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END").await.unwrap();
    assert_eq!(client.put(&url).header("Idempotency-Key","failed-save").json(&json!({"text":"[changed]\nctx-size=1024\n","base_revision":source["revision"],"overwrite":false})).send().await.unwrap().status(),500);
    let current: Value = client.get(&url).send().await.unwrap().json().await.unwrap();
    assert_eq!(current["text"], source["text"]);
    assert_eq!(current["revision"], source["revision"]);
}

#[tokio::test]
async fn restarting_after_a_crash_before_command_commit_reconciles_the_source_file() {
    use sea_orm::{ConnectionTrait, Database};
    let root = tempfile::tempdir().unwrap();
    let mut core = support::Core::start(root.path()).await;
    let db = Database::connect(format!(
        "sqlite:{}",
        root.path().join("data/core.sqlite").display()
    ))
    .await
    .unwrap();
    // Delay the external SQLite commit boundary so the supervisor can crash core after its file write.
    db.execute_unprepared("CREATE TRIGGER delayed_command BEFORE INSERT ON request_keys BEGIN SELECT length(randomblob(200000000)); END").await.unwrap();
    let url = core.url.clone();
    let request = tokio::spawn(async move {
        reqwest::Client::new()
            .post(format!("{url}/preset-files"))
            .header("Idempotency-Key", "crashed-create")
            .json(&json!({"name":"crashed.ini","text":"[crashed]\nctx-size=512\n"}))
            .send()
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while !root.path().join("presets/crashed.ini").exists() {
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    core.child.kill().await.unwrap();
    let _ = request.await;
    db.execute_unprepared("DROP TRIGGER delayed_command")
        .await
        .unwrap();
    db.close().await.unwrap();
    let core = support::Core::start(root.path()).await;
    let catalog: Value = reqwest::get(format!("{}/presets", core.url))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        catalog["files"].as_array().unwrap().is_empty(),
        "Uncommitted source creation must be undone at startup"
    );
    assert_eq!(
        reqwest::Client::new()
            .post(format!("{}/preset-files", core.url))
            .header("Idempotency-Key", "crashed-create")
            .json(&json!({"name":"crashed.ini","text":"[crashed]\nctx-size=512\n"}))
            .send()
            .await
            .unwrap()
            .status(),
        201
    );
}

#[tokio::test]
async fn restarting_after_an_uncommitted_save_restores_the_previous_source_revision() {
    use sea_orm::{ConnectionTrait, Database};
    let root = tempfile::tempdir().unwrap();
    let mut core = support::Core::start(root.path()).await;
    let original: Value = reqwest::Client::new()
        .post(format!("{}/preset-files", core.url))
        .header("Idempotency-Key", "original-source")
        .json(&json!({"name":"crashed.ini","text":"; original\r\n[original]\r\nctx-size=512\r\n"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let db = Database::connect(format!(
        "sqlite:{}",
        root.path().join("data/core.sqlite").display()
    ))
    .await
    .unwrap();
    // Delay the external SQLite commit boundary so the supervisor can crash core after its file write.
    db.execute_unprepared("CREATE TRIGGER delayed_command BEFORE INSERT ON request_keys BEGIN SELECT length(randomblob(200000000)); END").await.unwrap();
    let url = format!(
        "{}/preset-files/{}",
        core.url,
        original["id"].as_str().unwrap()
    );
    let revision = original["revision"].clone();
    let request = tokio::spawn(async move {
        reqwest::Client::new().put(url).header("Idempotency-Key","crashed-create")
        .json(&json!({"text":"[crashed]\nctx-size=512\n","base_revision":revision,"overwrite":false})).send().await
    });
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while std::fs::read_to_string(root.path().join("presets/crashed.ini")).unwrap_or_default()
            != "[crashed]\nctx-size=512\n"
        {
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    core.child.kill().await.unwrap();
    let _ = request.await;
    db.execute_unprepared("DROP TRIGGER delayed_command")
        .await
        .unwrap();
    db.close().await.unwrap();
    let core = support::Core::start(root.path()).await;
    let catalog: Value = reqwest::get(format!("{}/presets", core.url))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(catalog["files"][0]["text"], original["text"]);
    assert_eq!(catalog["files"][0]["revision"], original["revision"]);
}

#[tokio::test]
async fn restarting_after_an_uncommitted_delete_restores_the_source() {
    use sea_orm::{ConnectionTrait, Database};
    let root = tempfile::tempdir().unwrap();
    let mut core = support::Core::start(root.path()).await;
    let original: Value = reqwest::Client::new()
        .post(format!("{}/preset-files", core.url))
        .header("Idempotency-Key", "original-source")
        .json(&json!({"name":"crashed.ini","text":"; original\r\n[original]\r\nctx-size=512\r\n"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let db = Database::connect(format!(
        "sqlite:{}",
        root.path().join("data/core.sqlite").display()
    ))
    .await
    .unwrap();
    // Delay the external SQLite commit boundary so the supervisor can crash core after its file write.
    db.execute_unprepared("CREATE TRIGGER delayed_command BEFORE INSERT ON request_keys BEGIN SELECT length(randomblob(200000000)); END").await.unwrap();
    let url = format!(
        "{}/preset-files/{}",
        core.url,
        original["id"].as_str().unwrap()
    );
    let revision = original["revision"].clone();
    let request = tokio::spawn(async move {
        reqwest::Client::new()
            .delete(url)
            .header("Idempotency-Key", "crashed-create")
            .json(&json!({"revision":revision}))
            .send()
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while root.path().join("presets/crashed.ini").exists() {
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    core.child.kill().await.unwrap();
    let _ = request.await;
    db.execute_unprepared("DROP TRIGGER delayed_command")
        .await
        .unwrap();
    db.close().await.unwrap();
    let core = support::Core::start(root.path()).await;
    let catalog: Value = reqwest::get(format!("{}/presets", core.url))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(catalog["files"][0]["text"], original["text"]);
    assert_eq!(catalog["files"][0]["revision"], original["revision"]);
}
