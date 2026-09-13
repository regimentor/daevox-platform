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
    paths: Vec<PathBuf>,
}
pub(crate) struct FileRemoval {
    root: PathBuf,
    directory: PathBuf,
    record: Record,
    finished: bool,
}
impl FileRemoval {
    pub fn new(root: &Path, key: &str) -> io::Result<Self> {
        let directory = root
            .join("data/runtime/removals")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&directory)?;
        Ok(Self {
            root: root.into(),
            directory,
            record: Record {
                key: key.into(),
                paths: vec![],
            },
            finished: false,
        })
    }
    pub fn stage(&mut self, path: &Path) -> io::Result<()> {
        if !path.exists() {
            return Ok(());
        }
        let relative = path
            .strip_prefix(&self.root)
            .map_err(io::Error::other)?
            .to_path_buf();
        if !valid(&relative) {
            return Err(io::Error::other("Invalid removal path"));
        }
        let index = self.record.paths.len();
        self.record.paths.push(relative);
        let temp = self.directory.join("record.tmp");
        let mut file = fs::File::create(&temp)?;
        file.write_all(&serde_json::to_vec(&self.record)?)?;
        file.sync_all()?;
        fs::rename(temp, self.directory.join("record.json"))?;
        fs::File::open(&self.directory)?.sync_all()?;
        fs::File::open(self.directory.parent().unwrap())?.sync_all()?;
        fs::rename(path, self.directory.join(index.to_string()))?;
        fs::File::open(path.parent().unwrap())?.sync_all()?;
        fs::File::open(&self.directory)?.sync_all()
    }
    pub fn finish(&mut self) {
        self.finished = true;
        let _ = fs::remove_dir_all(&self.directory);
    }
    fn rollback(&mut self) -> io::Result<()> {
        for (index, path) in self.record.paths.iter().enumerate().rev() {
            let staged = self.directory.join(index.to_string());
            let original = self.root.join(path);
            if staged.exists() {
                if original.exists() {
                    return Err(io::Error::other(
                        "Removal recovery conflicts with an external file",
                    ));
                }
                fs::rename(staged, &original)?;
                fs::File::open(original.parent().unwrap())?.sync_all()?;
            }
        }
        self.finish();
        Ok(())
    }
}
impl Drop for FileRemoval {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.rollback();
        }
    }
}
fn valid(path: &Path) -> bool {
    (path.starts_with("data/models") || path.starts_with("data/builds"))
        && path
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
}
pub(crate) async fn recover(
    root: &Path,
    db: &DatabaseConnection,
) -> Result<(), Box<dyn std::error::Error>> {
    let removals = root.join("data/runtime/removals");
    if !removals.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(removals)? {
        let directory = entry?.path();
        let record = directory.join("record.json");
        if !record.exists() {
            fs::remove_dir_all(directory)?;
            continue;
        }
        let record: Record = serde_json::from_slice(&fs::read(record)?)?;
        if !record.paths.iter().all(|path| valid(path)) {
            return Err("Invalid removal recovery record".into());
        }
        let committed = db
            .query_one(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                "SELECT key FROM request_keys WHERE key=?",
                [record.key.clone().into()],
            ))
            .await?
            .is_some();
        let mut change = FileRemoval {
            root: root.into(),
            directory,
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
