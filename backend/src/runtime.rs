//! 在宿主维护回调内分页扫描历史，保存任务与不可变报表
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use gateway_plugin_sdk::{
    ErrorCode, PluginFault,
    call::{
        host::{ClientKey, KeyListRequest, StateGetResult, StatePutResult},
        management::{ManagementRegistration, ManagementRequest, ManagementResponse},
        middleware::http::Version,
    },
    client::{
        ComposedPlugin, Empty, HostClient, HttpBody, HttpFrame, HttpRequest, PluginBuilder,
        TypedReply, methods,
    },
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{
    aggregate::Accumulator,
    model::{Bounds, Configuration, Report, UsageRecord},
};

const CHUNK_TIME: Duration = Duration::from_secs(18);
const READ_TIMEOUT: Duration = Duration::from_secs(8);
const HISTORY_LIMIT: usize = 20;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    Queued,
    Running,
    Complete,
    Failed,
    Interrupted,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub configuration: Configuration,
    pub bounds: Bounds,
    pub submitted_at: DateTime<Utc>,
    pub state: TaskState,
    pub keys_processed: usize,
    pub keys_total: usize,
    pub records_read: u64,
    pub report_id: Option<String>,
    pub error: Option<String>,
}

impl Task {
    fn unfinished(&self) -> bool {
        matches!(self.state, TaskState::Queued | TaskState::Running)
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Summary {
    id: String,
    created_at: DateTime<Utc>,
    total_requests: u64,
    keys_count: usize,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct Index {
    reports: Vec<Summary>,
    garbage: Vec<String>,
}

enum Position {
    Directory {
        cursor: Option<String>,
    },
    History {
        key: usize,
        page: u32,
        total: Option<u64>,
    },
}

struct Scan {
    aggregate: Accumulator,
    keys: Vec<ClientKey>,
    position: Position,
}

struct PendingSubmission {
    task_id: String,
    scan: Scan,
}

#[derive(Default)]
struct State {
    initialized: bool,
    task: Option<Task>,
    task_version: Option<u64>,
    index: Index,
    index_version: Option<u64>,
    scan: Option<Scan>,
    pending_submission: Option<PendingSubmission>,
}

#[derive(Default)]
struct Runtime {
    state: Mutex<State>,
}

pub fn plugin() -> Result<ComposedPlugin> {
    let registration: ManagementRegistration =
        serde_json::from_slice(include_bytes!("../../dist/plugin/management.json"))?;
    let runtime = Arc::new(Runtime::default());
    let maintenance = runtime.clone();
    Ok(
        PluginBuilder::from_json(include_bytes!("../../plugin.json"))?
            .on(methods::RECONCILE, move |call| {
                let runtime = maintenance.clone();
                async move {
                    // 在宿主截止前返回，初始化与发布也计入预算
                    let budget = Duration::from_millis(call.context.timeout_ms)
                        .saturating_sub(Duration::from_millis(500));
                    tokio::time::timeout(budget, runtime.reconcile(&call.host))
                        .await
                        .context("Maintenance callback exceeded its processing budget")
                        .map_err(fault)?
                        .map_err(fault)?;
                    Ok(TypedReply::new(Empty {}))
                }
            })?
            .management(registration, move |call| {
                let runtime = runtime.clone();
                async move {
                    let (status, body) = runtime
                        .management(&call.host, &call.request, &call.payload)
                        .await;
                    Ok(TypedReply::new(ManagementResponse {
                        status,
                        content_type: "application/json".into(),
                        headers: vec![],
                    })
                    .with_payload(serde_json::to_vec(&body).map_err(|error| fault(error.into()))?))
                }
            })?
            .build()?,
    )
}

fn fault(error: anyhow::Error) -> PluginFault {
    PluginFault::new(ErrorCode::Fault, error.to_string())
}

async fn callback<T: DeserializeOwned>(
    host: &HostClient,
    method: &str,
    params: Value,
) -> Result<T> {
    let reply = host
        .call(method, params, vec![])
        .await
        .context("Host callback failed")?;
    if !reply.payload.is_empty() {
        bail!("Unexpected host callback payload");
    }
    serde_json::from_value(reply.result).context("Invalid host callback response")
}

async fn get<T: DeserializeOwned>(
    host: &HostClient,
    namespace: &str,
    key: &str,
) -> Result<Option<(T, u64)>> {
    let result: StateGetResult = callback(
        host,
        "host.state.get",
        json!({"namespace":namespace,"key":key}),
    )
    .await?;
    result
        .record
        .map(|record| Ok((serde_json::from_value(record.value)?, record.version)))
        .transpose()
}

async fn put<T: Serialize>(
    host: &HostClient,
    namespace: &str,
    key: &str,
    value: &T,
    version: &mut Option<u64>,
) -> Result<()> {
    let requested = serde_json::to_value(value)?;
    let result: Result<StatePutResult> = callback(
        host,
        "host.state.put",
        json!({"namespace":namespace,"key":key,"value":requested,"expected_version":version}),
    )
    .await;
    match result {
        Ok(result) => {
            *version = Some(result.version);
            Ok(())
        }
        Err(error) => {
            // 应答丢失时，完全相同的持久化值可证明这次写入已生效。
            if let Ok(Some((persisted, persisted_version))) =
                get::<Value>(host, namespace, key).await
                && persisted == requested
            {
                *version = Some(persisted_version);
                return Ok(());
            }
            Err(error)
        }
    }
}

async fn delete_report(host: &HostClient, id: &str) -> Result<()> {
    if let Some((_, version)) = get::<Value>(host, "reports", id).await? {
        let _: Value = callback(
            host,
            "host.state.delete",
            json!({"namespace":"reports","key":id,"expected_version":version}),
        )
        .await?;
    }
    Ok(())
}

impl State {
    async fn recover_submission(&mut self, host: &HostClient) -> Result<()> {
        if self.pending_submission.is_none() {
            return Ok(());
        }
        let persisted = get::<Task>(host, "control", "task").await?;
        let pending = self.pending_submission.take().expect("pending submission");
        // 只有持久化任务与待确认提交一致时，才接续尚未开始的扫描
        self.scan = persisted.as_ref().and_then(|(task, _)| {
            (task.id == pending.task_id && task.unfinished()).then_some(pending.scan)
        });
        (self.task, self.task_version) = persisted
            .map(|(task, version)| (Some(task), Some(version)))
            .unwrap_or_default();
        Ok(())
    }

    async fn initialize(&mut self, host: &HostClient) -> Result<()> {
        if self.initialized {
            return self.recover_submission(host).await;
        }
        if let Some((index, version)) = get(host, "control", "index").await? {
            self.index = index;
            self.index_version = Some(version);
        }
        if let Some((task, version)) = get::<Task>(host, "control", "task").await? {
            self.task = Some(task);
            self.task_version = Some(version);
        }
        if let Some(task) = &self.task {
            // 索引写入前退出或写入结果不明时，可能留下尚未发布的完整报表。
            if !self.index.reports.iter().any(|report| report.id == task.id) {
                delete_report(host, &task.id).await?;
            }
        }
        if let Some(mut task) = self.task.clone()
            && task.unfinished()
        {
            task.state = TaskState::Interrupted;
            task.error = Some("Report generation was interrupted by a plugin restart. Submit again to start a fresh scan.".into());
            let mut version = self.task_version;
            put(host, "control", "task", &task, &mut version).await?;
            self.task = Some(task);
            self.task_version = version;
        }
        self.cleanup(host).await?;
        self.initialized = true;
        Ok(())
    }

    async fn cleanup(&mut self, host: &HostClient) -> Result<()> {
        if self.index.garbage.is_empty() {
            return Ok(());
        }
        for id in &self.index.garbage {
            delete_report(host, id).await?;
        }
        self.index.garbage.clear();
        put(
            host,
            "control",
            "index",
            &self.index,
            &mut self.index_version,
        )
        .await
    }

    async fn save_task(&mut self, host: &HostClient) -> Result<()> {
        put(host, "control", "task", &self.task, &mut self.task_version).await
    }
}

impl Runtime {
    async fn management(
        &self,
        host: &HostClient,
        request: &ManagementRequest,
        body: &[u8],
    ) -> (u16, Value) {
        match self.handle_management(host, request, body).await {
            Ok(response) => response,
            Err(error) => (503, json!({"error":{"message":error.to_string()}})),
        }
    }

    async fn handle_management(
        &self,
        host: &HostClient,
        request: &ManagementRequest,
        body: &[u8],
    ) -> Result<(u16, Value)> {
        let mut state = self.state.lock().await;
        state.initialize(host).await?;
        if request.method == "GET" && request.path == "api/task" {
            return Ok((200, json!({"task":state.task})));
        }
        if request.method == "GET" && request.path == "api/reports" {
            return Ok((200, json!({"reports":state.index.reports})));
        }
        if request.method == "GET" && request.path == "api/reports/detail" {
            let params: Vec<_> = url::form_urlencoded::parse(request.query.as_bytes()).collect();
            if params.len() != 1 || params[0].0 != "id" {
                return Ok((400, json!({"error":{"message":"Expected one report id"}})));
            }
            let id = params[0].1.as_ref();
            if !state.index.reports.iter().any(|report| report.id == id) {
                return Ok((404, json!({"error":{"message":"Report not found"}})));
            }
            let (report, _) = get::<Report>(host, "reports", id)
                .await?
                .context("Saved report unavailable")?;
            return Ok((200, json!({"report":report})));
        }
        if request.method == "POST" && request.path == "api/tasks" {
            if state.task.as_ref().is_some_and(Task::unfinished) {
                return Ok((
                    409,
                    json!({"error":{"message":"A report task is already in progress"}}),
                ));
            }
            if !request.query.is_empty() || body.len() > 32 * 1024 {
                return Ok((
                    400,
                    json!({"error":{"message":"Invalid or oversized report configuration (maximum 32 KiB)"}}),
                ));
            }
            let now = Utc::now();
            let resolved = match serde_json::from_slice::<Configuration>(body)
                .map_err(anyhow::Error::from)
                .and_then(|configuration| configuration.resolve(now))
            {
                Ok(resolved) => resolved,
                Err(error) => return Ok((400, json!({"error":{"message":format!("{error:#}")}}))),
            };
            if let Some(previous) = &state.task {
                let previous_id = previous.id.clone();
                // 上次索引写入的应答可能丢失，重新读取后才能判断数据是否尚未发布。
                let persisted = get::<Index>(host, "control", "index").await?;
                let (index, version) = persisted
                    .map(|(index, version)| (index, Some(version)))
                    .unwrap_or_default();
                if !index.reports.iter().any(|report| report.id == previous_id) {
                    delete_report(host, &previous_id).await?;
                }
                state.index = index;
                state.index_version = version;
            }
            let task = Task {
                id: Uuid::new_v4().to_string(),
                configuration: resolved.configuration.clone(),
                bounds: resolved.bounds.clone(),
                submitted_at: now,
                state: TaskState::Queued,
                keys_processed: 0,
                keys_total: 0,
                records_read: 0,
                report_id: None,
                error: None,
            };
            // 写入前保留待确认提交，父调用取消或恢复读取失败时由下一次调用确认结果
            state.pending_submission = Some(PendingSubmission {
                task_id: task.id.clone(),
                scan: Scan {
                    aggregate: Accumulator::new(resolved),
                    keys: vec![],
                    position: Position::Directory { cursor: None },
                },
            });
            let mut version = state.task_version;
            put(host, "control", "task", &task, &mut version).await?;
            state.task_version = version;
            state.task = Some(task.clone());
            state.scan = Some(
                state
                    .pending_submission
                    .take()
                    .expect("pending submission")
                    .scan,
            );
            return Ok((202, json!({"task":task})));
        }
        Ok((404, json!({"error":{"message":"Route not found"}})))
    }

    async fn reconcile(&self, host: &HostClient) -> Result<()> {
        let start = Instant::now();
        let mut scan = {
            let mut state = self.state.lock().await;
            state.initialize(host).await?;
            let Some(scan) = state.scan.take() else {
                if state.task.as_ref().is_some_and(Task::unfinished) {
                    Self::fail(
                        &mut state,
                        anyhow::anyhow!(
                            "The previous maintenance call was interrupted. Submit again to start a fresh scan."
                        ),
                    );
                    state.save_task(host).await?;
                }
                return Ok(());
            };
            if let Some(task) = &mut state.task {
                task.state = TaskState::Running;
            }
            if let Err(error) = state.save_task(host).await {
                state.scan = Some(scan);
                return Err(error);
            }
            scan
        };
        let result = async {
            while start.elapsed() < CHUNK_TIME {
                let done = tokio::time::timeout(READ_TIMEOUT, self.step(host, &mut scan))
                    .await
                    .context("Host history read timed out")??;
                if done {
                    return Ok(true);
                }
            }
            Ok::<_, anyhow::Error>(false)
        }
        .await;
        let mut state = self.state.lock().await;
        match result {
            Ok(false) => {
                state.scan = Some(scan);
            }
            Ok(true) => {
                let id = state
                    .task
                    .as_ref()
                    .context("Missing report task")?
                    .id
                    .clone();
                match scan.aggregate.finish(id, Utc::now()) {
                    Ok(report) => {
                        if let Err(error) = self.publish(host, &mut state, report).await {
                            Self::fail(&mut state, error);
                        }
                    }
                    Err(error) => Self::fail(&mut state, error),
                }
            }
            Err(error) => Self::fail(&mut state, error),
        }
        state.save_task(host).await
    }

    fn fail(state: &mut State, error: anyhow::Error) {
        if let Some(task) = &mut state.task {
            task.state = TaskState::Failed;
            task.error = Some(format!("{error:#}"));
        }
    }

    async fn publish(
        &self,
        host: &HostClient,
        state: &mut State,
        report: Option<Report>,
    ) -> Result<()> {
        if let Some(report) = report {
            state.cleanup(host).await?;
            let summary = Summary {
                id: report.id.clone(),
                created_at: report.created_at,
                total_requests: report
                    .keys
                    .iter()
                    .flat_map(|key| &key.groups)
                    .map(|group| group.requests)
                    .sum(),
                keys_count: report.keys.len(),
            };
            let mut version = None;
            put(host, "reports", &report.id, &report, &mut version).await?;
            let mut index = state.index.clone();
            let mut index_version = state.index_version;
            index.reports.insert(0, summary);
            if index.reports.len() > HISTORY_LIMIT {
                let oldest = index.reports.pop().expect("nonempty index");
                index.garbage.push(oldest.id);
            }
            if let Err(error) = put(host, "control", "index", &index, &mut index_version).await {
                // RPC 失败不能证明写入未提交；先读取持久化索引，再决定能否清理数据。
                let persisted = get::<Index>(host, "control", "index").await?;
                let (persisted, persisted_version) = persisted
                    .map(|(index, version)| (index, Some(version)))
                    .unwrap_or_default();
                let published = persisted.reports.iter().any(|item| item.id == report.id);
                state.index = persisted;
                state.index_version = persisted_version;
                if !published {
                    let _ = delete_report(host, &report.id).await;
                    return Err(error);
                }
            } else {
                state.index = index;
                state.index_version = index_version;
            }
            if let Some(task) = &mut state.task {
                task.report_id = Some(report.id);
            }
            // 索引已发布；清理失败交给下次维护处理，不撤销完整报表
            let _ = state.cleanup(host).await;
        }
        if let Some(task) = &mut state.task {
            task.state = TaskState::Complete;
        }
        Ok(())
    }

    async fn step(&self, host: &HostClient, scan: &mut Scan) -> Result<bool> {
        match &scan.position {
            Position::Directory { cursor } => {
                let page = host
                    .list_keys(KeyListRequest {
                        cursor: cursor.clone(),
                        limit: 100,
                    })
                    .await
                    .map_err(|_| anyhow::anyhow!("Could not read Client Keys"))?;
                if page.next_cursor.is_some()
                    && (page.keys.is_empty() || page.next_cursor == *cursor)
                {
                    bail!("Host Key directory did not advance");
                }
                for key in page.keys {
                    if key.id.is_empty() || scan.keys.iter().any(|seen| seen.id == key.id) {
                        bail!("Host Key directory returned an invalid or repeated ID");
                    }
                    if key.name.trim().is_empty() {
                        continue;
                    }
                    scan.aggregate.add_key(key.id.clone(), key.name.clone());
                    scan.keys.push(key);
                }
                let mut state = self.state.lock().await;
                if let Some(task) = &mut state.task {
                    task.keys_total = scan.keys.len();
                }
                if let Some(cursor) = page.next_cursor {
                    scan.position = Position::Directory {
                        cursor: Some(cursor),
                    };
                } else {
                    scan.position = Position::History {
                        key: 0,
                        page: 1,
                        total: None,
                    };
                }
            }
            Position::History { key, page, total } => {
                let Some(client_key) = scan.keys.get(*key) else {
                    return Ok(true);
                };
                let response =
                    read_page(host, &client_key.id, *page, &scan.aggregate.resolved.bounds).await?;
                if response.current_page != *page
                    || response.page_size != 100
                    || response.items.len() > 100
                {
                    bail!("Invalid host history page");
                }
                if total.is_some_and(|expected| expected != response.total) {
                    bail!("Host history changed during report generation");
                }
                let offset = u64::from(*page - 1) * 100;
                let expected = response.total.saturating_sub(offset).min(100) as usize;
                if response.items.len() != expected || offset > response.total {
                    bail!("Incomplete host history page");
                }
                let mut ids = std::collections::HashSet::new();
                for record in &response.items {
                    if !ids.insert(&record.id) {
                        bail!("Repeated request in host history page");
                    }
                    scan.aggregate.add_record(*key, record)?;
                }
                let done = offset + response.items.len() as u64 >= response.total;
                let mut state = self.state.lock().await;
                if let Some(task) = &mut state.task {
                    task.records_read += response.items.len() as u64;
                    if done {
                        task.keys_processed += 1;
                    }
                }
                scan.position = if done {
                    Position::History {
                        key: *key + 1,
                        page: 1,
                        total: None,
                    }
                } else {
                    Position::History {
                        key: *key,
                        page: page.checked_add(1).context("History page overflow")?,
                        total: Some(response.total),
                    }
                };
            }
        }
        Ok(false)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    items: Vec<UsageRecord>,
    current_page: u32,
    page_size: u16,
    total: u64,
}

#[derive(Deserialize)]
struct Envelope {
    code: i32,
    data: Page,
}

async fn read_page(host: &HostClient, key: &str, page: u32, bounds: &Bounds) -> Result<Page> {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("status", "success")
        .append_pair("clientApiKeyId", key)
        .append_pair("currentPage", &page.to_string())
        .append_pair("pageSize", "100")
        .append_pair("startTime", &bounds.start.to_rfc3339())
        .append_pair("endTime", &bounds.end.to_rfc3339())
        .finish();
    let mut response = host
        .dispatch_http(HttpRequest {
            settings: Value::Null,
            method: "GET".into(),
            uri: format!("/api/admin/usage/records?{query}"),
            version: Version::Http11,
            headers: vec![],
            timeout_ms: Some(8000),
            body: HttpBody::empty(),
        })
        .await
        .map_err(|_| anyhow::anyhow!("Could not dispatch host history query"))?;
    if response.status != 200 {
        let _ = response.body.close().await;
        bail!("Host history query returned HTTP {}", response.status);
    }
    let mut bytes = Vec::new();
    while let Some(frame) = response
        .body
        .read()
        .await
        .map_err(|_| anyhow::anyhow!("Could not read host history response"))?
    {
        if let HttpFrame::Data(data) = frame {
            if bytes.len() + data.len() > 16 * 1024 * 1024 {
                let _ = response.body.close().await;
                bail!("Host history page exceeds 16 MiB");
            }
            bytes.extend(data);
        }
    }
    let envelope: Envelope =
        serde_json::from_slice(&bytes).context("Invalid host history response")?;
    if envelope.code != 200 {
        bail!("Host history query failed");
    }
    Ok(envelope.data)
}

#[cfg(test)]
mod tests;
