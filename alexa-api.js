const request = require('request');
const reqPromise = require("request-promise");
const logger = require('./logger');
const alexaCookie = require('./alexa-cookie/alexa-cookie');
const dateFormat = require('dateformat');
const editJsonFile = require("edit-json-file", {
    autosave: true
});
const dataFolder = require('os').homedir() + '/.echo-speaks';
const sessionFile = editJsonFile(dataFolder + '/session.json');

let alexaUrl = 'https://alexa.amazon.com';
let sessionData = sessionFile.get() || {};
sessionFile.save();

var clearSession = function(url, useHeroku) {
    sessionFile.unset('csrf');
    sessionFile.unset('cookie');
    sessionFile.save();
    if (url && useHeroku) {
        let options = {
            method: 'DELETE',
            uri: url,
            json: true
        };
        reqPromise(options)
            .then(function(resp) {
                // console.log('resp:', resp);
                if (resp) {
                    logger.info(`** Sent Remove Alexa Cookie Request to SmartThings Successfully! **`);
                }
            })
            .catch(function(err) {
                logger.error("ERROR: Unable to send Alexa Cookie to SmartThings: " + err.message);
            });
    }
};

function getRemoteCookie(alexaOptions) {
    return new Promise(resolve => {
        if (alexaOptions.useHeroku === false || alexaOptions.checkForCookie === false) { resolve(undefined); }
        let config = {};
        if (alexaOptions.useHeroku === true && alexaOptions.stEndpoint) {
            getCookiesFromST(alexaOptions.stEndpoint)
                .then(function(cookies) {
                    if (cookies && cookies.cookie && cookies.csrf) {
                        if (sessionData['csrf'] === undefined || sessionData['csrf'] !== cookies.csrf) {
                            sessionFile.set('csrf', cookies.csrf);
                            sessionData['csrf'] = cookies.csrf;
                        }
                        if (sessionData['cookie'] === undefined || sessionData['cookie'] !== cookies.cookie) {
                            sessionFile.set('cookie', cookies.cookie);
                            sessionData['cookie'] = cookies.cookie;
                        }
                        sessionFile.save();
                        config.cookies = cookies.cookie;
                        config.csrf = cookies.csrf;
                        resolve(config);
                    }
                });
        } else {
            resolve(config);
        }
    });
};

function alexaLogin(username, password, alexaOptions, webapp, callback) {
    let devicesArray = [];
    let deviceSerialNumber;
    let deviceType;
    let deviceOwnerCustomerId;
    let config = {};
    config.devicesArray = devicesArray;
    config.deviceSerialNumber = deviceSerialNumber;
    config.deviceType = deviceType;
    config.deviceOwnerCustomerId = deviceOwnerCustomerId;
    config.alexaURL = alexaOptions.amazonDomain;

    getRemoteCookie(alexaOptions)
        .then(function(remoteCookies) {
            // console.log('remoteCookies: ', remoteCookies, 'keys: ', Object.keys(remoteCookies));
            if (remoteCookies !== undefined && Object.keys(remoteCookies).length > 0 && remoteCookies.cookies && remoteCookies.csrf) {
                config.cookies = remoteCookies.cookies;
                config.csrf = remoteCookies.csrf;
                callback(null, 'Login Successful (Retreived from ST)', config);
            } else if (sessionData.csrf && sessionData.cookie) {
                config.cookies = sessionData.cookie;
                config.csrf = sessionData.csrf;
                callback(null, 'Login Successful (Stored Session)', config);
            } else {
                alexaCookie.generateAlexaCookie(username, password, alexaOptions, webapp, function(err, result) {
                    // console.log('generateAlexaCookie error: ', err);
                    // console.log('generateAlexaCookie result: ', result);
                    if (err && (err.message.startsWith('Login unsuccessful') || err.message.startsWith('Amazon-Login-Error:'))) {
                        logger.debug('Please complete Amazon login by going here: (http://' + alexaOptions.proxyHost + ':' + alexaOptions.serverPort + '/config)');
                    } else if (err && !result) {
                        logger.error('generateAlexaCookie: ' + err.message);
                        callback(err, 'There was an error', null);
                    } else if (result) {
                        alexaUrl = 'https://alexa.' + alexaOptions.amazonDomain;
                        // IMPORTANT: can be called multiple times!! As soon as a new cookie is fetched or an error happened. Consider that!
                        logger.debug('cookie: ' + result.cookie || undefined);
                        logger.debug('csrf: ' + result.csrf || undefined);
                        if (result && result.csrf && result.cookie) {
                            // alexaCookie.stopProxyServer();
                            if (sessionData['csrf'] === undefined || sessionData['csrf'] !== result.csrf) {
                                sessionFile.set('csrf', result.csrf);
                                sessionData['csrf'] = result.csrf;
                            }
                            if (sessionData['cookie'] === undefined || sessionData['cookie'] !== result.cookie) {
                                sessionFile.set('cookie', result.cookie);
                                sessionData['cookie'] = result.cookie;
                            }
                            sessionFile.save();
                            config.cookies = sessionData.cookie;
                            config.csrf = sessionData.csrf;
                            sendCookiesToST(alexaOptions.stEndpoint, config.cookies, config.csrf);
                            callback(null, 'Login Successful', config);
                        } else {
                            callback(true, 'There was an error getting authentication', null);
                            clearSession(alexaOptions.stEndpoint, alexaOptions.useHeroku);
                        }
                    }
                });
            }
        });
};

