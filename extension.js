/**
 * CO2 Consumption Monitor - GNOME Shell Extension
 *
 * Estimates real-time CO2 emissions from computer usage using a
 * CodeCarbon-inspired approach: RAPL energy measurement (with heuristic
 * fallback) + RAM power estimation + regional carbon intensity.
 *
 * https://github.com/adam-bouafia/Gnome-Shell-CO2-Consumption-monitor-extension
 * https://extensions.gnome.org/extension/8601/co2-consumption-monitor/
 *
 * Author: Adam Bouafia
 */
import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension as BaseExtension } from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    clearEphemeralTimeouts, sleepMs,
    safeGetBoolean, safeGetInt,
    formatWithUnit, formatCO2Short, sparkline,
    countryCodeToFlag, dateFromEpochDay, ymToText, mondayFromEpochWeek,
} from './lib/utils.js';
import {
    raplAvailable, readRaplSnapshot,
    getCpuTimes, getCpuUsagePercent,
    getTotalPowerWatts,
    resetAllCaches as resetPowerCaches,
} from './lib/power.js';
import { resolveIntensity, resetAllCaches as resetCarbonCaches } from './lib/carbon.js';
import { sampleProcessShares } from './lib/process.js';
import {
    updateTotals, accumulateSoftwareTotals, getOverallSoftwareTotals,
    rollDailyHistory, exportDailyHistoryCSV,
    getISOWeekNumber, getSundayWeekNumber,
} from './lib/storage.js';

// ---------------------------------------------------------------------------
// Icon helper
// ---------------------------------------------------------------------------

function _tryCreateLogoIcon(basePath) {
    if (!basePath) return null;
    const candidates = [
        GLib.build_filenamev([basePath, 'data', 'CO2.svg']),
        GLib.build_filenamev([basePath, 'data', 'co2.svg']),
        GLib.build_filenamev([basePath, 'CO2.svg']),
        GLib.build_filenamev([basePath, 'co2.svg']),
    ];
    for (const path of candidates) {
        try {
            const f = Gio.File.new_for_path(path);
            if (f.query_exists(null)) {
                const gicon = new Gio.FileIcon({ file: f });
                return new St.Icon({ gicon, style_class: 'co2-monitor-icon system-status-icon', icon_size: 36 });
            }
        } catch (_) {}
    }
    return null;
}

// ---------------------------------------------------------------------------
// Layout helper
// ---------------------------------------------------------------------------

// St.BoxLayout:vertical was removed in GNOME 51; :orientation exists from 48.
function vbox(params = {}) {
    const box = new St.BoxLayout(params);
    if ('orientation' in box)
        box.orientation = Clutter.Orientation.VERTICAL;
    else
        box.vertical = true;
    return box;
}

// ---------------------------------------------------------------------------
// CO2 Panel Indicator
// ---------------------------------------------------------------------------

