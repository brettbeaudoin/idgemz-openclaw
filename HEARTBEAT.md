# HEARTBEAT

This repo does not define a repo-local heartbeat workflow.

If an automation or agent looks for this file, treat its absence of additional instructions as intentional.
Prefer the parent task, cron prompt, or current operator request.

Operational guidance:
- Do not send Gmail-based daily sales reports by default.
- The live daily sales report path is Telegram-first.
- Prefer safe, surgical fixes over feature work.
