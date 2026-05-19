const path                        = require('path');
const { createHash }              = require('crypto');
const { promises: { writeFile } } = require('fs');
const fs                          = require('fs-extra');
const { Validator }               = require('livr');
const { getRandomId }             = require('homie-sdk/lib/utils/index');
const Debugger                    = require('homie-sdk/lib/utils/debugger');

const { config2smart }           = require('./lib/utils');
const createOpenWeatherMapBridge = require('./app');
const { name }                   = require('./config/openweathermap');

const CONFIG_PATH             = path.join('/', 'config', 'config.json');
const CONFIG_VALIDATION_RULES = {
    mqttUri         : [ 'required', 'string' ],
    userEmail       : [ 'required', 'email' ],
    productId       : [ 'required', 'string' ],
    token           : [ 'required', 'string' ],
    deviceId        : [ 'string' ],
    firmwareVersion : [ 'string' ],
    // openWeatherMap was previously used to pass the OpenWeatherMap API key.
    // Kept as an optional, free-form nested object for backward compatibility
    // with cloud configs that still ship it; the value is unused now.
    openWeatherMap  : [ ]
};

const readJson = filepath => require(filepath); // eslint-disable-line func-style

const validateObj = (obj, rules) => { // eslint-disable-line func-style
    const validator = new Validator(rules);
    const validData = validator.validate(obj);

    return validData ?
        {
            isValid : true,
            data    : validData,
            errors  : {}
        } :
        {
            isValid : false,
            data    : {},
            errors  : validator.getErrors()
        };
};

(async function main() {
    try {
        const config = readJson(CONFIG_PATH);

        Validator.defaultAutoTrim(true);

        const { isValid, data : validatedConfig, errors } = validateObj(config, CONFIG_VALIDATION_RULES);

        if (!isValid) {
            throw new Error(`Config validation errors: ${JSON.stringify(errors)}`);
        }

        fs.ensureDirSync(path.resolve('./etc/openweathermap')); // eslint-disable-line no-sync
        config2smart.init(path.resolve('./etc/openweathermap/config.json'));

        const {
            mqttUri,
            userEmail,
            token : password,
            productId,
            openWeatherMap,
            firmwareVersion
        } = validatedConfig;

        let { deviceId } = validatedConfig;

        if (!deviceId) {
            deviceId = getRandomId();
            const newConfig = { ...validatedConfig, deviceId };

            await writeFile(CONFIG_PATH, JSON.stringify(newConfig, null, 2));
        }

        const hash = createHash('sha256').update(userEmail).digest('hex');
        const username = hash;
        const rootTopic = hash;

        const deviceBridgeConfig = {
            smartMqttConnection : {
                username,
                password,
                uri : mqttUri,
                rootTopic
            },
            // Unused since the bridge switched to Open-Meteo (no API key needed);
            // accepted for backward compatibility only.
            openWeatherMap : openWeatherMap || {},
            device         : {
                id              : deviceId,
                name,
                firmwareName    : productId,
                firmwareVersion : firmwareVersion || 1
            }
        };

        const debug = new Debugger('MQTTTransport.handleClose;MQTTTransport.handleConnect');

        const openWeatherMapBridge = createOpenWeatherMapBridge({ deviceBridgeConfig, debug });

        openWeatherMapBridge.on('error', (error) => {
            debug.error(error);
        });
        openWeatherMapBridge.on('exit', (reason, exit_code) => {
            debug.error(reason);
            process.exit(exit_code);
        });

        openWeatherMapBridge.init();
    } catch (err) {
        console.error(err);

        process.exit(1);
    }
}());
