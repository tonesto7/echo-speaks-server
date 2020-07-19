# alexa-cookie

Library to generate/retrieve a cookie including a csrf for alexa remote

<!--
[![NPM version](http://img.shields.io/npm/v/alexa-remote.svg)](https://www.npmjs.com/package/alexa-remote)
[![Tests](http://img.shields.io/travis/soef/alexa-remote/master.svg)](https://travis-ci.org/soef/alexa-remote)
-->
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat)](https://github.com/soef/alexa-remote/blob/master/LICENSE)

## Description
This library can be used to get the cookies needed to access Amazon Alexa services from outside. It authenticates with Amazon and gathers all needed details. These details are returned in the callback.
If the automatic authentication fails (which is more common case in the meantime because of security checks from amazon like a needed Captcha or because you enabled two factor authentication) the library can also setup a proxy server to allow the manual login and will catch the cookie by itself. Using this proxy you can enter needed 2FA codes or solve captchas and still do not need to trick around to get the cookie.

Starting with version 2.0 of this library the proxy approach was changed to be more "as the Amazon mobile Apps" which registers a device at Amazon and uses OAuth tokens to handle the automatic refresh of the cookies afterwards. This should work seamless. A cookie is valid for 14 days, so it is preferred to refresh the cookie after 5-13 days (please report if it should be shorter).

## Example:
See example folder!

* **example.js** shows how to use the library to initially get a cookie
* **refresh.js** shown how to use the library to refresh the cookies


## Usage
Special note for callback return for parameter result:

### When automatic cookie retrieval worked (uncommon)
If the library was able to automatically log you in and get the cookie (which is the more uncommon case in the meantime) the object returned will contain keys "cookie" and "csrf" to use.

### When proxy was used (preferred and more common case)
If the Proxy was used (or especially when "proxyOnly" was set in options) then result is a object with much more data.

Important for the further interaction with alexa are the keys "localCookie" (same as "cookie" above) and pot. "crsf". I decided for different keys to make sure the next lines are understood by the developer ...

**Please store the returned object and provide this object in all subsequent calls to the library in the options object in key "formerRegistrationData" as shown in the example!**

If you not do this a new device is created each time the proxy is used which can end up in having many unused devices (such a device is like a mobile phone where you use the Alexa App with).

Please use the new method "refreshAlexaCookie" to refresh the cookie data. It takes the same options object as the other method and requires the key "formerRegistrationData". It returns an updated object will all data as above. Please also store this and provide for susequent calls!

## Thanks:
A big thanks go to soef for the initial version of this library.

Partly based on [Amazon Alexa Remote Control](http://blog.loetzimmer.de/2017/10/amazon-alexa-hort-auf-die-shell-echo.html) (PLAIN shell) and [alexa-remote-control](https://github.com/thorsten-gehrig/alexa-remote-control) and the the Proxy idea from [OpenHab-Addon](https://github.com/openhab/openhab2-addons/blob/f54c9b85016758ff6d271b62d255bbe41a027928/addons/binding/org.openhab.binding.amazonechocontrol). Also the new way to refresh cookie and all needed changes were developed in close cooperation with @mgeramb
Thank you for that work.

## Changelog:

### 2.0.1
* (Apollon77) Fix refresh problem, hopefully

### 2.0.0
* (Apollon77) Switch Proxy approach to use device registration logic and allow refreshing of cookies. Be aware: Breaking changes in API!!

### 1.0.3
* (Apollon77) try to better handle relative redirects from amazon (seen by 2FA checks)

### 1.0.2
* (Apollon77) more Amazon tweaks

### 1.0.1
* (Apollon77) better handle errors in automatic cookie generation

### 1.0.0
* (Apollon77) handle Amazon change

### 0.2.x
* (Apollon77) 0.2.2: fix encoding of special characters in email and password
* (Apollon77) 0.2.1: Cleanup to prepare release
* (Apollon77) 0.2.0: Add option to use a proxy to also retrieve the credentials if the automatic retrieval fails
* (Apollon77) 0.2.0: Optimize automatic cookie retrieval, remove MacOS user agent again because the Linux one seems to work better

### 0.1.x
* (Apollon77) 0.1.3: Use specific User-Agents for Win32, MacOS and linux based platforms
* (Apollon77) 0.1.2: Log the used user-Agent, Accept-Language and Login-URL
* (Apollon77) 0.1.1: update to get it working again and sync to [alexa-remote-control](https://github.com/thorsten-gehrig/alexa-remote-control)

### 0.0.x
* Versions by soef
