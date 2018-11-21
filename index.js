"use strict";

const appVer = require('./package.json').version;
const alexa_api = require('./alexa-api');
const reqPromise = require("request-promise");
const logger = require('./logger');
const express = require('express');
// const gson = require('gson');
// const io = socketIO(express);
const bodyParser = require('body-parser');
const os = require('os');
// const alexaCookie = require('./alexa-cookie/alexa-cookie');
const editJsonFile = require("edit-json-file", {
    autosave: true
});
const dataFolder = os.homedir() + '/.echo-speaks';
const configFile = editJsonFile(dataFolder + '/es_config.json');
const sessionFile = editJsonFile(dataFolder + '/session.json');
const fs = require('fs');
const webApp = express();
const urlencodedParser = bodyParser.urlencoded({
    extended: false
});
// process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// These the config variables
let configData = {};
let sessionData = sessionFile.get() || {};
let runTimeData = {};
runTimeData.savedConfig = {};
runTimeData.scheduledUpdatesActive = false;
runTimeData.alexaUrl = 'https://alexa.amazon.com';
runTimeData.loginProxyActive = false;
runTimeData.ignoredDevices = {};
runTimeData.authenticated = false;
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
    if (process.env.hostUrl) { configFile.set('settings.hostUrl', process.env.hostUrl); }
    configFile.set('settings.useHeroku', (process.env.useHeroku === true || process.env.useHeroku === 'true'));
    configFile.set('settings.amazonDomain', process.env.amazonDomain || (configData.settings.amazonDomain || 'amazon.com'));
    configFile.set('settings.smartThingsUrl', process.env.smartThingsUrl || configData.settings.smartThingsUrl);
    if (process.env.serviceDebug === true || process.env.serviceDebug === 'true') console.log('** SERVICE DEBUG IS ACTIVE **');
    configFile.set('settings.serviceDebug', (process.env.serviceDebug === true || process.env.serviceDebug === 'true'));
    configFile.set('settings.serviceTrace', (process.env.serviceTrace === true || process.env.serviceTrace === 'true'));
    // configFile.set('settings.serviceDebug', true);
    // configFile.set('settings.serviceTrace', true);
    configFile.set('settings.serverPort', process.env.PORT || (configData.settings.serverPort || 8091));
    configFile.set('settings.refreshSeconds', process.env.refreshSeconds ? parseInt(process.env.refreshSeconds) : (configData.settings.refreshSeconds || 60));
    if (!configData.state) {
        configData.state = {};
    }
    configFile.set('state.scriptVersion', appVer);
    configFile.save();
    configData = configFile.get();
    return true;
}

