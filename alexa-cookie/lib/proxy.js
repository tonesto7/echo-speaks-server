/* jshint -W097 */
/* jshint -W030 */
/* jshint strict: false */
/* jslint node: true */
/* jslint esversion: 6 */
"use strict";

const modifyResponse = require('http-proxy-response-rewrite');
const express = require('express');
const proxy = require('http-proxy-middleware');
const querystring = require('querystring');
const cookieTools = require('cookie');

let webApp;

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
    return value;
  }, intent);
}

function initAmazonProxy(_options, webapp, callbackCookie, callbackListening) {
  if (webapp) webApp = webapp;

  let getLocalHost = function() {
    return (_options.proxyHost || _options.proxyOwnIp) + (_options.useHeroku ? '' : ':' + _options.serverPort);
  };
  const initialCookies = {};
  if (!_options.formerRegistrationData || !_options.formerRegistrationData.frc) {
    // frc contains 313 random bytes, encoded as base64
    const frcBuffer = Buffer.alloc(313);
    for (let i = 0; i < 313; i++) {
      frcBuffer.writeUInt8(Math.floor(Math.random() * 255), i);
    }
    initialCookies.frc = frcBuffer.toString('base64');
  } else {
    _options.debug && console.log('Proxy Init: reuse frc from former data');
    initialCookies.frc = _options.formerRegistrationData.frc;
  }

  if (!_options.formerRegistrationData || !_options.formerRegistrationData["map-md"]) {
    initialCookies['map-md'] = Buffer.from('{"device_user_dictionary":[],"device_registration_data":{"software_version":"1"},"app_identifier":{"app_version":"2.2.223830","bundle_id":"com.amazon.echo"}}').toString('base64');
  } else {
    _options.debug && console.log('Proxy Init: reuse map-md from former data');
    initialCookies['map-md'] = _options.formerRegistrationData['map-md'];
  }

  let deviceId = '';
  if (!_options.formerRegistrationData || !_options.formerRegistrationData.deviceId) {
    for (let i = 0; i < 64; i++) {
      deviceId += Math.floor(Math.random() * 9).toString();
    }
    deviceId += '23413249564c5635564d32573831';
  } else {
    _options.debug && console.log('Proxy Init: reuse deviceId from former data');
    deviceId = _options.formerRegistrationData.deviceId;
  }

  let proxyCookies = "";

  const optionsAlexa = {
    target: `https://alexa.${_options.amazonDomain}`,
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
      'user-agent': "AmazonWebView/Amazon Alexa/2.2.223830.0/iOS/11.4.1/iPhone",
      'accept-language': _options.acceptLanguage
    },
    cookieDomainRewrite: { // enhanced below
      "*": ""
    }
  };
  optionsAlexa.pathRewrite[`^/proxy/www.${_options.amazonPage}`] = '';
  optionsAlexa.pathRewrite[`^/proxy/alexa.${_options.amazonPage}`] = '';
  optionsAlexa.pathRewrite[`^/alexa.${_options.amazonPage}`] = '';
  optionsAlexa.cookieDomainRewrite[`.${_options.amazonPage}`] = getLocalHost(true);
  optionsAlexa.cookieDomainRewrite[_options.amazonPage] = getLocalHost(true);
  if (_options.logger) optionsAlexa.logProvider = function logProvider(provider) {
    return {
      log: _options.logger.log || _options.logger,
      debug: _options.logger.debug || _options.logger,
      info: _options.logger.info || _options.logger,
      warn: _options.logger.warn || _options.logger,
      error: _options.logger.error || _options.logger
    };
  };

  function router(req) {
    const url = (req.originalUrl || req.url);
    _options.trace && console.log('Router: ' + url + ' / ' + req.method + ' / ' + JSON.stringify(req.headers));
    // console.log('router(host): ' + req.headers.host);
    let localHost = getLocalHost();
    if (req.headers.host === `${localHost}`) {
      if (url.startsWith(`/proxy/www.${_options.amazonPage}/`)) {
        return `https://www.${_options.amazonPage}`;
      } else if (url.startsWith(`/proxy/alexa.${_options.amazonPage}/`)) {
        return `https://alexa.${_options.amazonPage}`;
      } else if (req.headers.referer) {
        if (req.headers.referer.startsWith(`http://${localHost}/proxy/www.${_options.amazonPage}/`) || req.headers.referer.startsWith(`https://${localHost}/proxy/www.${_options.amazonPage}/`)) {
          return `https://www.${_options.amazonPage}`;
        } else if (req.headers.referer.startsWith(`http://${localHost}/proxy/alexa.${_options.amazonPage}/`) || req.headers.referer.startsWith(`https://${localHost}/proxy/alexa.${_options.amazonPage}/`)) {
          return `https://alexa.${_options.amazonPage}`;
        }
      }
      if (url === '/proxy') { // initial redirect
        const initialUrl = `https://www.${_options.amazonPage}/ap/signin?openid.return_to=https%3A%2F%2Fwww.amazon.com%2Fap%2Fmaplanding&openid.assoc_handle=amzn_dp_project_dee_ios&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&pageId=amzn_dp_project_dee_ios&accountStatusPolicy=P1&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.mode=checkid_setup&openid.ns.oa2=http%3A%2F%2Fwww.${_options.amazonPage}%2Fap%2Fext%2Foauth%2F2&openid.oa2.client_id=device%3A${deviceId}&openid.ns.pape=http%3A%2F%2Fspecs.openid.net%2Fextensions%2Fpape%2F1.0&openid.oa2.response_type=token&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0&openid.pape.max_auth_age=0&openid.oa2.scope=device_auth_access&language=${_options.amazonPageProxyLanguage}`;
        _options.debug && console.log('Alexa-Cookie: Initial Page Request: ' + initialUrl);
        return initialUrl;
      }
    }
    return `https://alexa.${_options.amazonPage}`;
  }

  function onError(err, req, res) {
    _options.debug && console.error('ERROR: ' + err);
    res.writeHead(500, {
      'Content-Type': 'text/plain'
    });
    res.end('Proxy-Error: ' + err);
  }

  function replaceHosts(data) {
    let localHost = getLocalHost();
    const amazonRegex = new RegExp(`https?://www.${_options.amazonPage}/`.replace(/\./g, "\\."), 'g');
    const alexaRegex = new RegExp(`https?://alexa.${_options.amazonPage}/`.replace(/\./g, "\\."), 'g');
    data = data.replace(/&#x2F;/g, '/');
    data = data.replace(amazonRegex, `https://${localHost}/proxy/www.${_options.amazonPage}/`);
    data = data.replace(alexaRegex, `https://${localHost}/proxy/alexa.${_options.amazonPage}/`);
    // data = data.replace(amazonRegex, `http://${localHost}/proxy/www.${_options.amazonPage}/`);
    // data = data.replace(alexaRegex, `http://${localHost}/proxy/alexa.${_options.amazonPage}/`);
    // _options.trace && console.log('REPLACEHOSTS: ' + dataOrig + ' --> ' + data);
    return data;
  }

  function replaceHostsBack(data) {
    let localHost = getLocalHost();
    const amazonRegex = new RegExp(`http://${localHost}/proxy/www.${_options.amazonPage}/`.replace(/\./g, "\\."), 'g');
    const amazonRegex2 = new RegExp(`https://${localHost}/proxy/www.${_options.amazonPage}/`.replace(/\./g, "\\."), 'g');
    const alexaRegex = new RegExp(`http://${localHost}/proxy/alexa.${_options.amazonPage}/`.replace(/\./g, "\\."), 'g');
    const alexaRegex2 = new RegExp(`https://${localHost}/proxy/alexa.${_options.amazonPage}/`.replace(/\./g, "\\."), 'g');
    data = data.replace(amazonRegex, `https://www.${_options.amazonPage}/`);
    data = data.replace(amazonRegex2, `https://www.${_options.amazonPage}/`);
    data = data.replace(alexaRegex, `https://alexa.${_options.amazonPage}/`);
    data = data.replace(alexaRegex2, `https://alexa.${_options.amazonPage}/`);
    return data;
  }

  function onProxyReq(proxyReq, req, res) {
    const url = req.originalUrl || req.url;
    if (url.endsWith('.ico') || url.endsWith('.js') || url.endsWith('.ttf') || url.endsWith('.svg') || url.endsWith('.png') || url.endsWith('.appcache')) return;
    if (url.startsWith('/ap/uedata')) {
      return;
    }

    _options.debug && console.log('Alexa-Cookie: Proxy-Request: ' + req.method + ' ' + url);
    _options.trace && console.log('Alexa-Cookie: Proxy-Request-Data: ' + customStringify(proxyReq, null, 2));

    if (proxyReq._headers) {
      _options.trace && console.log('Alexa-Cookie: Headers: ' + JSON.stringify(proxyReq._headers));
      let reqCookie = proxyReq._headers.cookie;
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
      _options.trace && console.log('Alexa-Cookie: Headers: ' + JSON.stringify(proxyReq._headers));
    }

    let modified = false;
    if (req.method === 'POST') {
      if (proxyReq._headers && proxyReq._headers.referer) {
        proxyReq._headers.referer = replaceHostsBack(proxyReq._headers.referer);
        _options.debug && console.log('Alexa-Cookie: Modify headers: Changed Referer');
        modified = true;
      }
      if (proxyReq._headers && proxyReq._headers.origin !== 'https://' + proxyReq._headers.host) {
        delete proxyReq._headers.origin;
        _options.debug && console.log('Alexa-Cookie: Modify headers: Delete Origin');
        modified = true;
      }

      let postBody = '';
      req.on('data', chunk => {
        postBody += chunk.toString(); // convert Buffer to string
      });
    }
    (!_options.debug && _options.trace) && console.log('Alexa-Cookie: Proxy-Request: (modified:' + modified + ')' + customStringify(proxyReq, null, 2));
    _options.debug && console.log('Alexa-Cookie: Proxy-Request: (modified:' + modified + ')');
  }

  function onProxyRes(proxyRes, req, res) {
    const url = req.originalUrl || req.url;
    if (url.endsWith('.ico') || url.endsWith('.js') || url.endsWith('.ttf') || url.endsWith('.svg') || url.endsWith('.png') || url.endsWith('.appcache')) return;
    if (url.startsWith('/ap/uedata')) return;
    //_options.logger && _options.logger('Proxy-Response: ' + customStringify(proxyRes, null, 2));
    let reqestHost = null;
    if (proxyRes.socket && proxyRes.socket._host) reqestHost = proxyRes.socket._host;
    _options.trace && console.log('Alexa-Cookie: Proxy Response from Host: ' + reqestHost);

    if (_options.trace) {
      console.log('Proxy-Response: ' + customStringify(proxyRes, null, 2));
      console.log('Alexa-Cookie: Proxy-Response Headers: ' + customStringify(proxyRes._headers, null, 2));
      console.log('Alexa-Cookie: Proxy-Response Outgoing: ' + customStringify(proxyRes.socket.parser.outgoing, null, 2));
    }
    _options.trace && console.log('Proxy-Response RES!!: ' + customStringify(res, null, 2));

    if (proxyRes && proxyRes.headers && proxyRes.headers['set-cookie']) {
      // make sure cookies are also sent to http by remove secure flags
      for (let i = 0; i < proxyRes.headers['set-cookie'].length; i++) {
        proxyRes.headers['set-cookie'][i] = proxyRes.headers['set-cookie'][i].replace('Secure;', '');
      }
      proxyCookies = addCookies(proxyCookies, proxyRes.headers);
    }

    if (
      (proxyRes.socket && proxyRes.socket._host === `www.${_options.amazonPage}` && proxyRes.socket.parser.outgoing && proxyRes.socket.parser.outgoing.method === 'GET' && proxyRes.socket.parser.outgoing.path.startsWith('/ap/maplanding')) ||
      (proxyRes.socket && proxyRes.socket.parser.outgoing && proxyRes.socket.parser.outgoing._headers.location && proxyRes.socket.parser.outgoing._headers.location.includes('/ap/maplanding?')) ||
      (proxyRes.headers.location && proxyRes.headers.location.includes('/ap/maplanding?'))
    ) {
      _options.debug && console.log('Alexa-Cookie: Proxy detected SUCCESS!!');
      const paramStart = proxyRes.headers.location.indexOf('?');
      const queryParams = querystring.parse(proxyRes.headers.location.substr(paramStart + 1));

      proxyRes.statusCode = 302;
      proxyRes.headers.location = `https://${getLocalHost()}/cookie-success`;
      delete proxyRes.headers.referer;

      _options.debug && console.log('Alexa-Cookie: Proxy catched cookie: ' + proxyCookies);
      _options.debug && console.log('Alexa-Cookie: Proxy catched parameters: ' + JSON.stringify(queryParams));

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
      _options.debug && console.log('Redirect: Original Location ----> ' + proxyRes.headers.location);
      proxyRes.headers.location = replaceHosts(proxyRes.headers.location);
      if (reqestHost && proxyRes.headers.location.startsWith('/')) {
        proxyRes.headers.location = `https://${getLocalHost()}/proxy/` + reqestHost + proxyRes.headers.location;
      }
      _options.debug && console.log('Redirect: Final Location ----> ' + proxyRes.headers.location);
      return;
    }
    if (!proxyRes || !proxyRes.headers || !proxyRes.headers['content-encoding']) return;

    modifyResponse(res, proxyRes.headers['content-encoding'], function(body) {
      if (body) {
        const bodyOrig = body;
        body = replaceHosts(body);
        if (body !== bodyOrig) {
          _options.debug && console.log('Alexa-Cookie: MODIFIED Response Body to rewrite URLs');
        }
      }
      return body;
    });
  }

  // create the proxy (without context)
  const myProxy = proxy(optionsAlexa);
  let useWebApp = true;
  if (useWebApp) {
    webApp.use('/proxy', myProxy);
    console.log('starting login proxy on port: ' + _options.serverPort);
    callbackListening(webApp);
  } else {
    const app = express();
    app.use(myProxy);
    let server = app.listen(_options.serverPort, _options.proxyListenBind, function() {
      _options.debug && console.log('Alexa-Cookie: Proxy-Server listening on port ' + server.address().port);
      callbackListening(server);
    });
  }
}

module.exports.initAmazonProxy = initAmazonProxy;