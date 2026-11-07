//! 在单次宿主维护回调内扫描历史快照，保存任务与不可变报表
use std::{collections::HashMap, num::NonZeroU32, sync::Arc, time::Duration};

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use gateway_plugin_sdk::{
    ErrorCode, PluginFault,
    call::{
        host::{KeyListRequest, StateGetResult, StatePutResult},
        management::{ManagementRegistration, ManagementRequest, ManagementResponse},
        services::{
            Operation, settings,
            usage::{ScanUsageRecords, UsageReadFilter, UsageReadItem, UsageRecordFilter},
        },
    },
    client::{ComposedPlugin, Empty, HostClient, PluginBuilder, TypedReply, UsageReader, methods},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{
    aggregate::Accumulator,
    model::{Bounds, Configuration, Report, ReportSource, UsageRecord},
};

const SAVE_RESERVE: Duration = Duration::from_secs(5);
const HISTORY_LIMIT: usize = 20;

// settings.load 返回全部设置；只解析报表需要的保留期，不缓存其他宿主设置。
#[derive(Deserialize, Serialize)]
struct UsageRetention {
    usage_retention_days: NonZeroU32,
}

struct ReadUsageRetention;

impl Operation for ReadUsageRetention {
    const NAME: &'static str = <settings::Load as Operation>::NAME;
    type Input = ();
    type Output = UsageRetention;
}

async fn usage_retention_days(host: &HostClient) -> Option<NonZeroU32> {
    // 保留期只用于提示；读取失败不能阻止历史扫描，也不能宣称历史完整。
    tokio::time::timeout(
        Duration::from_secs(2),
        host.service::<ReadUsageRetention>(()),
    )
    .await
    .ok()?
    .ok()
    .map(|settings| settings.usage_retention_days)
}

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<ReportSource>,
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

struct Scan {
    aggregate: Accumulator,
    keys: HashMap<String, usize>,
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

fn host_error(error: PluginFault) -> anyhow::Error {
    anyhow::anyhow!("{:?}: {}", error.code, error.message)
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
        if request.method == "POST" && matches!(request.path.as_str(), "api/tasks" | "api/preview")
        {
            if request.path == "api/tasks" && state.task.as_ref().is_some_and(Task::unfinished) {
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
            if request.path == "api/preview" {
                let retention_days = usage_retention_days(host).await;
                return Ok((
                    200,
                    json!({
                        "bounds":resolved.bounds,"evaluated_at":now,"retention_days":retention_days,
                    }),
                ));
            }
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
                source: None,
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
                    keys: HashMap::new(),
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
        // Reader 绑定本次维护调用；不把活跃句柄保存在跨调用的 State 中。
        let mut reader = None;
        let budget = host
            .remaining_budget()
            .unwrap_or_default()
            .saturating_sub(SAVE_RESERVE);
        let result = tokio::time::timeout(budget, async {
            self.read_keys(host, &mut scan).await?;
            let retention_days = usage_retention_days(host).await;
            let bounds = &scan.aggregate.resolved.bounds;
            reader = Some(
                host.scan_usage_records(ScanUsageRecords {
                    filter: UsageReadFilter {
                        records: UsageRecordFilter {
                            start_ms: bounds.start.timestamp_millis(),
                            end_ms: bounds.end.timestamp_millis(),
                            provider: None,
                            model: None,
                            account_ref: None,
                            client_key_ref: None,
                        },
                        routing_group_ref: None,
                    },
                    batch_size: None,
                })
                .await
                .map_err(host_error)
                .context("Could not open host usage snapshot")?,
            );
            self.read_records(
                reader.as_mut().expect("opened reader"),
                &mut scan,
                retention_days,
            )
            .await
        })
        .await
        .context("Host usage snapshot exceeded the report processing budget")
        .and_then(|result| result);
        // 完整读取后 close 是空操作；提前退出时尽快释放快照和数据库连接。
        let closed = if let Some(reader) = &mut reader {
            tokio::time::timeout(Duration::from_secs(2), reader.close())
                .await
                .context("Closing host usage snapshot timed out")
                .and_then(|result| {
                    result
                        .map_err(host_error)
                        .context("Could not close host usage snapshot")
                })
        } else {
            Ok(())
        };
        let mut state = self.state.lock().await;
        match result.and_then(|source| closed.map(|()| source)) {
            Ok(source) => {
                let id = state
                    .task
                    .as_ref()
                    .context("Missing report task")?
                    .id
                    .clone();
                if let Some(task) = &mut state.task {
                    task.source = Some(source.clone());
                }
                match scan.aggregate.finish(id, Utc::now(), source) {
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

    async fn read_keys(&self, host: &HostClient, scan: &mut Scan) -> Result<()> {
        let mut cursor = None;
        loop {
            let page = host
                .list_keys(KeyListRequest {
                    cursor: cursor.clone(),
                    limit: 100,
                })
                .await
                .map_err(host_error)
                .context("Could not read Client Keys")?;
            if page.next_cursor.is_some() && (page.keys.is_empty() || page.next_cursor == cursor) {
                bail!("Host Key directory did not advance");
            }
            for key in page.keys {
                if key.id.is_empty() || scan.keys.contains_key(&key.id) {
                    bail!("Host Key directory returned an invalid or repeated ID");
                }
                if key.name.trim().is_empty() {
                    continue;
                }
                let index = scan.aggregate.add_key(key.id.clone(), key.name);
                scan.keys.insert(key.id, index);
            }
            if let Some(task) = &mut self.state.lock().await.task {
                task.keys_total = scan.keys.len();
            }
            cursor = page.next_cursor;
            if cursor.is_none() {
                return Ok(());
            }
        }
    }

    async fn read_records(
        &self,
        reader: &mut UsageReader,
        scan: &mut Scan,
        retention_days: Option<NonZeroU32>,
    ) -> Result<ReportSource> {
        let mut snapshot_at = None;
        while let Some(batch) = reader
            .next_batch()
            .await
            .map_err(host_error)
            .context("Could not read host usage snapshot")?
        {
            if snapshot_at.is_none() {
                snapshot_at = Some(
                    DateTime::from_timestamp_millis(batch.observation.generated_at_ms)
                        .context("Host usage snapshot has an invalid observation time")?,
                );
            }
            let count = batch.items.len() as u64;
            for item in batch.items {
                let UsageReadItem::Record(fact) = item else {
                    bail!("Host usage scan returned statistics instead of request facts");
                };
                // 使用宿主的完整交付、预热排除和恢复关联口径。
                if !fact.usage_counted {
                    continue;
                }
                if let Some(key) = scan.keys.get(&fact.data.client_key_ref) {
                    scan.aggregate.add_record(
                        *key,
                        &UsageRecord {
                            started_at: DateTime::from_timestamp_millis(fact.data.started_at_ms)
                                .context("Host usage fact has an invalid start time")?,
                            upstream_model: fact.data.model,
                            requested_model: fact.data.requested_model,
                            reasoning_effort: fact.reasoning_effort,
                            subagent_kind: fact.subagent_kind,
                            user_agent: fact.user_agent,
                        },
                    )?;
                }
            }
            if let Some(task) = &mut self.state.lock().await.task {
                task.records_read = task
                    .records_read
                    .checked_add(count)
                    .context("Read count overflow")?;
            }
        }
        if let Some(task) = &mut self.state.lock().await.task {
            task.keys_processed = scan.keys.len();
        }
        Ok(ReportSource {
            snapshot_at: snapshot_at.context("Host usage snapshot has no observation time")?,
            retention_days,
        })
    }
}

#[cfg(test)]
mod tests;
