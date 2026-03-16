#!/bin/bash
# Quick Grafana setup for IDGemz dashboard

echo "🚀 Setting up Grafana for IDGemz Dashboard..."

# Install Grafana with Homebrew
brew install grafana

# Start Grafana service
brew services start grafana

# Wait for Grafana to start
sleep 5

echo "✅ Grafana installed and running!"
echo "📊 Access your dashboard at: http://localhost:3000"
echo "🔑 Default login: admin/admin"
echo ""
echo "Next steps:"
echo "1. Login to Grafana"
echo "2. Add PostgreSQL data source:"
echo "   - Host: localhost:5432" 
echo "   - Database: idgemz"
echo "   - User: bbeaudoin"
echo "   - SSL Mode: disable"
echo "3. Import the pre-built dashboard (creating next...)"

# Create a basic dashboard config
cat > idgemz-dashboard.json << 'EOF'
{
  "dashboard": {
    "title": "IDGemz Sales Dashboard",
    "panels": [
      {
        "title": "Today's Revenue",
        "targets": [{
          "rawSql": "SELECT SUM(order_total) as revenue FROM orders WHERE order_date::date = CURRENT_DATE"
        }]
      },
      {
        "title": "Orders by Day",
        "targets": [{
          "rawSql": "SELECT DATE(order_date) as day, COUNT(*) as orders FROM orders WHERE order_date > NOW() - INTERVAL '30 days' GROUP BY 1 ORDER BY 1"
        }]
      },
      {
        "title": "Top Products",
        "targets": [{
          "rawSql": "SELECT p.title, SUM(oi.quantity) as units FROM order_items oi JOIN channel_listings cl ON oi.channel_listing_id = cl.id JOIN products p ON cl.product_id = p.id GROUP BY 1 ORDER BY 2 DESC LIMIT 10"
        }]
      }
    ]
  }
}
EOF

echo "📄 Dashboard template saved to: idgemz-dashboard.json"