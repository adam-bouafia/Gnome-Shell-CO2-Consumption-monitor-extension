import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
// UPower integration removed
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension as BaseExtension } from 'resource:///org/gnome/shell/extensions/extension.js';

// Module-wide base path (set on enable) for loading bundled assets
let _extBasePath = null;
// Track ephemeral one-shot timeouts so we can clear them on disable
const _ephemeralTimeouts = new Set();

// Helper: tracked sleep using GLib main loop; ensures we can cancel on disable
// Reviewer note: All main-loop sources (timeouts) created here are tracked and
// removed before re-scheduling and on destroy()/disable() to satisfy E.G.O. guidelines.
function _sleepMsTracked(ms) {
    return new Promise(resolve => {
        try {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                _ephemeralTimeouts.delete(id);
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            _ephemeralTimeouts.add(id);
        } catch (_) {
            // If scheduling fails, resolve immediately to avoid blocking
            resolve();
        }
    });
}

// Safe getter helpers (avoid hard failures when schema key missing)
function _safeGetBoolean(settings, key, fallback = false) {
    try { return settings.get_boolean(key); } catch (_) { return fallback; }
}
function _safeGetInt(settings, key, fallback = 0) {
    try { return settings.get_int(key); } catch (_) { return fallback; }
}

// No legacy path helpers for 45+; use this.path from the entry point

// Try to load a logo icon (CO2.png or co2.png) from the extension folder
function _tryCreateLogoIcon(basePath) {
    const dir = basePath;
    if (!dir) return null;
    const candidates = [
        GLib.build_filenamev([dir, 'data', 'CO2.svg']),
        GLib.build_filenamev([dir, 'data', 'co2.svg']),
        GLib.build_filenamev([dir, 'CO2.svg']),
        GLib.build_filenamev([dir, 'co2.svg']),
    ];
    for (const path of candidates) {
        try {
            const f = Gio.File.new_for_path(path);
            if (f.query_exists(null)) {
                const gicon = new Gio.FileIcon({ file: f });
                return new St.Icon({ gicon, style_class: 'co2-monitor-icon system-status-icon', icon_size: 36 });
            }
        } catch (_) {
            // continue
        }
    }
    return null;
}

// Helpers for converting GLib.Bytes and Uint8Array buffers to string
function _decodeUtf8(u8) {
    try { return new TextDecoder('utf-8').decode(u8); } catch (_) { return null; }
}

function bytesToString(bytes) {
    // GNOME 45+: GLib.Bytes exposes toArray() via GJS; handle Uint8Array as well
    try {
        if (bytes && typeof bytes.toArray === 'function')
            return _decodeUtf8(bytes.toArray());
        if (bytes instanceof Uint8Array)
            return _decodeUtf8(bytes);
    } catch (_) {}
    return null;
}

// Helpers for system stats
const readFile = (path) => {
    try {
        const file = Gio.File.new_for_path(path);
        const [ok, contents] = file.load_contents(null);
        if (ok) return _decodeUtf8(contents);
    } catch (e) {
        // ignore
    }
    return null;
};

function getCpuTimes() {
    const data = readFile('/proc/stat');
    if (!data) return null;
    // First line: cpu  user nice system idle iowait irq softirq steal guest guest_nice
    const line = data.split('\n')[0];
    const parts = line.trim().split(/\s+/).slice(1).map(x => parseInt(x, 10));
    if (parts.length < 7) return null;
    const [user, nice, system, idle, iowait, irq, softirq, steal = 0] = parts;
    const idleAll = idle + iowait;
    const nonIdle = user + nice + system + irq + softirq + steal;
    const total = idleAll + nonIdle;
    return { idleAll, total };
}

function getCpuUsagePercent(prev, curr) {
    if (!prev || !curr) return 0;
    const totald = curr.total - prev.total;
    const idled = curr.idleAll - prev.idleAll;
    if (totald <= 0) return 0;
    return ((totald - idled) / totald) * 100.0;
}

function readCpuInfo() {
    const text = readFile('/proc/cpuinfo');
    if (!text) return { mhz: 2200, cores: 4 };
    const mhzMatch = text.match(/cpu MHz\s*:\s*([0-9.]+)/);
    const cores = (text.match(/^processor\s*:/gm) || []).length || 4;
    const mhz = mhzMatch ? parseFloat(mhzMatch[1]) : 2200;
    return { mhz, cores };
}

function getPowerModel(cpuProfile) {
    // Base per-core active power at 2.2GHz (heuristic), scaled by frequency
    const { mhz, cores } = readCpuInfo();
    const freqScale = Math.max(0.5, Math.min(2.0, mhz / 2200.0));
    let perCoreBase;
    switch (cpuProfile) {
        case 'laptop': perCoreBase = 2.8; break;
        case 'server': perCoreBase = 6.0; break;
        case 'lowpower': perCoreBase = 1.5; break;
        case 'desktop':
        default: perCoreBase = 4.0; break;
    }
    const activePerCore = perCoreBase * freqScale; // W per core under active load
    const maxActive = activePerCore * Math.max(1, cores);
    const idle = Math.min(0.25 * maxActive, 8); // cap idle baseline
    return { idleW: idle, maxActiveW: maxActive };
}

async function fetchElectricityMapsIntensity(apiKey, zone) {
    if (!apiKey || !zone) return null;
    try {
        // ElectricityMaps (v3) carbon-intensity endpoint
        // https://api.electricitymap.org/v3/carbon-intensity/latest?zone=DE
        const Soup = await _getSoup();
        if (!Soup) return null;
        const session = new Soup.Session();
        const url = `https://api.electricitymap.org/v3/carbon-intensity/latest?zone=${encodeURIComponent(zone)}`;
        const msg = Soup.Message.new('GET', url);
        msg.request_headers.append('auth-token', apiKey);
        const bytes = await new Promise((resolve, reject) => {
            session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
                try {
                    const data = session.send_and_read_finish(res);
                    resolve(data);
                } catch (e) { reject(e); }
            });
        });
        const text = bytesToString(bytes);
        const obj = JSON.parse(text);
        // Returns gCO2eq/kWh
        if (obj && obj.carbonIntensity) {
            return obj.carbonIntensity;
        }
    } catch (e) {
            console.warn(`CO2 Monitor: ElectricityMaps fetch error: ${e}`);
    }
    return null;
}

// Lazy Soup importer for compatibility (tries Soup 3 then Soup 2)
async function _getSoup() {
    try {
        const mod3 = await import('gi://Soup?version=3.0');
        return mod3.default;
    } catch (e) {
        try {
            const mod2 = await import('gi://Soup');
            return mod2.default;
        } catch (e2) {
            console.warn('CO2 Monitor: libsoup not available; HTTP disabled');
            return null;
        }
    }
}

async function fetchUKCarbonIntensity() {
    return null;
}

async function detectCountryCode() {
    // Basic IP geolocation using ipapi.co (no key, rate limited). Fallback only.
    try {
        const Soup = await _getSoup();
        if (!Soup) return null;
        const session = new Soup.Session();
        const msg = Soup.Message.new('GET', 'https://ipapi.co/json/');
        const bytes = await new Promise((resolve, reject) => {
            session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
                try { resolve(session.send_and_read_finish(res)); } catch (e) { reject(e); }
            });
        });
        const text = bytesToString(bytes);
        const obj = JSON.parse(text);
        const code = obj?.country_code;
        if (typeof code === 'string' && code.length >= 2) return code;
    } catch (e) {
    console.warn(`CO2 Monitor: geolocation error: ${e}`);
    }
    return null;
}

