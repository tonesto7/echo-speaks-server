/**
 * partly based on Amazon Alexa Remote Control (PLAIN shell)
 * http://blog.loetzimmer.de/2017/10/amazon-alexa-hort-auf-die-shell-echo.html AND on
 * https://github.com/thorsten-gehrig/alexa-remote-control
 * and much enhanced ...
 *
 * Based on alexa-cookie2 5.0.6 (Apollon77) with Echo Speaks defaults (amazon.com, en-US, app name
 * "Echo Speaks") and proxy URL handling for proxyHost / useHeroku / protocolPrefix / proxyRootPath.
 */

const https = require('https');
const querystring = require('querystring');
const url = require('url');
const os = require('os');
const cookieTools = require('cookie');
const amazonProxy = require('./lib/proxy.js');

const defaultAmazonPage = 'amazon.com';
const defaultUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.0.0 Safari/537.36';
const defaultUserAgentLinux = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.0.0 Safari/537.36';
//const defaultUserAgentMacOs = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/57.0.2987.133 Safari/537.36';
const defaultProxyCloseWindowHTML = '<b>Amazon Alexa Cookie successfully retrieved. You can close the browser.</b>';
const defaultAcceptLanguage = 'en-US';

const apiCallVersion = '2.2.651540.0';
const apiCallUserAgent = 'AmazonWebView/Amazon Alexa/2.2.651540.0/iOS/18.3.1/iPhone';
// Must stay "Echo Speaks": existing registrations were made under this name and refresh sends it
const defaultAppName = 'Echo Speaks';

const csrfOptions = [
    '/api/language',
    '/spa/index.html',
    '/api/devices-v2/device?cached=false',
    '/templates/oobe/d-device-pick.handlebars',
    '/api/strings'
];

