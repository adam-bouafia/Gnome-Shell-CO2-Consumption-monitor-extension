# Installation Guide — CO2 Consumption Monitor

This guide provides step-by-step instructions for installing the CO2 Consumption Monitor GNOME Shell extension.

## Prerequisites

Before installing the extension, ensure your system meets these requirements:

### System Requirements

- Linux distribution with GNOME Shell 43–48
- GNOME Extensions app (usually pre-installed)

### Verify Your System

Check your GNOME Shell version:

```bash
gnome-shell --version
```

## Step 1: Download the Extension

### Option A: Download from GitHub

1. Visit the project repository
2. Click "Code" → "Download ZIP"
3. Extract the ZIP file to a temporary location

### Option B: Clone with Git

```bash
git clone https://github.com/adambouafia/deb-co2-consumption-monitor.git
cd deb-co2-consumption-monitor
```

## Step 2: Install the Extension

### Create Extension Directory

```bash
mkdir -p ~/.local/share/gnome-shell/extensions/co2consumption@gmail.com
```

### Copy Extension Files

```bash
# If you downloaded a ZIP file:
cp -r /path/to/extracted/files/* ~/.local/share/gnome-shell/extensions/co2consumption@gmail.com/

# If you cloned with git:
cp -r * ~/.local/share/gnome-shell/extensions/co2consumption@gmail.com/
```

### Compile Schemas

If you copied the files manually, compile the GSettings schema:

```bash
glib-compile-schemas ~/.local/share/gnome-shell/extensions/co2consumption@gmail.com/schemas
```

## Step 3: Enable the Extension

### Method 1: Using GNOME Extensions App

1. Open "Extensions" app from your applications menu
2. Find "CO2 Consumption Monitor" in the list
3. Toggle the switch to enable it

### Method 2: Using Command Line

```bash
# Restart GNOME Shell first
# Press Alt+F2, type 'r', press Enter
# Or logout and login again

# Enable the extension
gnome-extensions enable co2consumption@gmail.com
```

### Method 3: Using GNOME Tweaks

1. Install GNOME Tweaks if not already installed:
   
   ```bash
   # Ubuntu/Debian
   sudo apt install gnome-tweaks
   
   # Fedora
   sudo dnf install gnome-tweaks
   
   # Arch Linux
   sudo pacman -S gnome-tweaks
   ```
   

2. Open GNOME Tweaks
3. Go to "Extensions" tab
4. Find "CO2 Consumption Monitor" and enable it

## Step 4: Verify Installation

### Check Extension Status

```bash
gnome-extensions list --enabled | grep co2consumption
```

### Test the Extension

1. Look for the CO2 indicator in your top panel (should show something like "0.000g" initially)
2. Click on the indicator to see the dropdown menu
3. Check that data updates after a few seconds

### Configure Provider (Optional)

Open Preferences and set:

- ElectricityMaps API key and zone (or enable auto-detect)
- Or select Smart Auto (uses a bundled country-average dataset and, if auto-detect is enabled, performs IP geolocation to choose your country)

Tip: You can open Preferences either via the Extensions app or directly from the extension popup using the gear icon at the bottom-right.

## Troubleshooting Installation

### Extension Not Appearing

1. **Restart GNOME Shell**:
   - Press Alt+F2, type 'r', press Enter
   - Or logout and login again

2. **Check file permissions**:
   
   ```bash
   ls -la ~/.local/share/gnome-shell/extensions/co2consumption@gmail.com/
   ```
   All files should be readable.

3. **Verify extension UUID**:
   
   ```bash
   cat ~/.local/share/gnome-shell/extensions/co2consumption@gmail.com/metadata.json
   ```
   The UUID should match the directory name.

### Provider Issues

- ElectricityMaps: ensure API key is valid and zone is set (or auto-detect enabled). Rate limits may apply.

### Extension Crashes

1. **Check GNOME Shell logs**:
   
   ```bash
   journalctl -f -o cat /usr/bin/gnome-shell
   ```

2. **Disable and re-enable**:
   
   ```bash
   gnome-extensions disable co2consumption@gmail.com
   gnome-extensions enable co2consumption@gmail.com
   ```
   

3. **Enable Safe Mode**:
   Open Preferences and enable Safe Mode to temporarily disable per‑process monitoring and online provider lookups. This helps isolate issues.

### No CO2 Data Showing

1. Ensure the extension is enabled and reload the shell if needed.
2. Check logs with `journalctl` as above.

## Uninstallation

To remove the extension:

1. **Disable the extension**:
   
   ```bash
   gnome-extensions disable co2consumption@gmail.com
   ```

2. **Remove extension files**:
   
   ```bash
   rm -rf ~/.local/share/gnome-shell/extensions/co2consumption@gmail.com
   ```

3. That’s it—no external dependencies were installed.

## Advanced Installation Options

### System-wide Installation

To install for all users (requires administrator privileges):

```bash
sudo mkdir -p /usr/share/gnome-shell/extensions/co2consumption@gmail.com
sudo cp -r * /usr/share/gnome-shell/extensions/co2consumption@gmail.com/
```


### Development Installation

For developers who want to modify the extension:

```bash
# Create symlink instead of copying files
ln -s /path/to/development/directory ~/.local/share/gnome-shell/extensions/co2consumption@gmail.com
```

### Notes

- On Wayland, you must log out/in to reload GNOME Shell. Alt+F2 → r only works on Xorg.
- Online features are optional. If disabled, the extension uses your configured fixed carbon intensity and does not perform network requests.

### Next Steps

After successful installation:

1. **Configure preferences**: Open Extensions app → CO2 Consumption Monitor → Settings
2. **Customize display**: Adjust update interval and appearance
3. **Monitor usage**: Start tracking your computer's environmental impact

For usage instructions, see the main [README.md](README.md) file.


## Runtime validation

After enabling the extension:

- On Xorg: Press Alt+F2, type r, press Enter to reload GNOME Shell
- On Wayland: Log out and log back in to reload the shell

To watch logs while enabling/testing:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

If the indicator doesn’t appear or stays at 0.000g:

- Open Preferences and check your provider settings
- Temporarily disable online provider to use the fixed intensity
- Re-enable the extension and watch logs for errors