const CO2Indicator = GObject.registerClass(
class CO2Indicator extends PanelMenu.Button {
    _init(basePath, settings, openPrefs) {
        super._init(0.0, 'CO2 Consumption Monitor');
        this._basePath = basePath;
        this._settings = settings;
        this._openPrefs = openPrefs;
        this._updating = false;
        this._prevCpuTimes = getCpuTimes();
        this._prevRapl = readRaplSnapshot();
        this._rolling = [];
        this._history = [];
        this._lastShares = [];
        this._sampleTick = 0;
        this._overallTotals = {};
        this._intensityCache = { value: null, ts: 0, source: null, countryCode: null };
        this._lastIntensityValue = null;
        this._lastIntensitySource = 'fixed';
        this._lastCountryCode = null;
        this._lastPowerSource = raplAvailable() ? 'rapl' : 'heuristic';
        this._periodicExportId = null;
        this._settingsSignalIds = [];

        this._co2Data = { total_co2_g: 0, per_software_co2: [] };

        this._buildPanel();
        this._createPopupMenu();
        this._scheduleNext();

        // React to settings changes
        this._settingsChangedId = this._settings.connect('changed', () => {
            this._scheduleNext(true);
            this._setupPeriodicExport();
        });
        try {
            this._settingsSignalIds.push(
                this._settings.connect('changed::display-unit', () => this._updateUI()),
                this._settings.connect('changed::overall-show-all', () => this._renderConsumersColumns()),
            );
        } catch (_) {}

        this._setupPeriodicExport();

        if (raplAvailable()) {
            console.info('CO2 Monitor: Using RAPL for power measurement (CodeCarbon mode)');
        } else {
            console.info('CO2 Monitor: RAPL unavailable, using CPU heuristic + RAM estimation');
        }
    }

    // -----------------------------------------------------------------------
    // Panel bar widget
    // -----------------------------------------------------------------------

    _buildPanel() {
        this._box = new St.BoxLayout({ style_class: 'co2-monitor-box' });
        this._box.set_y_align?.(Clutter.ActorAlign.CENTER);
        this._box.y_align = Clutter.ActorAlign.CENTER;
        this._box.set_spacing?.(0);
        this._box.spacing = 0;

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
    }

    // -----------------------------------------------------------------------
    // Popup menu
    // -----------------------------------------------------------------------

    _createPopupMenu() {
        // Popup opacity
        const applyPopupOpacity = () => {
            try {
                const pct = Math.max(0, Math.min(100, this._settings.get_int('popup-opacity')));
                const rgba = `rgba(30,30,30,${(pct / 100).toFixed(2)})`;
                if (this.menu?.box) this.menu.box.set_style(`background-color: ${rgba};`);
            } catch (_) {}
        };
        applyPopupOpacity();
        this.menu.connect('open-state-changed', (_m, isOpen) => { if (isOpen) applyPopupOpacity(); });
        try { this._settingsSignalIds.push(this._settings.connect('changed::popup-opacity', applyPopupOpacity)); } catch (_) {}

        // Current consumption header
        this._totalSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._totalSection);

        this._totalItem = new PopupMenu.PopupMenuItem('Current consumption: 0.000 g', {
            reactive: false, style_class: 'co2-popup-header',
        });
        this._totalSection.addMenuItem(this._totalItem);

        // Power source info
        this._powerSourceItem = new PopupMenu.PopupMenuItem('Power: --', {
            reactive: false, style_class: 'co2-popup-item',
        });
        this._totalSection.addMenuItem(this._powerSourceItem);

        // Trend sparkline
        this._trendItem = new PopupMenu.PopupMenuItem('Trend: --', {
            reactive: false, style_class: 'co2-popup-item',
        });
        this._totalSection.addMenuItem(this._trendItem);

        // Persistent totals
        this._totalsItem = new PopupMenu.PopupMenuItem('Totals: --', {
            reactive: false, style_class: 'co2-popup-item',
        });
        this._totalSection.addMenuItem(this._totalsItem);

        // Period info
        this._periodInfoItem = new PopupMenu.PopupMenuItem('Period: --', {
            reactive: false, style_class: 'co2-popup-item',
        });
        this._totalSection.addMenuItem(this._periodInfoItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Intensity row
        this._intensityItem = new PopupMenu.PopupMenuItem('Intensity: --', {
            reactive: false, style_class: 'co2-popup-item',
        });
        this.menu.addMenuItem(this._intensityItem);

        // Side-by-side consumers (left: current, right: overall cumulative)
        this._consumersColumnsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._consumersColumnsSection);
        this._consumersItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        this._consumersColumnsSection.addMenuItem(this._consumersItem);

        const columnsContainer = this._consumersItem.actor || this._consumersItem;
        const cols = new St.BoxLayout({ x_expand: true });
        cols.set_spacing?.(12);
        columnsContainer.add_child(cols);

        // Left column
        const leftCol = vbox({ x_expand: true, y_expand: true });
        leftCol.add_child(new St.Label({ text: 'Current CO2 Consumers', style_class: 'co2-popup-header' }));
        this._leftListBox = vbox({ x_expand: true, y_expand: true });
        leftCol.add_child(this._leftListBox);

        // Right column (scrollable)
        const rightCol = vbox({ x_expand: true, y_expand: true });
        rightCol.add_child(new St.Label({ text: 'Overall CO2 Consumers', style_class: 'co2-popup-header' }));
        this._overallInfoLabel = new St.Label({ text: '--', style_class: 'co2-popup-item' });
        this._rightListBox = vbox({ x_expand: true, y_expand: true });
        const overallScroll = new St.ScrollView({
            style_class: 'co2-overall-scroll', overlay_scrollbars: true,
            x_expand: true, y_expand: true,
        });
        try { overallScroll.set_policy?.(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC); } catch (_) {}
        overallScroll.add_child(this._rightListBox);
        rightCol.add_child(this._overallInfoLabel);
        rightCol.add_child(overallScroll);

        cols.add_child(leftCol);
        cols.add_child(rightCol);

        // Bottom controls
        const bottomSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(bottomSection);
        const controls = new St.BoxLayout();
        controls.add_style_class_name?.('co2-popup-controls');
        controls.add_child(new St.Widget({ x_expand: true })); // filler

        const clearBtn = new St.Button({
            child: new St.Icon({ icon_name: 'user-trash-symbolic', style_class: 'system-status-icon', icon_size: 20 }),
            style_class: 'co2-popup-btn',
        });
        clearBtn.set_tooltip_text?.('Clear stored totals');
        clearBtn.connect('clicked', () => {
            try {
                this._settings.set_double('daily-total-g', 0);
                this._settings.set_double('weekly-total-g', 0);
                this._settings.set_double('monthly-total-g', 0);
                this._settings.set_double('cumulative-total-g', 0);
                this._updateTotalsRow();
            } catch (_) {}
        });

        const settingsBtn = new St.Button({
            child: new St.Icon({ icon_name: 'emblem-system-symbolic', style_class: 'system-status-icon', icon_size: 20 }),
            style_class: 'co2-popup-btn',
        });
        settingsBtn.set_tooltip_text?.('Open Settings');
        settingsBtn.connect('clicked', () => {
            try { this._openPrefs?.(); } catch (_) {}
        });

        controls.add_child(clearBtn);
        controls.add_child(settingsBtn);
        bottomSection.actor.add_child(controls);
    }

    // -----------------------------------------------------------------------
    // Update loop
    // -----------------------------------------------------------------------

    _scheduleNext(reset = false) {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        const interval = Math.max(2, this._settings.get_int('update-interval'));
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            if (!this._updating) this._updateData();
            return GLib.SOURCE_REMOVE;
        });
        if (reset && !this._updating) this._updateData();
    }

    async _updateData() {
        if (this._updating) return;
        this._updating = true;
        try {
            const interval = this._settings.get_int('update-interval');
            const profile = this._settings.get_string('cpu-profile');
            const safe = this._settings.get_boolean('safe-mode');

            // -- Carbon intensity --
            const intensityResult = await resolveIntensity({
                useOnline: !safe && this._settings.get_boolean('use-online-intensity'),
                provider: this._settings.get_string('intensity-provider'),
                apiKey: this._settings.get_string('electricitymaps-api-key'),
                zone: this._settings.get_string('electricitymaps-zone'),
                autoDetectZone: this._settings.get_boolean('auto-detect-zone'),
                fixedIntensity: this._settings.get_int('carbon-intensity'),
                basePath: this._basePath,
                cache: this._intensityCache,
                cacheTtl: Math.max(10, Math.min(3600, this._settings.get_int('provider-cache-ttl'))),
            });
            const intensity = intensityResult.intensity;
            this._lastIntensityValue = intensity;
            this._lastIntensitySource = intensityResult.source;
            this._lastCountryCode = intensityResult.countryCode;

            // -- Power measurement (CodeCarbon approach) --
            const sampleMs = Math.max(50, Math.min(1000, this._settings.get_int('per-process-sample-ms') || 250));
            await sleepMs(sampleMs);

            const currCpu = getCpuTimes();
            const cpuPercent = getCpuUsagePercent(this._prevCpuTimes, currCpu);
            const currRapl = readRaplSnapshot();
            const power = getTotalPowerWatts({
                prevRapl: this._prevRapl,
                currRapl,
                cpuPercent,
                profile,
            });
            this._prevCpuTimes = currCpu;
            this._prevRapl = currRapl;
            this._lastPowerSource = power.source;

            // -- Emissions calculation --
            // Energy: P(W) * t(h) = Wh -> kWh; Emissions: intensity(g/kWh) * kWh
            const energyKWh = (power.watts * interval / 3600) / 1000;
            const intervalCO2g = intensity * energyKWh;

            // Smoothing
            let totalCO2g = intervalCO2g;
            if (this._settings.get_boolean('smoothing-enabled')) {
                const windowSize = Math.max(1, Math.min(60, this._settings.get_int('smoothing-window')));
                this._rolling.push(totalCO2g);
                if (this._rolling.length > windowSize) this._rolling.shift();
                totalCO2g = this._rolling.reduce((a, b) => a + b, 0) / this._rolling.length;
            } else {
                this._rolling = [totalCO2g];
            }

            // -- Per-process breakdown --
            let perSoftware = [];
            if (!safe && this._settings.get_boolean('per-software-monitoring')) {
                try {
                    this._sampleTick++;
                    if (this._sampleTick % 6 === 1) {
                        this._lastShares = await sampleProcessShares(sampleMs);
                    }
                    const topN = Math.max(5, Math.min(25, this._settings.get_int('per-process-top-n') || 10));
                    perSoftware = (this._lastShares || [])
                        .slice(0, topN)
                        .map(t => ({ name: t.name, co2_g: totalCO2g * t.share }));
                } catch (e) {
                    console.warn(`CO2 Monitor: per-process sampling error: ${e}`);
                }
            }

            // -- Persistence --
            try {
                if (perSoftware.length)
                    accumulateSoftwareTotals(this._settings, this._overallTotals, perSoftware);
                updateTotals(this._settings, intervalCO2g, (prevDay) => {
                    try { rollDailyHistory(this._settings, prevDay); } catch (_) {}
                    if (this._settings.get_boolean('auto-export-history'))
                        try { exportDailyHistoryCSV(this._settings); } catch (_) {}
                });
            } catch (_) {}

            this._co2Data = { total_co2_g: totalCO2g, per_software_co2: perSoftware, watts: power.watts };
            this._updateUI();
        } catch (e) {
            console.error(`CO2 Monitor: estimation error: ${e}`);
            this._co2Data = { total_co2_g: 0, per_software_co2: [], error: e.toString() };
            this._updateUI();
        } finally {
            this._updating = false;
            this._scheduleNext();
        }
    }

    // -----------------------------------------------------------------------
    // UI updates
    // -----------------------------------------------------------------------

    _getDisplayUnit() {
        try {
            const u = this._settings.get_string('display-unit');
            if (u === 'mg' || u === 'kg') return u;
        } catch (_) {}
        return 'g';
    }

    _fmt(grams) {
        return formatWithUnit(grams, this._getDisplayUnit());
    }

    _updateUI() {
        const totalG = this._co2Data.total_co2_g;
        this._label.set_text(this._fmt(totalG));
        this._applyCO2ColorCoding(totalG);

        this._totalItem.label.set_text(`Current consumption: ${this._fmt(totalG)}`);

        // Power source row
        const watts = this._co2Data.watts;
        this._powerSourceItem.label.set_text(
            `Power: ${watts ? watts.toFixed(1) : '--'} W`
        );

        this._updateTotalsRow();
        this._renderConsumersColumns();

        // Trend
        if (this._settings.get_boolean('show-trend')) {
            const historyLen = Math.max(10, Math.min(300, this._settings.get_int('history-length')));
            this._history.push(totalG);
            if (this._history.length > historyLen) this._history.shift();
            this._trendItem.label.set_text(`Trend: ${sparkline(this._history)}`);
            this._trendItem.actor.show?.();
        } else {
            this._trendItem.actor.hide?.();
        }

        // Intensity row
        if (this._settings.get_boolean('show-intensity')) {
            const val = this._lastIntensityValue;
            const src = this._lastIntensitySource;
            const code = this._lastCountryCode;
            const flag = code ? countryCodeToFlag(code) : null;
            const parts = [];
            parts.push(typeof val === 'number' ? `Intensity: ${val.toFixed(0)} g/kWh` : 'Intensity: --');
            if (code) parts.push(`${flag ? flag + ' ' : ''}${code}`);
            if (src && src !== 'fixed') parts.push(`(${src})`);
            this._intensityItem.label.set_text(parts.join(' '));
            this._intensityItem.actor.show?.();
        } else {
            this._intensityItem.actor.hide?.();
        }
    }

    _updateTotalsRow() {
        try {
            const daily = this._settings.get_double('daily-total-g');
            const weekly = this._settings.get_double('weekly-total-g');
            const monthly = this._settings.get_double('monthly-total-g');
            const cum = this._settings.get_double('cumulative-total-g');
            const weekStart = this._settings.get_string('week-start-day');
            const weekNum = weekStart === 'sunday'
                ? getSundayWeekNumber(new Date())
                : getISOWeekNumber(new Date());
            this._totalsItem.label.set_text(
                `Today: ${this._fmt(daily)}  \u2022  Week: ${this._fmt(weekly)} (W${weekNum})  \u2022  Month: ${this._fmt(monthly)}  \u2022  All-time: ${this._fmt(cum)}`
            );
            this._totalsItem.actor.show?.();

            // Period info
            const dayEpoch = this._settings.get_int('daily-epoch-day');
            const weekEpoch = this._settings.get_int('weekly-epoch-week');
            const ym = this._settings.get_int('monthly-epoch-ym');
            const parts = [];
            if (dayEpoch) parts.push(`Day reset: ${dateFromEpochDay(dayEpoch)}`);
            if (weekEpoch) parts.push(`Week start: ${mondayFromEpochWeek(weekEpoch)}`);
            if (ym) parts.push(`Month: ${ymToText(ym)}`);
            this._periodInfoItem.label.set_text(parts.length ? parts.join('  \u2022  ') : 'Period: --');
            this._periodInfoItem.actor.show?.();
        } catch (_) {
            this._totalsItem.actor?.hide?.();
            this._periodInfoItem.actor?.hide?.();
        }
    }

    _renderConsumersColumns() {
        try {
            // Left column (current interval)
            if (this._leftListBox?.get_children)
                for (const ch of this._leftListBox.get_children()) ch.destroy();

            const wantColors = this._settings.get_boolean('color-coding');
            const topSoftware = this._co2Data?.per_software_co2 || [];

            if (this._co2Data?.error) {
                this._leftListBox.add_child(new St.Label({ text: `Error: ${this._co2Data.error}`, style_class: 'co2-popup-item' }));
            } else if (!topSoftware.length || topSoftware.every(s => s.co2_g === 0)) {
                this._leftListBox.add_child(new St.Label({ text: 'No active processes detected', style_class: 'co2-popup-item' }));
            } else {
                for (const sw of topSoftware) {
                    if (!(sw.co2_g > 0)) continue;
                    const row = new St.BoxLayout();
                    if (wantColors) {
                        const badge = this._badgeClass(sw.co2_g);
                        if (badge) row.add_child(new St.BoxLayout({ style_class: `badge ${badge}` }));
                    }
                    row.add_child(new St.Label({ text: `${sw.name}: ${formatCO2Short(sw.co2_g)}`, style_class: 'co2-software-item' }));
                    this._leftListBox.add_child(row);
                }
            }

            // Right column (cumulative)
            if (this._rightListBox?.get_children)
                for (const ch of this._rightListBox.get_children()) ch.destroy();

            const allRows = getOverallSoftwareTotals(this._settings, this._overallTotals);
            const showAll = safeGetBoolean(this._settings, 'overall-show-all', true);
            const topN = Math.max(5, Math.min(25, safeGetInt(this._settings, 'per-process-top-n', 10)));
            const rows = showAll ? allRows : allRows.slice(0, topN);

            if (this._overallInfoLabel) {
                this._overallInfoLabel.set_text(
                    allRows.length === 0 ? 'No totals yet'
                    : showAll ? `Showing all ${allRows.length} apps`
                    : `Showing top ${topN} of ${allRows.length} apps`
                );
            }

            for (const r of rows) {
                const rowBox = new St.BoxLayout();
                if (wantColors) {
                    const badge = this._badgeClass(r.g);
                    if (badge) rowBox.add_child(new St.BoxLayout({ style_class: `badge ${badge}` }));
                }
                rowBox.add_child(new St.Label({ text: `${r.name}: ${formatCO2Short(r.g)}`, style_class: 'co2-software-item' }));
                this._rightListBox.add_child(rowBox);
            }
        } catch (_) {}
    }

    // -----------------------------------------------------------------------
    // Color coding
    // -----------------------------------------------------------------------

    _badgeClass(co2) {
        if (co2 < 0.01) return 'badge-very-low';
        if (co2 < 0.05) return 'badge-low';
        if (co2 < 0.1) return 'badge-moderate';
        if (co2 < 0.2) return 'badge-high';
        if (co2 < 0.5) return 'badge-very-high';
        if (co2 < 1.0) return 'badge-extreme';
        return 'badge-critical';
    }

    _applyCO2ColorCoding(co2) {
        const classes = [
            'co2-level-very-low', 'co2-level-low', 'co2-level-moderate',
            'co2-level-high', 'co2-level-very-high', 'co2-level-extreme', 'co2-level-critical',
        ];
        for (const cls of classes) {
            if (this._label.has_style_class_name?.(cls))
                this._label.remove_style_class_name(cls);
        }
        if (!this._settings.get_boolean('color-coding')) return;
        if (this._settings.get_boolean('monochrome-mode')) return;

        let cls;
        if (co2 < 0.01) cls = 'co2-level-very-low';
        else if (co2 < 0.05) cls = 'co2-level-low';
        else if (co2 < 0.1) cls = 'co2-level-moderate';
        else if (co2 < 0.2) cls = 'co2-level-high';
        else if (co2 < 0.5) cls = 'co2-level-very-high';
        else if (co2 < 1.0) cls = 'co2-level-extreme';
        else cls = 'co2-level-critical';
        this._label.add_style_class_name(cls);
    }

    // -----------------------------------------------------------------------
    // Periodic export
    // -----------------------------------------------------------------------

    _setupPeriodicExport() {
        if (this._periodicExportId) {
            try { GLib.source_remove(this._periodicExportId); } catch (_) {}
            this._periodicExportId = null;
        }
        try {
            const enabled = this._settings.get_boolean('enable-periodic-export') && !this._settings.get_boolean('safe-mode');
            if (!enabled) return;
            let mins = this._settings.get_int('export-interval-min');
            mins = Math.max(5, Math.min(240, Number.isFinite(mins) ? mins : 30));
            this._periodicExportId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, mins * 60, () => {
                try { exportDailyHistoryCSV(this._settings); } catch (_) {}
                return GLib.SOURCE_CONTINUE;
            });
        } catch (_) {}
    }

    // -----------------------------------------------------------------------
    // Cleanup
    // -----------------------------------------------------------------------

    destroy() {
        if (this._timeoutId) { GLib.source_remove(this._timeoutId); this._timeoutId = null; }
        clearEphemeralTimeouts();
        if (this._periodicExportId) { GLib.source_remove(this._periodicExportId); this._periodicExportId = null; }
        if (this._settingsChangedId) { this._settings.disconnect(this._settingsChangedId); this._settingsChangedId = null; }
        for (const id of this._settingsSignalIds) {
            try { this._settings.disconnect(id); } catch (_) {}
        }
        this._settingsSignalIds = [];
        super.destroy();
    }
});

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default class CO2Extension extends BaseExtension {
    enable() {
        console.info('CO2 Consumption Monitor: Enabling extension');
        const settings = this.getSettings();
        this._indicator = new CO2Indicator(this.path, settings, () => this.openPreferences());
        Main.panel.addToStatusArea('co2-monitor', this._indicator);
    }

    disable() {
        console.info('CO2 Consumption Monitor: Disabling extension');
        if (this._indicator) { this._indicator.destroy(); this._indicator = null; }
        resetPowerCaches();
        resetCarbonCaches();
    }
}
