# echo-speaks-server

The Amazon login and cookie service for the [Echo Speaks](https://github.com/tonesto7/echo-speaks) Hubitat app.

Echo Speaks talks to Alexa using an Amazon session cookie. This server gets that cookie: you log in to Amazon through the server's login proxy, and the server registers a device with Amazon, keeps the cookie refreshed, and sends it to the Echo Speaks app on your hub. The hub then talks to Alexa directly.

## Requirements

- **Node.js 20 or newer.** The server uses Node's built-in `fetch`.
- **Echo Speaks app 4.3.0.1 or newer** on the hub. 4.3.0.3 is recommended, because it can fix the server's stored hub URL automatically (see [Hub callback URL](#hub-callback-url)).
- A machine on your network that stays on (for example a Raspberry Pi), Docker, or a Heroku app.

## Included Amazon login library

`libs/alexa-cookie` is **[alexa-cookie2](https://github.com/Apollon77/alexa-cookie) 5.0.6** by Apollon77, with Echo Speaks changes merged in. It is a modified copy, not the npm package, because upstream can't run under Heroku.

Upstream 5.0.6 provides the current Amazon login flow (OAuth with PKCE), device registration including `macDms`, cookie refresh, and fixes for two-step verification.

Echo Speaks changes merged in:

- **Heroku and hosted installs:** the login proxy builds its URLs from `proxyHost`, `useHeroku` and `protocolPrefix` (http or https, with no port on Heroku) instead of `http://<ip>:<port>`.
- **Runs on the main web server:** the proxy is mounted under `/proxy` on the Echo Speaks express app (`expressInstance`, `proxyRootPath`) instead of starting its own server on a second port, which Heroku doesn't allow. After a successful login, Amazon is redirected to the server's own `/cookie-success` page.
- **Amazon's identifier-first sign-in (`/ax/claim`):** the proxy removes CSP and HSTS headers from Amazon's responses, rewrites root-relative form and link URLs into `/proxy`, and redirects stray requests to `/ax`, `/ap`, `/cvf`, `/aaut` and `/gp` back into the proxy.
- **Defaults:** `amazon.com`, `en-US`, and the app name **"Echo Speaks"** for device registration and refresh. The name must stay the same, because existing logins were registered with it.

## Install

### Local (Raspberry Pi or Linux, with pm2)

```bash
git clone https://github.com/tonesto7/echo-speaks-server.git
cd echo-speaks-server
npx yarn@1 install --frozen-lockfile --production
pm2 start index.js --name echo-speaks
pm2 save
```

The server listens on port **8091** by default; set the `PORT` environment variable to change it. Its address is detected from the machine's network interfaces, or you can set `ipAddress`.

### Docker

```bash
docker build -t echo-speaks-server .
docker run -d --name echo-speaks -p 8091:8091 echo-speaks-server
```

The image is based on `node:20`. The settings and login files are stored in the container's home folder, so mount a volume there if they should survive re-creating the container.

### Heroku

Deploy with `app.json`, or from the Echo Speaks app's server setup page. Heroku starts the server with the `Procfile` and installs dependencies from `yarn.lock`. Set at least `useHeroku=true`, `hostUrl` (your app's hostname), `amazonDomain` and `appCallbackUrl`.

## Setup

1. Open **`http://<server>:8091/config`** (on Heroku, `https://<app>.herokuapp.com/config`).
2. Paste the **App Callback Url** from the Echo Speaks app (**Begin Server Setup**, or **Manage Logging, and Metrics → Diagnostic Data** with `/diagData` changed to `/receiveData`). Either the cloud URL or the local hub URL works. Choose your Amazon domain and locale, then save.
3. Open **`http://<server>:8091/`** and log in to Amazon: email, password, then the two-step verification code if Amazon asks.
4. You land on the **"cookie successfully retrieved"** page, and the cookie is sent to the hub.

### Hub callback URL

The server stores the hub app's URL to send it cookies and status. That URL changes when the hub is replaced or restored, when the app is reinstalled, or when its access token is reset. Every call from the server to the hub then fails with `404 … AppException: Not Found`.

Echo Speaks 4.3.0.2 and newer checks the server's stored URL when the app initializes and every 6 hours, and sends the current URL when it is stale. With older app versions, paste the current URL into `/config` again.

### Forcing a fresh Amazon login

The hub app ignores the server's "clear login" request until it has received more than 5 of them, so the order matters:

1. On the hub: **Echo Speaks → Remove All Cookie Data?**
2. On the server: **`/config` → Clear Login Info** (click once)
3. Log in again at **`http://<server>:8091/`**

## Settings and files

| Item | Where |
|---|---|
| Settings | `~/es_config.json` |
| Saved login (cookie, refresh token) | `~/session.json` |
| Server logs | `~/logs/Echo-Speaks-YYYY-MM-DD.log` |
| Login library temp data | `libs/alexa-cookie/lib/formerDataStore.json` |

Environment variables (mostly for Heroku and Docker): `PORT`, `ipAddress`, `hostUrl`, `useHeroku`, `amazonDomain`, `regionLocale`, `appCallbackUrl`, `serviceDebug`, `serviceTrace`.

> **Note:** the login library's debug output goes to the console, so the process log (for example `~/.pm2/logs/*-out.log`) contains Amazon cookies and tokens. Treat it as secret, and clear it with `pm2 flush` when you no longer need it.

## Updating and rolling back

Before updating, back up the install folder and the settings and login files:

```bash
cp -a ~/echo-speaks-server ~/echo-speaks-server.bak-$(date +%Y%m%d)
cp -a ~/es_config.json ~/session.json ~/echo-speaks-server.bak-$(date +%Y%m%d)/
```

Update the files, run `npx yarn@1 install --frozen-lockfile --production`, then `pm2 restart echo-speaks`. To roll back, put the backup folder and the two JSON files back and restart.

The server refreshes the cookie when the hub asks it to (every 5 days by default; set from 1 to 90 days in the Echo Speaks app). The server restarts itself after each refresh by design, so pm2's restart count keeps growing.

## Changes in 2.8.1

- Updated the Amazon login library to alexa-cookie2 5.0.6, with the Echo Speaks Heroku and hosting changes merged in, and added support for Amazon's identifier-first sign-in (`/ax/claim`).
- Replaced the deprecated `request` and `request-promise` with Node's built-in `fetch`. Requests now time out after 30 seconds, and the Alexa API checks send their query parameters (previously ignored).
- Removed unused dependencies and updated the rest to their latest compatible versions (including body-parser 1.20.9 for CVE-2024-45590).
- Requires Node.js 20 or newer (Dockerfile: `node:20`).
