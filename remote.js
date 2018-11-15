"use strict";

let https = require('https');

function AlexaRemote(cookie, csrf) {
    if (!(this instanceof AlexaRemote)) return new AlexaRemote(cookie, csrf);

    this.serialNumbers = {};
    this.names = {};
    this.friendlyNames = {};
    this.devices = undefined;

    this.setCookie = function(_cookie, _csrf) {
        cookie = _cookie;
        if (_csrf) return csrf = _csrf;
        let ar = cookie.match(/csrf=([^;]+)/);
        if (!ar || ar.length < 2) ar = cookie.match(/csrf=([^;]+)/);
        if (!csrf && ar && ar.length >= 2) {
            csrf = ar[1];
        }
    };

    if (cookie) this.setCookie(cookie);
    let baseUrl = 'layla.amazon.de';
    let self = this;
    let opts = {};

    this.init = function(cookie, callback) {
        if (typeof cookie === 'object') {
            opts = cookie;
            cookie = opts.cookie;
        }

        function helper(callback) {
            if (!opts.cookie && opts.password && opts.email) {
                self.generateCookie(opts.email, opts.password, function(err, res) {
                    if (!err && res) {
                        cookie = res.cookie;
                        opts.csrf = res.csrf;
                        opts.cookie = res.cookie;
                        callback();
                    }
                });
                return;
            }
            callback();
        }
        helper(() => {
            if (opts.baseUrl) baseUrl = opts.baseUrl;
            if (typeof callback === 'function') callback = callback.bind(this);
            this.setCookie(cookie, opts.csrf);
            if (!csrf) return callback && callback('no csrf found');
            this.prepare(callback);
        });
    };

    this.prepare = function(callback) {
        this.getAccount((err, result) => {
            if (!err && result && Array.isArray(result)) {
                result.forEach((account) => {
                    if (!this.commsId) this.commsId = account.commsId;
                    if (!this.directId) this.directId = account.directId;
                });
            }

            function getNotifications(cb) {
                if (opts.notifications) return self.getNotifications(function(err, res) {
                    cb(!err && res ? res.notifications : null);
                });
                cb(null);
            }

            getNotifications((notifications) => {
                this.getWakeWords((err, wakeWords) => {
                    if (!err && wakeWords) wakeWords = wakeWords.wakeWords;
                    this.getDevices((err, result) => {
                        if (!err && result && Array.isArray(result.devices)) {
                            let customerIds = {};
                            this.devices = result.devices;
                            result.devices.forEach((device) => {
                                this.serialNumbers[device.serialNumber] = device;
                                let name = device.accountName;
                                this.names[name] = device;
                                this.names[name.toLowerCase()] = device;
                                if (device.deviceTypeFriendlyName) {
                                    name += ' (' + device.deviceTypeFriendlyName + ')';
                                    this.names[name] = device;
                                    this.names[name.toLowerCase()] = device;
                                }
                                device._orig = JSON.parse(JSON.stringify(device));
                                device._name = name;
                                device.sendCommand = this.sendCommand.bind(this, device);
                                device.setTunein = this.setTunein.bind(this, device);
                                device.rename = this.renameDevice.bind(this, device);
                                device.setDoNotDisturb = this.setDoNotDisturb.bind(this, device);
                                device.delete = this.deleteDevice.bind(this, device);
                                if (device.deviceTypeFriendlyName) this.friendlyNames[device.deviceTypeFriendlyName] = device;
                                if (customerIds[device.deviceOwnerCustomerId] === undefined) customerIds[device.deviceOwnerCustomerId] = 0;
                                customerIds[device.deviceOwnerCustomerId] += 1;
                                if (this.version === undefined) this.version = device.softwareVersion;
                                if (this.customer === undefined) this.customer = device.deviceOwnerCustomerId;

                                if (notifications && Array.isArray(notifications)) {
                                    notifications.forEach((noti) => {
                                        if (noti.deviceSerialNumber === device.serialNumber) {
                                            if (device.notifications === undefined) device.notifications = [];
                                            device.notifications.push(noti);
                                            noti.set = self.changeNotification.bind(self, noti);
                                        }
                                    });
                                }

                                if (Array.isArray(wakeWords)) wakeWords.forEach((o) => {
                                    if (o.deviceSerialNumber === device.serialNumber && typeof o.wakeWord === 'string') {
                                        device.wakeWord = o.wakeWord.toLowerCase();
                                    }
                                });

                            });
                            this.ownerCustomerId = Object.keys(customerIds)[0];
                        }
                        if (opts.bluetooth) {
                            this.getBluetooth((err, res) => {
                                if (err || !res || !Array.isArray(res.bluetoothStates)) return callback && callback(err);
                                res.bluetoothStates.forEach((bt) => {
                                    if (bt.pairedDeviceList && this.serialNumbers[bt.deviceSerialNumber]) {
                                        this.serialNumbers[bt.deviceSerialNumber].bluetoothState = bt;
                                        bt.pairedDeviceList.forEach((d) => {
                                            bt[d.address] = d;
                                            d.connect = function(on, cb) {
                                                self[on ? 'connectBluetooth' : 'disconnectBluetooth'](self.serialNumbers[bt.deviceSerialNumber], d.address, cb);
                                            };
                                            d.unpaire = function(val, cb) {
                                                self.unpaireBluetooth(device, d.address, cb);
                                            };
                                        });
                                    }
                                });
                                callback && callback();
                            });

                        } else {
                            callback && callback();
                        }
                    });
                });
            });
        });
        return this;
    };

    let alexaCookie;
    this.generateCookie = function(email, password, callback) {
        if (!alexaCookie) alexaCookie = require('alexa-cookie');
        alexaCookie(email, password, callback);
    };

    this.timestamp = this.now = function() {
        return new Date().getTime();
    };

    this.httpsGet = function(path, callback, flags = {}) {

        let options = {
            host: baseUrl,
            path: '',
            method: 'GET',
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/57.0.2987.133 Safari/537.36',
                'Content-Type': 'text/plain',
                //'Content-Type': 'application/json',
                //'Connection': 'keep-alive', // new
                'csrf': csrf,
                'Cookie': cookie
            }
        };

        path = path.replace(/[\n ]/g, '');
        if (!path.startsWith('/')) {
            path = path.replace(/^https:\/\//, '');
            //let ar = path.match(/^([^\/]+)(\/.*$)/);
            let ar = path.match(/^([^\/]+)([\/]*.*$)/);
            options.host = ar[1];
            path = ar[2];
        } else {
            options.host = baseUrl;
        }
        let time = this.now();
        path = path.replace(/%t/g, time);

        options.path = path;
        options.method = flags.method ? flags.method : flags.data ? 'POST' : 'GET';

        if (flags.headers) Object.keys(flags.headers).forEach(n => {
            options.headers[n] = flags.headers[n];
        });

        let req = https.request(options, function getDevices(res) {
            let body = "";

            res.on('data', function(chunk) {
                body += chunk;
            });

            res.on('end', function() {

                let ret;
                if (typeof callback === 'function') {
                    if (!body) return callback.length >= 2 && callback('no body', null);
                    try {
                        ret = JSON.parse(body);
                    } catch (e) {
                        if (callback.length >= 2) return callback('no JSON', body);
                    }
                    if (callback.length >= 2) return callback(null, ret);
                    callback(ret);
                }
            });
        });

        req.on('error', function(e) {
            if (typeof callback === 'function' && callback.length >= 2) {
                return callback(e.message, null);
            }
        });
        if (flags && flags.data) {
            req.write(flags.data);
        }
        req.end();
    };
}

