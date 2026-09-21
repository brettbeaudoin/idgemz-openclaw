# Dangerboat Self-Improvement Loop

The weekly runner keeps improvements conservative and file-canonical:

- Refresh Postgres, Milvus, and Hindsight from canonical files.
- Validate Docker, Node, memory-stack health, and the `memory_recall` plugin.
- Push clean already-committed repo work to GitHub.
- Append a short note to the daily memory file.
- Send Brett a Telegram summary of changes, verified checks, and blockers.

It does not run paid model/API reviews or risky system rewrites by default.
Those are reported as permission-needed items so Brett can approve them when
the upside is worth the cost or risk.

Schedule: `com.openclaw.self-improvement-weekly` runs Mondays at 10:17 ET via
LaunchAgent. It is kept in Git with the cron wrapper so rollback is just a
revert plus unloading the LaunchAgent.
