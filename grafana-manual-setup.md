# Grafana Manual Configuration Guide

Since the default credentials might have been changed, here's how to manually configure Grafana:

## 1. Login to Grafana
- Go to http://localhost:3000
- Login with your credentials (if you changed from admin/admin)

## 2. Add PostgreSQL Data Source

1. Click the gear icon (⚙️) → **Data Sources**
2. Click **Add data source**
3. Search for and select **PostgreSQL**
4. Configure with these settings:

   **Connection:**
   - Host: `localhost:5432`
   - Database: `idgemz`
   - User: `bbeaudoin`
   - Password: (leave blank if no password)
   - TLS/SSL Mode: `disable`

5. Click **Save & Test**

## 3. Import the Dashboard

Copy this JSON and import it:

```json
{
  "dashboard": {
    "title": "IDGemz Sales Dashboard",
    "panels": [
      {
        "datasource": "IDGemz PostgreSQL",
        "targets": [{
          "rawSql": "SELECT date_trunc('day', order_date) as time, COUNT(*) as \"Orders\", SUM(order_total) as \"Revenue\" FROM orders WHERE order_date >= NOW() - INTERVAL '30 days' GROUP BY 1 ORDER BY 1",
          "format": "time_series"
        }],
        "title": "Orders & Revenue Trend",
        "type": "graph",
        "gridPos": {"x": 0, "y": 0, "w": 24, "h": 8}
      },
      {
        "datasource": "IDGemz PostgreSQL",
        "targets": [{
          "rawSql": "SELECT SUM(order_total) FROM orders WHERE order_date::date = CURRENT_DATE",
          "format": "table"
        }],
        "title": "Today's Revenue",
        "type": "stat",
        "gridPos": {"x": 0, "y": 8, "w": 6, "h": 4}
      },
      {
        "datasource": "IDGemz PostgreSQL",
        "targets": [{
          "rawSql": "SELECT COUNT(*) FROM orders WHERE order_date::date = CURRENT_DATE",
          "format": "table"
        }],
        "title": "Today's Orders",
        "type": "stat",
        "gridPos": {"x": 6, "y": 8, "w": 6, "h": 4}
      },
      {
        "datasource": "IDGemz PostgreSQL",
        "targets": [{
          "rawSql": "SELECT p.title as \"Product\", SUM(oi.quantity) as \"Units\", SUM(oi.total) as \"Revenue\" FROM order_items oi JOIN channel_listings cl ON oi.channel_listing_id = cl.id JOIN products p ON cl.product_id = p.id JOIN orders o ON oi.order_id = o.id WHERE o.order_date >= NOW() - INTERVAL '7 days' GROUP BY p.title ORDER BY \"Revenue\" DESC LIMIT 10",
          "format": "table"
        }],
        "title": "Top Products (Last 7 Days)",
        "type": "table",
        "gridPos": {"x": 12, "y": 8, "w": 12, "h": 8}
      }
    ]
  }
}
```

To import:
1. Click the **+** icon → **Import**
2. Paste the JSON above
3. Click **Load**
4. Select your PostgreSQL data source
5. Click **Import**