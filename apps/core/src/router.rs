use std::{
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::process::{Child, Command};

pub(crate) struct RouterProcess {
    pub child: Child,
    pub url: String,
    pub instance_id: String,
    identity: PathBuf,
}
impl Drop for RouterProcess {
    fn drop(&mut self) {
        if let Some(pid) = self.child.id() {
            // Only the live process group created for this router is signalled.
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
    }
}
impl RouterProcess {
    pub fn exited(&self) -> bool {
        self.child.id().is_none_or(|pid| {
            std::fs::read_to_string(format!("/proc/{pid}/stat"))
                .ok()
                .is_none_or(|s| {
                    s.rsplit_once(") ")
                        .is_none_or(|(_, fields)| fields.starts_with("Z "))
                })
        })
    }

    pub async fn start(root: &Path, build_id: &str, ini: &Path) -> Result<Self, String> {
        let port = std::env::var("CORE_ROUTER_PORT")
            .unwrap_or_else(|_| "8080".into())
            .parse::<u16>()
            .ok().filter(|port| *port != 0)
            .ok_or("CORE_ROUTER_PORT must be an integer from 1 to 65535")?;
        // Do not probe or adopt somebody else's server if the configured port is busy.
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
            .await.map_err(|error| format!("Model server port {port} is unavailable: {error}"))?;
        drop(listener);
        let token = uuid::Uuid::new_v4().to_string();
        let mut child = Command::new(
            root.join("data/builds")
                .join(build_id)
                .join("bin/llama-server"),
        )
        .args([
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--models-preset",
        ])
        .arg(ini)
        .args(["--no-models-autoload", "--models-max", "1"])
        .env("DAEVOX_PROCESS_TOKEN", &token)
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
        let context = serde_json::json!({"build_id":build_id,"instance_id":token});
        crate::logs::capture(
            root,
            "router",
            context.clone(),
            "stdout",
            child.stdout.take().unwrap(),
        );
        crate::logs::capture(
            root,
            "router",
            context,
            "stderr",
            child.stderr.take().unwrap(),
        );
        let identity = crate::processes::record(root, child.id().ok_or("Router exited")?, &token)?;
        let mut router = Self {
            child,
            url: format!("http://127.0.0.1:{port}"),
            instance_id: token,
            identity,
        };
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(1))
            .build()
            .map_err(|e| e.to_string())?;
        tokio::time::timeout(std::time::Duration::from_secs(20), async {
            loop {
                if router
                    .child
                    .try_wait()
                    .map_err(|e| e.to_string())?
                    .is_some()
                {
                    return Err("Router exited before readiness".to_string());
                }
                if let Ok(response) = client.get(format!("{}/health", router.url)).send().await
                    && response.status().is_success()
                {
                    return Ok(());
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        })
        .await
        .map_err(|_| "Router readiness timed out".to_string())??;
        Ok(router)
    }
    pub async fn stop(mut self) -> Result<(), String> {
        let mut descendants = Vec::new();
        if let Some(pid) = self.child.id() {
            let mut pending = crate::processes::children(pid);
            while let Some(process) = pending.pop() {
                pending.extend(crate::processes::children(process.0));
                descendants.push(process);
            }
        }
        let release = self
            .identity
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("releases");
        std::fs::create_dir_all(&release).map_err(|e| e.to_string())?;
        let release = release.join(format!("{}.json", self.instance_id));
        std::fs::write(
            &release,
            serde_json::to_vec(&descendants).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        std::fs::File::open(&release)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
        if let Some(pid) = self.child.id() {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
        self.child.wait().await.map_err(|e| e.to_string())?;
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while !crate::processes::resources_released(&descendants) {
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
        })
        .await
        .map_err(|_| "Owned model resources have not been released".to_string())?;
        let _ = std::fs::remove_file(release);
        let _ = std::fs::remove_file(&self.identity);
        Ok(())
    }
}