// Simple geolocation cache to avoid frequent network calls
let _geoCache = { code: null, ts: 0 };
async function getCachedCountryCode() {
    const now = Date.now() / 1000;
    const maxAge = 6 * 3600; // 6 hours
    if (_geoCache.code && (now - _geoCache.ts) < maxAge)
        return _geoCache.code;
    const code = await detectCountryCode();
    if (code) _geoCache = { code, ts: now };
    return code;
}

// Offline country-average intensity fallback (gCO2/kWh).
// We bundle a curated dataset in data/country_intensity.json and keep
// a tiny built-in fallback for safety.
const COUNTRY_INTENSITY_FALLBACK = {
    'US': 388, 'CA': 150, 'FR': 60, 'DE': 340, 'GB': 230, 'UK': 230,
    'ES': 180, 'IT': 300, 'SE': 30, 'NO': 30, 'FI': 120, 'PL': 700,
    'NL': 400, 'BE': 200, 'CH': 30, 'AT': 120, 'DK': 200, 'IE': 300,
    'PT': 180, 'CZ': 520, 'HU': 270, 'RO': 300, 'BG': 420, 'GR': 430,
    'TR': 440, 'RU': 420, 'CN': 600, 'IN': 700, 'JP': 450, 'KR': 500,
    'AU': 600, 'NZ': 120, 'BR': 90, 'MX': 430, 'ZA': 800
};

let _bundledCountryMap = null;
function loadCountryIntensityMap(basePath = _extBasePath) {
    if (_bundledCountryMap)
        return _bundledCountryMap;
    try {
        const dir = basePath;
        if (!dir) {
            _bundledCountryMap = COUNTRY_INTENSITY_FALLBACK;
            return _bundledCountryMap;
        }
        const jsonPath = GLib.build_filenamev([dir, 'data', 'country_intensity.json']);
        const text = readFile(jsonPath);
        if (!text) {
            _bundledCountryMap = COUNTRY_INTENSITY_FALLBACK;
            return _bundledCountryMap;
        }
        const obj = JSON.parse(text);
        if (obj && typeof obj === 'object') {
            _bundledCountryMap = Object.freeze({ ...COUNTRY_INTENSITY_FALLBACK, ...obj });
        } else {
            _bundledCountryMap = COUNTRY_INTENSITY_FALLBACK;
        }
    } catch (e) {
        console.warn(`CO2 Monitor: failed to load bundled country intensities: ${e}`);
        _bundledCountryMap = COUNTRY_INTENSITY_FALLBACK;
    }
    return _bundledCountryMap;
}

async function autoCountryIntensity() {
    // Try to detect country via IP, then map to averages from bundled dataset.
    const code = await getCachedCountryCode();
    if (!code) return null;
    const map = loadCountryIntensityMap();
    if (map[code]) return map[code];
    // Some APIs return GB; map to UK key for convenience
    if (code === 'GB' && map['UK']) return map['UK'];
    return null;
}

async function fetchOWIDCountryIntensity() {
    // Public dataset: OWID electricity mix + assumed intensities per fuel
    // We keep it simple: download country averages (if available) and map to gCO2/kWh.
    // Endpoint example: https://raw.githubusercontent.com/owid/energy-data/master/owid-energy-data.csv
    // To keep payload small and robust, we can instead use a curated JSON hosted by the extension in the future.
    const Soup = await _getSoup();
    if (!Soup) return null;
    try {
        const session = new Soup.Session();
        const msg = Soup.Message.new('GET', 'https://raw.githubusercontent.com/owid/energy-data/master/owid-energy-data.csv');
        const bytes = await new Promise((resolve, reject) => {
            session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
                try { resolve(session.send_and_read_finish(res)); } catch (e) { reject(e); }
            });
        });
        const text = bytesToString(bytes);
        if (!text) return null;
        // Minimal parse: find line for country code, extract a proxy intensity if available.
        const code = await detectCountryCode();
        if (!code) return null;
        const lines = text.split('\n');
        // Heuristic: look for a CSV line starting with the country code and containing co2 intensity proxy column if present.
        // OWID CSV may not have direct gCO2/kWh; if not, bail to offline dataset.
        for (const line of lines) {
            if (line.startsWith(`${code},`) || line.startsWith(`${code.toLowerCase()},`)) {
                // No direct intensity column in standard OWID; skip for now.
                break;
            }
        }
    } catch (e) {
    console.warn(`CO2 Monitor: OWID fetch error: ${e}`);
    }
    return null;
}

// Convert ISO 3166-1 alpha-2 country code to flag emoji (if supported by font)
function countryCodeToFlagEmoji(code) {
    if (!code || typeof code !== 'string' || code.length < 2)
        return null;
    let cc = code.trim().toUpperCase();
    // Normalize UK to GB for emoji consistency
    if (cc === 'UK') cc = 'GB';
    const A = 0x41; // 'A'
    const REGIONAL_INDICATOR = 0x1F1E6;
    const chars = [];
    for (let i = 0; i < 2; i++) {
        const c = cc.charCodeAt(i);
        if (c < 0x41 || c > 0x5A) return null; // not A-Z
        chars.push(String.fromCodePoint(REGIONAL_INDICATOR + (c - A)));
    }
    return chars.join('');
}

// Procfs helpers for per-process sampling
function listNumericSubdirs(dirPath) {
    try {
        const dir = Gio.File.new_for_path(dirPath);
        const enumerator = dir.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        const names = [];
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                const name = info.get_name();
                if (/^\d+$/.test(name)) names.push(name);
            }
        }
        enumerator.close(null);
        return names;
    } catch (e) {
        return [];
    }
}

function readProcStat(pid) {
    const text = readFile(`/proc/${pid}/stat`);
    if (!text) return null;
    // pid (comm) state ... utime stime ...
    const l = text.indexOf('(');
    const r = text.lastIndexOf(')');
    if (l < 0 || r < 0 || r <= l) return null;
    const comm = text.substring(l + 1, r);
    const rest = text.substring(r + 2).trim();
    const parts = rest.split(/\s+/);
    if (parts.length < 13) return null; // need up to stime index 12
    const utime = parseInt(parts[11], 10) || 0;
    const stime = parseInt(parts[12], 10) || 0;
    return { name: comm, ticks: utime + stime };
}

function readProcCmdline(pid) {
    const raw = readFile(`/proc/${pid}/cmdline`);
    if (!raw) return null;
    const name = raw.replace(/\0/g, ' ').trim();
    return name || null;
}

function getProcessTimesSnapshot() {
    const pids = listNumericSubdirs('/proc');
    const map = new Map();
    // Cap number of PIDs processed to reduce load in busy systems
    const MAX_PIDS = 500;
    let count = 0;
    for (const pid of pids) {
        if (count++ > MAX_PIDS) break;
        const st = readProcStat(pid);
        if (!st) continue;
        // Use the lightweight command name from /proc/<pid>/stat only; avoid cmdline reads
        const name = st.name || 'unknown';
        map.set(pid, { name, ticks: st.ticks });
    }
    return map;
}

