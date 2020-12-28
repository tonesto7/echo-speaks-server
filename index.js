const packageFile = require('./package.json'),
    appVer = packageFile.version,
    alexaCookie = require('./libs/alexa-cookie/alexa-cookie'),
    reqPromise = require("request-promise"),
    logger = require('./logger'),
    express = require('express'),
    bodyParser = require('body-parser'),
    childProcess = require("child_process"),
    compareVersions = require("compare-versions"),
    os = require('os'),
    editJsonFile = require("edit-json-file", {
        autosave: true
    }),
    dataFolder = os.homedir(),
    configFile = editJsonFile(dataFolder + '/es_config.json'),
    sessionFile = editJsonFile(dataFolder + '/session.json'),
    fs = require('fs'),
    webApp = express(),
    urlencodedParser = bodyParser.urlencoded({
        extended: false
    });
// process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
sessionFile.save();

// These the config variables
let configData = {};
let sessionData = sessionFile.get() || {};
let runTimeData = {};
let forceHeroku = false;

runTimeData.savedConfig = {};
runTimeData.scheduledUpdatesActive = false;
runTimeData.alexaUrl = 'https://alexa.amazon.com';
runTimeData.loginProxyActive = false;
runTimeData.loginComplete = false;
runTimeData.ignoredDevices = {};
runTimeData.authenticated = false;
runTimeData.serviceDebug = false;
runTimeData.serviceTrace = false;
runTimeData.serviceStartTime = Date.now(); //Returns time in millis
runTimeData.eventCount = 0;
runTimeData.echoDevices = {};
runTimeData.guardData = {};

function initConfig() {
    return new Promise((resolve) => {
        // logger.debug('dataFolder: ' + dataFolder);
        // Create the log directory if it does not exist
        if (!fs.existsSync(dataFolder)) {
            fs.mkdirSync(dataFolder);
        }
        if (!fs.existsSync(dataFolder + '/logs')) {
            fs.mkdirSync(dataFolder + '/logs');
        }
        resolve(loadConfig());
    });
}

function loadConfig() {
    configData = configFile.get() || {};
    // console.log(configData);
    if (!configData.settings) {
        configData.settings = {};
    }
    if (process.env.hostUrl) {
        configFile.set('settings.hostUrl', process.env.hostUrl);
    }
    configFile.set('settings.useHeroku', (forceHeroku || process.env.useHeroku === true || process.env.useHeroku === 'true'));
    configFile.set('settings.amazonDomain', process.env.amazonDomain || (configData.settings.amazonDomain || 'amazon.com'));
    configFile.set('settings.hubPlatform', process.env.hubPlatform || (configData.settings.hubPlatform || 'SmartThings'));
    configFile.set('settings.appCallbackUrl', (process.env.appCallbackUrl || configData.settings.appCallbackUrl || (process.env.smartThingsUrl !== null ? process.env.smartThingsUrl : configData.settings.smartThingsUrl)));
    if (process.env.serviceDebug === true || process.env.serviceDebug === 'true') console.log('** SERVICE DEBUG IS ACTIVE **');
    configFile.set('settings.serviceDebug', (process.env.serviceDebug === true || process.env.serviceDebug === 'true'));
    configFile.set('settings.serviceTrace', (process.env.serviceTrace === true || process.env.serviceTrace === 'true'));
    configFile.set('settings.regionLocale', (process.env.regionLocale || (configData.settings.regionLocale || 'en-US'))),
        //   configFile.set('settings.serviceDebug', true);
        //   configFile.set('settings.serviceTrace', true);
        configFile.set('settings.serverPort', process.env.PORT || (configData.settings.serverPort || 8091));
    if (!configData.state) {
        configData.state = {};
    }
    configFile.set('state.scriptVersion', appVer);
    configFile.save();
    configData = configFile.get();
    return true;
}

const getLocalHost = (noPort = false) => {
        return `${getIPAddress()}${(noPort || configData.settings.useHeroku) ? '' : `:${configData.settings.serverPort}`}`;
};

const getProtoPrefix = () => {
    return `${configData.settings.useHeroku ? 'https' : 'http'}`;
};

