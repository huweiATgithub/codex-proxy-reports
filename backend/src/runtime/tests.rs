//! 通过真实 SDK 双工会话验证任务互斥、宿主分页与版本化发布，不连接生产宿主。

use super::*;
use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex as StdMutex,
};

use gateway_plugin_sdk::client::{
    CallFuture, CallReply, PluginCall, PluginHandler, PluginSession, SessionConfig, SessionError,
    read_frame, write_frame,
};
use gateway_plugin_sdk::{
    CallContext, Contributions, Frame, Handshake, Message, PROTOCOL_VERSION, Stage,
};
use tokio::{
    io::{DuplexStream, WriteHalf},
    sync::mpsc,
    task::JoinHandle,
};

struct Handler(Arc<Runtime>);

impl PluginHandler for Handler {
    fn call(&self, call: PluginCall) -> CallFuture<'_> {
        Box::pin(async move {
            if call.method == "test.reconcile" {
                self.0.reconcile(&call.host).await.map_err(fault)?;
                return Ok(CallReply::unary(json!({}), vec![]));
            }
            let request: ManagementRequest =
                serde_json::from_value(call.params).map_err(|error| fault(error.into()))?;
            let (status, body) = self.0.management(&call.host, &request, &call.payload).await;
            Ok(CallReply::unary(
                json!({"status":status,"body":body}),
                vec![],
            ))
        })
    }
}

#[derive(Default)]
struct MockStore {
    values: HashMap<(String, String), (Value, u64)>,
    keys: Vec<Value>,
    records: HashMap<String, Vec<Value>>,
    missing_detail: Option<String>,
    bodies: HashMap<String, VecDeque<Vec<u8>>>,
    calls: Vec<(String, Value)>,
    failures: Vec<Failure>,
    key_page_size: usize,
    sequence: u64,
}

struct Failure {
    method: &'static str,
    namespace: Option<&'static str>,
    key: Option<&'static str>,
    state: Option<&'static str>,
    page: Option<u32>,
    after_commit: bool,
}

impl Failure {
    fn put(key: &'static str) -> Self {
        Self {
            method: "host.state.put",
            namespace: Some("control"),
            key: Some(key),
            state: None,
            page: None,
            after_commit: false,
        }
    }

    fn matches(&self, method: &str, params: &Value) -> bool {
        method == self.method
            && self
                .namespace
                .is_none_or(|value| params["namespace"] == value)
            && self.key.is_none_or(|value| params["key"] == value)
            && self
                .state
                .is_none_or(|value| params["value"]["state"] == value)
            && self
                .page
                .is_none_or(|value| query(params).get("currentPage") == Some(&value.to_string()))
    }
}

fn query(params: &Value) -> HashMap<String, String> {
    let uri = params["uri"].as_str().unwrap_or_default();
    url::form_urlencoded::parse(
        uri.split_once('?')
            .map(|(_, query)| query)
            .unwrap_or_default()
            .as_bytes(),
    )
    .into_owned()
    .collect()
}

fn injected() -> PluginFault {
    PluginFault::new(ErrorCode::Fault, "injected host failure")
}

impl MockStore {
    fn fixture() -> Self {
        let mut mock = Self {
            key_page_size: 100,
            ..Self::default()
        };
        mock.keys
            .push(json!({"id":"key-1","name":"Client One","enabled":true}));
        mock.records.insert("key-1".into(), vec![row("request-1")]);
        mock
    }

    fn value(&self, namespace: &str, key: &str) -> Option<&Value> {
        self.values
            .get(&(namespace.into(), key.into()))
            .map(|(value, _)| value)
    }

    fn seed(&mut self, namespace: &str, key: &str, value: Value) {
        self.values
            .insert((namespace.into(), key.into()), (value, 1));
    }

    fn callback(
        &mut self,
        method: &str,
        params: &Value,
    ) -> std::result::Result<(Value, Vec<u8>), PluginFault> {
        self.calls.push((method.into(), params.clone()));
        let failure = self
            .failures
            .iter()
            .position(|failure| failure.matches(method, params))
            .map(|index| self.failures.remove(index));
        if failure
            .as_ref()
            .is_some_and(|failure| !failure.after_commit)
        {
            return Err(injected());
        }
        let result = self.perform(method, params)?;
        if failure.is_some() {
            return Err(injected());
        }
        Ok(result)
    }