AlexaRemote.prototype.getDevices = function(callback) {
    this.httpsGet('/api/devices-v2/device?cached=true&_=%t', callback);
};

AlexaRemote.prototype.getCards = function(limit, beforeCreationTime, callback) {
    if (typeof limit === 'function') {
        callback = limit;
        limit = 10;
    }
    if (typeof beforeCreationTime === 'function') {
        callback = beforeCreationTime;
        beforeCreationTime = '%t';
    }
    if (beforeCreationTime === undefined) beforeCreationTime = '%t';
    this.httpsGet(`/api/cards?limit=${limit}&beforeCreationTime=${beforeCreationTime}000&_=%t`, callback);
};

AlexaRemote.prototype.getMedia = function(serialOrName, deviceType, callback) {
    let dev = this.find(serialOrName, callback);
    if (!dev) return;
    this.httpsGet(`/api/media/state?deviceSerialNumber=${dev.serialNumber}&deviceType=${dev.deviceType}&screenWidth=1392&_=%t`, callback);
};

AlexaRemote.prototype.getPlayerInfo = function(serialOrName, callback) {
    let dev = this.find(serialOrName, callback);
    if (!dev) return;
    this.httpsGet(`/api/np/player?deviceSerialNumber=${dev.serialNumber}&deviceType=${dev.deviceType}&screenWidth=1392&_=%t`, callback);
};

