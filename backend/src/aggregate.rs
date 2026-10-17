//! 按 Key 流式筛选并计数，不保留请求历史或预先计算的百分比。

use std::collections::BTreeMap;

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};

use crate::model::{
    Group, KeyReport, MAX_REPORT_BYTES, Removed, Report, ResolvedConfiguration, UsageRecord,
};

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Dimensions {
    model: String,
    reasoning_effort: String,
    is_subagent: bool,
}

struct KeyAccumulator {
    id: String,
    name: String,
    groups: BTreeMap<Dimensions, u64>,
}

/// 仅保留分组计数与 Key 名称；调用方处理完当前页后即可丢弃原始记录。
pub struct Accumulator {
    pub resolved: ResolvedConfiguration,
    removed: Removed,
    keys: Vec<KeyAccumulator>,
}

impl Accumulator {
    pub fn new(resolved: ResolvedConfiguration) -> Self {
        Self {
            resolved,
            removed: Removed::default(),
            keys: Vec::new(),
        }
    }

    pub fn add_key(&mut self, id: impl Into<String>, name: impl Into<String>) -> usize {
        let index = self.keys.len();
        self.keys.push(KeyAccumulator {
            id: id.into(),
            name: name.into(),
            groups: BTreeMap::new(),
        });
        index
    }

    pub fn add_record(&mut self, key_index: usize, record: &UsageRecord) -> Result<()> {
        if key_index >= self.keys.len() {
            bail!("Usage record refers to an unknown report key");
        }
        if record.started_at < self.resolved.bounds.start
            || record.started_at >= self.resolved.bounds.end
        {
            return Ok(());
        }
        if self
            .resolved
            .excludes_user_agent(record.user_agent.as_deref())
        {
            self.removed.user_agent = self
                .removed
                .user_agent
                .checked_add(1)
                .context("User-agent exclusion count overflow")?;
            return Ok(());
        }
        let model = recorded_model(record.upstream_model.as_deref())
            .or_else(|| recorded_model(record.requested_model.as_deref()))
            .unwrap_or("unknown");
        if self.resolved.excludes_model(model) {
            self.removed.model = self
                .removed
                .model
                .checked_add(1)
                .context("Model exclusion count overflow")?;
            return Ok(());
        }
        let dimensions = Dimensions {
            model: model.into(),
            reasoning_effort: nonblank(record.reasoning_effort.as_deref())
                .unwrap_or("unspecified")
                .into(),
            is_subagent: nonblank(record.subagent_kind.as_deref()).is_some(),
        };
        let groups = &mut self.keys[key_index].groups;
        let new_group = !groups.contains_key(&dimensions);
        let count = groups.entry(dimensions).or_default();
        *count = count.checked_add(1).context("Request count overflow")?;
        if new_group {
            // 分组本身已超过存储上限时，继续读取也无法生成完整报表。
            let bytes = serde_json::to_vec(&self.key_reports())?;
            if bytes.len() > MAX_REPORT_BYTES {
                bail!("Report groups exceed the 48 KiB storage limit");
            }
        }
        Ok(())
    }

    pub fn finish(
        self,
        id: impl Into<String>,
        created_at: DateTime<Utc>,
    ) -> Result<Option<Report>> {
        let keys = self.key_reports();
        if keys.is_empty() {
            return Ok(None);
        }
        let report = Report {
            format_version: 1,
            id: id.into(),
            created_at,
            configuration: self.resolved.configuration,
            bounds: self.resolved.bounds,
            removed: self.removed,
            keys,
        };
        report.checked_json()?;
        Ok(Some(report))
    }

    fn key_reports(&self) -> Vec<KeyReport> {
        self.keys
            .iter()
            .filter(|key| !key.groups.is_empty())
            .map(|key| KeyReport {
                id: key.id.clone(),
                name: key.name.clone(),
                groups: key
                    .groups
                    .iter()
                    .map(|(dimensions, requests)| Group {
                        model: dimensions.model.clone(),
                        reasoning_effort: dimensions.reasoning_effort.clone(),
                        is_subagent: dimensions.is_subagent,
                        requests: *requests,
                    })
                    .collect(),
            })
            .collect()
    }
}

