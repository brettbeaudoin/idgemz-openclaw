const crypto = require('crypto');

function normalizeEmail(email) {
  if (!email) return null;
  const e = String(email).trim().toLowerCase();
  return e || null;
}

function normalizePhone(phone) {
  if (!phone) return null;
  // keep digits + leading +
  const p = String(phone).trim();
  if (!p) return null;
  const cleaned = p.replace(/(?!^)\D/g, ''); // remove non-digits except maybe leading
  // if original started with +, preserve it
  const withPlus = p.startsWith('+') ? `+${cleaned}` : cleaned;
  return withPlus || null;
}

function addressFingerprint(addr) {
  // addr can be object or json string
  let a = addr;
  if (!a) return null;
  if (typeof a === 'string') {
    try { a = JSON.parse(a); } catch { return null; }
  }

  const parts = [
    a.Name,
    a.AddressLine1,
    a.AddressLine2,
    a.AddressLine3,
    a.City,
    a.StateOrRegion,
    a.PostalCode,
    a.CountryCode,
    a.Phone
  ]
    .filter(Boolean)
    .map((s) => String(s).trim().toLowerCase())
    .join('|')
    .replace(/\s+/g, ' ');

  if (!parts) return null;

  // Use a stable hash so fingerprints aren't huge
  return crypto.createHash('sha256').update(parts).digest('hex');
}

async function ensureCustomerForOrder({ pool, channel, buyerName, buyerEmail, shippingAddress, source }) {
  const email = normalizeEmail(buyerEmail);
  const phone = normalizePhone(shippingAddress?.Phone);
  const fp = addressFingerprint(shippingAddress);

  // 1) find by email
  if (email) {
    const found = await pool.query(
      `SELECT customer_id FROM customer_identities WHERE kind='email' AND lower(value)=lower($1) LIMIT 1`,
      [email]
    );
    if (found.rows.length) return found.rows[0].customer_id;
  }

  // 2) find by address fingerprint
  if (fp) {
    const found = await pool.query(
      `SELECT customer_id FROM customer_addresses WHERE fingerprint=$1 LIMIT 1`,
      [fp]
    );
    if (found.rows.length) return found.rows[0].customer_id;
  }

  // 3) create
  const created = await pool.query(
    `INSERT INTO customers (display_name) VALUES ($1) RETURNING id`,
    [buyerName || null]
  );
  const customerId = created.rows[0].id;

  // attach identities (best-effort; ignore dup conflicts)
  if (email) {
    await pool.query(
      `INSERT INTO customer_identities (customer_id, kind, value, source)
       VALUES ($1,'email',$2,$3)
       ON CONFLICT (kind, lower(value)) DO NOTHING`,
      [customerId, email, source || channel || null]
    );
  }
  if (phone) {
    await pool.query(
      `INSERT INTO customer_identities (customer_id, kind, value, source)
       VALUES ($1,'phone',$2,$3)
       ON CONFLICT (kind, lower(value)) DO NOTHING`,
      [customerId, phone, source || channel || null]
    );
  }
  if (shippingAddress && fp) {
    await pool.query(
      `INSERT INTO customer_addresses (customer_id, address, fingerprint, source)
       VALUES ($1,$2::jsonb,$3,$4)
       ON CONFLICT (fingerprint) DO NOTHING`,
      [customerId, JSON.stringify(shippingAddress), fp, source || channel || null]
    );
  }

  return customerId;
}

module.exports = {
  normalizeEmail,
  normalizePhone,
  addressFingerprint,
  ensureCustomerForOrder
};
