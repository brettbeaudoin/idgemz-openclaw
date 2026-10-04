# Dangerboat Self-Improvement Loop

The weekly runner keeps improvements conservative and file-canonical:

- Refresh Postgres, Milvus, and Hindsight from canonical files.
- Validate Docker, Node, memory-stack health, and the `memory_recall` plugin.
- Push clean already-committed repo work to GitHub.
- Append a short note to the daily memory file.
- Send Brett a Telegram summary of changes, verified checks, and blockers.

The former daily self-improvement status check has been replaced with the
**Daily DB Operating Brief**. It runs at the same time and sends an
evidence-backed business action list:

- Yesterday's sales, channel mix, and top SKUs (Pacific Time).
- Large order / possible B2B signals.
- Amazon inventory early warnings, clearly labeled as requiring MYI
  verification when Amazon reports disagree.
- Sales-data freshness so stale data cannot quietly drive a production
  decision.

It sends a short action-oriented Telegram brief every day. Infrastructure and
memory-stack maintenance remain a weekly responsibility instead of cluttering
Brett's daily operating signal.

It does not run paid model/API reviews or risky system rewrites by default.
Those are reported as permission-needed items so Brett can approve them when
the upside is worth the cost or risk.

Schedule: `com.openclaw.self-improvement-weekly` runs Mondays at 10:17 ET via
LaunchAgent. `com.openclaw.self-improvement-daily` runs daily at 09:17 ET via
LaunchAgent. They are kept in Git with their cron wrappers so rollback is just
a revert plus unloading the LaunchAgents.