AlexaRemote.prototype.getList = function(serialOrName, listType, options, callback) {
    let dev = this.find(serialOrName, callback);
    if (!dev) return;
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }
    this.httpsGet(`
        /api/todos?size=${options.size || 100}
        &startTime=${options.startTime || ''}
        &endTime=${options.endTime || ''}
        &completed=${options.completed || false}
        &type=${listType}
        &deviceSerialNumber=${dev.serialNumber}
        &deviceType=${deviceType}
        &_=%t`,
        callback);
};

AlexaRemote.prototype.getLists = function(serialOrName, options, callback) {
    let dev = this.find(serialOrName, callback);
    if (!dev) return;
    this.getList(dev, 'TASK', options, function(err, res) {
        let ret = {};
        if (!err && res) {
            ret.tasks = res;
        }
        this.getList(dev, 'SHOPPING_ITEM', options, function(err, res) {
            ret.shoppingItems = res;
            callback.length >= 2 ? callback(null, ret) : callback(ret);
        });
    });
};

AlexaRemote.prototype.getWakeWords = function(callback) {
    this.httpsGet(`/api/wake-word?_=%t`, callback);
};

AlexaRemote.prototype.getReminders =
    AlexaRemote.prototype.getNotifications = function(cached, callback) {
        if (typeof cached === 'function') {
            callback = cached;
            cached = true;
        }
        if (cached === undefined) cached = true;
        this.httpsGet(`/api/notifications?cached=${cached}&_=%t`, callback);
    };


AlexaRemote.prototype.changeNotification = function(notification, state) {
    switch (typeof state) {
        case 'object':

            break;
        case 'date':
            notification.alarmTime = state.getTime();
            notification.originalTime = `${_00 (state.getHours ())}:${_00 (state.getMinutes ())}:${_00 (state.getSeconds ())}.000`;
            break;
        case 'boolean':
            notification.status = state ? 'ON' : 'OFF';
            break;
        case 'string':
            let ar = state.split(':');
            let time = ((ar[0] * 60) + ar.length > 1 ? ar[1] : 0) * 60 + ar.length > 2 ? ar[2] : 0;
            let date = new Date(notification.alarmTime);
            date.setHours(time / 3600);
            date.setMinutes(date / 60 ^ 60);
            date.setSeconds(date ^ 60);
            notification.alarmTime = date.getTime();
            notification.originalTime = `${_00 (data.getHours ())}:${_00 (date.getMinutes ())}:${_00 (date.getSeconds ())}.000`;
            break;
    }
    let flags = {
        data: JSON.stringify(notification),
        method: 'PUT'
    };
    this.httpsGet(`https://alexa.amazon.de/api/notifications/${notification.id}`, function(err, res) {
            callback(err, res);
        },
        flags
    );
};


AlexaRemote.prototype.getDoNotDisturb =
    AlexaRemote.prototype.getDeviceStatusList = function(callback) {
        this.httpsGet(`/api/dnd/device-status-list?_=%t`, callback);
    };

