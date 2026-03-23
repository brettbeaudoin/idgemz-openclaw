const { Pool } = require('pg');
const { SellingPartner } = require('amazon-sp-api');
const { DateTime } = require('luxon');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
require('dotenv').config({ path: path.resolve(__dirname, '.env.local'), override: true });

function safeReadJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function readImprovementLogForEmail({ reportDateStr }) {
  // Include any log entries added since last time we included them.
  const logPath = path.resolve(__dirname, '../improvements-log.md');
  const statePath = path.resolve(__dirname, '../memory/improvements-state.json');

  if (!fs.existsSync(logPath)) return { markdown: null, updatedState: null };

  const state = safeReadJson(statePath, { lastIncludedIso: null });
  const lastIso = state?.lastIncludedIso;

  const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/);
  const entries = [];

  // Convention: entries start with a line like:
  // "## 2026-02-04T14:12:00Z"
  // We include any entries after lastIncludedIso.
  let current = null;
  for (const line of lines) {
    const m = line.match(/^##\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\s*$/);
    if (m) {
      if (current) entries.push(current);
      current = { ts: m[1], lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) entries.push(current);

  const newEntries = entries.filter((e) => !lastIso || e.ts > lastIso);
  if (!newEntries.length) return { markdown: null, updatedState: null };

  const md = newEntries.map((e) => e.lines.join('\n').trimEnd()).join('\n\n');

  // Advance lastIncludedIso to the newest entry we just included.
  const newest = newEntries[newEntries.length - 1].ts;
  const updatedState = { lastIncludedIso: newest, lastReportDate: reportDateStr };

  return { markdown: md, updatedState, statePath };
}

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost/idgemz'
});

async function persistAmazonDailyMetricsToDb(m, dateStr) {
  try {
    await pool.query(
      `INSERT INTO amazon_daily_metrics (
         date_pt, marketplace_id, total_sales, currency, order_count, order_item_count, unit_count,
         interval, raw, fetched_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb, now())
       ON CONFLICT (date_pt) DO UPDATE SET
         marketplace_id=EXCLUDED.marketplace_id,
         total_sales=EXCLUDED.total_sales,
         currency=EXCLUDED.currency,
         order_count=EXCLUDED.order_count,
         order_item_count=EXCLUDED.order_item_count,
         unit_count=EXCLUDED.unit_count,
         interval=EXCLUDED.interval,
         raw=EXCLUDED.raw,
         fetched_at=now()`,
      [
        dateStr,
        'ATVPDKIKX0DER',
        m.totalSalesAmount,
        m.totalSalesCurrency,
        m.orderCount,
        m.orderItemCount,
        m.unitCount,
        m.interval,
        JSON.stringify(m)
      ]
    );
  } catch (e) {
    // Non-fatal: report generation should not fail if persistence fails
    console.warn('⚠️ Could not persist amazon_daily_metrics (continuing):', e?.message || e);
  }
}

async function fetchAmazonOrderMetricsForPtDay(dateStr) {
  // Amazon sales dashboard "Product sales" aligns with SP-API Sales /orderMetrics.
  // Use PT day boundaries + granularityTimeZone=America/Los_Angeles.
  const chRes = await pool.query(
    `SELECT api_credentials FROM channels WHERE platform='amazon' AND api_connected=true ORDER BY name LIMIT 1`
  );
  if (!chRes.rows.length) throw new Error('Amazon channel not connected');

  const refreshToken = chRes.rows[0].api_credentials.refreshToken;

  const sp = new SellingPartner({
    region: 'na',
    refresh_token: refreshToken,
    credentials: {
      SELLING_PARTNER_APP_CLIENT_ID: process.env.SELLING_PARTNER_APP_CLIENT_ID,
      SELLING_PARTNER_APP_CLIENT_SECRET: process.env.SELLING_PARTNER_APP_CLIENT_SECRET
    },
    options: { auto_request_throttled: true }
  });

  const startPt = DateTime.fromISO(dateStr, { zone: 'America/Los_Angeles' }).startOf('day');
  const endPt = startPt.plus({ days: 1 });

  const interval = `${startPt.toISO()}--${endPt.toISO()}`;

  const metrics = await sp.callAPI({
    endpoint: 'sales',
    operation: 'getOrderMetrics',
    query: {
      marketplaceIds: ['ATVPDKIKX0DER'],
      interval,
      granularity: 'Day',
      granularityTimeZone: 'America/Los_Angeles'
    }
  });

  const m = Array.isArray(metrics) ? metrics[0] : null;
  return {
    interval: m?.interval || interval,
    orderCount: m?.orderCount ?? 0,
    orderItemCount: m?.orderItemCount ?? 0,
    unitCount: m?.unitCount ?? 0,
    totalSalesAmount: m?.totalSales?.amount ?? 0,
    totalSalesCurrency: m?.totalSales?.currencyCode ?? 'USD'
  };
}

