//! 独立插件进程入口，标准输出只承载 SDK 协议
use gateway_plugin_sdk::client::{PluginSession, SessionConfig};
use gateway_plugin_sdk::{CallBudgets, Stage};

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("reports: {error}");
        std::process::exit(1);
    }
}

async fn run() -> anyhow::Result<()> {
    let mut session = PluginSession::accept(
        tokio::io::stdin(),
        tokio::io::stdout(),
        SessionConfig::default(),
    )
    .await?;
    session.set_call_budgets(CallBudgets::from([(Stage::Maintenance, 180_000)]))?;
    session.run(codex_proxy_reports::runtime::plugin()?).await?;
    Ok(())
}
