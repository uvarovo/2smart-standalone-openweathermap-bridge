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
        config2smart.init("/etc/openweathermap/config.json");

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


        // Apply CITY / COORDINATES from env vars (set via bridge settings UI).
        // ENV always wins — changing settings in UI recreates the container with new env,
        // so we always write env values to config. Manual MQTT option changes
        // (via $options/city or $options/coordinates) are stored in the same config file
        // and will be used on the next restart unless the user changes settings again.
        const COORDS_RE_ENV = /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/;
        const envCoords = (process.env.COORDINATES || '').trim();
        const envCity   = (process.env.CITY || '').trim();

        if (envCoords && COORDS_RE_ENV.test(envCoords)) {
            const [ , lat, lon ] = envCoords.match(COORDS_RE_ENV);

            config2smart.set('openweathermap.latitude', parseFloat(lat));
            config2smart.set('openweathermap.longitude', parseFloat(lon));
            config2smart.set('openweathermap.city', `${parseFloat(lat)}, ${parseFloat(lon)}`);
        } else if (envCity) {
            // Clear old coordinates so the device geocodes the new city on startup
            config2smart.set('openweathermap.city', envCity);
            config2smart.set('openweathermap.latitude', null);
            config2smart.set('openweathermap.longitude', null);
        }

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
