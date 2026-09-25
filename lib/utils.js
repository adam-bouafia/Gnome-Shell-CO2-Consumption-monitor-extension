/**
 * Shared utility helpers for the CO2 Consumption Monitor extension.
 * Safe to import from both extension.js and prefs.js (no Shell-only deps).
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// ---------------------------------------------------------------------------
// Tracked one-shot timeouts (cleared on disable to satisfy E.G.O. guidelines)
// ---------------------------------------------------------------------------
export const ephemeralTimeouts = new Set();

/**
 * Promise-based sleep using the GLib main loop.
 * Resolves early, and removes its timeout, when `cancellable` is cancelled.
 */
export function sleepMs(ms, cancellable = null) {
    return new Promise(resolve => {
        if (cancellable?.is_cancelled()) {
            resolve();
            return;
        }
        let cancelId = 0;
        try {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                ephemeralTimeouts.delete(id);
                if (cancelId) cancellable.disconnect(cancelId);
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            ephemeralTimeouts.add(id);
            if (cancellable) {
                cancelId = cancellable.connect('cancelled', () => {
                    if (ephemeralTimeouts.delete(id)) GLib.source_remove(id);
                    resolve();
                });
            }
        } catch (_) {
            resolve();
        }
    });
}

/** Remove all tracked ephemeral timeouts. */
export function clearEphemeralTimeouts() {
    for (const id of Array.from(ephemeralTimeouts)) {
        try { GLib.source_remove(id); } catch (_) { /* already fired */ }
    }
    ephemeralTimeouts.clear();
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

/** Decode a Uint8Array (or GLib.Bytes via toArray()) to a UTF-8 string. */
export function decodeUtf8(u8) {
    try { return new TextDecoder('utf-8').decode(u8); } catch (_) { return null; }
}

/** Convert GLib.Bytes or Uint8Array to string. */
export function bytesToString(bytes) {
    try {
        if (bytes && typeof bytes.toArray === 'function')
            return decodeUtf8(bytes.toArray());
        if (bytes instanceof Uint8Array)
            return decodeUtf8(bytes);
    } catch (_) {}
    return null;
}

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');

/** Read a file without blocking the main loop; resolves to its text or null. */
export async function readFile(path, cancellable = null) {
    try {
        const [contents] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
        return decodeUtf8(contents);
    } catch (_) {
        return null;
    }
}

/** List a directory without blocking the main loop; resolves to Gio.FileInfo[] ([] on error). */
export async function listDir(path, attributes = 'standard::name,standard::type', cancellable = null) {
    const infos = [];
    try {
        const enumerator = await Gio.File.new_for_path(path).enumerate_children_async(
            attributes, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, cancellable);
        let batch;
        while ((batch = await enumerator.next_files_async(256, GLib.PRIORITY_DEFAULT, cancellable)).length)
            infos.push(...batch);
        await enumerator.close_async(GLib.PRIORITY_DEFAULT, null);
    } catch (_) {}
    return infos;
}

// ---------------------------------------------------------------------------
// Safe GSettings getters (avoid hard failures when schema key is missing)
// ---------------------------------------------------------------------------
export function safeGetBoolean(settings, key, fallback = false) {
    try { return settings.get_boolean(key); } catch (_) { return fallback; }
}

export function safeGetInt(settings, key, fallback = 0) {
    try { return settings.get_int(key); } catch (_) { return fallback; }
}

export function safeGetDouble(settings, key, fallback = 0.0) {
    try { return settings.get_double(key); } catch (_) { return fallback; }
}

export function safeGetString(settings, key, fallback = '') {
    try { return settings.get_string(key); } catch (_) { return fallback; }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Format grams with the user-selected unit (g / mg / kg). */
export function formatWithUnit(grams, unit = 'g') {
    if (!Number.isFinite(grams) || grams <= 0) {
        if (unit === 'mg') return '0.0 mg';
        if (unit === 'kg') return '0.000 kg';
        return '0.000 g';
    }
    if (unit === 'mg') return `${(grams * 1000).toFixed(1)} mg`;
    if (unit === 'kg') return `${(grams / 1000).toFixed(3)} kg`;
    return `${grams.toFixed(3)} g`;
}

/** Short format for per-process values - uses mg for very small amounts. */
export function formatCO2Short(grams) {
    if (!Number.isFinite(grams) || grams <= 0) return '0.000 g';
    if (grams < 0.001) {
        const mg = grams * 1000;
        let prec;
        if (mg >= 100) prec = 0;
        else if (mg >= 10) prec = 1;
        else if (mg >= 1) prec = 2;
        else if (mg >= 0.1) prec = 3;
        else if (mg >= 0.01) prec = 4;
        else if (mg >= 0.001) prec = 5;
        else prec = 6;
        return `${mg.toFixed(prec)} mg`;
    }
    return `${grams.toFixed(3)} g`;
}

/** Build a sparkline string from an array of numbers. */
export function sparkline(arr) {
    if (!arr || !arr.length) return '\u2014';
    const ticks = '\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588';
    const min = Math.min(...arr);
    const max = Math.max(...arr);
    const span = max - min || 1;
    return arr.map(v => {
        const idx = Math.floor(((v - min) / span) * (ticks.length - 1));
        return ticks[idx];
    }).join('');
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Convert ISO 3166-1 alpha-2 country code to flag emoji. */
export function countryCodeToFlag(code) {
    if (!code || typeof code !== 'string' || code.length < 2) return null;
    let cc = code.trim().toUpperCase();
    if (cc === 'UK') cc = 'GB';
    const REGIONAL_A = 0x1F1E6;
    const chars = [];
    for (let i = 0; i < 2; i++) {
        const c = cc.charCodeAt(i);
        if (c < 0x41 || c > 0x5A) return null;
        chars.push(String.fromCodePoint(REGIONAL_A + (c - 0x41)));
    }
    return chars.join('');
}

/** Format an epoch-day number as YYYY-MM-DD. */
export function dateFromEpochDay(epochDay) {
    const d = new Date(epochDay * 86400000);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** Format a year-month integer (YYYYMM) as YYYY-MM. */
export function ymToText(ym) {
    const y = Math.floor(ym / 100);
    const m = ym % 100;
    return `${y}-${String(m).padStart(2, '0')}`;
}

/** Monday date string from epoch-week number. */
export function mondayFromEpochWeek(epochWeek) {
    const d = new Date(epochWeek * 7 * 86400000);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}