function startWebConfig() {
    return new Promise((resolve, reject) => {
        try {
            webApp.listen(configData.settings.serverPort, () => {
                logger.info(`** Echo Speaks Config Service (v${appVer}) is Running at (IP: ${getIPAddress()} | Port: ${configData.settings.serverPort}) | ProcessId: ${process.pid} **`);
                // logger.info(`** To Signin to Amazon please open your browser to: (${getProtoPrefix()}://${getLocalHost()}) **`);
                logger.info(`** On Heroku: (${configData.settings.useHeroku}) **`);
                checkVersion();
            });
            //   }
            webApp.use((req, res, next) => {
                res.header("Access-Control-Allow-Origin", "*");
                res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
                next();
            });

            webApp.get('/', (req, res) => {
                if (req.hostname) {
                    if (configData.settings.hostUrl === undefined || configData.settings.hostUrl !== req.hostname) {
                        logger.debug(`set host url: ${req.hostname}`);
                        configFile.set('settings.hostUrl', req.hostname);
                        configFile.save();
                        configData.settings.hostUrl = req.hostname;
                    }
                }
                if (!configData.state.loginComplete) {
                    startWebServer();
                }
                logger.debug('config(/) page requested');
                res.sendFile(__dirname + '/public/index.html');
            });

            webApp.get('/config', (req, res) => {
                if (req.hostname) {
                    if (configData.settings.hostUrl === undefined || configData.settings.hostUrl !== req.hostname) {
                        logger.debug(`set host url: ${req.hostname}`);
                        configFile.set('settings.hostUrl', req.hostname);
                        configFile.save();
                        configData.settings.hostUrl = req.hostname;
                    }
                }
                if (!configData.state.loginComplete) {
                    startWebServer();
                }
                logger.debug('/config page requested');
                res.sendFile(__dirname + '/public/index.html');
            });
            webApp.get('/manualCookie', (req, res) => {
                logger.debug('/manualCookie page requested');
                res.sendFile(__dirname + '/public/manual_cookie.html');
            });

            webApp.get('/cookieData', (req, res) => {
                // console.log(configData)
                res.send(JSON.stringify(sessionFile.get() || {}));
            });
            webApp.post('/wakeup', (req, res) => {
                // console.log('req: ', req.headers);
                logger.info(`Server Wakeup Received | Reason: (${req.headers.wakesrc})`);
                res.send("OK");
            });
            webApp.get('/checkVersion', (req, res) => {
                // console.log(configData)
                res.send(JSON.stringify(checkVersion()));
            });
            webApp.get('/agsData', async (req, res) => {
                logger.info('Requesting Guard Support Data...');
                let resp = await getGuardDataSupport();
                res.send(JSON.stringify({
                    guardData: resp || null
                }));
            });
            webApp.post('/cookieData', (req, res) => {
                let saveFile = false;
                if (req.headers.cookiedata) {
                    let cData = JSON.parse(req.headers.cookiedata);
                    // console.log(cData);
                    sessionFile.set('cookieData', {
                        localCookie: cData.cookie,
                        csrf: cData.csrf
                    });
                    saveFile = true;
                };
                if (saveFile) {
                    sessionFile.save();
                    sessionData = sessionFile.get();
                    logger.debug('** Cookie Settings File Updated via Manual Entry **');
                    sendCookiesToEndpoint((configData.settings.appCallbackUrl ? String(configData.settings.appCallbackUrl).replace("/receiveData?", "/cookie?") : null), sessionData.cookieData)
                        .then((sendResp) => {
                            if (sendResp) {
                                res.send('done');
                            } else {
                                res.send('failed');
                            }
                        });

                } else {
                    res.send('failed');
                }
            });

            webApp.get('/clearAuth', urlencodedParser, (req, res) => {
                logger.verbose('got request for to clear authentication');
                clearAuth()
                    .then(() => {
                        res.send({
                            result: 'Clear Complete'
                        });
                    });
            });
            webApp.get('/refreshCookie', urlencodedParser, (req, res) => {
                logger.verbose('refreshCookie request received');
                logger.debug(`cookieData: ${runTimeData.savedConfig || null}`);
                alexaCookie.refreshAlexaCookie({
                    formerRegistrationData: runTimeData.savedConfig.cookieData
                }, (err, result) => {
                    if (result && Object.keys(result).length >= 2) {
                      isCookieValid(result)
                        .then((valid) => {
                            if (valid) {
                                sendCookiesToEndpoint((configData.settings.appCallbackUrl ? String(configData.settings.appCallbackUrl).replace("/receiveData?", "/cookie?") : null), result);
                                runTimeData.savedConfig.cookieData = result;
                                // console.log('RESULT: ' + err + ' / ' + JSON.stringify(result));
                                logger.info('Successfully Refreshed Alexa Cookie...');
                                res.send({
                                    result: JSON.stringify(result)
                                });
                            } else {
                                logger.error(`** ERROR: Unsuccessfully refreshed Alexa Cookie it was found to be invalid/expired... **`);
                                logger.error('RESULT: ' + err + ' / ' + JSON.stringify(result));
                                logger.warn(`** WARNING: We are clearing the Cookie from ${configData.settings.hubPlatform} to prevent further requests and server load... **`);
                                sendClearAuthToST()
                            }
                        });
                    } else {
                        logger.error(`** ERROR: Unsuccessfully refreshed Alexa Cookie it was found to be invalid/expired... **`);
                        logger.error('RESULT: ' + err + ' / ' + JSON.stringify(result));
                        logger.warn(`** WARNING: We are clearing the Cookie from ${configData.settings.hubPlatform} to prevent further requests and server load... **`);
                        sendClearAuthToST()
                    }
                    setTimeout(() => {
                        logger.warn("Restarting after cookie refresh attempt");
                        process.exit(1);
                    }, 25 * 1000);
                });
            });
            webApp.get('/configData', (req, res) => {
                // console.log(configData)
                res.send(JSON.stringify(configData));
            });

            webApp.post('/configData', (req, res) => {
                let saveFile = false;
                if (req.headers.user) {
                    configFile.set('settings.user', req.headers.user);
                    saveFile = true;
                };
                if (req.headers.password) {
                    configFile.set('settings.password', req.headers.password);
                    saveFile = true;
                };
                if (req.headers.appcallbackurl) {
                    configFile.set('settings.appCallbackUrl', req.headers.appcallbackurl);
                    saveFile = true;
                };
                if (req.headers.hubplatform) {
                    console.log('hubPlatform: ' + req.headers.hubplatform);
                    configFile.set('settings.hubPlatform', req.headers.hubplatform);
                    saveFile = true;
                };
                if (req.headers.serverport) {
                    configFile.set('settings.serverPort', req.headers.serverport);
                    saveFile = true;
                };
                if (saveFile) {
                    configFile.save();
                    loadConfig();
                    res.send('done');
                    configCheckOk()
                        .then((res) => {
                            if (res) {
                                // console.log('configData(set): ', configData);
                                logger.debug('** Settings File Updated via Web Config **');
                                if (!runTimeData.scheduledUpdatesActive || !runTimeData.loginProxyActive) {
                                    startWebServer();
                                }
                            }
                        });
                } else {
                    res.send('failed');
                }
            });
            webApp.get('/cookie-success', (req, res) => {
                res.send(loginSuccessHtml());
            });
            resolve(true);
        } catch (ex) {
            reject(ex);
        }
    });
}