function AlexaCookie() {
    if (!(this instanceof AlexaCookie)) return new AlexaCookie();

    let proxyServer;
    let _options;

    let Cookie = '';

    const isAmazonCookieName = name => /^(session-id|session-id-time|session-token|ubid-.+|lc-.+|x-.+|at-.+|sess-at-.+|frc|map-md|csrf|sid|csm-hit|i18n-prefs|sp-cdn|skin)$/.test(name);

    const sanitizeAmazonCookie = cookie => {
        const cookies = cookieTools.parse(cookie || '');
        let sanitizedCookie = '';
        for (const name of Object.keys(cookies)) {
            if (isAmazonCookieName(name)) {
                sanitizedCookie += `${name}=${cookies[name]}; `;
            }
        }
        return sanitizedCookie.replace(/[; ]*$/, '');
    };

    const addCookies = (Cookie, headers) => {
        if (!headers || !headers['set-cookie']) return Cookie;
        const cookies = cookieTools.parse(Cookie || '');
        for (let cookie of headers['set-cookie']) {
            cookie = cookie.match(/^([^=]+)=([^;]+);.*/);
            if (cookie && cookie.length === 3) {
                if (cookie[1] === 'ap-fid' && cookie[2] === '""') continue;
                if (cookies[cookie[1]] && cookies[cookie[1]] !== cookie[2]) {
                    _options.logger && _options.logger(`Alexa-Cookie: Update Cookie ${cookie[1]} = ${cookie[2]}`);
                } else if (!cookies[cookie[1]]) {
                    _options.logger && _options.logger(`Alexa-Cookie: Add Cookie ${cookie[1]} = ${cookie[2]}`);
                }
                cookies[cookie[1]] = cookie[2];
            }
        }
        Cookie = '';
        for (const name of Object.keys(cookies)) {
            Cookie += `${name}=${cookies[name]}; `;
        }
        Cookie = Cookie.replace(/[; ]*$/, '');
        return Cookie;
    };

    const request = (options, info, callback) => {
        _options.logger && _options.logger(`Alexa-Cookie: Sending Request with ${JSON.stringify(options)}`);
        if (typeof info === 'function') {
            callback = info;
            info = {
                requests: []
            };
        }

        let removeContentLength;
        if (options.headers && options.headers['Content-Length']) {
            if (!options.body) delete options.headers['Content-Length'];
        } else if (options.body) {
            if (!options.headers) options.headers = {};
            options.headers['Content-Length'] = options.body.length;
            removeContentLength = true;
        }

        const req = https.request(options, (res) => {
            let body = '';
            info.requests.push({options: options, response: res});

            if (options.followRedirects !== false && res.statusCode >= 300 && res.statusCode < 400) {
                _options.logger && _options.logger(`Alexa-Cookie: Response (${res.statusCode})${res.headers.location ? ` - Redirect to ${res.headers.location}` : ''}`);
                //options.url = res.headers.location;
                const u = url.parse(res.headers.location);
                if (u.host) options.host = u.host;
                options.path = u.path;
                options.method = 'GET';
                options.body = '';
                options.headers.Cookie = Cookie = addCookies(Cookie, res.headers);

                res.socket && res.socket.end();
                return request(options, info, callback);
            } else {
                _options.logger && _options.logger(`Alexa-Cookie: Response (${res.statusCode})`);
                res.on('data', (chunk) => {
                    body += chunk;
                });

                res.on('end',  () => {
                    if (removeContentLength) delete options.headers['Content-Length'];
                    res.socket && res.socket.end();
                    callback && callback(0, res, body, info);
                });
            }
        });

        req.on('error', (e) => {
            if (typeof callback === 'function' && callback.length >= 2) {
                return callback(e, null, null, info);
            }
        });
        if (options && options.body) {
            req.write(options.body);
        }
        req.end();
    };

    const getFields = body => {
        body = body.replace(/[\n\r]/g, ' ');
        let re = /^.*?("hidden"\s*name=".*$)/;
        const ar = re.exec(body);
        if (!ar || ar.length < 2) return {};
        let h;
        re = /.*?name="([^"]+)"[\s^\s]*value="([^"]+).*?"/g;
        const data = {};
        while ((h = re.exec(ar[1])) !== null) {
            if (h[1] !== 'rememberMe') {
                data[h[1]] = h[2];
            }
        }
        return data;
    };

    // URL the user opens in a browser to log in through the proxy
    const getProxyUrl = () => {
        const host = `${_options.proxyHost || _options.proxyOwnIp}${_options.useHeroku ? '' : `:${_options.proxyPort}`}`;
        return `${_options.protocolPrefix || 'http'}://${host}${(_options.proxyRootPath || '').replace(/\/+$/, '')}/`;
    };

    const initConfig = () => {
        _options.amazonPage = _options.amazonPage || defaultAmazonPage;
        if (_options.formerRegistrationData && _options.formerRegistrationData.amazonPage) _options.amazonPage = _options.formerRegistrationData.amazonPage;

        _options.logger && _options.logger(`Alexa-Cookie: Use as Login-Amazon-URL: ${_options.amazonPage}`);

        _options.baseAmazonPage = _options.baseAmazonPage || 'amazon.com';
        _options.logger && _options.logger(`Alexa-Cookie: Use as Base-Amazon-URL: ${_options.baseAmazonPage}`);

        _options.deviceAppName = _options.deviceAppName || defaultAppName;
        _options.logger && _options.logger(`Alexa-Cookie: Use as Device-App-Name: ${_options.deviceAppName}`);

        if (!_options.baseAmazonPageHandle && _options.baseAmazonPageHandle !== '') {
            const amazonDomain = _options.baseAmazonPage.substr(_options.baseAmazonPage.lastIndexOf('.') + 1);
            if (amazonDomain === 'jp') {
                _options.baseAmazonPageHandle = `_${amazonDomain}`;
            }
            else if (amazonDomain !== 'com') {
                _options.baseAmazonPageHandle = `_${amazonDomain}`;
            }
            else {
                _options.baseAmazonPageHandle = '';
            }
        }

        if (!_options.userAgent) {
            const platform = os.platform();
            if (platform === 'win32') {
                _options.userAgent = defaultUserAgent;
            }
            /*else if (platform === 'darwin') {
                _options.userAgent = defaultUserAgentMacOs;
            }*/
            else {
                _options.userAgent = defaultUserAgentLinux;
            }
        }
        _options.logger && _options.logger(`Alexa-Cookie: Use as User-Agent: ${_options.userAgent}`);

        _options.acceptLanguage = _options.acceptLanguage || defaultAcceptLanguage;

        _options.logger && _options.logger(`Alexa-Cookie: Use as Accept-Language: ${_options.acceptLanguage}`);

        _options.proxyCloseWindowHTML = _options.proxyCloseWindowHTML || defaultProxyCloseWindowHTML;

        if (_options.setupProxy && !_options.proxyOwnIp && !_options.proxyHost) {
            _options.logger && _options.logger('Alexa-Cookie: Own-IP Setting missing for Proxy. Disabling!');
            _options.setupProxy = false;
        }
        if (_options.setupProxy) {
            _options.setupProxy = true;
            _options.proxyPort = _options.proxyPort || 0;
            _options.proxyListenBind = _options.proxyListenBind || '0.0.0.0';
            _options.logger && _options.logger(`Alexa-Cookie: Proxy-Mode enabled if needed: ${getProxyUrl()} to listen on ${_options.proxyListenBind}`);
        } else {
            _options.setupProxy = false;
            _options.logger && _options.logger('Alexa-Cookie: Proxy mode disabled');
        }
        _options.proxyLogLevel = _options.proxyLogLevel || 'warn';
        _options.amazonPageProxyLanguage = _options.amazonPageProxyLanguage || 'en_US';

        if (_options.formerRegistrationData) _options.proxyOnly = true;
    };

    const getCSRFFromCookies = (cookie, _options, callback) => {
        // get CSRF
        const csrfUrls = [...csrfOptions];

        function csrfTry() {
            const path = csrfUrls.shift();
            const options = {
                'host': `alexa.${_options.amazonPage}`,
                'path': path,
                'method': 'GET',
                'headers': {
                    'DNT': '1',
                    'User-Agent': _options.userAgent,
                    'Connection': 'keep-alive',
                    'Referer': `https://alexa.${_options.amazonPage}/spa/index.html`,
                    'Cookie': cookie,
                    'Accept': '*/*',
                    'Origin': `https://alexa.${_options.amazonPage}`
                }
            };

            _options.logger && _options.logger(`Alexa-Cookie: Step 4: get CSRF via ${path}`);
            request(options, (error, response) => {
                cookie = addCookies(cookie, response ? response.headers : null);
                const ar = /csrf=([^;]+)/.exec(cookie);
                const csrf = ar ? ar[1] : undefined;
                _options.logger && _options.logger(`Alexa-Cookie: Result: csrf=${csrf}, Cookie=${cookie}`);
                if (!csrf && csrfUrls.length) {
                    csrfTry();
                    return;
                }
                callback && callback(null, {
                    cookie: cookie,
                    csrf: csrf
                });
            });
        }

        csrfTry();
    };

    this.generateAlexaCookie = (email, password, __options, callback) => {
        if (email !== undefined && typeof email !== 'string') {
            callback = __options;
            __options = password;
            password = email;
            email = null;
        }
        if (password !== undefined && typeof password !== 'string') {
            callback = __options;
            __options = password;
            password = null;
        }

        if (typeof __options === 'function') {
            callback = __options;
            __options = {};
        }

        _options = __options;

        if (!email || !password) {
            __options.proxyOnly = true;
        }

        initConfig();

        if (!_options.proxyOnly) {
            // get first cookie and write redirection target into referer
            const options = {
                host: `alexa.${_options.amazonPage}`,
                path: '',
                method: 'GET',
                headers: {
                    'DNT': '1',
                    'Upgrade-Insecure-Requests': '1',
                    'User-Agent': _options.userAgent,
                    'Accept-Language': _options.acceptLanguage,
                    'Connection': 'keep-alive',
                    'Accept': '*/*'
                },
            };
            _options.logger && _options.logger('Alexa-Cookie: Step 1: get first cookie and authentication redirect');
            request(options, (error, response, body, info) => {
                if (error) {
                    callback && callback(error, null);
                    return;
                }

                const lastRequestOptions = info.requests[info.requests.length - 1].options;
                // login empty to generate session
                Cookie = addCookies(Cookie, response.headers);
                const options = {
                    host: `www.${_options.amazonPage}`,
                    path: '/ap/signin',
                    method: 'POST',
                    headers: {
                        'DNT': '1',
                        'Upgrade-Insecure-Requests': '1',
                        'User-Agent': _options.userAgent,
                        'Accept-Language': _options.acceptLanguage,
                        'Connection': 'keep-alive',
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Referer': `https://${lastRequestOptions.host}${lastRequestOptions.path}`,
                        'Cookie': Cookie,
                        'Accept': '*/*'
                    },
                    gzip: true,
                    body: querystring.stringify(getFields(body))
                };
                _options.logger && _options.logger('Alexa-Cookie: Step 2: login empty to generate session');
                request(options, (error, response, body) => {
                    if (error) {
                        callback && callback(error, null);
                        return;
                    }

                    // login with filled out form
                    //  !!! referer now contains session in URL
                    options.host = `www.${_options.amazonPage}`;
                    options.path = '/ap/signin';
                    options.method = 'POST';
                    options.headers.Cookie = Cookie = addCookies(Cookie, response.headers);
                    const ar = options.headers.Cookie.match(/session-id=([^;]+)/);
                    options.headers.Referer = `https://www.${_options.amazonPage}/ap/signin/${ar[1]}`;
                    options.body = getFields(body);
                    options.body.email = email || '';
                    options.body.password = password || '';
                    options.body = querystring.stringify(options.body, null, null, {encodeURIComponent: encodeURIComponent});

                    _options.logger && _options.logger('Alexa-Cookie: Step 3: login with filled form, referer contains session id');
                    request(options, (error, response, body, info) => {
                        if (error) {
                            callback && callback(error, null);
                            return;
                        }

                        const lastRequestOptions = info.requests[info.requests.length - 1].options;

                        // check whether the login has been successful or exit otherwise
                        if (!lastRequestOptions.host.startsWith('alexa') || !lastRequestOptions.path.endsWith('.html')) {
                            let errMessage = 'Login unsuccessfull. Please check credentials.';
                            const amazonMessage = body.match(/auth-warning-message-box[\S\s]*"a-alert-heading">([^<]*)[\S\s]*<li><[^>]*>\s*([^<\n]*)\s*</);
                            if (amazonMessage && amazonMessage[1] && amazonMessage[2]) {
                                errMessage = `Amazon-Login-Error: ${amazonMessage[1]}: ${amazonMessage[2]}`;
                            }
                            if (_options.setupProxy) {
                                if (proxyServer) {
                                    errMessage += ` You can try to get the cookie manually by opening ${getProxyUrl()} with your browser.`;
                                } else {
                                    amazonProxy.initAmazonProxy(_options, prepareResult,
                                        (server) => {
                                            if (!server) {
                                                return callback && callback(new Error('Proxy could not be initialized'), null);
                                            }
                                            proxyServer = server;
                                            if (!_options.proxyPort || _options.proxyPort === 0) {
                                                _options.proxyPort = proxyServer.address().port;
                                            }
                                            errMessage += ` You can try to get the cookie manually by opening ${getProxyUrl()} with your browser.`;
                                            callback && callback(new Error(errMessage), null);
                                        }
                                    );
                                    return;
                                }
                            }
                            callback && callback(new Error(errMessage), null);
                            return;
                        }

                        return getCSRFFromCookies(Cookie, _options, callback);
                    });
                });
            });
        } else {
            amazonProxy.initAmazonProxy(_options, prepareResult, (server) => {
                if (!server) {
                    callback && callback(new Error('Proxy Server could not be initialized. Check Logs.'), null);
                    return;
                }
                proxyServer = server;
                if (!_options.proxyPort || _options.proxyPort === 0) {
                    _options.proxyPort = proxyServer.address().port;
                }
                const errMessage = `You can try to get the cookie manually by opening ${getProxyUrl()} with your browser.`;
                callback && callback(new Error(errMessage), null);
            });
        }

        function prepareResult(err, data) {
            if (err || !data.authorization_code) {
                callback && callback(err, data.loginCookie);
                return;
            }
            handleTokenRegistration(_options, data, callback);
        }
    };

    this.getDeviceAppName = () => {
        return (_options && _options.deviceAppName) || defaultAppName;
    };

    const handleTokenRegistration = (_options, loginData, callback) => {
        _options.logger && _options.logger(`Handle token registration Start: ${JSON.stringify(loginData)}`);

        loginData.deviceAppName = _options.deviceAppName;
        loginData.loginCookie = sanitizeAmazonCookie(loginData.loginCookie);

        let deviceSerial;
        if (!_options.formerRegistrationData || !_options.formerRegistrationData.deviceSerial) {
            const deviceSerialBuffer = Buffer.alloc(16);
            for (let i = 0; i < 16; i++) {
                deviceSerialBuffer.writeUInt8(Math.floor(Math.random() * 255), i);
            }
            deviceSerial = deviceSerialBuffer.toString('hex');
        } else {
            _options.logger && _options.logger('Proxy Init: reuse deviceSerial from former data');
            deviceSerial = _options.formerRegistrationData.deviceSerial;
        }
        loginData.deviceSerial = deviceSerial;

        const cookies = cookieTools.parse(loginData.loginCookie);
        Cookie = loginData.loginCookie;

        /*
            Register App
         */

        const registerData = {
            'requested_extensions': [
                'device_info',
                'customer_info'
            ],
            'cookies': {
                'website_cookies': [],
                'domain': `.${_options.baseAmazonPage}`
            },
            'registration_data': {
                'domain': 'Device',
                'app_version': apiCallVersion,
                'device_type': 'A2IVLV5VM2W81',
                'device_name': '%FIRST_NAME%\u0027s%DUPE_STRATEGY_1ST%' + _options.deviceAppName,
                'os_version': '18.3.1',
                'device_serial': deviceSerial,
                'device_model': 'iPhone',
                'app_name': _options.deviceAppName,
                'software_version': '1'
            },
            'auth_data': {
                // Filled below
            },
            'user_context_map': {
                'frc': cookies.frc
            },
            'requested_token_type': [
                'bearer',
                'mac_dms',
                'website_cookies'
            ]
        };
        if (loginData.accessToken) {
            registerData.auth_data = {
                'access_token': loginData.accessToken
            };
        } else if (loginData.authorization_code && loginData.verifier) {
            registerData.auth_data = {
                'client_id' : loginData.deviceId,
                'authorization_code' : loginData.authorization_code,
                'code_verifier' : loginData.verifier,
                'code_algorithm' : 'SHA-256',
                'client_domain' : 'DeviceLegacy'
            };
        }
        for (const key of Object.keys(cookies)) {
            registerData.cookies.website_cookies.push({
                'Value': cookies[key],
                'Name': key
            });
        }

        const options = {
            host: `api.${_options.baseAmazonPage}`,
            path: '/auth/register',
            method: 'POST',
            headers: {
                'User-Agent': apiCallUserAgent,
                'Accept-Language': _options.acceptLanguage,
                'Accept-Charset': 'utf-8',
                'Connection': 'keep-alive',
                'Content-Type': 'application/json',
                'Cookie': loginData.loginCookie,
                'Accept': 'application/json',
                'x-amzn-identity-auth-domain': `api.${_options.baseAmazonPage}`
            },
            body: JSON.stringify(registerData)
        };
        _options.logger && _options.logger('Alexa-Cookie: Register App');
        _options.logger && _options.logger(JSON.stringify(options));
        request(options, (error, response, body) => {
            if (error) {
                callback && callback(error, null);
                return;
            }
            try {
                if (typeof body !== 'object') body = JSON.parse(body);
            } catch (err) {
                _options.logger && _options.logger(`Register App Response: ${JSON.stringify(body)}`);
                callback && callback(err, null);
                return;
            }
            _options.logger && _options.logger(`Register App Response: ${JSON.stringify(body)}`);

            if (!body.response || !body.response.success || !body.response.success.tokens || !body.response.success.tokens.bearer) {
                callback && callback(new Error('No tokens in Register response'), null);
                return;
            }
            Cookie = addCookies(Cookie, response.headers);
            loginData.refreshToken = body.response.success.tokens.bearer.refresh_token;
            const accessToken = body.response.success.tokens.bearer.access_token;
            loginData.accessToken = accessToken;
            loginData.tokenDate = Date.now();
            loginData.macDms = body.response.success.tokens.mac_dms;

            if (body.response.success.tokens.website_cookies && Array.isArray(body.response.success.tokens.website_cookies)) {
                const newCookies = [];
                body.response.success.tokens.website_cookies.forEach(cookie => {
                    newCookies.push(`${cookie.Name}=${cookie.Value};`);
                });
                Cookie = addCookies(Cookie, {'set-cookie': newCookies});
            }

            registerTokenCapabilities(accessToken, () => {
                /*
                    Get Amazon Marketplace Country
                */

                const options = {
                    host: `alexa.${_options.baseAmazonPage}`,
                    path: `/api/users/me?platform=ios&version=${apiCallVersion}`,
                    method: 'GET',
                    headers: {
                        'User-Agent': apiCallUserAgent,
                        'Accept-Language': _options.acceptLanguage,
                        'Accept-Charset': 'utf-8',
                        'Connection': 'keep-alive',
                        'Accept': 'application/json',
                        'Cookie': Cookie
                    }
                };
                _options.logger && _options.logger('Alexa-Cookie: Get User data');
                _options.logger && _options.logger(JSON.stringify(options));
                request(options, (error, response, body) => {
                    if (!error) {
                        if (!response || response.statusCode < 200 || response.statusCode >= 300 || !body) {
                            _options.logger && _options.logger(`Get User data Response: status=${response && response.statusCode}, body=${JSON.stringify(body)}`);
                            if (!_options.amazonPage) {
                                callback && callback(new Error(`Could not get user data from Amazon: HTTP ${response && response.statusCode}`), null);
                                return;
                            }
                            loginData.amazonPage = _options.amazonPage;
                        } else {
                            try {
                                if (typeof body !== 'object') body = JSON.parse(body);
                            } catch (err) {
                                _options.logger && _options.logger(`Get User data Response: ${JSON.stringify(body)}`);
                                if (!_options.amazonPage) {
                                    callback && callback(err, null);
                                    return;
                                }
                                loginData.amazonPage = _options.amazonPage;
                            }
                            _options.logger && _options.logger(`Get User data Response: ${JSON.stringify(body)}`);

                            Cookie = addCookies(Cookie, response.headers);

                            if (body && body.marketPlaceDomainName) {
                                const pos = body.marketPlaceDomainName.indexOf('.');
                                if (pos !== -1) _options.amazonPage = body.marketPlaceDomainName.substr(pos + 1);
                            }
                            loginData.amazonPage = _options.amazonPage;
                        }
                    } else if (error && (!_options || !_options.amazonPage)) {
                        callback && callback(error, null);
                        return;
                    } else if (error && (!_options.formerRegistrationData || !_options.formerRegistrationData.amazonPage) && _options.amazonPage) {
                        _options.logger && _options.logger(`Continue with externally set amazonPage: ${_options.amazonPage}`);
                    } else if (error) {
                        _options.logger && _options.logger('Ignore error while getting user data and amazonPage because previously set amazonPage is available');
                    }

                    loginData.loginCookie = Cookie;

                    getLocalCookies(loginData.amazonPage, loginData.refreshToken, (err, localCookie) => {
                        if (err) {
                            callback && callback(err, null);
                            return;
                        }

                        loginData.localCookie = localCookie;
                        getCSRFFromCookies(loginData.localCookie, _options, (err, resData) => {
                            if (err) {
                                callback && callback(new Error(`Error getting csrf for ${loginData.amazonPage}`), null);
                                return;
                            }
                            loginData.localCookie = resData.cookie;
                            loginData.csrf = resData.csrf;
                            delete loginData.authorization_code;
                            delete loginData.verifier;
                            loginData.dataVersion = 2;
                            _options.logger && _options.logger(`Final Registration Result: ${JSON.stringify(loginData)}`);
                            callback && callback(null, loginData);
                        });
                    });
                });
            });
        });
    };

    const registerTokenCapabilities = (accessToken, callback) => {
        /*
            Register Capabilities - mainly needed for HTTP/2 push infos
         */
        const options = {
            host: `api.amazonalexa.com`, // How Domains needs to be for other regions? au/jp?
            path: `/v1/devices/@self/capabilities`,
            method: 'PUT',
            headers: {
                'User-Agent': apiCallUserAgent,
                'Accept-Language': _options.acceptLanguage,
                'Accept-Charset': 'utf-8',
                'Connection': 'keep-alive',
                'Content-type': 'application/json; charset=UTF-8',
                'authorization': `Bearer ${accessToken}`,
            },
            body: '{"legacyFlags":{"SUPPORTS_COMMS":true,"SUPPORTS_ARBITRATION":true,"SCREEN_WIDTH":1170,"SUPPORTS_SCRUBBING":true,"SPEECH_SYNTH_SUPPORTS_TTS_URLS":false,"SUPPORTS_HOME_AUTOMATION":true,"SUPPORTS_DROPIN_OUTBOUND":true,"FRIENDLY_NAME_TEMPLATE":"VOX","SUPPORTS_SIP_OUTBOUND_CALLING":true,"VOICE_PROFILE_SWITCHING_DISABLED":true,"SUPPORTS_LYRICS_IN_CARD":false,"SUPPORTS_DATAMART_NAMESPACE":"Vox","SUPPORTS_VIDEO_CALLING":true,"SUPPORTS_PFM_CHANGED":true,"SUPPORTS_TARGET_PLATFORM":"TABLET","SUPPORTS_SECURE_LOCKSCREEN":false,"AUDIO_PLAYER_SUPPORTS_TTS_URLS":false,"SUPPORTS_KEYS_IN_HEADER":false,"SUPPORTS_MIXING_BEHAVIOR_FOR_AUDIO_PLAYER":false,"AXON_SUPPORT":true,"SUPPORTS_TTS_SPEECHMARKS":true},"envelopeVersion":"20160207","capabilities":[{"version":"0.1","interface":"CardRenderer","type":"AlexaInterface"},{"interface":"Navigation","type":"AlexaInterface","version":"1.1"},{"type":"AlexaInterface","version":"2.0","interface":"Alexa.Comms.PhoneCallController"},{"type":"AlexaInterface","version":"1.1","interface":"ExternalMediaPlayer"},{"type":"AlexaInterface","interface":"Alerts","configurations":{"maximumAlerts":{"timers":2,"overall":99,"alarms":2}},"version":"1.3"},{"version":"1.0","interface":"Alexa.Display.Window","type":"AlexaInterface","configurations":{"templates":[{"type":"STANDARD","id":"app_window_template","configuration":{"sizes":[{"id":"fullscreen","type":"DISCRETE","value":{"value":{"height":1440,"width":3200},"unit":"PIXEL"}}],"interactionModes":["mobile_mode","auto_mode"]}}]}},{"type":"AlexaInterface","interface":"AccessoryKit","version":"0.1"},{"type":"AlexaInterface","interface":"Alexa.AudioSignal.ActiveNoiseControl","version":"1.0","configurations":{"ambientSoundProcessingModes":[{"name":"ACTIVE_NOISE_CONTROL"},{"name":"PASSTHROUGH"}]}},{"interface":"PlaybackController","type":"AlexaInterface","version":"1.0"},{"version":"1.0","interface":"Speaker","type":"AlexaInterface"},{"version":"1.0","interface":"SpeechSynthesizer","type":"AlexaInterface"},{"version":"1.0","interface":"AudioActivityTracker","type":"AlexaInterface"},{"type":"AlexaInterface","interface":"Alexa.Camera.LiveViewController","version":"1.0"},{"type":"AlexaInterface","version":"1.0","interface":"Alexa.Input.Text"},{"type":"AlexaInterface","interface":"Alexa.PlaybackStateReporter","version":"1.0"},{"version":"1.1","interface":"Geolocation","type":"AlexaInterface"},{"interface":"Alexa.Health.Fitness","version":"1.0","type":"AlexaInterface"},{"interface":"Settings","type":"AlexaInterface","version":"1.0"},{"configurations":{"interactionModes":[{"dialog":"SUPPORTED","interactionDistance":{"value":18,"unit":"INCHES"},"video":"SUPPORTED","keyboard":"SUPPORTED","id":"mobile_mode","uiMode":"MOBILE","touch":"SUPPORTED"},{"video":"UNSUPPORTED","dialog":"SUPPORTED","interactionDistance":{"value":36,"unit":"INCHES"},"uiMode":"AUTO","touch":"SUPPORTED","id":"auto_mode","keyboard":"UNSUPPORTED"}]},"type":"AlexaInterface","interface":"Alexa.InteractionMode","version":"1.0"},{"type":"AlexaInterface","configurations":{"catalogs":[{"type":"IOS_APP_STORE","identifierTypes":["URI_HTTP_SCHEME","URI_CUSTOM_SCHEME"]}]},"version":"0.2","interface":"Alexa.Launcher"},{"interface":"System","version":"1.0","type":"AlexaInterface"},{"interface":"Alexa.IOComponents","type":"AlexaInterface","version":"1.4"},{"type":"AlexaInterface","interface":"Alexa.FavoritesController","version":"1.0"},{"version":"1.0","type":"AlexaInterface","interface":"Alexa.Mobile.Push"},{"type":"AlexaInterface","interface":"InteractionModel","version":"1.1"},{"interface":"Alexa.PlaylistController","type":"AlexaInterface","version":"1.0"},{"interface":"SpeechRecognizer","type":"AlexaInterface","version":"2.1"},{"interface":"AudioPlayer","type":"AlexaInterface","version":"1.3"},{"type":"AlexaInterface","version":"3.1","interface":"Alexa.RTCSessionController"},{"interface":"VisualActivityTracker","version":"1.1","type":"AlexaInterface"},{"interface":"Alexa.PlaybackController","version":"1.0","type":"AlexaInterface"},{"type":"AlexaInterface","interface":"Alexa.SeekController","version":"1.0"},{"interface":"Alexa.Comms.MessagingController","type":"AlexaInterface","version":"1.0"}]}'

            // New
            // {"envelopeVersion":"20160207","legacyFlags":{"SUPPORTS_TARGET_PLATFORM":"TABLET","SUPPORTS_SECURE_LOCKSCREEN":false,"SUPPORTS_DATAMART_NAMESPACE":"Vox","AXON_SUPPORT":true,"SUPPORTS_DROPIN_OUTBOUND":true,"SUPPORTS_LYRICS_IN_CARD":false,"VOICE_PROFILE_SWITCHING_DISABLED":true,"SUPPORTS_ARBITRATION":true,"SUPPORTS_HOME_AUTOMATION":true,"SUPPORTS_KEYS_IN_HEADER":false,"SUPPORTS_TTS_SPEECHMARKS":true,"AUDIO_PLAYER_SUPPORTS_TTS_URLS":false,"SUPPORTS_SIP_OUTBOUND_CALLING":true,"SUPPORTS_MIXING_BEHAVIOR_FOR_AUDIO_PLAYER":false,"SUPPORTS_COMMS":true,"SCREEN_WIDTH":1170,"SUPPORTS_VIDEO_CALLING":true,"FRIENDLY_NAME_TEMPLATE":"VOX","SUPPORTS_PFM_CHANGED":true,"SPEECH_SYNTH_SUPPORTS_TTS_URLS":false,"SUPPORTS_SCRUBBING":true},"capabilities":[{"type":"AlexaInterface","interface":"AudioPlayer","version":"1.3"},{"version":"1.0","type":"AlexaInterface","interface":"Settings"},{"interface":"System","type":"AlexaInterface","version":"1.0"},{"type":"AlexaInterface","interface":"AudioActivityTracker","version":"1.0"},{"interface":"SpeechRecognizer","version":"2.3","type":"AlexaInterface"},{"type":"AlexaInterface","interface":"Speaker","version":"1.0"},{"type":"AlexaInterface","version":"1.0","interface":"SpeechSynthesizer"},{"type":"AlexaInterface","version":"0.1","interface":"CardRenderer"},{"interface":"PlaybackController","type":"AlexaInterface","version":"1.0"},{"version":"1.1","type":"AlexaInterface","interface":"Navigation"},{"version":"1.1","type":"AlexaInterface","interface":"InteractionModel"},{"type":"AlexaInterface","version":"1.1","interface":"Geolocation"}]}
        };
        _options.logger && _options.logger('Alexa-Cookie: Register capabilities');
        _options.logger && _options.logger(JSON.stringify(options));
        request(options, (error, response, body) => {
            if (error || (response.statusCode !== 204 && response.statusCode !== 200)) {
                _options.logger && _options.logger('Alexa-Cookie: Could not set capabilities, Push connection might not work!');
                _options.logger && _options.logger(`Alexa-Cookie: ${JSON.stringify(error)}: ${JSON.stringify(body)}`);
            }
            callback && callback();
        });
    };

    const getLocalCookies = (amazonPage, refreshToken, callback) => {
        Cookie = ''; // Reset because we are switching domains
        /*
            Token Exchange to Amazon Country Page
        */

        const exchangeParams = {
            'di.os.name': 'iOS',
            'app_version': apiCallVersion,
            'domain': `.${amazonPage}`,
            'source_token': refreshToken,
            'requested_token_type': 'auth_cookies',
            'source_token_type': 'refresh_token',
            'di.hw.version': 'iPhone',
            'di.sdk.version': '6.12.4',
            'app_name': _options.deviceAppName || defaultAppName,
            'di.os.version': '16.6'
        };
        const options = {
            host: `www.${amazonPage}`,
            path: '/ap/exchangetoken/cookies',
            method: 'POST',
            headers: {
                'User-Agent': apiCallUserAgent,
                'Accept-Language': _options.acceptLanguage,
                'Accept-Charset': 'utf-8',
                'Connection': 'keep-alive',
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': '*/*',
                'Cookie': Cookie,
                'x-amzn-identity-auth-domain': `api.${amazonPage}`
            },
            body: querystring.stringify(exchangeParams, null, null, {
                encodeURIComponent: encodeURIComponent
            })
        };
        _options.logger && _options.logger(`Alexa-Cookie: Exchange tokens for ${amazonPage}`);
        _options.logger && _options.logger(JSON.stringify(options));

        request(options, (error, response, body) => {
            if (error) {
                callback && callback(error, null);
                return;
            }
            try {
                if (typeof body !== 'object') body = JSON.parse(body);
            } catch (err) {
                _options.logger && _options.logger(`Exchange Token Response: ${JSON.stringify(body)}`);
                callback && callback(err, null);
                return;
            }
            _options.logger && _options.logger(`Exchange Token Response: ${JSON.stringify(body)}`);

            if (!body.response || !body.response.tokens || !body.response.tokens.cookies) {
                callback && callback(new Error('No cookies in Exchange response'), null);
                return;
            }
            if (!body.response.tokens.cookies[`.${amazonPage}`]) {
                callback && callback(new Error(`No cookies for ${amazonPage} in Exchange response`), null);
                return;
            }

            Cookie = addCookies(Cookie, response.headers);
            const cookies = cookieTools.parse(Cookie);
            body.response.tokens.cookies[`.${amazonPage}`].forEach((cookie) => {
                if (cookies[cookie.Name] && cookies[cookie.Name] !== cookie.Value) {
                    _options.logger && _options.logger(`Alexa-Cookie: Update Cookie ${cookie.Name} = ${cookie.Value}`);
                } else if (!cookies[cookie.Name]) {
                    _options.logger && _options.logger(`Alexa-Cookie: Add Cookie ${cookie.Name} = ${cookie.Value}`);
                }
                cookies[cookie.Name] = cookie.Value;

            });
            let localCookie = '';
            for (const name of Object.keys(cookies)) {
                localCookie += `${name}=${cookies[name]}; `;
            }
            localCookie = localCookie.replace(/[; ]*$/, '');

            callback && callback(null, localCookie);
        });
    };

    const finishCookieRefresh = (loginData, callback) => {
        _options.logger && _options.logger('Alexa-Cookie: Skip App registration during refresh and update local cookies');
        const updateLocalCookies = () => {
            const amazonPage = loginData.amazonPage || _options.amazonPage;
            getLocalCookies(amazonPage, loginData.refreshToken, (err, localCookie) => {
                if (err) {
                    callback && callback(err, null);
                    return;
                }

                loginData.localCookie = localCookie;
                getCSRFFromCookies(loginData.localCookie, _options, (err, resData) => {
                    if (err) {
                        callback && callback(new Error(`Error getting csrf for ${amazonPage}`), null);
                        return;
                    }
                    loginData.localCookie = resData.cookie;
                    loginData.csrf = resData.csrf;
                    loginData.amazonPage = amazonPage;
                    loginData.tokenDate = Date.now();
                    delete loginData.authorization_code;
                    delete loginData.verifier;
                    loginData.dataVersion = 2;
                    _options.logger && _options.logger('Alexa-Cookie: Refresh finished with updated cookies and csrf');
                    callback && callback(null, loginData);
                });
            });
        };

        if (loginData.accessToken) {
            registerTokenCapabilities(loginData.accessToken, updateLocalCookies);
            return;
        }
        updateLocalCookies();
    };

    this.refreshAlexaCookie = (__options, callback) => {
        if (!__options || !__options.formerRegistrationData || !__options.formerRegistrationData.loginCookie || !__options.formerRegistrationData.refreshToken) {
            callback && callback(new Error('No former registration data provided for Cookie Refresh'), null);
            return;
        }

        if (typeof __options === 'function') {
            callback = __options;
            __options = {};
        }

        _options = __options;

        __options.proxyOnly = true;

        initConfig();

        const refreshData = {
            'app_name': _options.deviceAppName || defaultAppName,
            'app_version': apiCallVersion,
            'di.sdk.version': '6.12.4',
            'source_token': _options.formerRegistrationData.refreshToken,
            'package_name': 'com.amazon.echo',
            'di.hw.version': 'iPhone',
            'platform': 'iOS',
            'requested_token_type': 'access_token',
            'source_token_type': 'refresh_token',
            'di.os.name': 'iOS',
            'di.os.version': '16.6',
            'current_version': '6.12.4'
        };

        const options = {
            host: `api.${_options.baseAmazonPage}`,
            path: '/auth/token',
            method: 'POST',
            headers: {
                'User-Agent': apiCallUserAgent,
                'Accept-Language': _options.acceptLanguage,
                'Accept-Charset': 'utf-8',
                'Connection': 'keep-alive',
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': _options.formerRegistrationData.loginCookie,
                'Accept': 'application/json',
                'x-amzn-identity-auth-domain': `api.${_options.baseAmazonPage}`
            },
            body: querystring.stringify(refreshData)
        };
        Cookie = _options.formerRegistrationData.loginCookie;
        _options.logger && _options.logger('Alexa-Cookie: Refresh Token');
        _options.logger && _options.logger(JSON.stringify(options));
        request(options, (error, response, body) => {
            if (error) {
                callback && callback(error, null);
                return;
            }
            try {
                if (typeof body !== 'object') body = JSON.parse(body);
            } catch (err) {
                _options.logger && _options.logger(`Refresh Token Response: ${JSON.stringify(body)}`);
                callback && callback(err, null);
                return;
            }
            _options.logger && _options.logger(`Refresh Token Response: ${JSON.stringify(body)}`);

            _options.formerRegistrationData.loginCookie = addCookies(_options.formerRegistrationData.loginCookie, response.headers);

            if (!body.access_token) {
                callback && callback(new Error('No new access token in Refresh Token response'), null);
                return;
            }
            _options.formerRegistrationData.loginCookie = addCookies(Cookie, response.headers);
            _options.formerRegistrationData.accessToken = body.access_token;

            getLocalCookies(_options.baseAmazonPage, _options.formerRegistrationData.refreshToken, (err, comCookie) => {
                if (err) {
                    callback && callback(err, null);
                    return;
                }

                // Restore frc and map-md
                const initCookies = cookieTools.parse(_options.formerRegistrationData.loginCookie);
                let newCookie = `frc=${initCookies.frc}; `;
                newCookie += `map-md=${initCookies['map-md']}; `;
                newCookie += comCookie;

                _options.formerRegistrationData.loginCookie = sanitizeAmazonCookie(newCookie);
                finishCookieRefresh(_options.formerRegistrationData, callback);
            });
        });
    };

    this.stopProxyServer = (callback) => {
        if (proxyServer) {
            proxyServer.close(() => {
                callback && callback();
            });
        }
        proxyServer = null;
    };
}

module.exports = AlexaCookie();
