const https = require('https');

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

const CURRENT_FIELDS = [
    'temperature_2m',
    'relative_humidity_2m',
    'apparent_temperature',
    'pressure_msl',
    'wind_speed_10m',
    'wind_direction_10m',
    'weather_code'
].join(',');
const DAILY_FIELDS = [
    'temperature_2m_max',
    'temperature_2m_min',
    'sunrise',
    'sunset'
].join(',');

const WMO_CODE_TEXT = {
    0  : 'clear sky',
    1  : 'mainly clear',
    2  : 'partly cloudy',
    3  : 'overcast',
    45 : 'fog',
    48 : 'depositing rime fog',
    51 : 'light drizzle',
    53 : 'moderate drizzle',
    55 : 'dense drizzle',
    56 : 'light freezing drizzle',
    57 : 'dense freezing drizzle',
    61 : 'slight rain',
    63 : 'moderate rain',
    65 : 'heavy rain',
    66 : 'light freezing rain',
    67 : 'heavy freezing rain',
    71 : 'slight snow fall',
    73 : 'moderate snow fall',
    75 : 'heavy snow fall',
    77 : 'snow grains',
    80 : 'slight rain showers',
    81 : 'moderate rain showers',
    82 : 'violent rain showers',
    85 : 'slight snow showers',
    86 : 'heavy snow showers',
    95 : 'thunderstorm',
    96 : 'thunderstorm with slight hail',
    99 : 'thunderstorm with heavy hail'
};

function buildQuery(params) {
    return Object.keys(params)
        .filter(k => params[k] !== undefined && params[k] !== null)
        .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
        .join('&');
}

function httpGetJson(url, { timeoutMs = 8000 } = {}) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, (res) => {
            const chunks = [];

            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');

                if (res.statusCode < 200 || res.statusCode >= 300) {
                    const err = new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`);

                    err.statusCode = res.statusCode;
                    reject(err);

                    return;
                }
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    reject(new Error(`Bad JSON: ${e.message}`));
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
        });
    });
}

async function geocode(name) {
    const qs = buildQuery({
        name,
        count    : 1,
        language : 'en',
        format   : 'json'
    });
    const data = await httpGetJson(`${GEOCODING_URL}?${qs}`);

    if (!data.results || !data.results.length) return null;

    const r = data.results[0];

    return {
        name      : r.name,
        country   : r.country || '',
        latitude  : r.latitude,
        longitude : r.longitude
    };
}

async function fetchCurrent({ latitude, longitude }) {
    const qs = buildQuery({
        latitude,
        longitude,
        current         : CURRENT_FIELDS,
        daily           : DAILY_FIELDS,
        timezone        : 'auto',
        wind_speed_unit : 'ms'
    });

    return httpGetJson(`${FORECAST_URL}?${qs}`);
}

function toUnixSeconds(isoOrSec) {
    if (!isoOrSec) return 0;
    if (typeof isoOrSec === 'number') return isoOrSec;
    const ts = Date.parse(isoOrSec);

    return Number.isFinite(ts) ? Math.floor(ts / 1000) : 0;
}

// Translate an Open-Meteo forecast response into an OpenWeatherMap-shaped
// object, so the existing property parsers (which read `data.main.*`,
// `data.wind.*`, `data.weather[0].description`, `data.sys.*`) keep working
// without any changes.
function toOWMShape(omResp) {
    const current = omResp.current || {};
    const daily = omResp.daily || {};
    const dailyMin = daily.temperature_2m_min || [];
    const dailyMax = daily.temperature_2m_max || [];
    const sunriseArr = daily.sunrise || [];
    const sunsetArr = daily.sunset || [];
    const weatherCode = current.weather_code;
    const description = WMO_CODE_TEXT[weatherCode] || `code ${weatherCode}`;

    return {
        cod  : 200,
        main : {
            temp       : current.temperature_2m,
            feels_like : current.apparent_temperature,
            temp_min   : dailyMin[0],
            temp_max   : dailyMax[0],
            pressure   : current.pressure_msl,
            humidity   : current.relative_humidity_2m
        },
        wind : {
            speed : current.wind_speed_10m,
            deg   : current.wind_direction_10m
        },
        weather : [ { description, id: weatherCode } ],
        sys     : {
            sunrise : toUnixSeconds(sunriseArr[0]),
            sunset  : toUnixSeconds(sunsetArr[0])
        }
    };
}

module.exports = {
    geocode,
    fetchCurrent,
    toOWMShape,
    WMO_CODE_TEXT,
    httpGetJson
};