let clearAuth = () => {
    return new Promise(resolve => {
        logger.verbose('got request for to clear authentication');
        let clearUrl = configData.settings.appCallbackUrl ? String(configData.settings.appCallbackUrl).replace("/receiveData?", "/cookie?") : null;
        clearSession(clearUrl, configData.settings.useHeroku);
        configFile.set('state.loginProxyActive', true);
        configData.state.loginProxyActive = true;
        runTimeData.savedConfig.cookieData = undefined;
        runTimeData.authenticated = false;
        configFile.set('state.loginComplete', false);
        configData.state.loginComplete = false;
        configFile.unset('user');
        configFile.unset('password');
        configFile.save();
        startWebServer();
        resolve(true);
    });
};

function startWebServer(checkForCookie = false) {
    const isHeroku = (configData.settings.useHeroku === true || configData.settings.useHeroku === 'true');
    const alexaOptions = {
        debug: (configData.settings.serviceDebug === true),
        trace: (configData.settings.serviceTrace === true),
        checkForCookie: checkForCookie,
        serverPort: configData.settings.serverPort,
        amazonPage: (configData.settings.amazonDomain === 'amazon.co.jp') ? configData.settings.amazonDomain : undefined,
        logger: console.log,
        baseAmazonPage: (configData.settings.amazonDomain === 'amazon.co.jp') ? configData.settings.amazonDomain : undefined,
        // alexaServiceHost: ((configData.settings.amazonDomain === 'amazon.de' || configData.settings.amazonDomain === 'amazon.co.uk') ? 'layla.' : 'pitangui.') + configData.settings.amazonDomain,
        setupProxy: true,
        proxyOwnIp: getIPAddress(),
        proxyListenBind: '0.0.0.0',
        // proxyLogLevel: 'info', // optional: Loglevel of Proxy, default 'warn'
        protocolPrefix: getProtoPrefix(),
        regDataAppName: "Echo Speaks",
        useHeroku: isHeroku,
        proxyHost: configData.settings.hostUrl,
        proxyPort: configData.settings.serverPort,
        proxyRootPath: isHeroku ? '/proxy' : '/proxy',
        acceptLanguage: configData.settings.regionLocale,
        formerRegistrationData: runTimeData.savedConfig.cookieData,
        expressInstance: webApp,
        callbackEndpoint: configData.settings.appCallbackUrl ? String(configData.settings.appCallbackUrl).replace("/receiveData?", "/cookie?") : null
    };

    configFile.set('state.loginProxyActive', true);
    configFile.set('state.loginComplete', false);
    configFile.save();
    configData = configFile.get();
    runTimeData.loginProxyActive = true;
    alexaLogin(undefined, undefined, alexaOptions, async (error, response, config) => {
        runTimeData.alexaUrl = `https://alexa.${configData.settings.amazonDomain}`;
        if (config) {
            runTimeData.savedConfig = config;
        }
        // console.log('error:', error);
        if (response !== undefined && response !== "") {
            logger.debug('Alexa Login Status: ' + response);
        }
        sendServerDataToST();
        // console.log('response: ', response);
        if (response.startsWith('Login Successful') && config.devicesArray) {
            configFile.set('state.loginProxyActive', false);
            configData.state.loginProxyActive = false;
            configFile.set('state.loginComplete', true);
            configData.state.loginComplete = true;
            configFile.save();
            logger.silly('Echo Speaks Alexa API is Actively Running at (IP: ' + getIPAddress() + ' | Port: ' + configData.settings.serverPort + ') | ProcessId: ' + process.pid);
            runTimeData.guardData = await getGuardDataSupport();
        }
    });
}

