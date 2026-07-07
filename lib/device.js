const BaseDeviceBridge = require('homie-sdk/lib/Bridge/BaseDevice');
const BaseNodeBridge = require('homie-sdk/lib/Bridge/BaseNode');
const BasePropertyBridge = require('homie-sdk/lib/Bridge/BaseProperty');
const { config2smart } = require('./utils');
const openMeteo = require('./open-meteo');

const UPDATE_INTERVAL = 10 * 60 * 1000;
const DEFAULT_CITY = 'Moscow';
const DEFAULT_LATITUDE = 55.7558;
const DEFAULT_LONGITUDE = 37.6173;
const COORDS_RE = /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/;

const { create: createTransport } = require('./transport');
const { create: createParser } = require('./parser');

class DeviceBridge extends BaseDeviceBridge {
    constructor(config, { debug } = {}) {
        super(config, { debug });
        this.handleConnected = this.handleConnected.bind(this);
        this.handleDisconnected = this.handleDisconnected.bind(this);

        const transport = this._createPropertyTransport();

        transport.on('load.succeed', this.handleConnected);
        transport.on('load.error', this.handleDisconnected);

        const city = this._createCityOption(transport);

        this.addOption(city);

        const coordinates = this._createCoordinatesOption(transport);

        this.addOption(coordinates);

        const baseNode = this._createBaseNode(transport);

        this.addNode(baseNode);

        baseNode.connected = true;
    }

    get coordinatesInput() {
        const lat = config2smart.get('openweathermap.latitude');
        const lon = config2smart.get('openweathermap.longitude');

        if (typeof lat === 'number' && typeof lon === 'number') {
            return `${lat}, ${lon}`;
        }
        return '';
    }
    get city() {
        return config2smart.get('openweathermap.city') || DEFAULT_CITY;
    }
    get latitude() {
        const v = config2smart.get('openweathermap.latitude');

        return (typeof v === 'number') ? v : DEFAULT_LATITUDE;
    }
    get longitude() {
        const v = config2smart.get('openweathermap.longitude');

        return (typeof v === 'number') ? v : DEFAULT_LONGITUDE;
    }