    fn perform(
        &mut self,
        method: &str,
        params: &Value,
    ) -> std::result::Result<(Value, Vec<u8>), PluginFault> {
        let address = || {
            (
                params["namespace"].as_str().unwrap().into(),
                params["key"].as_str().unwrap().into(),
            )
        };
        let value = match method {
            "host.state.get" => {
                json!({"record":self.values.get(&address()).map(|(value,version)|json!({"value":value,"version":version,"schema_version":1}))})
            }
            "host.state.put" => {
                let expected = params["expected_version"].as_u64();
                let actual = self.values.get(&address()).map(|(_, version)| *version);
                if expected != actual {
                    return Err(PluginFault::new(ErrorCode::Conflict, "state CAS conflict"));
                }
                let version = actual.unwrap_or(0) + 1;
                self.values
                    .insert(address(), (params["value"].clone(), version));
                json!({"version":version})
            }
            "host.state.delete" => {
                let actual = self.values.get(&address()).map(|(_, version)| *version);
                if actual != params["expected_version"].as_u64() {
                    return Err(PluginFault::new(ErrorCode::Conflict, "delete CAS conflict"));
                }
                let deleted = self.values.remove(&address()).is_some();
                json!({"deleted":deleted})
            }
            "host.keys.list" => {
                let offset = params["cursor"]
                    .as_str()
                    .map(|cursor| cursor.parse::<usize>().unwrap())
                    .unwrap_or(0);
                let limit = (params["limit"].as_u64().unwrap() as usize).min(self.key_page_size);
                let end = (offset + limit).min(self.keys.len());
                json!({"keys":self.keys[offset..end],"next_cursor":(end<self.keys.len()).then(||end.to_string())})
            }
            "host.http.dispatch" => {
                let detail = params["uri"]
                    .as_str()
                    .unwrap()
                    .starts_with("/api/admin/usage/records/detail?");
                let params = query(params);
                let data = if detail {
                    assert_eq!(params.len(), 1);
                    if self.missing_detail.as_ref() == Some(&params["id"]) {
                        return Err(injected());
                    }
                    let (key, record) = self
                        .records
                        .iter()
                        .find_map(|(key, records)| {
                            records
                                .iter()
                                .find(|record| record["id"] == params["id"])
                                .map(|record| (key, record))
                        })
                        .ok_or_else(injected)?;
                    let mut detail = record.clone();
                    detail["clientApiKeyId"] = json!(key);
                    detail
                } else {
                    // v3.31 rejects ID filters; list names are historical snapshots.
                    assert_eq!(params.len(), 5);
                    assert_eq!(params["status"], "success");
                    assert_eq!(params["pageSize"], "100");
                    assert_eq!(params["startTime"], "2026-10-01T00:00:00+00:00");
                    assert_eq!(params["endTime"], "2026-10-02T00:00:00+00:00");
                    let mut records: Vec<_> = self.records.values().flatten().collect();
                    records.sort_by_key(|record| record["id"].as_str().unwrap());
                    let page = params["currentPage"].parse::<usize>().unwrap();
                    let start = ((page - 1) * 100).min(records.len());
                    let end = (start + 100).min(records.len());
                    json!({"items":records[start..end],"currentPage":page,"pageSize":100,"total":records.len()})
                };
                // 宿主 AdminEnvelope 的成功码为 200，不能使用常见的 0 约定。
                let bytes =
                    serde_json::to_vec(&json!({"code":200,"message":"OK","data":data})).unwrap();
                self.sequence += 1;
                let handle = format!("body-{}", self.sequence);
                self.bodies.insert(
                    handle.clone(),
                    bytes
                        .chunks(16 * 1024)
                        .map(|chunk| chunk.to_vec())
                        .collect(),
                );
                json!({"status":200,"version":"HTTP/1.1","headers":[],"body":{"kind":"handle","handle":handle},"response":null,"session":false})
            }
            "host.http.body_read" => {
                let body = self
                    .bodies
                    .get_mut(params["handle"].as_str().unwrap())
                    .unwrap();
                return Ok(match body.pop_front() {
                    Some(bytes) => (json!({"eof":false,"trailers":null}), bytes),
                    None => (json!({"eof":true,"trailers":null}), vec![]),
                });
            }
            "host.http.body_close" => {
                self.bodies.remove(params["handle"].as_str().unwrap());
                json!({})
            }
            _ => panic!("Unexpected host callback: {method}"),
        };
        Ok((value, vec![]))
    }
}

struct Harness {
    writer: Arc<Mutex<WriteHalf<DuplexStream>>>,
    replies: mpsc::UnboundedReceiver<Frame>,
    session: JoinHandle<std::result::Result<(), SessionError>>,
    peer: JoinHandle<()>,
    runtime: Arc<Runtime>,
    next_id: u64,
}

