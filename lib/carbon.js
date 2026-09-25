/**
 * Carbon intensity providers.
 *
 * Supports:
 *   - ElectricityMaps API v3 (real-time, requires API key)
 *   - Auto-country: IP geolocation + bundled country-average dataset
 *   - Fixed fallback from user settings
 */
import GLib from 'gi://GLib';
import { bytesToString, readFile } from './utils.js';

// ---------------------------------------------------------------------------
// Lazy Soup import (tries Soup 3, then Soup 2)
// ---------------------------------------------------------------------------

let _Soup = undefined; // undefined = not tried, null = unavailable

async function getSoup() {
    if (_Soup !== undefined) return _Soup;
    try {
        const mod3 = await import('gi://Soup?version=3.0');
        _Soup = mod3.default;
    } catch (_) {
        try {
            const mod2 = await import('gi://Soup');
            _Soup = mod2.default;
        } catch (_2) {
            console.warn('CO2 Monitor: libsoup not available; HTTP disabled');
            _Soup = null;
        }
    }
    return _Soup;
}

/** Reset Soup cache on disable. */
export function resetSoupCache() {
    _Soup = undefined;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function httpGet(url, headers = {}, cancellable = null) {
    const Soup = await getSoup();
    if (!Soup) return null;
    const session = new Soup.Session();
    const msg = Soup.Message.new('GET', url);
    for (const [k, v] of Object.entries(headers))
        msg.request_headers.append(k, v);
    const bytes = await new Promise((resolve, reject) => {
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (_sess, res) => {
            try { resolve(session.send_and_read_finish(res)); }
            catch (e) { reject(e); }
        });
    });
    return bytesToString(bytes);
}

// ---------------------------------------------------------------------------
// ElectricityMaps provider
// ---------------------------------------------------------------------------

/**
 * Fetch real-time carbon intensity from ElectricityMaps API v3.
 * Returns gCO2eq/kWh or null on failure.
 */
export async function fetchElectricityMapsIntensity(apiKey, zone, cancellable = null) {
    if (!apiKey || !zone) return null;
    try {
        const url = `https://api.electricitymap.org/v3/carbon-intensity/latest?zone=${encodeURIComponent(zone)}`;
        const text = await httpGet(url, { 'auth-token': apiKey }, cancellable);
        if (!text) return null;
        const obj = JSON.parse(text);
        if (obj?.carbonIntensity) return obj.carbonIntensity;
    } catch (e) {
        console.warn(`CO2 Monitor: ElectricityMaps fetch error: ${e}`);
    }
    return null;
}

// ---------------------------------------------------------------------------
// IP geolocation (for auto-country provider)
// ---------------------------------------------------------------------------

let _geoCache = { code: null, ts: 0 };
const GEO_CACHE_MAX_AGE = 6 * 3600; // 6 hours

async function detectCountryCode(cancellable = null) {
    try {
        const text = await httpGet('https://ipapi.co/json/', {}, cancellable);
        if (!text) return null;
        const obj = JSON.parse(text);
        const code = obj?.country_code;
        if (typeof code === 'string' && code.length >= 2) return code;
    } catch (e) {
        console.warn(`CO2 Monitor: geolocation error: ${e}`);
    }
    return null;
}

export async function getCachedCountryCode(cancellable = null) {
    const now = Date.now() / 1000;
    if (_geoCache.code && (now - _geoCache.ts) < GEO_CACHE_MAX_AGE)
        return _geoCache.code;
    const code = await detectCountryCode(cancellable);
    if (code) _geoCache = { code, ts: now };
    return code;
}

/** Reset geolocation cache on disable. */
export function resetGeoCache() {
    _geoCache = { code: null, ts: 0 };
}

// ---------------------------------------------------------------------------
// Bundled country-average intensity dataset
// ---------------------------------------------------------------------------

const COUNTRY_INTENSITY_BUILTIN = {
    'US': 388, 'CA': 150, 'FR': 60, 'DE': 340, 'GB': 230, 'UK': 230,
    'ES': 180, 'IT': 300, 'SE': 30, 'NO': 30, 'FI': 120, 'PL': 700,
    'NL': 400, 'BE': 200, 'CH': 30, 'AT': 120, 'DK': 200, 'IE': 300,
    'PT': 180, 'CZ': 520, 'HU': 270, 'RO': 300, 'BG': 420, 'GR': 430,
    'TR': 440, 'RU': 420, 'CN': 600, 'IN': 700, 'JP': 450, 'KR': 500,
    'AU': 600, 'NZ': 120, 'BR': 90, 'MX': 430, 'ZA': 800,
};

