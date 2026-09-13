use std::{
    fs::{self, File, OpenOptions},
    io,
    path::Path,
};

pub fn lock_data(root: &Path) -> io::Result<File> {
    let runtime = root.join("data/runtime");
    fs::create_dir_all(&runtime)?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(runtime.join("core.lock"))?;
    file.try_lock().map_err(|error| {
        io::Error::other(format!(
            "Core data directory already in use or cannot be locked: {error}"
        ))
    })?;
    Ok(file)
}

use sea_orm::{ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement};
use sea_orm_migration::MigratorTrait;

pub async fn open(root: &Path) -> Result<DatabaseConnection, Box<dyn std::error::Error>> {
    for directory in [
        "backups",
        "models",
        "downloads",
        "builds",
        "generated",
        "logs",
        "runtime",
    ] {
        fs::create_dir_all(root.join("data").join(directory))?;
    }
    fs::create_dir_all(root.join("presets"))?;
    let path = root.join("data/core.sqlite");
    let existing = path.exists();
    let mut options = sea_orm::ConnectOptions::new(format!("sqlite:{}?mode=rwc", path.display()));
    options.max_connections(1).sqlx_logging(false);
    let db = Database::connect(options).await?;
    if !crate::migration::Migrator::get_pending_migrations(&db)
        .await?
        .is_empty()
    {
        if existing {
            let backup = root
                .join("data/backups")
                .join(format!("{}.sqlite", uuid::Uuid::new_v4()));
            db.execute(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                "VACUUM INTO ?",
                [backup.to_string_lossy().to_string().into()],
            ))
            .await?;
        }
        crate::migration::Migrator::up(&db, None).await?;
    }
    db.execute_unprepared("UPDATE operations SET body=json_set(body,'$.status','paused','$.phase','paused','$.pause_requested',json('false'),'$.allowed_actions',json('[\"resume\",\"cancel\"]')) WHERE json_extract(body,'$.type')='download' AND json_extract(body,'$.status') IN ('queued','running','pausing','cancelling'); UPDATE operations SET body=json_set(body,'$.status','interrupted','$.allowed_actions',json('[]'),'$.error',json('{\"code\":\"core_restarted\",\"message\":\"Core restarted before the operation completed\",\"retryable\":true,\"details\":null}')) WHERE json_extract(body,'$.status')='running'; UPDATE builds SET body=json_set(body,'$.status','interrupted') WHERE json_extract(body,'$.status')='building';").await?;
    crate::source_change::recover(root, &db).await?;
    crate::file_removal::recover(root, &db).await?;
    crate::downloads::recover_publications(root, &db).await?;
    crate::commands::prune(&db).await.map_err(|e| e.2)?;
    Ok(db)
}