function sendServerDataToST() {
    let url = configData.settings.appCallbackUrl;
    return new Promise(resolve => {
        if (url) {
            let options = {
                method: 'POST',
                uri: url,
                body: {
                    version: appVer,
                    onHeroku: (configData.settings.useHeroku === true),
                    isLocal: (configData.settings.useHeroku !== true),
                    serverUrl: (configData.settings.useHeroku === true) ? null : `http://${getLocalHost()}`
                },
                json: true
            };
            reqPromise(options)
                .then((resp) => {
                    // console.log('resp:', resp);
                    if (resp) {
                        logger.info(`** ServerVersion Sent to ${configData.settings.hubPlatform} Cloud Endpoint Successfully! **`);
                        resolve(true);
                    } else {
                        resolve(false);
                    }
                })
                .catch((err) => {
                    logger.error(`ERROR: Unable to send Server Version to ${configData.settings.hubPlatform}: ` + err.message);
                    resolve(false);
                });
        }
    });
};

function sendClearAuthToST() {
    let url = (configData.settings.appCallbackUrl ? String(configData.settings.appCallbackUrl).replace("/receiveData?", "/cookie?") : null);
    return new Promise(resolve => {
        if (url) {
            let options = {
                method: 'DELETE',
                uri: url,
                json: true
            };
            reqPromise(options)
                .then((resp) => {
                    // console.log('resp:', resp);
                    if (resp) {
                        logger.info(`** Sent Request to ${configData.settings.hubPlatform} Cloud Endpoint to Remove All Auth Data Successfully! **`);
                        resolve(true);
                    } else {
                        resolve(false);
                    }
                })
                .catch((err) => {
                    logger.error(`ERROR: Unable to send Auth Data Reset to ${configData.settings.hubPlatform}: ` + err.message);
                    resolve(false);
                });
        }
    });
};

