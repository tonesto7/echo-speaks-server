const request = require('request');
const reqPromise = require("request-promise");
const logger = require('./logger');
const querystring = require('querystring');
const alexaCookie = require('./alexa-cookie/alexa-cookie');
const editJsonFile = require("edit-json-file", {
  autosave: true
});
const dataFolder = require('os').homedir() + '/.echo-speaks';
const sessionFile = editJsonFile(dataFolder + '/session.json');

let alexaUrl = 'https://alexa.amazon.com';
let sessionData = sessionFile.get() || {};
let serviceDebug = false;
let serviceTrace = false;
let serverVersion = '';
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
    if (alexaOptions.useHeroku === false || alexaOptions.checkForCookie === false) {
      resolve(undefined);
    }
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
  serverVersion = alexaOptions.serverVersion;
  let devicesArray = [];
  let deviceSerialNumber;
  let deviceType;
  let deviceOwnerCustomerId;
  let config = {};
  config.devicesArray = devicesArray;
  config.deviceSerialNumber = deviceSerialNumber;
  config.deviceType = deviceType;
  config.deviceOwnerCustomerId = deviceOwnerCustomerId;
  config.alexaURL = alexaOptions.amazonPage;
  serviceDebug = (alexaOptions.debug === true);
  serviceTrace = (alexaOptions.trace === true);

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
            alexaUrl = 'https://alexa.' + alexaOptions.amazonPage;
            // IMPORTANT: can be called multiple times!! As soon as a new cookie is fetched or an error happened. Consider that!
            serviceDebug && logger.debug('cookie: ' + result.cookie || undefined);
            serviceDebug && logger.debug('csrf: ' + result.csrf || undefined);
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
              if (alexaOptions.stEndpoint && alexaOptions.useHeroku) {
                clearSession(alexaOptions.stEndpoint, alexaOptions.useHeroku);
              }
            }
          }
        });
      }
    });
};

function sendCookiesToST(url, cookie, csrf) {
  return new Promise(resolve => {
    if (url && cookie && csrf) {
      let options = {
        method: 'POST',
        uri: url,
        body: {
          cookie: cookie,
          csrf: csrf,
          version: serverVersion
        },
        json: true
      };
      reqPromise(options)
        .then(function(resp) {
          // console.log('resp:', resp);
          if (resp) {
            logger.info(`** Alexa Cookie sent to SmartThings Cloud Endpoint Successfully! **`);
            resolve(true);
          } else {
            resolve(false);
          }
        })
        .catch(function(err) {
          logger.error("ERROR: Unable to send Alexa Cookie to SmartThings: " + err.message);
          resolve(false);
        });
    }
  });
};

function getCookiesFromST(url) {
  return new Promise(resolve => {
    reqPromise({
        method: 'GET',
        uri: url,
        headers: {
          serverVersion: serverVersion
        },
        json: true
      })
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

let checkAuthentication = function(config, callback) {
  request({
    method: 'GET',
    url: `${alexaUrl}/api/bootstrap?version=0`,
    headers: {
      'Cookie': config.cookies,
      'csrf': config.csrf
    },
    json: true
  }, function(error, response, body) {
    // console.log("checkAuthentication resp: ", response, 'body:', body);
    if (!error && response.statusCode === 200) {
      callback(null, {
        result: (body && body.authentication && body.authentication.authenticated !== false)
      });
    } else {
      callback(null, {
        result: true
      });
    }
  });
};

exports.alexaLogin = alexaLogin;
exports.clearSession = clearSession;
exports.sendCookiesToST = sendCookiesToST;
exports.getRemoteCookie = getRemoteCookie;