var sendCookiesToST = function(url, cookie, csrf) {
    if (url && cookie && csrf) {
        let options = {
            method: 'POST',
            uri: url,
            body: {
                cookie: cookie,
                csrf: csrf
            },
            json: true
        };
        reqPromise(options)
            .then(function(resp) {
                // console.log('resp:', resp);
                if (resp) {
                    logger.info(`** Alexa Cookie sent to SmartThings Cloud Endpoint Successfully! **`);
                }
            })
            .catch(function(err) {
                logger.error("ERROR: Unable to send Alexa Cookie to SmartThings: " + err.message);
            });
    }
};

function getCookiesFromST(url) {
    return new Promise(resolve => {
        reqPromise({ method: 'GET', uri: url, json: true })
            .then(function(resp) {
                // console.log('getCookiesFromST resp: ', resp);
                if (resp && resp.length > 0)
                    logger.info(`** Retrieved Alexa Cookie from SmartThings Cloud Endpoint Successfully! **`);
                resolve(resp);
            })
            .catch(function(err) {
                logger.error("ERROR: Unable to retrieve Alexa Cookie from SmartThings: " + err.message);
                resolve({});
            });
    });
};

var setReminder = function(message, datetime, deviceSerialNumber, config, callback) {
    var now = new Date();
    var createdDate = now.getTime();
    var addSeconds = new Date(createdDate + 1 * 60000); // one minute afer the current time
    var alarmTime = addSeconds.getTime();
    if (datetime) {
        var datetimeDate = new Date(dateFormat(datetime));
        alarmTime = datetimeDate.getTime();
    }
    var originalTime = dateFormat(alarmTime, 'HH:MM:00.000');
    var originalDate = dateFormat(alarmTime, 'yyyy-mm-dd');
    var device = {};
    config.devicesArray.devices.forEach(function(dev) {
        if (dev.serialNumber === deviceSerialNumber) {
            device.deviceSerialNumber = dev.serialNumber;
            device.deviceType = dev.deviceType;
            device.deviceOwnerCustomerId = dev.deviceOwnerCustomerId;
        }
    });

    request({
        method: 'PUT',
        url: alexaUrl + '/api/notifications/createReminder',
        headers: {
            'Cookie': config.cookies,
            'csrf': config.csrf
        },
        json: {
            type: 'Reminder',
            status: 'ON',
            alarmTime: alarmTime,
            originalTime: originalTime,
            originalDate: originalDate,
            timeZoneId: null,
            reminderIndex: null,
            sound: null,
            deviceSerialNumber: device.deviceSerialNumber,
            deviceType: device.deviceType,
            recurringPattern: '',
            reminderLabel: message,
            isSaveInFlight: true,
            id: 'createReminder',
            isRecurring: false,
            createdDate: createdDate
        }
    }, function(error, response) {
        if (!error && response.statusCode === 200) {
            callback(null, {
                "status": "success"
            });
        } else {
            callback(error, {
                "status": "failure"
            });
        }
    });
};

