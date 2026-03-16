# QBO Production OAuth Callback (Vercel)

This folder contains a tiny Vercel serverless callback so Intuit **Production** OAuth can redirect to a public HTTPS URL.

## What you get
- `GET /api/auth` → redirects you to Intuit consent screen (uses PKCE + state)
- `GET /api/callback` → exchanges code for tokens and **shows refresh_token + realmId**

> After you copy the `refresh_token` + `realmId`, you can delete the Vercel project.

## Deploy steps (Vercel)

1) Create a new Vercel project and import **this folder** (`idgemz-sync/qbo-vercel-callback`).

2) In Vercel → Project → Settings → Environment Variables, set:
- `QBO_CLIENT_ID` = your **Production** client id
- `QBO_CLIENT_SECRET` = your **Production** client secret

Optional:
- `APP_BASE_URL` = `https://<your-project>.vercel.app` (no trailing slash)

If you omit `APP_BASE_URL`, the callback will auto-detect the current host.

3) In Intuit Developer → your app → **Production** → Redirect URIs, add:
- `https://<your-project>.vercel.app/api/callback`

4) Visit:
- `https://<your-project>.vercel.app/api/auth`

5) After you approve, you’ll land on `/api/callback` and it will show:
- `realmId`
- `refresh_token`

## After connect: put token into local encrypted storage
On your Mac:

```bash
cd /Users/bbeaudoin/clawd/idgemz-sync
node qbo-save-token.js --realmId <REALMID> --refreshToken <REFRESH_TOKEN>
node qbo-test-purchases.js
```

## Notes
- Tokens are displayed once in the browser. Treat them like a password.
- This does not persist tokens server-side; it’s intended as a temporary bootstrap.