let _countryMap = null;

/**
 * Load country intensity map, merging bundled JSON over built-in fallback.
 * @param {string|null} basePath - Extension base directory
 */
export async function loadCountryIntensityMap(basePath) {
    if (_countryMap) return _countryMap;
    if (!basePath) {
        _countryMap = COUNTRY_INTENSITY_BUILTIN;
        return _countryMap;
    }
    try {
        const jsonPath = GLib.build_filenamev([basePath, 'data', 'country_intensity.json']);
        const text = await readFile(jsonPath);
        if (text) {
            const obj = JSON.parse(text);
            if (obj && typeof obj === 'object') {
                _countryMap = Object.freeze({ ...COUNTRY_INTENSITY_BUILTIN, ...obj });
                return _countryMap;
            }
        }
    } catch (e) {
        console.warn(`CO2 Monitor: failed to load bundled country intensities: ${e}`);
    }
    _countryMap = COUNTRY_INTENSITY_BUILTIN;
    return _countryMap;
}

/** Reset country map cache on disable. */
export function resetCountryMapCache() {
    _countryMap = null;
}

// ---------------------------------------------------------------------------
// Auto-country intensity
// ---------------------------------------------------------------------------

/**
 * Get carbon intensity by detecting country via IP and looking up the average.
 * Returns { intensity: number, code: string } or null.
 */
export async function autoCountryIntensity(basePath, cancellable = null) {
    const code = await getCachedCountryCode(cancellable);
    if (!code) return null;
    const map = await loadCountryIntensityMap(basePath);
    const val = map[code] || (code === 'GB' ? map['UK'] : undefined);
    if (typeof val === 'number' && val > 0) {
        const normCode = code === 'GB' ? 'UK' : code;
        return { intensity: val, code: normCode };
    }
    return null;
}

// ---------------------------------------------------------------------------
// Unified intensity resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the current carbon intensity.
 *
 * @param {object} opts
 * @param {boolean} opts.useOnline - Whether online providers are enabled
 * @param {string} opts.provider - 'electricitymaps' or 'auto-country'
 * @param {string} opts.apiKey - ElectricityMaps API key
 * @param {string} opts.zone - ElectricityMaps zone override
 * @param {boolean} opts.autoDetectZone - Auto-detect zone from IP
 * @param {number} opts.fixedIntensity - Fallback fixed value
 * @param {string|null} opts.basePath - Extension base path
 * @param {{ value: number|null, ts: number }} opts.cache - Provider cache
 * @param {number} opts.cacheTtl - Cache TTL in seconds
 * @param {Gio.Cancellable|null} [opts.cancellable] - Aborts in-flight HTTP requests
 * @returns {Promise<{ intensity: number, source: string, countryCode: string|null }>}
 */
export async function resolveIntensity(opts) {
    const {
        useOnline, provider, apiKey, zone, autoDetectZone,
        fixedIntensity, basePath, cache, cacheTtl, cancellable = null,
    } = opts;

    if (!useOnline) {
        return { intensity: fixedIntensity, source: 'fixed', countryCode: null };
    }

    // Check cache first
    const now = Date.now() / 1000;
    if (cache.value !== null && (now - cache.ts) < cacheTtl) {
        return { intensity: cache.value, source: cache.source || 'cached', countryCode: cache.countryCode || null };
    }

    if (provider === 'electricitymaps') {
        let effectiveZone = zone;
        if (!effectiveZone && autoDetectZone) {
            const detected = await getCachedCountryCode(cancellable);
            if (detected) effectiveZone = detected;
        }
        const val = await fetchElectricityMapsIntensity(apiKey, effectiveZone, cancellable);
        if (typeof val === 'number' && val > 0) {
            const cc = effectiveZone?.slice(0, 2).toUpperCase() || null;
            cache.value = val;
            cache.ts = now;
            cache.source = 'ElectricityMaps';
            cache.countryCode = cc;
            return { intensity: val, source: 'ElectricityMaps', countryCode: cc };
        }
    }

    if (provider === 'auto-country') {
        const result = await autoCountryIntensity(basePath, cancellable);
        if (result) {
            cache.value = result.intensity;
            cache.ts = now;
            cache.source = 'Country Avg';
            cache.countryCode = result.code;
            return { intensity: result.intensity, source: 'Country Avg', countryCode: result.code };
        }
    }

    return { intensity: fixedIntensity, source: 'fixed', countryCode: null };
}

/** Reset all carbon module caches on disable. */
export function resetAllCaches() {
    resetSoupCache();
    resetGeoCache();
    resetCountryMapCache();
}