var setTTS = function(message, deviceSerialNumber, config, callback) {
    var device = {};
    config.devicesArray.devices.forEach(function(dev) {
        if (dev.serialNumber === deviceSerialNumber) {
            device.deviceSerialNumber = dev.serialNumber;
            device.deviceType = dev.deviceType;
            device.deviceOwnerCustomerId = dev.deviceOwnerCustomerId;
        }
    });
    request({
        method: 'POST',
        url: alexaUrl + '/api/behaviors/preview',
        headers: {
            'Cookie': config.cookies,
            'csrf': config.csrf
        },
        json: {
            "behaviorId": "PREVIEW",
            "sequenceJson": "{\"@type\":\"com.amazon.alexa.behaviors.model.Sequence\", \
        \"startNode\":{\"@type\":\"com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode\", \
        \"type\":\"Alexa.Speak\",\"operationPayload\":{\"deviceType\":\"" + device.deviceType + "\", \
        \"deviceSerialNumber\":\"" + device.deviceSerialNumber + "\",\"locale\":\"en-US\", \
        \"customerId\":\"" + device.deviceOwnerCustomerId + "\", \"textToSpeak\": \"" + message + "\"}}}",
            "status": "ENABLED"
        }
    }, function(error, response) {
        if (!error && response.statusCode === 200) {
            callback(null, {
                "status": "success"
            });
        } else {
            callback(error, {
                "status": "failure"
            });
        }
    });
};

var executeCommand = function(_cmdOpts, callback) {
    // console.log('Method: ' + _cmdOpts.method);
    // console.log('URL:' + _cmdOpts.url);
    // console.log('Query: ', _cmdOpts.qs);
    // console.log('Body: ', _cmdOpts.json);
    request(_cmdOpts, function(error, response, body) {
        // console.log('body:', body);
        console.log('executeCommand Status: (' + response.statusCode + ')');
        if (!error && response.statusCode === 200) {
            callback(null, {
                "statusCode": response.statusCode,
                "deviceId": _cmdOpts.deviceId,
                "message": "success",
                "queueKey": _cmdOpts.queueKey,
                "msgDelay": _cmdOpts.msgDelay
            });
        } else {
            // console.log('error: ', error.message);
            callback(error, {
                "statusCode": response.statusCode,
                "deviceId": _cmdOpts.deviceId,
                "message": body.message || null,
                "queueKey": _cmdOpts.queueKey,
                "msgDelay": _cmdOpts.msgDelay
            });
        }
    });
};

var setMedia = function(command, deviceSerialNumber, config, callback) {
    var device = {};
    config.devicesArray.devices.forEach(function(dev) {
        if (dev.serialNumber === deviceSerialNumber) {
            device.deviceSerialNumber = dev.serialNumber;
            device.deviceType = dev.deviceType;
            device.deviceOwnerCustomerId = dev.deviceOwnerCustomerId;
        }
    });
    request({
        method: 'POST',
        url: alexaUrl + '/api/np/command?deviceSerialNumber=' +
            device.deviceSerialNumber + '&deviceType=' + device.deviceType,
        headers: {
            'Cookie': config.cookies,
            'csrf': config.csrf
        },
        json: command
    }, function(error, response) {
        if (!error && response.statusCode === 200) {
            callback(null, {
                "status": "success"
            });
        } else {
            callback(error, response);
        }
    });
};

var getDevices = function(config, callback) {
    // console.log('config: ', JSON.stringify(config));
    request({
        method: 'GET',
        url: alexaUrl + '/api/devices-v2/device',
        headers: {
            'Cookie': config.cookies,
            'csrf': config.csrf
        }
    }, function(error, response, body) {
        if (!error && response.statusCode === 200) {
            try {
                // console.log('getDevices Body: ', body);
                config.devicesArray = JSON.parse(body);
            } catch (e) {
                logger.error('getDevices Error: ' + e.message);
                config.devicesArray = [];
            }
            callback(null, config.devicesArray);
        } else {
            if (response && response.statusCode !== undefined) {
                // console.log('getDevices status: ', response || "", 'Code: (' + response.statusCode || 'error' + ')');
            }
            callback(error, response);
        }
    });
};

var getState = function(device, _config, callback) {
    request({
        method: 'GET',
        url: alexaUrl + '/api/np/player?deviceSerialNumber=' + device.serialNumber + '&deviceType=' + device.deviceType + '&screenWidth=2560',
        headers: {
            'Cookie': _config.cookies,
            'csrf': _config.csrf
        }
    }, function(error, response, body) {
        if (!error && response.statusCode === 200) {
            callback(null, JSON.parse(body));
        } else {
            callback(error, response);
        }
    });
};