impl Harness {
    async fn new(store: Arc<StdMutex<MockStore>>) -> Self {
        let runtime = Arc::new(Runtime::default());
        let handler = Handler(runtime.clone());
        let (host, plugin) = tokio::io::duplex(128 * 1024);
        let (plugin_reader, plugin_writer) = tokio::io::split(plugin);
        let session = tokio::spawn(async move {
            PluginSession::accept(
                plugin_reader,
                plugin_writer,
                SessionConfig {
                    maximum_stream_chunk_bytes: 64 * 1024,
                    maximum_calls: 8,
                    maximum_callbacks: 8,
                    maximum_buffered_stream_chunks: 16,
                    handshake_timeout: Duration::from_secs(2),
                    maximum_call_timeout: Duration::from_secs(30),
                },
            )
            .await?
            .run(handler)
            .await
        });
        let (mut reader, mut writer) = tokio::io::split(host);
        write_frame(
            &mut writer,
            &Frame::control(Message::Hello {
                handshake: Handshake {
                    protocol_version: PROTOCOL_VERSION,
                    artifact_sha256: "a".repeat(64),
                    plugin_id: "reports.test".into(),
                    instance_id: "reports-instance".into(),
                    generation: 1,
                    incarnation: "reports-incarnation".into(),
                    configuration: json!({}),
                    contributes: Contributions::new(),
                },
            }),
        )
        .await
        .unwrap();
        assert!(matches!(
            read_frame(&mut reader).await.unwrap().message,
            Message::Ready { .. }
        ));
        let writer = Arc::new(Mutex::new(writer));
        let (tx, replies) = mpsc::unbounded_channel();
        let callback_writer = writer.clone();
        let callback_store = store.clone();
        let peer = tokio::spawn(async move {
            while let Ok(frame) = read_frame(&mut reader).await {
                if let Message::Callback {
                    id, method, params, ..
                } = frame.message
                {
                    let response = callback_store.lock().unwrap().callback(&method, &params);
                    let frame = match response {
                        Ok((result, payload)) => Frame {
                            message: Message::Result { id, result },
                            payload,
                        },
                        Err(error) => Frame::control(Message::Error { id, error }),
                    };
                    if write_frame(&mut *callback_writer.lock().await, &frame)
                        .await
                        .is_err()
                    {
                        break;
                    }
                } else if tx.send(frame).is_err() {
                    break;
                }
            }
        });
        Self {
            writer,
            replies,
            session,
            peer,
            runtime,
            next_id: 1,
        }
    }

    async fn send(&mut self, method: &str, path: &str, body: Vec<u8>) -> u64 {
        let id = self.next_id;
        self.next_id += 2;
        let params = if method == "RECONCILE" {
            json!({})
        } else {
            json!({"method":method,"path":path,"query":"","content_type":Some("application/json"),"headers":[]})
        };
        let frame = Frame {
            message: Message::Call {
                id,
                method: if method == "RECONCILE" {
                    "test.reconcile"
                } else {
                    "test.management"
                }
                .into(),
                context: CallContext {
                    request: None,
                    call_id: id,
                    instance_id: "reports-instance".into(),
                    generation: 1,
                    incarnation: "reports-incarnation".into(),
                    stage: Stage::Request,
                    timeout_ms: 30_000,
                    resource_stream: false,
                    resource_scope_id: format!("scope-{id}"),
                    request_id: None,
                    attempt_id: None,
                    account_id: None,
                    credential_revision: None,
                },
                params,
            },
            payload: body,
        };
        write_frame(&mut *self.writer.lock().await, &frame)
            .await
            .unwrap();
        id
    }

    async fn receive(&mut self) -> Frame {
        tokio::time::timeout(Duration::from_secs(3), self.replies.recv())
            .await
            .expect("runtime response timeout")
            .expect("session closed")
    }

    async fn request(&mut self, method: &str, path: &str, body: Vec<u8>) -> Value {
        let id = self.send(method, path, body).await;
        match self.receive().await.message {
            Message::Result {
                id: reply_id,
                result,
            } => {
                assert_eq!(reply_id, id);
                result
            }
            message => panic!("Unexpected runtime response: {message:?}"),
        }
    }

    async fn submit(&mut self) -> Value {
        self.request("POST", "api/tasks", configuration()).await
    }

    async fn task(&mut self) -> Value {
        self.request("GET", "api/task", vec![]).await["body"]["task"].clone()
    }

