use sea_orm_migration::prelude::*;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(Initial),
            Box::new(Commands),
            Box::new(Operations),
            Box::new(Models),
            Box::new(RuntimePreferences),
        ]
    }
}

#[derive(DeriveMigrationName)]
struct Initial;

#[async_trait::async_trait]
impl MigrationTrait for Initial {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(
            "CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
             INSERT INTO settings VALUES (1, '{\"drain_timeout_ms\":300000,\"compiler_jobs\":8,\"revision\":\"initial\"}');"
        ).await?;
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Custom(
            "Destructive rollback is not supported".into(),
        ))
    }
}

struct Commands;
impl MigrationName for Commands {
    fn name(&self) -> &str {
        "m0002_request_keys"
    }
}
#[async_trait::async_trait]
impl MigrationTrait for Commands {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared("CREATE TABLE request_keys (key TEXT PRIMARY KEY, action TEXT NOT NULL, request TEXT NOT NULL, response TEXT NOT NULL, expires_at INTEGER)").await?;
        Ok(())
    }
    async fn down(&self, _: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Custom(
            "Destructive rollback is not supported".into(),
        ))
    }
}

struct Operations;
impl MigrationName for Operations {
    fn name(&self) -> &str {
        "m0003_operations"
    }
}
#[async_trait::async_trait]
impl MigrationTrait for Operations {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared("CREATE TABLE operations (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE builds (id TEXT PRIMARY KEY, body TEXT NOT NULL);").await?;
        Ok(())
    }
    async fn down(&self, _: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Custom(
            "Destructive rollback is not supported".into(),
        ))
    }
}

struct Models;
impl MigrationName for Models {
    fn name(&self) -> &str {
        "m0004_models"
    }
}
#[async_trait::async_trait]
impl MigrationTrait for Models {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared("CREATE TABLE model_sets(id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE model_files(id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE model_set_files(model_set_id TEXT NOT NULL, file_id TEXT NOT NULL, PRIMARY KEY(model_set_id,file_id));").await?;
        Ok(())
    }
    async fn down(&self, _: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Custom(
            "Destructive rollback is not supported".into(),
        ))
    }
}

struct RuntimePreferences;
impl MigrationName for RuntimePreferences {
    fn name(&self) -> &str {
        "m0005_runtime_preferences"
    }
}
#[async_trait::async_trait]
impl MigrationTrait for RuntimePreferences {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "CREATE TABLE runtime_preferences(id TEXT PRIMARY KEY, body TEXT NOT NULL)",
            )
            .await?;
        Ok(())
    }
    async fn down(&self, _: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Custom(
            "Destructive rollback is not supported".into(),
        ))
    }
}