    _createPropertyTransport() {
        return createTransport({
            type         : 'custom',
            pollInterval : UPDATE_INTERVAL,
            methods      : {
                async set() {
                    throw new Error('Property is not settable');
                },
                async get() {
                    const dev = this.bridge.deviceBridge;
                    const result = await this.loadCurrentWeather({
                        latitude  : dev.latitude,
                        longitude : dev.longitude
                    });

                    this.emit('load.succeed');
                    this.handleNewData(result);

                    return this.data;
                },
                async loadCurrentWeather({ latitude, longitude }) {
                    try {
                        const raw = await openMeteo.fetchCurrent({ latitude, longitude });

                        return openMeteo.toOWMShape(raw);
                    } catch (err) {
                        this.emit('load.error');
                        throw err;
                    }
                }
            },
            attachBridge() {
                this.enablePolling();
            },
            detachBridge() {
                this.disablePolling();
            }
        });
    }
    _createCityOption(transport) {
        const deviceBridge = this;

        return new BasePropertyBridge({
            id       : 'city',
            name     : 'City',
            dataType : 'string',
            settable : true,
            retained : true
        }, {
            type      : 'option',
            parser    : createParser('string'),
            transport : createTransport({
                type    : 'custom',
                data    : this.city,
                methods : {
                    async set(data) {
                        const cityName = String(data || '').trim();

                        if (!cityName) throw new Error('City must be a non-empty string');

                        // Try to resolve the city to coordinates so polling has the
                        // right location. Geocoding failures (no match, network down)
                        // should NOT prevent the user from saving the new city name —
                        // otherwise transient API errors block the option permanently.
                        let geo = null;
                        let geoError = null;

                        try {
                            geo = await openMeteo.geocode(cityName);
                        } catch (err) {
                            geoError = err;
                        }

                        if (geo) {
                            config2smart.set('openweathermap.latitude', geo.latitude);
                            config2smart.set('openweathermap.longitude', geo.longitude);
                        }
                        config2smart.set('openweathermap.city', this.city = cityName);
                        if (geo) {
                            // keep coordinates option in sync
                            const coordsStr = `${geo.latitude}, ${geo.longitude}`;

                            if (deviceBridge._coordsTransport) {
                                deviceBridge._coordsTransport.handleNewData(coordsStr);
                            }
                        }

                        // Best-effort refresh of sensors for the new location so the
                        // dashboard reflects the change immediately.
                        if (geo) {
                            try {
                                const fresh = await transport.loadCurrentWeather({
                                    latitude  : geo.latitude,
                                    longitude : geo.longitude
                                });

                                setImmediate(() => {
                                    transport.handleNewData(fresh);
                                    transport.emit('load.succeed');
                                });
                            } catch (_e) {
                                // ignore — polling will retry on its own interval
                            }
                        } else if (geoError) {
                            // eslint-disable-next-line no-console
                            console.warn(`[open-meteo] geocode failed for "${cityName}": ${geoError.message}; city saved without coordinate refresh`);
                        }

                        return this.city;
                    },
                    async get() {
                        return deviceBridge.city;
                    }
                }
            })
        });
    }
    _createCoordinatesOption(transport) {
        const deviceBridge = this;

        return new BasePropertyBridge({
            id       : 'coordinates',
            name     : 'Coordinates (lat, lon)',
            dataType : 'string',
            settable : true,
            retained : true
        }, {
            type      : 'option',
            parser    : createParser('string'),
            transport : deviceBridge._coordsTransport = createTransport({
                type    : 'custom',
                data    : this.coordinatesInput,
                methods : {
                    async set(data) {
                        const raw = String(data || '').trim();
                        const m = raw.match(COORDS_RE);

                        if (!m) throw new Error('Format: "latitude, longitude" e.g. "55.28, 37.96"');

                        const latitude = parseFloat(m[1]);
                        const longitude = parseFloat(m[2]);

                        config2smart.set('openweathermap.latitude', latitude);
                        config2smart.set('openweathermap.longitude', longitude);
                        // clear city so UI shows coordinates took priority
                        config2smart.set('openweathermap.city', `${latitude}, ${longitude}`);

                        try {
                            const fresh = await transport.loadCurrentWeather({ latitude, longitude });

                            setImmediate(() => {
                                transport.handleNewData(fresh);
                                transport.emit('load.succeed');
                            });
                        } catch (_e) {
                            // polling will retry
                        }

                        return `${latitude}, ${longitude}`;
                    },
                    async get() {
                        return deviceBridge.coordinatesInput;
                    }
                }
            })
        });
    }
    _createTempSensor(transport) {
        return new BasePropertyBridge({
            id       : 'temperature',
            name     : 'Temperature',
            settable : false,
            retained : true,
            unit     : '°C'
        }, {
            type   : 'sensor',
            parser : createParser({
                type          : 'custom',
                homieDataType : 'float',
                fromHomie() {
                    throw new Error('Unsupported');
                },
                toHomie(data) {
                    return `${data.main.temp}`;
                }
            }),
            transport
        });
    }
    _createTempFeelsLikeSensor(transport) {
        return new BasePropertyBridge({
            id       : 'temperature-feels-like',
            name     : 'Temperature feels like',
            settable : false,
            retained : true,
            unit     : '°C'
        }, {
            type   : 'sensor',
            parser : createParser({
                type          : 'custom',
                homieDataType : 'float',
                fromHomie() {
                    throw new Error('Unsupported');
                },
                toHomie(data) {
                    return `${data.main.feels_like}`;
                }
            }),
            transport
        });
    }
    _createTempMin(transport) {
        return new BasePropertyBridge({
            id       : 'temperature-min',
            name     : 'Temperature min',
            settable : false,
            retained : true,
            unit     : '°C'
        }, {
            type   : 'sensor',
            parser : createParser({
                type          : 'custom',
                homieDataType : 'float',
                fromHomie() {
                    throw new Error('Unsupported');
                },
                toHomie(data) {
                    return `${data.main.temp_min}`;
                }
            }),
            transport
        });
    }
    _createTempMax(transport) {
        return new BasePropertyBridge({
            id       : 'temperature-max',
            name     : 'Temperature max',
            settable : false,
            retained : true,
            unit     : '°C'
        }, {
            type   : 'sensor',
            parser : createParser({
                type          : 'custom',
                homieDataType : 'float',
                fromHomie() {
                    throw new Error('Unsupported');
                },
                toHomie(data) {
                    return `${data.main.temp_max}`;
                }
            }),
            transport
        });
    }
    _createPressure(transport) {
        return new BasePropertyBridge({
            id       : 'pressure',
            name     : 'Pressure',
            settable : false,
            retained : true,
            unit     : 'rhm'
        }, {
            type   : 'sensor',
            parser : createParser({
                type          : 'custom',
                homieDataType : 'float',
                fromHomie() {
                    throw new Error('Unsupported');
                },
                toHomie(data) {
                    return `${data.main.pressure}`;
                }
            }),
            transport
        });
    }
    _createHumidity(transport) {
        return new BasePropertyBridge({
            id       : 'humidity',
            name     : 'Humidity',
            settable : false,
            retained : true,
            unit     : '%'
        }, {
            type   : 'sensor',
            parser : createParser({
                type          : 'custom',
                homieDataType : 'float',
                fromHomie() {
                    throw new Error('Unsupported');
                },
                toHomie(data) {
                    return `${data.main.humidity}`;
                }
            }),
            transport
        });
    }
    _createWindSpeed(transport) {
        return new BasePropertyBridge({
            id       : 'wind-speed',
            name     : 'Wind speed',
            settable : false,
            retained : true,
            unit     : 'm/s'
        }, {
            type   : 'sensor',
            parser : createParser({
                type          : 'custom',
                homieDataType : 'float',
                fromHomie() {
                    throw new Error('Unsupported');
                },
                toHomie(data) {
                    return `${data.wind.speed}`;
                }
            }),
            transport
        });
    }
    _createWindDeg(transport) {
        return new BasePropertyBridge({
            id       : 'wind-deg',
            name     : 'Wind deg',
            settable : false,
            retained : true,
            unit     : '°'
        }, {
            type   : 'sensor',
            parser : createParser({
                type          : 'custom',
                homieDataType : 'float',
                fromHomie() {
                    throw new Error('Unsupported');
                },
                toHomie(data) {
                    return `${data.wind.deg}`;
                }
            }),
            transport
        });
    }
    _createWeather(transport) {
        return new BasePropertyBridge({
            id       : 'weather',
            name     : 'Weather',
            settable : false,
            retained : true,
            unit     : ''
        }, {
            type   : 'sensor',
            parser : createParser({
                type          : 'custom',
                homieDataType : 'string',
                fromHomie() {
                    throw new Error('Unsupported');
                },
                toHomie(data) {
                    return `${data.weather.length && data.weather[0].description}`;
                }
            }),
            transport
        });
    }
    _createSunrise(transport) {
        return new BasePropertyBridge({
            id       : 'sunrise',
            name     : 'Sunrise',
            settable : false,
            retained : true,
            unit     : ''
        }, {
            type   : 'sensor',
            parser : createParser({
                type          : 'custom',
                homieDataType : 'string',
                fromHomie() {
                    throw new Error('Unsupported');
                },
                toHomie(data) {
                    return `${new Date(data.sys.sunrise * 1000)}`;
                }
            }),
            transport
        });
    }
    _createSunset(transport) {
        return new BasePropertyBridge({
            id       : 'sunset',
            name     : 'Sunset',
            settable : false,
            retained : true,
            unit     : ''
        }, {
            type   : 'sensor',
            parser : createParser({
                type          : 'custom',
                homieDataType : 'string',
                fromHomie() {
                    throw new Error('Unsupported');
                },
                toHomie(data) {
                    return `${new Date(data.sys.sunset * 1000)}`;
                }
            }),
            transport
        });
    }
    _createBaseNode(transport) {
        return new BaseNodeBridge({
            id      : 'sensors',
            name    : 'Sensors',
            sensors : [
                this._createTempSensor(transport),
                this._createTempFeelsLikeSensor(transport),
                this._createTempMin(transport),
                this._createTempMax(transport),
                this._createPressure(transport),
                this._createHumidity(transport),
                this._createWindSpeed(transport),
                this._createWindDeg(transport),
                this._createWeather(transport),
                this._createSunrise(transport),
                this._createSunset(transport)
            ]
        });
    }

    // sync
    attachBridge(bridge) {
        super.attachBridge(bridge);
    }

    detachBridge() {
        super.detachBridge();
    }

    // async

    // handlers
    handleConnected() {
        this.connected = true;
    }
    handleDisconnected() {
        this.connected = false;
    }
}

module.exports = DeviceBridge;
