"use strict";

const appVer = require('./package.json').version;
const alexa_api = require('./alexa-api');
const reqPromise = require("request-promise");
const logger = require('./logger');
const express = require('express');
// const io = socketIO(express);
const bodyParser = require('body-parser');
const os = require('os');
const alexaCookie = require('./alexa-cookie/alexa-cookie');
const editJsonFile = require("edit-json-file", {
    autosave: true
});
const dataFolder = os.homedir() + '/.echo-speaks';
const configFile = editJsonFile(dataFolder + '/es_config.json');
const fs = require('fs');
const webApp = express();
const urlencodedParser = bodyParser.urlencoded({
    extended: false
});
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// These the config variables
let configData = {};
let scheduledUpdatesActive = false;
let loginProxyActive = false;
let savedConfig = {};
let command = {};
let serviceStartTime = Date.now(); //Returns time in millis
let eventCount = 0;
let alexaUrl = 'https://alexa.amazon.com';
let echoDevices = {};

function initConfig() {
    return new Promise(function(resolve, reject) {
        logger.debug('dataFolder: ' + dataFolder);
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
    configFile.set('settings.amazonDomain', process.env.amazonDomain || configData.settings.amazonDomain);
    configFile.set('settings.smartThingsUrl', process.env.smartThingsUrl || configData.settings.smartThingsUrl);
    configFile.set('settings.serverPort', process.env.PORT || (configData.settings.serverPort || 8091));
    configFile.set('settings.refreshSeconds', process.env.refreshSeconds ? parseInt(process.env.refreshSeconds) : (configData.settings.refreshSeconds || 60));
    if (!configData.state) {
        configData.state = {};
    }
    configFile.set('state.scriptVersion', appVer);
    configFile.save();
    configData = configFile.get();
    return true
}

function startWebConfig() {
    return new Promise(function(resolve, reject) {
        try {
            webApp.listen(configData.settings.serverPort, function() {
                logger.info('** Echo Speaks Config Service (v' + appVer + ') is Running at (IP: ' + getIPAddress() + ' | Port: ' + configData.settings.serverPort + ') | ProcessId: ' + process.pid + ' **');
                // if (!configCheckOk()) {
                // logger.warn('** Configurations Settings Missing... Please visit https://' + getIPAddress() + ':' + configData.settings.serverPort + '/config to configure settings...');
                // } else {
                // logger.info('** Configurations Page available at (https://' + getIPAddress() + ':' + configData.settings.serverPort + '/config)');
                // }
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
            webApp.get('/clearAuth', urlencodedParser, function(req, res) {
                logger.verbose('got request for to clear authentication');
                let clearUrl = configData.settings.smartThingsUrl ? String(configData.settings.smartThingsUrl).replace("/receiveData?", "/cookie?") : null
                alexa_api.clearSession(clearUrl, configData.settings.useHeroku);
                configFile.set('state.loginProxyActive', true);
                configData.state.loginProxyActive = true;
                configFile.set('state.loginComplete', false);
                configData.state.loginComplete = false;
                configFile.unset('user');
                configFile.unset('password');
                configFile.save();
                if (scheduledUpdatesActive) {
                    clearDataUpdates()
                }
                startWebServer();
                res.send({ result: 'Clear Complete' });
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
                    let ls = loadConfig();
                    res.send('done');
                    if (configCheckOk()) {
                        // console.log('configData(set): ', configData);
                        logger.debug('** Settings File Updated via Web Config **');
                        if (!scheduledUpdatesActive || !loginProxyActive) {
                            startWebServer();
                        }
                    }
                } else {
                    res.send('failed');
                }
            });
            webApp.get('/cookie-success', function(req, res) {
                res.send(loginSuccessHtml());
            });
            resolve(true)
        } catch (ex) {
            reject(ex)
        }
    });
}

function startWebServer(checkForCookie = false) {
    const alexaOptions = {
        debug: false,
        checkForCookie: checkForCookie,
        serverPort: configData.settings.serverPort,
        amazonDomain: configData.settings.amazonDomain,
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
    loginProxyActive = true;
    alexa_api.alexaLogin(configData.settings.user, configData.settings.password, alexaOptions, webApp, function(error, response, config) {
        alexaUrl = 'https://alexa.' + configData.settings.amazonDomain;
        savedConfig = config;
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

            buildEchoDeviceMap(config.devicesArray.devices)
                .then(function(devOk) {
                    logger.silly('Echo Speaks Alexa API is Actively Running at (IP: ' + getIPAddress() + ' | Port: ' + configData.settings.serverPort + ') | ProcessId: ' + process.pid);

                    webApp.post('/alexa-tts', urlencodedParser, function(req, res) {
                        let hubAct = (req.headers.tts !== undefined || req.headers.deviceserialnumber !== undefined);
                        let tts = req.body.tts || req.headers.tts;
                        let deviceSerialNumber = req.body.deviceSerialNumber || req.headers.deviceserialnumber;
                        logger.debug('++ Received a Send TTS Request for Device: ' + deviceSerialNumber + ' | Message: ' + tts + (hubAct ? ' | Source: (ST HubAction)' : '') + ' ++');
                        alexa_api.setTTS(tts, deviceSerialNumber, savedConfig, function(error, response) {
                            res.send(response);
                        });
                    });

                    webApp.post('/alexa-getDevices', urlencodedParser, function(req, res) {
                        logger.verbose('++ Received a getDevices Request... ++');
                        alexa_api.getDevices(savedConfig, function(error, response) {
                            buildEchoDeviceMap(response.devices)
                                .then(function(devOk) {
                                    res.send(echoDevices);
                                })
                                .catch(function(err) {
                                    res.send(null);
                                });
                        });
                    });

                    webApp.get('/alexa-devices', urlencodedParser, function(req, res) {
                        logger.verbose('++ Received a alexa-devices Request... ++');
                        alexa_api.getDevices(savedConfig, function(error, response) {
                            buildEchoDeviceMap(response.devices)
                                .then(function(devOk) {
                                    res.send(echoDevices);
                                })
                                .catch(function(err) {
                                    res.send(null);
                                });
                        });
                    });

                    webApp.get('/alexa-testDevices', urlencodedParser, function(req, res) {
                        console.log('++ Received a testDevices Request... ++');
                        let ttsMsg = 'Yay!!!!,  This device is Successfully receiving tts messages.';
                        for (const echo in echoDevices) {
                            console.log(echoDevices[echo]);
                            alexa_api.setTTS(ttsMsg, echoDevices[echo].serialNumber, savedConfig, function(error, response) {
                                console.log('sent testmsg to ' + echoDevices[echo].serialNumber);
                            });
                        }
                        res.send('done');
                    });

                    webApp.post('/alexa-command', urlencodedParser, function(req, res) {
                        // console.log('command headers: ', req.headers);
                        let hubAct = (req.headers.deviceserialnumber != undefined && !configData.settings.useHeroku);
                        let serialNumber = req.headers.deviceserialnumber;
                        let deviceType = req.headers.devicetype;
                        let deviceOwnerCustomerId = req.headers.deviceownercustomerid;
                        let cmdType = req.headers.cmdtype;
                        let cmdValues = (req.headers.cmdvalobj && req.headers.cmdvalobj.length) ? JSON.parse(req.headers.cmdvalobj) : {};
                        let message = (req.headers.message) || "";

                        let cmdOpts = {
                            headers: {
                                'Cookie': savedConfig.cookies,
                                'csrf': savedConfig.csrf
                            },
                            json: {}
                        };
                        switch (cmdType) {
                            case 'SetDnd':
                                cmdOpts.method = 'PUT';
                                cmdOpts.url = alexaUrl + '/api/dnd/status';
                                cmdOpts.json = {
                                    deviceSerialNumber: serialNumber,
                                    deviceType: deviceType
                                };
                                break;
                            case 'SendTTS':
                                cmdOpts.method = 'POST';
                                cmdOpts.url = alexaUrl + '/api/behaviors/preview';
                                cmdOpts.deviceId = req.headers.deviceid || undefined;
                                cmdOpts.queueKey = req.headers.queuekey || undefined;
                                cmdOpts.msgDelay = req.headers.msgdelay || undefined;
                                cmdOpts.json = {
                                    "behaviorId": "PREVIEW",
                                    "sequenceJson": "{\"@type\":\"com.amazon.alexa.behaviors.model.Sequence\", \
                                    \"startNode\":{\"@type\":\"com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode\", \
                                    \"type\":\"Alexa.Speak\",\"operationPayload\":{\"deviceType\":\"" + deviceType + "\", \
                                    \"deviceSerialNumber\":\"" + serialNumber + "\",\"locale\":\"en-US\", \
                                    \"customerId\":\"" + deviceOwnerCustomerId + "\", \"textToSpeak\": \"" + message + "\"}}}",
                                    "status": "ENABLED"
                                }
                                break;
                            default:
                                cmdOpts.method = 'POST';
                                cmdOpts.url = alexaUrl + '/api/np/command';
                                cmdOpts.qs = {
                                    deviceSerialNumber: serialNumber,
                                    deviceType: deviceType
                                };
                                cmdOpts.json = {
                                    type: cmdType
                                };
                                break
                        }
                        if (Object.keys(cmdValues).length) {
                            for (const key in cmdValues) {
                                cmdOpts.json[key] = cmdValues[key];
                            }
                        }
                        if (serialNumber) {
                            logger.debug('++ Received an Execute Command Request for Device: ' + serialNumber + ' | CmdType: ' + cmdType + ' | CmdValObj: ' + cmdValues + ' | deviceDni: ' + cmdOpts.deviceId + ' ' + (hubAct && !configData.settings.useHeroku ? ' | Source: (ST HubAction)' : (configData.settings.useHeroku ? ' | Source: (ST C2C)' : '')) + ' ++');
                            alexa_api.executeCommand(cmdOpts, function(error, response) {
                                res.send(response);
                            });
                        } else {
                            res.send('failed');
                        }
                    });

                    // webApp.post('/alexa-getState', urlencodedParser, function(req, res) {
                    //     let hubAct = (req.headers.deviceserialnumber != undefined);
                    //     let deviceSerialNumber = req.body.deviceSerialNumber || req.headers.echodeviceid;
                    //     console.log('++ Received a Device State Request for Device: ' + deviceSerialNumber + (hubAct ? ' | Source: (ST HubAction)' : '') + ' ++');
                    //     alexa_api.getState(deviceSerialNumber, savedConfig, function(error, response) {
                    //         res.send(response);
                    //     });
                    // });

                    // webApp.post('/alexa-getActivities', urlencodedParser, function(req, res) {
                    //     logger.verbose('got request for getActivities');
                    //     alexa_api.getActivities(savedConfig, function(error, response) {
                    //         res.send(response);
                    //     });
                    // });

                    // webApp.post('/alexa-setBluetooth', urlencodedParser, function(req, res) {
                    //     var mac = req.body.mac;
                    //     var deviceSerialNumber = req.body.deviceSerialNumber;
                    //     console.log('got set bluetooth  message with mac: ' + mac + ' for device: ' + deviceSerialNumber);
                    //     alexa_api.setBluetoothDevice(mac, deviceSerialNumber, savedConfig, function(error, response) {
                    //         res.send(response);
                    //     });
                    // });

                    // webApp.post('/alexa-getBluetooth', urlencodedParser, function(req, res) {
                    //     console.log('got get bluetootha message');
                    //     alexa_api.getBluetoothDevices(savedConfig, function(error, response) {
                    //         res.send(response);
                    //     });
                    // });

                    // webApp.post('/alexa-disconnectBluetooth', urlencodedParser, function(req, res) {
                    //     var deviceSerialNumber = req.body.deviceSerialNumber;
                    //     console.log('got set bluetooth disconnect for device: ' + deviceSerialNumber);
                    //     alexa_api.disconnectBluetoothDevice(deviceSerialNumber, savedConfig, function(error, response) {
                    //         res.send(response);
                    //     });
                    // });

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
                            clearDataUpdates()
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

                    webApp.get('/heartbeat', urlencodedParser, function(req, res) {
                        logger.verbose('++ Received a heartbeat Request... ++');
                        res.send({ result: "i am alive" })
                    });

                    sendDeviceDataToST(echoDevices);
                    logger.debug("** Device Data Refresh Scheduled for Every (" + configData.settings.refreshSeconds + ' sec) **');
                    setInterval(scheduledDataUpdates, configData.settings.refreshSeconds * 1000);
                    scheduledUpdatesActive = true;
                })
                .catch(function(err) {
                    console.log(err);
                });
        }
    });
}

async function buildEchoDeviceMap(eDevData) {
    // console.log('eDevData: ', eDevData);
    try {
        let removeKeys = ['appDeviceList', 'charging', 'clusterMembers', 'essid', 'macAddress', 'parentClusters', 'deviceTypeFriendlyName', 'registrationId', 'remainingBatteryLevel', 'postalCode', 'language'];
        for (const dev in eDevData) {
            if (eDevData[dev].deviceFamily === 'ECHO' || eDevData[dev].deviceFamily === 'KNIGHT' || eDevData[dev].deviceFamily === 'ROOK' || eDevData[dev].deviceFamily === 'TABLET' || eDevData[dev].deviceFamily === 'THIRD_PARTY_AVS_MEDIA_DISPLAY') {
                for (const item in removeKeys) {
                    delete eDevData[dev][removeKeys[item]];
                }
                echoDevices[eDevData[dev].serialNumber] = eDevData[dev];
                let devState = await getDeviceStateInfo(eDevData[dev].serialNumber);
                echoDevices[eDevData[dev].serialNumber].playerState = devState;
            }
        }
        let dndState = await getDeviceDndInfo();
        for (const ds in dndState) {
            if (echoDevices[dndState[ds].deviceSerialNumber] !== undefined) {
                echoDevices[dndState[ds].deviceSerialNumber].dndEnabled = dndState[ds].enabled || false;
            }
        }
        // let notifs = await getNotificationInfo();
        // for (const nd in notifs) {
        //     if (echoDevices[notifs[nd].deviceSerialNumber] !== undefined) {
        //         echoDevices[notifs[nd].deviceSerialNumber].dndEnabled = notifs[nd].enabled || false;
        //     }
        // }
    } catch (err) {
        logger.error('buildEchoDeviceMap ERROR:', err);
    }
}

function getDeviceStateInfo(deviceId) {
    return new Promise(resolve => {
        alexa_api.getState(deviceId, savedConfig, function(err, resp) {
            resolve(resp.playerInfo || {});
        });
    });
}

function getDeviceDndInfo() {
    return new Promise(resolve => {
        alexa_api.getDndStatus(savedConfig, function(err, resp) {
            resolve(resp || []);
        });
    });
}

function getNotificationInfo() {
    return new Promise(resolve => {
        alexa_api.getNotifications(savedConfig, function(err, resp) {
            resolve(resp || []);
        });
    });
}

function handleDataUpload(deviceData, src) {
    try {
        let url = (configData.settings.useHeroku && configData.settings.smartThingsUrl) ? `${configData.settings.smartThingsUrl}` : `http://${configData.settings.smartThingsHubIP}:39500/event`;
        // logger.info('ST URL: ' + url);
        if (deviceData === undefined) {
            logger.error('device data missing');
        } else if (configData.settings && ((configData.settings.useHeroku && configData.settings.smartThingsUrl) || (configData.settings.smartThingsHubIP !== "" && configData.settings.smartThingsHubIP !== undefined))) {
            buildEchoDeviceMap(deviceData)
                .then(function(devOk) {
                    let options = {
                        method: 'POST',
                        uri: url,
                        headers: {
                            'evtSource': 'Echo_Speaks',
                            'evtType': 'sendStatusData'
                        },
                        body: {
                            'echoDevices': echoDevices,
                            'useHeroku': (configData.settings.useHeroku === true),
                            'hostUrl': configData.settings.hostUrl || null,
                            'cloudUrl': (configData.settings.useHeroku === true) ? 'https://' + configData.settings.hostUrl : null,
                            'timestamp': Date.now(),
                            'serviceInfo': {
                                'version': appVer,
                                'sessionEvts': eventCount,
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
                            eventCount++;
                            if (configData.settings.useHeroku) {
                                logger.info(`** Sent Echo Speaks Data to SmartThings Cloud Endpoint Successfully! **`);
                            } else {
                                logger.info(`** Sent Echo Speaks Data to SmartThings Hub Successfully! | Hub: (${url}) **`);
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
    handleDataUpload(eDevData, 'sendDeviceDataToST')
}

function sendStatusUpdateToST(self) {
    self.getDevices(savedConfig, function(error, response) {
        if (response && response.devices) {
            handleDataUpload(response.devices, 'sendStatusUpdateToST')
        } else {
            logger.error("sendStatusUpdateToST Response was empty... | error: " + error);
        }
    });
}

function scheduledDataUpdates() {
    sendStatusUpdateToST(alexa_api);
}

function clearDataUpdates() {
    scheduledUpdatesActive = false
    logger.debug("Scheduled Updates Cancelled...");
    clearInterval(scheduledDataUpdates);
}

function configCheckOk() {
    return ((configData.settings.useHeroku === true && !configData.settings.smartThingsUrl) || configData.settings.amazonDomain === '' || (!configData.settings.useHeroku && !configData.settings.smartThingsHubIP)) ? false : true
}

initConfig()
    .then(function(res) {
        if (res) {
            startWebConfig()
                .then(function(res) {
                    // console.log('webconfig up');
                    // console.log('configCheckOk: ' + configCheckOk());
                    if (configCheckOk()) {
                        // console.log('loginComplete: ' + configData.state.loginComplete, 'hostUrl: ' + configData.settings.hostUrl, 'smartThingsUrl: ' + configData.settings.smartThingsUrl);
                        if (configData.state.loginComplete === true || (configData.settings.hostUrl && configData.settings.smartThingsUrl)) {
                            // logger.info('-- Echo Speaks Web Service Starting Up! Takes about 10 seconds before it\'s available... --');
                            startWebServer((configData.settings.useHeroku === true && configData.settings.smartThingsUrl !== undefined));
                        }
                    }
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

function tsLogger(msg) {
    let dt = new Date().toLocaleString();
    console.log(dt + ' | ' + msg);
}

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
    let diff = (now - serviceStartTime) / 1000;
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
    html += '<!DOCTYPE html>'
    html += '<html>'
    html += '   <head>'
    html += '       <meta name="viewport" content="width=640">'
    html += '       <title>Echo Speaks Amazon Authentication</title>'
    html += '       <style type="text/css">'
    html += '           body { background-color: slategray; text-align: center; }'
    html += '           .container {'
    html += '               width: 90%;'
    html += '               padding: 4%;'
    html += '               text-align: center;'
    html += '               color: white;'
    html += '           }'
    html += '           p {'
    html += '               font-size: 2.2em;'
    html += '               text-align: center;'
    html += '               padding: 0 40px;'
    html += '               margin-bottom: 0;'
    html += '           }'
    html += '       </style>'
    html += '   </head>'
    html += '   <body>'
    html += '       <div class="container">'
    html += '           <h3>Amazon Alexa Cookie Retrieved Successfully</h3>'
    html += '           <h5>You will be redirected back to the config page in 5 seconds.</h5>';
    html += '       </div>';
    html += "       <script>setTimeout( function(){ window.location.href = '" + redirUrl + "'; }, 5000 );</script>";
    html += '   </body>'
    html += '</html>';
    return html;
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
    // alexaCookie.stopProxyServer();
    if (scheduledUpdatesActive) {
        clearDataUpdates()
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
