#!/usr/bin/env node

require('dotenv').config();
require('./gog-env');

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

function decodeHtml(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeIdentifierText(text) {
  return decodeHtml(text)
    .normalize('NFKC')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
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

async function loadEtsySkuToSheetSku(pool) {
  const res = await pool.query(
    `WITH etsy AS (
       SELECT product_id, id_value AS etsy_sku
       FROM public.product_identifiers
       WHERE id_type = 'etsy_sku' AND active = true
     ), sheet AS (
       SELECT product_id, id_value AS google_sheet_sku
       FROM public.product_identifiers
       WHERE id_type = 'google_sheet_sku' AND active = true
     )
     SELECT etsy.etsy_sku, sheet.google_sheet_sku
     FROM etsy
     JOIN sheet ON sheet.product_id = etsy.product_id`
  );
  const m = new Map();
  for (const r of res.rows) m.set(String(r.etsy_sku), String(r.google_sheet_sku));
  return m;
}

async function loadEtsyEmailMatchers(pool) {
  const res = await pool.query(
    `WITH email_alias AS (
       SELECT product_id, id_value AS email_match
       FROM public.product_identifiers
       WHERE id_type = 'etsy_email_contains' AND active = true
     ), etsy AS (
       SELECT product_id, id_value AS etsy_sku
       FROM public.product_identifiers
       WHERE id_type = 'etsy_sku' AND active = true
     ), sheet AS (
       SELECT product_id, id_value AS google_sheet_sku
       FROM public.product_identifiers
       WHERE id_type = 'google_sheet_sku' AND active = true
     )
     SELECT email_alias.email_match, etsy.etsy_sku, sheet.google_sheet_sku
     FROM email_alias
     JOIN etsy ON etsy.product_id = email_alias.product_id
     LEFT JOIN sheet ON sheet.product_id = email_alias.product_id`
  );

  return res.rows.map((r) => {
    const parts = String(r.email_match)
      .split('||')
      .map(normalizeIdentifierText)
      .filter(Boolean);
    return {
      parts,
      sourceValue: r.email_match,
      sku: r.etsy_sku,
      sheetSku: r.google_sheet_sku
    };
  }).sort((a, b) => {
    if (b.parts.length !== a.parts.length) return b.parts.length - a.parts.length;
    return b.parts.join(' ').length - a.parts.join(' ').length;
  });
}

function resolveEtsyEmailIdentifier(matchers, item, extraText) {
  const haystack = normalizeIdentifierText([
    item.title,
    item.tokenConfig,
    item.numberOfTokens,
    extraText
  ].filter(Boolean).join('\n'));

  return matchers.find((m) => m.parts.length && m.parts.every((part) => haystack.includes(part))) || null;
}

function parseLineItems(body) {
  const items = [];
  const regex = /Transaction ID:\s*(\d+)([\s\S]*?)(?=Transaction ID:|[-]{10,}|Shipping:|Sales Tax:|Order Total:|$)/gi;
  let match;
  while ((match = regex.exec(body)) !== null) {
    const transactionId = match[1];
    const block = match[2] || '';
    const title = (block.match(/Item:\s*([^\n]+)/i) || [])[1]?.trim() || null;
    const tokenConfig = (block.match(/(?:Token\s+)?Configuration:\s*([^\n]+)/i) || [])[1]?.trim() || null;
    const numberOfTokens = (block.match(/Number of Tokens:\s*([^\n]+)/i) || [])[1]?.trim() || null;
    const quantity = Number((block.match(/Quantity:\s*(\d+)/i) || [])[1] || 1);
    const itemPrice = money(block, 'Item price');

    items.push({
      transactionId,
      title,
      tokenConfig,
      numberOfTokens,
      quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
      itemPrice
    });
  }
  return items;
}

function extractOrder(body, subject, messageDate) {
  const orderMatch = body.match(/order number is:\s*(\d+)/i) || subject.match(/Order\s*#(\d+)/i);
  if (!orderMatch) return null;
  const orderNumber = orderMatch[1];

  let orderedDate = null;
  const orderedOn = body.match(/Ordered on:?\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}(?:\s+at\s+\d{1,2}:\d{2}\s*(?:AM|PM))?)/i)
    || body.match(/Order date:?\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}(?:\s+at\s+\d{1,2}:\d{2}\s*(?:AM|PM))?)/i);
  if (orderedOn) {
    const parsed = new Date(orderedOn[1]);
    if (!Number.isNaN(parsed.getTime())) orderedDate = parsed;
  }
  if (!orderedDate && messageDate) {
    const parsedMsgDate = new Date(messageDate.replace(' ', 'T'));
    if (!Number.isNaN(parsedMsgDate.getTime())) orderedDate = parsedMsgDate;
  }

  const lineItems = parseLineItems(body);
  const firstItem = lineItems[0] || null;
  const tokenConfig = firstItem?.tokenConfig || null;
  const title = firstItem?.title || (body.match(/Item:\s*([^\n]+)/i) || [])[1]?.trim() || null;

  const ship = body.match(/Shipping address \*\s*\n([^\n]+)\n([^\n]+)\n([A-Z .'-]+),\s*([A-Z]{2})\s*(\d{5}(?:-\d{4})?)/i);
  const transactionId = firstItem?.transactionId || (body.match(/Transaction ID:\s*(\d+)/i) || [])[1] || null;

  const itemTotal = money(body, 'Item total');
  const subtotal = money(body, 'Subtotal');
  const tax = money(body, 'Sales tax');
  const orderTotal = money(body, 'Order total');
  const revenue = subtotal ?? itemTotal;

  if (revenue == null) return null;

  return {
    orderNumber,
    orderedDate,
    title,
    tokenConfig,
    transactionId,
    lineItems,
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
    const etsySkuToSheetSku = await loadEtsySkuToSheetSku(pool);
    const etsyEmailMatchers = await loadEtsyEmailMatchers(pool);

    const query = `in:inbox subject:("You made a sale on Etsy") newer_than:${LOOKBACK}`;
    const messages = gogSearch(query, 50);

    let imported = 0;
    let updated = 0;
    let skipped = 0;

    for (const msg of messages) {
      const body = msg.body || '';
      const subject = msg.subject || '';
      const parsed = extractOrder(body, subject, msg.date);
      if (!parsed) {
        skipped++;
        continue;
      }

      const existingOrderRes = await pool.query(
        `SELECT id FROM public.orders WHERE channel_id=$1 AND channel_order_id=$2 LIMIT 1`,
        [etsyChannelId, parsed.orderNumber]
      );
      const exists = existingOrderRes.rows.length > 0;

      const orderRes = await pool.query(
        `INSERT INTO public.orders (
           channel_id, channel_order_id, order_date, customer_name, shipping_address,
           order_total, currency, status, fulfillment_channel, created_at, updated_at, amount_known
         ) VALUES (
           $1::uuid, $2::text, COALESCE($3::timestamptz, NOW()), $4::text,
           jsonb_strip_nulls(jsonb_build_object(
             'name',$4::text,'address1',$5::text,'city',$6::text,'state',$7::text,'postal_code',$8::text,'country','US'
           )),
           $9::numeric, 'USD', 'manual_import', 'etsy', now(), now(), true
         )
         ON CONFLICT (channel_id, channel_order_id)
         DO UPDATE SET
           order_date = COALESCE(EXCLUDED.order_date, public.orders.order_date),
           customer_name = COALESCE(EXCLUDED.customer_name, public.orders.customer_name),
           shipping_address = COALESCE(EXCLUDED.shipping_address, public.orders.shipping_address),
           order_total = EXCLUDED.order_total,
           updated_at = now(),
           amount_known = true
         RETURNING id`,
        [
          etsyChannelId,
          parsed.orderNumber,
          parsed.orderedDate ? parsed.orderedDate.toISOString() : null,
          parsed.customerName,
          parsed.address1,
          parsed.city,
          parsed.state,
          parsed.postal,
          parsed.revenue
        ]
      );
      const orderId = orderRes.rows[0].id;

      const lineItems = parsed.lineItems?.length
        ? parsed.lineItems
        : [{
            transactionId: parsed.transactionId,
            title: parsed.title,
            tokenConfig: parsed.tokenConfig,
            numberOfTokens: null,
            quantity: 1,
            itemPrice: parsed.revenue
          }];
      const normalizedLineItems = lineItems.map((item) => {
        const quantity = Number.isFinite(Number(item.quantity)) && Number(item.quantity) > 0 ? Number(item.quantity) : 1;
        const unitPrice = Number.isFinite(Number(item.itemPrice)) ? Number(item.itemPrice) : parsed.revenue;
        const identifierMatch = resolveEtsyEmailIdentifier(etsyEmailMatchers, item, body);
        return {
          ...item,
          quantity,
          unitPrice,
          lineSubtotal: quantity * unitPrice,
          sku: identifierMatch?.sku || null,
          sheetSku: identifierMatch?.sheetSku || null,
          emailMatch: identifierMatch?.sourceValue || null
        };
      });
      const taxTotal = Number(parsed.tax || 0);
      const taxBasis = normalizedLineItems.reduce((sum, item) => sum + Math.max(item.lineSubtotal, 0), 0);

      for (const item of normalizedLineItems) {
        let itemListingId = null;
        const itemSheetSku = item.sheetSku || etsySkuToSheetSku.get(String(item.sku || '').trim()) || null;
        if (item.sku) {
          await pool.query(
            `WITH product_match AS (
               SELECT pi.product_id
               FROM public.product_identifiers pi
               WHERE pi.active = true
                 AND (
                   (pi.id_type = 'etsy_sku' AND pi.id_value = $2::text)
                   OR ($3::text IS NOT NULL AND pi.id_type = 'google_sheet_sku' AND pi.id_value = $3::text)
                   OR (pi.id_type = 'amazon_sku' AND pi.id_value = $2::text)
                 )
               ORDER BY CASE pi.id_type
                 WHEN 'etsy_sku' THEN 0
                 WHEN 'google_sheet_sku' THEN 1
                 ELSE 2
               END
               LIMIT 1
             )
             INSERT INTO public.channel_listings (product_id, channel_id, channel_sku, status, created_at, updated_at)
             SELECT product_id, $1::uuid, $2::text, 'active', now(), now()
             FROM product_match
             ON CONFLICT (channel_id, channel_sku)
             DO UPDATE SET product_id=EXCLUDED.product_id, updated_at=now()`,
            [etsyChannelId, item.sku, itemSheetSku]
          );
          const listRes = await pool.query(
            `SELECT id FROM public.channel_listings WHERE channel_id=$1 AND channel_sku=$2 LIMIT 1`,
            [etsyChannelId, item.sku]
          );
          itemListingId = listRes.rows[0]?.id || null;
        }

        const itemRaw = {
          source: 'etsy_email',
          sku: item.sku,
          sheet_sku: itemSheetSku,
          etsy_email_match: item.emailMatch,
          title: item.title,
          token_configuration: item.tokenConfig,
          number_of_tokens: item.numberOfTokens,
          transaction_id: item.transactionId,
          subject: parsed.subject
        };

        const existingItem = await pool.query(
          `SELECT id, channel_listing_id FROM public.order_items
           WHERE order_id = $1
             AND (
               ($2::text IS NOT NULL AND raw->>'transaction_id' = $2::text)
               OR (
                 $2::text IS NULL
                 AND COALESCE(raw->>'source','') = 'etsy_email'
                 AND COALESCE(raw->>'sku','') = COALESCE($3::text, '')
               )
             )
           ORDER BY CASE WHEN COALESCE(raw->>'source','') = 'etsy_email' THEN 0 ELSE 1 END
           LIMIT 1`,
          [orderId, item.transactionId, item.sku]
        );

        const effectiveListingId = itemListingId || existingItem.rows[0]?.channel_listing_id || null;
        const quantity = item.quantity;
        const unitPrice = item.unitPrice;
        const lineTax = taxBasis > 0
          ? taxTotal * (Math.max(item.lineSubtotal, 0) / taxBasis)
          : (normalizedLineItems.length === 1 ? taxTotal : 0);

        let canonicalItemId;
        if (existingItem.rows.length) {
          canonicalItemId = existingItem.rows[0].id;
          await pool.query(
            `UPDATE public.order_items
             SET channel_listing_id = COALESCE($2, channel_listing_id),
                 quantity = $3, unit_price = $4, tax = $5,
                 raw = $6::jsonb
             WHERE id = $1`,
            [canonicalItemId, effectiveListingId, quantity, unitPrice, lineTax, JSON.stringify(itemRaw)]
          );
        } else {
          const insertedItem = await pool.query(
            `INSERT INTO public.order_items (order_id, channel_listing_id, quantity, unit_price, tax, raw, created_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())
             RETURNING id`,
            [orderId, effectiveListingId, quantity, unitPrice, lineTax, JSON.stringify(itemRaw)]
          );
          canonicalItemId = insertedItem.rows[0].id;
        }

        if (item.transactionId) {
          await pool.query(
            `DELETE FROM public.order_items
             WHERE order_id = $1
               AND id <> $2
               AND raw->>'transaction_id' = $3::text
               AND COALESCE(raw->>'source','') IN ('manual_etsy_message', 'etsy_email')`,
            [orderId, canonicalItemId, item.transactionId]
          );
        }
      }

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