function getGuardDataSupport() {
    return new Promise(resolve => {
        if (runTimeData.guardData && Object.keys(runTimeData.guardData)) {
            resolve(runTimeData.guardData);
        }
        // console.log('alexaUrl: ', runTimeData.alexaUrl);
        // console.log('cookieData: ', runTimeData.savedConfig.cookieData);
        if (runTimeData.alexaUrl && runTimeData.savedConfig.cookieData) {
            reqPromise({
                    method: 'GET',
                    uri: `${runTimeData.alexaUrl}/api/phoenix`,
                    query: {
                        'cached': true,
                        '_': new Date().getTime()
                    },
                    headers: {
                        cookie: runTimeData.savedConfig.cookieData.localCookie,
                        csrf: runTimeData.savedConfig.cookieData.csrf
                    },
                    json: true
                })
                .then((resp) => {
                    // console.log('guardresp:', resp);
                    if (resp && resp.networkDetail) {
                        let details = JSON.parse(resp.networkDetail);
                        let locDetails = details.locationDetails.locationDetails.Default_Location.amazonBridgeDetails.amazonBridgeDetails["LambdaBridge_AAA/OnGuardSmartHomeBridgeService"] || undefined;
                        if (locDetails && locDetails.applianceDetails && locDetails.applianceDetails.applianceDetails) {
                            let applKey = Object.keys(locDetails.applianceDetails.applianceDetails).filter(i => {
                                return i.includes("AAA_OnGuardSmartHomeBridgeService_");
                            });
                            if (Object.keys(applKey).length >= 1) {
                                let guardData = locDetails.applianceDetails.applianceDetails[applKey[0]];
                                // console.log('guardData: ', guardData);
                                if (guardData.modelName === "REDROCK_GUARD_PANEL") {
                                    let gData = {
                                        entityId: guardData.entityId,
                                        applianceId: guardData.applianceId,
                                        friendlyName: guardData.friendlyName,
                                        supported: true
                                    };
                                    // console.log(JSON.stringify(gData));
                                    runTimeData.guardData = gData;
                                    resolve(gData);
                                } else {
                                    logger.error("AlexaGuardDataSupport | No Alexa Guard Appliance Data found...");
                                    runTimeData.guardData = undefined;
                                    resolve(undefined);
                                }
                            } else {
                                logger.error("AlexaGuardDataSupport | No Alexa Guard Appliance Data found...");
                                runTimeData.guardData = undefined;
                                resolve(undefined);
                            }
                        } else {
                            logger.error("AlexaGuardDataSupport | No Alexa Guard Appliance Data found...");
                            runTimeData.guardData = undefined;
                            resolve(undefined);
                        }

                    } else {
                        logger.error("AlexaGuardDataSupport | No Alexa Guard Appliance Data found...");
                        runTimeData.guardData = undefined;
                        resolve(undefined);
                    }
                })
                .catch((err) => {
                    logger.error(`ERROR: Unable to send Alexa Guard Data to ${configData.settings.hubPlatform}: ` + err.message);
                    resolve(undefined);
                });
        } else {
            runTimeData.guardData = undefined;
            resolve(undefined);
        }
    });
}

function configCheckOk() {
    return new Promise((resolve) => {
        let res = (((configData.settings.useHeroku === true && !configData.settings.appCallbackUrl) || !configData.settings.amazonDomain || (!configData.settings.useHeroku && !configData.settings.appCallbackUrl)) !== true);
        resolve(res);
    });
};