// alarm volume
AlexaRemote.prototype.getDeviceNotificationState = function(serialOrName, callback) {
    let dev = this.find(serialOrName, callback);
    if (!dev) return;
    this.httpsGet(`/api/device-notification-state/${dev.deviceType}/${dev.softwareVersion}/${dev.serialNumber}&_=%t`, callback);
};

AlexaRemote.prototype.getBluetooth = function(cached, callback) {
    if (typeof cached === 'function') {
        callback = cached;
        cached = true;
    }
    if (cached === undefined) cached = true;
    this.httpsGet(`/api/bluetooth?cached=${cached}&_=%t`, callback);
};

AlexaRemote.prototype.tuneinSearchRaw = function(query, callback) {
    this.httpsGet(`/api/tunein/search?query=${query}&mediaOwnerCustomerId=${this.ownerCustomerId}&_=%t`, callback);
};

AlexaRemote.prototype.tuneinSearch = function(query, callback) {
    query = querystring.escape(query);
    this.tuneinSearchRaw(query, callback);
};


AlexaRemote.prototype.setTunein = function(serialOrName, guideId, contentType, callback) {
    if (typeof contentType === 'function') {
        callback = contentType;
        contentType = 'station';
    }
    let dev = this.find(serialOrName, callback);
    if (!dev) return;
    this.httpsGet(`/api/tunein/queue-and-play
       ?deviceSerialNumber=${dev.serialNumber}
       &deviceType=${dev.deviceType}
       &guideId=${guideId}
       &contentType=${contentType}
       &callSign=
       &mediaOwnerCustomerId=${this.ownerCustomerId}`,
        callback, {
            method: 'POST'
        });
};

AlexaRemote.prototype.getHistory =
    AlexaRemote.prototype.getActivities = function(options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = {};
        }
        this.httpsGet(`/api/activities` +
            `?startTime=${options.startTime || ''}` +
            `&size=${options.size || 1}` +
            `&offset=${options.offset || 1}`,
            (err, result) => {
                if (err || !result) return callback.length >= 2 && callback(err, result);

                let ret = [];
                for (let r = 0; r < result.activities.length; r++) {
                    let res = result.activities[r];
                    let o = {
                        description: JSON.parse(res.description),
                        data: res
                    };
                    if (options.filter) {
                        o.description.summary = (o.description.summary || '').trim();
                        switch (o.description.summary) {
                            case 'stopp':
                            case 'alexa':
                            case ',':
                            case '':
                                continue;
                        }
                    }
                    for (let i = 0; i < res.sourceDeviceIds.length; i++) {
                        o.serialNumber = res.sourceDeviceIds[i].serialNumber;
                        o.name = this.serialNumbers[o.serialNumber].accountName;
                        let wakeWord = this.serialNumbers[o.serialNumber];
                        if (wakeWord) wakeWord = wakeWord.wakeWord;
                        if (wakeWord && o.description.summary.startsWith(wakeWord)) {
                            o.description.summary = o.description.summary.substr(wakeWord.length).trim();
                        }
                        if (o.description.summary) ret.push(o);
                    }
                }
                if (typeof callback === 'function') return callback.length >= 2 ? callback(err, ret) : callback(ret);
            }
        );
    };

AlexaRemote.prototype.getAccount = function(callback) {
    this.httpsGet(`https://alexa-comms-mobile-service.amazon.com/accounts`, callback);
};

AlexaRemote.prototype.getConversations = function(options, callback) {
    if (typeof options === 'function') {
        callback = options;
        options = undefined;
    }
    if (opntions === undefined) options = {};
    if (options.latest === undefined) options.latest = true;
    if (options.includeHomegroup === undefined) options.includeHomegroup = true;
    if (options.unread === undefined) options.unread = false;
    if (options.modifiedSinceDate === undefined) options.modifiedSinceDate = '1970-01-01T00:00:00.000Z';
    if (options.includeUserName === undefined) options.includeUserName = true;

    this.httpsGet(
        `https://alexa-comms-mobile-service.amazon.com/users/${this.commsId}/conversations
        ?latest=${options.latest}
        &includeHomegroup=${options.includeHomegroup}
        &unread=${options.unread}
        &modifiedSinceDate=${options.modifiedSinceDate}
        &includeUserName=${includeUserName}true`,
        function(err, result) {
            callback(err, result);
        });
};