    async fn reconcile(&mut self) {
        self.request("RECONCILE", "", vec![]).await;
    }

    async fn shutdown(self) {
        write_frame(
            &mut *self.writer.lock().await,
            &Frame::control(Message::Shutdown),
        )
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(2), self.session)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        self.peer.abort();
    }
}

fn configuration() -> Vec<u8> {
    serde_json::to_vec(&Configuration {
        window: crate::model::Window::Custom {
            start_date: "2026-10-01".into(),
            end_date: "2026-10-01".into(),
        },
        ..Configuration::default()
    })
    .unwrap()
}

fn row(id: &str) -> Value {
    json!({"id":id,"createdAt":"2026-10-01T12:00:00Z","upstreamModel":"gpt-6","requestedModel":"alias","reasoningEffort":"max","subagentKind":null,"userAgent":"codex-cli/1"})
}

fn shared(store: MockStore) -> Arc<StdMutex<MockStore>> {
    Arc::new(StdMutex::new(store))
}

#[tokio::test]
async fn simultaneous_page_sessions_share_one_unfinished_task_and_cas_version() {
    let store = shared(MockStore::fixture());
    let mut harness = Harness::new(store.clone()).await;
    harness.send("POST", "api/tasks", configuration()).await;
    harness.send("POST", "api/tasks", configuration()).await;
    let mut statuses = vec![];
    for _ in 0..2 {
        let Message::Result { result, .. } = harness.receive().await.message else {
            panic!("management response required")
        };
        statuses.push(result["status"].as_u64().unwrap());
    }
    statuses.sort();
    assert_eq!(statuses, vec![202, 409]);
    assert_eq!(
        store.lock().unwrap().values[&("control".into(), "task".into())].1,
        1
    );
    harness.reconcile().await;
    assert_eq!(harness.task().await["state"], "complete");
    assert!(harness.runtime.state.lock().await.scan.is_none());
    harness.shutdown().await;
}

#[tokio::test]
async fn all_directory_and_history_pages_use_fixed_bounds_then_publish_aggregate_only() {
    let mut store = MockStore::fixture();
    store.key_page_size = 1;
    store
        .keys
        .push(json!({"id":"key-2","name":"Second","enabled":false}));
    store.records.insert(
        "key-1".into(),
        (0..101)
            .map(|index| row(&format!("request-{index}")))
            .collect(),
    );
    let store = shared(store);
    let mut harness = Harness::new(store.clone()).await;
    assert_eq!(harness.submit().await["status"], 202);
    harness.reconcile().await;
    let task = harness.task().await;
    assert_eq!(task["state"], "complete");
    assert_eq!(task["keys_processed"], 2);
    assert_eq!(task["records_read"], 101);
    {
        let store = store.lock().unwrap();
        let report = store
            .value("reports", task["report_id"].as_str().unwrap())
            .unwrap();
        assert_eq!(report["keys"].as_array().unwrap().len(), 1);
        assert_eq!(report["keys"][0]["groups"][0]["requests"], 101);
        assert!(report["keys"][0]["groups"][0].get("id").is_none());
        assert_eq!(
            store
                .calls
                .iter()
                .filter(|(method, _)| method == "host.keys.list")
                .count(),
            2
        );
        assert_eq!(
            store
                .calls
                .iter()
                .filter(|(method, _)| method == "host.http.dispatch")
                .count(),
            103
        );
        let puts = store
            .calls
            .iter()
            .filter(|(method, _)| method == "host.state.put")
            .map(|(_, params)| params)
            .collect::<Vec<_>>();
        let report_position = puts
            .iter()
            .position(|params| params["namespace"] == "reports")
            .unwrap();
        let index_position = puts
            .iter()
            .position(|params| params["key"] == "index")
            .unwrap();
        let complete_position = puts
            .iter()
            .position(|params| params["value"]["state"] == "complete")
            .unwrap();
        assert!(report_position < index_position && index_position < complete_position);
        assert_eq!(puts.last().unwrap()["expected_version"], 2);
    }
    harness.shutdown().await;
}