initConfig()
    .then((res) => {
        if (res) {
            startWebConfig()
                .then(() => {
                    configCheckOk()
                        .then((res) => {
                            if (res === true) {
                                if (configData.state.loginComplete === true || (configData.settings.hostUrl && configData.settings.appCallbackUrl)) {
                                    logger.info('-- Echo Speaks Web Service Starting Up! Takes about 10 seconds before it\'s available... --');
                                    startWebServer((configData.settings.useHeroku === true && configData.settings.appCallbackUrl !== undefined));
                                } else {
                                    logger.info(`** Echo Speaks Web Service is Waiting for Amazon Login to Start... loginComplete: ${configData.state.loginComplete || undefined} | hostUrl: ${configData.settings.hostUrl || undefined} | appCallbackUrl: ${configData.settings.appCallbackUrl} **`);
                                }
                            } else {
                                logger.error('Config Check Did Not Pass');
                            }
                        });
                })
                .catch((err) => {
                    logger.error("## Start Web Config Error: " + err.message);
                });
        }
    })
    .catch((err) => {
        logger.error("## InitConfig Error: " + err.message);
    });


function alexaLogin(username, password, alexaOptions, callback) {
    let config = {};
    config.devicesArray = [];
    config.alexaURL = alexaOptions.amazonPage;

    getRemoteCookie(alexaOptions)
        .then((remoteCookies) => {
            runTimeData.serviceDebug && logger.debug(`remoteCookies: ${JSON.stringify(remoteCookies) || undefined} | keys: ${Object.keys(remoteCookies) || {}}`);
            if (remoteCookies !== undefined && Object.keys(remoteCookies).length > 0 && remoteCookies.cookieData && remoteCookies.cookieData.localCookie && remoteCookies.cookieData.csrf) {
                updSessionItem('cookieData', remoteCookies.cookieData);
                config.cookieData = remoteCookies.cookieData;
                callback(null, `Login Successful (Retreived from ${configData.settings.hubPlatform})`, config);
            } else if (sessionData && sessionData.cookieData && Object.keys(sessionData.cookieData) >= 2) {
                config.cookieData = sessionData.cookieData || {};
                callback(null, 'Login Successful (Stored Session)', config);
            } else {
                alexaCookie.generateAlexaCookie(username, password, alexaOptions, (err, result) => {
                    //   console.log('generateAlexaCookie error: ', err);
                    //   console.log('generateAlexaCookie result: ', result);
                    if (err && (err.message.startsWith('Login unsuccessful') || err.message.startsWith('Amazon-Login-Error:') || err.message.startsWith(' You can try to get the cookie manually by opening'))) {
                        logger.debug('Please complete Amazon login by going here: (http://' + alexaOptions.proxyHost + ':' + alexaOptions.proxyPort + '/config)');
                    } else if (err && !result) {
                        logger.error('generateAlexaCookie: ' + err.message);
                        callback(err, 'There was an error', null);
                    } else if (result) {
                        runTimeData.alexaUrl = 'https://alexa.' + alexaOptions.amazonPage;
                        // IMPORTANT: can be called multiple times!! As soon as a new cookie is fetched or an error happened. Consider that!
                        runTimeData.serviceDebug && logger.debug('cookie: ' + result.localCookie || undefined);
                        runTimeData.serviceDebug && logger.debug('csrf: ' + result.csrf || undefined);

                        if (result && result.csrf && (result.cookie || result.localCookie)) {
                            logger.debug(`result: ${result}`);
                            updSessionItem('cookieData', result);
                            config.cookieData = result;
                            sendCookiesToEndpoint(alexaOptions.callbackEndpoint, result);
                            alexaCookie.stopProxyServer();
                            callback(null, 'Login Successful', config);
                        } else {
                            callback(true, 'There was an error getting authentication', null);
                            if (alexaOptions.callbackEndpoint) {
                                clearSession(alexaOptions.callbackEndpoint);
                            }
                        }
                    }
                });
            }
        });
};

let updSessionItem = (key, value) => {
    if (sessionData[key] === undefined || sessionData[key] !== value) {
        sessionFile.set(key, value);
        sessionFile.save();
    }
    sessionData = sessionFile.get();
};

let remSessionItem = (key) => {
    sessionFile.unset(key);
    sessionFile.save();
    sessionData = sessionFile.get();
};

var clearSession = () => {
    remSessionItem('csrf');
    remSessionItem('cookie');
    remSessionItem('cookieData');
    if (runTimeData.savedConfig.cookieData) delete runTimeData.savedConfig.cookieData;
    sendClearAuthToST();
};