AlexaRemote.prototype.connectBluetooth = function(serialOrName, btAddress, callback) {
    let dev = this.find(serialOrName, callback);
    if (!dev) return;
    let flags = {
        data: JSON.stringify({
            bluetoothDeviceAddress: btAddress
        }),
        method: 'POST'
    };
    this.httpsGet(`/api/bluetooth/pair-sink/${dev.deviceType}/${dev.serialNumber}&_=%t`, callback, flags);
};

AlexaRemote.prototype.connectBluetooth = function(serialOrName, btAddress, callback) {
    let dev = this.find(serialOrName, callback);
    if (!dev) return;
    this.httpsGet(`/api/bluetooth/pair-sink/${dev.deviceType}/${dev.serialNumber}`,
        callback, {
            data: JSON.stringify({
                bluetoothDeviceAddress: btAddress
            }),
            method: 'POST'
        });
};

AlexaRemote.prototype.disconnectBluetooth = function(serialOrName, btAddress, callback) {
    let dev = this.find(serialOrName, callback);
    if (!dev) return;
    let flags = {
        data: JSON.stringify({
            bluetoothDeviceAddress: btAddress
        }),
        method: 'POST'
    };
    this.httpsGet(`/api/bluetooth/disconnect-sink/${dev.deviceType}/${dev.serialNumber}`, callback, flags);
};

AlexaRemote.prototype.setDoNotDisturb = function(serialOrName, enabled, callback) {
    let dev = this.find(serialOrName, callback);
    if (!dev) return;
    let flags = {
        data: JSON.stringify({
            deviceSerialNumber: dev.serialNumber,
            deviceType: dev.deviceType,
            enabled: enabled
        }),
        method: 'PUT'
    };
    this.httpsGet(`//api/dnd/status`, callback, flags);
};

AlexaRemote.prototype.find = function(serialOrName, callback) {
    if (typeof serialOrName === 'object') return serialOrName;
    let dev = this.serialNumbers[serialOrName];
    if (dev !== undefined) return dev;
    dev = this.names[serialOrName];
    if (!dev) dev = this.names[serialOrName.toLowerCase()];
    if (!dev) dev = this.friendlyNames[serialOrName];
    if (!dev) callback.length >= 2 && callback('wrong serial or name', null);
    return dev;
};

AlexaRemote.prototype.setAlarmVolume = function(serialOrName, volume, callback) {
    let dev = this.find(serialOrName, callback);
    if (!dev) return;
    let flags = {
        data: JSON.stringify({
            deviceSerialNumber: dev.serialNumber,
            deviceType: dev.deviceType,
            softwareVersion: dev.softwareVersion,
            volumeLevel: volume
        }),
        method: 'PUT'
    };
    this.httpsGet(`/api/device-notification-state/${dev.deviceType}/${this.version}/${dev.serialNumber}&_=%t`, callback, flags);
};

AlexaRemote.prototype.sendCommand =
    AlexaRemote.prototype.sendMessage = function(serialOrName, command, value, callback) {
        let dev = this.find(serialOrName, callback);
        if (!dev) return;

        let o = {
            contentFocusClientId: null
        };
        switch (command) {
            case 'play':
            case 'pause':
            case 'next':
            case 'previous':
            case 'forward':
            case 'rewind':
                o.type = command.substr(0, 1).toUpperCase() + command.substr(1) + 'Command';
                break;
            case 'volume':
                o.type = 'VolumeLevelCommand';
                o.volumeLevel = ~~value;
                break;
            case 'shuffle':
                o.shuffle = value === 'on';
                break;
            case 'repeat':
                o.repeat = value === 'on';
                break;
            default:
                return;
        }

        this.httpsGet(`/api/np/command?deviceSerialNumber=${dev.serialNumber}&deviceType=${dev.deviceType}`,
            callback, {
                method: 'POST',
                data: JSON.stringify(o),
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
                }
                // Content-Type: application/x-www-form-urlencoded;
                // charset=UTF-8",#\r\n
                // Referer: https://alexa.amazon.de/spa/index.html'
            }
        );
    };