async function generateDailySalesReport() {
  try {
    // Report day is always yesterday in Pacific Time to match Amazon Seller dashboard boundaries.
    const reportDatePt = DateTime.now().setZone('America/Los_Angeles').minus({ days: 1 }).startOf('day');
    const reportDateStr = reportDatePt.toISODate();
    
    console.log(`Generating sales report for: ${reportDateStr}`);
    
    // 1. Total sales and orders yesterday
    // We want to match the Amazon Seller app "Sales dashboard".
    // For Amazon: use SP-API Sales /orderMetrics (PT day boundaries).
    // For non-Amazon: use our order_items totals.

    const amazonMetrics = await fetchAmazonOrderMetricsForPtDay(reportDateStr);
    await persistAmazonDailyMetricsToDb(amazonMetrics, reportDateStr);

    // Non-Amazon: use PT day boundaries and PRE-tax/shipping revenue = SUM(quantity * unit_price)
    const nonAmazonDailyStats = await pool.query(`
      SELECT 
        COUNT(DISTINCT o.id) as order_count,
        COALESCE(SUM(oi.quantity * oi.unit_price), 0) as total_revenue,
        COALESCE(SUM(oi.quantity), 0) as units_sold
      FROM orders o
      JOIN channels c ON c.id = o.channel_id
      JOIN order_items oi ON oi.order_id = o.id
      WHERE (o.order_date AT TIME ZONE 'America/Los_Angeles')::date = $1::date
        AND c.platform <> 'amazon'
        AND COALESCE(o.status,'') <> 'Pending'
    `, [reportDateStr]);

    const dailyStats = {
      order_count: (parseInt(nonAmazonDailyStats.rows[0].order_count) || 0) + (amazonMetrics.orderCount || 0),
      total_revenue: (parseFloat(nonAmazonDailyStats.rows[0].total_revenue) || 0) + (amazonMetrics.totalSalesAmount || 0),
      units_sold: (parseInt(nonAmazonDailyStats.rows[0].units_sold) || 0) + (amazonMetrics.unitCount || 0)
    };
    
    // 2. Top selling products
    const topProducts = await pool.query(`
      SELECT 
        p.title as product,
        p.internal_sku as sku,
        SUM(oi.quantity) as units_sold,
        COALESCE(SUM(oi.quantity * oi.unit_price), 0) as revenue
      FROM order_items oi 
      JOIN orders o ON oi.order_id = o.id
      JOIN channel_listings cl ON oi.channel_listing_id = cl.id 
      JOIN products p ON cl.product_id = p.id 
      WHERE (o.order_date AT TIME ZONE 'America/Los_Angeles')::date = $1::date
        AND COALESCE(o.status,'') <> 'Pending'
      GROUP BY p.id, p.title, p.internal_sku 
      ORDER BY revenue DESC 
      LIMIT 3
    `, [reportDateStr]);
    
    // 4. Week-over-week comparison
    const lastWeekDateStr = reportDatePt.minus({ days: 7 }).toISODate();

    const amazonLastWeekMetrics = await fetchAmazonOrderMetricsForPtDay(lastWeekDateStr);
    await persistAmazonDailyMetricsToDb(amazonLastWeekMetrics, lastWeekDateStr);

    const nonAmazonLastWeekStats = await pool.query(`
      SELECT 
        COUNT(DISTINCT o.id) as order_count,
        COALESCE(SUM(oi.quantity * oi.unit_price), 0) as total_revenue
      FROM orders o
      JOIN channels c ON c.id = o.channel_id
      JOIN order_items oi ON oi.order_id = o.id
      WHERE (o.order_date AT TIME ZONE 'America/Los_Angeles')::date = $1::date
        AND c.platform <> 'amazon'
        AND COALESCE(o.status,'') <> 'Pending'
    `, [lastWeekDateStr]);

    const lastWeekStats = {
      order_count: (parseInt(nonAmazonLastWeekStats.rows[0].order_count) || 0) + (amazonLastWeekMetrics.orderCount || 0),
      total_revenue: (parseFloat(nonAmazonLastWeekStats.rows[0].total_revenue) || 0) + (amazonLastWeekMetrics.totalSalesAmount || 0)
    };
    
    // 5. Recent orders (all order line items for yesterday)
    // Output columns mirror the "Top Selling Products" section: product, sku, units_sold, revenue.
    // To preserve the notion of "orders", we prefix the product name with the Amazon order id.
    const recentOrders = await pool.query(`
      SELECT 
        o.channel_order_id as order_id,
        p.title as product,
        p.internal_sku as sku,
        COALESCE(SUM(oi.quantity), 0) as units_sold,
        COALESCE(SUM(oi.quantity * oi.unit_price), 0) as revenue
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      JOIN channel_listings cl ON oi.channel_listing_id = cl.id
      JOIN products p ON cl.product_id = p.id
      WHERE (o.order_date AT TIME ZONE 'America/Los_Angeles')::date = $1::date
        AND COALESCE(o.status,'') <> 'Pending'
      GROUP BY o.channel_order_id, p.title, p.internal_sku
      ORDER BY o.channel_order_id, revenue DESC
    `, [reportDateStr]);
    
    // Channel breakdown (PT day) for non-Amazon channels
    const nonAmazonByChannel = await pool.query(`
      SELECT c.platform,
             COUNT(DISTINCT o.id) AS order_count,
             COALESCE(SUM(oi.quantity),0) AS units_sold,
             COALESCE(SUM(oi.quantity * oi.unit_price),0) AS revenue
      FROM orders o
      JOIN channels c ON c.id=o.channel_id
      JOIN order_items oi ON oi.order_id=o.id
      WHERE (o.order_date AT TIME ZONE 'America/Los_Angeles')::date = $1::date
        AND c.platform <> 'amazon'
        AND COALESCE(o.status,'') <> 'Pending'
      GROUP BY c.platform
      ORDER BY revenue DESC`,
      [reportDateStr]
    );

    // Format the report
    const report = {
      date: reportDateStr,
      summary: {
        totalRevenue: parseFloat(dailyStats.total_revenue),
        totalOrders: parseInt(dailyStats.order_count),
        unitsSold: parseInt(dailyStats.units_sold),
        averageOrderValue: dailyStats.order_count > 0 ? 
          parseFloat(dailyStats.total_revenue) / parseInt(dailyStats.order_count) : 0
      },
      channelBreakdown: [
        {
          channel: 'Amazon',
          platform: 'amazon',
          orderCount: amazonMetrics.orderCount || 0,
          unitsSold: amazonMetrics.unitCount || 0,
          revenue: amazonMetrics.totalSalesAmount || 0
        },
        ...nonAmazonByChannel.rows.map((r) => ({
          channel: (r.platform || '').toString().toUpperCase(),
          platform: r.platform,
          orderCount: parseInt(r.order_count) || 0,
          unitsSold: parseInt(r.units_sold) || 0,
          revenue: parseFloat(r.revenue) || 0
        }))
      ],
      topProducts: topProducts.rows.map(row => ({
        product: row.product,
        sku: row.sku,
        unitsSold: parseInt(row.units_sold),
        revenue: parseFloat(row.revenue)
      })),
      weekComparison: {
        lastWeekRevenue: parseFloat(lastWeekStats.total_revenue),
        lastWeekOrders: parseInt(lastWeekStats.order_count),
        revenueChange: parseFloat(dailyStats.total_revenue) - parseFloat(lastWeekStats.total_revenue),
        ordersChange: parseInt(dailyStats.order_count) - parseInt(lastWeekStats.order_count)
      },
      lowInventory: [],
      orders: recentOrders.rows.map(row => ({
        orderId: row.order_id,
        product: `[${row.order_id}] ${row.product}`,
        sku: row.sku,
        unitsSold: parseInt(row.units_sold),
        revenue: parseFloat(row.revenue)
      }))
    };
    
    // Create HTML email
    const improvements = readImprovementLogForEmail({ reportDateStr });
    const htmlReport = generateHtmlReport(report, { improvementsMarkdown: improvements.markdown });
    
    // Create text summary for Telegram
    const telegramSummary = generateTelegramSummary(report);
    
    // Write to files for email attachment
    fs.writeFileSync('/tmp/idgemz-daily-report.html', htmlReport);
    fs.writeFileSync('/tmp/idgemz-daily-report.json', JSON.stringify(report, null, 2));

    // Persist improvements-state if we included any new entries
    if (improvements.updatedState && improvements.statePath) {
      try {
        fs.writeFileSync(improvements.statePath, JSON.stringify(improvements.updatedState, null, 2));
      } catch (e) {
        console.warn('Could not write improvements-state.json:', e?.message || e);
      }
    }
    
    return { htmlReport, telegramSummary, report };
    
  } catch (error) {
    console.error('Error generating report:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

function generateHtmlReport(report, { improvementsMarkdown } = {}) {
  const percentChange = (current, previous) => {
    if (previous === 0) return current > 0 ? '+100%' : '0%';
    const pct = ((current - previous) / previous * 100).toFixed(1);
    return pct >= 0 ? `+${pct}%` : `${pct}%`;
  };
  
  const formatCurrency = (amount) => `$${amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
  
  return `
<!DOCTYPE html>
<html>
<head>
    <title>IDGemz Daily Sales Report - ${report.date}</title>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px; }
        h1 { color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 10px; }
        h2 { color: #34495e; margin-top: 30px; }
        table { width: 100%; border-collapse: collapse; margin-top: 15px; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
        th { background-color: #3498db; color: white; font-weight: bold; }
        tr:nth-child(even) { background-color: #f8f9fa; }
        .summary-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin: 20px 0; }
        .summary-card { background: #f8f9fa; padding: 20px; border-radius: 8px; text-align: center; }
        .summary-card h3 { margin: 0 0 10px 0; color: #2c3e50; }
        .summary-card .value { font-size: 28px; font-weight: bold; color: #3498db; }
        .positive { color: #27ae60; }
        .negative { color: #e74c3c; }
        .warning { background-color: #fff3cd; padding: 15px; border-radius: 5px; margin: 20px 0; }
    </style>
</head>
<body>
    <h1>IDGemz Daily Sales Report</h1>
    <p><strong>Report Date:</strong> ${report.date}</p>
    
    <h2>📊 Daily Summary</h2>
    <div class="summary-grid">
        <div class="summary-card">
            <h3>Total Revenue</h3>
            <div class="value">${formatCurrency(report.summary.totalRevenue)}</div>
        </div>
        <div class="summary-card">
            <h3>Total Orders</h3>
            <div class="value">${report.summary.totalOrders}</div>
        </div>
        <div class="summary-card">
            <h3>Average Order Value</h3>
            <div class="value">${formatCurrency(report.summary.averageOrderValue)}</div>
        </div>
    </div>
    
    <h2>📈 Week-over-Week Comparison</h2>
    <table>
        <tr>
            <th>Metric</th>
            <th>Yesterday</th>
            <th>Same Day Last Week</th>
            <th>Change</th>
            <th>% Change</th>
        </tr>
        <tr>
            <td>Revenue</td>
            <td>${formatCurrency(report.summary.totalRevenue)}</td>
            <td>${formatCurrency(report.weekComparison.lastWeekRevenue)}</td>
            <td class="${report.weekComparison.revenueChange >= 0 ? 'positive' : 'negative'}">
                ${formatCurrency(Math.abs(report.weekComparison.revenueChange))}
            </td>
            <td class="${report.weekComparison.revenueChange >= 0 ? 'positive' : 'negative'}">
                ${percentChange(report.summary.totalRevenue, report.weekComparison.lastWeekRevenue)}
            </td>
        </tr>
        <tr>
            <td>Orders</td>
            <td>${report.summary.totalOrders}</td>
            <td>${report.weekComparison.lastWeekOrders}</td>
            <td class="${report.weekComparison.ordersChange >= 0 ? 'positive' : 'negative'}">
                ${Math.abs(report.weekComparison.ordersChange)}
            </td>
            <td class="${report.weekComparison.ordersChange >= 0 ? 'positive' : 'negative'}">
                ${percentChange(report.summary.totalOrders, report.weekComparison.lastWeekOrders)}
            </td>
        </tr>
    </table>
    
    <h2>🏆 Top Selling Products</h2>
    <table>
        <tr>
            <th>Product</th>
            <th>SKU</th>
            <th>Units Sold</th>
            <th>Revenue</th>
        </tr>
        ${report.topProducts.map((product, index) => `
        <tr>
            <td>${index === 0 ? '🥇 ' : index === 1 ? '🥈 ' : '🥉 '}${product.product}</td>
            <td>${product.sku}</td>
            <td>${product.unitsSold}</td>
            <td>${formatCurrency(product.revenue)}</td>
        </tr>
        `).join('')}
    </table>
    
    <h2>📦 Recent Orders (all line items from yesterday)</h2>
    <table>
        <tr>
            <th>Product</th>
            <th>SKU</th>
            <th>Units Sold</th>
            <th>Revenue</th>
        </tr>
        ${report.orders.map((row) => `
        <tr>
            <td>${row.product}</td>
            <td>${row.sku}</td>
            <td>${row.unitsSold}</td>
            <td>${formatCurrency(row.revenue)}</td>
        </tr>
        `).join('')}
    </table>

    <hr style="margin-top: 50px;">
    <p style="text-align: center; color: #7f8c8d;">
        This report was automatically generated by IDGemz Sales Bot<br>
        For questions or support, contact brett@nerdwidgets.com
    </p>
</body>
</html>
`;
}

function generateTelegramSummary(report) {
  const formatCurrency = (amount) => `$${amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
  const arrow = (value) => value >= 0 ? '📈' : '📉';
  const percentChange = (current, previous) => {
    if (previous === 0) return current > 0 ? '+100%' : '0%';
    const pct = ((current - previous) / previous * 100).toFixed(1);
    return pct >= 0 ? `+${pct}%` : `${pct}%`;
  };
  
  let summary = `📊 **IDGemz Daily Sales Report**\n`;
  summary += `📅 ${report.date}\n\n`;
  
  summary += `**💰 Total Sales:** ${formatCurrency(report.summary.totalRevenue)} (${report.summary.totalOrders} orders, ${report.summary.unitsSold} units)\n`;
  summary += `**📊 Average Order:** ${formatCurrency(report.summary.averageOrderValue)}\n\n`;
  
  summary += `**📈 Week-over-Week:**\n`;
  summary += `${arrow(report.weekComparison.revenueChange)} Revenue: ${percentChange(report.summary.totalRevenue, report.weekComparison.lastWeekRevenue)} (${formatCurrency(Math.abs(report.weekComparison.revenueChange))})\n`;
  summary += `${arrow(report.weekComparison.ordersChange)} Orders: ${percentChange(report.summary.totalOrders, report.weekComparison.lastWeekOrders)} (${Math.abs(report.weekComparison.ordersChange)} orders)\n\n`;
  
  summary += `**🏆 Top Products:**\n`;
  report.topProducts.forEach((product, index) => {
    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : '🥉';
    summary += `${medal} ${product.product}\n   ${product.unitsSold} units = ${formatCurrency(product.revenue)}\n`;
  });
  
  summary += `\n📧 Full report sent to brett@nerdwidgets.com`;
  
  return summary;
}

// Execute if run directly
if (require.main === module) {
  generateDailySalesReport()
    .then(({ htmlReport, telegramSummary, report }) => {
      console.log('Report generated successfully!');
      console.log('\nTelegram Summary:');
      console.log(telegramSummary);
      console.log('\nHTML report saved to /tmp/idgemz-daily-report.html');
      console.log('JSON report saved to /tmp/idgemz-daily-report.json');
    })
    .catch(error => {
      console.error('Failed to generate report:', error);
      process.exit(1);
    });
}

module.exports = { generateDailySalesReport };