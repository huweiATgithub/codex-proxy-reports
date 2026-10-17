//! 解析报表配置与时间边界，定义仅包含计数的持久化格式。

use anyhow::{Context, Result, anyhow, bail};
use chrono::{DateTime, Days, Duration, LocalResult, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use regex::Regex;
use serde::{Deserialize, Serialize};

pub const MAX_REPORT_BYTES: usize = 48 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Configuration {
    pub window: Window,
    pub timezone: String,
    pub exclusions: Exclusions,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Window {
    Relative {},
    Custom {
        start_date: String,
        end_date: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Exclusions {
    pub user_agent_patterns: Vec<String>,
    pub models: Vec<String>,
}

impl Default for Configuration {
    fn default() -> Self {
        Self {
            window: Window::Relative {},
            timezone: "UTC".into(),
            exclusions: Exclusions {
                user_agent_patterns: vec!["^prompt".into()],
                models: vec!["codex-auto-review".into(), "gpt-5.6-luna".into()],
            },
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Bounds {
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
}

#[derive(Clone, Debug)]
pub struct ResolvedConfiguration {
    pub configuration: Configuration,
    pub bounds: Bounds,
    user_agent_patterns: Vec<Regex>,
}

impl Configuration {
    pub fn resolve(self, now: DateTime<Utc>) -> Result<ResolvedConfiguration> {
        let timezone: Tz = self
            .timezone
            .parse()
            .map_err(|_| anyhow!("Unknown timezone: {}", self.timezone))?;
        let bounds = match &self.window {
            Window::Relative {} => Bounds {
                start: now
                    .checked_sub_signed(Duration::hours(7 * 24))
                    .context("Relative window start is out of range")?,
                end: now,
            },
            Window::Custom {
                start_date,
                end_date,
            } => {
                let start = parse_date(start_date)?;
                let end = parse_date(end_date)?;
                if start > end {
                    bail!("Start date must not be after end date");
                }
                let exclusive_end = end
                    .checked_add_days(Days::new(1))
                    .context("End date is out of range")?;
                Bounds {
                    start: local_midnight(timezone, start)?,
                    end: local_midnight(timezone, exclusive_end)?,
                }
            }
        };
        let user_agent_patterns = self
            .exclusions
            .user_agent_patterns
            .iter()
            .map(|pattern| {
                Regex::new(pattern).with_context(|| format!("Invalid user-agent regex {pattern:?}"))
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(ResolvedConfiguration {
            configuration: self,
            bounds,
            user_agent_patterns,
        })
    }
}

fn parse_date(value: &str) -> Result<NaiveDate> {
    if value.len() != 10 {
        bail!("Invalid date {value:?}; expected YYYY-MM-DD");
    }
    let date = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .with_context(|| format!("Invalid date {value:?}; expected YYYY-MM-DD"))?;
    if date.format("%Y-%m-%d").to_string() != value {
        bail!("Invalid date {value:?}; expected YYYY-MM-DD");
    }
    Ok(date)
}

fn local_midnight(timezone: Tz, date: NaiveDate) -> Result<DateTime<Utc>> {
    let midnight = date.and_hms_opt(0, 0, 0).context("Date is out of range")?;
    match timezone.from_local_datetime(&midnight) {
        LocalResult::Single(value) => Ok(value.with_timezone(&Utc)),
        LocalResult::Ambiguous(_, _) => {
            bail!("Local midnight on {date} is ambiguous in {timezone}")
        }
        LocalResult::None => bail!("Local midnight on {date} does not exist in {timezone}"),
    }
}

impl ResolvedConfiguration {
    pub(crate) fn excludes_user_agent(&self, user_agent: Option<&str>) -> bool {
        let value = user_agent.unwrap_or("");
        self.user_agent_patterns
            .iter()
            .any(|pattern| pattern.is_match(value))
    }

    pub(crate) fn excludes_model(&self, model: &str) -> bool {
        self.configuration
            .exclusions
            .models
            .iter()
            .any(|excluded| excluded == model)
    }
}

/// 宿主 usage 列表用 createdAt 表示逻辑请求的开始时间；不是重试尝试的 startedAt。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecord {
    pub id: String,
    #[serde(rename = "createdAt")]
    pub started_at: DateTime<Utc>,
    pub upstream_model: Option<String>,
    pub requested_model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub subagent_kind: Option<String>,
    pub user_agent: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Report {
    pub format_version: u8,
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub configuration: Configuration,
    pub bounds: Bounds,
    pub removed: Removed,
    pub keys: Vec<KeyReport>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct Removed {
    pub user_agent: u64,
    pub model: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct KeyReport {
    pub id: String,
    pub name: String,
    pub groups: Vec<Group>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Group {
    pub model: String,
    pub reasoning_effort: String,
    pub is_subagent: bool,
    pub requests: u64,
}

impl Report {
    pub fn checked_json(&self) -> Result<String> {
        let json = serde_json::to_string(self).context("Could not serialize report")?;
        if json.len() > MAX_REPORT_BYTES {
            bail!(
                "Report exceeds the 48 KiB storage limit ({} bytes)",
                json.len()
            );
        }
        Ok(json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<Utc> {
        "2026-10-17T12:34:56Z".parse().unwrap()
    }

    fn custom(start: &str, end: &str, timezone: &str) -> Configuration {
        Configuration {
            window: Window::Custom {
                start_date: start.into(),
                end_date: end.into(),
            },
            timezone: timezone.into(),
            ..Configuration::default()
        }
    }

    #[test]
    fn relative_window_is_exactly_168_hours_in_any_timezone() {
        let configuration = Configuration {
            timezone: "America/New_York".into(),
            ..Configuration::default()
        };
        let resolved = configuration.resolve(now()).unwrap();
        assert_eq!(resolved.bounds.end, now());
        assert_eq!(
            resolved.bounds.end - resolved.bounds.start,
            Duration::hours(168)
        );
        assert_eq!(
            serde_json::to_value(resolved.bounds).unwrap(),
            serde_json::json!({
                "start": "2026-10-10T12:34:56Z",
                "end": "2026-10-17T12:34:56Z"
            })
        );
    }

    #[test]
    fn custom_days_follow_both_dst_transitions_and_include_the_end_date() {
        let spring = custom("2026-03-08", "2026-03-08", "America/New_York")
            .resolve(now())
            .unwrap();
        assert_eq!(
            spring.bounds.start.to_rfc3339(),
            "2026-03-08T05:00:00+00:00"
        );
        assert_eq!(spring.bounds.end.to_rfc3339(), "2026-03-09T04:00:00+00:00");
        assert_eq!(spring.bounds.end - spring.bounds.start, Duration::hours(23));
        let fall = custom("2026-11-01", "2026-11-01", "America/New_York")
            .resolve(now())
            .unwrap();
        assert_eq!(fall.bounds.end - fall.bounds.start, Duration::hours(25));
    }

    #[test]
    fn invalid_or_reversed_dates_and_unknown_timezones_are_errors() {
        for (start, end, timezone) in [
            ("2026-10-18", "2026-10-17", "UTC"),
            ("2026-02-30", "2026-03-01", "UTC"),
            ("2026-1-01", "2026-01-01", "UTC"),
            ("-0001-01-01", "2026-01-01", "UTC"),
            ("2026-01-01", "2026-01-01", "Not/A_Zone"),
        ] {
            assert!(custom(start, end, timezone).resolve(now()).is_err());
        }
    }

    #[test]
    fn skipped_or_ambiguous_local_midnight_is_rejected_explicitly() {
        let skipped = custom("2011-12-30", "2011-12-30", "Pacific/Apia")
            .resolve(now())
            .unwrap_err();
        assert!(skipped.to_string().contains("does not exist"));
        let ambiguous = custom("2020-11-01", "2020-11-01", "America/Havana")
            .resolve(now())
            .unwrap_err();
        assert!(ambiguous.to_string().contains("ambiguous"));
    }

    #[test]
    fn invalid_regex_and_unknown_configuration_fields_reject_generation() {
        let mut configuration = Configuration::default();
        configuration.exclusions.user_agent_patterns = vec!["[".into()];
        assert!(
            configuration
                .resolve(now())
                .unwrap_err()
                .to_string()
                .contains("Invalid user-agent regex")
        );
        let mut json = serde_json::to_value(Configuration::default()).unwrap();
        json["keys"] = serde_json::json!(["unavailable-key-selector"]);
        assert!(serde_json::from_value::<Configuration>(json).is_err());
        let mut json = serde_json::to_value(Configuration::default()).unwrap();
        json["window"]["days"] = serde_json::json!(30);
        assert!(serde_json::from_value::<Configuration>(json).is_err());
        let mut json = serde_json::to_value(Configuration::default()).unwrap();
        json["exclusions"]["unknown"] = serde_json::json!(true);
        assert!(serde_json::from_value::<Configuration>(json).is_err());
    }

    #[test]
    fn usage_record_reads_actual_host_list_fields_and_ignores_other_metadata() {
        let record: UsageRecord = serde_json::from_value(serde_json::json!({
            "id": "request-1",
            "createdAt": "2026-10-17T12:34:56Z",
            "upstreamModel": "gpt-6",
            "requestedModel": "alias",
            "reasoningEffort": "max",
            "subagentKind": "worker",
            "userAgent": null,
            "logicalOutcome": "success",
            "tokenDetails": { "inputTokens": 123 }
        }))
        .unwrap();
        assert_eq!(record.started_at, now());
        assert_eq!(record.upstream_model.as_deref(), Some("gpt-6"));
        assert_eq!(record.user_agent, None);
    }
}