function getRemoteCookie(alexaOptions) {
    console.log('getRemoteCookie...');
    return new Promise(resolve => {
        // if (alexaOptions.checkForCookie === false) {
        //     resolve(undefined);
        // }
        let config = {};
        if (alexaOptions.callbackEndpoint) {
            getCookiesFromEndpoint(alexaOptions.callbackEndpoint)
                .then((data) => {
                    if (data) {
                        updSessionItem('cookieData', data);
                        config.cookieData = data;
                        resolve(config);
                    }
                    resolve(config);
                });
        } else {
            resolve(config);
        }
    });
};

function sendCookiesToEndpoint(url, cookieData) {
    return new Promise(resolve => {
        if (url && cookieData && Object.keys(cookieData).length >= 2) {
            let options = {
                method: 'POST',
                uri: url,
                body: {
                    cookieData: cookieData,
                    version: appVer,
                    onHeroku: (configData.settings.useHeroku === true),
                    isLocal: (configData.settings.useHeroku !== true),
                    serverUrl: (configData.settings.useHeroku === true) ? null : `http://${getLocalHost()}`
                },
                json: true
            };
            reqPromise(options)
                .then((resp) => {
                    // console.log('resp:', resp);
                    if (resp) {
                        logger.info(`** Alexa Cookie Data sent to ${configData.settings.hubPlatform} Cloud Endpoint Successfully! **`);
                        resolve(true);
                    } else {
                        resolve(false);
                    }
                })
                .catch((err) => {
                    logger.error(`ERROR: Unable to send Alexa Cookie Data to ${configData.settings.hubPlatform}: ` + err.message);
                    resolve(false);
                });
        }
    });
};

function isCookieValid(cookieData) {
    return new Promise(resolve => {
        if (!(cookieData && cookieData.loginCookie && cookieData.csrf)) {
            logger.error(`isCookieValid ERROR | Cookie or CSRF value not received!!!`);
            resolve(false);
        }
        reqPromise({
                method: 'GET',
                uri: `https://alexa.${configData.settings.amazonDomain}/api/bootstrap`,
                query: {
                    "version": 0
                },
                headers: {
                    Cookie: cookieData.loginCookie,
                    csrf: cookieData.csrf
                },
                json: true
            })
            .then((resp) => {
                if (resp && resp.authentication) {
                    let valid = (resp.authentication.authenticated !== false);
                    // logger.info(`** Alexa Cookie Valid (${valid}) **`);
                    resolve(valid);
                }
                resolve(true);
            })
            .catch((err) => {
                logger.error(`ERROR: Unable to validate Alexa Cookie Data: ` + err.message);
                resolve(true);
            });
    });
}

function getCookiesFromEndpoint(url) {
    return new Promise(resolve => {
        reqPromise({
                method: 'GET',
                uri: url,
                headers: {
                    serverVersion: appVer,
                    onHeroku: (configData.settings.useHeroku === true),
                    isLocal: (configData.settings.useHeroku !== true),
                },
                json: true
            })
            .then((resp) => {
                // console.log('getCookiesFromEndpoint resp: ', resp);
                if (resp && Object.keys(resp).length >= 2) {
                    logger.info(`** Retrieved Alexa Cookie Data from ${configData.settings.hubPlatform} Cloud Endpoint Successfully! **`);
                    isCookieValid(resp)
                        .then((valid) => {
                            if (valid) {
                                logger.info(`** Alexa Cookie Data Received from ${configData.settings.hubPlatform} Cloud Endpoint has been Confirmed to be Valid! **`);
                                resolve(resp);
                            } else {
                                logger.error(`** ERROR: In an attempt to validate the Alexa Cookie from ${configData.settings.hubPlatform} it was found to be invalid/expired... **`);
                                logger.warn(`** WARNING: We are clearing the Cookie from ${configData.settings.hubPlatform} to prevent further requests and server load... **`);
                                sendClearAuthToST()
                                    .then(() => {
                                        clearAuth()
                                            .then(() => {
                                                resolve(undefined);
                                            });
                                    });
                            }
                        });
                } else {
                    resolve(false);
                }
            })
            .catch((err) => {
                logger.error(`ERROR: Unable to retrieve Alexa Cookie Data from ${configData.settings.hubPlatform}: ` + err.message);
                resolve({});
            });
    });
};

