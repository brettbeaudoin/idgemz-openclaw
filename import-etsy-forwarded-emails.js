#!/usr/bin/env node

require('dotenv').config();

const { execFileSync } = require('child_process');
const { Pool } = require('pg');

const GOG_ACCOUNT = process.env.GOG_ACCOUNT || 'dangerboatai@gmail.com';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/idgemz';
const LOOKBACK = process.env.ETSY_EMAIL_LOOKBACK || '7d';

function gogSearch(query, max = 50) {
  const out = execFileSync(
    'gog',
    ['gmail', 'messages', 'search', query, '--max', String(max), '--include-body', '--json', '--no-input', '--account', GOG_ACCOUNT],
    { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
  );
  return JSON.parse(out).messages || [];
}

function money(body, label) {
  const patterns = [
    new RegExp(`${label}:\\s*\\$([0-9]+\\.[0-9]{2})`, 'i'),
    new RegExp(`${label}:\\s*\\n\\$([0-9]+\\.[0-9]{2})`, 'i')
  ];
  for (const p of patterns) {
    const m = body.match(p);
    if (m) return Number(m[1]);
  }
  return null;
}

function extractOrder(body, subject) {
  const orderMatch = body.match(/order number is:\s*(\d+)/i) || subject.match(/Order\s*#(\d+)/i);
  if (!orderMatch) return null;
  const orderNumber = orderMatch[1];

  const shipBy = subject.match(/Ship by ([A-Za-z]{3}) (\d{1,2})/i);
  const orderedDate = new Date();
  if (shipBy) {
    // Etsy seller emails are “ship by” ~2 days after order; not reliable as order date.
    // We keep today's date when importing from email-only unless already known elsewhere.
  }

  const bodySnippetStart = body.indexOf('Transaction ID:');
  const pre = bodySnippetStart >= 0 ? body.slice(Math.max(0, bodySnippetStart - 900), bodySnippetStart) : body;

  let sku = null;
  let tokenConfig = null;
  const tc = pre.match(/Token Configuration:\s*([^\n]+)/i);
  if (tc) tokenConfig = tc[1].trim();
  const titleMatch = pre.match(/\n([^\n]+Badge Holder[^\n]+)\n/i);
  const title = titleMatch ? titleMatch[1].trim() : null;

  // Heuristics for current Etsy catalog emails.
  if (/Yubikey 5 NFC & RSA SecurID Tokens/i.test(pre)) {
    if (/1 RSA\s*&\s*1 Yubikey V2/i.test(pre)) sku = 'BHT2STE-RSA-YUBI-V2';
    else if (/2 RSA\s*&\s*1 Yubikey/i.test(pre)) sku = 'BHT3STE-RSA-YUBI';
  } else if (/Flag Badge Holder/i.test(pre)) {
    if (/Holds 2 Tokens/i.test(pre)) sku = 'BHT2FLAG-V2';
  } else if (/Stealth Badge Holder/i.test(pre)) {
    if (/Holds 1 Token/i.test(pre)) sku = 'BHT1STE-V2';
    else if (/Holds 2 Tokens/i.test(pre)) sku = 'BHT2STE-V2';
    else if (/Holds 3 Tokens/i.test(pre)) sku = 'BHT3STE-V2';
  }

  const ship = body.match(/Shipping address \*\s*\n([^\n]+)\n([^\n]+)\n([A-Z .'-]+),\s*([A-Z]{2})\s*(\d{5}(?:-\d{4})?)/i);
  const transactionId = (body.match(/Transaction ID:\s*(\d+)/i) || [])[1] || null;

  const itemTotal = money(body, 'Item total');
  const subtotal = money(body, 'Subtotal');
  const tax = money(body, 'Sales tax');
  const orderTotal = money(body, 'Order total');
  const revenue = subtotal ?? itemTotal;

  if (revenue == null) return null;

  return {
    orderNumber,
    sku,
    title,
    tokenConfig,
    transactionId,
    customerName: ship ? ship[1].trim() : null,
    address1: ship ? ship[2].trim() : null,
    city: ship ? ship[3].trim() : null,
    state: ship ? ship[4].trim() : null,
    postal: ship ? ship[5].trim() : null,
    revenue,
    tax: tax || 0,
    orderTotal,
    subject
  };
}

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const chRes = await pool.query(`SELECT id FROM public.channels WHERE platform='etsy' ORDER BY name LIMIT 1`);
    if (!chRes.rows.length) throw new Error('No Etsy channel found');
    const etsyChannelId = chRes.rows[0].id;

    const query = `in:inbox from:brett@nerdwidgets.com subject:("You made a sale on Etsy") newer_than:${LOOKBACK}`;
    const messages = gogSearch(query, 50);

    let imported = 0;
    let updated = 0;
    let skipped = 0;

    for (const msg of messages) {
      const body = msg.body || '';
      const subject = msg.subject || '';
      const parsed = extractOrder(body, subject);
      if (!parsed) {
        skipped++;
        continue;
      }

      const existingOrderRes = await pool.query(
        `SELECT id FROM public.orders WHERE channel_id=$1 AND channel_order_id=$2 LIMIT 1`,
        [etsyChannelId, parsed.orderNumber]
      );
      const exists = existingOrderRes.rows.length > 0;

      let listingId = null;
      if (parsed.sku) {
        await pool.query(
          `INSERT INTO public.channel_listings (product_id, channel_id, channel_sku, status, created_at, updated_at)
           SELECT pi.product_id, $1::uuid, $2::text, 'active', now(), now()
           FROM public.product_identifiers pi
           WHERE pi.id_type='amazon_sku' AND pi.id_value=$2::text AND pi.active=true
           ON CONFLICT (channel_id, channel_sku)
           DO UPDATE SET product_id=EXCLUDED.product_id, updated_at=now()`,
          [etsyChannelId, parsed.sku]
        );
        const listRes = await pool.query(
          `SELECT id FROM public.channel_listings WHERE channel_id=$1 AND channel_sku=$2 LIMIT 1`,
          [etsyChannelId, parsed.sku]
        );
        listingId = listRes.rows[0]?.id || null;
      }

      const orderRes = await pool.query(
        `INSERT INTO public.orders (
           channel_id, channel_order_id, order_date, customer_name, shipping_address,
           order_total, currency, status, fulfillment_channel, created_at, updated_at, amount_known
         ) VALUES (
           $1::uuid, $2::text, NOW(), $3::text,
           jsonb_strip_nulls(jsonb_build_object(
             'name',$3::text,'address1',$4::text,'city',$5::text,'state',$6::text,'postal_code',$7::text,'country','US'
           )),
           $8::numeric, 'USD', 'manual_import', 'etsy', now(), now(), true
         )
         ON CONFLICT (channel_id, channel_order_id)
         DO UPDATE SET
           customer_name = COALESCE(EXCLUDED.customer_name, public.orders.customer_name),
           shipping_address = COALESCE(EXCLUDED.shipping_address, public.orders.shipping_address),
           order_total = EXCLUDED.order_total,
           updated_at = now(),
           amount_known = true
         RETURNING id`,
        [
          etsyChannelId,
          parsed.orderNumber,
          parsed.customerName,
          parsed.address1,
          parsed.city,
          parsed.state,
          parsed.postal,
          parsed.revenue
        ]
      );
      const orderId = orderRes.rows[0].id;

      const itemRaw = {
        source: 'etsy_email',
        sku: parsed.sku,
        title: parsed.title,
        token_configuration: parsed.tokenConfig,
        transaction_id: parsed.transactionId,
        subject: parsed.subject
      };

      // For Etsy email imports, keep a single canonical order_item row per order.
      // The cron re-sees forwarded emails, so blind inserts would duplicate quantity forever.
      await pool.query(
        `DELETE FROM public.order_items
         WHERE order_id = $1
           AND COALESCE(raw->>'source','') = 'etsy_email'`,
        [orderId]
      );

      await pool.query(
        `INSERT INTO public.order_items (order_id, channel_listing_id, quantity, unit_price, tax, raw, created_at)
         VALUES ($1, $2, 1, $3, $4, $5::jsonb, now())`,
        [orderId, listingId, parsed.revenue, parsed.tax, JSON.stringify(itemRaw)]
      );

      if (exists) updated++; else imported++;
    }

    console.log(`Etsy email import complete: imported=${imported}, updated=${updated}, skipped=${skipped}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
