"use strict";

const appVer = require('./package.json').version;
const alexaCookie = require('./alexa-cookie/alexa-cookie');
const reqPromise = require("request-promise");
const logger = require('./logger');
const express = require('express');
const bodyParser = require('body-parser');
const os = require('os');
// const alexaCookie = require('./alexa-cookie/alexa-cookie');
const editJsonFile = require("edit-json-file", {
    autosave: true
});
const dataFolder = os.homedir();
const configFile = editJsonFile(dataFolder + '/es_config.json');
const sessionFile = editJsonFile(dataFolder + '/session.json');
const fs = require('fs');
const webApp = express();
const urlencodedParser = bodyParser.urlencoded({
    extended: false
});
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
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

function initConfig() {
    return new Promise(function(resolve, reject) {
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
    configFile.set('settings.hubPlatform', process.env.hubPlatform || 'SmartThings');
    configFile.set('settings.appCallbackUrl', (process.env.appCallbackUrl || configData.settings.appCallbackUrl || (process.env.smartThingsUrl !== null ? process.env.smartThingsUrl : configData.settings.smartThingsUrl)));
    if (process.env.serviceDebug === true || process.env.serviceDebug === 'true') console.log('** SERVICE DEBUG IS ACTIVE **');
    configFile.set('settings.serviceDebug', (process.env.serviceDebug === true || process.env.serviceDebug === 'true'));
    configFile.set('settings.serviceTrace', (process.env.serviceTrace === true || process.env.serviceTrace === 'true'));
    configFile.set('settings.regionLocale', (process.env.regionLocale || (configData.settings.regionLocale || 'en-US'))),
        //     configFile.set('settings.serviceDebug', true);
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

const getLocalHost = function(noPort = false) {
        return `${getIPAddress()}${(noPort || configData.settings.useHeroku) ? '' : `:${configData.settings.serverPort}`}`;
};

const getProtoPrefix = function() {
    return `${configData.settings.useHeroku ? 'https' : 'http'}`;
};

function startWebConfig() {
    return new Promise(function(resolve, reject) {
        try {
            webApp.listen(configData.settings.serverPort, function() {
                logger.info(`** Echo Speaks Config Service (v${appVer}) is Running at (IP: ${getIPAddress()} | Port: ${configData.settings.serverPort}) | ProcessId: ${process.pid} **`);
                logger.info(`** To Signin to Amazon please open your browser to: (${getProtoPrefix()}://${getLocalHost()}) **`);
                logger.info(`** On Heroku: (${configData.settings.useHeroku}) **`);
            });
            //   }
            webApp.use(function(req, res, next) {
                res.header("Access-Control-Allow-Origin", "*");
                res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
                next();
            });

            webApp.get('/', function(req, res) {
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

            webApp.get('/config', function(req, res) {
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
            webApp.get('/manualCookie', function(req, res) {
                logger.debug('/manualCookie page requested');
                res.sendFile(__dirname + '/public/manual_cookie.html');
            });

            webApp.get('/cookieData', function(req, res) {
                // console.log(configData)
                res.send(JSON.stringify(sessionFile.get() || {}));
            });
            webApp.post('/cookieData', function(req, res) {
                let saveFile = false;
                if (req.headers.cookiedata) {
                    let cData = JSON.parse(req.headers.cookiedata);
                    // console.log(cData);
                    sessionFile.set('cookie', cData.cookie);
                    sessionFile.set('csrf', cData.csrf);
                    saveFile = true;
                };
                if (saveFile) {
                    sessionFile.save();
                    sessionData = sessionFile.get();
                    logger.debug('** Cookie Settings File Updated via Manual Entry **');
                    sendCookiesToEndpoint((configData.settings.appCallbackUrl ? String(configData.settings.appCallbackUrl).replace("/receiveData?", "/cookie?") : null), sessionData.cookie, sessionData.csrf)
                        .then(function(sendResp) {
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

            webApp.get('/clearAuth', urlencodedParser, function(req, res) {
                logger.verbose('got request for to clear authentication');
                clearAuth()
                    .then(function() {
                        startWebServer();
                        res.send({
                            result: 'Clear Complete'
                        });
                    });
            });
            webApp.get('/refreshCookie', urlencodedParser, function(req, res) {
                logger.verbose('refreshCookie request received');
                alexaCookie.refreshAlexaCookie({
                    formerRegistrationData: runTimeData.savedConfig.cookieData
                }, (err, result) => {
                    if (result && Object.keys(result).length >= 2) {
                        sendCookiesToEndpoint((configData.settings.appCallbackUrl ? String(configData.settings.appCallbackUrl).replace("/receiveData?", "/cookie?") : null), result);
                        runTimeData.savedConfig.cookieData = result;
                        // console.log('RESULT: ' + err + ' / ' + JSON.stringify(result));
                        res.send({
                            result: result
                        });
                    }
                });
            });
            webApp.get('/configData', function(req, res) {
                // console.log(configData)
                res.send(JSON.stringify(configData));
            });

            webApp.post('/configData', function(req, res) {
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
                if (req.headers.serverport) {
                    configFile.set('settings.serverPort', req.headers.serverport);
                    saveFile = true;
                };
                if (saveFile) {
                    configFile.save();
                    const ls = loadConfig();
                    res.send('done');
                    configCheckOk()
                        .then(function(res) {
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
            webApp.get('/cookie-success', function(req, res) {
                res.send(loginSuccessHtml());
            });
            resolve(true);
        } catch (ex) {
            reject(ex);
        }
    });
}

let clearAuth = function() {
    return new Promise(resolve => {
        logger.verbose('got request for to clear authentication');
        let clearUrl = configData.settings.appCallbackUrl ? String(configData.settings.appCallbackUrl).replace("/receiveData?", "/cookie?") : null;
        clearSession(clearUrl, configData.settings.useHeroku);
        configFile.set('state.loginProxyActive', true);
        configData.state.loginProxyActive = true;
        runTimeData.authenticated = false;
        configFile.set('state.loginComplete', false);
        configData.state.loginComplete = false;
        configFile.unset('user');
        configFile.unset('password');
        configFile.save();
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
        amazonPage: configData.settings.amazonDomain,
        // alexaServiceHost: ((configData.settings.amazonDomain === 'amazon.de' || configData.settings.amazonDomain === 'amazon.co.uk') ? 'layla.' : 'pitangui.') + configData.settings.amazonDomain,
        setupProxy: true,
        proxyOwnIp: getIPAddress(),
        proxyListenBind: '0.0.0.0',
        protocolPrefix: isHeroku ? 'https' : 'http',
        useHeroku: isHeroku,
        proxyHost: configData.settings.hostUrl,
        proxyPort: configData.settings.serverPort,
        proxyRootPath: isHeroku ? '/proxy' : '/proxy',
        acceptLanguage: configData.settings.regionLocale,
        callbackEndpoint: configData.settings.appCallbackUrl ? String(configData.settings.appCallbackUrl).replace("/receiveData?", "/cookie?") : null
    };

    configFile.set('state.loginProxyActive', true);
    configFile.set('state.loginComplete', false);
    configFile.save();
    configData = configFile.get();
    runTimeData.loginProxyActive = true;
    alexaLogin(undefined, undefined, alexaOptions, function(error, response, config) {
        runTimeData.alexaUrl = `https://alexa.${configData.settings.amazonDomain}`;
        runTimeData.savedConfig = config;
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
                    serverUrl: (configData.settings.useHeroku === true) ? null : `http://${getLocalHost()}`
                },
                json: true
            };
            reqPromise(options)
                .then(function(resp) {
                    // console.log('resp:', resp);
                    if (resp) {
                        logger.info(`** ServerVersion Sent to ${configData.settings.hubPlatform} Cloud Endpoint Successfully! **`);
                        resolve(true);
                    } else {
                        resolve(false);
                    }
                })
                .catch(function(err) {
                    logger.error(`ERROR: Unable to send Server Version to ${configData.settings.hubPlatform}: ` + err.message);
                    resolve(false);
                });
        }
    });
};

function configCheckOk() {
    return new Promise(function(resolve) {
        let res = (((configData.settings.useHeroku === true && !configData.settings.appCallbackUrl) || !configData.settings.amazonDomain || (!configData.settings.useHeroku && !configData.settings.appCallbackUrl)) !== true);
        resolve(res);
    });
};

initConfig()
    .then(function(res) {
        if (res) {
            startWebConfig()
                .then(function() {
                    configCheckOk()
                        .then(function(res) {
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
                .catch(function(err) {
                    logger.error("## Start Web Config Error: " + err.message);
                });
        }
    })
    .catch(function(err) {
        logger.error("## InitConfig Error: " + err.message);
    });


function alexaLogin(username, password, alexaOptions, callback) {
    let config = {};
    config.devicesArray = [];
    config.alexaURL = alexaOptions.amazonPage;

    getRemoteCookie(alexaOptions)
        .then(function(remoteCookies) {
            // console.log('remoteCookies: ', remoteCookies || undefined, 'keys: ', Object.keys(remoteCookies) || {});
            if (remoteCookies !== undefined && Object.keys(remoteCookies).length > 0 && remoteCookies.cookieData && remoteCookies.cookieData.localCookie && remoteCookies.cookieData.csrf) {
                updSessionItem('cookieData', remoteCookies.cookieData);
                config.cookieData = remoteCookies.cookieData;
                callback(null, `Login Successful (Retreived from ${configData.settings.hubPlatform})`, config);
            } else if (sessionData && sessionData.cookieData && Object.keys(sessionData.cookieData) >= 2) {
                config.cookieData = sessionData.cookieData || {};
                callback(null, 'Login Successful (Stored Session)', config);
            } else {
                alexaCookie.generateAlexaCookie(username, password, alexaOptions, webApp, (err, result) => {
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
                            console.log('result: ', result);
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
    sessionFile.unset('csrf');
    sessionFile.save();
    sessionData = sessionFile.get();
};

var clearSession = function(url) {
    remSessionItem('csrf');
    remSessionItem('cookie');
    remSessionItem('cookieData');
    delete runTimeData.savedConfig.cookieData;
    if (url) {
        let options = {
            method: 'DELETE',
            uri: url,
            json: true
        };
        reqPromise(options)
            .then(function(resp) {
                // console.log('resp:', resp);
                if (resp) {
                    logger.info(`** Sent Remove Alexa Cookie Data Request to ${configData.settings.hubPlatform} Successfully! **`);
                }
            })
            .catch(function(err) {
                logger.error(`ERROR: Unable to send Alexa Cookie Data to ${configData.settings.hubPlatform}: ` + err.message);
            });
    }
};

function getRemoteCookie(alexaOptions) {
    return new Promise(resolve => {
        if (alexaOptions.checkForCookie === false) {
            resolve(undefined);
        }
        let config = {};
        if (alexaOptions.callbackEndpoint) {
            getCookiesFromEndpoint(alexaOptions.callbackEndpoint)
                .then(function(data) {
                    if (data) {
                        updSessionItem('cookieData', data);
                        config.cookieData = data;
                        resolve(config);
                    }
                });
        } else {
            resolve(config);
        }
    });
};

function sendCookiesToEndpoint(url, cookieData) {
    return new Promise(resolve => {
        if (url && cookieData) {
            let options = {
                method: 'POST',
                uri: url,
                body: {
                    cookieData: cookieData,
                    version: appVer,
                    onHeroku: (configData.settings.useHeroku === true),
                    serverUrl: (configData.settings.useHeroku === true) ? null : `http://${getLocalHost()}`
                },
                json: true
            };
            reqPromise(options)
                .then(function(resp) {
                    // console.log('resp:', resp);
                    if (resp) {
                        logger.info(`** Alexa Cookie Data sent to ${configData.settings.hubPlatform} Cloud Endpoint Successfully! **`);
                        resolve(true);
                    } else {
                        resolve(false);
                    }
                })
                .catch(function(err) {
                    logger.error(`ERROR: Unable to send Alexa Cookie Data to ${configData.settings.hubPlatform}: ` + err.message);
                    resolve(false);
                });
        }
    });
};

function getCookiesFromEndpoint(url) {
    return new Promise(resolve => {
        reqPromise({
                method: 'GET',
                uri: url,
                headers: {
                    serverVersion: appVer
                },
                json: true
            })
            .then(function(resp) {
                // console.log('getCookiesFromEndpoint resp: ', resp);
                if (resp && Object.keys(resp).length >= 2)
                    logger.info(`** Retrieved Alexa Cookie Data from ${configData.settings.hubPlatform} Cloud Endpoint Successfully! **`);
                resolve(resp);
            })
            .catch(function(err) {
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

function getServiceUptime() {
    let now = Date.now();
    let diff = (now - runTimeData.serviceStartTime) / 1000;
    //logger.debug("diff: "+ diff);
    return getHostUptimeStr(diff);
}

function getHostUptimeStr(time) {
    let years = Math.floor(time / 31536000);
    time -= years * 31536000;
    let months = Math.floor(time / 31536000);
    time -= months * 2592000;
    let days = Math.floor(time / 86400);
    time -= days * 86400;
    let hours = Math.floor(time / 3600);
    time -= hours * 3600;
    let minutes = Math.floor(time / 60);
    time -= minutes * 60;
    let seconds = parseInt(time % 60, 10);
    return {
        'y': years,
        'mn': months,
        'd': days,
        'h': hours,
        'm': minutes,
        's': seconds
    };
}

const loginSuccessHtml = function() {
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
    setTimeout(function() {
        console.error("Could not close connections in time, forcefully shutting down");
        process.exit(1);
    }, 2 * 1000);
}