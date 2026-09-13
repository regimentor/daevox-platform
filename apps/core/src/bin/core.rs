use std::{env, future::IntoFuture, net::Ipv4Addr};
use tokio::net::TcpListener;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Set the public-Hub policy before starting any Tokio worker threads.
    unsafe {
        env::set_var("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1");
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run())
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    if env::args().nth(1).as_deref() == Some("download-worker") {
        let manifest = env::args_os().nth(2).ok_or("Worker manifest is required")?;
        return daevox_core::download_worker::run(std::path::Path::new(&manifest)).await;
    }
    let root = env::var_os("CORE_APP_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    let _lock = daevox_core::storage::lock_data(&root)?;
    let port: u16 = env::var("CORE_PORT")
        .map_err(|_| "Set CORE_PORT to the local HTTP port for core")?
        .parse()?;
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await?;
    let (app, shutdown) = daevox_core::controlled_app(&root).await?;
    eprintln!("Core listening on http://{}", listener.local_addr()?);
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    {
        let server = axum::serve(listener, app).into_future();
        tokio::pin!(server);
        tokio::select! {
            result=&mut server => result?,
            _=tokio::signal::ctrl_c()=>{},
            _=terminate.recv()=>{},
        }
    }
    shutdown.stop().await?;
    Ok(())
}