async function sampleProcessShares(sampleMs = 250) {
    const s1 = getCpuTimes();
    const p1 = getProcessTimesSnapshot();
    // Use tracked sleep so this timeout can be cancelled on disable
    await _sleepMsTracked(sampleMs);
    const s2 = getCpuTimes();
    const p2 = getProcessTimesSnapshot();
    if (!s1 || !s2) return [];
    const totald = s2.total - s1.total;
    if (totald <= 0) return [];
    const rows = [];
    for (const [pid, v1] of p1.entries()) {
        const v2 = p2.get(pid);
        if (!v2) continue;
        const delta = v2.ticks - v1.ticks;
        if (delta <= 0) continue;
        const share = delta / totald; // fraction of CPU time across all cores
        rows.push({ name: v2.name, share });
    }
    // Aggregate by name
    const byName = new Map();
    for (const row of rows) {
        const prev = byName.get(row.name) || 0;
        byName.set(row.name, prev + row.share);
    }
    let agg = Array.from(byName.entries()).map(([name, share]) => ({ name, share }));
    agg.sort((a, b) => b.share - a.share);
    // Limit aggregation to top 200 names to reduce UI churn
    return agg.slice(0, 200);
}

// CO2 Indicator class
const CO2Indicator = GObject.registerClass(
class CO2Indicator extends PanelMenu.Button {
    _init(basePath, settings, openPrefs) {
        super._init(0.0, 'CO2 Consumption Monitor');
        this._basePath = basePath;
        this._settings = settings;
        this._openPrefs = openPrefs;
        
        // Create the status bar box with optional icon + bold label
    console.debug('CO2 Consumption Monitor: Initializing indicator');
    this._box = new St.BoxLayout({ style_class: 'co2-monitor-box', vertical: false });
        this._box.set_y_align?.(Clutter.ActorAlign.CENTER);
        this._box.y_align = Clutter.ActorAlign.CENTER;
    // Ensure no extra spacing between children
    this._box.set_spacing?.(0);
    this._box.spacing = 0;
        // Show numeric value first (no "CO2" word), then the logo icon
        this._label = new St.Label({ text: '0.000g', style_class: 'co2-monitor-label' });
        this._label.set_y_align?.(Clutter.ActorAlign.CENTER);
        this._label.y_align = Clutter.ActorAlign.CENTER;
        this._box.add_child(this._label);
    const icon = _tryCreateLogoIcon(this._basePath);
        if (icon) {
            icon.set_y_align?.(Clutter.ActorAlign.CENTER);
            icon.y_align = Clutter.ActorAlign.CENTER;
            this._box.add_child(icon);
        }
        this.add_child(this._box);
        
        // Create the popup menu
        this._createPopupMenu();
        
        // Initialize data
        this._co2Data = {
            total_co2_g: 0.0,
            per_software_co2: []
        };
        // In-memory fallback for overall totals (profile -> name -> grams)
        // Used when schemas aren't compiled yet or to coalesce during the session
        this._overallTotals = {};

        // Schedule first update without overlap
        this._updating = false;
    this._prevCpuTimes = getCpuTimes();
    this._rolling = []; // keep last N totals for smoothing
        this._scheduleNext();

        // React to settings changes
        this._settingsChangedId = this._settings.connect('changed', () => {
            // re-schedule with new interval
            this._scheduleNext(true);
            // refresh periodic export schedule on relevant changes
            this._setupOrRefreshPeriodicExport();
        });
        // Immediate UI reactions for specific settings (track their IDs for cleanup)
        this._settingsSignalIds = [];
        try {
            this._settingsSignalIds.push(this._settings.connect('changed::display-unit', () => this._updateUI()));
            this._settingsSignalIds.push(this._settings.connect('changed::overall-show-all', () => this._renderConsumersColumns()));
        } catch (_) {}

        // Provider cache and last intensity info
        this._intensityCache = { value: null, ts: 0 };
        this._lastIntensityValue = null;
        this._lastIntensitySource = 'fixed';
        this._lastCountryCode = null;

    // UPower watcher removed
    this._upowerClient = null;
    this._onBattery = null;
    this._upowerSignals = [];
    // Periodic export timer id
    this._periodicExportId = null;
    this._setupOrRefreshPeriodicExport();
    }
    
    _createPopupMenu() {
    // Prepare popup controls container (we'll place it at the bottom-right)
    const headerControls = new St.BoxLayout({ vertical: false });
        headerControls.add_style_class_name?.('co2-popup-controls');
        headerControls.set_x_expand?.(true);
        headerControls.set_y_align?.(Clutter.ActorAlign.CENTER);

        // Apply popup background opacity if configured
        const applyPopupOpacity = () => {
            try {
                const pct = this._settings.get_int('popup-opacity');
                const clamped = Math.max(0, Math.min(100, pct));
                const alpha = (clamped / 100).toFixed(2);
                const rgba = `rgba(255,255,255,${alpha})`;
                this.menu.box?.set_style?.(`background-color: ${rgba};`);
                this.menu.box?.queue_relayout?.();
            } catch (_) {}
        };
        applyPopupOpacity();
        try {
            this._settingsSignalIds.push(this._settings.connect('changed::popup-opacity', () => applyPopupOpacity()));
        } catch (_) {}

    // Settings button
    const settingsIcon = new St.Icon({ icon_name: 'emblem-system-symbolic', style_class: 'system-status-icon', icon_size: 20 });
        const settingsBtn = new St.Button({ child: settingsIcon, style_class: 'co2-popup-btn' });
        settingsBtn.set_tooltip_text?.('Open Settings');
        settingsBtn.connect('clicked', () => {
            try { this._openPrefs?.(); } catch (e) { console.warn(`CO2 Monitor: open prefs failed: ${e}`); }
        });
    // We'll add this button to the controls container later (bottom-right)

    // Clear totals button
    const clearIcon = new St.Icon({ icon_name: 'user-trash-symbolic', style_class: 'system-status-icon', icon_size: 20 });
        const clearBtn = new St.Button({ child: clearIcon, style_class: 'co2-popup-btn' });
        clearBtn.set_tooltip_text?.('Clear stored totals');
        clearBtn.connect('clicked', () => {
            try {
                this._settings.set_double('daily-total-g', 0.0);
                this._settings.set_double('weekly-total-g', 0.0);
                this._settings.set_double('monthly-total-g', 0.0);
                this._settings.set_double('cumulative-total-g', 0.0);
                this._updateTotalsRow();
            } catch (e) { console.warn(`CO2 Monitor: clear totals failed: ${e}`); }
        });
        // We'll add this button to the controls container later (bottom-right)
        // Controls are appended at the end of the popup (bottom-right)

        // Total CO2 section
        this._totalSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._totalSection);
        
            this._totalItem = new PopupMenu.PopupMenuItem('Current consumption: 0.000 g', { 
            reactive: false,
            style_class: 'co2-popup-header'
        });
        try {
            const sec = this._settings.get_int('update-interval');
            this._totalItem.actor.set_tooltip_text?.(`Estimated emissions over the last ${sec}s`);
        } catch (_) {}
        this._totalSection.addMenuItem(this._totalItem);
        
        // Trend line (created once)
        this._trendItem = new PopupMenu.PopupMenuItem('Trend: —', {
            reactive: false,
            style_class: 'co2-popup-item'
        });
        this._totalSection.addMenuItem(this._trendItem);

        // Persistent totals (daily and cumulative)
        this._totalsItem = new PopupMenu.PopupMenuItem('Totals: —', {
            reactive: false,
            style_class: 'co2-popup-item'
        });
        this._totalSection.addMenuItem(this._totalsItem);

        // Period info (week number, last resets)
        this._periodInfoItem = new PopupMenu.PopupMenuItem('Period: —', {
            reactive: false,
            style_class: 'co2-popup-item'
        });
        this._totalSection.addMenuItem(this._periodInfoItem);

        // Reset/export controls are moved to Preferences to declutter the popup

        // Separator
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Intensity row (value and provider)
        this._intensityItem = new PopupMenu.PopupMenuItem('Intensity: —', {
            reactive: false,
            style_class: 'co2-popup-item'
        });
        this.menu.addMenuItem(this._intensityItem);

        // Side-by-side Consumers section (Left: Top interval, Right: Overall cumulative)
        this._consumersColumnsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._consumersColumnsSection);
        this._consumersItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        this._consumersColumnsSection.addMenuItem(this._consumersItem);
        const columnsContainer = this._consumersItem.actor || this._consumersItem;
        const cols = new St.BoxLayout({ vertical: false, x_expand: true });
        cols.set_spacing?.(12);
        columnsContainer.add_child(cols);
        // Left column (current interval)
        const leftCol = new St.BoxLayout({ vertical: true, x_expand: true, y_expand: true });
        const leftHeader = new St.Label({ text: 'Current CO2 Consumers', style_class: 'co2-popup-header' });
        this._leftListBox = new St.BoxLayout({ vertical: true, x_expand: true, y_expand: true });
        leftCol.add_child(leftHeader);
        leftCol.add_child(this._leftListBox);
        // Right column (cumulative)
        const rightCol = new St.BoxLayout({ vertical: true, x_expand: true, y_expand: true });
        const rightHeader = new St.Label({ text: 'Overall CO2 Consumers', style_class: 'co2-popup-header' });
        this._overallInfoLabel = new St.Label({ text: '—', style_class: 'co2-popup-item' });
        this._rightListBox = new St.BoxLayout({ vertical: true, x_expand: true, y_expand: true });
        rightCol.add_child(rightHeader);
        rightCol.add_child(this._overallInfoLabel);
        rightCol.add_child(this._rightListBox);
        cols.add_child(leftCol);
        cols.add_child(rightCol);

        // Overall totals admin actions moved to Preferences

    // No separator above bottom controls (cleaner look)
    // Bottom controls section (buttons on the bottom-right)
    const bottomControlsSection = new PopupMenu.PopupMenuSection();
    this.menu.addMenuItem(bottomControlsSection);
    // Right-align: place an expanding filler first, then the buttons
    const filler = new St.Widget({ x_expand: true });
    headerControls.add_child(filler);
    // Swap order so Clear appears before Settings (Settings far right)
    headerControls.add_child(clearBtn);
    headerControls.add_child(settingsBtn);
    bottomControlsSection.actor.add_child(headerControls);
    }
    
    async _updateData() {
        if (this._updating) return;
        this._updating = true;
        try {
            const interval = this._settings.get_int('update-interval');
            const profile = this._settings.get_string('cpu-profile');
            const safe = this._settings.get_boolean('safe-mode');
            const useOnline = !safe && this._settings.get_boolean('use-online-intensity');
            const provider = this._settings.get_string('intensity-provider');
            let intensity = this._settings.get_int('carbon-intensity'); // gCO2/kWh
            this._lastCountryCode = null;

            if (useOnline && provider === 'electricitymaps') {
                const key = this._settings.get_string('electricitymaps-api-key');
                let zone = this._settings.get_string('electricitymaps-zone');
                if (!zone && this._settings.get_boolean('auto-detect-zone')) {
                    const detected = await getCachedCountryCode();
                    if (detected) zone = detected;
                }
                const fetched = await this._getCachedIntensity(async () => await fetchElectricityMapsIntensity(key, zone));
                if (typeof fetched === 'number' && fetched > 0) {
                    intensity = fetched;
                    this._lastIntensitySource = 'ElectricityMaps';
                    if (zone && zone.length >= 2)
                        this._lastCountryCode = zone.slice(0, 2).toUpperCase();
                } else {
                    this._lastIntensitySource = 'fixed';
                }
            } else if (useOnline && provider === 'auto-country') {
                // Prefer country-average from bundled dataset with IP geolocation
                const code = await getCachedCountryCode();
                const map = loadCountryIntensityMap();
                const val = code ? (map[code] || (code === 'GB' ? map['UK'] : undefined)) : undefined;
                if (typeof val === 'number' && val > 0) {
                    intensity = val;
                    this._lastIntensitySource = 'Country Avg';
                    this._lastCountryCode = (code === 'GB') ? 'UK' : code;
                } else {
                    this._lastIntensitySource = 'fixed';
                }
            } else {
                // No online provider: do NOT perform any geolocation/network calls.
                // Keep using the fixed intensity from settings to minimize main-loop work.
                this._lastIntensitySource = 'fixed';
                this._lastCountryCode = null;
            }
            this._lastIntensityValue = intensity;

            // CPU usage sample
            const prev = this._prevCpuTimes;
            const sampleMs = Math.max(50, Math.min(1000, this._settings.get_int('per-process-sample-ms') || 250));
            // Tracked sleep to ensure one-shot timeout is cancellable
            await _sleepMsTracked(sampleMs);
            const curr = getCpuTimes();
            const cpuPercent = getCpuUsagePercent(prev, curr);
            this._prevCpuTimes = curr;

            // Power estimate (Watts)
            const { idleW, maxActiveW } = getPowerModel(profile);
            const watts = Math.max(1, idleW + (maxActiveW - idleW) * (cpuPercent / 100));

            // Energy over interval (Wh): P(W) * t(h)
            const energyWh = watts * (interval / 3600.0);
            // Convert to kWh
            const energyKWh = energyWh / 1000.0;
            // Emissions in g: intensity (g/kWh) * kWh
            const intervalCO2g = intensity * energyKWh;
            let totalCO2g = intervalCO2g;
            // Rolling average smoothing (settings)
            if (this._settings.get_boolean('smoothing-enabled')) {
                const windowSize = Math.max(1, Math.min(60, this._settings.get_int('smoothing-window')));
                this._rolling.push(totalCO2g);
                if (this._rolling.length > windowSize) this._rolling.shift();
                const avg = this._rolling.reduce((a, b) => a + b, 0) / this._rolling.length;
                totalCO2g = avg;
            } else {
                this._rolling = [totalCO2g];
            }

            let perSoftware = [];
            if (!safe && this._settings.get_boolean('per-software-monitoring')) {
                try {
                    // Throttle sampling to every 3rd tick to reduce load
                    this._sampleTick = (this._sampleTick || 0) + 1;
                    // Increase throttle to every 6th tick for stability on busy systems
                    if (this._sampleTick % 6 === 1) {
                        const shares = await sampleProcessShares(sampleMs);
                        this._lastShares = shares;
                    }
                    const useShares = this._lastShares || [];
                    const topN = Math.max(5, Math.min(25, this._settings.get_int('per-process-top-n') || 10));
                    const top = useShares.slice(0, topN);
                    perSoftware = top.map(t => ({ name: t.name, co2_g: totalCO2g * t.share }));
                } catch (e) {
                    console.warn(`CO2 Monitor: per-process sampling error: ${e}`);
                }
            }

            // Persist per-software cumulative totals (unsmoothed interval allocation)
            try {
                if (perSoftware.length) {
                    const profile = this._settings.get_string('profile-name') || 'default';
                    // Always update in-memory totals so Overall updates instantly even if schemas aren't compiled
                    if (!this._overallTotals[profile]) this._overallTotals[profile] = {};
                    for (const row of perSoftware) {
                        const key = String(row.name || 'unknown');
                        const prevMem = Number(this._overallTotals[profile][key]) || 0;
                        this._overallTotals[profile][key] = prevMem + (Number(row.co2_g) || 0);
                    }
                    // Best-effort mirror to GSettings for persistence
                    try {
                        let obj = {};
                        try { obj = JSON.parse(this._settings.get_string('software-totals-json')); } catch (_) { obj = {}; }
                        if (!obj[profile]) obj[profile] = {};
                        for (const row of perSoftware) {
                            const key = String(row.name || 'unknown');
                            const prev = Number(obj[profile][key]) || 0;
                            obj[profile][key] = prev + (Number(row.co2_g) || 0);
                        }
                        this._settings.set_string('software-totals-json', JSON.stringify(obj));
                    } catch (_) {
                        // ignore persistence errors
                    }
                }
            } catch (e) {
                // ignore aggregation errors
            }

            // Persist daily and cumulative totals (unsmoothed interval)
            try {
                const now = Date.now();
                const epochDay = Math.floor(now / 86400000);
                let lastDay = this._settings.get_int('daily-epoch-day');
                if (lastDay === 0) {
                    this._settings.set_int('daily-epoch-day', epochDay);
                    lastDay = epochDay;
                }
                if (epochDay !== lastDay) {
                    // New day: reset daily
                    // Before reset, store yesterday into history and auto-export if enabled
                    try { this._rollDailyHistory(lastDay); } catch (_) {}
                    if (this._settings.get_boolean('auto-export-history'))
                        try { this._exportDailyHistoryCSV(); } catch (_) {}
                    this._settings.set_double('daily-total-g', 0.0);
                    this._settings.set_int('daily-epoch-day', epochDay);
                }
                const prevDaily = this._settings.get_double('daily-total-g');
                const prevCum = this._settings.get_double('cumulative-total-g');
                this._settings.set_double('daily-total-g', prevDaily + intervalCO2g);
                this._settings.set_double('cumulative-total-g', prevCum + intervalCO2g);

                // Weekly (ISO week approximation: Monday-based, count weeks since epoch Monday)
                const weekNow = this._getEpochWeek();
                let lastWeek = this._settings.get_int('weekly-epoch-week');
                if (lastWeek === 0) {
                    this._settings.set_int('weekly-epoch-week', weekNow);
                    lastWeek = weekNow;
                }
                if (weekNow !== lastWeek) {
                    this._settings.set_double('weekly-total-g', 0.0);
                    this._settings.set_int('weekly-epoch-week', weekNow);
                }
                const prevWeekly = this._settings.get_double('weekly-total-g');
                this._settings.set_double('weekly-total-g', prevWeekly + intervalCO2g);

                // Monthly (ym = year*100 + month)
                const ymNow = this._getEpochYearMonth();
                let lastYm = this._settings.get_int('monthly-epoch-ym');
                if (lastYm === 0) {
                    this._settings.set_int('monthly-epoch-ym', ymNow);
                    lastYm = ymNow;
                }
                if (ymNow !== lastYm) {
                    this._settings.set_double('monthly-total-g', 0.0);
                    this._settings.set_int('monthly-epoch-ym', ymNow);
                }
                const prevMonthly = this._settings.get_double('monthly-total-g');
                this._settings.set_double('monthly-total-g', prevMonthly + intervalCO2g);
            } catch (e) {
                // settings might not be writable in some environments
            }

            this._co2Data = {
                total_co2_g: totalCO2g,
                per_software_co2: perSoftware,
            };
            this._updateUI();
        } catch (e) {
            console.error(`CO2 Monitor: estimation error: ${e}`);
            this._co2Data = { total_co2_g: 0.0, per_software_co2: [], error: e.toString() };
            this._updateUI();
        } finally {
            this._updating = false;
            this._scheduleNext();
        }
    }

    async _getCachedIntensity(fetcher) {
        const ttl = Math.max(10, Math.min(3600, this._settings.get_int('provider-cache-ttl')));
        const now = Date.now() / 1000;
        if (this._intensityCache.value !== null && (now - this._intensityCache.ts) < ttl) {
            return this._intensityCache.value;
        }
        const v = await fetcher();
        if (typeof v === 'number') {
            this._intensityCache = { value: v, ts: now };
        }
        return v;
    }

    _scheduleNext(reset = false) {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
    // Keep a slightly higher minimum interval to reduce shell load on busy systems
    const interval = Math.max(2, this._settings.get_int('update-interval'));
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            if (!this._updating) this._updateData();
            return GLib.SOURCE_REMOVE;
        });
        if (reset) {
            // kick an immediate update; timer will be rescheduled by finally
            if (!this._updating) this._updateData();
        }
    }
    
    _formatWithUnit(grams) {
        let unit = 'g';
        try {
            const u = this._settings.get_string('display-unit');
            if (u === 'mg' || u === 'kg' || u === 'g') unit = u;
        } catch (_) {}
        if (!Number.isFinite(grams) || grams <= 0) return unit === 'mg' ? '0.0 mg' : (unit === 'kg' ? '0.000 kg' : '0.000 g');
        if (unit === 'mg') {
            const mg = grams * 1000.0;
            // Show 1 decimal for readability
            return `${mg.toFixed(1)} mg`;
        }
        if (unit === 'kg') {
            const kg = grams / 1000.0;
            return `${kg.toFixed(3)} kg`;
        }
        return `${grams.toFixed(3)} g`;
    }

    _updateUI() {
        // Update status bar label with color coding
    const totalG = this._co2Data.total_co2_g;
    this._label.set_text(this._formatWithUnit(totalG));
        
        // Apply color coding based on CO2 level
        this._applyCO2ColorCoding(this._co2Data.total_co2_g);
        
        // Update popup menu
    this._totalItem.label.set_text(`Current consumption: ${this._formatWithUnit(totalG)}`);
        try {
            const sec = this._settings.get_int('update-interval');
            this._totalItem.actor.set_tooltip_text?.(`Estimated emissions over the last ${sec}s`);
        } catch (_) {}
    this._updateTotalsRow();
        
        // Render side-by-side consumers columns
        this._renderConsumersColumns();
        if (this._settings.get_boolean('show-trend')) {
            const historyLen = Math.max(10, Math.min(300, this._settings.get_int('history-length')));
            // Maintain a separate history array
            if (!this._history) this._history = [];
            this._history.push(this._co2Data.total_co2_g);
            if (this._history.length > historyLen) this._history.shift();
            this._trendItem.label.set_text(`Trend: ${this._sparkline(this._history)}`);
            this._trendItem.actor.show?.();
        } else {
            this._trendItem.actor.hide?.();
        }

        // Intensity row visibility and content
        if (this._settings.get_boolean('show-intensity')) {
            const val = this._lastIntensityValue;
            const src = this._lastIntensitySource || 'fixed';
            const code = this._lastCountryCode;
            const flag = code ? countryCodeToFlagEmoji(code) : null;
            const parts = [];
            parts.push(typeof val === 'number' ? `Intensity: ${val.toFixed(0)} g/kWh` : 'Intensity: —');
            if (code) parts.push(`${flag ? flag + ' ' : ''}${code}`);
            // Show provider name if it's not the generic fixed fallback
            if (src && src !== 'fixed') parts.push(`(${src})`);
            this._intensityItem.label.set_text(parts.join(' '));
            this._intensityItem.actor.show?.();
        } else {
            this._intensityItem.actor.hide?.();
        }
    }

    _renderConsumersColumns() {
        try {
            // Left column (current interval)
            if (this._leftListBox && this._leftListBox.get_children) {
                for (const ch of this._leftListBox.get_children()) ch.destroy();
            }
            const wantColorsLeft = this._settings.get_boolean('color-coding');
            const topSoftware = (this._co2Data?.per_software_co2) || [];
            if (this._co2Data?.error) {
                const err = new St.Label({ text: `Error: ${this._co2Data.error}`, style_class: 'co2-popup-item' });
                this._leftListBox.add_child(err);
            } else if (topSoftware.length === 0 || topSoftware.every(s => s.co2_g === 0)) {
                const noData = new St.Label({ text: 'No active processes detected', style_class: 'co2-popup-item' });
                this._leftListBox.add_child(noData);
            } else {
                for (const software of topSoftware) {
                    if (!(software.co2_g > 0)) continue;
                    const row = new St.BoxLayout({ vertical: false });
                    if (wantColorsLeft) {
                        const badgeCls = this._badgeClassForCO2?.(software.co2_g) || '';
                        if (badgeCls) row.add_child(new St.BoxLayout({ style_class: `badge ${badgeCls}` }));
                    }
                    const co2Text = this._formatCO2Short(software.co2_g);
                    row.add_child(new St.Label({ text: `${software.name}: ${co2Text}`, style_class: 'co2-software-item' }));
                    this._leftListBox.add_child(row);
                }
            }

            // Right column (cumulative totals)
            if (this._rightListBox && this._rightListBox.get_children) {
                for (const ch of this._rightListBox.get_children()) ch.destroy();
            }
            const profile = this._settings.get_string('profile-name') || 'default';
            let obj = {};
            try { obj = JSON.parse(this._settings.get_string('software-totals-json')); } catch (_) { obj = {}; }
            const persisted = obj[profile] || {};
            const mem = this._overallTotals?.[profile] || {};
            const map = {};
            for (const [n, g] of Object.entries(persisted)) map[n] = Number(g) || 0;
            for (const [n, g] of Object.entries(mem)) map[n] = (map[n] || 0) + (Number(g) || 0);
            const allRows = Object.entries(map)
                .map(([name, g]) => ({ name, g: Number(g) || 0 }))
                .filter(r => r.g > 0)
                .sort((a, b) => b.g - a.g);
            const totalCount = allRows.length;
            const showAll = _safeGetBoolean(this._settings, 'overall-show-all', true);
            const topN = Math.max(5, Math.min(25, _safeGetInt(this._settings, 'per-process-top-n', 10) || 10));
            // Update info subtitle
            if (this._overallInfoLabel) {
                if (totalCount === 0) this._overallInfoLabel.set_text('No totals yet');
                else this._overallInfoLabel.set_text(showAll ? `Showing all ${totalCount} apps` : `Showing top ${topN} of ${totalCount} apps`);
            }
            const rows = showAll ? allRows : allRows.slice(0, topN);
            const wantColorsRight = _safeGetBoolean(this._settings, 'color-coding', false);
            for (const r of rows) {
                const rowBox = new St.BoxLayout({ vertical: false });
                if (wantColorsRight) {
                    const badge = this._badgeClassForCO2?.(r.g) || '';
                    if (badge) rowBox.add_child(new St.BoxLayout({ style_class: `badge ${badge}` }));
                }
                // Use the same short formatter; it shows mg for tiny values. If you prefer the global unit for overall, change to _formatWithUnit(r.g)
                rowBox.add_child(new St.Label({ text: `${r.name}: ${this._formatCO2Short(r.g)}`, style_class: 'co2-software-item' }));
                this._rightListBox.add_child(rowBox);
            }
        } catch (e) {
            // best-effort rendering
        }
    }

    _exportOverallSoftwareTotalsCSV(viewAll = false) {
        try {
            const profile = this._settings.get_string('profile-name') || 'default';
            let obj = {};
            try { obj = JSON.parse(this._settings.get_string('software-totals-json')); } catch (_) { obj = {}; }
            const persisted = obj[profile] || {};
            const mem = this._overallTotals?.[profile] || {};
            const map = {};
            for (const [n, g] of Object.entries(persisted)) map[n] = Number(g) || 0;
            for (const [n, g] of Object.entries(mem)) map[n] = (map[n] || 0) + (Number(g) || 0);
            let rows = Object.entries(map)
                .map(([name, g]) => ({ name, g: Number(g) || 0 }))
                .sort((a, b) => b.g - a.g);
            if (!viewAll) {
                let showAll = true;
                try { showAll = this._settings.get_boolean('overall-show-all'); } catch (_) { showAll = true; }
                if (!showAll) {
                const topN = Math.max(5, Math.min(25, this._settings.get_int('per-process-top-n') || 10));
                rows = rows.slice(0, topN);
                }
            }
            const header = 'software,grams\n';
            const body = rows.map(r => `${r.name.replace(/[,\n]/g, ' ')} , ${r.g.toFixed(6)}`).join('\n') + (rows.length ? '\n' : '');
            const dirPref = this._settings.get_string('export-directory');
            const baseDir = dirPref && dirPref.length > 0 ? dirPref : GLib.get_home_dir();
            const safeProfile = (profile || 'default').replace(/[^A-Za-z0-9_-]/g, '_');
            const suffix = viewAll ? 'all' : 'top';
            const path = GLib.build_filenamev([baseDir, `co2-overall-software-${safeProfile}-${suffix}.csv`]);
            const file = Gio.File.new_for_path(path);
            const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
            stream.write_all(new TextEncoder().encode(header + body), null);
            stream.close(null);
        } catch (e) {
            console.warn(`CO2 Monitor: export overall software CSV failed: ${e}`);
        }
    }

    _importOverallSoftwareTotalsCSV() {
        try {
            const profile = this._settings.get_string('profile-name') || 'default';
            const dirPref = this._settings.get_string('export-directory');
            const baseDir = dirPref && dirPref.length > 0 ? dirPref : GLib.get_home_dir();
            // Default expected path (user can adjust the directory setting before importing)
            const safeProfile = (profile || 'default').replace(/[^A-Za-z0-9_-]/g, '_');
            const path = GLib.build_filenamev([baseDir, `co2-overall-software-${safeProfile}.csv`]);
            const file = Gio.File.new_for_path(path);
            if (!file.query_exists(null)) return;
            const [ok, bytes] = file.load_contents(null);
            if (!ok) return;
            const text = bytesToString(bytes) || '';
            const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
            // Skip header if present
            const startIdx = lines[0].toLowerCase().startsWith('software,') ? 1 : 0;
            let obj = {};
            try { obj = JSON.parse(this._settings.get_string('software-totals-json')); } catch (_) { obj = {}; }
            if (!obj[profile]) obj[profile] = {};
            for (let i = startIdx; i < lines.length; i++) {
                const parts = lines[i].split(',');
                if (parts.length < 2) continue;
                const name = parts[0].trim();
                const g = parseFloat(parts[1]);
                if (!name) continue;
                const prev = Number(obj[profile][name]) || 0;
                if (Number.isFinite(g)) obj[profile][name] = prev + g;
                // reflect to memory cache
                if (!this._overallTotals[profile]) this._overallTotals[profile] = {};
                const prevMem = Number(this._overallTotals[profile][name]) || 0;
                if (Number.isFinite(g)) this._overallTotals[profile][name] = prevMem + g;
            }
            this._settings.set_string('software-totals-json', JSON.stringify(obj));
            this._renderConsumersColumns();
        } catch (e) {
            console.warn(`CO2 Monitor: import overall software CSV failed: ${e}`);
        }
    }

    _badgeClassForCO2(co2Value) {
        if (co2Value < 0.01) return 'badge-very-low';
        if (co2Value < 0.05) return 'badge-low';
        if (co2Value < 0.1) return 'badge-moderate';
        if (co2Value < 0.2) return 'badge-high';
        if (co2Value < 0.5) return 'badge-very-high';
        if (co2Value < 1.0) return 'badge-extreme';
        return 'badge-critical';
    }

    _formatCO2Short(grams) {
        // Use milligrams for very small per-process values so they don't all show as 0.000
        if (!Number.isFinite(grams) || grams <= 0) return '0.000 g';
        if (grams < 0.001) {
            const mg = grams * 1000.0;
            // dynamic precision for mg: increase decimals for tiny values
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

    _updateTotalsRow() {
        try {
            const daily = this._settings.get_double('daily-total-g');
            const cum = this._settings.get_double('cumulative-total-g');
            const weekly = this._settings.get_double('weekly-total-g');
            const monthly = this._settings.get_double('monthly-total-g');
            const dailyText = this._formatWithUnit(daily);
            const weeklyText = this._formatWithUnit(weekly);
            const monthlyText = this._formatWithUnit(monthly);
            const cumText = this._formatWithUnit(cum);
            const weekStart = this._settings.get_string('week-start-day');
            const weekNum = (weekStart === 'sunday') ? this._getSundayWeekNumber(new Date()) : this._getISOWeekNumber(new Date());
            this._totalsItem.label.set_text(`Today: ${dailyText}  •  Week: ${weeklyText} (W${weekNum})  •  Month: ${monthlyText}  •  All-time: ${cumText}`);
            this._totalsItem.actor.show?.();

            // Period info row
            const dayEpoch = this._settings.get_int('daily-epoch-day');
            const weekEpoch = this._settings.get_int('weekly-epoch-week');
            const ym = this._settings.get_int('monthly-epoch-ym');
            const dayDate = dayEpoch ? this._dateFromEpochDay(dayEpoch) : null;
            const weekMonday = weekEpoch ? this._mondayFromEpochWeek(weekEpoch) : null;
            const ymText = ym ? this._ymToText(ym) : null;
            const parts = [];
            if (dayDate) parts.push(`Day reset: ${dayDate}`);
            if (weekMonday) parts.push(`Week start: ${weekMonday}`);
            if (ymText) parts.push(`Month: ${ymText}`);
            const infoText = parts.length ? parts.join('  •  ') : 'Period: —';
            this._periodInfoItem.label.set_text(infoText);
            // Tooltip with timestamps
            try {
                const tip = `Daily reset day=${dayEpoch || '-'}; week=${weekEpoch || '-'}; ym=${ym || '-'}`;
                this._periodInfoItem.actor.set_tooltip_text?.(tip);
            } catch (_) {}
            this._periodInfoItem.actor.show?.();
        } catch (_) {
            this._totalsItem.actor?.hide?.();
            this._periodInfoItem.actor?.hide?.();
        }
    }

    _getEpochWeek() {
        // Compute week index depending on configured start day.
        const msPerDay = 86400000;
        const msPerWeek = msPerDay * 7;
        const now = new Date();
        const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const dayMs = day.getTime();
        const weekStart = this._settings?.get_string('week-start-day') || 'monday';
        if (weekStart === 'sunday') {
            // Sunday=0 .. Saturday=6, subtract dow to get Sunday
            const dow = day.getDay();
            const sundayMs = dayMs - dow * msPerDay;
            return Math.floor(sundayMs / msPerWeek);
        } else {
            // Monday-based
            let dow = day.getDay(); // 0 Sunday .. 6 Saturday
            dow = (dow + 6) % 7; // shift so Monday=0
            const mondayMs = dayMs - dow * msPerDay;
            return Math.floor(mondayMs / msPerWeek);
        }
    }

    _getEpochYearMonth() {
        const now = new Date();
        const y = now.getFullYear();
        const m = now.getMonth() + 1; // 1..12
        return y * 100 + m;
    }

    _getISOWeekNumber(date) {
        // ISO week date weeks start on Monday, week 1 is the week with Jan 4th
        const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
        // Set to nearest Thursday: current date + 4 - current day number (Monday=1..Sunday=7)
        const dayNum = (d.getUTCDay() + 6) % 7; // 0..6 with Monday=0
        d.setUTCDate(d.getUTCDate() + 3 - dayNum);
        const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
        const diff = d - firstThursday;
        return 1 + Math.round(diff / (7 * 24 * 3600 * 1000));
    }

    _getSundayWeekNumber(date) {
        // Week number with Sunday as the first day (common US-style), simple count since Jan 1.
        const first = new Date(date.getFullYear(), 0, 1);
        const ms = (date - first) + ((first.getDay()) * 86400000);
        return Math.floor(ms / (7 * 86400000)) + 1;
    }

    _rollDailyHistory(prevEpochDay) {
        const profile = this._settings.get_string('profile-name') || 'default';
        const days = this._settings.get_int('history-days');
        const key = 'daily-history-json';
        let raw = this._settings.get_string(key);
        let obj = {};
        try { obj = JSON.parse(raw); } catch (_) { obj = {}; }
        if (!obj[profile]) obj[profile] = {};
        const dateStr = this._dateFromEpochDay(prevEpochDay);
        const prevDaily = this._settings.get_double('daily-total-g');
        obj[profile][dateStr] = prevDaily;
        // Trim to last N days
        const entries = Object.entries(obj[profile]).sort((a,b) => a[0].localeCompare(b[0]));
        const cut = Math.max(0, entries.length - days);
        const trimmed = entries.slice(cut);
        obj[profile] = Object.fromEntries(trimmed);
        this._settings.set_string(key, JSON.stringify(obj));
    }

    _exportDailyHistoryCSV() {
        try {
            const profile = this._settings.get_string('profile-name') || 'default';
            const key = 'daily-history-json';
            let obj = {};
            try { obj = JSON.parse(this._settings.get_string(key)); } catch (_) { obj = {}; }
            const map = obj[profile] || {};
            const rows = Object.entries(map).sort((a,b) => a[0].localeCompare(b[0]));
            const header = 'date,grams\n';
            const body = rows.map(([d, g]) => `${d},${(+g).toFixed(6)}`).join('\n') + (rows.length ? '\n' : '');
            const dirPref = this._settings.get_string('export-directory');
            const baseDir = dirPref && dirPref.length > 0 ? dirPref : GLib.get_home_dir();
            const safeProfile = profile.replace(/[^A-Za-z0-9_-]/g, '_');
            const path = GLib.build_filenamev([baseDir, `co2-daily-history-${safeProfile}.csv`]);
            const file = Gio.File.new_for_path(path);
            const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
            stream.write(new TextEncoder().encode(header + body), null);
            stream.close(null);
        } catch (e) {
            console.warn(`CO2 Monitor: export daily history failed: ${e}`);
        }
    }

    // _setupUPower removed

    _dateFromEpochDay(epochDay) {
        const ms = epochDay * 86400000;
        const d = new Date(ms);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    _mondayFromEpochWeek(epochWeek) {
        const msPerWeek = 7 * 86400000;
        const mondayMs = epochWeek * msPerWeek;
        const d = new Date(mondayMs);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    _ymToText(ym) {
        const y = Math.floor(ym / 100);
        const m = ym % 100;
        return `${y}-${String(m).padStart(2, '0')}`;
    }

    _exportTotalsToCSV() {
        try {
            const daily = this._settings.get_double('daily-total-g');
            const weekly = this._settings.get_double('weekly-total-g');
            const monthly = this._settings.get_double('monthly-total-g');
            const cum = this._settings.get_double('cumulative-total-g');
            const now = new Date();
            const ts = now.toISOString();
            const header = 'timestamp,daily_g,weekly_g,monthly_g,all_time_g\n';
            const line = `${ts},${daily.toFixed(6)},${weekly.toFixed(6)},${monthly.toFixed(6)},${cum.toFixed(6)}\n`;
            const dirPref = this._settings.get_string('export-directory');
            const baseDir = dirPref && dirPref.length > 0 ? dirPref : GLib.get_home_dir();
            const path = GLib.build_filenamev([baseDir, 'co2-consumption-totals.csv']);
            const file = Gio.File.new_for_path(path);
            let stream;
            if (!file.query_exists(null)) {
                stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
                stream.write(new TextEncoder().encode(header), null);
            } else {
                stream = file.append_to(Gio.FileCreateFlags.NONE, null);
            }
            stream.write(new TextEncoder().encode(line), null);
            stream.close(null);
        } catch (e) {
            console.warn(`CO2 Monitor: export CSV failed: ${e}`);
        }
    }

    _sparkline(arr) {
        if (!arr.length) return '—';
        const ticks = '▁▂▃▄▅▆▇█';
        const min = Math.min(...arr);
        const max = Math.max(...arr);
        const span = max - min || 1;
        return arr.map(v => {
            const idx = Math.floor(((v - min) / span) * (ticks.length - 1));
            return ticks[idx];
        }).join('');
    }

    _setupOrRefreshPeriodicExport() {
        // Clear existing
        try {
            if (this._periodicExportId) {
                GLib.source_remove(this._periodicExportId);
                this._periodicExportId = null;
            }
        } catch (_) {}
        // Schedule if enabled
        try {
            const enabled = this._settings.get_boolean('enable-periodic-export') && !this._settings.get_boolean('safe-mode');
            if (!enabled) return;
            let mins = this._settings.get_int('export-interval-min');
            if (!Number.isFinite(mins)) mins = 30;
            mins = Math.max(5, Math.min(240, mins));
            const sec = mins * 60;
            this._periodicExportId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, sec, () => {
                try { this._exportDailyHistoryCSV(); } catch (e) { console.warn(`CO2 Monitor: periodic export failed: ${e}`); }
                return GLib.SOURCE_CONTINUE;
            });
        } catch (e) {
            console.warn(`CO2 Monitor: periodic schedule error: ${e}`);
        }
    }
    
    _applyCO2ColorCoding(co2Value) {
        // Remove existing color classes
        const colorClasses = [
            'co2-level-very-low', 'co2-level-low', 'co2-level-moderate',
            'co2-level-high', 'co2-level-very-high', 'co2-level-extreme', 'co2-level-critical'
        ];
        // Always clear existing classes first
        for (const cls of colorClasses) {
            if (this._label.has_style_class_name?.(cls))
                this._label.remove_style_class_name(cls);
        }
        if (!this._settings.get_boolean('color-coding'))
            return;
        if (this._settings.get_boolean('monochrome-mode'))
            return; // Monochrome mode overrides color coding in UI
        
        // Apply appropriate color class based on CO2 level
        if (co2Value < 0.01) {
            this._label.add_style_class_name('co2-level-very-low');
        } else if (co2Value < 0.05) {
            this._label.add_style_class_name('co2-level-low');
        } else if (co2Value < 0.1) {
            this._label.add_style_class_name('co2-level-moderate');
        } else if (co2Value < 0.2) {
            this._label.add_style_class_name('co2-level-high');
        } else if (co2Value < 0.5) {
            this._label.add_style_class_name('co2-level-very-high');
        } else if (co2Value < 1.0) {
            this._label.add_style_class_name('co2-level-extreme');
        } else {
            this._label.add_style_class_name('co2-level-critical');
        }
    }

    _classForCO2(co2Value) {
        if (co2Value < 0.01) return 'co2-level-very-low';
        if (co2Value < 0.05) return 'co2-level-low';
        if (co2Value < 0.1) return 'co2-level-moderate';
        if (co2Value < 0.2) return 'co2-level-high';
        if (co2Value < 0.5) return 'co2-level-very-high';
        if (co2Value < 1.0) return 'co2-level-extreme';
        return 'co2-level-critical';
    }
    
    destroy() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        // Clear any pending tracked one-shot timeouts (sampling sleeps, etc.)
        for (const id of Array.from(_ephemeralTimeouts)) {
            GLib.source_remove(id);
            _ephemeralTimeouts.delete(id);
        }
        if (this._periodicExportId) {
            GLib.source_remove(this._periodicExportId);
            this._periodicExportId = null;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        if (this._settingsSignalIds && this._settingsSignalIds.length) {
            for (const id of this._settingsSignalIds) {
                try { this._settings.disconnect(id); } catch (_) {}
            }
            this._settingsSignalIds = [];
        }
        // UPower cleanup removed
        super.destroy();
    }
});

// Extension class (ES Modules export)
export default class CO2Extension extends BaseExtension {

    enable() {
        console.info('CO2 Consumption Monitor: Enabling extension');
        const settings = this.getSettings();
        const basePath = this.path;
        _extBasePath = basePath;
        const openPrefs = () => this.openPreferences();
        this._indicator = new CO2Indicator(basePath, settings, openPrefs);
        Main.panel.addToStatusArea('co2-monitor', this._indicator);
    }

    disable() {
        console.info('CO2 Consumption Monitor: Disabling extension');
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        // Null out caches required by reviewers
        _bundledCountryMap = null;
        _extBasePath = null;
    }
}


