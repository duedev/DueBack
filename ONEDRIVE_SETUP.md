# OneDrive setup (optional "Save to OneDrive")

The app is **local-first and complete without any cloud** — this guide is only
for the optional OneDrive layer: a **Save to OneDrive** button in the report
bar that uploads the generated workbook to `OneDrive / Apps / DueBack`, plus a
connect/disconnect section in Settings.

Everything is config-less until you provide one env var; without it, every
OneDrive surface stays hidden. There is **no server and no SDK**: the browser
talks to Microsoft directly (OAuth 2.0 authorization-code flow with PKCE, then
Microsoft Graph), and sign-in tokens never leave the user's browser.

## 1. Register the app in Azure (~3 minutes, free)

You need a free Microsoft **app registration** — it's an identifier, not a
hosted resource; there is nothing to pay for or keep running.

1. Sign in to the [Azure portal](https://portal.azure.com) and open
   **Microsoft Entra ID → App registrations → New registration**
   (or go straight to
   [portal.azure.com/#blade/Microsoft_AAD_RegisteredApps](https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)).
   A personal Microsoft account works; the free default directory is enough.
2. Fill the form:
   - **Name:** `DueBack` (users see this on the consent screen).
   - **Supported account types:** *"Accounts in any organizational directory
     (Any Microsoft Entra ID tenant - Multitenant) and personal Microsoft
     accounts (e.g. Skype, Xbox)"* — this is what lets both personal OneDrive
     and OneDrive for Business users sign in. (To restrict to your own
     organization only, pick single-tenant and see `VITE_ONEDRIVE_TENANT`
     below.)
   - **Redirect URI:** choose platform **Single-page application (SPA)** —
     this is the setting that matters most (see Troubleshooting) — and enter
     your deployed app URL, e.g. `https://you.github.io/ReimbursementsF5/`.
3. Register, then on the **Overview** page copy the
   **Application (client) ID** — a GUID. That's the only secret-free value
   the build needs.
4. Still under **Authentication → Single-page application**, add every origin
   the app is served from, exactly as the browser sees it:
   - `http://localhost:5173/` (local dev)
   - `http://localhost:4173/` (vite preview, optional)
   - your production URL (with the trailing slash it actually resolves to)

   The app sends `location.origin + pathname` (with any trailing
   `index.html` stripped) as the redirect URI, so the registered value must
   match that exactly.

No client secret, no certificate: a static site can't keep secrets, which is
exactly what the SPA + PKCE flow is designed for. **API permissions** need no
manual setup either — the app requests its delegated scopes (`Files.ReadWrite`,
`offline_access`, `openid`, `profile`, `email`) dynamically at sign-in, and
each user consents to their own OneDrive; no admin consent is required for
these scopes in the common case.

## 2. Build the app with the client ID

Set the variable wherever the site is built:

```bash
VITE_ONEDRIVE_CLIENT_ID=00000000-0000-0000-0000-000000000000
```

For GitHub Pages, add it as a **repository variable** (the deploy workflow
already forwards `vars.VITE_ONEDRIVE_CLIENT_ID`). For local dev, put it in
`.env` (see `.env.example`).

Optional extras:

```bash
# Lock sign-in to one Microsoft Entra tenant (default "common" = personal +
# any work/school account). Use your tenant GUID or domain. If you restricted
# the registration to single-tenant in step 1, you MUST set this to match.
VITE_ONEDRIVE_TENANT=common

# Override the computed redirect URI (rarely needed — e.g. an embed setup
# where the app's own address isn't what you registered).
VITE_ONEDRIVE_REDIRECT_URI=https://your-registered-url.example/
```

## 3. Use it

- **Report bar → Save to OneDrive:** first use opens a Microsoft sign-in
  popup; after that the workbook is built and uploaded to
  `OneDrive / Apps / DueBack / Reimbursements_<Employee>_<YYYYMMDD>.xlsx`
  (same-named files are replaced — re-saving a report updates it).
- **Settings → OneDrive:** shows the connected account, connects, or
  disconnects (which just forgets the tokens in this browser).

## How it works / privacy

- Auth is the standard **authorization-code + PKCE** popup flow; the token
  exchange goes straight from the browser to
  `login.microsoftonline.com` (Microsoft allows this cross-origin call only
  for SPA-registered redirect URIs — that's why step 2's platform choice
  matters).
- Access/refresh tokens are stored in the browser's localStorage, scoped to
  this app's origin. Nothing is proxied; **no token ever reaches a server of
  ours** (there isn't one).
- Only files you explicitly save are uploaded. Receipts are still read
  on-device; nothing else in the app touches OneDrive.
- Browser refresh tokens are valid for **24 hours** (a Microsoft identity
  platform rule for SPAs), so expect the sign-in popup roughly once a day of
  use. Files under 4 MB upload in one request; larger workbooks stream
  through a chunked Graph upload session.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Popup opens then errors `AADSTS50011` (redirect URI mismatch) | The exact URL (origin + path, trailing slash included) isn't registered. Add it under **Authentication → Single-page application**. |
| Sign-in works but the token exchange fails with `AADSTS9002326` (cross-origin token redemption) | The redirect URI was registered under the **Web** platform. Remove it there and re-add it under **Single-page application**. |
| `AADSTS50194` / "unauthorized_client" for personal accounts | The registration is single-tenant. Either re-register as multitenant + personal accounts, or set `VITE_ONEDRIVE_TENANT` to your tenant and accept org-only sign-in. |
| "Popup blocked" toast | Allow popups for the site, or click the button again (the popup must open inside a click). |
| The button doesn't appear at all | The build has no `VITE_ONEDRIVE_CLIENT_ID`. Settings → OneDrive says so explicitly. |
| Signed in, but uploads fail with 403 | The user declined the `Files.ReadWrite` consent, or a tenant admin has disabled user consent — an admin must grant it (Entra ID → Enterprise applications → DueBack → Permissions). |