fn nonblank(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn recorded_model(value: Option<&str>) -> Option<&str> {
    value.filter(|value| !value.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Configuration;

    fn now() -> DateTime<Utc> {
        "2026-10-17T12:34:56Z".parse().unwrap()
    }

    fn record() -> UsageRecord {
        UsageRecord {
            id: "request-1".into(),
            started_at: now() - chrono::Duration::hours(1),
            upstream_model: Some("gpt-6".into()),
            requested_model: Some("alias".into()),
            reasoning_effort: Some("max".into()),
            subagent_kind: None,
            user_agent: None,
        }
    }

    fn accumulator() -> Accumulator {
        Accumulator::new(Configuration::default().resolve(now()).unwrap())
    }

    #[test]
    fn exclusions_are_ordered_nonoverlapping_and_case_sensitive() {
        let mut aggregate = accumulator();
        let key = aggregate.add_key("key-1", "First");
        let mut row = record();
        row.user_agent = Some("prompt-diary/1".into());
        row.upstream_model = Some("codex-auto-review".into());
        aggregate.add_record(key, &row).unwrap();
        row.user_agent = Some("Prompt_Diary/1".into());
        aggregate.add_record(key, &row).unwrap();
        row.upstream_model = Some("Codex-auto-review".into());
        aggregate.add_record(key, &row).unwrap();
        row.user_agent = None;
        aggregate.add_record(key, &row).unwrap();
        let report = aggregate.finish("report-1", now()).unwrap().unwrap();
        assert_eq!(
            report.removed,
            Removed {
                user_agent: 1,
                model: 1
            }
        );
        assert_eq!(report.keys[0].groups[0].requests, 2);
    }

    #[test]
    fn missing_user_agent_is_evaluated_as_empty_with_regex_search_semantics() {
        let mut configuration = Configuration::default();
        configuration.exclusions.user_agent_patterns = vec!["^$".into(), "diary".into()];
        let mut aggregate = Accumulator::new(configuration.resolve(now()).unwrap());
        let key = aggregate.add_key("key-1", "First");
        let mut row = record();
        aggregate.add_record(key, &row).unwrap();
        row.user_agent = Some("prefix-diary-suffix".into());
        aggregate.add_record(key, &row).unwrap();
        row.user_agent = Some("ordinary-client".into());
        aggregate.add_record(key, &row).unwrap();
        let report = aggregate.finish("report-1", now()).unwrap().unwrap();
        assert_eq!(report.removed.user_agent, 2);
        assert_eq!(report.keys[0].groups[0].requests, 1);
    }

    #[test]
    fn model_filters_match_exact_recorded_ids_after_upstream_fallback() {
        let mut aggregate = accumulator();
        let key = aggregate.add_key("key-1", "First");
        let mut row = record();
        row.upstream_model = Some(" codex-auto-review ".into());
        aggregate.add_record(key, &row).unwrap();
        row.upstream_model = None;
        row.requested_model = Some("codex-auto-review".into());
        aggregate.add_record(key, &row).unwrap();
        let report = aggregate.finish("report-1", now()).unwrap().unwrap();
        assert_eq!(report.removed.model, 1);
        assert_eq!(report.keys[0].groups[0].model, " codex-auto-review ");
    }

    #[test]
    fn selection_is_half_open_and_outside_rows_do_not_add_removal_counts() {
        let mut aggregate = accumulator();
        let key = aggregate.add_key("key-1", "First");
        let mut row = record();
        row.started_at = aggregate.resolved.bounds.start;
        aggregate.add_record(key, &row).unwrap();
        row.started_at = aggregate.resolved.bounds.end;
        row.user_agent = Some("prompt".into());
        aggregate.add_record(key, &row).unwrap();
        row.started_at = aggregate.resolved.bounds.start - chrono::Duration::milliseconds(1);
        aggregate.add_record(key, &row).unwrap();
        let report = aggregate.finish("report-1", now()).unwrap().unwrap();
        assert_eq!(report.keys[0].groups[0].requests, 1);
        assert_eq!(report.removed, Removed::default());
    }

    #[test]
    fn fallback_and_normalization_preserve_distinct_efforts_and_subagent_counts() {
        let mut aggregate = accumulator();
        let key = aggregate.add_key("key-1", "First");
        let mut row = record();
        aggregate.add_record(key, &row).unwrap();
        row.subagent_kind = Some(" worker ".into());
        aggregate.add_record(key, &row).unwrap();
        row.reasoning_effort = Some(" high ".into());
        aggregate.add_record(key, &row).unwrap();
        row.upstream_model = Some("   ".into());
        row.requested_model = Some("requested".into());
        row.reasoning_effort = Some(" \t ".into());
        row.subagent_kind = Some("  ".into());
        aggregate.add_record(key, &row).unwrap();
        row.upstream_model = None;
        row.requested_model = None;
        row.reasoning_effort = None;
        aggregate.add_record(key, &row).unwrap();
        let report = aggregate.finish("report-1", now()).unwrap().unwrap();
        let groups = &report.keys[0].groups;
        assert_eq!(groups.len(), 5);
        assert!(groups.contains(&Group {
            model: "requested".into(),
            reasoning_effort: "unspecified".into(),
            is_subagent: false,
            requests: 1,
        }));
        assert!(groups.contains(&Group {
            model: "unknown".into(),
            reasoning_effort: "unspecified".into(),
            is_subagent: false,
            requests: 1,
        }));
        assert_eq!(groups.iter().filter(|group| group.is_subagent).count(), 2);
    }

    #[test]
    fn empty_keys_are_omitted_and_directory_order_is_preserved() {
        let mut aggregate = accumulator();
        let last_alphabetically = aggregate.add_key("z", "Zulu");
        aggregate.add_key("empty", "Empty");
        let first_alphabetically = aggregate.add_key("a", "Alpha");
        aggregate
            .add_record(first_alphabetically, &record())
            .unwrap();
        aggregate
            .add_record(last_alphabetically, &record())
            .unwrap();
        let report = aggregate.finish("report-1", now()).unwrap().unwrap();
        assert_eq!(
            report
                .keys
                .iter()
                .map(|key| key.id.as_str())
                .collect::<Vec<_>>(),
            vec!["z", "a"]
        );
        assert_eq!(report.format_version, 1);
        let stored: serde_json::Value =
            serde_json::from_str(&report.checked_json().unwrap()).unwrap();
        assert_eq!(stored["keys"][0]["groups"][0]["requests"], 1);
        assert!(stored["keys"][0]["groups"][0].get("user_agent").is_none());
        let mut empty = accumulator();
        empty.add_key("empty", "Empty");
        assert!(empty.finish("no-report", now()).unwrap().is_none());
    }

    #[test]
    fn all_filtered_completes_without_a_report() {
        let mut aggregate = accumulator();
        let key = aggregate.add_key("key-1", "First");
        let mut row = record();
        row.upstream_model = Some("gpt-5.6-luna".into());
        aggregate.add_record(key, &row).unwrap();
        assert!(aggregate.finish("no-report", now()).unwrap().is_none());
    }

    #[test]
    fn oversized_groups_fail_during_scan_and_metadata_is_checked_before_storage() {
        let mut aggregate = accumulator();
        let key = aggregate.add_key("key-1", "First");
        let mut row = record();
        row.upstream_model = Some("m".repeat(MAX_REPORT_BYTES));
        assert!(
            aggregate
                .add_record(key, &row)
                .unwrap_err()
                .to_string()
                .contains("48 KiB")
        );

        let mut aggregate = accumulator();
        let key = aggregate.add_key("key-1", "First");
        aggregate.add_record(key, &record()).unwrap();
        assert!(
            aggregate
                .finish("id".repeat(MAX_REPORT_BYTES), now())
                .unwrap_err()
                .to_string()
                .contains("48 KiB")
        );
    }
}
