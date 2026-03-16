# Historical Sales Data ETL Plan

## 📥 Expected Data Sources

### Amazon All Orders Report
- **Format**: CSV/XLSX
- **Key fields**: order-id, purchase-date, sku, product-name, quantity, item-price, shipping-price, order-status
- **Period**: All available history (ideally 2025-2026)

### Etsy Orders CSV
- **Format**: CSV
- **Key fields**: Order ID, Date, Buyer, SKU, Item, Quantity, Price, Shipping
- **Period**: All available history

## 🔄 ETL Process

### 1. Extract
```javascript
// Parse CSV/Excel files
const parseAmazonOrders = (file) => {
  // Map Amazon fields to our schema
}

const parseEtsyOrders = (file) => {
  // Map Etsy fields to our schema
}
```

### 2. Transform
- Normalize date formats
- Clean SKU variations
- Match to existing products or create new
- Handle currency conversions if needed
- Deduplicate against existing orders

### 3. Load
- Bulk insert historical orders
- Update product catalog
- Recalculate aggregates
- Refresh materialized views

## 📊 Benefits of Historical Data

1. **Year-over-Year Comparisons**
   - See growth trends
   - Identify seasonal patterns
   - Forecast future sales

2. **Product Lifecycle Analysis**
   - Track product performance over time
   - Identify declining/growing SKUs
   - Optimize inventory

3. **Customer Insights**
   - Find long-term repeat customers
   - Calculate true lifetime values
   - Identify B2B opportunities

4. **Complete Dashboard**
   - Full historical charts
   - Accurate averages
   - Trend predictions

## 🚀 Ready to Process

Once you download the files tomorrow, I'll:
1. Parse and validate the data
2. Match orders to our existing schema
3. Backfill the database
4. Update Grafana with full historical views
5. Generate insights report on patterns found