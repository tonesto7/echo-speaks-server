const reqPromise = require("request-promise");

let cookie = 'session-id=140-4391698-6987643; session-id-time=2198946136l; ubid-main=132-5708901-8785568; x-main=EfG8dnZee80dJc96Zbiv59tG0e@FDYRc; at-main=Atza|IwEBIBeMYpaCKsK6Y9q2J_U2OdNlSlvWpDjquG5xClr0yompQctq04NXx_LeKHJujNqQ73VlKgyVZ3IkLX0JGD0a8auXuMArFIsr4B5MoPF9ZQs_Xbh4tw6zpM246QSPdkPyBU1N1l1NmxJteWHI0IUEKLP1fvHRW5eQdaFUE_ryaJf3u01OR0OpFdEtLySSn3QOfCzCSyPr_CbFQpu0mZmrw0nEMhpH0JTyp0IH1TiTpVON3He0uUxnLw4TsnqYpSzfy6edD1Xc_Zu8x9hEOvGrIe6_kc5x4UUGKSGlLsNJlSwiHvpGosmXU3BHXoDQKvVGdNCaw0-Dzryq5a8OJUFkA942o0JmZGtbSTexHnXLz-plNtSiOJcWFsiZ1AjJHZmYXNnE70XVZwor0yb-iImRLVlmbu4WFryH0qoMisalRWuYNM9psHrwjTYhQXDiD4r9Ns4GXtcCxka11mVOlGfvfOU3; sess-at-main=BTHOWx0pVuTiHO3TFOvpjfrYzm73J4KUarP/KrFEHA8=; csrf=600002164';
let csrf = '600002164';

function getGuardDataSupport(cookieData) {
    return new Promise(resolve => {
        let runTimeData = {
            alexaUrl: 'https://alexa.amazon.com'
        }
        let sessionData = {
            cookieData: {
                localCookie: cookie,
                csrf: csrf
            }
        };
        let cData = cookieData || sessionData.cookieData;
        if (runTimeData.alexaUrl && cData) {
            let options = {
                method: 'GET',
                uri: `${runTimeData.alexaUrl}/api/phoenix`,
                query: {
                    'cached': true,
                    '_': new Date().getTime()
                },
                headers: {
                    cookie: cData.localCookie,
                    csrf: cData.csrf
                },
                json: true
            };

            reqPromise(options)
                .then(function(resp) {
                    // console.log('guardresp:', resp);
                    if (resp && resp.networkDetail) {
                        let details = JSON.parse(resp.networkDetail);
                        let locDetails = details.locationDetails.locationDetails.Default_Location.amazonBridgeDetails.amazonBridgeDetails["LambdaBridge_AAA/OnGuardSmartHomeBridgeService"] || undefined;
                        if (locDetails && locDetails.applianceDetails && locDetails.applianceDetails.applianceDetails) {
                            let applKey = Object.keys(locDetails.applianceDetails.applianceDetails).filter(i => {
                                return i.includes("AAA_OnGuardSmartHomeBridgeService_");
                            });
                            if (Object.keys(applKey).length >= 1) {
                                let guardData = locDetails.applianceDetails.applianceDetails[applKey[0]]
                                    // console.log('guardData: ', guardData);
                                if (guardData.modelName === "REDROCK_GUARD_PANEL") {
                                    let gData = {
                                        entityId: guardData.entityId,
                                        applianceId: guardData.applianceId,
                                        friendlyName: guardData.friendlyName,
                                        supported: true
                                    };
                                    console.log(JSON.stringify(gData));
                                    sendGuardDataToEndpoint(gData);
                                    logger.info(`** Alexa Guard Data sent to ${configData.settings.hubPlatform} Cloud Endpoint Successfully! **`);
                                    resolve(true);
                                } else {
                                    logger.error("getGuardDataSupport Error | No Guard Appliance Data found...")
                                    resolve(false);
                                }
                            } else {
                                logger.error("getGuardDataSupport Error | No Guard Appliance Details found...")
                                resolve(false);
                            }
                        } else {
                            logger.error("getGuardDataSupport Error | No Guard Appliance Location Data found...")
                            resolve(false);
                        }

                    } else {
                        logger.error("getGuardDataSupport Error | No Guard Response Data Received...")
                        resolve(false);
                    }
                })
                .catch(function(err) {
                    logger.error(`ERROR: Unable to send Alexa Guard Data to ${configData.settings.hubPlatform}: ` + err.message);
                    resolve(false);
                });
        } else {
            resolve(false)
        }
    });
}
async function test() {
    await getGuardDataSupport();
};

test();