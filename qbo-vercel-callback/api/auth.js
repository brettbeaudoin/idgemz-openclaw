const { randomBase64Url, sha256Base64Url } = require('./_util');

module.exports = async (req, res) => {
  try {
    const clientId = process.env.QBO_CLIENT_ID;
    if (!clientId) return res.status(500).send('Missing env QBO_CLIENT_ID');

    // Prefer explicit base URL, but fall back to current host (works on *.vercel.app).
    const appBase = process.env.APP_BASE_URL || `https://${req.headers.host}`;
    const redirectUri = `${appBase}/api/callback`;

    const state = randomBase64Url(16);
    const codeVerifier = randomBase64Url(32);
    const codeChallenge = sha256Base64Url(codeVerifier);

    // Store PKCE verifier + state in an HttpOnly cookie (short-lived).
    // This is just a bootstrap flow; we do not persist anything server-side.
    const payload = JSON.stringify({ state, codeVerifier, createdAt: Date.now() });

    res.setHeader('Set-Cookie', [
      `qbo_oauth=${encodeURIComponent(payload)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`
    ]);

    const scopes = 'com.intuit.quickbooks.accounting';

    const url = new URL('https://appcenter.intuit.com/connect/oauth2');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', scopes);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');

    res.statusCode = 302;
    res.setHeader('Location', url.toString());
    res.end();
  } catch (e) {
    res.status(500).send(String(e?.stack || e));
  }
};
