/* jshint -W097 */
/* jshint -W030 */
/* jshint strict: false */
/* jslint node: true */
/* jslint esversion: 6 */
'use strict';

// Based on alexa-cookie2 5.0.6 (Apollon77) with Echo Speaks additions:
//  - proxyHost / useHeroku / protocolPrefix / proxyRootPath: build proxy URLs for local and Heroku installs
//  - expressInstance: mount the proxy on the Echo Speaks express app under proxyRootPath instead of
//    starting a separate server
//  - ES-AX-PATCH: support Amazon identifier-first sign-in (/ax/claim)
//      * strip CSP/HSTS headers from proxied responses (stops https upgrade of form posts)
//      * rewrite root-relative action/href/src in proxied bodies into the proxy path
//      * 307-redirect root-level Amazon paths (/ax, /ap, /cvf, /aaut, /gp) into the proxy path

const modifyResponse = require('http-proxy-response-rewrite');
const express = require('express');
const proxy = require('http-proxy-middleware').createProxyMiddleware;
const querystring = require('querystring');
const cookieTools = require('cookie');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FORMERDATA_STORE_VERSION = 4;
const ALEXA_APP_VERSION = '2.2.651540.0';
const EXTRA_AMAZON_PROXY_HOSTS = ['amazon.com', 'www.amazon.com', 'alexa.amazon.com'];

function addCookies(Cookie, headers) {
    if (!headers || !headers['set-cookie']) return Cookie;
    const cookies = cookieTools.parse(Cookie);
    for (let cookie of headers['set-cookie']) {
        cookie = cookie.match(/^([^=]+)=([^;]+);.*/);
        if (cookie && cookie.length === 3) {
            if (cookie[1] === 'ap-fid' && cookie[2] === '""') continue;
            cookies[cookie[1]] = cookie[2];
        }
    }
    Cookie = '';
    for (const name of Object.keys(cookies)) {
        Cookie += `${name}=${cookies[name]}; `;
    }
    Cookie = Cookie.replace(/[; ]*$/, '');
    return Cookie;
}

function isAmazonCookieName(name) {
    return /^(session-id|session-id-time|session-token|ubid-.+|lc-.+|x-.+|at-.+|sess-at-.+|frc|map-md|csrf|sid|csm-hit|i18n-prefs|sp-cdn|skin)$/.test(name);
}

function sanitizeAmazonCookie(cookie) {
    const cookies = cookieTools.parse(cookie || '');
    let sanitizedCookie = '';
    for (const name of Object.keys(cookies)) {
        if (isAmazonCookieName(name)) {
            sanitizedCookie += `${name}=${cookies[name]}; `;
        }
    }
    return sanitizedCookie.replace(/[; ]*$/, '');
}

function customStringify(v, func, intent) {
    const cache = new Map();
    return JSON.stringify(v, function (key, value) {
        if (typeof value === 'object' && value !== null) {
            if (cache.get(value)) {
                // Circular reference found, discard key
                return;
            }
            // Store value in our map
            cache.set(value, true);
        }
        if (Buffer.isBuffer(value)) {
            // Buffers not relevant to be logged, ignore
            return;
        }
        return value;
    }, intent);
}

