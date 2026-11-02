# david-fix patches (base: tonesto7/echo-speaks-server 1d1d63a)
1. PR #101 – server-side scheduled cookie refresh (24h local / 6h Heroku); persist refreshed cookie to session.json (updSessionItem); fix `Object.keys(x) >= 2` -> `.length >= 2`; clear interval on exit.
2. x86cpu register-fallback – if Amazon /auth/register rejects (2026 "Auth time of the token is expired"), keep existing refresh token and continue deriving cookies/csrf.
   Also /refreshCookie: on failure NO sendClearAuthToHub(), NO forced process.exit after 25s; returns {kept_existing:true}.
3. david-fix – scheduled refresh moved to scheduledCookieRefresh(): never clears hub auth; keeps current cookie; retries at 5/15/60/180 min then waits for next cycle. guardData Object.keys .length fix.
4. PR #103 – sign-in proxy keeps root-relative /ax paths inside the proxy (login page fix).
Remaining sendClearAuthToHub() calls: explicit /clearAuth and startup when hub-supplied cookie fails validation (unchanged).
Build: docker build -t echo-speaks-server:david-fix .
