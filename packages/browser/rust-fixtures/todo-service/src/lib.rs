//! An axum CRUD service on tokio-postgres, prebuilt for wasm32-wasip1 — the Rust
//! runtime's exit criterion (PRD 31 §W9 phase 6d). `DATABASE_URL` names the
//! Postgres gateway (PGlite) the application runtime started; `PORT` the port to
//! serve (default 8080).

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tokio::sync::OnceCell;
use tokio_postgres::{Client, Config, NoTls};

#[derive(Clone, Default)]
struct Db(Arc<OnceCell<Client>>);

struct Failure(String);

impl<E: std::fmt::Display> From<E> for Failure {
    fn from(error: E) -> Self {
        Failure(error.to_string())
    }
}

impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        (StatusCode::INTERNAL_SERVER_ERROR, self.0).into_response()
    }
}

impl Db {
    /// The one connection, opened (and the schema created) on first use.
    async fn client(&self) -> Result<&Client, Failure> {
        self.0
            .get_or_try_init(|| async {
                let url = std::env::var("DATABASE_URL").unwrap_or_else(|_| "postgres://postgres@localhost:5432/postgres".into());
                let config: Config = url.parse()?;
                let port = config.get_ports().first().copied().unwrap_or(5432);
                let stream = bfwc_wasi::net::connect(port)?;
                let (client, connection) = config.connect_raw(stream, NoTls).await?;
                bfwc_wasi::spawn(async move {
                    if let Err(error) = connection.await {
                        eprintln!("postgres connection failed: {error}");
                    }
                });
                client
                    .batch_execute("CREATE TABLE IF NOT EXISTS todos (id serial PRIMARY KEY, title text NOT NULL UNIQUE, done boolean NOT NULL DEFAULT false)")
                    .await?;
                println!("connected to postgres on port {port}");
                Ok::<Client, Failure>(client)
            })
            .await
    }
}

#[derive(Serialize)]
struct Todo {
    id: i32,
    title: String,
    done: bool,
}

#[derive(Deserialize)]
struct NewTodo {
    title: String,
}

#[derive(Deserialize)]
struct Change {
    done: bool,
}

async fn health(State(db): State<Db>) -> Result<Json<serde_json::Value>, Failure> {
    let one: i32 = db.client().await?.query_one("SELECT 1", &[]).await?.get(0);
    Ok(Json(serde_json::json!({ "ok": one == 1 })))
}

async fn list(State(db): State<Db>) -> Result<Json<Vec<Todo>>, Failure> {
    let rows = db.client().await?.query("SELECT id, title, done FROM todos ORDER BY id", &[]).await?;
    Ok(Json(rows.iter().map(|row| Todo { id: row.get(0), title: row.get(1), done: row.get(2) }).collect()))
}

async fn create(State(db): State<Db>, Json(todo): Json<NewTodo>) -> Result<(StatusCode, Json<serde_json::Value>), Failure> {
    let id: i32 = db.client().await?.query_one("INSERT INTO todos (title) VALUES ($1) RETURNING id", &[&todo.title]).await?.get(0);
    Ok((StatusCode::CREATED, Json(serde_json::json!({ "id": id }))))
}

async fn update(State(db): State<Db>, Path(id): Path<i32>, Json(change): Json<Change>) -> Result<Json<serde_json::Value>, Failure> {
    let updated = db.client().await?.execute("UPDATE todos SET done = $1 WHERE id = $2", &[&change.done, &id]).await?;
    Ok(Json(serde_json::json!({ "updated": updated })))
}

async fn remove(State(db): State<Db>, Path(id): Path<i32>) -> Result<Json<serde_json::Value>, Failure> {
    let deleted = db.client().await?.execute("DELETE FROM todos WHERE id = $1", &[&id]).await?;
    Ok(Json(serde_json::json!({ "deleted": deleted })))
}

/// Two inserts of one title in a transaction: the second violates the unique key, so it rolls back.
async fn transfer(State(db): State<Db>) -> Result<Response, Failure> {
    let client = db.client().await?;
    client.batch_execute("BEGIN").await?;
    let insert = "INSERT INTO todos (title) VALUES ('in-transaction')";
    let outcome = async {
        client.execute(insert, &[]).await?;
        client.execute(insert, &[]).await
    }
    .await;
    match outcome {
        Ok(_) => {
            client.batch_execute("COMMIT").await?;
            Ok(Json(serde_json::json!({ "committed": true })).into_response())
        }
        Err(error) => {
            client.batch_execute("ROLLBACK").await?;
            let sqlstate = error.code().map(|code| code.code().to_owned());
            Ok((StatusCode::CONFLICT, Json(serde_json::json!({ "rolledBack": true, "sqlstate": sqlstate }))).into_response())
        }
    }
}

fn app() -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/todos", get(list).post(create))
        .route("/todos/{id}", patch(update).delete(remove))
        .route("/transfer", post(transfer))
        .with_state(Db::default())
}

/// The service's entry: the runtime calls it once, after `_initialize`.
#[no_mangle]
pub extern "C" fn bfwc_start() -> i32 {
    let port = std::env::var("PORT").ok().and_then(|port| port.parse().ok()).unwrap_or(8080);
    match bfwc_wasi::serve(port, app()) {
        Ok(()) => {
            println!("listening on http://0.0.0.0:{port}");
            0
        }
        Err(error) => {
            eprintln!("{error}");
            1
        }
    }
}