function initAmazonProxy(_options, callbackCookie, callbackListening) {
    const initialCookies = {};
    const mounted = !!_options.expressInstance;
    // when mounted on the host app the proxy must live under its own path, never at '/'
    const proxyRootPath = (_options.proxyRootPath || (mounted ? '/proxy' : '')).replace(/\/+$/, '');
    const protocolPrefix = _options.protocolPrefix || 'http';
    // host[:port] the browser uses to reach us
    const getLocalHost = (noPort = false) => `${_options.proxyHost || _options.proxyOwnIp}${(noPort || _options.useHeroku) ? '' : `:${_options.proxyPort}`}`;
    const serverBase = () => `${protocolPrefix}://${getLocalHost()}`;
    const proxyBase = () => `${serverBase()}${proxyRootPath}/`;
    // when mounted, everything under proxyRootPath is ours; standalone checks the Host header like upstream
    const isProxyRequest = req => mounted || req.headers.host === getLocalHost();
    // http-proxy-middleware v2 works on req.originalUrl, which still includes the mount path
    const stripRoot = url => {
        if (proxyRootPath && url && (url === proxyRootPath || url.startsWith(`${proxyRootPath}/`) || url.startsWith(`${proxyRootPath}?`))) {
            url = url.slice(proxyRootPath.length);
        }
        return url || '/';
    };
    const defaultAmazonHost = `www.${_options.baseAmazonPage}`;
    const amazonProxyHosts = [];

    function escapeRegex(data) {
        return data.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function addAmazonProxyHost(host) {
        if (host && !amazonProxyHosts.includes(host)) {
            amazonProxyHosts.push(host);
        }
    }

    function amazonRootFromHost(host) {
        return host.replace(/^(www|alexa)\./, '');
    }

    addAmazonProxyHost(defaultAmazonHost);
    addAmazonProxyHost(`alexa.${_options.baseAmazonPage}`);
    addAmazonProxyHost(_options.baseAmazonPage);
    EXTRA_AMAZON_PROXY_HOSTS.forEach(addAmazonProxyHost);

    function amazonHostFromProxyPath(url) {
        const match = stripRoot(url).match(/^\/([^/?#]+)(?:[/?#]|$)/);
        if (match && amazonProxyHosts.includes(match[1])) {
            return match[1];
        }
        return null;
    }

    function amazonHostFromProxyUrl(url) {
        if (!url) return null;
        for (const host of amazonProxyHosts) {
            if (url === `${proxyBase()}${host}` || url.startsWith(`${proxyBase()}${host}/`)) {
                return host;
            }
        }
        return null;
    }

    const formerDataStorePath = _options.formerDataStorePath || path.join(__dirname, 'formerDataStore.json');
    let formerDataStoreValid = false;
    if (!_options.formerRegistrationData) {
        try {
            if (fs.existsSync(formerDataStorePath)) {
                const formerDataStore = JSON.parse(fs.readFileSync(path.join(__dirname, 'formerDataStore.json'), 'utf8'));
                if (typeof formerDataStore === 'object' && formerDataStore.storeVersion === FORMERDATA_STORE_VERSION) {
                    _options.formerRegistrationData = _options.formerRegistrationData || {};
                    _options.formerRegistrationData.frc = _options.formerRegistrationData.frc || formerDataStore.frc;
                    _options.formerRegistrationData['map-md'] = _options.formerRegistrationData['map-md'] || formerDataStore['map-md'];
                    _options.formerRegistrationData.deviceId = _options.formerRegistrationData.deviceId || formerDataStore.deviceId;
                    _options.logger && _options.logger('Proxy Init: loaded temp data store ass fallback former data');
                    formerDataStoreValid = true;
                }
            }
        } catch (_err) {
            // ignore
        }
    }

    if (!_options.formerRegistrationData || !_options.formerRegistrationData.frc) {
        // frc contains 313 random bytes, encoded as base64
        const frcBuffer = Buffer.alloc(313);
        for (let i = 0; i < 313; i++) {
            frcBuffer.writeUInt8(Math.floor(Math.random() * 255), i);
        }
        initialCookies.frc = frcBuffer.toString('base64');
    }
    else {
        _options.logger && _options.logger('Proxy Init: reuse frc from former data');
        initialCookies.frc = _options.formerRegistrationData.frc;
    }

    if (!_options.formerRegistrationData || !_options.formerRegistrationData['map-md']) {
        initialCookies['map-md'] = Buffer.from(`{"device_user_dictionary":[],"device_registration_data":{"software_version":"1"},"app_identifier":{"app_version":"${ALEXA_APP_VERSION}","bundle_id":"com.amazon.echo"}}`).toString('base64');
    }
    else {
        _options.logger && _options.logger('Proxy Init: reuse map-md from former data');
        initialCookies['map-md'] = _options.formerRegistrationData['map-md'];
    }

    let deviceId = '';
    if (!_options.formerRegistrationData || !_options.formerRegistrationData.deviceId || !formerDataStoreValid) {
        const buf = Buffer.alloc(16); // 16 random bytes
        const bufHex = crypto.randomFillSync(buf).toString('hex').toUpperCase(); // convert into hex = 32x 0-9A-F
        deviceId = Buffer.from(bufHex).toString('hex'); // convert into hex = 64 chars that are hex of hex id
        deviceId += '23413249564c5635564d32573831';
    }
    else {
        _options.logger && _options.logger('Proxy Init: reuse deviceId from former data');
        deviceId = _options.formerRegistrationData.deviceId;
    }

    try {
        const formerDataStore = {
            'storeVersion': FORMERDATA_STORE_VERSION,
            'deviceId': deviceId,
            'map-md': initialCookies['map-md'],
            'frc': initialCookies.frc
        };
        fs.writeFileSync(formerDataStorePath, JSON.stringify(formerDataStore), 'utf8');
    }
    catch (_err) {
        // ignore
    }

    function base64URLEncode(str) {
        return str.toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=/g, '');
    }
    function sha256(buffer) {
        return crypto.createHash('sha256').update(buffer).digest();
    }
    const code_verifier = base64URLEncode(crypto.randomBytes(32));
    const code_challenge = base64URLEncode(sha256(code_verifier));

    let proxyCookies = '';
    let returnedInitUrl;

    function buildInitialUrl() {
        return `https://www.${_options.baseAmazonPage}/ap/signin?openid.return_to=https%3A%2F%2Fwww.${_options.baseAmazonPage}%2Fap%2Fmaplanding&openid.assoc_handle=amzn_dp_project_dee_ios${_options.baseAmazonPageHandle}&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&pageId=amzn_dp_project_dee_ios${_options.baseAmazonPageHandle}&accountStatusPolicy=P1&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.mode=checkid_setup&openid.ns.oa2=http%3A%2F%2Fwww.${_options.baseAmazonPage}%2Fap%2Fext%2Foauth%2F2&openid.oa2.client_id=device%3A${deviceId}&openid.ns.pape=http%3A%2F%2Fspecs.openid.net%2Fextensions%2Fpape%2F1.0&openid.oa2.response_type=code&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0&openid.pape.max_auth_age=0&openid.oa2.scope=device_auth_access&openid.oa2.code_challenge_method=S256&openid.oa2.code_challenge=${code_challenge}&language=${_options.amazonPageProxyLanguage}`;
    }

    function fixEmbeddedProxyUrls(pathAndQuery) {
        const qIndex = pathAndQuery.indexOf('?');
        if (qIndex === -1) return pathAndQuery;
        const p = pathAndQuery.slice(0, qIndex);
        const qs = pathAndQuery.slice(qIndex + 1);
        let params;
        try {
            params = new URLSearchParams(qs);
        } catch (_e) {
            return pathAndQuery;
        }
        let changed = false;
        for (const key of params.keys()) {
            const value = params.get(key);
            const fixed = replaceHostsBack(value);
            if (fixed !== value) {
                params.set(key, fixed);
                changed = true;
            }
        }
        if (changed) {
            _options.logger && _options.logger(`Alexa-Cookie: Fixed embedded proxy URL(s) in outgoing request query`);
        }
        return changed ? `${p}?${params.toString()}` : pathAndQuery;
    }

    function rewriteProxyPath(url, req) {
        let result;
        url = stripRoot(url);
        const urlHost = amazonHostFromProxyPath(url);
        if (urlHost) {
            result = url.replace(new RegExp(`^/${escapeRegex(urlHost)}`), '') || '/';
        }
        else if (req && req.headers && isProxyRequest(req) && url === '/') {
            const initialUrl = returnedInitUrl || buildInitialUrl();
            const parsed = new URL(initialUrl);
            result = `${parsed.pathname}${parsed.search}`;
        }
        else {
            result = url;
        }
        return fixEmbeddedProxyUrls(result);
    }

    // proxy middleware options
    const optionsAlexa = {
        target: `https://alexa.${_options.baseAmazonPage}`,
        changeOrigin: true,
        ws: false,
        pathRewrite: rewriteProxyPath,
        router: router,
        hostRewrite: true,
        followRedirects: false,
        logLevel: _options.proxyLogLevel,
        onError: onError,
        onProxyRes: onProxyRes,
        onProxyReq: onProxyReq,
        headers: {
            'accept-language': _options.acceptLanguage
        },
        cookieDomainRewrite: {
            '*': ''
        },
        cookiePathRewrite: {
            '*': '/'
        }
    };
    if (_options.logger) optionsAlexa.logProvider = function logProvider() {
        return {
            log: _options.logger.log || _options.logger,
            debug: _options.logger.debug || _options.logger,
            info: _options.logger.info || _options.logger,
            warn: _options.logger.warn || _options.logger,
            error: _options.logger.error || _options.logger
        };
    };

    function router(req) {
        const url = stripRoot(req.originalUrl || req.url);
        _options.logger && _options.logger(`Router: ${url} / ${req.method} / ${JSON.stringify(req.headers)}`);
        if (isProxyRequest(req)) {
            const urlHost = amazonHostFromProxyPath(url);
            if (urlHost) {
                return `https://${urlHost}`;
            }
            const refererHost = amazonHostFromProxyUrl(req.headers.referer);
            if (refererHost) {
                return `https://${refererHost}`;
            }
            if (url === '/') { // initial redirect
                returnedInitUrl =  buildInitialUrl();
                _options.logger && _options.logger(`Alexa-Cookie: Initial Page Request: ${returnedInitUrl}`);
                const parsedInitUrl = new URL(returnedInitUrl);
                return `${parsedInitUrl.protocol}//${parsedInitUrl.host}`;
            }
            else {
                return `https://${defaultAmazonHost}`;
            }
        }
        return `https://alexa.${_options.baseAmazonPage}`;
    }

    function onError(err, req, res) {
        _options.logger && _options.logger(`ERROR: ${err}`);
        try {
            res.writeHead(500, {
                'Content-Type': 'text/plain'
            });
            res.end(`Proxy-Error: ${err}`);
        } catch (err) {
            // ignore
        }
    }

    function replaceHosts(data) {
        //const dataOrig = data;
        data = data.replace(/&#x2F;/g, '/');
        for (const host of amazonProxyHosts) {
            const hostRegex = new RegExp(`https?://${escapeRegex(host)}:?[0-9]*/`, 'g');
            data = data.replace(hostRegex, `${proxyBase()}${host}/`);
        }
        //_options.logger && _options.logger('REPLACEHOSTS: ' + dataOrig + ' --> ' + data);
        return data;
    }

    // ES-AX-PATCH: rewrite root-relative attribute URLs (e.g. action="/ax/claim?...") into the proxy path.
    // Applied to response bodies only (not Location headers, which are handled separately).
    function replaceRootRelative(data, reqestHost) {
        const host = (reqestHost && amazonProxyHosts.includes(reqestHost)) ? reqestHost : defaultAmazonHost;
        const prefix = `${proxyRootPath}/${host}/`;
        const proxyRoot = proxyRootPath.replace(/^\//, '');
        return data.replace(/(\s(?:action|formaction|href|src)\s*=\s*["'])\/(?!\/)([^"']*)/gi, function (match, attr, rest) {
            if (proxyRoot && rest.startsWith(`${proxyRoot}/`)) return match; // already rewritten
            if (amazonProxyHosts.some(h => rest === h || rest.startsWith(`${h}/`))) return match; // already rewritten (no root path)
            return attr + prefix + rest;
        });
    }

    function replaceHostsBack(data) {
        const base = proxyBase();
        for (const host of amazonProxyHosts) {
            const hostRegex = new RegExp(`${escapeRegex(base)}${escapeRegex(host)}/`, 'g');
            data = data.replace(hostRegex, `https://${host}/`);
        }
        if (data === base || data === base.slice(0, -1)) {
            data = returnedInitUrl;
        }
        else if (data.startsWith(base)) {
            data = `https://${defaultAmazonHost}/${data.slice(base.length)}`;
        }
        return data;
    }

    function parseQueryParams(data) {
        const paramStart = data && data.indexOf('?');
        if (paramStart === -1 || paramStart === undefined) return {};
        return querystring.parse(data.substr(paramStart + 1));
    }

    function isProxySuccessUrl(data) {
        if (!data) return false;
        if (data.includes('/spa/index.html')) return true;
        if (!data.includes('/ap/maplanding?')) return false;
        return !!parseQueryParams(data)['openid.oa2.authorization_code'];
    }

    function onProxyReq(proxyReq, req/*, _res*/) {
        const url = stripRoot(req.originalUrl || req.url);
        if (url.endsWith('.ico') || url.endsWith('.js') || url.endsWith('.ttf') || url.endsWith('.svg') || url.endsWith('.png') || url.endsWith('.appcache')) return;
        //if (url.startsWith('/ap/uedata')) return;

        _options.logger && _options.logger(`Alexa-Cookie: Proxy-Request: ${req.method} ${url}`);
        //_options.logger && _options.logger('Alexa-Cookie: Proxy-Request-Data: ' + customStringify(proxyReq, null, 2));

        if (typeof proxyReq.getHeader === 'function') {
            _options.logger && _options.logger(`Alexa-Cookie: Headers: ${JSON.stringify(proxyReq.getHeaders())}`);
            let reqCookie = proxyReq.getHeader('cookie');
            if (reqCookie === undefined) {
                reqCookie = '';
            }
            for (const cookie of Object.keys(initialCookies)) {
                if (!reqCookie.includes(`${cookie}=`)) {
                    reqCookie += `; ${cookie}=${initialCookies[cookie]}`;
                }
            }
            if (reqCookie.startsWith('; ')) {
                reqCookie = reqCookie.substr(2);
            }
            proxyReq.setHeader('cookie', reqCookie);
            if (!proxyCookies.length) {
                proxyCookies = reqCookie;
            } else {
                proxyCookies += `; ${reqCookie}`;
            }
            _options.logger && _options.logger(`Alexa-Cookie: Headers: ${JSON.stringify(proxyReq.getHeaders())}`);
        }

        let modified = false;
        if (req.method === 'POST') {
            if (typeof proxyReq.getHeader === 'function' && proxyReq.getHeader('referer')) {
                const fixedReferer = replaceHostsBack(proxyReq.getHeader('referer'));
                if (fixedReferer ) {
                    proxyReq.setHeader('referer', fixedReferer);
                    _options.logger && _options.logger(`Alexa-Cookie: Modify headers: Changed Referer: ${fixedReferer}`);
                    modified = true;
                }
            }
            if (typeof proxyReq.getHeader === 'function' && proxyReq.getHeader('origin') !== `https://${proxyReq.getHeader('host')}`) {
                proxyReq.setHeader('origin', `https://${proxyReq.getHeader('host') || defaultAmazonHost}`);
                _options.logger && _options.logger('Alexa-Cookie: Modify headers: Changed Origin');
                modified = true;
            }

            if (req.body && typeof req.body === 'object') {
                let bodyChanged = false;
                for (const key of Object.keys(req.body)) {
                    const value = req.body[key];
                    if (typeof value !== 'string') continue;
                    const fixed = replaceHostsBack(value);
                    if (fixed !== value) {
                        req.body[key] = fixed;
                        bodyChanged = true;
                    }
                }
                if (bodyChanged) {
                    _options.logger && _options.logger('Alexa-Cookie: Fixed embedded proxy URL(s) in outgoing POST body');
                }
                // req.body was already fully buffered and parsed by bufferUrlencodedBody()
                // before this middleware runs, so the original stream is drained and the
                // default http-proxy pipe-through is a no-op; write our (possibly fixed) body.
                const bodyData = querystring.stringify(req.body);
                proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
                proxyReq.write(bodyData);
            }
        }
        _options.proxyLogLevel === 'debug' && _options.logger && _options.logger(`Alexa-Cookie: Proxy-Request: (modified:${modified})${customStringify(proxyReq, null, 2)}`);
    }

    function onProxyRes(proxyRes, req, res) {
        const url = stripRoot(req.originalUrl || req.url);
        if (url.endsWith('.ico') || url.endsWith('.js') || url.endsWith('.ttf') || url.endsWith('.svg') || url.endsWith('.png') || url.endsWith('.appcache')) return;
        if (url.startsWith('/ap/uedata')) return;
        //_options.logger && _options.logger('Proxy-Response: ' + customStringify(proxyRes, null, 2));
        let reqestHost = null;
        if (proxyRes.socket && proxyRes.socket._host) reqestHost = proxyRes.socket._host;
        _options.logger && _options.logger(`Alexa-Cookie: Proxy Response from Host: ${reqestHost}`);
        _options.proxyLogLevel === 'debug' && _options.logger && _options.logger(`Alexa-Cookie: Proxy-Response Headers: ${customStringify(proxyRes.headers, null, 2)}`);
        _options.proxyLogLevel === 'debug' && _options.logger && _options.logger(`Alexa-Cookie: Proxy-Response Outgoing: ${customStringify(proxyRes.socket.parser.outgoing, null, 2)}`);
        //_options.logger && _options.logger('Proxy-Response RES!!: ' + customStringify(res, null, 2));

        if (proxyRes && proxyRes.headers && proxyRes.headers['set-cookie']) {
            // make sure cookies are also sent to http by remove secure flags
            for (let i = 0; i < proxyRes.headers['set-cookie'].length; i++) {
                proxyRes.headers['set-cookie'][i] = proxyRes.headers['set-cookie'][i].replace('Secure', '');
            }
            proxyCookies = addCookies(proxyCookies, proxyRes.headers);
        }
        _options.logger && _options.logger(`Alexa-Cookie: Cookies handled: ${JSON.stringify(proxyCookies)}`);

        // ES-AX-PATCH: drop headers that make the browser upgrade proxied requests to https
        if (proxyRes && proxyRes.headers) {
            delete proxyRes.headers['content-security-policy'];
            delete proxyRes.headers['content-security-policy-report-only'];
            delete proxyRes.headers['strict-transport-security'];
        }

        const outgoing = proxyRes.socket && proxyRes.socket.parser && proxyRes.socket.parser.outgoing;
        const successUrl = [
            proxyRes.headers.location,
            outgoing && outgoing.method === 'GET' && outgoing.path,
            outgoing && outgoing.getHeader && outgoing.getHeader('location')
        ].find(isProxySuccessUrl);

        if (successUrl) {
            _options.logger && _options.logger('Alexa-Cookie: Proxy detected SUCCESS!!');

            const queryParams = parseQueryParams(successUrl);

            proxyRes.statusCode = 302;
            // /cookie-success is served outside the proxy path (by the host app when mounted)
            proxyRes.headers.location = `${serverBase()}/cookie-success`;
            delete proxyRes.headers.referer;

            _options.logger && _options.logger(`Alexa-Cookie: Proxy catched cookie: ${proxyCookies}`);
            _options.logger && _options.logger(`Alexa-Cookie: Proxy catched parameters: ${JSON.stringify(queryParams)}`);

            callbackCookie && callbackCookie(null, {
                'loginCookie': sanitizeAmazonCookie(proxyCookies),
                'authorization_code': queryParams['openid.oa2.authorization_code'],
                'frc': initialCookies.frc,
                'map-md': initialCookies['map-md'],
                'deviceId': deviceId,
                'verifier': code_verifier
            });
            return;
        }

        // If we detect a redirect, rewrite the location header
        if (proxyRes.headers.location) {
            _options.logger && _options.logger(`Redirect: Original Location ----> ${proxyRes.headers.location}`);
            proxyRes.headers.location = replaceHosts(proxyRes.headers.location);
            if (reqestHost && amazonProxyHosts.includes(reqestHost) && proxyRes.headers.location.startsWith('/')) {
                proxyRes.headers.location = `${proxyBase()}${reqestHost}${proxyRes.headers.location}`;
            }
            _options.logger && _options.logger(`Redirect: Final Location ----> ${proxyRes.headers.location}`);
            return;
        }

        modifyResponse(res, (proxyRes && proxyRes.headers ? proxyRes.headers['content-encoding'] || '' : ''), function(body) {
            if (body) {
                const bodyOrig = body;
                body = replaceHosts(body);
                body = replaceRootRelative(body, reqestHost); // ES-AX-PATCH
                if (body !== bodyOrig) {
                    _options.logger && _options.logger('Alexa-Cookie: MODIFIED Response Body to rewrite URLs');
                    _options.logger && _options.logger('');
                    _options.logger && _options.logger('');
                    _options.logger && _options.logger('');
                }
            }
            return body;
        });
    }

    // Fully buffer+parse `application/x-www-form-urlencoded` POST bodies before the proxy
    // middleware sees them, so onProxyReq can rewrite fields and re-send the body itself
    // (the stream is drained by the time http-proxy would otherwise pipe it through).
    function bufferUrlencodedBody(req, res, next) {
        const contentType = req.headers['content-type'] || '';
        if (req.method !== 'POST' || contentType.indexOf('application/x-www-form-urlencoded') === -1) {
            return next();
        }
        // already consumed by a body parser of the host app
        if (req.body !== undefined || req.readableEnded) {
            return next();
        }
        let raw = '';
        req.on('data', chunk => {
            raw += chunk;
        });
        req.on('end', () => {
            req.body = querystring.parse(raw);
            next();
        });
    }

    if (mounted) {
        // Mount on the Echo Speaks express app. A single dispatcher per app is registered once and
        // forwards to the proxy of the most recent initAmazonProxy() call, so repeated login attempts
        // don't stack up stale proxies (each one has its own deviceId and PKCE verifier).
        const app = _options.expressInstance;
        const myProxy = proxy(optionsAlexa);
        const state = app.__alexaCookieProxy || (app.__alexaCookieProxy = { handler: null });
        state.handler = (req, res, next) => bufferUrlencodedBody(req, res, err => (err ? next(err) : myProxy(req, res, next)));

        if (!state.mounted) {
            state.mounted = true;
            app.use(proxyRootPath, (req, res, next) => (state.handler ? state.handler(req, res, next) : next()));

            // ES-AX-PATCH: safety net for root-level Amazon paths built outside the rewritten HTML.
            // 307 preserves method and body (POST stays POST).
            app.use(['/ax', '/ap', '/cvf', '/aaut', '/gp'], (req, res, next) => {
                if (!state.handler) return next();
                const target = `${state.proxyRootPath}/${state.defaultAmazonHost}${req.originalUrl}`;
                state.logger && state.logger(`ES-AX-PATCH: redirect ${req.method} ${req.originalUrl.split('?')[0]} -> ${target.split('?')[0]}`);
                res.redirect(307, target);
            });
        }
        // the dispatcher outlives this call, so it reads the current settings from state
        state.proxyRootPath = proxyRootPath;
        state.defaultAmazonHost = defaultAmazonHost;
        state.logger = _options.logger;

        // server-like handle so alexa-cookie.js can treat both modes the same
        const handle = {
            address: () => ({ port: _options.proxyPort }),
            close: cb => {
                if (state.handler === myHandler) state.handler = null;
                cb && cb();
            }
        };
        const myHandler = state.handler;
        _options.logger && _options.logger(`Alexa-Cookie: Proxy mounted on host app at ${proxyBase()}`);
        callbackListening && callbackListening(handle);
        callbackListening = null;
        return;
    }

    // create the proxy (without context)
    const myProxy = proxy('!/cookie-success', optionsAlexa);

    // mount `exampleProxy` in web server
    const app = express();

    app.use(bufferUrlencodedBody);
    app.use(myProxy);
    app.get('/cookie-success', function(req, res) {
        res.send(_options.proxyCloseWindowHTML);
    });
    if (_options.proxyPort< 1 || _options.proxyPort > 65535) {
        _options.logger && _options.logger(`Alexa-Cookie: Error: Port ${_options.proxyPort} invalid. Use random port.`);
        _options.proxyPort = undefined;
    }
    const server = app.listen(_options.proxyPort, _options.proxyListenBind, function() {
        _options.proxyPort = this.address().port;
        _options.logger && _options.logger(`Alexa-Cookie: Proxy-Server listening on port ${_options.proxyPort}`);
        callbackListening && callbackListening(server);
        callbackListening = null;
    }).on('error', err => {
        _options.logger && _options.logger(`Alexa-Cookie: Proxy-Server Error: ${err}`);
        callbackListening && callbackListening(null);
        callbackListening = null;
    });

}

module.exports.initAmazonProxy = initAmazonProxy;