#[tokio::test]
async fn renamed_keys_and_reused_names_keep_their_ids_and_unavailable_keys_are_skipped() {
    let mut store = MockStore::fixture();
    store.keys[0]["name"] = json!("Renamed");
    store
        .keys
        .push(json!({"id":"key-2","name":"Old name","enabled":false}));
    store.records.get_mut("key-1").unwrap()[0]["clientApiKeyName"] = json!("Old name");
    store
        .records
        .insert("key-2".into(), vec![row("request-2"), row("request-3")]);
    store
        .records
        .insert("deleted-key".into(), vec![row("request-4")]);
    let store = shared(store);
    let mut harness = Harness::new(store.clone()).await;
    harness.submit().await;
    harness.reconcile().await;
    let task = harness.task().await;
    assert_eq!(task["state"], "complete");
    assert_eq!(task["records_read"], 4);
    {
        let store = store.lock().unwrap();
        let keys = store
            .value("reports", task["report_id"].as_str().unwrap())
            .unwrap()["keys"]
            .as_array()
            .unwrap();
        assert_eq!(keys.len(), 2);
        assert_eq!(keys[0]["id"], "key-1");
        assert_eq!(keys[0]["name"], "Renamed");
        assert_eq!(keys[0]["groups"][0]["requests"], 1);
        assert_eq!(keys[1]["id"], "key-2");
        assert_eq!(keys[1]["name"], "Old name");
        assert_eq!(keys[1]["groups"][0]["requests"], 2);
    }
    harness.shutdown().await;
}

#[tokio::test]
async fn detail_disappearing_after_listing_fails_without_publishing_partial_counts() {
    let mut store = MockStore::fixture();
    store
        .records
        .get_mut("key-1")
        .unwrap()
        .push(row("request-2"));
    store.missing_detail = Some("request-2".into());
    let store = shared(store);
    let mut harness = Harness::new(store.clone()).await;
    harness.submit().await;
    harness.reconcile().await;
    let task = harness.task().await;
    assert_eq!(task["state"], "failed");
    assert_eq!(task["records_read"], 1);
    assert!(task["report_id"].is_null());
    assert!(harness.runtime.state.lock().await.scan.is_none());
    assert!(
        !store
            .lock()
            .unwrap()
            .values
            .keys()
            .any(|(namespace, _)| namespace == "reports")
    );
    harness.shutdown().await;
}

#[tokio::test]
async fn read_failure_discards_partial_aggregates_and_never_retries_itself() {
    let mut store = MockStore::fixture();
    store.records.insert(
        "key-1".into(),
        (0..101)
            .map(|index| row(&format!("request-{index}")))
            .collect(),
    );
    store.failures.push(Failure {
        method: "host.http.dispatch",
        namespace: None,
        key: None,
        state: None,
        page: Some(2),
        after_commit: false,
    });
    let store = shared(store);
    let mut harness = Harness::new(store.clone()).await;
    harness.submit().await;
    harness.reconcile().await;
    let task = harness.task().await;
    assert_eq!(task["state"], "failed");
    assert_eq!(task["records_read"], 100);
    assert!(task["report_id"].is_null());
    assert!(harness.runtime.state.lock().await.scan.is_none());
    harness.reconcile().await;
    {
        let store = store.lock().unwrap();
        assert!(
            !store
                .values
                .keys()
                .any(|(namespace, _)| namespace == "reports")
        );
        assert!(store.value("control", "index").is_none());
        assert_eq!(
            store
                .calls
                .iter()
                .filter(|(method, _)| method == "host.http.dispatch")
                .count(),
            102
        );
    }
    harness.shutdown().await;
}