AlexaRemote.prototype.sendTextMessage = function(conversationId, text, callback) {
    let o = {
        type: 'message/text',
        payload: {
            text: text
        }
    };

    this.httpsGet(`https://alexa-comms-mobile-service.amazon.com/users/${this.commsId}/conversations/${conversationId}/messages`,
        callback, {
            method: 'POST',
            data: JSON.stringify(o),
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
            }
            // Content-Type: application/x-www-form-urlencoded;
            // charset=UTF-8",#\r\n
            // Referer: https://alexa.amazon.de/spa/index.html'
        }
    );
};


AlexaRemote.prototype.setList = function(serialOrName, listType, value, callback) {
    let dev = this.find(serialOrName, callback);
    if (!dev) return;
    let o = {
        type: listType,
        text: value,
        createdDate: this.now(),
        complete: false,
        deleted: false
    };

    this.httpsGet(`/api/todos?deviceSerialNumber=${dev.serialNumber}&deviceType=${dev.deviceType}`,
        callback, {
            method: 'POST',
            data: JSON.stringify(o),
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
            }
            // Content-Type: application/x-www-form-urlencoded;
            // charset=UTF-8",#\r\n
            // Referer: https://alexa.amazon.de/spa/index.html'
        }
    );
};

function _00(val) {
    let s = val.toString();
    while (s.length) s = '0' + s;
    return s;
}

AlexaRemote.prototype.setReminder = function(serialOrName, timestamp, label, callback) {
    let dev = this.find(serialOrName, callback);
    if (!dev) return;

    let time = new Date(timestamp);
    let o = {
        type: '"Reminder',
        status: "ON",
        alarmTime: timestamp,
        originalTime: `${_00 (time.getHours ())}:${_00 (time.getMinutes ())}:${_00 (time.getSeconds ())}.000`,
        originalDate: `${time.getFullYear ()}-${_00 (time.getMonth () + 1)}.${_00 (time.getDay ())}`,
        deviceSerialNumber: dev.serialNumber,
        deviceType: dev.deviceType,
        reminderLabel: label,
        isSaveInFlight: true,
        id: 'createReminder',
        createdDate: this.now()
    };
    this.httpsGet(`/api/notifications/createReminder`,
        callback, {
            method: 'PUT',
            data: JSON.stringify(o),
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
            }
            // Content-Type: application/x-www-form-urlencoded;
            // charset=UTF-8",#\r\n
            // Referer: https://alexa.amazon.de/spa/index.html'
        }
    );
};

AlexaRemote.prototype.getHomeGroup = function(callback) {
    this.httpsGet(`https://alexa-comms-mobile-service.amazon.com/users/${this.commsId}/identities?includeUserName=true`, callback);
};


function test() {
    AlexaRemote.prototype.getFeatureAlertLocation = function(callback) {
        alexa.httpsGet(`https://alexa.amazon.de/api/feature-alert-location?`, callback);
    };

    let alexa = AlexaRemote().init(cookie, function() {

        alexa.getHomeGroup(function(err, res) {
                res = res;
            });
            // alexa.getPlayer('wohnzimmer', function(err, res) {
            //     res = res;
            // })
        alexa.httpsGet(`https://alexa.amazon.de/api/devices-v2/device?cached=true&"`, function(err, res) {
            res = res;
        });


        //alexa.sendCommand('Wohnzimmer', 'volume', 20, function(res) {
        //alexa.sendCommand('Küche (Sonos)', 'play', 0, function(res) {
        alexa.sendCommand('wohnzimmer', 'play', 0, function(res) {
            res = res;
        });

        // alexa.tuneinSearch('wdr 4', alexa.ownerCustomerId, function(err, res) {
        //     res = res;
        //
        //     alexa.setTunein ('Schlafzimmer', res.browseList[0].id, alexa.ownerCustomerId, function(err, res) {
        //         res = res;
        //     });
        // })


        return;
        alexa.getHistory({
            filter: true
        }, function(res) {
            res = res;
        });
        alexa.tuneinSearch('wdr 4', alexa.ownerCustomerId, function(err, res) {
                res = res;

                //alexa.setTunein ('Schlafzimmer', res.browseList[0].id, alexa.ownerCustomerId, function(err, res) {
                alexa.setTunein('Wohnzimmer', res.browseList[0].id, alexa.ownerCustomerId, function(err, res) {
                    res = res;
                });
            });
            // alexa.getDeviceStatusList((ret) => {
            //     ret = ret;
            // })
            // alexa.getDevices((err, res) => {
            //     res = res;
            // });
            // alexa.getNotifications((err, res) => {
            //     res = res;
            // })
            // alexa.getBluetooth((err, res) => {
            //     res = res;
            // })
    });

}

