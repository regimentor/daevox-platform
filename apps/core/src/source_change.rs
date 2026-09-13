use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

#[derive(Serialize, Deserialize)]
struct Record {
    key: String,
    name: String,
    before: Option<String>,
    after: Option<String>,
}

pub(crate) struct SourceChange {
    directory: PathBuf,
    journal: PathBuf,
    record: Record,
    finished: bool,
}
impl SourceChange {
    pub fn apply(root: &Path, key: &str, path: &Path, after: Option<&str>) -> io::Result<Self> {
        let directory = root.join("presets");
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| io::Error::other("Invalid source filename"))?
            .to_string();
        let before = read(path)?;
        let record = Record {
            key: key.into(),
            name,
            before,
            after: after.map(str::to_owned),
        };
        let journals = root.join("data/runtime/source-changes");
        fs::create_dir_all(&journals)?;
        let journal = journals.join(format!("{}.json", uuid::Uuid::new_v4()));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&journal)?;
        file.write_all(&serde_json::to_vec(&record)?)?;
        file.sync_all()?;
        fs::File::open(&journals)?.sync_all()?;
        let mut change = Self {
            directory,
            journal,
            record,
            finished: false,
        };
        if let Err(error) = write(path, after) {
            change.finish();
            return Err(error);
        }
        Ok(change)
    }
    pub fn finish(&mut self) {
        self.finished = true;
        let _ = fs::remove_file(&self.journal);
        if let Some(parent) = self.journal.parent() {
            let _ = fs::File::open(parent).and_then(|f| f.sync_all());
        }
    }
    fn rollback(&mut self) -> io::Result<()> {
        let path = self.directory.join(&self.record.name);
        let current = read(&path)?;
        if current != self.record.before {
            if current != self.record.after {
                return Err(io::Error::other(
                    "Source changed externally during interrupted command; reconcile it before startup",
                ));
            }
            write(&path, self.record.before.as_deref())?;
        }
        self.finish();
        Ok(())
    }
}
impl Drop for SourceChange {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.rollback();
        }
    }
}
fn read(path: &Path) -> io::Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}
fn write(path: &Path, text: Option<&str>) -> io::Result<()> {
    if let Some(text) = text {
        let temp = path.with_file_name(format!(".{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)?;
            file.write_all(text.as_bytes())?;
            file.sync_all()?;
            fs::rename(&temp, path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result?;
    } else if path.exists() {
        fs::remove_file(path)?;
    }
    fs::File::open(path.parent().unwrap())?.sync_all()
}
pub(crate) async fn recover(
    root: &Path,
    db: &DatabaseConnection,
) -> Result<(), Box<dyn std::error::Error>> {
    let journals = root.join("data/runtime/source-changes");
    if !journals.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(journals)? {
        let path = entry?.path();
        let record: Record = serde_json::from_slice(&fs::read(&path)?)?;
        if !record.name.ends_with(".ini")
            || record.name.contains(['/', '\\'])
            || record.name.starts_with('.')
        {
            return Err("Invalid source recovery record".into());
        }
        let committed = db
            .query_one(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                "SELECT key FROM request_keys WHERE key=?",
                [record.key.clone().into()],
            ))
            .await?
            .is_some();
        let mut change = SourceChange {
            directory: root.join("presets"),
            journal: path,
            record,
            finished: true,
        };
        if committed {
            change.finish();
        } else {
            change.rollback()?;
        }
    }
    Ok(())
}
