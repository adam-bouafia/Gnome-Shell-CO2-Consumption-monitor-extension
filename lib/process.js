/**
 * Per-process CPU monitoring via procfs.
 *
 * Samples /proc/<pid>/stat to determine each process's share of total
 * CPU time, then allocates a proportional fraction of total CO2.
 */
import Gio from 'gi://Gio';
import { listDir, readFile, sleepMs } from './utils.js';
import { getCpuTimes } from './power.js';

// Cap PIDs to prevent excessive I/O on busy systems.
// Sorted numerically so newer (higher PID) processes are included, as
// they are more likely to be user-visible applications.
const MAX_PIDS = 500;

// ---------------------------------------------------------------------------
// Procfs helpers
// ---------------------------------------------------------------------------

async function listPidDirs(cancellable) {
    const pids = (await listDir('/proc', 'standard::name,standard::type', cancellable))
        .filter(info => info.get_file_type() === Gio.FileType.DIRECTORY)
        .map(info => info.get_name())
        .filter(name => /^\d+$/.test(name));
    // Sort descending so higher PIDs (newer processes) come first
    pids.sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
    return pids;
}

/**
 * Parse /proc/<pid>/stat for process name and CPU ticks.
 * Returns { name, ticks } or null.
 */
async function readProcStat(pid, cancellable) {
    const text = await readFile(`/proc/${pid}/stat`, cancellable);
    if (!text) return null;
    const l = text.indexOf('(');
    const r = text.lastIndexOf(')');
    if (l < 0 || r < 0 || r <= l) return null;
    const comm = text.substring(l + 1, r);
    const rest = text.substring(r + 2).trim();
    const parts = rest.split(/\s+/);
    if (parts.length < 13) return null;
    const utime = parseInt(parts[11], 10) || 0;
    const stime = parseInt(parts[12], 10) || 0;
    return { name: comm, ticks: utime + stime };
}

/** Take a snapshot of all process CPU ticks (reads run concurrently on GIO's thread pool). */
async function getProcessTimesSnapshot(cancellable) {
    const pids = (await listPidDirs(cancellable)).slice(0, MAX_PIDS);
    const stats = await Promise.all(pids.map(pid => readProcStat(pid, cancellable)));
    const map = new Map();
    pids.forEach((pid, i) => {
        const st = stats[i];
        if (st) map.set(pid, { name: st.name || 'unknown', ticks: st.ticks });
    });
    return map;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sample per-process CPU shares over a time window.
 *
 * Takes two snapshots of /proc separated by `sampleMs` milliseconds,
 * computes each process's fraction of total CPU time, aggregates by
 * process name, and returns sorted descending by share.
 *
 * @param {number} sampleMs - Sampling window in ms (50-1000)
 * @param {Gio.Cancellable|null} cancellable
 * @returns {Promise<Array<{ name: string, share: number }>>}
 */
export async function sampleProcessShares(sampleMs = 250, cancellable = null) {
    const [s1, p1] = await Promise.all([getCpuTimes(cancellable), getProcessTimesSnapshot(cancellable)]);
    await sleepMs(sampleMs, cancellable);
    if (cancellable?.is_cancelled()) return [];
    const [s2, p2] = await Promise.all([getCpuTimes(cancellable), getProcessTimesSnapshot(cancellable)]);
    if (!s1 || !s2) return [];
    const totald = s2.total - s1.total;
    if (totald <= 0) return [];

    // Compute per-PID deltas
    const rows = [];
    for (const [pid, v1] of p1.entries()) {
        const v2 = p2.get(pid);
        if (!v2) continue;
        const delta = v2.ticks - v1.ticks;
        if (delta <= 0) continue;
        rows.push({ name: v2.name, share: delta / totald });
    }

    // Aggregate by process name
    const byName = new Map();
    for (const row of rows) {
        byName.set(row.name, (byName.get(row.name) || 0) + row.share);
    }

    return Array.from(byName.entries())
        .map(([name, share]) => ({ name, share }))
        .sort((a, b) => b.share - a.share)
        .slice(0, 200);
}
