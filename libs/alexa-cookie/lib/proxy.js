/* eslint-disable no-prototype-builtins */
/* jshint -W097 */
/* jshint -W030 */
/* jshint strict: false */
/* jslint node: true */
/* jslint esversion: 6 */
"use strict";

const modifyResponse = require('http-proxy-response-rewrite');
const express = require('express');
const proxy = require('http-proxy-middleware').createProxyMiddleware;
const querystring = require('querystring');
const cookieTools = require('cookie');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FORMERDATA_STORE_VERSION = 4;

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
    for (let name in cookies) {
        if (!cookies.hasOwnProperty(name)) continue;
        Cookie += name + '=' + cookies[name] + '; ';
    }
    Cookie = Cookie.replace(/[; ]*$/, '');
    return Cookie;
}

function customStringify(v, func, intent) {
    const cache = new Map();
    return JSON.stringify(v, function(key, value) {
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
    const getLocalHost = function(noPort = false) {
            return `${(_options.proxyHost || _options.proxyOwnIp)}${(noPort || _options.useHeroku) ? '' : `:${_options.proxyPort}`}`;
    };
    const initialCookies = {};

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
    } else {
        _options.logger && _options.logger('Proxy Init: reuse frc from former data');
        initialCookies.frc = _options.formerRegistrationData.frc;
    }

    if (!_options.formerRegistrationData || !_options.formerRegistrationData["map-md"]) {
        initialCookies['map-md'] = Buffer.from('{"device_user_dictionary":[],"device_registration_data":{"software_version":"1"},"app_identifier":{"app_version":"2.2.223830","bundle_id":"com.amazon.echo"}}').toString('base64');
    } else {
        _options.logger && _options.logger('Proxy Init: reuse map-md from former data');
        initialCookies['map-md'] = _options.formerRegistrationData['map-md'];
    }

    let deviceId = '';
    if (!_options.formerRegistrationData || !_options.formerRegistrationData.deviceId || !formerDataStoreValid) {
        const buf = Buffer.alloc(16); // 16 random bytes
        const bufHex = crypto.randomFillSync(buf).toString('hex').toUpperCase(); // convert into hex = 32x 0-9A-F
        deviceId = Buffer.from(bufHex).toString('hex'); // convert into hex = 64 chars that are hex of hex id
        deviceId += '23413249564c5635564d32573831';
    } else {
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
    } catch (_err) {
        // ignore
    }

    let proxyCookies = "";

    // proxy middleware options
    const optionsAlexa = {
        target: `https://alexa.${_options.baseAmazonPage}`,
        changeOrigin: true,
        ws: false,
        pathRewrite: {}, // enhanced below
        router: router,
        hostRewrite: true,
        followRedirects: false,
        logLevel: _options.proxyLogLevel,
        onError: onError,
        onProxyRes: onProxyRes,
        onProxyReq: onProxyReq,
        headers: {
            'user-agent': "Mozilla/5.0 (iPhone; CPU iPhone OS 13_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 PitanguiBridge/2.2.345247.0-[HARDWARE=iPhone10_4][SOFTWARE=13.5.1]",
            'accept-language': _options.acceptLanguage,
            'authority': `www.${_options.baseAmazonPage}`
        },
        cookieDomainRewrite: { // enhanced below
            "*": ""
        }
    };
    optionsAlexa.pathRewrite[`^${_options.proxyRootPath}/www.${_options.baseAmazonPage}`] = '';
    optionsAlexa.pathRewrite[`^${_options.proxyRootPath}/alexa.${_options.baseAmazonPage}`] = '';
    optionsAlexa.pathRewrite[`^/alexa.${_options.baseAmazonPage}`] = '';
    optionsAlexa.cookieDomainRewrite[`.${_options.baseAmazonPage}`] = getLocalHost(true);
    optionsAlexa.cookieDomainRewrite[_options.baseAmazonPage] = getLocalHost(true);
    if (_options.logger) optionsAlexa.logProvider = function logProvider(_provider) {
        return {
            log: _options.logger.log || _options.logger,
            debug: _options.logger.debug || _options.logger,
            info: _options.logger.info || _options.logger,
            warn: _options.logger.warn || _options.logger,
            error: _options.logger.error || _options.logger
        };
    };
    let returnedInitUrl;

    function router(req) {
        const url = (req.originalUrl || req.url);
        _options.logger && _options.logger('Router: ' + url + ' / ' + req.method + ' / ' + JSON.stringify(req.headers));
        let localHost = getLocalHost();
        if (req.headers.host === `${localHost}`) {
            if (url.startsWith(`${_options.proxyRootPath}/www.${_options.baseAmazonPage}/`)) {
                return `https://www.${_options.baseAmazonPage}`;
            } else if (url.startsWith(`${_options.proxyRootPath}/alexa.${_options.baseAmazonPage}/`)) {
                return `https://alexa.${_options.baseAmazonPage}`;
            } else if (req.headers.referer) {
                if (req.headers.referer.startsWith(`${_options.protocolPrefix}://${localHost}${_options.proxyRootPath}/www.${_options.baseAmazonPage}/`)) {
                    return `https://www.${_options.baseAmazonPage}`;
                } else if (req.headers.referer.startsWith(`${_options.protocolPrefix}://${localHost}${_options.proxyRootPath}/alexa.${_options.baseAmazonPage}/`)) {
                    return `https://alexa.${_options.baseAmazonPage}`;
                }
            }
            if (url === `${_options.proxyRootPath}`) { // initial redirect
                returnedInitUrl = `https://www.${_options.baseAmazonPage}/ap/signin?openid.return_to=https%3A%2F%2Fwww.${_options.baseAmazonPage}%2Fap%2Fmaplanding&openid.assoc_handle=amzn_dp_project_dee_ios${_options.baseAmazonPageHandle}&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&pageId=amzn_dp_project_dee_ios${_options.baseAmazonPageHandle}&accountStatusPolicy=P1&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.mode=checkid_setup&openid.ns.oa2=http%3A%2F%2Fwww.${_options.baseAmazonPage}%2Fap%2Fext%2Foauth%2F2&openid.oa2.client_id=device%3A${deviceId}&openid.ns.pape=http%3A%2F%2Fspecs.openid.net%2Fextensions%2Fpape%2F1.0&openid.oa2.response_type=token&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0&openid.pape.max_auth_age=0&openid.oa2.scope=device_auth_access&language=${_options.amazonPageProxyLanguage}`;
                _options.logger && _options.logger('Alexa-Cookie: Initial Page Request: ' + returnedInitUrl);
                return returnedInitUrl;
            } else {
                return `https://www.${_options.baseAmazonPage}`;
            }
        }
        return `https://alexa.${_options.baseAmazonPage}`;
    }

    function onError(err, req, res) {
        _options.logger && _options.logger('ERROR: ' + err);
        res.writeHead(500, {
            'Content-Type': 'text/plain'
        });
        res.end('Proxy-Error: ' + err);
    }

    function replaceHosts(data) {
        let localHost = getLocalHost();
        const amazonRegex = new RegExp(`https?://www.${_options.baseAmazonPage}:?[0-9]*/`.replace(/\./g, "\\."), 'g');
        const alexaRegex = new RegExp(`https?://alexa.${_options.baseAmazonPage}:?[0-9]*/`.replace(/\./g, "\\."), 'g');
        data = data.replace(/&#x2F;/g, '/');
        data = data.replace(amazonRegex, `${_options.protocolPrefix}://${localHost}${_options.proxyRootPath}/www.${_options.baseAmazonPage}/`);
        data = data.replace(alexaRegex, `${_options.protocolPrefix}://${localHost}${_options.proxyRootPath}/alexa.${_options.baseAmazonPage}/`);
        //_options.trace && console.log('REPLACEHOSTS: ' + dataOrig + ' --> ' + data);
        return data;
    }

    function replaceHostsBack(data) {
        let localHost = getLocalHost();
        const amazonRegex = new RegExp(`${_options.protocolPrefix}://${localHost}${_options.proxyRootPath}/www.${_options.baseAmazonPage}/`.replace(/\./g, "\\."), 'g');
        const alexaRegex = new RegExp(`${_options.protocolPrefix}://${localHost}${_options.proxyRootPath}/alexa.${_options.baseAmazonPage}/`.replace(/\./g, "\\."), 'g');
        data = data.replace(amazonRegex, `https://www.${_options.baseAmazonPage}/`);
        data = data.replace(alexaRegex, `https://alexa.${_options.baseAmazonPage}/`);
        if (data === `${_options.protocolPrefix}://${localHost}${_options.proxyRootPath}`) {
            data = returnedInitUrl;
        }
        return data;
    }

    function onProxyReq(proxyReq, req, _res) {
        const url = req.originalUrl || req.url;
        if (url.endsWith('.ico') || url.endsWith('.js') || url.endsWith('.ttf') || url.endsWith('.svg') || url.endsWith('.png') || url.endsWith('.appcache')) return;
        //if (url.startsWith('/ap/uedata')) return;

        _options.logger && _options.logger('Alexa-Cookie: Proxy-Request: ' + req.method + ' ' + url);
        //_options.logger && _options.logger('Alexa-Cookie: Proxy-Request-Data: ' + customStringify(proxyReq, null, 2));

        if (typeof proxyReq.getHeader === 'function') {
            _options.logger && _options.logger('Alexa-Cookie: Headers: ' + JSON.stringify(proxyReq.getHeaders()));
            let reqCookie = proxyReq.getHeader('cookie');
            if (reqCookie === undefined) {
                reqCookie = "";
            }
            for (var cookie in initialCookies) {
                if (!initialCookies.hasOwnProperty(cookie)) continue;
                if (!reqCookie.includes(cookie + '=')) {
                    reqCookie += '; ' + cookie + '=' + initialCookies[cookie];
                }
            }
            if (reqCookie.startsWith('; ')) {
                reqCookie = reqCookie.substr(2);
            }
            proxyReq.setHeader('cookie', reqCookie);
            if (!proxyCookies.length) {
                proxyCookies = reqCookie;
            } else {
                proxyCookies += '; ' + reqCookie;
            }
            _options.logger && _options.logger('Alexa-Cookie: Headers: ' + JSON.stringify(proxyReq.getHeaders()));
        }

        let modified = false;
        if (req.method === 'POST') {
            if (typeof proxyReq.getHeader === 'function' && proxyReq.getHeader('referer')) {
                let fixedReferer = replaceHostsBack(proxyReq.getHeader('referer'));
                proxyReq.setHeader('referer', fixedReferer);
                _options.logger && _options.logger('Alexa-Cookie: Modify headers: Changed Referer: ' + fixedReferer);
                modified = true;
            }
            if (typeof proxyReq.getHeader === 'function' && proxyReq.getHeader('origin') !== 'https://' + proxyReq.getHeader('host')) {
                proxyReq.setHeader('origin', `https://www.${_options.baseAmazonPage}`);
                _options.logger && _options.logger('Alexa-Cookie: Modify headers: Delete Origin');
                modified = true;
            }

            let postBody = '';
            req.on('data', chunk => {
                postBody += chunk.toString(); // convert Buffer to string
            });
        }
        _options.proxyLogLevel === 'debug' && _options.logger && _options.logger('Alexa-Cookie: Proxy-Request: (modified:' + modified + ')' + customStringify(proxyReq, null, 2));
    }

    function onProxyRes(proxyRes, req, res) {
        const url = req.originalUrl || req.url;
        if (url.endsWith('.ico') || url.endsWith('.js') || url.endsWith('.ttf') || url.endsWith('.svg') || url.endsWith('.png') || url.endsWith('.appcache')) return;
        if (url.startsWith('/ap/uedata')) return;
        //_options.logger && _options.logger('Proxy-Response: ' + customStringify(proxyRes, null, 2));
        let reqestHost = null;
        if (proxyRes.socket && proxyRes.socket._host) reqestHost = proxyRes.socket._host;
        _options.logger && _options.logger('Alexa-Cookie: Proxy Response from Host: ' + reqestHost);
        _options.proxyLogLevel === 'debug' && _options.logger && _options.logger('Alexa-Cookie: Proxy-Response Headers: ' + customStringify(proxyRes.headers, null, 2));
        _options.proxyLogLevel === 'debug' && _options.logger && _options.logger('Alexa-Cookie: Proxy-Response Outgoing: ' + customStringify(proxyRes.socket.parser.outgoing, null, 2));
        //_options.logger && _options.logger('Proxy-Response RES!!: ' + customStringify(res, null, 2));

        if (proxyRes && proxyRes.headers && proxyRes.headers['set-cookie']) {
            // make sure cookies are also sent to http by remove secure flags
            for (let i = 0; i < proxyRes.headers['set-cookie'].length; i++) {
                proxyRes.headers['set-cookie'][i] = proxyRes.headers['set-cookie'][i].replace('Secure', '');
            }
            proxyCookies = addCookies(proxyCookies, proxyRes.headers);
        }
        _options.logger && _options.logger('Alexa-Cookie: Cookies handled: ' + JSON.stringify(proxyCookies));

        if (
            (proxyRes.socket && proxyRes.socket._host === `www.${_options.baseAmazonPage}` && proxyRes.socket.parser.outgoing && proxyRes.socket.parser.outgoing.method === 'GET' && proxyRes.socket.parser.outgoing.path.startsWith('/ap/maplanding')) ||
            (proxyRes.socket && proxyRes.socket.parser.outgoing && proxyRes.socket.parser.outgoing.getHeader('location') && proxyRes.socket.parser.outgoing.getHeader('location').includes('/ap/maplanding?')) ||
            (proxyRes.headers.location && (proxyRes.headers.location.includes('/ap/maplanding?') || proxyRes.headers.location.includes('/spa/index.html')))
        ) {
            _options.logger && _options.logger('Alexa-Cookie: Proxy detected SUCCESS!!');

            const paramStart = proxyRes.headers.location.indexOf('?');
            const queryParams = querystring.parse(proxyRes.headers.location.substr(paramStart + 1));

            proxyRes.statusCode = 302;
            proxyRes.headers.location = `${_options.protocolPrefix}://${getLocalHost()}/cookie-success`;
            delete proxyRes.headers.referer;

            _options.logger && _options.logger('Alexa-Cookie: Proxy catched cookie: ' + proxyCookies);
            _options.logger && _options.logger('Alexa-Cookie: Proxy catched parameters: ' + JSON.stringify(queryParams));

            callbackCookie && callbackCookie(null, {
                "loginCookie": proxyCookies,
                "accessToken": queryParams['openid.oa2.access_token'],
                "frc": initialCookies.frc,
                "map-md": initialCookies['map-md'],
                "deviceId": deviceId
            });
            return;
        }

        // If we detect a redirect, rewrite the location header
        if (proxyRes.headers.location) {
            _options.logger && _options.logger('Redirect: Original Location ----> ' + proxyRes.headers.location);
            proxyRes.headers.location = replaceHosts(proxyRes.headers.location);
            if (reqestHost && proxyRes.headers.location.startsWith('/')) {
                proxyRes.headers.location = `${_options.protocolPrefix}://${getLocalHost()}${_options.proxyRootPath}/` + reqestHost + proxyRes.headers.location;
            }
            _options.logger && _options.logger('Redirect: Final Location ----> ' + proxyRes.headers.location);
            return;
        }

        modifyResponse(res, (proxyRes && proxyRes.headers ? proxyRes.headers['content-encoding'] || '' : ''), function (body) {
            if (body) {
                const bodyOrig = body;
                body = replaceHosts(body);
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

    // create the proxy (without context)
    const myProxy = proxy(optionsAlexa);
    if (_options.expressInstance !== undefined) {
        _options.expressInstance.use(`${_options.proxyRootPath}`, myProxy);
        callbackListening(_options.expressInstance);
    } else {
        const app = express();

        app.use(myProxy);
        let server = app.listen(parseInt(_options.proxyPort), _options.proxyListenBind, function () {
            _options.debug && console.log('Alexa-Cookie: Proxy-Server listening on port ' + server.address().port);
            callbackListening(server);
        });
    }
}

module.exports.initAmazonProxy = initAmazonProxy;