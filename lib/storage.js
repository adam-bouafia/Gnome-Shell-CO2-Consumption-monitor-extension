/**
 * Persistence helpers for CO2 totals, daily history, and CSV export/import.
 * Safe to import from both extension.js and prefs.js.
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { dateFromEpochDay } from './utils.js';

// ---------------------------------------------------------------------------
// Time period helpers
// ---------------------------------------------------------------------------

/**
 * Compute epoch-week index based on configured start day.
 * @param {'monday'|'sunday'} weekStart
 */
export function getEpochWeek(weekStart = 'monday') {
    const msPerDay = 86400000;
    const msPerWeek = msPerDay * 7;
    const now = new Date();
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayMs = day.getTime();
    if (weekStart === 'sunday') {
        return Math.floor((dayMs - day.getDay() * msPerDay) / msPerWeek);
    }
    const dow = (day.getDay() + 6) % 7; // Monday=0
    return Math.floor((dayMs - dow * msPerDay) / msPerWeek);
}

/** Get current year-month as YYYYMM integer. */
export function getEpochYearMonth() {
    const now = new Date();
    return now.getFullYear() * 100 + (now.getMonth() + 1);
}

/** ISO week number (Monday-based, week 1 contains Jan 4th). */
export function getISOWeekNumber(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() + 3 - dayNum);
    const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    return 1 + Math.round((d - firstThursday) / (7 * 24 * 3600 * 1000));
}

/** US-style Sunday week number. */
export function getSundayWeekNumber(date) {
    const first = new Date(date.getFullYear(), 0, 1);
    const ms = (date - first) + (first.getDay() * 86400000);
    return Math.floor(ms / (7 * 86400000)) + 1;
}

// ---------------------------------------------------------------------------
// Totals persistence
// ---------------------------------------------------------------------------

/**
 * Update daily/weekly/monthly/cumulative totals with a new interval emission.
 * Handles day/week/month rollovers.
 *
 * @param {Gio.Settings} settings
 * @param {number} intervalCO2g - Emission for this interval (grams)
 * @param {Function|null} onDayRollover - Callback when day changes (receives prevEpochDay)
 */
export function updateTotals(settings, intervalCO2g, onDayRollover = null) {
    const now = Date.now();
    const epochDay = Math.floor(now / 86400000);
    let lastDay = settings.get_int('daily-epoch-day');
    if (lastDay === 0) {
        settings.set_int('daily-epoch-day', epochDay);
        lastDay = epochDay;
    }
    if (epochDay !== lastDay) {
        if (onDayRollover) onDayRollover(lastDay);
        settings.set_double('daily-total-g', 0.0);
        settings.set_int('daily-epoch-day', epochDay);
    }
    settings.set_double('daily-total-g', settings.get_double('daily-total-g') + intervalCO2g);
    settings.set_double('cumulative-total-g', settings.get_double('cumulative-total-g') + intervalCO2g);

    // Weekly
    const weekStart = settings.get_string('week-start-day') || 'monday';
    const weekNow = getEpochWeek(weekStart);
    let lastWeek = settings.get_int('weekly-epoch-week');
    if (lastWeek === 0) { settings.set_int('weekly-epoch-week', weekNow); lastWeek = weekNow; }
    if (weekNow !== lastWeek) {
        settings.set_double('weekly-total-g', 0.0);
        settings.set_int('weekly-epoch-week', weekNow);
    }
    settings.set_double('weekly-total-g', settings.get_double('weekly-total-g') + intervalCO2g);

    // Monthly
    const ymNow = getEpochYearMonth();
    let lastYm = settings.get_int('monthly-epoch-ym');
    if (lastYm === 0) { settings.set_int('monthly-epoch-ym', ymNow); lastYm = ymNow; }
    if (ymNow !== lastYm) {
        settings.set_double('monthly-total-g', 0.0);
        settings.set_int('monthly-epoch-ym', ymNow);
    }
    settings.set_double('monthly-total-g', settings.get_double('monthly-total-g') + intervalCO2g);
}

// ---------------------------------------------------------------------------
// Per-software cumulative totals
// ---------------------------------------------------------------------------

