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

function persistImprovementStateUpdate(improvements) {
  if (!improvements?.updatedState || !improvements?.statePath) return;

  try {
    fs.writeFileSync(improvements.statePath, JSON.stringify(improvements.updatedState, null, 2));
  } catch (e) {
    console.warn('Could not write improvements-state.json:', e?.message || e);
  }
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

function getSkuFamily(sku, title = '') {
  const text = `${sku || ''} ${title || ''}`.toUpperCase();

  if (text.includes('DF') || text.includes('DUMPSTER')) return 'DF';
  if (text.includes('FLAG') || text.includes('PATRIOTIC') || text.includes('MADE IN USA')) return 'Flag';
  if (text.includes('NK250')) return 'NK250';
  if (text.includes('CF') || text.includes('CARBON FIBER')) return 'CF';
  if (text.includes('YUBI') && (text.includes('RSA') || text.includes('BHT2STE-RSA') || text.includes('BHT3STE-RSA'))) return 'RSA+Yubi';
  if (text.includes('YUBI')) return 'Yubi';
  if (
    text.includes('GO6') || text.includes('GO 6') ||
    text.includes('GO7') || text.includes('GO 7') ||
    text.includes('ETOKEN') || text.includes('HID') ||
    text.includes('SUREPASS') || /(^|[-_\s])SP($|[-_\s])/.test(sku || '')
  ) return 'Other Token';
  if (/^BHT[123]STE-V2$/i.test(sku || '')) return 'Stealth RSA';
  if (/^BHT[123]STE$/i.test(sku || '')) return 'Legacy RSA';

  return 'Other';
}

function makeEmptyFamilyMetric(name) {
  return {
    family: name,
    recentUnits: 0,
    recentRevenue: 0,
    previousUnits: 0,
    previousRevenue: 0,
    unitDelta: 0,
    revenueDelta: 0,
    weeklyUnits: []
  };
}

async function getSalesTrends(reportDateStr) {
  const reportDate = DateTime.fromISO(reportDateStr, { zone: 'America/Los_Angeles' }).startOf('day');
  const recentStart = reportDate.minus({ days: 29 }).toISODate();
  const previousStart = reportDate.minus({ days: 59 }).toISODate();
  const weekStart = reportDate.minus({ weeks: 11 }).startOf('week').toISODate();
  const endExclusive = reportDate.plus({ days: 1 }).toISODate();
  const bulkStart = reportDate.minus({ days: 29 }).toISODate();
  const familyOrder = ['Stealth RSA', 'Yubi', 'CF', 'Flag', 'DF', 'RSA+Yubi', 'Other Token'];

  const trendRows = await pool.query(`
    SELECT
      to_char((o.order_date AT TIME ZONE 'America/Los_Angeles')::date, 'YYYY-MM-DD') AS date_pt,
      to_char(date_trunc('week', (o.order_date AT TIME ZONE 'America/Los_Angeles')::date), 'YYYY-MM-DD') AS week_pt,
      p.internal_sku AS sku,
      p.title,
      SUM(oi.quantity)::int AS units,
      COALESCE(SUM(oi.quantity * oi.unit_price), 0)::numeric AS revenue
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    JOIN channel_listings cl ON cl.id = oi.channel_listing_id
    JOIN products p ON p.id = cl.product_id
    WHERE (o.order_date AT TIME ZONE 'America/Los_Angeles')::date >= $1::date
      AND (o.order_date AT TIME ZONE 'America/Los_Angeles')::date < $2::date
      AND COALESCE(o.status,'') <> 'Pending'
    GROUP BY 1, 2, 3, 4
    ORDER BY 1
  `, [weekStart, endExclusive]);

  const families = new Map(familyOrder.map((name) => [name, makeEmptyFamilyMetric(name)]));
  const weekLabels = [];
  const lastWeekStart = reportDate.startOf('week');
  for (let d = DateTime.fromISO(weekStart); d <= lastWeekStart; d = d.plus({ weeks: 1 })) {
    weekLabels.push(d.toISODate());
  }

  for (const row of trendRows.rows) {
    const family = getSkuFamily(row.sku, row.title);
    if (!families.has(family)) families.set(family, makeEmptyFamilyMetric(family));

    const metric = families.get(family);
    const units = Number(row.units || 0);
    const revenue = Number(row.revenue || 0);

    if (row.date_pt >= recentStart) {
      metric.recentUnits += units;
      metric.recentRevenue += revenue;
    } else if (row.date_pt >= previousStart) {
      metric.previousUnits += units;
      metric.previousRevenue += revenue;
    }

    const weekIndex = weekLabels.indexOf(row.week_pt);
    if (weekIndex >= 0) {
      metric.weeklyUnits[weekIndex] = (metric.weeklyUnits[weekIndex] || 0) + units;
    }
  }

  const familyMetrics = [...families.values()]
    .map((metric) => {
      const weeklyUnits = weekLabels.map((_, index) => metric.weeklyUnits[index] || 0);
      return {
        ...metric,
        weeklyUnits,
        unitDelta: metric.recentUnits - metric.previousUnits,
        revenueDelta: metric.recentRevenue - metric.previousRevenue
      };
    })
    .filter((metric) => familyOrder.includes(metric.family) || metric.recentUnits);

  const recentUnits = familyMetrics.reduce((sum, metric) => sum + metric.recentUnits, 0);
  const familyMix = familyMetrics
    .filter((metric) => metric.recentUnits > 0)
    .map((metric) => ({
      family: metric.family,
      units: metric.recentUnits,
      share: recentUnits > 0 ? metric.recentUnits / recentUnits : 0
    }))
    .sort((a, b) => b.units - a.units);

  const bulkRows = await pool.query(`
    SELECT
      to_char((o.order_date AT TIME ZONE 'America/Los_Angeles')::date, 'YYYY-MM-DD') AS date_pt,
      c.platform,
      o.channel_order_id,
      p.internal_sku AS sku,
      p.title,
      SUM(oi.quantity)::int AS units,
      COALESCE(SUM(oi.quantity * oi.unit_price), 0)::numeric AS revenue
    FROM orders o
    JOIN channels c ON c.id = o.channel_id
    JOIN order_items oi ON oi.order_id = o.id
    JOIN channel_listings cl ON cl.id = oi.channel_listing_id
    JOIN products p ON p.id = cl.product_id
    WHERE (o.order_date AT TIME ZONE 'America/Los_Angeles')::date >= $1::date
      AND (o.order_date AT TIME ZONE 'America/Los_Angeles')::date < $2::date
      AND COALESCE(o.status,'') <> 'Pending'
    GROUP BY 1, 2, 3, 4, 5
    HAVING SUM(oi.quantity) >= 5
    ORDER BY units DESC, revenue DESC
    LIMIT 8
  `, [bulkStart, endExclusive]);

  const biggestGainer = familyMetrics
    .filter((metric) => metric.unitDelta > 0)
    .sort((a, b) => b.unitDelta - a.unitDelta)[0] || null;
  const biggestCooler = familyMetrics
    .filter((metric) => metric.unitDelta < 0)
    .sort((a, b) => a.unitDelta - b.unitDelta)[0] || null;

  return {
    recentStart,
    previousStart,
    reportDate: reportDateStr,
    weekLabels,
    families: familyMetrics,
    familyMix,
    bulkSignals: bulkRows.rows.map((row) => ({
      date: row.date_pt,
      channel: row.platform,
      orderId: row.channel_order_id,
      family: getSkuFamily(row.sku, row.title),
      sku: row.sku,
      title: row.title,
      units: Number(row.units || 0),
      revenue: Number(row.revenue || 0)
    })),
    biggestGainer,
    biggestCooler
  };
}

async function generateDailySalesReport({ persistImprovementState = true } = {}) {
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

    const salesTrends = await getSalesTrends(reportDateStr);
    
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
      })),
      salesTrends
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
    if (persistImprovementState) {
      persistImprovementStateUpdate(improvements);
    }
    
    return { htmlReport, telegramSummary, report, improvements };
    
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
  const escapeHtml = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
  const improvementsHtml = improvementsMarkdown
    ? `
    <h2>🛠️ Recent Improvements / Bug Fixes</h2>
    <div class="warning"><pre style="white-space: pre-wrap; margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px;">${escapeHtml(improvementsMarkdown)}</pre></div>`
    : '';
  const fmtNumber = (value) => Number(value || 0).toLocaleString('en-US');
  const trendSign = (value) => value > 0 ? '+' : '';
  const signedCurrency = (value) => `${value > 0 ? '+' : value < 0 ? '-' : ''}${formatCurrency(Math.abs(value))}`;
  const sparklinePoints = (values, width = 140, height = 34) => {
    const max = Math.max(...values, 1);
    if (values.length === 1) return `0,${height - (values[0] / max * height)}`;
    return values.map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - (value / max * height);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  };
  const familyColors = {
    'Stealth RSA': '#2563eb',
    Yubi: '#16a34a',
    CF: '#374151',
    Flag: '#dc2626',
    DF: '#f97316',
    'RSA+Yubi': '#7c3aed',
    'Other Token': '#0891b2',
    NK250: '#ca8a04',
    Other: '#64748b'
  };
  const maxTrendUnits = Math.max(
    ...(report.salesTrends?.families || []).flatMap((metric) => [metric.recentUnits, metric.previousUnits]),
    1
  );
  const familyTrendHtml = report.salesTrends?.families?.length
    ? `
    <h2>📈 Sales Trends</h2>
    <div class="trend-note">SKU-family trends use item-level order rows for attribution. Bars compare the latest 30 days ending ${escapeHtml(report.salesTrends.reportDate)} against the prior 30 days.</div>
    <div class="trend-callouts">
      <div class="callout">
        <span class="label">Biggest gainer</span>
        <strong>${escapeHtml(report.salesTrends.biggestGainer?.family || 'None')}</strong>
        <span>${report.salesTrends.biggestGainer ? `${trendSign(report.salesTrends.biggestGainer.unitDelta)}${fmtNumber(report.salesTrends.biggestGainer.unitDelta)} units` : 'No family grew'}</span>
      </div>
      <div class="callout">
        <span class="label">Biggest cooler</span>
        <strong>${escapeHtml(report.salesTrends.biggestCooler?.family || 'None')}</strong>
        <span>${report.salesTrends.biggestCooler ? `${fmtNumber(report.salesTrends.biggestCooler.unitDelta)} units` : 'No family cooled'}</span>
      </div>
    </div>
    <div class="trend-list">
      ${report.salesTrends.families.map((metric) => {
        const color = familyColors[metric.family] || familyColors.Other;
        const lastWidth = Math.max((metric.recentUnits / maxTrendUnits) * 100, metric.recentUnits ? 4 : 0);
        const prevWidth = Math.max((metric.previousUnits / maxTrendUnits) * 100, metric.previousUnits ? 4 : 0);
        const deltaClass = metric.unitDelta >= 0 ? 'positive' : 'negative';
        return `
        <div class="trend-row">
          <div class="trend-name">${escapeHtml(metric.family)}</div>
          <div class="trend-bars">
            <div class="bar-line"><span>Last 30</span><div class="bar-track"><div class="bar-fill" style="width:${lastWidth.toFixed(1)}%; background:${color};"></div></div><strong>${fmtNumber(metric.recentUnits)}</strong></div>
            <div class="bar-line previous"><span>Prior</span><div class="bar-track"><div class="bar-fill" style="width:${prevWidth.toFixed(1)}%;"></div></div><strong>${fmtNumber(metric.previousUnits)}</strong></div>
          </div>
          <div class="spark">
            <svg viewBox="0 0 140 34" role="img" aria-label="${escapeHtml(metric.family)} weekly units">
              <polyline points="${sparklinePoints(metric.weeklyUnits)}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></polyline>
            </svg>
          </div>
          <div class="trend-delta ${deltaClass}">
            ${trendSign(metric.unitDelta)}${fmtNumber(metric.unitDelta)} units<br>
            ${signedCurrency(metric.revenueDelta)}
          </div>
        </div>`;
      }).join('')}
    </div>
    <div class="mix-strip" aria-label="Latest 30-day family mix">
      ${report.salesTrends.familyMix.map((metric) => `<div title="${escapeHtml(metric.family)}: ${fmtNumber(metric.units)} units" style="width:${(metric.share * 100).toFixed(1)}%; background:${familyColors[metric.family] || familyColors.Other};"></div>`).join('')}
    </div>
    <div class="mix-legend">
      ${report.salesTrends.familyMix.map((metric) => `<span><i style="background:${familyColors[metric.family] || familyColors.Other};"></i>${escapeHtml(metric.family)} ${fmtNumber(metric.units)}</span>`).join('')}
    </div>`
    : '';
  const bulkSignalsHtml = report.salesTrends?.bulkSignals?.length
    ? `
    <h2>🏢 Bulk / B2B Signals</h2>
    <table>
      <tr>
        <th>Date</th>
        <th>Channel</th>
        <th>Family</th>
        <th>SKU</th>
        <th>Units</th>
        <th>Revenue</th>
      </tr>
      ${report.salesTrends.bulkSignals.map((row) => `
      <tr>
        <td>${escapeHtml(row.date)}</td>
        <td>${escapeHtml(String(row.channel || '').toUpperCase())}</td>
        <td>${escapeHtml(row.family)}</td>
        <td>${escapeHtml(row.sku)}</td>
        <td>${row.units}</td>
        <td>${formatCurrency(row.revenue)}</td>
      </tr>`).join('')}
    </table>`
    : '';
  
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
        .trend-note { color: #5f6b7a; font-size: 13px; margin-top: -8px; }
        .trend-callouts { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin: 16px 0; }
        .callout { background: #f8f9fa; border-left: 4px solid #3498db; padding: 12px; border-radius: 6px; }
        .callout .label { display: block; color: #5f6b7a; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
        .callout strong { display: block; font-size: 18px; color: #2c3e50; }
        .trend-list { border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; margin-top: 12px; }
        .trend-row { display: grid; grid-template-columns: 94px 1fr 150px 92px; gap: 12px; align-items: center; padding: 12px; border-bottom: 1px solid #e5e7eb; }
        .trend-row:last-child { border-bottom: 0; }
        .trend-name { font-weight: bold; color: #2c3e50; }
        .bar-line { display: grid; grid-template-columns: 48px 1fr 42px; gap: 8px; align-items: center; font-size: 12px; margin: 3px 0; }
        .bar-line span { color: #5f6b7a; }
        .bar-track { height: 9px; background: #eef2f7; border-radius: 99px; overflow: hidden; }
        .bar-fill { height: 100%; border-radius: 99px; background: #9ca3af; }
        .bar-line.previous .bar-fill { background: #cbd5e1; }
        .spark svg { width: 140px; height: 34px; background: #f8fafc; border-radius: 6px; }
        .trend-delta { text-align: right; font-size: 12px; font-weight: bold; font-variant-numeric: tabular-nums; }
        .mix-strip { display: flex; height: 16px; margin-top: 16px; overflow: hidden; border-radius: 99px; background: #eef2f7; }
        .mix-strip div { min-width: 2px; }
        .mix-legend { display: flex; flex-wrap: wrap; gap: 10px 14px; margin-top: 8px; font-size: 12px; color: #4b5563; }
        .mix-legend i { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 5px; }
        @media (max-width: 700px) {
          .summary-grid, .trend-callouts { grid-template-columns: 1fr; }
          .trend-row { grid-template-columns: 1fr; }
          .trend-delta { text-align: left; }
        }
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
            <td>${index === 0 ? '🥇 ' : index === 1 ? '🥈 ' : '🥉 '}${escapeHtml(product.product)}</td>
            <td>${escapeHtml(product.sku)}</td>
            <td>${product.unitsSold}</td>
            <td>${formatCurrency(product.revenue)}</td>
        </tr>
        `).join('')}
    </table>
    ${familyTrendHtml}
    ${bulkSignalsHtml}
    
    ${improvementsHtml}

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
  
  summary += `\n📲 Full report delivered via Telegram`;
  
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

module.exports = { generateDailySalesReport, persistImprovementStateUpdate };