#[tokio::test]
async fn restart_marks_unfinished_task_interrupted_before_a_fresh_submission() {
    let store = shared(MockStore::fixture());
    let mut harness = Harness::new(store.clone()).await;
    let id = harness.submit().await["body"]["task"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    store
        .lock()
        .unwrap()
        .seed("reports", &id, json!({"unpublished":true}));
    harness.shutdown().await;
    let mut restarted = Harness::new(store.clone()).await;
    let task = restarted.task().await;
    assert_eq!(task["state"], "interrupted");
    assert_eq!(task["id"], id);
    assert!(store.lock().unwrap().value("reports", &id).is_none());
    assert!(restarted.runtime.state.lock().await.scan.is_none());
    restarted.reconcile().await;
    assert_eq!(restarted.submit().await["status"], 202);
    restarted.reconcile().await;
    assert_eq!(restarted.task().await["state"], "complete");
    restarted.shutdown().await;
}

#[tokio::test]
async fn empty_result_completes_without_data_or_a_history_entry() {
    let mut store = MockStore::fixture();
    store.records.get_mut("key-1").unwrap()[0]["userAgent"] = json!("prompt-diary");
    let store = shared(store);
    let mut harness = Harness::new(store.clone()).await;
    harness.submit().await;
    harness.reconcile().await;
    let task = harness.task().await;
    assert_eq!(task["state"], "complete");
    assert!(task["report_id"].is_null());
    assert!(store.lock().unwrap().value("control", "index").is_none());
    assert!(
        !store
            .lock()
            .unwrap()
            .values
            .keys()
            .any(|(namespace, _)| namespace == "reports")
    );
    harness.shutdown().await;
}

#[tokio::test]
async fn retention_publishes_twenty_latest_reports_before_removing_oldest_data() {
    let store = shared(MockStore::fixture());
    let mut harness = Harness::new(store.clone()).await;
    let mut ids = vec![];
    for _ in 0..21 {
        assert_eq!(harness.submit().await["status"], 202);
        harness.reconcile().await;
        let task = harness.task().await;
        assert_eq!(task["state"], "complete");
        ids.push(task["report_id"].as_str().unwrap().to_string());
    }
    {
        let store = store.lock().unwrap();
        let index = store.value("control", "index").unwrap();
        assert_eq!(index["reports"].as_array().unwrap().len(), 20);
        assert_eq!(index["reports"][0]["id"], ids[20]);
        assert_eq!(index["reports"][19]["id"], ids[1]);
        assert!(index["garbage"].as_array().unwrap().is_empty());
        assert!(store.value("reports", &ids[0]).is_none());
        assert_eq!(
            store
                .values
                .keys()
                .filter(|(namespace, _)| namespace == "reports")
                .count(),
            20
        );
        let publication = store
            .calls
            .iter()
            .rposition(|(method, params)| {
                method == "host.state.put"
                    && params["key"] == "index"
                    && params["value"]["garbage"] == json!([ids[0]])
            })
            .unwrap();
        let deletion = store
            .calls
            .iter()
            .position(|(method, params)| method == "host.state.delete" && params["key"] == ids[0])
            .unwrap();
        assert!(publication < deletion);
    }
    harness.shutdown().await;
}

#[tokio::test]
async fn oversized_result_fails_without_persisting_partial_report() {
    let mut store = MockStore::fixture();
    store.records.get_mut("key-1").unwrap()[0]["upstreamModel"] =
        json!("m".repeat(crate::model::MAX_REPORT_BYTES));
    let store = shared(store);
    let mut harness = Harness::new(store.clone()).await;
    harness.submit().await;
    harness.reconcile().await;
    let task = harness.task().await;
    assert_eq!(task["state"], "failed");
    assert!(task["error"].as_str().unwrap().contains("48 KiB"));
    assert!(
        !store
            .lock()
            .unwrap()
            .values
            .keys()
            .any(|(namespace, _)| namespace == "reports")
    );
    harness.shutdown().await;
}

#[tokio::test]
async fn rejected_index_cas_keeps_unpublished_report_out_of_live_history() {
    let mut store = MockStore::fixture();
    store.failures.push(Failure::put("index"));
    let store = shared(store);
    let mut harness = Harness::new(store.clone()).await;
    harness.submit().await;
    harness.reconcile().await;
    assert_eq!(harness.task().await["state"], "failed");
    assert!(
        harness.request("GET", "api/reports", vec![]).await["body"]["reports"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        !store
            .lock()
            .unwrap()
            .values
            .keys()
            .any(|(namespace, _)| namespace == "reports")
    );
    harness.shutdown().await;
}

#[tokio::test]
async fn committed_index_with_lost_ack_preserves_published_data_and_completes() {
    let mut store = MockStore::fixture();
    let mut failure = Failure::put("index");
    failure.after_commit = true;
    store.failures.push(failure);
    let store = shared(store);
    let mut harness = Harness::new(store.clone()).await;
    harness.submit().await;
    harness.reconcile().await;
    let task = harness.task().await;
    assert_eq!(task["state"], "complete");
    assert!(
        store
            .lock()
            .unwrap()
            .value("reports", task["report_id"].as_str().unwrap())
            .is_some()
    );
    assert_eq!(
        harness.request("GET", "api/reports", vec![]).await["body"]["reports"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    harness.shutdown().await;
}

#[tokio::test]
async fn failed_interrupt_persistence_is_retried_before_initialization_completes() {
    let store = shared(MockStore::fixture());
    let mut harness = Harness::new(store.clone()).await;
    harness.submit().await;
    harness.shutdown().await;
    let mut failure = Failure::put("task");
    failure.state = Some("interrupted");
    store.lock().unwrap().failures.push(failure);
    let mut restarted = Harness::new(store.clone()).await;
    assert_eq!(
        restarted.request("GET", "api/task", vec![]).await["status"],
        503
    );
    assert!(!restarted.runtime.state.lock().await.initialized);
    assert_eq!(
        store.lock().unwrap().value("control", "task").unwrap()["state"],
        "queued"
    );
    assert_eq!(restarted.task().await["state"], "interrupted");
    assert_eq!(
        store.lock().unwrap().value("control", "task").unwrap()["state"],
        "interrupted"
    );
    restarted.shutdown().await;
}

#[tokio::test]
async fn uncertain_index_write_is_resolved_before_replacing_previous_task() {
    for committed in [false, true] {
        let store = shared(MockStore::fixture());
        let mut harness = Harness::new(store.clone()).await;
        let id = harness.submit().await["body"]["task"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        {
            let mut store = store.lock().unwrap();
            let mut write = Failure::put("index");
            write.after_commit = committed;
            store.failures.push(write);
            store.failures.push(Failure {
                method: "host.state.get",
                namespace: Some("control"),
                key: Some("index"),
                state: None,
                page: None,
                after_commit: false,
            });
            store.failures.push(Failure {
                method: "host.state.get",
                namespace: Some("control"),
                key: Some("index"),
                state: None,
                page: None,
                after_commit: false,
            });
        }
        harness.reconcile().await;
        assert_eq!(harness.task().await["state"], "failed");
        assert!(store.lock().unwrap().value("reports", &id).is_some());
        assert_eq!(harness.submit().await["status"], 202);
        {
            let store = store.lock().unwrap();
            assert_eq!(store.value("reports", &id).is_some(), committed);
            if committed {
                assert_eq!(
                    store.value("control", "index").unwrap()["reports"][0]["id"],
                    id
                );
            }
        }
        harness.shutdown().await;
    }
}

#[tokio::test]
async fn failure_saving_running_state_keeps_scan_available_for_next_callback() {
    let store = shared(MockStore::fixture());
    let mut harness = Harness::new(store.clone()).await;
    harness.submit().await;
    let mut failure = Failure::put("task");
    failure.state = Some("running");
    store.lock().unwrap().failures.push(failure);
    harness.send("RECONCILE", "", vec![]).await;
    assert!(matches!(
        harness.receive().await.message,
        Message::Error { .. }
    ));
    assert!(harness.runtime.state.lock().await.scan.is_some());
    assert_eq!(
        store.lock().unwrap().value("control", "task").unwrap()["state"],
        "queued"
    );
    harness.reconcile().await;
    assert_eq!(harness.task().await["state"], "complete");
    harness.shutdown().await;
}

#[tokio::test]
async fn committed_task_submission_with_lost_ack_recovers_accepted_task_and_version() {
    let mut store = MockStore::fixture();
    let mut failure = Failure::put("task");
    failure.state = Some("queued");
    failure.after_commit = true;
    store.failures.push(failure);
    let store = shared(store);
    let mut harness = Harness::new(store.clone()).await;
    assert_eq!(harness.submit().await["status"], 202);
    assert_eq!(harness.submit().await["status"], 409);
    assert_eq!(harness.runtime.state.lock().await.task_version, Some(1));
    harness.reconcile().await;
    assert_eq!(harness.task().await["state"], "complete");
    assert_eq!(harness.runtime.state.lock().await.task_version, Some(3));
    harness.shutdown().await;
}

#[tokio::test]
async fn committed_running_save_with_lost_ack_updates_version_before_completion() {
    let store = shared(MockStore::fixture());
    let mut harness = Harness::new(store.clone()).await;
    harness.submit().await;
    let mut failure = Failure::put("task");
    failure.state = Some("running");
    failure.after_commit = true;
    store.lock().unwrap().failures.push(failure);
    harness.reconcile().await;
    assert_eq!(harness.task().await["state"], "complete");
    assert_eq!(harness.runtime.state.lock().await.task_version, Some(3));
    assert_eq!(
        store.lock().unwrap().values[&("control".into(), "task".into())].1,
        3
    );
    harness.shutdown().await;
}

#[tokio::test]
async fn uncertain_submission_is_recovered_by_a_later_callback_without_duplicate_scanning() {
    let store = shared(MockStore::fixture());
    let mut harness = Harness::new(store.clone()).await;
    assert!(harness.task().await.is_null());
    {
        let mut store = store.lock().unwrap();
        let mut failure = Failure::put("task");
        failure.state = Some("queued");
        failure.after_commit = true;
        store.failures.push(failure);
        store.failures.push(Failure {
            method: "host.state.get",
            namespace: Some("control"),
            key: Some("task"),
            state: None,
            page: None,
            after_commit: false,
        });
    }
    assert_eq!(harness.submit().await["status"], 503);
    let id = store.lock().unwrap().value("control", "task").unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    store.lock().unwrap().failures.push(Failure {
        method: "host.state.get",
        namespace: Some("control"),
        key: Some("task"),
        state: None,
        page: None,
        after_commit: false,
    });
    assert_eq!(
        harness.request("GET", "api/task", vec![]).await["status"],
        503
    );
    assert!(harness.runtime.state.lock().await.scan.is_none());
    assert_eq!(harness.task().await["id"], id);
    assert_eq!(harness.submit().await["status"], 409);
    harness.reconcile().await;
    let task = harness.task().await;
    assert_eq!(task["state"], "complete");
    assert_eq!(task["id"], id);
    assert_eq!(task["records_read"], 1);
    {
        let store = store.lock().unwrap();
        assert_eq!(
            store
                .calls
                .iter()
                .filter(|(method, _)| method == "host.http.dispatch")
                .count(),
            2
        );
        assert_eq!(
            store.value("control", "index").unwrap()["reports"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
    harness.shutdown().await;
}

#[tokio::test]
async fn uncommitted_uncertain_submission_does_not_block_a_fresh_submission() {
    let store = shared(MockStore::fixture());
    let mut harness = Harness::new(store.clone()).await;
    assert!(harness.task().await.is_null());
    {
        let mut store = store.lock().unwrap();
        let mut failure = Failure::put("task");
        failure.state = Some("queued");
        store.failures.push(failure);
        store.failures.push(Failure {
            method: "host.state.get",
            namespace: Some("control"),
            key: Some("task"),
            state: None,
            page: None,
            after_commit: false,
        });
    }
    assert_eq!(harness.submit().await["status"], 503);
    assert!(store.lock().unwrap().value("control", "task").is_none());
    let submitted = harness.submit().await;
    assert_eq!(submitted["status"], 202);
    assert_eq!(harness.submit().await["status"], 409);
    assert!(
        harness
            .runtime
            .state
            .lock()
            .await
            .pending_submission
            .is_none()
    );
    harness.reconcile().await;
    let task = harness.task().await;
    assert_eq!(task["state"], "complete");
    assert_eq!(task["id"], submitted["body"]["task"]["id"]);
    assert_eq!(task["records_read"], 1);
    {
        let store = store.lock().unwrap();
        assert_eq!(
            store
                .calls
                .iter()
                .filter(|(method, _)| method == "host.http.dispatch")
                .count(),
            2
        );
        let submissions: Vec<_> = store
            .calls
            .iter()
            .filter(|(method, params)| {
                method == "host.state.put" && params["value"]["state"] == "queued"
            })
            .collect();
        assert_eq!(submissions.len(), 2);
        assert_ne!(
            submissions[0].1["value"]["id"],
            submissions[1].1["value"]["id"]
        );
        assert!(submissions[1].1["expected_version"].is_null());
        assert_eq!(
            store.value("control", "index").unwrap()["reports"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
    harness.shutdown().await;
}

#[tokio::test]
async fn running_save_recovers_after_both_ack_and_immediate_read_are_unavailable() {
    let store = shared(MockStore::fixture());
    let mut harness = Harness::new(store.clone()).await;
    let submitted = harness.submit().await;
    {
        let mut store = store.lock().unwrap();
        let mut failure = Failure::put("task");
        failure.state = Some("running");
        failure.after_commit = true;
        store.failures.push(failure);
        store.failures.push(Failure {
            method: "host.state.get",
            namespace: Some("control"),
            key: Some("task"),
            state: None,
            page: None,
            after_commit: false,
        });
    }
    harness.send("RECONCILE", "", vec![]).await;
    assert!(matches!(
        harness.receive().await.message,
        Message::Error { .. }
    ));
    assert!(harness.runtime.state.lock().await.scan.is_some());
    harness.reconcile().await;
    let task = harness.task().await;
    assert_eq!(task["state"], "complete");
    assert_eq!(task["id"], submitted["body"]["task"]["id"]);
    assert_eq!(task["records_read"], 1);
    assert_eq!(harness.runtime.state.lock().await.task_version, Some(3));
    assert_eq!(
        store
            .lock()
            .unwrap()
            .calls
            .iter()
            .filter(|(method, _)| method == "host.http.dispatch")
            .count(),
        2
    );
    harness.shutdown().await;
}