function startWebConfig() {
    return new Promise(function(resolve, reject) {
        try {
            webApp.listen(configData.settings.serverPort, function() {
                logger.info('** Echo Speaks Config Service (v' + appVer + ') is Running at (IP: ' + getIPAddress() + ' | Port: ' + configData.settings.serverPort + ') | ProcessId: ' + process.pid + ' **');
            });
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
                // console.log(req.headers);
                if (req.headers.cookiestr) {
                    console.log(req.headers.cookiestr);
                    sessionFile.set('cookie', req.headers.cookiestr);
                    saveFile = true;
                };
                if (req.headers.csrfstr) {
                    console.log(req.headers.csrfstr);
                    sessionFile.set('csrf', req.headers.csrfstr);
                    saveFile = true;
                };
                if (saveFile) {
                    sessionFile.save();
                    sessionFile.get();
                    logger.debug('** Cookie Settings File Updated via Manual Entry **');
                    if (process.env.useHeroku === true) {
                        let sendCookie = alexa_api.sendCookiesToST(configData.settings.smartThingsUrl, sessionFile.cookie, sessionFile.csrf);
                        if (sendCookie) {
                            startWebServer();
                            res.send('done');
                        } else {
                            res.send('failed');
                        };
                    } else {
                        startWebServer();
                        res.send('done');
                    }
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
                if (req.headers.smartthingshubip) {
                    configFile.set('settings.smartThingsHubIP', req.headers.smartthingshubip);
                    saveFile = true;
                };
                if (req.headers.smartthingsurl) {
                    configFile.set('settings.smartThingsUrl', req.headers.smartthingsurl);
                    saveFile = true;
                };
                if (req.headers.smartthingstoken) {
                    configFile.set('settings.smartThingsToken', req.headers.smartthingstoken);
                    saveFile = true;
                };
                if (req.headers.amazondomain) {
                    configFile.set('settings.amazonDomain', req.headers.amazondomain);
                    saveFile = true;
                };
                if (req.headers.refreshseconds) {
                    configFile.set('settings.refreshSeconds', parseInt(req.headers.refreshseconds));
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
        let clearUrl = configData.settings.smartThingsUrl ? String(configData.settings.smartThingsUrl).replace("/receiveData?", "/cookie?") : null;
        alexa_api.clearSession(clearUrl, configData.settings.useHeroku);
        configFile.set('state.loginProxyActive', true);
        configData.state.loginProxyActive = true;
        configFile.set('state.loginComplete', false);
        configData.state.loginComplete = false;
        configFile.unset('user');
        configFile.unset('password');
        configFile.save();
        // if (runTimeData.scheduledUpdatesActive) {
        stopScheduledDataUpdates();
        // }
        resolve(true);
    });

};

function startWebServer(checkForCookie = false) {
    const alexaOptions = {
        debug: (configData.settings.serviceDebug === true),
        trace: (configData.settings.serviceTrace === true),
        checkForCookie: checkForCookie,
        serverPort: configData.settings.serverPort,
        amazonDomain: configData.settings.amazonDomain,
        alexaServiceHost: ((configData.settings.amazonDomain === 'amazon.de' || configData.settings.amazonDomain === 'amazon.co.uk') ? 'layla.' : 'pitangui.') + configData.settings.amazonDomain,
        setupProxy: true,
        proxyOwnIp: getIPAddress(),
        proxyListenBind: '0.0.0.0',
        useHeroku: (configData.settings.useHeroku === true || configData.settings.useHeroku === 'true'),
        proxyHost: configData.settings.hostUrl,
        stEndpoint: configData.settings.smartThingsUrl ? String(configData.settings.smartThingsUrl).replace("/receiveData?", "/cookie?") : null
    };

    configFile.set('state.loginProxyActive', true);
    configFile.set('state.loginComplete', false);
    configFile.save();
    configData = configFile.get();
    runTimeData.loginProxyActive = true;
    alexa_api.alexaLogin(configData.settings.user, configData.settings.password, alexaOptions, webApp, function(error, response, config) {
        runTimeData.alexaUrl = `https://alexa.${configData.settings.amazonDomain}`;
        runTimeData.savedConfig = config;
        // console.log('error:', error);
        if (response !== undefined && response !== "") {
            logger.debug('Alexa Login Status: ' + response);
        }
        // console.log('config: ', config);
        if (response.startsWith('Login Successful') && config.devicesArray) {
            configFile.set('state.loginProxyActive', false);
            configData.state.loginProxyActive = false;
            configFile.set('state.loginComplete', true);
            configData.state.loginComplete = true;
            configFile.save();
            authenticationCheck()
                .then(function(authResp) {
                    if (authResp === true) {
                        buildEchoDeviceMap()
                            .then(function(devOk) {
                                logger.silly('Echo Speaks Alexa API is Actively Running at (IP: ' + getIPAddress() + ' | Port: ' + configData.settings.serverPort + ') | ProcessId: ' + process.pid);

                                webApp.get('/heartbeat', urlencodedParser, function(req, res) {
                                    let clientVer = req.headers.appversion;
                                    authenticationCheck()
                                        .then(function() {
                                            logger.verbose('++ Received a Heartbeat Request...' + (clientVer ? ' | Client Version: (v' + clientVer + ')' : '') + ' ++');
                                            res.send({
                                                result: "i am alive",
                                                authenticated: runTimeData.authenticated,
                                                version: appVer
                                            });
                                        });
                                });

                                webApp.get('/checkAuth', urlencodedParser, function(req, res) {
                                    console.log('received checkAuth request');
                                    alexa_api.checkAuthentication(runTimeData.savedConfig, function(error, response) {
                                        res.send(response);
                                    });
                                });

                                webApp.get('/getDevices', urlencodedParser, function(req, res) {
                                    logger.verbose('++ Received a getDevices Request... ++');
                                    // alexa_api.getDevices(runTimeData.savedConfig, function(error, response) {

                                    buildEchoDeviceMap()
                                        .then(function(eDevices) {
                                            res.send(eDevices);
                                        })
                                        .catch(function(err) {
                                            res.send(null);
                                        });
                                    // });
                                });

                                webApp.get('/getPlaylists', urlencodedParser, function(req, res) {
                                    let device = {};
                                    device.serialNumber = req.query.serialNumber || '';
                                    device.deviceType = req.query.deviceType || '';
                                    device.deviceOwnerCustomerId = req.query.customerId || '';
                                    console.log(`received getPlaylists request | query: ${device}`);
                                    alexa_api.getPlaylists(device, runTimeData.savedConfig, function(error, response) {
                                        res.send(response);
                                    });
                                });

                                webApp.get('/skippedDevices', urlencodedParser, function(req, res) {
                                    console.log(`received skippedDevices request`);
                                    let obj = runTimeData.ignoredDevices;
                                    let ignKeys = [
                                        'appDeviceList', 'charging', 'clusterMembers', 'essid', 'macAddress', 'parentClusters', 'deviceTypeFriendlyName', 'registrationId',
                                        'remainingBatteryLevel', 'postalCode', 'language', 'serialNumber', 'online', 'deviceOwnerCustomerId', 'softwareVersion', 'deviceAccountId'
                                    ];
                                    for (const i in obj) {
                                        Object.keys(obj[i]).forEach((key) => !ignKeys.includes(key) || delete obj[i][key]);
                                    }
                                    res.send(JSON.stringify(obj));
                                });

                                webApp.get('/getNotifications', urlencodedParser, function(req, res) {
                                    console.log(`received getNotifications request`);
                                    alexa_api.getNotifications(runTimeData.savedConfig, function(error, response) {
                                        res.send(response);
                                    });
                                });

                                webApp.get('/musicProviders', urlencodedParser, function(req, res) {
                                    console.log('received musicProviders request');
                                    alexa_api.getMusicProviders(runTimeData.savedConfig, function(error, response) {
                                        res.send(response);
                                    });
                                });

                                webApp.get('/devicePreferences', urlencodedParser, function(req, res) {
                                    console.log('received devicePreferences request');
                                    alexa_api.getDevicePreferences(false, runTimeData.savedConfig, function(error, response) {
                                        res.send(response);
                                    });
                                });

                                webApp.get('/getRoutines', urlencodedParser, function(req, res) {
                                    console.log('received getRoutines request');
                                    alexa_api.getAutomationRoutines(undefined, runTimeData.savedConfig, function(error, response) {
                                        res.send(response);
                                    });
                                });

                                webApp.get('/getAccount', urlencodedParser, function(req, res) {
                                    console.log('received getAccount request');
                                    alexa_api.getAccount(runTimeData.savedConfig, function(error, response) {
                                        res.send(response);
                                    });
                                });

                                webApp.get('/tuneInSearch', urlencodedParser, function(req, res) {
                                    let query = req.query.search || '';
                                    console.log(`received tuneInSearch request | query: ${query}`);
                                    alexa_api.tuneinSearch(query, runTimeData.savedConfig, function(error, response) {
                                        res.send(JSON.stringify(response, undefined, 4));
                                    });
                                });

                                webApp.get('/getDeviceLists', urlencodedParser, function(req, res) {
                                    let serialNumber = req.headers.deviceserialnumber;
                                    let deviceType = req.headers.devicetype;
                                    let listOpts = req.headers.listOption || {};
                                    console.log('received getDeviceLists request');
                                    alexa_api.getLists({
                                        deviceSerialNumber: serialNumber,
                                        deviceType: deviceType
                                    }, listOpts, runTimeData.savedConfig, function(error, response) {
                                        res.send(response);
                                    });
                                });

                                webApp.post('/alexa-command', urlencodedParser, function(req, res) {
                                    // console.log('command headers: ', req.headers);
                                    let hubAct = (req.headers.deviceserialnumber !== undefined && !configData.settings.useHeroku);
                                    let serialNumber = req.headers.deviceserialnumber;
                                    let deviceType = req.headers.devicetype;
                                    let deviceOwnerCustomerId = req.headers.deviceownercustomerid;
                                    let cmdType = req.headers.cmdtype;
                                    let cmdValues = (req.headers.cmdvalobj && req.headers.cmdvalobj.length) ? JSON.parse(req.headers.cmdvalobj) : {};
                                    let message = (req.headers.message) || "";

                                    let cmdOpts = {
                                        headers: {
                                            'Cookie': runTimeData.savedConfig.cookies,
                                            'csrf': runTimeData.savedConfig.csrf
                                        },
                                        json: {}
                                    };
                                    cmdOpts.deviceId = req.headers.deviceid || undefined;
                                    cmdOpts.queueKey = req.headers.queuekey || undefined;
                                    cmdOpts.msgDelay = req.headers.msgdelay || undefined;
                                    cmdOpts.cmdDesc = req.headers.cmddesc || undefined;
                                    switch (cmdType) {
                                        case 'SetDnd':
                                        case 'SetDoNotDisturbOn':
                                        case 'SetDoNotDisturbOff':
                                            cmdOpts.method = 'PUT';
                                            cmdOpts.url = `${runTimeData.alexaUrl}/api/dnd/status`;
                                            cmdOpts.json = {
                                                deviceSerialNumber: serialNumber,
                                                deviceType: deviceType
                                            };
                                            break;
                                        case 'AlarmVolume':
                                            cmdOpts.method = 'PUT';
                                            let device = {
                                                serialNumber: req.headers.deviceserialnumber,
                                                deviceType: req.headers.devicetype,
                                                softwareVersion: req.headers.softwareversion,
                                                volumeLevel: req.headers.volumeLevel
                                            };
                                            cmdOpts.url = `${runTimeData.alexaUrl}/api/device-notification-state/${device.deviceType}/${device.softwareVersion}/${device.serialNumber}`;
                                            cmdOpts.json = device;
                                            break;
                                        case 'ExecuteSequence':
                                            let seqCmdKey = req.headers.seqcmdkey || undefined;
                                            let seqCmdVal = req.headers.seqcmdval || undefined;
                                            cmdOpts.method = 'POST';
                                            cmdOpts.url = `${runTimeData.alexaUrl}/api/behaviors/preview`;
                                            cmdOpts.json = alexa_api.sequenceJsonBuilder(serialNumber, deviceType, deviceOwnerCustomerId, seqCmdKey, seqCmdVal);
                                            break;
                                        default:
                                            cmdOpts.method = 'POST';
                                            cmdOpts.url = `${runTimeData.alexaUrl}/api/np/command`;
                                            cmdOpts.qs = {
                                                deviceSerialNumber: serialNumber,
                                                deviceType: deviceType
                                            };
                                            cmdOpts.json = {
                                                type: cmdType
                                            };
                                            break;
                                    }
                                    if (Object.keys(cmdValues).length) {
                                        for (const key in cmdValues) {
                                            cmdOpts.json[key] = cmdValues[key];
                                        }
                                    }
                                    if (serialNumber) {
                                        logger.debug('++ Received an Execute Command Request for Device: ' + serialNumber + ' | CmdType: ' + cmdType + ' | CmdValObj: ' + JSON.stringify(cmdValues) + (hubAct && !configData.settings.useHeroku ? ' | Source: (ST HubAction)' : (configData.settings.useHeroku ? ' | Source: (ST C2C)' : '')) + ' ++');
                                        alexa_api.executeCommand(cmdOpts, function(error, response) {
                                            res.send(response);
                                        });
                                    } else {
                                        res.send('failed');
                                    }
                                });

                                webApp.post('/createNotification', urlencodedParser, function(req, res) {
                                    let params = {};
                                    let device = runTimeData.echoDevices[req.query.serialNumber];
                                    // if (!device) { res.send("device not found"); return;}
                                    let type = req.query.type;
                                    params.serialNumber = req.query.serialNumber || '';
                                    params.deviceType = req.query.deviceType || '';
                                    params.label = req.query.label || '';
                                    params.time = req.query.time || '';
                                    params.date = req.query.date || '';
                                    params.timerDuration = req.query.timerDuration || null;
                                    console.log(`received createNotification($type) request | query: ${params}`);
                                    alexa_api.createNotification(type, params, runTimeData.savedConfig, function(error, response) {
                                        res.send(response);
                                    });
                                });

                                webApp.post('/removeNotification', urlencodedParser, function(req, res) {
                                    let params = {};
                                    params.id = req.query.id || '';
                                    console.log(`received removeNotification request | query: ${params}`);
                                    alexa_api.deleteNotification(params, runTimeData.savedConfig, function(error, response) {
                                        res.send(response);
                                    });
                                });

                                webApp.post('/musicSearch', urlencodedParser, function(req, res) {
                                    // console.log('command headers: ', req.headers);
                                    let hubAct = (req.headers.deviceserialnumber !== undefined && !configData.settings.useHeroku);
                                    let serialNumber = req.headers.deviceserialnumber;
                                    let deviceType = req.headers.devicetype;
                                    let deviceOwnerCustomerId = req.headers.deviceownercustomerid;
                                    let searchPhrase = req.headers.searchphrase || undefined;
                                    let providerId = req.headers.providerid || undefined;
                                    let options = {
                                        deviceSerialNumber: serialNumber,
                                        deviceType: deviceType,
                                        deviceOwnerCustomerId: deviceOwnerCustomerId,
                                        locale: 'en-US',
                                        searchPhrase: searchPhrase,
                                        providerId: providerId
                                    };
                                    if (serialNumber) {
                                        logger.debug('++ Received an Music Search Play Request for Device: ' + serialNumber + ' | Search Phrase: ' + searchPhrase + ' | MusicProviderId: ' + providerId + (hubAct && !configData.settings.useHeroku ? ' | Source: (ST HubAction)' : (configData.settings.useHeroku ? ' | Source: (ST C2C)' : '')) + ' ++');
                                        alexa_api.playMusicProvider(options, runTimeData.savedConfig, (error, response) => {
                                            res.send(response);
                                        });
                                    } else {
                                        res.send('failed');
                                    }
                                });

                                webApp.put('/setDeviceName', urlencodedParser, function(req, res) {
                                    let newName = req.query.name;
                                    let device = runTimeData.echoDevices[req.query.serialNumber];
                                    if (!device) { res.send("device not found"); return; }
                                    console.log(`received setDeviceName request | query: ${req.query}`);
                                    alexa_api.setDeviceName(newName, device, runTimeData.savedConfig, function(error, response) {
                                        res.send(response);
                                    });
                                });

                                webApp.put('/setWakeWord', urlencodedParser, function(req, res) {
                                    let oldWord = req.query.oldWord;
                                    let newWord = req.query.newWord;
                                    let device = runTimeData.echoDevices[req.query.serialNumber];
                                    if (!device) { res.send("device not found"); return; }
                                    console.log(`received setWakeWord request | query: ${req.query}`);
                                    alexa_api.setWakeWord(oldWord, newWord, device, runTimeData.savedConfig, function(error, response) {
                                        res.send(response);
                                    });
                                });

                                //Returns Status of Service
                                webApp.post('/sendStatusUpdate', urlencodedParser, function(req, res) {
                                    logger.verbose('++ SmartThings is Requesting Device Data Update... | PID: ' + process.pid + ' ++');
                                    res.send(0);
                                    sendStatusUpdateToST(alexa_api);
                                });

                                webApp.post('/updateSettings', function(req, res) {
                                    logger.verbose('** Settings Update Received from SmartThings **');
                                    if (req.headers.refreshseconds !== undefined && parseInt(req.headers.refreshseconds) !== configData.settings.refreshSeconds) {
                                        logger.debug('++ Changed Setting (refreshSeconds) | New Value: (' + req.headers.refreshseconds + ') | Old Value: (' + configData.settings.refreshSeconds + ') ++');
                                        configData.settings.refreshSeconds = parseInt(req.headers.refreshseconds);
                                        configFile.set('settings.refreshSeconds', parseInt(req.headers.refreshseconds));
                                        stopScheduledDataUpdates();
                                        logger.debug("** Device Data Refresh Schedule Changed to Every (" + configData.settings.refreshSeconds + ' sec) **');
                                        setInterval(scheduledDataUpdates, configData.settings.refreshSeconds * 1000);
                                    }
                                    if (req.headers.smartthingshubip !== undefined && req.headers.smartthingshubip !== configData.settings.smartThingsHubIP) {
                                        logger.debug('++ Changed Setting (smartThingsHubIP) | New Value: (' + req.headers.smartthingshubip + ') | Old Value: (' + configData.settings.smartThingsHubIP + ') ++');
                                        configFile.set('settings.smartThingsHubIP', req.headers.smartthingshubip);
                                        configData.settings.smartThingsHubIP = req.headers.smartthingshubip;
                                    }
                                    configFile.save();
                                });

                                if (Object.keys(runTimeData.echoDevices).length > 0) { sendDeviceDataToST(runTimeData.echoDevices); }
                                logger.debug("** Device Data Refresh Scheduled for Every (" + configData.settings.refreshSeconds + ' sec) **');
                                setInterval(scheduledDataUpdates, configData.settings.refreshSeconds * 1000);
                                runTimeData.scheduledUpdatesActive = true;
                            })
                            .catch(function(err) {
                                console.log(err);
                            });
                    } else {
                        logger.debug(`** Amazon Cookie is no longer valid!!! Please login again using the config page. ${error.message}**`);
                    }
                });
        }
    });
}

const findDevice = async(serialNum) => {
    let dev = runTimeData.echoDevices[serialNum];
    if (dev) {
        return dev;
    } else { return null; }
};

function getDeviceStateInfo(device) {
    return new Promise(resolve => {
        alexa_api.getState(device, runTimeData.savedConfig, function(err, resp) {
            resolve(resp.playerInfo || {});
        });
    });
}

function getPlaylistInfo(device) {
    return new Promise(resolve => {
        alexa_api.getPlaylists(device, runTimeData.savedConfig, function(err, resp) {
            resolve(resp.playlists || {});
        });
    });
}

function getDeviceDndInfo() {
    return new Promise(resolve => {
        alexa_api.getDndStatus(runTimeData.savedConfig, function(err, resp) {
            resolve(resp || []);
        });
    });
}

function getWakeWordsInfo(device) {
    return new Promise(resolve => {
        alexa_api.getAvailWakeWords(device, runTimeData.savedConfig, function(err, resp) {
            resolve(resp.wakeWords || []);
        });
    });
}

function getWakeWordInfo() {
    return new Promise(resolve => {
        alexa_api.getWakeWords(runTimeData.savedConfig, function(err, resp) {
            resolve(resp.wakeWords || []);
        });
    });
}

function getMusicProviderInfo() {
    return new Promise(resolve => {
        alexa_api.getMusicProviders(runTimeData.savedConfig, function(err, resp) {
            let items = {};
            if (resp && resp !== undefined) {
                resp.filter((item) => item.availability === 'AVAILABLE').forEach((item) => {
                    items[item.id] = item.displayName;
                });
            }
            resolve(items || {});
        });
    });
}

// function getRoutinesInfo() {
//     return new Promise(resolve => {
//         alexa_api.getAutomationRoutines(undefined, runTimeData.savedConfig, function(err, resp) {

//             let items = {};
//             resp.filter((item) => item.status === 'ENABLED').forEach((item) => {
//                 items[item.id] = {
//                     item.displayName;

//                 }

//             });
//             resolve(items || {});
//         });
//     });
// }

function getAlarmVolume(device) {
    return new Promise(resolve => {
        alexa_api.getAlarmVolume(device, runTimeData.savedConfig, function(err, resp) {
            resolve(resp.alarmVolume || null);
        });
    });
}

function getNotificationInfo() {
    return new Promise(resolve => {
        alexa_api.getNotifications(runTimeData.savedConfig, function(err, resp) {
            let items = resp && resp.notifications ? resp.notifications.filter((item) => item.status === 'ON') : [];
            let keys2Keep = ['id', 'reminderLabel', 'originalDate', 'originalTime', 'deviceSerialNumber', 'type', 'remainingDuration'];
            for (const i in items) {
                Object.keys(items[i]).forEach((key) => keys2Keep.includes(key) || delete items[i][key]);
            }
            resolve(items || []);
        });
    });
}

function authenticationCheck() {
    return new Promise((resolve) => {
        logger.debug('** Checking if Amazon Cookie is Still Valid. **');
        alexa_api.checkAuthentication(runTimeData.savedConfig, function(error, resp) {
            logger.debug(`** Authentication Check Response | Authenticated: ${resp.result || undefined} **`);
            if (resp && resp.result && resp.result !== undefined) {
                runTimeData.authenticated = (resp.result !== false);
                if (!runTimeData.authenticated) {
                    clearAuth()
                        .then(function() {
                            logger.debug('** Amazon Cookie is no longer valid!!! Please login again using the config page. **');
                            handleDataUpload([], 'checkAuthentication');
                            startWebServer();
                        });
                }
                resolve(runTimeData.authenticated);
            } else {
                // Unless explicitly told that we are not authenticate we return true
                resolve(runTimeData.authenticated);
            }
        });
    });
}

//

async function buildEchoDeviceMap() {
    try {
        let eDevData = await alexa_api.getDevices(runTimeData.savedConfig)
            .catch(function(err) {
                if (err.message === '401 - undefined') {
                    logger.error("ERROR: Unable to getDevices() to buildEchoDeviceMap because you are not authenticated: " + err.message);
                    clearAuth()
                        .then(function() {
                            logger.debug('** Amazon Cookie is no longer valid!!! Please login again using the config page. **');
                            handleDataUpload([], 'checkAuthentication');
                            startWebServer();
                        });
                    return {};
                } else {
                    logger.error("ERROR: Unable to getDevices() to buildEchoDeviceMap: " + err.message);
                    return runTimeData.echoDevices;
                }
            });
        if (!Object.keys(eDevData).length > 0) { return {}; }
        let ignoreTypes = ['A1DL2DVDQVK3Q', 'A21Z3CGI8UIP0F', 'A2825NDLA7WDZV', 'A2IVLV5VM2W81', 'A2TF17PFR55MTB', 'A1X7HJX9QL16M5', 'A2T0P32DY3F7VB', 'A3H674413M2EKB', 'AILBSA2LNTOYL', 'A38BPK7OW001EX'];
        let removeKeys = ['appDeviceList', 'charging', 'macAddress', 'deviceTypeFriendlyName', 'registrationId', 'remainingBatteryLevel', 'postalCode', 'language'];
        let wakeWords = await getWakeWordInfo();
        let dndStates = await getDeviceDndInfo();
        let musicProvs = await getMusicProviderInfo();
        let notifs = await getNotificationInfo();

        for (const dev in eDevData) {
            let devSerialNumber = eDevData[dev].serialNumber;
            // if (eDevData[dev].deviceFamily === 'ECHO' || eDevData[dev].deviceFamily === 'KNIGHT' || eDevData[dev].deviceFamily === 'ROOK' || eDevData[dev].deviceFamily === 'TABLET' || eDevData[dev].deviceFamily === 'WHA') {
            if (!ignoreTypes.includes(eDevData[dev].deviceType) && !eDevData[dev].accountName.includes('Alexa App')) {
                for (const item in removeKeys) {
                    delete eDevData[dev][removeKeys[item]];
                }
                if (eDevData[dev].deviceOwnerCustomerId !== undefined) {
                    runTimeData.savedConfig.deviceOwnerCustomerId = eDevData[dev].deviceOwnerCustomerId;
                }
                runTimeData.echoDevices[devSerialNumber] = eDevData[dev];
                let devState = await getDeviceStateInfo(eDevData[dev]);
                runTimeData.echoDevices[devSerialNumber].playerState = devState;
                let playlist = await getPlaylistInfo(eDevData[dev]);
                runTimeData.echoDevices[devSerialNumber].playlists = playlist;
                runTimeData.echoDevices[devSerialNumber].musicProviders = musicProvs;
                let wakeWord = wakeWords.filter((item) => item.deviceSerialNumber === devSerialNumber).shift();
                runTimeData.echoDevices[devSerialNumber].wakeWord = wakeWord ? wakeWord.wakeWord : "";
                let alarmVolume = await getAlarmVolume(eDevData[dev]);
                runTimeData.echoDevices[devSerialNumber].alarmVolume = alarmVolume || null;
                let availWakeWords = await getWakeWordsInfo(eDevData[dev]);
                runTimeData.echoDevices[devSerialNumber].wakeWords = availWakeWords || [];
                let dnd = dndStates.filter((item) => item.deviceSerialNumber === devSerialNumber).shift();

                runTimeData.echoDevices[devSerialNumber].dndEnabled = dnd ? dnd.enabled : false;
                runTimeData.echoDevices[devSerialNumber].canPlayMusic = (eDevData[dev].capabilities.includes('AUDIO_PLAYER') || eDevData[dev].capabilities.includes('AMAZON_MUSIC') || eDevData[dev].capabilities.includes('TUNE_IN') || eDevData[dev].capabilities.includes('PANDORA') || eDevData[dev].capabilities.includes('I_HEART_RADIO') || eDevData[dev].capabilities.includes('SPOTIFY')) || false;
                runTimeData.echoDevices[devSerialNumber].allowAmazonMusic = (eDevData[dev].capabilities.includes('AMAZON_MUSIC')) || false;
                runTimeData.echoDevices[devSerialNumber].volumeControl = (eDevData[dev].capabilities.includes('VOLUME_SETTING')) || false;
                runTimeData.echoDevices[devSerialNumber].allowTuneIn = (eDevData[dev].capabilities.includes('TUNE_IN')) || false;
                runTimeData.echoDevices[devSerialNumber].allowIheart = (eDevData[dev].capabilities.includes('I_HEART_RADIO')) || false;
                runTimeData.echoDevices[devSerialNumber].allowPandora = (eDevData[dev].capabilities.includes('PANDORA')) || false;
                runTimeData.echoDevices[devSerialNumber].allowSpotify = (eDevData[dev].capabilities.includes('SPOTIFY')) || false;
                runTimeData.echoDevices[devSerialNumber].isMultiroomDevice = (eDevData[dev].clusterMembers && eDevData[dev].clusterMembers.length > 0) || false;
                runTimeData.echoDevices[devSerialNumber].isMultiroomMember = (eDevData[dev].parentClusters && eDevData[dev].parentClusters.length > 0) || false;

                runTimeData.echoDevices[devSerialNumber].notifications = notifs.filter(item => item.deviceSerialNumber === devSerialNumber) || [];
                delete eDevData[dev]['capabilities'];
            } else {
                runTimeData.ignoredDevices[devSerialNumber] = eDevData[dev];
            }
        }
        return runTimeData.echoDevices;
    } catch (err) {
        logger.error('buildEchoDeviceMap ERROR:', err);
    }
}

function handleDataUpload(deviceData, src) {
    try {
        let url = (configData.settings.useHeroku && configData.settings.smartThingsUrl) ? `${configData.settings.smartThingsUrl}` : `http://${configData.settings.smartThingsHubIP}:39500/event`;
        // logger.info('ST URL: ' + url);
        if (configData.settings && ((configData.settings.useHeroku && configData.settings.smartThingsUrl) || (configData.settings.smartThingsHubIP !== "" && configData.settings.smartThingsHubIP !== undefined))) {
            buildEchoDeviceMap()
                .then(function() {
                    let options = {
                        method: 'POST',
                        uri: url,
                        headers: {
                            'evtSource': 'Echo_Speaks',
                            'evtType': 'sendStatusData'
                        },
                        body: {
                            'echoDevices': runTimeData.echoDevices,
                            'authenticated': runTimeData.authenticated,
                            'useHeroku': (configData.settings.useHeroku === true),
                            'hostUrl': configData.settings.hostUrl || null,
                            'cloudUrl': (configData.settings.useHeroku === true) ? `https://${configData.settings.hostUrl}` : null,
                            'timestamp': Date.now(),
                            'serviceInfo': {
                                'version': appVer,
                                'sessionEvts': runTimeData.eventCount,
                                'startupDt': getServiceUptime(),
                                'ip': getIPAddress(),
                                'port': configData.settings.serverPort,
                                'config': {
                                    'refreshSeconds': configData.settings.refreshSeconds,
                                    'smartThingsHubIP': configData.settings.smartThingsHubIP
                                }
                            }
                        },
                        json: true
                    };
                    reqPromise(options)
                        .then(function(resp) {
                            // logger.debug('resp:', resp);
                            let cltVerStr = resp && resp.version ? ` | Client Version: (${resp.version})` : '';
                            runTimeData.eventCount++;
                            if (configData.settings.useHeroku) {
                                logger.info(`** Data Sent to SmartThings Cloud Endpoint Successfully!${cltVerStr} **`);
                            } else {
                                logger.info(`** Data Sent to SmartThings Hub Successfully! | Hub: (${url}) **`);
                            }
                        })
                        .catch(function(err) {
                            logger.error("ERROR: Unable to connect to SmartThings Hub: " + err.message);
                        });
                })
                .catch(function(err) {
                    logger.error('buildEchoDeviceMap error: ' + err.message);
                });
        } else {
            logger.silly('Required Parameters has not been set!!  Please visit http://' + getIPAddress() + ':' + configData.settings.serverPort + '/config to configure settings...');
        }
    } catch (err) {
        logger.error(`${src} Error: ` + err.message);
    }
}

function sendDeviceDataToST(eDevData) {
    handleDataUpload(eDevData, 'sendDeviceDataToST');
}

function sendStatusUpdateToST(self) {
    handleDataUpload('sendStatusUpdateToST');
}

function scheduledDataUpdates() {
    sendStatusUpdateToST(alexa_api);
}

function stopScheduledDataUpdates() {
    runTimeData.scheduledUpdatesActive = false;
    logger.debug("Scheduled Updates Cancelled...");
    try {
        clearInterval(scheduledDataUpdates);
    } catch (err) {
        // console.log('clearUpdates Schedule: ')
    }
}

function configCheckOk() {
    return new Promise(function(resolve) {
        let res = (((configData.settings.useHeroku === true && !configData.settings.smartThingsUrl) || !configData.settings.amazonDomain || (!configData.settings.useHeroku && !configData.settings.smartThingsHubIP)) !== true);
        resolve(res);
    });
};

initConfig()
    .then(function(res) {
        if (res) {
            startWebConfig()
                .then(function(res) {
                    configCheckOk()
                        .then(function(res) {
                            if (res === true) {
                                if (configData.state.loginComplete === true || (configData.settings.hostUrl && configData.settings.smartThingsUrl)) {
                                    logger.info('-- Echo Speaks Web Service Starting Up! Takes about 10 seconds before it\'s available... --');
                                    startWebServer((configData.settings.useHeroku === true && configData.settings.smartThingsUrl !== undefined));
                                } else {
                                    logger.info(`** Echo Speaks Web Service is Waiting for Amazon Login to Start... loginComplete: ${configData.state.loginComplete || undefined} | hostUrl: ${configData.settings.hostUrl || undefined} | smartThingsUrl: ${configData.settings.smartThingsUrl} **`);
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
    // alexaCookie.stopProxyServer();
    if (runTimeData.scheduledUpdatesActive) {
        stopScheduledDataUpdates();
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