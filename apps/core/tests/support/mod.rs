use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
};

pub struct Core {
    pub child: Child,
    pub url: String,
}

pub fn command(root: &Path) -> Command {
    let port_file = root.join(".test-router-port");
    let port = std::fs::read_to_string(&port_file).unwrap_or_else(|_| {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port().to_string();
        std::fs::write(&port_file, &port).unwrap();
        port
    });
    let mut command = Command::new(env!("CARGO_BIN_EXE_core"));
    command.env("CORE_ROUTER_PORT",port);
    command
        .env("CORE_PORT", "0")
        .env("CORE_AUTO_BUILD", "0")
        .env("CORE_APP_DIR", root)
        .env("CORE_WEB_ORIGIN", "http://localhost:5173")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

impl Core {
    #[allow(dead_code)]
    pub async fn start(root: &Path) -> Self {
        Self::start_command(command(root)).await
    }

    pub async fn start_command(mut command: Command) -> Self {
        let mut child = command.spawn().unwrap();
        let mut lines = BufReader::new(child.stderr.take().unwrap()).lines();
        let url = tokio::time::timeout(Duration::from_secs(15), async {
            while let Some(line) = lines.next_line().await.unwrap() {
                if let Some(url) = line.strip_prefix("Core listening on ") {
                    return url.to_string();
                }
                eprintln!("{line}");
            }
            panic!("Core exited before listening")
        })
        .await
        .unwrap();
        Self { child, url }
    }
}

#[allow(dead_code)]
pub async fn with_fixture_toolchain(root: &std::path::Path) -> Core {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(root.join("vendor")).unwrap();
    std::os::unix::fs::symlink(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("vendor/llama.cpp"),
        root.join("vendor/llama.cpp"),
    )
    .unwrap();
    std::fs::create_dir_all(root.join("tools")).unwrap();
    let cmake = root.join("tools/cmake");
    std::fs::write(
        &cmake,
        r#"#!/usr/bin/python3
import os, pathlib, shutil, sys
if '-B' in sys.argv:
    root = pathlib.Path(sys.argv[sys.argv.index('-B')+1])
    root.mkdir(parents=True, exist_ok=True)
    (root/'CMakeCache.txt').write_text('external compiler fixture')
elif '--build' in sys.argv:
    root = pathlib.Path(sys.argv[sys.argv.index('--build')+1])
    (root/'bin').mkdir(exist_ok=True)
    shutil.copyfile(os.environ['FIXTURE_ROUTER'], root/'bin/llama-server')
    (root/'bin/llama-server').chmod(0o755)
else:
    print('cmake fixture')
"#,
    )
    .unwrap();
    std::fs::set_permissions(&cmake, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut command = command(root);
    command
        .env(
            "PATH",
            format!(
                "{}:{}",
                root.join("tools").display(),
                std::env::var("PATH").unwrap()
            ),
        )
        .env(
            "FIXTURE_ROUTER",
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/router.py"),
        );
    if root.join("nvml/libnvidia-ml.so.1").exists() {
        command
            .env("LD_LIBRARY_PATH", root.join("nvml"))
            .env("FIXTURE_NVML_STATE", root.join("nvml/allocation"));
    }
    Core::start_command(command).await
}

#[allow(dead_code)]
pub async fn candidate(core: &Core) -> String {
    let client = reqwest::Client::new();
    let response: serde_json::Value = client
        .post(format!("{}/builds", core.url))
        .header("Idempotency-Key", "candidate")
        .json(&serde_json::json!({"profile":"cpu", "jobs":2, "clean":false}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let op: serde_json::Value = client
                .get(format!(
                    "{}/operations/{}",
                    core.url,
                    response["operation_id"].as_str().unwrap()
                ))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_ne!(op["status"], "failed", "{op}");
            if op["status"] == "succeeded" {
                break op["resource_id"].as_str().unwrap().to_string();
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap()
}

impl Drop for Core {
    fn drop(&mut self) {
        if let Some(pid) = self.child.id() {
            // Give the public shutdown path time to clean up owned child processes.
            unsafe {
                libc::kill(pid as i32, libc::SIGINT);
            }
            for _ in 0..100 {
                if self.child.try_wait().ok().flatten().is_some() {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
    }
}

#[allow(dead_code)]
pub async fn apply_candidate(core: &Core) -> String {
    let build = candidate(core).await;
    let response = reqwest::Client::new()
        .post(format!("{}/builds/{build}/apply", core.url))
        .header("Idempotency-Key", "apply")
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let snapshot: serde_json::Value = reqwest::get(format!("{}/runtime", core.url))
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if snapshot["current_build_id"] == build {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    build
}

#[allow(dead_code)]
pub async fn ready(core: &Core, root: &std::path::Path) -> serde_json::Value {
    use serde_json::{Value, json};
    apply_candidate(core).await;
    std::fs::write(
        root.join("data/models/fixture.gguf"),
        "external model fixture",
    )
    .unwrap();
    let client = reqwest::Client::new();
    let source: Value = client.post(format!("{}/preset-files", core.url)).header("Idempotency-Key", "presets")
        .json(&json!({"name":"local.ini","text":"[*]\nmodel=../data/models/fixture.gguf\n[a]\nctx-size=512\n[b]\nctx-size=2048\n"})).send().await.unwrap().json().await.unwrap();
    let response = client
        .post(format!("{}/runtime/switch", core.url))
        .header("Idempotency-Key", "load-a")
        .json(&json!({"preset_id":"a","preset_revision":source["revision"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let state: Value = client
                .get(format!("{}/runtime", core.url))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_ne!(state["state"], "error", "{state}");
            if state["state"] == "ready" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    source
}