/*******************************************************************************
                            SYSTEM INFO FUNCTIONS
********************************************************************************/

function getIPAddress() {
    let interfaces = os.networkInterfaces();
    for (const devName in interfaces) {
        let iface = interfaces[devName];
        for (var i = 0; i < iface.length; i++) {
            let alias = iface[i];
            if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
                return alias.address;
            }
        }
    }
    return '0.0.0.0';
}

const loginSuccessHtml = () => {
    let html = '';
    let redirUrl = (configData.settings.useHeroku) ? 'https://' + configData.settings.hostUrl + '/config' : 'http://' + getIPAddress() + ':' + configData.settings.serverPort + '/config';
    html += '<!DOCTYPE html>';
    html += '<html>';
    html += '   <head>';
    html += '       <meta name="viewport" content="width=640">';
    html += '       <title>Echo Speaks Amazon Authentication</title>';
    html += '       <style type="text/css">';
    html += '           body { background-color: slategray; text-align: center; }';
    html += '           .container {';
    html += '               width: 90%;';
    html += '               padding: 4%;';
    html += '               text-align: center;';
    html += '               color: white;';
    html += '           }';
    html += '           p {';
    html += '               font-size: 2.2em;';
    html += '               text-align: center;';
    html += '               padding: 0 40px;';
    html += '               margin-bottom: 0;';
    html += '           }';
    html += '       </style>';
    html += '   </head>';
    html += '   <body>';
    html += '       <div class="container">';
    html += '           <h3>Amazon Alexa Cookie Retrieved Successfully</h3>';
    html += '           <h5>You will be redirected back to the config page in 5 seconds.</h5>';
    html += '       </div>';
    html += "       <script>setTimeout( function(){ window.location.href = '" + redirUrl + "'; }, 5000 );</script>";
    html += '   </body>';
    html += '</html>';
    return html;
};

function checkVersion() {
    logger.info("Checking for Server Version Updates...");
    try {
        childProcess.exec(`npm view ${packageFile.name} version`, (error, stdout) => {
            const newVer = stdout && stdout.trim();
            if (newVer && compareVersions(stdout.trim(), packageFile.version) > 0) {
                logger.warn(`---------------------------------------------------------------`);
                logger.warn(`NOTICE: New version of ${packageFile.name} available: ${newVer}`);
                logger.warn(`---------------------------------------------------------------`);
                return {
                    update: true,
                    version: newVer
                };
            } else {
                logger.info(`Server Version is Up-to-Date.`);
                return {
                    update: false,
                    version: undefined
                };
            }
        });
    } catch (e) {
        return {
            update: false,
            version: undefined
        };
    }
}


/*******************************************************************************
                            PROCESS EXIT FUNCTIONS
********************************************************************************/
//so the program will not close instantly
process.stdin.resume();
//do something when app is closing
process.on('exit', exitHandler.bind(null, {
    cleanup: true
}));
//catches ctrl+c event
process.on('SIGINT', exitHandler.bind(null, {
    exit: true
}));
process.on('SIGUSR2', exitHandler.bind(null, {
    exit: true
}));
process.on('SIGHUP', exitHandler.bind(null, {
    exit: true
}));
process.on('SIGTERM', exitHandler.bind(null, {
    exit: true
}));
process.on('uncaughtException', exitHandler.bind(null, {
    exit: true
}));

function exitHandler(options, exitCode) {
    alexaCookie.stopProxyServer();
    if (runTimeData.scheduledUpdatesActive) {
        // stopScheduledDataUpdates();
    }
    if (options.cleanup) {
        console.log('clean');
    }
    if (exitCode || exitCode === 0) {
        console.log(exitCode);
    }
    if (options.exit) {
        process.exit();
    }
    console.log('graceful setting timeout for PID: ' + process.pid);
    setTimeout(() => {
        console.error("Could not close connections in time, forcefully shutting down");
        process.exit(1);
    }, 2 * 1000);
}