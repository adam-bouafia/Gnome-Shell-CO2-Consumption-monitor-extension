/**
 * Power measurement module - CodeCarbon-inspired approach.
 *
 * Priority order:
 *   1. Intel RAPL (actual measured energy via sysfs powercap)
 *   2. CPU heuristic (frequency-scaled per-core wattage by profile)
 *
 * RAM power is always added using CodeCarbon's coefficient from
 * Lannelongue et al. 2021: 0.3725 W per GB of installed RAM.
 *
 * References:
 *   - CodeCarbon: https://github.com/mlco2/codecarbon
 *   - Lannelongue, Grealey & Inouye (2021), Nature Computational Science
 */
import GLib from 'gi://GLib';
import { listDir, readFile } from './utils.js';

// CodeCarbon RAM power coefficient (W per GB)
const RAM_WATTS_PER_GB = 0.3725;

// ---------------------------------------------------------------------------
// RAPL (Running Average Power Limit) - Intel & recent AMD
// ---------------------------------------------------------------------------

let _raplDomains = null;

/**
 * Detect available RAPL package-level domains.
 * Resolves to an array of { name, energyPath, maxRangeUj } objects.
 * Caches result after first call.
 */
export async function detectRaplDomains(cancellable = null) {
    if (_raplDomains !== null) return _raplDomains;
    const basePath = '/sys/class/powercap';
    const domains = [];
    for (const info of await listDir(basePath, 'standard::name', cancellable)) {
        const name = info.get_name();
        // Only top-level package domains (intel-rapl:0, intel-rapl:1, ...)
        // Skip sub-packages like intel-rapl:0:0 (core), intel-rapl:0:1 (uncore)
        if (!name.startsWith('intel-rapl:') || (name.match(/:/g) || []).length !== 1)
            continue;
        const energyPath = `${basePath}/${name}/energy_uj`;
        // Check readability (requires kernel config or udev rule)
        const [energyText, maxText] = await Promise.all([
            readFile(energyPath, cancellable),
            readFile(`${basePath}/${name}/max_energy_range_uj`, cancellable),
        ]);
        if (energyText === null) continue;
        const maxRangeUj = maxText ? parseInt(maxText.trim(), 10) : 0;
        domains.push({ name, energyPath, maxRangeUj });
    }
    if (cancellable?.is_cancelled()) return domains; // don't cache a partial scan
    _raplDomains = domains;
    return _raplDomains;
}

/** Reset cached RAPL domains (call on extension disable). */
export function resetRaplCache() {
    _raplDomains = null;
}

/** Check if RAPL energy readings are available on this system. */
export async function raplAvailable(cancellable = null) {
    return (await detectRaplDomains(cancellable)).length > 0;
}

/**
 * Read current RAPL energy counters.
 * Returns { totalUj: number, timestamp: number (ms) } or null.
 */
export async function readRaplSnapshot(cancellable = null) {
    const domains = await detectRaplDomains(cancellable);
    if (domains.length === 0) return null;
    const texts = await Promise.all(domains.map(d => readFile(d.energyPath, cancellable)));
    let totalUj = 0;
    for (const text of texts) {
        if (text === null) return null; // lost access mid-session
        const uj = parseInt(text.trim(), 10);
        if (!Number.isFinite(uj)) return null;
        totalUj += uj;
    }
    return { totalUj, timestamp: GLib.get_monotonic_time() / 1000 }; // us -> ms
}

/**
 * Compute average power in watts from two RAPL snapshots.
 * Handles counter wraparound using max_energy_range_uj.
 */
export function computeRaplWatts(prev, curr) {
    if (!prev || !curr) return null;
    const deltaMs = curr.timestamp - prev.timestamp;
    if (deltaMs <= 0) return null;
    let deltaUj = curr.totalUj - prev.totalUj;
    // Handle wraparound
    if (deltaUj < 0) {
        const domains = _raplDomains ?? [];
        const maxRange = domains.reduce((sum, d) => sum + (d.maxRangeUj || 0), 0);
        if (maxRange > 0) deltaUj += maxRange;
        else return null; // can't recover without max range
    }
    const deltaSec = deltaMs / 1000;
    return deltaUj / (deltaSec * 1e6); // uJ / (s * 1e6) = W
}

// ---------------------------------------------------------------------------
// CPU stats from /proc/stat
// ---------------------------------------------------------------------------

/**
 * Read aggregate CPU times from /proc/stat.
 * Returns { idleAll, total } in jiffies or null.
 */
export async function getCpuTimes(cancellable = null) {
    const data = await readFile('/proc/stat', cancellable);
    if (!data) return null;
    const line = data.split('\n')[0];
    const parts = line.trim().split(/\s+/).slice(1).map(x => parseInt(x, 10));
    if (parts.length < 7) return null;
    const [user, nice, system, idle, iowait, irq, softirq, steal = 0] = parts;
    const idleAll = idle + iowait;
    const nonIdle = user + nice + system + irq + softirq + steal;
    return { idleAll, total: idleAll + nonIdle };
}