AlexaRemote.prototype.getDevicePreferences = function(callback) {
    this.httpsGet('https://alexa.amazon.de/api/device-preferences?cached=true&_=%t', callback);
};

AlexaRemote.prototype.getSmarthomeDevices = function(callback) {
    this.httpsGet('https://alexa.amazon.de/api/phoenix?_=%t', function(err, res) {
        if (err || !res || !res.networkDetail) return callback(err, res);
        try {
            res = JSON.parse(res.networkDetail);
        } catch (e) {
            return callback('invalid JSON');
        }
        if (!res.locationDetails) return callback('locationDetails not found');
        callback(err, res.locationDetails);
    });
};

AlexaRemote.prototype.renameDevice = function(serialOrName, newName, callback) {
    let dev = this.find(serialOrName, callback);
    if (!dev) return;
    let o = {
        accountName: newName,
        serialNumber: dev.serialNumber,
        deviceAccountId: dev.deviceAccountId,
        deviceType: dev.deviceType,
        //deviceOwnerCustomerId: oo.deviceOwnerCustomerId
    };
    this.httpsGet(`https://alexa.amazon.de/api/devices-v2/device/${dev.serialNumber}`,
        callback, {
            method: 'PUT',
            data: JSON.stringify(o),
        }
    );
};


AlexaRemote.prototype.deleteSmarthomeDevice = function(smarthomeDevice, callback) {
    let flags = {
        method: 'DELETE'
            //data: JSON.stringify (o),
    };
    this.httpsGet(`https://alexa.amazon.de/api/phoenix/appliance/${smarthomeDevice}`, callback, flags);
};

AlexaRemote.prototype.deleteAllSmarthomeDevices = function(callback) {
    let flags = {
        method: 'DELETE'
            //data: JSON.stringify (o),
    };
    this.httpsGet(`https://alexa.amazon.de/api/phoenix`, callback, flags);
};



AlexaRemote.prototype.discoverSmarthomeDevice = function(callback) {
    let flags = {
        method: 'POST'
            //data: JSON.stringify (o),
    };
    this.httpsGet('https://alexa.amazon.de/api/phoenix/discovery', callback, flags);
};


AlexaRemote.prototype.unpaireBluetooth = function(serialOrName, btAddress, callback) {
    let dev = this.find(serialOrName, callback);
    if (!dev) return;
    let flags = {
        method: 'POST',
        data: JSON.stringify({
            bluetoothDeviceAddress: btAddress,
            bluetoothDeviceClass: "OTHER"
        })
    };
    this.httpsGet(`https://alexa.amazon.de/api/bluetooth/unpair-sink/${dev.deviceType}/${dev.serialNumber}`, callback, flags);
};

AlexaRemote.prototype.deleteDevice = function(serialOrName, callback) {
    let dev = this.find(serialOrName, callback);
    if (!dev) return;
    let flags = {
        method: 'DELETE',
        data: JSON.stringify({
            deviceType: dev.deviceType
        })
    };
    this.httpsGet(`https://alexa.amazon.de/api/devices/device/${dev.serialNumber}?deviceType=${dev.deviceType}`, callback, flags);
};

module.exports = AlexaRemote;