/**
 * Accumulate per-software CO2 into both in-memory map and GSettings.
 *
 * @param {Gio.Settings} settings
 * @param {Object} memoryTotals - In-memory { profile: { name: grams } }
 * @param {Array<{ name: string, co2_g: number }>} perSoftware
 */
export function accumulateSoftwareTotals(settings, memoryTotals, perSoftware) {
    if (!perSoftware.length) return;
    const profile = settings.get_string('profile-name') || 'default';

    // In-memory
    if (!memoryTotals[profile]) memoryTotals[profile] = {};
    for (const row of perSoftware) {
        const key = String(row.name || 'unknown');
        memoryTotals[profile][key] = (Number(memoryTotals[profile][key]) || 0) + (Number(row.co2_g) || 0);
    }

    // GSettings persistence (best-effort)
    try {
        let obj = {};
        try { obj = JSON.parse(settings.get_string('software-totals-json')); } catch (_) {}
        if (!obj[profile]) obj[profile] = {};
        for (const row of perSoftware) {
            const key = String(row.name || 'unknown');
            obj[profile][key] = (Number(obj[profile][key]) || 0) + (Number(row.co2_g) || 0);
        }
        settings.set_string('software-totals-json', JSON.stringify(obj));
    } catch (_) {}
}

/**
 * Get merged overall software totals (GSettings + in-memory).
 * Returns sorted array of { name, g }.
 */
export function getOverallSoftwareTotals(settings, memoryTotals) {
    const profile = settings.get_string('profile-name') || 'default';
    let obj = {};
    try { obj = JSON.parse(settings.get_string('software-totals-json')); } catch (_) {}
    const persisted = obj[profile] || {};
    const mem = memoryTotals?.[profile] || {};
    const map = {};
    for (const [n, g] of Object.entries(persisted)) map[n] = Number(g) || 0;
    for (const [n, g] of Object.entries(mem)) map[n] = (map[n] || 0) + (Number(g) || 0);
    return Object.entries(map)
        .map(([name, g]) => ({ name, g: Number(g) || 0 }))
        .filter(r => r.g > 0)
        .sort((a, b) => b.g - a.g);
}

// ---------------------------------------------------------------------------
// Daily history
// ---------------------------------------------------------------------------

