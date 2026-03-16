const { parseCookies } = require('./_util');

module.exports = async (req, res) => {
  try {
    const clientId = process.env.QBO_CLIENT_ID;
    const clientSecret = process.env.QBO_CLIENT_SECRET;

    if (!clientId) return res.status(500).send('Missing env QBO_CLIENT_ID');
    if (!clientSecret) return res.status(500).send('Missing env QBO_CLIENT_SECRET');

    // Prefer explicit base URL, but fall back to current host (works on *.vercel.app).
    const appBase = process.env.APP_BASE_URL || `https://${req.headers.host}`;
    const redirectUri = `${appBase}/api/callback`;

    const { code, realmId, state, error, error_description } = req.query || {};
    if (error) {
      return res.status(400).send(`OAuth error: ${error}\n${error_description || ''}`);
    }
    if (!code || !realmId || !state) {
      return res.status(400).send('Missing code, realmId, or state');
    }

    const cookies = parseCookies(req.headers.cookie);
    const raw = cookies.qbo_oauth;
    if (!raw) return res.status(400).send('Missing qbo_oauth cookie (start at /api/auth)');

    let cookie;
    try { cookie = JSON.parse(raw); } catch { cookie = JSON.parse(decodeURIComponent(raw)); }

    if (cookie.state !== state) {
      return res.status(400).send('State mismatch');
    }

    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: redirectUri,
      code_verifier: cookie.codeVerifier
    });

    const tokenResp = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body
    });

    const text = await tokenResp.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }

    if (!tokenResp.ok) {
      return res.status(500).send(`Token exchange failed (${tokenResp.status}):\n${text}`);
    }

    // Clear cookie
    res.setHeader('Set-Cookie', [`qbo_oauth=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`]);

    // Display result
    const out = {
      obtainedAt: new Date().toISOString(),
      realmId: String(realmId),
      ...json
    };

    const safeHtml = (s) => String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>QBO Connected</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:28px;max-width:900px}code,pre{background:#f6f7f9;padding:2px 6px;border-radius:6px}pre{padding:12px;overflow:auto} .warn{color:#8a0000;font-weight:600}</style>
</head>
<body>
<h2>✅ QuickBooks Connected (Production)</h2>
<p class="warn">These tokens are sensitive. Copy them now, then close this tab.</p>
<p><strong>realmId:</strong> <code>${safeHtml(out.realmId)}</code></p>
<p><strong>refresh_token:</strong> <code>${safeHtml(out.refresh_token || '')}</code></p>
<p>Next on your Mac:</p>
<pre>cd /Users/bbeaudoin/clawd/idgemz-sync
node qbo-save-token.js --realmId ${safeHtml(out.realmId)} --refreshToken "${safeHtml(out.refresh_token || '')}" 
node qbo-test-purchases.js</pre>
<h3>Full token JSON</h3>
<pre>${safeHtml(JSON.stringify(out, null, 2))}</pre>
</body></html>`);
  } catch (e) {
    res.status(500).send(String(e?.stack || e));
  }
};