/** Compute CPU usage percentage from two snapshots. */
export function getCpuUsagePercent(prev, curr) {
    if (!prev || !curr) return 0;
    const totald = curr.total - prev.total;
    const idled = curr.idleAll - prev.idleAll;
    if (totald <= 0) return 0;
    return ((totald - idled) / totald) * 100;
}

// ---------------------------------------------------------------------------
// CPU info
// ---------------------------------------------------------------------------

let _cpuInfoCache = null;
let _cpuInfoAge = 0;
const CPU_INFO_CACHE_MS = 30000;

/** Read CPU frequency and core count from /proc/cpuinfo (cached 30s). */
export async function readCpuInfo(cancellable = null) {
    const now = Date.now();
    if (_cpuInfoCache && (now - _cpuInfoAge) < CPU_INFO_CACHE_MS)
        return _cpuInfoCache;
    const text = await readFile('/proc/cpuinfo', cancellable);
    if (!text) {
        _cpuInfoCache = { mhz: 2200, cores: 4 };
    } else {
        const mhzMatch = text.match(/cpu MHz\s*:\s*([0-9.]+)/);
        const cores = (text.match(/^processor\s*:/gm) || []).length || 4;
        const mhz = mhzMatch ? parseFloat(mhzMatch[1]) : 2200;
        _cpuInfoCache = { mhz, cores };
    }
    _cpuInfoAge = now;
    return _cpuInfoCache;
}

/** Reset CPU info cache (call on disable). */
export function resetCpuInfoCache() {
    _cpuInfoCache = null;
    _cpuInfoAge = 0;
}

// ---------------------------------------------------------------------------
// Heuristic power model (fallback when RAPL is unavailable)
// ---------------------------------------------------------------------------

// Base per-core active power at 2.2 GHz reference (watts)
const PROFILE_BASE_W = {
    laptop: 2.8,
    desktop: 4.0,
    server: 6.0,
    lowpower: 1.5,
};

/**
 * Estimate total system power draw using CPU utilization heuristic.
 * Returns watts (CPU only, excludes RAM - that's added separately).
 */
export async function getHeuristicCpuWatts(cpuPercent, profile = 'desktop', cancellable = null) {
    const { mhz, cores } = await readCpuInfo(cancellable);
    const freqScale = Math.max(0.5, Math.min(2.0, mhz / 2200));
    const perCoreBase = PROFILE_BASE_W[profile] ?? PROFILE_BASE_W.desktop;
    const activePerCore = perCoreBase * freqScale;
    const maxActive = activePerCore * Math.max(1, cores);
    const idle = Math.min(0.25 * maxActive, 8);
    return Math.max(1, idle + (maxActive - idle) * (cpuPercent / 100));
}

// ---------------------------------------------------------------------------
// RAM power estimation (CodeCarbon approach)
// ---------------------------------------------------------------------------

let _ramGB = null;

/** Read total installed RAM in GB from /proc/meminfo. */
export async function getInstalledRamGB(cancellable = null) {
    if (_ramGB !== null) return _ramGB;
    const text = await readFile('/proc/meminfo', cancellable);
    if (!text) { _ramGB = 8; return _ramGB; }
    const match = text.match(/MemTotal:\s+(\d+)/);
    _ramGB = match ? parseInt(match[1], 10) / (1024 * 1024) : 8;
    return _ramGB;
}

/**
 * Estimate RAM power draw in watts.
 * Uses CodeCarbon's coefficient: 0.3725 W per GB (Lannelongue et al. 2021).
 */
export async function getRamPowerWatts(cancellable = null) {
    return (await getInstalledRamGB(cancellable)) * RAM_WATTS_PER_GB;
}

/** Reset RAM cache (call on disable). */
export function resetRamCache() {
    _ramGB = null;
}

// ---------------------------------------------------------------------------
// Combined power estimate
// ---------------------------------------------------------------------------

/**
 * Get total system power in watts.
 *
 * If RAPL is available, uses measured CPU package power + RAM estimate.
 * Otherwise falls back to CPU heuristic + RAM estimate.
 *
 * @param {object} opts
 * @param {object|null} opts.prevRapl - Previous RAPL snapshot
 * @param {object|null} opts.currRapl - Current RAPL snapshot
 * @param {number} opts.cpuPercent - CPU usage 0-100
 * @param {string} opts.profile - CPU power profile
 * @param {Gio.Cancellable|null} [opts.cancellable]
 * @returns {Promise<{ watts: number, source: 'rapl'|'heuristic' }>}
 */
export async function getTotalPowerWatts({ prevRapl, currRapl, cpuPercent, profile, cancellable = null }) {
    const ramW = await getRamPowerWatts(cancellable);
    const raplW = computeRaplWatts(prevRapl, currRapl);
    if (raplW !== null && raplW > 0) {
        // RAPL measures CPU package (cores + uncore/iGPU). Add RAM on top.
        return { watts: raplW + ramW, source: 'rapl' };
    }
    // Fallback: heuristic CPU model + RAM
    const cpuW = await getHeuristicCpuWatts(cpuPercent, profile, cancellable);
    return { watts: cpuW + ramW, source: 'heuristic' };
}

/** Clean up all caches on extension disable. */
export function resetAllCaches() {
    resetRaplCache();
    resetCpuInfoCache();
    resetRamCache();
}
