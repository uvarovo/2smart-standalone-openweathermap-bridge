const path     = require('path');
const fs       = require('fs-extra');
const Debugger = require('homie-sdk/lib/utils/debugger');

const { config2smart }           = require('./lib/utils');
const createOpenWeatherMapBridge = require('./app');

const {
    MQTT_USER,
    MQTT_PASS,
    MQTT_URI,
    DEVICE_ID,
    DEVICE_NAME,
    DEVICE_IMPLEMENTATION,
    DEVICE_MAC,
    DEVICE_FIRMWARE_VERSION,
    DEVICE_FIRMWARE_NAME
} = process.env;

(async () => {
    const debug = new Debugger(process.env.DEBUG || '');

    debug.initEvents();

    try {
        fs.ensureDirSync(path.resolve('./etc/openweathermap')); // eslint-disable-line no-sync
        config2smart.init(path.resolve('./etc/openweathermap/config.json'));

        const deviceBridgeConfig = {
            smartMqttConnection : {
                username : MQTT_USER,
                password : MQTT_PASS,
                uri      : MQTT_URI
            },
            // Kept for backward compatibility with existing market installs;
            // unused since the bridge now uses Open-Meteo (no API key required).
            openWeatherMap : {},
            device         : {
                id              : DEVICE_ID || MQTT_USER,
                name            : DEVICE_NAME,
                implementation  : DEVICE_IMPLEMENTATION,
                mac             : DEVICE_MAC,
                firmwareVersion : DEVICE_FIRMWARE_VERSION,
                firmwareName    : DEVICE_FIRMWARE_NAME
            }
        };

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
        debug.error(err);

        process.exit(1);
    }
})();
