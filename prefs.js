/**
 * CO2 Consumption Monitor - Preferences Window
 *
 * Uses Adw (libadwaita) for a modern GNOME settings experience.
 * Export/import logic is shared via lib/storage.js.
 */
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    exportTotalsCSV, exportDailyHistoryCSV,
    exportOverallSoftwareCSV, getOverallSoftwareTotals,
    importOverallSoftwareFromText, importHistoryFromPath,
} from './lib/storage.js';

// ---------------------------------------------------------------------------
// Preferences page
// ---------------------------------------------------------------------------

const CO2ConsumptionPreferences = GObject.registerClass(
class CO2ConsumptionPreferences extends Adw.PreferencesPage {
    _init(settings) {
        super._init({ title: 'General', icon_name: 'preferences-system-symbolic' });
        this._settings = settings;

        this._buildCalculationGroup();
        this._buildMonitoringGroup();
        this._buildDataSourceGroup();
        this._buildDisplayGroup();
        this._buildDataManagementGroup();
        this._buildAdvancedGroup();
        this._buildTimePeriodsGroup();
        this._buildHistoryGroup();
        this._buildAboutGroup();
    }

    // -----------------------------------------------------------------------
    // CO2 Calculation
    // -----------------------------------------------------------------------

    _buildCalculationGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'CO2 Calculation',
            description: 'Configure how CO2 emissions are calculated',
        });
        this.add(group);

        this._updateIntervalRow = new Adw.SpinRow({
            title: 'Update Interval',
            subtitle: 'How often to update CO2 readings (seconds)',
            adjustment: new Gtk.Adjustment({
                lower: 1, upper: 60, step_increment: 1, page_increment: 5,
                value: this._settings.get_int('update-interval'),
            }),
        });
        group.add(this._updateIntervalRow);
        this._updateIntervalRow.connect('notify::value', () => {
            this._settings.set_int('update-interval', this._updateIntervalRow.get_value());
        });

        this._carbonIntensityRow = new Adw.SpinRow({
            title: 'Carbon Intensity',
            subtitle: 'Regional carbon intensity (gCO2/kWh) - used when online provider is off',
            adjustment: new Gtk.Adjustment({
                lower: 50, upper: 1000, step_increment: 10, page_increment: 50,
                value: this._settings.get_int('carbon-intensity'),
            }),
        });
        group.add(this._carbonIntensityRow);
        this._carbonIntensityRow.connect('notify::value', () => {
            this._settings.set_int('carbon-intensity', this._carbonIntensityRow.get_value());
        });
    }

    // -----------------------------------------------------------------------
    // Monitoring Mode
    // -----------------------------------------------------------------------

    _buildMonitoringGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'Monitoring Mode',
            description: 'Configure what to monitor and display',
        });
        this.add(group);

        this._perSoftwareRow = new Adw.SwitchRow({
            title: 'Per-Software Monitoring',
            subtitle: 'Track CO2 consumption by individual applications',
            active: this._settings.get_boolean('per-software-monitoring'),
        });
        group.add(this._perSoftwareRow);
        this._perSoftwareRow.connect('notify::active', () => {
            this._settings.set_boolean('per-software-monitoring', this._perSoftwareRow.get_active());
        });

        this._colorCodingRow = new Adw.SwitchRow({
            title: 'Color Coding',
            subtitle: 'Use colors to indicate CO2 emission levels',
            active: this._settings.get_boolean('color-coding'),
        });
        group.add(this._colorCodingRow);
        this._colorCodingRow.connect('notify::active', () => {
            this._settings.set_boolean('color-coding', this._colorCodingRow.get_active());
        });

        this._smoothingRow = new Adw.SwitchRow({
            title: 'Smoothing',
            subtitle: 'Average recent samples to reduce noise',
            active: this._settings.get_boolean('smoothing-enabled'),
        });
        group.add(this._smoothingRow);
        this._smoothingRow.connect('notify::active', () => {
            this._settings.set_boolean('smoothing-enabled', this._smoothingRow.get_active());
        });

        this._smoothingWinRow = new Adw.SpinRow({
            title: 'Smoothing Window',
            subtitle: 'Number of samples (1-60)',
            adjustment: new Gtk.Adjustment({
                lower: 1, upper: 60, step_increment: 1, page_increment: 5,
                value: this._settings.get_int('smoothing-window'),
            }),
        });
        group.add(this._smoothingWinRow);
        this._smoothingWinRow.connect('notify::value', () => {
            this._settings.set_int('smoothing-window', this._smoothingWinRow.get_value());
        });

        this._sampleMsRow = new Adw.SpinRow({
            title: 'Per-Process Sample (ms)',
            subtitle: 'Duration to measure CPU shares (50-1000)',
            adjustment: new Gtk.Adjustment({
                lower: 50, upper: 1000, step_increment: 25, page_increment: 100,
                value: this._settings.get_int('per-process-sample-ms'),
            }),
        });
        group.add(this._sampleMsRow);
        this._sampleMsRow.connect('notify::value', () => {
            this._settings.set_int('per-process-sample-ms', this._sampleMsRow.get_value());
        });

        this._topNRow = new Adw.SpinRow({
            title: 'Top N Processes',
            subtitle: 'Number to display (5-25)',
            adjustment: new Gtk.Adjustment({
                lower: 5, upper: 25, step_increment: 1, page_increment: 5,
                value: this._settings.get_int('per-process-top-n'),
            }),
        });
        group.add(this._topNRow);
        this._topNRow.connect('notify::value', () => {
            this._settings.set_int('per-process-top-n', this._topNRow.get_value());
        });

        this._overallShowAllRow = new Adw.SwitchRow({
            title: 'Show All Overall Totals',
            subtitle: 'Show full cumulative software list in popup (otherwise limit to Top N)',
            active: (() => { try { return this._settings.get_boolean('overall-show-all'); } catch (_) { return true; } })(),
        });
        group.add(this._overallShowAllRow);
        this._overallShowAllRow.connect('notify::active', () => {
            try { this._settings.set_boolean('overall-show-all', this._overallShowAllRow.get_active()); } catch (_) {}
        });

        this._showTrendRow = new Adw.SwitchRow({
            title: 'Show Trend',
            subtitle: 'Display recent emission trend in popup',
            active: this._settings.get_boolean('show-trend'),
        });
        group.add(this._showTrendRow);
        this._showTrendRow.connect('notify::active', () => {
            this._settings.set_boolean('show-trend', this._showTrendRow.get_active());
        });

        this._historyLenRow = new Adw.SpinRow({
            title: 'Trend History Length',
            subtitle: 'Number of samples (10-300)',
            adjustment: new Gtk.Adjustment({
                lower: 10, upper: 300, step_increment: 10, page_increment: 20,
                value: this._settings.get_int('history-length'),
            }),
        });
        group.add(this._historyLenRow);
        this._historyLenRow.connect('notify::value', () => {
            this._settings.set_int('history-length', this._historyLenRow.get_value());
        });
    }

    // -----------------------------------------------------------------------
    // Data Source
    // -----------------------------------------------------------------------

    _buildDataSourceGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'Data Source',
            description: 'Use real-time grid carbon intensity when available',
        });
        this.add(group);

        this._useOnlineRow = new Adw.SwitchRow({
            title: 'Use Online Intensity',
            subtitle: 'Fetch grid carbon intensity from a provider',
            active: this._settings.get_boolean('use-online-intensity'),
        });
        group.add(this._useOnlineRow);
        this._useOnlineRow.connect('notify::active', () => {
            this._settings.set_boolean('use-online-intensity', this._useOnlineRow.get_active());
        });

        this._providerRow = new Adw.ComboRow({
            title: 'Intensity Provider',
            subtitle: 'Select the carbon intensity provider',
        });
        const providerModel = new Gtk.StringList();
        providerModel.append('electricitymaps');
        providerModel.append('auto-country');
        this._providerRow.set_model(providerModel);
        this._providerRow.set_selected(this._settings.get_string('intensity-provider') === 'auto-country' ? 1 : 0);
        group.add(this._providerRow);
        this._providerRow.connect('notify::selected', () => {
            const mapping = ['electricitymaps', 'auto-country'];
            this._settings.set_string('intensity-provider', mapping[this._providerRow.get_selected()] ?? 'electricitymaps');
        });

        this._apiKeyRow = new Adw.EntryRow({ title: 'ElectricityMaps API Key' });
        this._apiKeyRow.set_text(this._settings.get_string('electricitymaps-api-key'));
        this._apiKeyRow.connect('notify::text', () => {
            this._settings.set_string('electricitymaps-api-key', this._apiKeyRow.get_text());
        });
        group.add(this._apiKeyRow);

        this._zoneRow = new Adw.EntryRow({ title: 'ElectricityMaps Zone (e.g., DE, FR, US-CAL)' });
        this._zoneRow.set_text(this._settings.get_string('electricitymaps-zone'));
        this._zoneRow.connect('notify::text', () => {
            this._settings.set_string('electricitymaps-zone', this._zoneRow.get_text());
        });
        group.add(this._zoneRow);

        this._autoDetectRow = new Adw.SwitchRow({
            title: 'Auto-detect Zone',
            subtitle: 'Use IP geolocation to set country code when zone is empty',
            active: this._settings.get_boolean('auto-detect-zone'),
        });
        group.add(this._autoDetectRow);
        this._autoDetectRow.connect('notify::active', () => {
            this._settings.set_boolean('auto-detect-zone', this._autoDetectRow.get_active());
        });

        this._cacheTtlRow = new Adw.SpinRow({
            title: 'Provider Cache TTL',
            subtitle: 'Seconds to cache grid intensity (10-3600)',
            adjustment: new Gtk.Adjustment({
                lower: 10, upper: 3600, step_increment: 10, page_increment: 60,
                value: this._settings.get_int('provider-cache-ttl'),
            }),
        });
        group.add(this._cacheTtlRow);
        this._cacheTtlRow.connect('notify::value', () => {
            this._settings.set_int('provider-cache-ttl', this._cacheTtlRow.get_value());
        });

        this._showIntensityRow = new Adw.SwitchRow({
            title: 'Show Carbon Intensity',
            subtitle: 'Display intensity value and provider in popup',
            active: this._settings.get_boolean('show-intensity'),
        });
        group.add(this._showIntensityRow);
        this._showIntensityRow.connect('notify::active', () => {
            this._settings.set_boolean('show-intensity', this._showIntensityRow.get_active());
        });
    }

    // -----------------------------------------------------------------------
    // Display
    // -----------------------------------------------------------------------

    _buildDisplayGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'Display',
            description: 'Configure how data is displayed',
        });
        this.add(group);

        this._unitRow = new Adw.ComboRow({
            title: 'Display Unit',
            subtitle: 'Unit for panel label and Current consumption',
        });
        const unitModel = new Gtk.StringList();
        unitModel.append('Grams (g)');
        unitModel.append('Milligrams (mg)');
        unitModel.append('Kilograms (kg)');
        this._unitRow.set_model(unitModel);
        const currentUnit = (() => { try { return this._settings.get_string('display-unit'); } catch (_) { return 'g'; } })();
        this._unitRow.set_selected(currentUnit === 'mg' ? 1 : (currentUnit === 'kg' ? 2 : 0));
        this._unitRow.connect('notify::selected', () => {
            const map = ['g', 'mg', 'kg'];
            try { this._settings.set_string('display-unit', map[this._unitRow.get_selected()] || 'g'); } catch (_) {}
        });
        group.add(this._unitRow);

        this._opacityRow = new Adw.SpinRow({
            title: 'Popup Opacity',
            subtitle: 'Background opacity percent (0-100)',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 100, step_increment: 1, page_increment: 5,
                value: (() => { try { return this._settings.get_int('popup-opacity'); } catch (_) { return 100; } })(),
            }),
        });
        this._opacityRow.connect('notify::value', () => {
            try { this._settings.set_int('popup-opacity', this._opacityRow.get_value()); } catch (_) {}
        });
        group.add(this._opacityRow);

        this._monochromeRow = new Adw.SwitchRow({
            title: 'Monochrome Mode',
            subtitle: 'Use a single neutral color even when color-coding is on',
            active: this._settings.get_boolean('monochrome-mode'),
        });
        this._monochromeRow.connect('notify::active', () => {
            this._settings.set_boolean('monochrome-mode', this._monochromeRow.get_active());
        });
        group.add(this._monochromeRow);
    }

    // -----------------------------------------------------------------------
    // Data Management (shared export/import via lib/storage.js)
    // -----------------------------------------------------------------------

    _buildDataManagementGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'Data Management',
            description: 'Export, import, and reset your CO2 data',
        });
        this.add(group);

        // Export totals snapshot
        const exportTotalsBtn = new Gtk.Button({ label: 'Export' });
        exportTotalsBtn.connect('clicked', () => {
            try { exportTotalsCSV(this._settings); } catch (_) {}
        });
        group.add(new Adw.ActionRow({
            title: 'Export Totals Snapshot (CSV)',
            subtitle: 'Writes timestamped daily/weekly/monthly/all-time row',
            activatable_widget: exportTotalsBtn,
        }));

        // Export daily history
        const exportHistoryBtn = new Gtk.Button({ label: 'Export' });
        exportHistoryBtn.connect('clicked', () => {
            try { exportDailyHistoryCSV(this._settings); } catch (_) {}
        });
        group.add(new Adw.ActionRow({
            title: 'Export Daily History (CSV)',
            subtitle: 'Writes per-day history for active profile',
            activatable_widget: exportHistoryBtn,
        }));

        // Export overall software (respects toggle)
        const exportOverallToggleBtn = new Gtk.Button({ label: 'Export' });
        exportOverallToggleBtn.connect('clicked', () => {
            try {
                const showAll = (() => { try { return this._settings.get_boolean('overall-show-all'); } catch (_) { return true; } })();
                const allRows = getOverallSoftwareTotals(this._settings, {});
                const topN = Math.max(5, Math.min(25, this._settings.get_int('per-process-top-n') || 10));
                const rows = showAll ? allRows : allRows.slice(0, topN);
                exportOverallSoftwareCSV(this._settings, {}, rows, showAll ? 'all' : 'top');
            } catch (_) {}
        });
        group.add(new Adw.ActionRow({
            title: 'Export Overall Software (Top/Toggle)',
            subtitle: 'Respects Show-All toggle and Top N',
            activatable_widget: exportOverallToggleBtn,
        }));

        // Export overall software (all)
        const exportOverallAllBtn = new Gtk.Button({ label: 'Export' });
        exportOverallAllBtn.connect('clicked', () => {
            try { exportOverallSoftwareCSV(this._settings, {}, null, 'all'); } catch (_) {}
        });
        group.add(new Adw.ActionRow({
            title: 'Export Overall Software (All)',
            subtitle: 'Exports the full cumulative list',
            activatable_widget: exportOverallAllBtn,
        }));

        // Import overall software
        const importOverallBtn = new Gtk.Button({ label: 'Import' });
        importOverallBtn.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({ title: 'Select Overall Software CSV', modal: true });
            dialog.open(this.get_root(), null, (d, res) => {
                try {
                    const file = d.open_finish(res);
                    const [ok, bytes] = file.load_contents(null);
                    if (ok) {
                        const text = new TextDecoder('utf-8').decode(bytes);
                        importOverallSoftwareFromText(this._settings, text);
                    }
                } catch (_) { /* cancelled or unreadable */ }
            });
        });
        group.add(new Adw.ActionRow({
            title: 'Import Overall Software Totals (CSV)',
            subtitle: 'Merges by software name into current profile',
            activatable_widget: importOverallBtn,
        }));

        // Reset all totals
        const resetRow = new Adw.ActionRow({ title: 'Reset Totals' });
        const resetAllBtn = new Gtk.Button({ label: 'Reset All (Day/Week/Month/All-time/Overall)' });
        resetAllBtn.add_css_class('destructive-action');
        resetAllBtn.connect('clicked', () => {
            const params = {
                heading: 'Reset all totals?',
                body: 'This clears Daily, Weekly, Monthly, All-time, and Overall Software totals for the active profile.',
            };
            // Adw.AlertDialog needs libadwaita 1.5 (GNOME 46); MessageDialog is deprecated.
            const dlg = Adw.AlertDialog
                ? new Adw.AlertDialog(params)
                : new Adw.MessageDialog({ ...params, transient_for: this.get_root(), modal: true });
            dlg.add_response('cancel', 'Cancel');
            dlg.add_response('reset', 'Reset');
            dlg.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
            dlg.connect('response', (_d, id) => {
                if (id !== 'reset') return;
                try {
                    this._settings.set_double('daily-total-g', 0);
                    this._settings.set_double('weekly-total-g', 0);
                    this._settings.set_double('monthly-total-g', 0);
                    this._settings.set_double('cumulative-total-g', 0);
                    this._settings.set_int('daily-epoch-day', Math.floor(Date.now() / 86400000));
                    this._settings.set_int('weekly-epoch-week', 0);
                    this._settings.set_int('monthly-epoch-ym', 0);
                    let obj = {};
                    try { obj = JSON.parse(this._settings.get_string('software-totals-json')); } catch (_) {}
                    const profile = this._settings.get_string('profile-name') || 'default';
                    obj[profile] = {};
                    this._settings.set_string('software-totals-json', JSON.stringify(obj));
                } catch (_) {}
            });
            if (Adw.AlertDialog)
                dlg.present(this.get_root());
            else
                dlg.present();
        });
        resetRow.add_suffix(resetAllBtn);
        group.add(resetRow);
    }

    // -----------------------------------------------------------------------
    // Advanced
    // -----------------------------------------------------------------------

    _buildAdvancedGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'Advanced',
            description: 'Advanced configuration options',
        });
        this.add(group);

        this._cpuProfileRow = new Adw.ComboRow({
            title: 'CPU Power Profile',
            subtitle: 'Select your CPU type for power estimation (used when RAPL is unavailable)',
        });
        const cpuModel = new Gtk.StringList();
        cpuModel.append('Laptop');
        cpuModel.append('Desktop');
        cpuModel.append('Server');
        cpuModel.append('Low Power');
        this._cpuProfileRow.set_model(cpuModel);
        const cpuProfile = this._settings.get_string('cpu-profile');
        this._cpuProfileRow.set_selected({ laptop: 0, desktop: 1, server: 2, lowpower: 3 }[cpuProfile] ?? 1);
        group.add(this._cpuProfileRow);
        this._cpuProfileRow.connect('notify::selected', () => {
            const mapping = ['laptop', 'desktop', 'server', 'lowpower'];
            this._settings.set_string('cpu-profile', mapping[this._cpuProfileRow.get_selected()] ?? 'desktop');
        });

        // Reset to defaults
        const resetButton = new Gtk.Button({ label: 'Reset to Defaults', css_classes: ['destructive-action'] });
        resetButton.connect('clicked', () => this._resetAllSettings());
        group.add(resetButton);

        // Safe mode
        this._safeModeRow = new Adw.SwitchRow({
            title: 'Safe Mode',
            subtitle: 'Disable heavy features (per-process, online provider, periodic/auto exports)',
            active: this._settings.get_boolean('safe-mode'),
        });
        this._safeModeRow.connect('notify::active', () => {
            this._settings.set_boolean('safe-mode', this._safeModeRow.get_active());
        });
        group.add(this._safeModeRow);
    }

    // -----------------------------------------------------------------------
    // Time Periods
    // -----------------------------------------------------------------------

    _buildTimePeriodsGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'Time Periods',
            description: 'Configure how weeks are calculated and where exports go',
        });
        this.add(group);

        this._weekStartRow = new Adw.ComboRow({
            title: 'Week Start Day',
            subtitle: 'Affects weekly rollover and displayed week number',
        });
        const weekModel = new Gtk.StringList();
        weekModel.append('Monday');
        weekModel.append('Sunday');
        this._weekStartRow.set_model(weekModel);
        this._weekStartRow.set_selected(this._settings.get_string('week-start-day') === 'sunday' ? 1 : 0);
        group.add(this._weekStartRow);
        this._weekStartRow.connect('notify::selected', () => {
            this._settings.set_string('week-start-day', this._weekStartRow.get_selected() === 1 ? 'sunday' : 'monday');
        });

        this._exportDirRow = new Adw.EntryRow({ title: 'Export Directory' });
        try { this._exportDirRow.set_placeholder_text?.('Leave empty to use your home directory'); } catch (_) {}
        this._exportDirRow.set_text(this._settings.get_string('export-directory'));
        this._exportDirRow.connect('notify::text', () => {
            this._settings.set_string('export-directory', this._exportDirRow.get_text());
        });
        group.add(this._exportDirRow);
    }

    // -----------------------------------------------------------------------
    // History & Export
    // -----------------------------------------------------------------------

    _buildHistoryGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'History &amp; Export',
            description: 'Configure daily history and automatic exports',
        });
        this.add(group);

        this._profileRow = new Adw.EntryRow({ title: 'Profile Name' });
        try { this._profileRow.set_placeholder_text?.('Optional label to namespace history/exports'); } catch (_) {}
        this._profileRow.set_text(this._settings.get_string('profile-name'));
        this._profileRow.connect('notify::text', () => {
            this._settings.set_string('profile-name', this._profileRow.get_text());
        });
        group.add(this._profileRow);

        this._histDaysRow = new Adw.SpinRow({
            title: 'History Window (days)',
            adjustment: new Gtk.Adjustment({
                lower: 7, upper: 180, step_increment: 1, page_increment: 7,
                value: this._settings.get_int('history-days'),
            }),
        });
        this._histDaysRow.connect('notify::value', () => {
            this._settings.set_int('history-days', this._histDaysRow.get_value());
        });
        group.add(this._histDaysRow);

        this._autoExportRow = new Adw.SwitchRow({
            title: 'Auto Export on Day Change',
            active: this._settings.get_boolean('auto-export-history'),
        });
        this._autoExportRow.connect('notify::active', () => {
            this._settings.set_boolean('auto-export-history', this._autoExportRow.get_active());
        });
        group.add(this._autoExportRow);

        this._periodicExportRow = new Adw.SwitchRow({
            title: 'Enable Periodic Export',
            subtitle: 'Write daily history CSV every N minutes',
            active: this._settings.get_boolean('enable-periodic-export'),
        });
        this._periodicExportRow.connect('notify::active', () => {
            this._settings.set_boolean('enable-periodic-export', this._periodicExportRow.get_active());
        });
        group.add(this._periodicExportRow);

        this._exportIntervalRow = new Adw.SpinRow({
            title: 'Export Interval (minutes)',
            subtitle: 'Between 5 and 240 minutes',
            adjustment: new Gtk.Adjustment({
                lower: 5, upper: 240, step_increment: 5, page_increment: 15,
                value: this._settings.get_int('export-interval-min'),
            }),
        });
        this._exportIntervalRow.connect('notify::value', () => {
            this._settings.set_int('export-interval-min', this._exportIntervalRow.get_value());
        });
        group.add(this._exportIntervalRow);

        // Import history
        const importRow = new Adw.ActionRow({
            title: 'Import/Merge History',
            subtitle: 'Merge a CSV (date,grams) or JSON file into history',
        });
        const importBtn = new Gtk.Button({ label: 'Choose File...', halign: Gtk.Align.END });
        importBtn.connect('clicked', () => this._promptImportHistory());
        importRow.add_suffix(importBtn);
        importRow.set_activatable_widget(importBtn);
        group.add(importRow);

        // Recent history preview
        const previewRow = new Adw.ActionRow({ title: 'Recent History Preview', subtitle: 'Last few days for current profile' });
        const previewBtn = new Gtk.Button({ label: 'Refresh', halign: Gtk.Align.END });
        previewBtn.connect('clicked', () => this._refreshHistoryPreview());
        previewRow.add_suffix(previewBtn);
        previewRow.set_activatable_widget(previewBtn);
        group.add(previewRow);

        this._previewLabel = new Gtk.Label({
            xalign: 0, justify: Gtk.Justification.LEFT, selectable: true, wrap: false,
        });
        this._previewLabel.add_css_class?.('dim-label');
        group.add(this._previewLabel);
        this._refreshHistoryPreview();
    }

    // -----------------------------------------------------------------------
    // About
    // -----------------------------------------------------------------------

    _buildAboutGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'About',
            description: 'Links and project info',
        });
        this.add(group);

        const openUrl = (url) => {
            try { Gio.AppInfo.launch_default_for_uri(url, null); } catch (_) {}
        };

        for (const [title, url] of [
            ['Portfolio', 'https://adam-bouafia.github.io/'],
            ['LinkedIn', 'https://www.linkedin.com/in/adam-bouafia-b597ab86/'],
        ]) {
            const row = new Adw.ActionRow({ title });
            const btn = new Gtk.Button({ label: 'Open', halign: Gtk.Align.END });
            btn.connect('clicked', () => openUrl(url));
            row.add_suffix(btn);
            row.set_activatable_widget(btn);
            group.add(row);
        }

        group.add(new Adw.ActionRow({ title: 'Developer', subtitle: 'Adam Bouafia' }));
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    _refreshHistoryPreview() {
        try {
            const profile = this._settings.get_string('profile-name') || 'default';
            let obj = {};
            try { obj = JSON.parse(this._settings.get_string('daily-history-json')); } catch (_) {}
            const rows = Object.entries(obj[profile] || {}).sort((a, b) => a[0].localeCompare(b[0]));
            const last = rows.slice(-10);
            const text = last.length
                ? last.map(([d, g]) => `${d}  \u2022  ${(+(g || 0)).toFixed(3)}g`).join('\n')
                : 'No history for current profile.';
            this._previewLabel.set_text(text);
        } catch (e) {
            this._previewLabel.set_text(`Error: ${e}`);
        }
    }

    _promptImportHistory() {
        try {
            const filter = new Gtk.FileFilter();
            filter.add_pattern('*.csv');
            filter.add_pattern('*.json');
            filter.set_name('CSV or JSON');
            const dialog = new Gtk.FileDialog({
                title: 'Select CSV or JSON file',
                modal: true,
                default_filter: filter,
            });
            dialog.open(this.get_root(), null, (dlg, res) => {
                let path = null;
                try { path = dlg.open_finish(res)?.get_path?.(); } catch (_) { /* cancelled */ }
                if (path) {
                    try { importHistoryFromPath(this._settings, path); } catch (_) {}
                }
            });
        } catch (e) {
            console.warn(`CO2 Prefs: file chooser error: ${e}`);
        }
    }

    _resetAllSettings() {
        const keys = [
            'update-interval', 'carbon-intensity', 'per-software-monitoring',
            'color-coding', 'cpu-profile', 'use-online-intensity', 'intensity-provider',
            'electricitymaps-api-key', 'electricitymaps-zone', 'smoothing-enabled',
            'smoothing-window', 'provider-cache-ttl', 'show-trend', 'history-length',
            'per-process-sample-ms', 'per-process-top-n', 'show-intensity', 'monochrome-mode',
        ];
        for (const key of keys) this._settings.reset(key);

        // Sync UI widgets
        this._updateIntervalRow.set_value(this._settings.get_int('update-interval'));
        this._carbonIntensityRow.set_value(this._settings.get_int('carbon-intensity'));
        this._perSoftwareRow.set_active(this._settings.get_boolean('per-software-monitoring'));
        this._colorCodingRow.set_active(this._settings.get_boolean('color-coding'));
        this._unitRow.set_selected(0);
        this._cpuProfileRow.set_selected({ laptop: 0, desktop: 1, server: 2, lowpower: 3 }[this._settings.get_string('cpu-profile')] ?? 1);
        this._smoothingRow.set_active(this._settings.get_boolean('smoothing-enabled'));
        this._smoothingWinRow.set_value(this._settings.get_int('smoothing-window'));
        this._cacheTtlRow.set_value(this._settings.get_int('provider-cache-ttl'));
        this._showTrendRow.set_active(this._settings.get_boolean('show-trend'));
        this._historyLenRow.set_value(this._settings.get_int('history-length'));
        this._sampleMsRow.set_value(this._settings.get_int('per-process-sample-ms'));
        this._topNRow.set_value(this._settings.get_int('per-process-top-n'));
        this._showIntensityRow.set_active(this._settings.get_boolean('show-intensity'));
        this._monochromeRow.set_active(this._settings.get_boolean('monochrome-mode'));
        this._providerRow.set_selected(this._settings.get_string('intensity-provider') === 'auto-country' ? 1 : 0);
        this._apiKeyRow.set_text(this._settings.get_string('electricitymaps-api-key'));
        this._zoneRow.set_text(this._settings.get_string('electricitymaps-zone'));
        this._autoDetectRow.set_active(this._settings.get_boolean('auto-detect-zone'));
    }
});

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default class Preferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.add(new CO2ConsumptionPreferences(this.getSettings()));
    }
}
