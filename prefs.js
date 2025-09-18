import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
// Robust settings loader that doesn't depend on ExtensionUtils path
function getSettings() {
    const SCHEMA_ID = 'org.gnome.shell.extensions.co2consumption';
    try {
        // Resolve current directory via URI-safe API
        const thisFile = Gio.File.new_for_uri(import.meta.url);
        const extDir = thisFile.get_parent().get_path();
        const schemaDir = GLib.build_filenamev([extDir, 'schemas']);

        const defaultSrc = Gio.SettingsSchemaSource.get_default();
        const src = Gio.SettingsSchemaSource.new_from_directory(schemaDir, defaultSrc, false);
        const schema = src.lookup(SCHEMA_ID, true);
        if (!schema)
            throw new Error(`Schema ${SCHEMA_ID} not found in ${schemaDir}`);
        return new Gio.Settings({ settings_schema: schema });
    } catch (e) {
        // Fallback: try global schema (if installed system-wide)
        try { return new Gio.Settings({ schema_id: SCHEMA_ID }); } catch (_) { throw e; }
    }
}

// A single Preferences Page added to the provided window
const CO2ConsumptionPreferences = GObject.registerClass(
class CO2ConsumptionPreferences extends Adw.PreferencesPage {
    _init() {
        super._init({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
    this._settings = getSettings();
        
        // CO2 Calculation group
        const calculationGroup = new Adw.PreferencesGroup({
            title: 'CO2 Calculation',
            description: 'Configure how CO2 emissions are calculated',
        });
        this.add(calculationGroup);
        
        // Update interval setting
        const updateIntervalRow = new Adw.SpinRow({
            title: 'Update Interval',
            subtitle: 'How often to update CO2 readings (seconds)',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 60,
                step_increment: 1,
                page_increment: 5,
                value: this._settings.get_int('update-interval'),
            }),
        });
        calculationGroup.add(updateIntervalRow);
        updateIntervalRow.connect('notify::value', () => {
            this._settings.set_int('update-interval', updateIntervalRow.get_value());
        });
        
        // Carbon intensity setting
        const carbonIntensityRow = new Adw.SpinRow({
            title: 'Carbon Intensity',
            subtitle: 'Regional carbon intensity (gCO2/kWh)',
            adjustment: new Gtk.Adjustment({
                lower: 50,
                upper: 1000,
                step_increment: 10,
                page_increment: 50,
                value: this._settings.get_int('carbon-intensity'),
            }),
        });
        calculationGroup.add(carbonIntensityRow);
        carbonIntensityRow.connect('notify::value', () => {
            this._settings.set_int('carbon-intensity', carbonIntensityRow.get_value());
        });
        
        // Monitoring Mode group
        const monitoringGroup = new Adw.PreferencesGroup({
            title: 'Monitoring Mode',
            description: 'Configure what to monitor and display',
        });
        this.add(monitoringGroup);
        
        // Per-software monitoring toggle
        const perSoftwareRow = new Adw.SwitchRow({
            title: 'Per-Software Monitoring',
            subtitle: 'Track CO2 consumption by individual applications',
            active: this._settings.get_boolean('per-software-monitoring'),
        });
        monitoringGroup.add(perSoftwareRow);
        perSoftwareRow.connect('notify::active', () => {
            this._settings.set_boolean('per-software-monitoring', perSoftwareRow.get_active());
        });
        
        // Color coding toggle
        const colorCodingRow = new Adw.SwitchRow({
            title: 'Color Coding',
            subtitle: 'Use colors to indicate CO2 emission levels',
            active: this._settings.get_boolean('color-coding'),
        });
        monitoringGroup.add(colorCodingRow);
        
        // Smoothing options
        const smoothingRow = new Adw.SwitchRow({
            title: 'Smoothing',
            subtitle: 'Average recent samples to reduce noise',
            active: this._settings.get_boolean('smoothing-enabled'),
        });
        smoothingRow.connect('notify::active', () => {
            this._settings.set_boolean('smoothing-enabled', smoothingRow.get_active());
        });
        monitoringGroup.add(smoothingRow);

        const smoothingWinRow = new Adw.SpinRow({
            title: 'Smoothing Window',
            subtitle: 'Number of samples (1–60)',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 60,
                step_increment: 1,
                page_increment: 5,
                value: this._settings.get_int('smoothing-window'),
            }),
        });
        smoothingWinRow.connect('notify::value', () => {
            this._settings.set_int('smoothing-window', smoothingWinRow.get_value());
        });
        monitoringGroup.add(smoothingWinRow);

        const sampleMsRow = new Adw.SpinRow({
            title: 'Per-Process Sample (ms)',
            subtitle: 'Duration to measure CPU shares (50–1000)',
            adjustment: new Gtk.Adjustment({
                lower: 50,
                upper: 1000,
                step_increment: 25,
                page_increment: 100,
                value: this._settings.get_int('per-process-sample-ms'),
            }),
        });
        sampleMsRow.connect('notify::value', () => {
            this._settings.set_int('per-process-sample-ms', sampleMsRow.get_value());
        });
        monitoringGroup.add(sampleMsRow);

        const topNRow = new Adw.SpinRow({
            title: 'Top N Processes',
            subtitle: 'Number to display (5–25)',
            adjustment: new Gtk.Adjustment({
                lower: 5,
                upper: 25,
                step_increment: 1,
                page_increment: 5,
                value: this._settings.get_int('per-process-top-n'),
            }),
        });
        topNRow.connect('notify::value', () => {
            this._settings.set_int('per-process-top-n', topNRow.get_value());
        });
        monitoringGroup.add(topNRow);

        // Show all overall totals toggle
        const overallShowAllRow = new Adw.SwitchRow({
            title: 'Show All Overall Totals',
            subtitle: 'Show full cumulative software list in popup (otherwise limit to Top N)',
            active: (() => { try { return this._settings.get_boolean('overall-show-all'); } catch (_) { return true; } })(),
        });
        overallShowAllRow.connect('notify::active', () => {
            try { this._settings.set_boolean('overall-show-all', overallShowAllRow.get_active()); } catch (_) { /* ignore until schemas compiled */ }
        });
        monitoringGroup.add(overallShowAllRow);

        const showTrendRow = new Adw.SwitchRow({
            title: 'Show Trend',
            subtitle: 'Display recent emission trend in popup',
            active: this._settings.get_boolean('show-trend'),
        });
        showTrendRow.connect('notify::active', () => {
            this._settings.set_boolean('show-trend', showTrendRow.get_active());
        });
        monitoringGroup.add(showTrendRow);

        const historyLenRow = new Adw.SpinRow({
            title: 'Trend History Length',
            subtitle: 'Number of samples (10–300)',
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 300,
                step_increment: 10,
                page_increment: 20,
                value: this._settings.get_int('history-length'),
            }),
        });
        historyLenRow.connect('notify::value', () => {
            this._settings.set_int('history-length', historyLenRow.get_value());
        });
        monitoringGroup.add(historyLenRow);
        colorCodingRow.connect('notify::active', () => {
            this._settings.set_boolean('color-coding', colorCodingRow.get_active());
        });

        // Data Source group
        const dataSourceGroup = new Adw.PreferencesGroup({
            title: 'Data Source',
            description: 'Use real-time grid carbon intensity when available',
        });
        this.add(dataSourceGroup);

        const useOnlineRow = new Adw.SwitchRow({
            title: 'Use Online Intensity',
            subtitle: 'Fetch grid carbon intensity from a provider',
            active: this._settings.get_boolean('use-online-intensity'),
        });
        dataSourceGroup.add(useOnlineRow);
        useOnlineRow.connect('notify::active', () => {
            this._settings.set_boolean('use-online-intensity', useOnlineRow.get_active());
        });

        const providerRow = new Adw.ComboRow({
            title: 'Intensity Provider',
            subtitle: 'Select the carbon intensity provider',
        });
        const providerModel = new Gtk.StringList();
        providerModel.append('electricitymaps');
        providerModel.append('auto-country');
        providerRow.set_model(providerModel);
        const currentProvider = this._settings.get_string('intensity-provider');
        providerRow.set_selected(currentProvider === 'auto-country' ? 1 : 0);
        dataSourceGroup.add(providerRow);
        providerRow.connect('notify::selected', () => {
            const sel = providerRow.get_selected();
            const mapping = ['electricitymaps', 'auto-country'];
            this._settings.set_string('intensity-provider', mapping[sel] ?? 'electricitymaps');
        });

        const apiKeyRow = new Adw.EntryRow({
            title: 'ElectricityMaps API Key',
        });
        apiKeyRow.set_text(this._settings.get_string('electricitymaps-api-key'));
        apiKeyRow.connect('notify::text', () => {
            this._settings.set_string('electricitymaps-api-key', apiKeyRow.get_text());
        });
        dataSourceGroup.add(apiKeyRow);

        const zoneRow = new Adw.EntryRow({
            title: 'ElectricityMaps Zone (e.g., DE, FR, US-CAL)',
        });
        zoneRow.set_text(this._settings.get_string('electricitymaps-zone'));
        zoneRow.connect('notify::text', () => {
            this._settings.set_string('electricitymaps-zone', zoneRow.get_text());
        });
        dataSourceGroup.add(zoneRow);

        const autoDetectRow = new Adw.SwitchRow({
            title: 'Auto-detect Zone',
            subtitle: 'Use IP geolocation to set country code when zone is empty',
            active: this._settings.get_boolean('auto-detect-zone'),
        });
        autoDetectRow.connect('notify::active', () => {
            this._settings.set_boolean('auto-detect-zone', autoDetectRow.get_active());
        });
        dataSourceGroup.add(autoDetectRow);

        const cacheTtlRow = new Adw.SpinRow({
            title: 'Provider Cache TTL',
            subtitle: 'Seconds to cache grid intensity (10–3600)',
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 3600,
                step_increment: 10,
                page_increment: 60,
                value: this._settings.get_int('provider-cache-ttl'),
            }),
        });
        cacheTtlRow.connect('notify::value', () => {
            this._settings.set_int('provider-cache-ttl', cacheTtlRow.get_value());
        });
        dataSourceGroup.add(cacheTtlRow);

        const showIntensityRow = new Adw.SwitchRow({
            title: 'Show Carbon Intensity',
            subtitle: 'Display intensity value and provider in popup',
            active: this._settings.get_boolean('show-intensity'),
        });
        showIntensityRow.connect('notify::active', () => {
            this._settings.set_boolean('show-intensity', showIntensityRow.get_active());
        });
        dataSourceGroup.add(showIntensityRow);
        
        
        // Notification group
        const notificationGroup = new Adw.PreferencesGroup({
            title: 'Notifications',
            description: 'Configure threshold-based notifications',
        });
        this.add(notificationGroup);
        
        // Enable notifications toggle
        const enableNotificationsRow = new Adw.SwitchRow({
            title: 'Enable Notifications',
            subtitle: 'Show notifications when CO2 threshold is exceeded',
            active: false,
        });
        notificationGroup.add(enableNotificationsRow);
        
        // Notification threshold setting
        const thresholdRow = new Adw.SpinRow({
            title: 'Notification Threshold',
            subtitle: 'CO2 threshold for notifications (grams per update interval)',
            adjustment: new Gtk.Adjustment({
                lower: 0.01,
                upper: 10.0,
                step_increment: 0.01,
                page_increment: 0.1,
                value: 0.2,
            }),
            digits: 2,
        });
        notificationGroup.add(thresholdRow);
        
        // Notification cooldown setting
        const cooldownRow = new Adw.SpinRow({
            title: 'Notification Cooldown',
            subtitle: 'Minimum time between notifications (minutes)',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 60,
                step_increment: 1,
                page_increment: 5,
                value: 5,
            }),
        });
        notificationGroup.add(cooldownRow);
        
        // Display group
        const displayGroup = new Adw.PreferencesGroup({
            title: 'Display',
            description: 'Configure how data is displayed',
        });
        this.add(displayGroup);
        
        // Display unit setting
        const unitRow = new Adw.ComboRow({
            title: 'Display Unit',
            subtitle: 'Unit for panel label and Current consumption',
        });
        const unitModel = new Gtk.StringList();
        unitModel.append('Grams (g)');
        unitModel.append('Milligrams (mg)');
        unitModel.append('Kilograms (kg)');
        unitRow.set_model(unitModel);
        const currentUnit = (() => { try { return this._settings.get_string('display-unit'); } catch (_) { return 'g'; } })();
        unitRow.set_selected(currentUnit === 'mg' ? 1 : (currentUnit === 'kg' ? 2 : 0));
        unitRow.connect('notify::selected', () => {
            const idx = unitRow.get_selected();
            const map = ['g','mg','kg'];
            try { this._settings.set_string('display-unit', map[idx] || 'g'); } catch (_) {}
        });
        displayGroup.add(unitRow);

        // Popup opacity setting
        const opacityRow = new Adw.SpinRow({
            title: 'Popup Opacity',
            subtitle: 'Background opacity percent (0–100)',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 100,
                step_increment: 1,
                page_increment: 5,
                value: (() => { try { return this._settings.get_int('popup-opacity'); } catch (_) { return 100; } })(),
            }),
        });
        opacityRow.connect('notify::value', () => {
            try { this._settings.set_int('popup-opacity', opacityRow.get_value()); } catch (_) {}
        });
        displayGroup.add(opacityRow);

        // Monochrome mode toggle (after displayGroup exists)
        const monochromeRow = new Adw.SwitchRow({
            title: 'Monochrome Mode',
            subtitle: 'Use a single neutral color even when color-coding is on',
            active: this._settings.get_boolean('monochrome-mode'),
        });
        monochromeRow.connect('notify::active', () => {
            this._settings.set_boolean('monochrome-mode', monochromeRow.get_active());
        });
        displayGroup.add(monochromeRow);

        // Data Management group
        const dataGroup = new Adw.PreferencesGroup({
            title: 'Data Management',
            description: 'Export, import, and reset your CO2 data',
        });
        this.add(dataGroup);

        const exportTotalsBtn = new Gtk.Button({ label: 'Export' });
        exportTotalsBtn.connect('clicked', () => {
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
                const toBytes = (s) => imports.byteArray.fromString(s);
                let stream;
                if (!file.query_exists(null)) {
                    stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
                    stream.write_all(toBytes(header), null);
                } else {
                    stream = file.append_to(Gio.FileCreateFlags.NONE, null);
                }
                stream.write_all(toBytes(line), null);
                stream.close(null);
            } catch (_) {}
        });
        dataGroup.add(new Adw.ActionRow({ title: 'Export Totals Snapshot (CSV)', subtitle: 'Writes timestamped daily/weekly/monthly/all‑time row', activatable_widget: exportTotalsBtn }));

        const exportHistoryBtn = new Gtk.Button({ label: 'Export' });
        exportHistoryBtn.connect('clicked', () => {
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
                const safeProfile = (profile || 'default').replace(/[^A-Za-z0-9_-]/g, '_');
                const path = GLib.build_filenamev([baseDir, `co2-daily-history-${safeProfile}.csv`]);
                const file = Gio.File.new_for_path(path);
                const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
                const toBytes = (s) => imports.byteArray.fromString(s);
                stream.write_all(toBytes(header + body), null);
                stream.close(null);
            } catch (_) {}
        });
        dataGroup.add(new Adw.ActionRow({ title: 'Export Daily History (CSV)', subtitle: 'Writes per‑day history for active profile', activatable_widget: exportHistoryBtn }));

        const exportOverallTopBtn = new Gtk.Button({ label: 'Export' });
        exportOverallTopBtn.connect('clicked', () => {
            try {
                const profile = this._settings.get_string('profile-name') || 'default';
                let obj = {};
                try { obj = JSON.parse(this._settings.get_string('software-totals-json')); } catch (_) { obj = {}; }
                const map = obj[profile] || {};
                let rows = Object.entries(map).map(([name, g]) => ({ name, g: Number(g) || 0 }))
                    .sort((a,b) => b.g - a.g);
                const showAll = (() => { try { return this._settings.get_boolean('overall-show-all'); } catch (_) { return true; } })();
                if (!showAll) {
                    const topN = Math.max(5, Math.min(25, this._settings.get_int('per-process-top-n') || 10));
                    rows = rows.slice(0, topN);
                }
                const header = 'software,grams\n';
                const body = rows.map(r => `${r.name.replace(/[\n,]/g, ' ')} , ${r.g.toFixed(6)}`).join('\n') + (rows.length ? '\n' : '');
                const dirPref = this._settings.get_string('export-directory');
                const baseDir = dirPref && dirPref.length > 0 ? dirPref : GLib.get_home_dir();
                const safeProfile = (profile || 'default').replace(/[^A-Za-z0-9_-]/g, '_');
                const suffix = showAll ? 'all' : 'top';
                const path = GLib.build_filenamev([baseDir, `co2-overall-software-${safeProfile}-${suffix}.csv`]);
                const file = Gio.File.new_for_path(path);
                const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
                const toBytes = (s) => imports.byteArray.fromString(s);
                stream.write_all(toBytes(header + body), null);
                stream.close(null);
            } catch (_) {}
        });
        dataGroup.add(new Adw.ActionRow({ title: 'Export Overall Software (Top/Toggle)', subtitle: 'Respects Show‑All toggle and Top N', activatable_widget: exportOverallTopBtn }));

        const exportOverallAllBtn = new Gtk.Button({ label: 'Export' });
        exportOverallAllBtn.connect('clicked', () => {
            try {
                const profile = this._settings.get_string('profile-name') || 'default';
                let obj = {};
                try { obj = JSON.parse(this._settings.get_string('software-totals-json')); } catch (_) { obj = {}; }
                const map = obj[profile] || {};
                const rows = Object.entries(map).map(([name, g]) => ({ name, g: Number(g) || 0 }))
                    .sort((a,b) => b.g - a.g);
                const header = 'software,grams\n';
                const body = rows.map(r => `${r.name.replace(/[\n,]/g, ' ')} , ${r.g.toFixed(6)}`).join('\n') + (rows.length ? '\n' : '');
                const dirPref = this._settings.get_string('export-directory');
                const baseDir = dirPref && dirPref.length > 0 ? dirPref : GLib.get_home_dir();
                const safeProfile = (profile || 'default').replace(/[^A-Za-z0-9_-]/g, '_');
                const path = GLib.build_filenamev([baseDir, `co2-overall-software-${safeProfile}-all.csv`]);
                const file = Gio.File.new_for_path(path);
                const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
                stream.write(new TextEncoder().encode(header + body), null);
                stream.close(null);
            } catch (_) {}
        });
        dataGroup.add(new Adw.ActionRow({ title: 'Export Overall Software (All)', subtitle: 'Exports the full cumulative list', activatable_widget: exportOverallAllBtn }));

        const importOverallBtn = new Gtk.Button({ label: 'Import' });
        importOverallBtn.connect('clicked', () => {
            const dialog = new Gtk.FileChooserNative({
                title: 'Select Overall Software CSV',
                action: Gtk.FileChooserAction.OPEN,
                transient_for: this.get_root(),
                modal: true,
            });
            dialog.connect('response', (d, res) => {
                try {
                    if (res === Gtk.ResponseType.ACCEPT) {
                        const file = d.get_file();
                        if (file) {
                            const [ok, bytes] = file.load_contents(null);
                            if (ok) {
                                const text = imports.byteArray.toString(bytes);
                                const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
                                const startIdx = lines[0]?.toLowerCase().startsWith('software,') ? 1 : 0;
                                let obj = {};
                                try { obj = JSON.parse(this._settings.get_string('software-totals-json')); } catch (_) { obj = {}; }
                                const profile = this._settings.get_string('profile-name') || 'default';
                                if (!obj[profile]) obj[profile] = {};
                                for (let i = startIdx; i < lines.length; i++) {
                                    const parts = lines[i].split(',');
                                    if (parts.length < 2) continue;
                                    const name = parts[0].trim();
                                    const g = parseFloat(parts[1]);
                                    if (!name || !Number.isFinite(g)) continue;
                                    const prev = Number(obj[profile][name]) || 0;
                                    obj[profile][name] = prev + g;
                                }
                                this._settings.set_string('software-totals-json', JSON.stringify(obj));
                            }
                        }
                    }
                } catch (_) { }
                d.destroy();
            });
            dialog.show();
        });
        dataGroup.add(new Adw.ActionRow({ title: 'Import Overall Software Totals (CSV)', subtitle: 'Merges by software name into current profile', activatable_widget: importOverallBtn }));

        const resetRow = new Adw.ActionRow({ title: 'Reset Totals' });
        const resetAllBtn = new Gtk.Button({ label: 'Reset All (Day/Week/Month/All‑time/Overall)' });
        resetAllBtn.add_css_class('destructive-action');
        resetAllBtn.connect('clicked', () => {
            const dlg = new Adw.MessageDialog({
                transient_for: this.get_root(),
                modal: true,
                heading: 'Reset all totals?',
                body: 'This clears Daily, Weekly, Monthly, All‑time, and Overall Software totals for the active profile.',
            });
            dlg.add_response('cancel', 'Cancel');
            dlg.add_response('reset', 'Reset');
            dlg.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
            dlg.connect('response', (_d, id) => {
                if (id !== 'reset') { dlg.destroy(); return; }
                try {
                    this._settings.set_double('daily-total-g', 0.0);
                    this._settings.set_double('weekly-total-g', 0.0);
                    this._settings.set_double('monthly-total-g', 0.0);
                    this._settings.set_double('cumulative-total-g', 0.0);
                    const epochDay = Math.floor(Date.now() / 86400000);
                    this._settings.set_int('daily-epoch-day', epochDay);
                    this._settings.set_int('weekly-epoch-week', 0);
                    this._settings.set_int('monthly-epoch-ym', 0);
                    let obj = {};
                    try { obj = JSON.parse(this._settings.get_string('software-totals-json')); } catch (_) { obj = {}; }
                    const profile = this._settings.get_string('profile-name') || 'default';
                    obj[profile] = {};
                    this._settings.set_string('software-totals-json', JSON.stringify(obj));
                } catch (_) {}
                dlg.destroy();
            });
            dlg.present();
        });
        resetRow.add_suffix(resetAllBtn);
        dataGroup.add(resetRow);
        
        // Advanced group
        const advancedGroup = new Adw.PreferencesGroup({
            title: 'Advanced',
            description: 'Advanced configuration options',
        });
        this.add(advancedGroup);
        
        // CPU power profile setting
        const cpuProfileRow = new Adw.ComboRow({
            title: 'CPU Power Profile',
            subtitle: 'Select your CPU type for more accurate power estimation',
        });
        
        const cpuModel = new Gtk.StringList();
        cpuModel.append('Laptop');
        cpuModel.append('Desktop');
        cpuModel.append('Server');
        cpuModel.append('Low Power');
        cpuProfileRow.set_model(cpuModel);
        const cpuProfile = this._settings.get_string('cpu-profile');
        const idx = { 'laptop': 0, 'desktop': 1, 'server': 2, 'lowpower': 3 }[cpuProfile] ?? 1;
        cpuProfileRow.set_selected(idx);
        
        advancedGroup.add(cpuProfileRow);
        cpuProfileRow.connect('notify::selected', () => {
            const mapping = ['laptop', 'desktop', 'server', 'lowpower'];
            this._settings.set_string('cpu-profile', mapping[cpuProfileRow.get_selected()] ?? 'desktop');
        });
        
        // Reset to defaults button
        const resetButton = new Gtk.Button({
            label: 'Reset to Defaults',
            css_classes: ['destructive-action'],
        });
        
        resetButton.connect('clicked', () => {
            // Reset all settings to default values
            this._settings.reset('update-interval');
            this._settings.reset('carbon-intensity');
            this._settings.reset('per-software-monitoring');
            this._settings.reset('color-coding');
            this._settings.reset('cpu-profile');
            this._settings.reset('use-online-intensity');
            this._settings.reset('intensity-provider');
            this._settings.reset('electricitymaps-api-key');
            this._settings.reset('electricitymaps-zone');
            this._settings.reset('smoothing-enabled');
            this._settings.reset('smoothing-window');
            this._settings.reset('provider-cache-ttl');
            this._settings.reset('show-trend');
            this._settings.reset('history-length');
            this._settings.reset('per-process-sample-ms');
            this._settings.reset('per-process-top-n');
            this._settings.reset('show-intensity');
            this._settings.reset('monochrome-mode');

            updateIntervalRow.set_value(this._settings.get_int('update-interval'));
            carbonIntensityRow.set_value(this._settings.get_int('carbon-intensity'));
            perSoftwareRow.set_active(this._settings.get_boolean('per-software-monitoring'));
            colorCodingRow.set_active(this._settings.get_boolean('color-coding'));
            enableNotificationsRow.set_active(false);
            thresholdRow.set_value(0.2);
            cooldownRow.set_value(5);
            displayFormatRow.set_selected(0);
            const newIdx = { 'laptop': 0, 'desktop': 1, 'server': 2, 'lowpower': 3 }[this._settings.get_string('cpu-profile')] ?? 1;
            cpuProfileRow.set_selected(newIdx);
            smoothingRow.set_active(this._settings.get_boolean('smoothing-enabled'));
            smoothingWinRow.set_value(this._settings.get_int('smoothing-window'));
            cacheTtlRow.set_value(this._settings.get_int('provider-cache-ttl'));
            showTrendRow.set_active(this._settings.get_boolean('show-trend'));
            historyLenRow.set_value(this._settings.get_int('history-length'));
            sampleMsRow.set_value(this._settings.get_int('per-process-sample-ms'));
            topNRow.set_value(this._settings.get_int('per-process-top-n'));
            showIntensityRow.set_active(this._settings.get_boolean('show-intensity'));
            monochromeRow.set_active(this._settings.get_boolean('monochrome-mode'));
            providerRow.set_selected(this._settings.get_string('intensity-provider') === 'auto-country' ? 1 : 0);
            apiKeyRow.set_text(this._settings.get_string('electricitymaps-api-key'));
            zoneRow.set_text(this._settings.get_string('electricitymaps-zone'));
            autoDetectRow.set_active(this._settings.get_boolean('auto-detect-zone'));
        });
        
        advancedGroup.add(resetButton);

        // Safe Mode toggle for recovery
        const safeModeRow = new Adw.SwitchRow({
            title: 'Safe Mode',
            subtitle: 'Disable heavy features (per‑process, online provider, periodic/auto exports)',
            active: this._settings.get_boolean('safe-mode'),
        });
        safeModeRow.connect('notify::active', () => {
            this._settings.set_boolean('safe-mode', safeModeRow.get_active());
        });
        advancedGroup.add(safeModeRow);

        // Week start day
        const weekGroup = new Adw.PreferencesGroup({
            title: 'Time Periods',
            description: 'Configure how weeks are calculated and where exports go',
        });
        this.add(weekGroup);

        const weekStartRow = new Adw.ComboRow({
            title: 'Week Start Day',
            subtitle: 'Affects weekly rollover and displayed week number',
        });
        const weekModel = new Gtk.StringList();
        weekModel.append('Monday');
        weekModel.append('Sunday');
        weekStartRow.set_model(weekModel);
        const ws = this._settings.get_string('week-start-day');
        weekStartRow.set_selected(ws === 'sunday' ? 1 : 0);
        weekGroup.add(weekStartRow);
        weekStartRow.connect('notify::selected', () => {
            const val = weekStartRow.get_selected() === 1 ? 'sunday' : 'monday';
            this._settings.set_string('week-start-day', val);
        });

        // Export directory
        const exportDirRow = new Adw.EntryRow({
            title: 'Export Directory',
        });
        try { exportDirRow.set_placeholder_text?.('Leave empty to use your home directory'); } catch (_) {}
        exportDirRow.set_text(this._settings.get_string('export-directory'));
        exportDirRow.connect('notify::text', () => {
            this._settings.set_string('export-directory', exportDirRow.get_text());
        });
        weekGroup.add(exportDirRow);

        // Power transitions UI temporarily removed to isolate suspected crash source

        // History & Export
        const histGroup = new Adw.PreferencesGroup({
            title: 'History & Export',
            description: 'Configure daily history and automatic exports',
        });
        this.add(histGroup);

        const profileRow = new Adw.EntryRow({ title: 'Profile Name' });
        try { profileRow.set_placeholder_text?.('Optional label to namespace history/exports'); } catch (_) {}
        profileRow.set_text(this._settings.get_string('profile-name'));
        profileRow.connect('notify::text', () => {
            this._settings.set_string('profile-name', profileRow.get_text());
        });
        histGroup.add(profileRow);

        const histDaysRow = new Adw.SpinRow({
            title: 'History Window (days)',
            adjustment: new Gtk.Adjustment({ lower: 7, upper: 180, step_increment: 1, page_increment: 7, value: this._settings.get_int('history-days') }),
        });
        histDaysRow.connect('notify::value', () => {
            this._settings.set_int('history-days', histDaysRow.get_value());
        });
        histGroup.add(histDaysRow);

        const autoExportRow = new Adw.SwitchRow({
            title: 'Auto Export on Day Change',
            active: this._settings.get_boolean('auto-export-history'),
        });
        autoExportRow.connect('notify::active', () => {
            this._settings.set_boolean('auto-export-history', autoExportRow.get_active());
        });
        histGroup.add(autoExportRow);

        // Periodic export toggle
        const periodicExportRow = new Adw.SwitchRow({
            title: 'Enable Periodic Export',
            subtitle: 'Write daily history CSV every N minutes',
            active: this._settings.get_boolean('enable-periodic-export'),
        });
        periodicExportRow.connect('notify::active', () => {
            this._settings.set_boolean('enable-periodic-export', periodicExportRow.get_active());
        });
        histGroup.add(periodicExportRow);

        // Periodic interval spin
        const exportIntervalRow = new Adw.SpinRow({
            title: 'Export Interval (minutes)',
            subtitle: 'Between 5 and 240 minutes',
            adjustment: new Gtk.Adjustment({
                lower: 5,
                upper: 240,
                step_increment: 5,
                page_increment: 15,
                value: this._settings.get_int('export-interval-min'),
            }),
        });
        exportIntervalRow.connect('notify::value', () => {
            this._settings.set_int('export-interval-min', exportIntervalRow.get_value());
        });
        histGroup.add(exportIntervalRow);

        // Import/Merge history from CSV or JSON
        const importRow = new Adw.ActionRow({ title: 'Import/Merge History', subtitle: 'Merge a CSV (date,grams) or JSON file into history' });
        const importBtn = new Gtk.Button({ label: 'Choose File…', halign: Gtk.Align.END });
        importBtn.connect('clicked', () => this._promptImportHistory());
        importRow.add_suffix(importBtn);
        importRow.set_activatable_widget(importBtn);
        histGroup.add(importRow);

        // Preview of recent history
        const previewRow = new Adw.ActionRow({ title: 'Recent History Preview', subtitle: 'Last few days for current profile' });
        const previewBtn = new Gtk.Button({ label: 'Refresh', halign: Gtk.Align.END });
        previewBtn.connect('clicked', () => this._refreshHistoryPreview(previewList));
        previewRow.add_suffix(previewBtn);
        previewRow.set_activatable_widget(previewBtn);
        histGroup.add(previewRow);

        const previewList = new Gtk.Label({
            xalign: 0,
            justify: Gtk.Justification.LEFT,
            selectable: true,
            wrap: false,
        });
        previewList.add_css_class?.('dim-label');
        histGroup.add(previewList);
        this._refreshHistoryPreview(previewList);

        // About section
        const aboutGroup = new Adw.PreferencesGroup({
            title: 'About',
            description: 'Links and project info',
        });
        this.add(aboutGroup);

        const linkRow1 = new Adw.ActionRow({ title: 'Portfolio' });
        linkRow1.set_activatable?.(true);
        linkRow1.connect('activated', () => {
            try { Gio.AppInfo.launch_default_for_uri('https://adam-bouafia.github.io/', null); } catch (e) { log(`CO2 Prefs: open URL failed: ${e}`); }
        });
        const btn1 = new Gtk.Button({ label: 'Open', halign: Gtk.Align.END });
        btn1.connect('clicked', () => {
            try { Gio.AppInfo.launch_default_for_uri('https://adam-bouafia.github.io/', null); } catch (e) { log(`CO2 Prefs: open URL failed: ${e}`); }
        });
        linkRow1.add_suffix(btn1);
        linkRow1.set_activatable_widget(btn1);
        aboutGroup.add(linkRow1);

        const linkRow2 = new Adw.ActionRow({ title: 'LinkedIn' });
        linkRow2.set_activatable?.(true);
        linkRow2.connect('activated', () => {
            try { Gio.AppInfo.launch_default_for_uri('https://www.linkedin.com/in/adam-bouafia-b597ab86/', null); } catch (e) { log(`CO2 Prefs: open URL failed: ${e}`); }
        });
        const btn2 = new Gtk.Button({ label: 'Open', halign: Gtk.Align.END });
        btn2.connect('clicked', () => {
            try { Gio.AppInfo.launch_default_for_uri('https://www.linkedin.com/in/adam-bouafia-b597ab86/', null); } catch (e) { log(`CO2 Prefs: open URL failed: ${e}`); }
        });
        linkRow2.add_suffix(btn2);
        linkRow2.set_activatable_widget(btn2);
        aboutGroup.add(linkRow2);

        const devRow = new Adw.ActionRow({ title: 'Developer', subtitle: 'Adam Bouafia' });
        aboutGroup.add(devRow);
    }

    _refreshHistoryPreview(label) {
        try {
            const profile = this._settings.get_string('profile-name') || 'default';
            let obj = {};
            try { obj = JSON.parse(this._settings.get_string('daily-history-json')); } catch (_) { obj = {}; }
            const map = obj[profile] || {};
            const rows = Object.entries(map).sort((a,b) => a[0].localeCompare(b[0]));
            const last = rows.slice(-10);
            const text = last.length ? last.map(([d,g]) => `${d}  •  ${(+(g||0)).toFixed(3)}g`).join('\n') : 'No history for current profile.';
            label.set_text(text);
        } catch (e) {
            label.set_text(`Error: ${e}`);
        }
    }

    _promptImportHistory() {
        try {
            const parent = this.get_root();
            const dialog = new Gtk.FileChooserNative({
                title: 'Select CSV or JSON file',
                action: Gtk.FileChooserAction.OPEN,
                transient_for: parent,
                modal: true,
            });
            const filter = new Gtk.FileFilter();
            filter.add_pattern('*.csv');
            filter.add_pattern('*.json');
            filter.set_name('CSV or JSON');
            dialog.add_filter(filter);
            dialog.connect('response', (dlg, response) => {
                if (response === Gtk.ResponseType.ACCEPT) {
                    const file = dlg.get_file();
                    const path = file?.get_path?.();
                    if (path) this._importHistoryFromPath(path);
                }
                dlg.destroy();
            });
            dialog.show();
        } catch (e) {
            log(`CO2 Prefs: file chooser error: ${e}`);
        }
    }

    _importHistoryFromPath(path) {
        try {
            const gf = Gio.File.new_for_path(path);
            const [ok, bytes] = gf.load_contents(null);
            if (!ok) return;
            const text = new TextDecoder('utf-8').decode(bytes);
            let entries = [];
            if (/\.json$/i.test(path)) {
                const obj = JSON.parse(text);
                // Accept either {date: grams} or {profile: {date: grams}}
                const profile = this._settings.get_string('profile-name') || 'default';
                const map = obj[profile] ? obj[profile] : obj;
                for (const [d, g] of Object.entries(map)) entries.push([d, +g]);
            } else {
                // CSV: date,grams
                const lines = text.split(/\r?\n/).filter(l => l.trim().length);
                for (const line of lines) {
                    const m = line.trim();
                    if (/^date\s*,/i.test(m)) continue; // skip header
                    const parts = m.split(',');
                    if (parts.length >= 2) entries.push([parts[0].trim(), +parts[1]]);
                }
            }
            if (!entries.length) return;
            // Merge into settings history for current profile
            const profile = this._settings.get_string('profile-name') || 'default';
            let state = {};
            try { state = JSON.parse(this._settings.get_string('daily-history-json')); } catch (_) { state = {}; }
            if (!state[profile]) state[profile] = {};
            for (const [d,g] of entries) {
                if (!d || isNaN(g)) continue;
                state[profile][d] = +g;
            }
            // Trim to history-days
            const days = this._settings.get_int('history-days');
            const sorted = Object.entries(state[profile]).sort((a,b) => a[0].localeCompare(b[0]));
            const cut = Math.max(0, sorted.length - days);
            state[profile] = Object.fromEntries(sorted.slice(cut));
            this._settings.set_string('daily-history-json', JSON.stringify(state));
        } catch (e) {
            log(`CO2 Prefs: import error: ${e}`);
        }
    }
});
// Export functions for compatibility with all GNOME versions
export function init() {}
export function fillPreferencesWindow(window) {
    window.add(new CO2ConsumptionPreferences());
}

// Default export for GNOME versions that instantiate a class from the module
export default class Preferences {
    fillPreferencesWindow(window) {
        window.add(new CO2ConsumptionPreferences());
    }
}