/** Roll the previous day's total into daily history JSON. */
export function rollDailyHistory(settings, prevEpochDay) {
    const profile = settings.get_string('profile-name') || 'default';
    const days = settings.get_int('history-days');
    let obj = {};
    try { obj = JSON.parse(settings.get_string('daily-history-json')); } catch (_) {}
    if (!obj[profile]) obj[profile] = {};
    obj[profile][dateFromEpochDay(prevEpochDay)] = settings.get_double('daily-total-g');
    // Trim to configured window
    const entries = Object.entries(obj[profile]).sort((a, b) => a[0].localeCompare(b[0]));
    obj[profile] = Object.fromEntries(entries.slice(Math.max(0, entries.length - days)));
    settings.set_string('daily-history-json', JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// CSV export helpers
// ---------------------------------------------------------------------------

function writeTextFile(path, content) {
    const file = Gio.File.new_for_path(path);
    const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
    stream.write_all(new TextEncoder().encode(content), null);
    stream.close(null);
}

function appendTextFile(path, content) {
    const file = Gio.File.new_for_path(path);
    let stream;
    if (!file.query_exists(null)) {
        stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
    } else {
        stream = file.append_to(Gio.FileCreateFlags.NONE, null);
    }
    stream.write_all(new TextEncoder().encode(content), null);
    stream.close(null);
}

function getExportDir(settings) {
    const dir = settings.get_string('export-directory');
    return (dir && dir.length > 0) ? dir : GLib.get_home_dir();
}

function safeProfileName(settings) {
    const p = settings.get_string('profile-name') || 'default';
    return p.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** Export a timestamped totals snapshot row (appends to CSV). */
export function exportTotalsCSV(settings) {
    const daily = settings.get_double('daily-total-g');
    const weekly = settings.get_double('weekly-total-g');
    const monthly = settings.get_double('monthly-total-g');
    const cum = settings.get_double('cumulative-total-g');
    const ts = new Date().toISOString();
    const header = 'timestamp,daily_g,weekly_g,monthly_g,all_time_g\n';
    const line = `${ts},${daily.toFixed(6)},${weekly.toFixed(6)},${monthly.toFixed(6)},${cum.toFixed(6)}\n`;
    const path = GLib.build_filenamev([getExportDir(settings), 'co2-consumption-totals.csv']);
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null)) {
        writeTextFile(path, header + line);
    } else {
        appendTextFile(path, line);
    }
}

/** Export daily history for the active profile. */
export function exportDailyHistoryCSV(settings) {
    const profile = settings.get_string('profile-name') || 'default';
    let obj = {};
    try { obj = JSON.parse(settings.get_string('daily-history-json')); } catch (_) {}
    const rows = Object.entries(obj[profile] || {}).sort((a, b) => a[0].localeCompare(b[0]));
    const header = 'date,grams\n';
    const body = rows.map(([d, g]) => `${d},${(+g).toFixed(6)}`).join('\n') + (rows.length ? '\n' : '');
    const path = GLib.build_filenamev([getExportDir(settings), `co2-daily-history-${safeProfileName(settings)}.csv`]);
    writeTextFile(path, header + body);
}

/** Export overall software totals to CSV. */
export function exportOverallSoftwareCSV(settings, memoryTotals, allRows, suffix = 'all') {
    const rows = allRows || getOverallSoftwareTotals(settings, memoryTotals);
    const header = 'software,grams\n';
    const body = rows.map(r => `${r.name.replace(/[,\n]/g, ' ')},${r.g.toFixed(6)}`).join('\n') + (rows.length ? '\n' : '');
    const path = GLib.build_filenamev([
        getExportDir(settings),
        `co2-overall-software-${safeProfileName(settings)}-${suffix}.csv`,
    ]);
    writeTextFile(path, header + body);
}

// ---------------------------------------------------------------------------
// CSV/JSON import
// ---------------------------------------------------------------------------

/** Import overall software totals from CSV text, merging into settings. */
export function importOverallSoftwareFromText(settings, text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
    const startIdx = lines[0]?.toLowerCase().startsWith('software,') ? 1 : 0;
    let obj = {};
    try { obj = JSON.parse(settings.get_string('software-totals-json')); } catch (_) {}
    const profile = settings.get_string('profile-name') || 'default';
    if (!obj[profile]) obj[profile] = {};
    for (let i = startIdx; i < lines.length; i++) {
        const parts = lines[i].split(',');
        if (parts.length < 2) continue;
        const name = parts[0].trim();
        const g = parseFloat(parts[1]);
        if (!name || !Number.isFinite(g)) continue;
        obj[profile][name] = (Number(obj[profile][name]) || 0) + g;
    }
    settings.set_string('software-totals-json', JSON.stringify(obj));
}

/** Import daily history from CSV or JSON file path. */
export function importHistoryFromPath(settings, path) {
    const gf = Gio.File.new_for_path(path);
    const [ok, bytes] = gf.load_contents(null);
    if (!ok) return;
    const text = new TextDecoder('utf-8').decode(bytes);
    const profile = settings.get_string('profile-name') || 'default';
    let entries = [];

    if (/\.json$/i.test(path)) {
        const obj = JSON.parse(text);
        const map = obj[profile] ? obj[profile] : obj;
        for (const [d, g] of Object.entries(map)) entries.push([d, +g]);
    } else {
        for (const line of text.split(/\r?\n/).filter(l => l.trim().length)) {
            if (/^date\s*,/i.test(line.trim())) continue;
            const parts = line.trim().split(',');
            if (parts.length >= 2) entries.push([parts[0].trim(), +parts[1]]);
        }
    }
    if (!entries.length) return;

    let state = {};
    try { state = JSON.parse(settings.get_string('daily-history-json')); } catch (_) {}
    if (!state[profile]) state[profile] = {};
    for (const [d, g] of entries) {
        if (!d || isNaN(g)) continue;
        state[profile][d] = +g;
    }
    const days = settings.get_int('history-days');
    const sorted = Object.entries(state[profile]).sort((a, b) => a[0].localeCompare(b[0]));
    state[profile] = Object.fromEntries(sorted.slice(Math.max(0, sorted.length - days)));
    settings.set_string('daily-history-json', JSON.stringify(state));
}
