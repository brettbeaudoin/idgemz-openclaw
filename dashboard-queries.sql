-- IDGemz Dashboard SQL Queries
-- Dashboard: IDGemz Test Dashboard
-- Exported: 2026-01-28T23:40:30.898Z

-- Panel: Simple Order Count (ID: 1)
SELECT COUNT(*) as count FROM orders;

-- Panel: Total Revenue (ID: 2)
SELECT SUM(order_total) as total FROM orders;