var getDndStatus = function(_config, callback) {
    request({
        method: 'GET',
        url: alexaUrl + '/api/dnd/device-status-list',
        headers: {
            'Cookie': _config.cookies,
            'csrf': _config.csrf
        }
    }, function(error, response, body) {
        if (!error && response.statusCode === 200) {
            let items = [];
            try {
                let res = JSON.parse(body);
                if (Object.keys(res).length) {
                    if (res.doNotDisturbDeviceStatusList.length) {
                        items = res.doNotDisturbDeviceStatusList;
                    }
                }
            } catch (e) {
                logger.error('getDevices Error: ' + e.message);
            }
            callback(null, items);
        } else {
            callback(error, response);
        }
    });
};

var getNotifications = function(_config, callback) {
    request({
        method: 'GET',
        url: alexaUrl + '/api/notifications',
        headers: {
            'Cookie': _config.cookies,
            'csrf': _config.csrf
        }
    }, function(error, response, body) {
        if (!error && response.statusCode === 200) {
            let items = [];
            try {
                let res = JSON.parse(body);
                if (Object.keys(res).length) {
                    if (res.notifications.length) {
                        items = res.notifications;
                    }
                }
            } catch (e) {
                logger.error('getNotifications Error: ' + e.message);
            }
            callback(null, items);
        } else {
            callback(error, response);
        }
    });
};


var getBluetoothDevices = function(config, callback) {
    request({
        method: 'GET',
        url: alexaUrl + '/api/bluetooth?cached=false',
        headers: {
            'Cookie': config.cookies,
            'csrf': config.csrf
        }
    }, function(error, response, body) {
        if (!error && response.statusCode === 200) {
            callback(null, JSON.parse(body));
        } else {
            callback(error, response);
        }
    });
};

var setBluetoothDevice = function(mac, deviceSerialNumber, config, callback) {
    var device = {};
    config.devicesArray.devices.forEach(function(dev) {
        if (dev.serialNumber === deviceSerialNumber) {
            device.deviceSerialNumber = dev.serialNumber;
            device.deviceType = dev.deviceType;
            device.deviceOwnerCustomerId = dev.deviceOwnerCustomerId;
        }
    });
    request({
        method: 'POST',
        url: alexaUrl + '/api/bluetooth/pair-sink/' + device.deviceType + '/' + device.deviceSerialNumber,
        headers: {
            'Cookie': config.cookies,
            'csrf': config.csrf
        },
        json: {
            bluetoothDeviceAddress: mac
        }
    }, function(error, response) {
        if (!error && response.statusCode === 200) {
            callback(null, {
                "message": "success"
            });
        } else {
            callback(error, response);
        }
    });
};

var disconnectBluetoothDevice = function(deviceSerialNumber, config, callback) {
    var device = {};
    config.devicesArray.devices.forEach(function(dev) {
        if (dev.serialNumber === deviceSerialNumber) {
            device.deviceSerialNumber = dev.serialNumber;
            device.deviceType = dev.deviceType;
            device.deviceOwnerCustomerId = dev.deviceOwnerCustomerId;
        }
    });
    request({
        method: 'POST',
        url: alexaUrl + '/api/bluetooth/disconnect-sink/' + device.deviceType + '/' + device.deviceSerialNumber,
        headers: {
            'Cookie': config.cookies,
            'csrf': config.csrf
        },
    }, function(error, response) {
        if (!error && response.statusCode === 200) {
            callback(null, {
                "message": "success"
            });
        } else {
            callback(error, response);
        }
    });
};

exports.alexaLogin = alexaLogin;
exports.clearSession = clearSession;
exports.setReminder = setReminder;
exports.setTTS = setTTS;
exports.setMedia = setMedia;
exports.getDevices = getDevices;
exports.getState = getState;
exports.getDndStatus = getDndStatus;
exports.getNotifications = getNotifications;
exports.executeCommand = executeCommand;
exports.getBluetoothDevices = getBluetoothDevices;
exports.setBluetoothDevice = setBluetoothDevice;
exports.disconnectBluetoothDevice = disconnectBluetoothDevice;