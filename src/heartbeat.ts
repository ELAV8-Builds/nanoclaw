/**
 * NanoClaw Heartbeat Service
 *
 * Monitors all active agent containers at a configurable interval (default 60s):
 *
 *   1. Measures context window usage (transcript size → estimated tokens)
 *   2. Classifies health: healthy (<40%), filling (40-65%), high (65-85%), critical (>85%)
 *   3. Auto-checkpoints at HIGH (writes CONTINUE.md with spec tracker snapshot)
 *   4. Force-resets at CRITICAL (checkpoint + IPC reset_context signal)
 *   5. Detects dead/hung container processes
 *   6. Logs health snapshots (current.json + ring-buffer history.json)
 *
 * Safety features:
 *   - Hysteresis: HIGH must persist for 2+ consecutive ticks before acting
 *   - Cooldowns: 5-min checkpoint, 10-min reset (prevents spam)
 *   - Atomic writes: temp+rename pattern for crash safety
 *   - Transition logging: warnings only on status changes, not every tick
 *   - Stale state cleanup: removes tracking for inactive groups
 *   - Tick duration monitoring: warns if tick takes >5s
 *
 * Runs on the HOST process alongside startMessageLoop and startSchedulerLoop.
 * Reset signals are consumed by the IPC handler in src/ipc.ts (reset_context case).
 */

import fs from 'fs';
import path from 'path';
import { ChildProcess } from 'child_process';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeartbeatOptions {
  /** Function to get active groups: Map<groupJid, GroupState> */
  getActiveGroups: () => Map<
    string,
    {
      active: boolean;
      process: ChildProcess | null;
      containerName: string | null;
      groupFolder: string | null;
    }
  >;
  /** Interval in ms (default: 60000 = 1 minute) */
  intervalMs?: number;
}

export interface HealthSnapshot {
  timestamp: string;
  groups: GroupHealth[];
  totalActiveContainers: number;
  systemHealthy: boolean;
  /** How long the heartbeat tick took in milliseconds. */
  tickDurationMs?: number;
}

export interface GroupHealth {
  groupFolder: string;
  containerName: string | null;
  active: boolean;
  transcriptSizeKB: number;
  estimatedTokens: number;
  percentUsed: number;
  status: HealthStatus;
  action: HealthAction;
}

export type HealthStatus = 'healthy' | 'filling' | 'high' | 'critical';
export type HealthAction = 'none' | 'warn' | 'checkpoint' | 'force-reset';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHARS_PER_TOKEN = 4;
const CONTEXT_LIMIT = 200_000;
const MAX_HEALTH_LOGS = 100;
const MAX_ACTION_LOG_ENTRIES = 200;

// Cooldown: don't re-checkpoint or re-reset a group for this many ms
// after the last checkpoint/reset for that group.
const CHECKPOINT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const RESET_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// State tracking (prevents spamming checkpoints/resets)
// ---------------------------------------------------------------------------

const lastCheckpointTime = new Map<string, number>();
const lastResetTime = new Map<string, number>();
const previousStatus = new Map<string, HealthStatus>();
/** Track consecutive ticks at a given status to provide hysteresis. */
const consecutiveTicks = new Map<string, { status: HealthStatus; count: number }>();

/** Minimum consecutive ticks at a threshold before acting (prevents oscillation). */
const HYSTERESIS_TICKS = 2;

function isOnCooldown(
  map: Map<string, number>,
  key: string,
  cooldownMs: number,
): boolean {
  const last = map.get(key);
  if (!last) return false;
  return Date.now() - last < cooldownMs;
}

// ---------------------------------------------------------------------------
// Core Functions
// ---------------------------------------------------------------------------

/**
 * Measure transcript size for a specific group's session.
 * Mirrors the logic in container-runner.ts and ipc-mcp-stdio.ts.
 */
function measureTranscriptSize(groupFolder: string): number {
  const sessionsDir = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
    'projects',
  );
  let total = 0;

  try {
    if (!fs.existsSync(sessionsDir)) return 0;
    for (const dir of fs.readdirSync(sessionsDir)) {
      const projectDir = path.join(sessionsDir, dir);
      if (!fs.statSync(projectDir).isDirectory()) continue;
      for (const file of fs.readdirSync(projectDir)) {
        if (file.endsWith('.jsonl')) {
          total += fs.statSync(path.join(projectDir, file)).size;
        }
      }
      const subagentsDir = path.join(projectDir, 'subagents');
      if (fs.existsSync(subagentsDir)) {
        for (const file of fs.readdirSync(subagentsDir)) {
          if (file.endsWith('.jsonl')) {
            total += fs.statSync(path.join(subagentsDir, file)).size;
          }
        }
      }
    }
  } catch {
    /* ignore filesystem errors */
  }

  return total;
}

/**
 * Write a CONTINUE.md checkpoint for a group approaching context limits.
 * Skipped if a checkpoint was written recently (cooldown).
 */
function writeCheckpoint(groupFolder: string, reason: string): boolean {
  if (isOnCooldown(lastCheckpointTime, groupFolder, CHECKPOINT_COOLDOWN_MS)) {
    return false;
  }

  const groupDir = path.join(GROUPS_DIR, groupFolder);
  const continuePath = path.join(groupDir, 'CONTINUE.md');
  const specTrackerPath = path.join(groupDir, 'SPEC_TRACKER.md');

  let specStatus = 'No spec tracker found.';
  try {
    if (fs.existsSync(specTrackerPath)) {
      specStatus = fs.readFileSync(specTrackerPath, 'utf-8');
    }
  } catch {
    /* ignore */
  }

  const now = new Date();
  const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const content = [
    `# CONTINUE — Auto-saved by Heartbeat Service`,
    ``,
    `## Metadata`,
    `- Created: ${now.toISOString()}`,
    `- Expires: ${expires.toISOString()}`,
    `- Reason: ${reason}`,
    ``,
    `## Instructions for Next Session`,
    `This file was auto-created by the heartbeat monitor because the context`,
    `window was getting full. Read this file and the SPEC_TRACKER.md (if it`,
    `exists) to understand where the previous session left off.`,
    ``,
    `## Spec Tracker Snapshot`,
    '```',
    specStatus,
    '```',
    ``,
    `## Recent Conversations`,
    `Check /workspace/group/conversations/ for archived transcripts.`,
    ``,
  ].join('\n');

  const tempPath = `${continuePath}.tmp`;
  try {
    fs.mkdirSync(groupDir, { recursive: true });
    // Atomic write: temp → rename
    fs.writeFileSync(tempPath, content);
    fs.renameSync(tempPath, continuePath);
    lastCheckpointTime.set(groupFolder, Date.now());
    return true;
  } catch (err) {
    logger.error(
      { groupFolder, err },
      'Heartbeat: failed to write checkpoint',
    );
    // Clean up temp file if rename failed
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      /* best-effort cleanup */
    }
    return false;
  }
}

/**
 * Write an IPC reset_context signal for a group.
 * Skipped if a reset was triggered recently (cooldown).
 */
function writeResetSignal(
  groupFolder: string,
  chatJid: string,
  reason: string,
): boolean {
  if (isOnCooldown(lastResetTime, groupFolder, RESET_COOLDOWN_MS)) {
    return false;
  }

  const tasksDir = path.join(DATA_DIR, 'ipc', groupFolder, 'tasks');
  const filename = `${Date.now()}-heartbeat-reset.json`;
  const tempPath = path.join(tasksDir, `${filename}.tmp`);

  try {
    fs.mkdirSync(tasksDir, { recursive: true });

    const data = {
      type: 'reset_context',
      groupFolder,
      chatJid,
      summary: `Heartbeat auto-reset: ${reason}`,
      timestamp: new Date().toISOString(),
    };

    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
    fs.renameSync(tempPath, path.join(tasksDir, filename));
    lastResetTime.set(groupFolder, Date.now());
    return true;
  } catch (err) {
    logger.error(
      { groupFolder, err },
      'Heartbeat: failed to write reset signal',
    );
    // Clean up temp file if rename failed
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      /* best-effort cleanup */
    }
    return false;
  }
}

/**
 * Check if a container process is still alive.
 */
function isProcessAlive(proc: ChildProcess | null): boolean {
  if (!proc || proc.pid === undefined) return false;
  try {
    process.kill(proc.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Classify transcript usage into a health status.
 */
function classifyStatus(percentUsed: number): HealthStatus {
  if (percentUsed < 40) return 'healthy';
  if (percentUsed < 65) return 'filling';
  if (percentUsed < 85) return 'high';
  return 'critical';
}

/**
 * Determine what action to take based on status.
 */
function determineAction(status: HealthStatus): HealthAction {
  switch (status) {
    case 'critical':
      return 'force-reset';
    case 'high':
      return 'checkpoint';
    case 'filling':
      return 'warn';
    default:
      return 'none';
  }
}

// ---------------------------------------------------------------------------
// Action Log (per-group append-only JSONL)
// ---------------------------------------------------------------------------

interface ActionLogEntry {
  timestamp: string;
  groupFolder: string;
  status: HealthStatus;
  action: HealthAction;
  percentUsed: number;
  result: 'executed' | 'cooldown' | 'hysteresis' | 'skipped';
  detail?: string;
}

/**
 * Append an action entry to the per-group action log.
 * Uses JSONL format (one JSON object per line) for easy streaming/parsing.
 * Truncates to MAX_ACTION_LOG_ENTRIES to prevent unbounded growth.
 */
function writeActionLog(entry: ActionLogEntry): void {
  const actionDir = path.join(DATA_DIR, 'health', 'actions');
  const logPath = path.join(actionDir, `${entry.groupFolder}.jsonl`);

  try {
    fs.mkdirSync(actionDir, { recursive: true });
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(logPath, line);

    // Periodic truncation: check line count every ~50 writes
    // (cheaper than checking every write)
    try {
      const stat = fs.statSync(logPath);
      // Rough check: if file > 100KB, truncate to last MAX_ACTION_LOG_ENTRIES lines
      if (stat.size > 100 * 1024) {
        const content = fs.readFileSync(logPath, 'utf-8');
        const lines = content.trim().split('\n');
        if (lines.length > MAX_ACTION_LOG_ENTRIES) {
          const truncated = lines.slice(-MAX_ACTION_LOG_ENTRIES).join('\n') + '\n';
          const tempPath = `${logPath}.tmp`;
          fs.writeFileSync(tempPath, truncated);
          fs.renameSync(tempPath, logPath);
        }
      }
    } catch {
      /* truncation is best-effort */
    }
  } catch (err) {
    logger.error(
      { groupFolder: entry.groupFolder, err },
      'Heartbeat: failed to write action log',
    );
  }
}

// ---------------------------------------------------------------------------
// Health Log
// ---------------------------------------------------------------------------

function writeHealthLog(snapshot: HealthSnapshot): void {
  const healthDir = path.join(DATA_DIR, 'health');
  const currentPath = path.join(healthDir, 'current.json');
  const currentTemp = `${currentPath}.tmp`;
  const historyPath = path.join(healthDir, 'history.json');
  const historyTemp = `${historyPath}.tmp`;

  try {
    fs.mkdirSync(healthDir, { recursive: true });

    // Atomic write for current snapshot
    fs.writeFileSync(currentTemp, JSON.stringify(snapshot, null, 2));
    fs.renameSync(currentTemp, currentPath);

    // Append to ring-buffer history
    let history: HealthSnapshot[] = [];
    try {
      if (fs.existsSync(historyPath)) {
        history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
      }
    } catch {
      history = [];
    }

    // Ensure history is an array (guard against corrupted data)
    if (!Array.isArray(history)) {
      logger.warn('Heartbeat: corrupted history.json, resetting');
      history = [];
    }

    history.push(snapshot);
    if (history.length > MAX_HEALTH_LOGS) {
      history = history.slice(-MAX_HEALTH_LOGS);
    }

    fs.writeFileSync(historyTemp, JSON.stringify(history, null, 2));
    fs.renameSync(historyTemp, historyPath);
  } catch (err) {
    logger.error({ err }, 'Heartbeat: failed to write health log');
    // Clean up temp files on failure
    try {
      if (fs.existsSync(currentTemp)) fs.unlinkSync(currentTemp);
    } catch {
      /* best-effort */
    }
    try {
      if (fs.existsSync(historyTemp)) fs.unlinkSync(historyTemp);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Clean up state tracking for groups that are no longer active.
 * Prevents memory leaks from accumulated group keys.
 */
function cleanupStaleState(activeGroupFolders: Set<string>): void {
  for (const key of lastCheckpointTime.keys()) {
    if (!activeGroupFolders.has(key)) {
      lastCheckpointTime.delete(key);
      previousStatus.delete(key);
      consecutiveTicks.delete(key);
    }
  }
  for (const key of lastResetTime.keys()) {
    if (!activeGroupFolders.has(key)) {
      lastResetTime.delete(key);
    }
  }
}

/**
 * Reset all module-level state. Exported for testing only.
 * @internal
 */
export function _resetState(): void {
  lastCheckpointTime.clear();
  lastResetTime.clear();
  previousStatus.clear();
  consecutiveTicks.clear();
}

// ---------------------------------------------------------------------------
// Main Heartbeat Loop
// ---------------------------------------------------------------------------

/**
 * Start the heartbeat monitoring loop.
 * Returns a stop function to cleanly shut down the heartbeat.
 */
export function startHeartbeat(opts: HeartbeatOptions): { stop: () => void } {
  const { getActiveGroups, intervalMs = 60_000 } = opts;

  logger.info(
    { intervalMs },
    `Heartbeat started (interval: ${intervalMs / 1000}s)`,
  );

  const tick = () => {
    const tickStart = Date.now();
    try {
      const groups = getActiveGroups();
      const groupHealths: GroupHealth[] = [];
      let systemHealthy = true;
      const activeGroupFolders = new Set<string>();

      for (const [jid, state] of groups) {
        if (!state.groupFolder || !state.active) continue;
        activeGroupFolders.add(state.groupFolder);

        const transcriptSize = measureTranscriptSize(state.groupFolder);
        const estimatedTokens = Math.round(transcriptSize / CHARS_PER_TOKEN);
        const percentUsed = Math.round(
          (estimatedTokens / CONTEXT_LIMIT) * 100,
        );

        const status = classifyStatus(percentUsed);
        const action = determineAction(status);
        const prevStatus = previousStatus.get(state.groupFolder);

        // Track consecutive ticks at same status (hysteresis)
        const prevTicks = consecutiveTicks.get(state.groupFolder);
        if (prevTicks && prevTicks.status === status) {
          prevTicks.count++;
        } else {
          consecutiveTicks.set(state.groupFolder, { status, count: 1 });
        }
        const tickCount =
          consecutiveTicks.get(state.groupFolder)?.count ?? 1;

        // Act on status — with hysteresis to prevent oscillation at boundaries.
        // Critical always acts immediately (safety). High requires HYSTERESIS_TICKS.
        if (status === 'critical') {
          systemHealthy = false;

          // Only log on transition or first detection
          if (prevStatus !== 'critical') {
            logger.warn(
              {
                groupFolder: state.groupFolder,
                percentUsed,
                transcriptSizeKB: Math.round(transcriptSize / 1024),
              },
              `Heartbeat: context CRITICAL for ${state.groupFolder} (${percentUsed}%) — forcing reset`,
            );
          }

          const checkpointOk = writeCheckpoint(
            state.groupFolder,
            `Context at ${percentUsed}% — heartbeat auto-reset`,
          );
          const resetOk = writeResetSignal(
            state.groupFolder,
            jid,
            `Context at ${percentUsed}%`,
          );
          writeActionLog({
            timestamp: new Date().toISOString(),
            groupFolder: state.groupFolder,
            status,
            action: 'force-reset',
            percentUsed,
            result: resetOk ? 'executed' : 'cooldown',
            detail: `checkpoint=${checkpointOk}, reset=${resetOk}`,
          });
        } else if (status === 'high') {
          // Log on first transition regardless of hysteresis
          if (prevStatus !== 'high') {
            logger.warn(
              { groupFolder: state.groupFolder, percentUsed },
              `Heartbeat: context HIGH for ${state.groupFolder} (${percentUsed}%) — checkpoint pending`,
            );
          }
          // Only act (write checkpoint) after hysteresis confirms sustained HIGH
          if (tickCount >= HYSTERESIS_TICKS) {
            const ok = writeCheckpoint(
              state.groupFolder,
              `Context at ${percentUsed}% — heartbeat checkpoint`,
            );
            writeActionLog({
              timestamp: new Date().toISOString(),
              groupFolder: state.groupFolder,
              status,
              action: 'checkpoint',
              percentUsed,
              result: ok ? 'executed' : 'cooldown',
            });
          } else {
            writeActionLog({
              timestamp: new Date().toISOString(),
              groupFolder: state.groupFolder,
              status,
              action: 'checkpoint',
              percentUsed,
              result: 'hysteresis',
              detail: `tick ${tickCount}/${HYSTERESIS_TICKS}`,
            });
          }
        }

        previousStatus.set(state.groupFolder, status);

        // Detect dead containers
        if (state.process && !isProcessAlive(state.process)) {
          logger.error(
            {
              groupFolder: state.groupFolder,
              containerName: state.containerName,
            },
            `Heartbeat: container process DEAD for ${state.groupFolder} but still marked active`,
          );
          systemHealthy = false;
        }

        groupHealths.push({
          groupFolder: state.groupFolder,
          containerName: state.containerName,
          active: state.active,
          transcriptSizeKB: Math.round(transcriptSize / 1024),
          estimatedTokens,
          percentUsed,
          status,
          action,
        });
      }

      const tickDurationMs = Date.now() - tickStart;
      const snapshot: HealthSnapshot = {
        timestamp: new Date().toISOString(),
        groups: groupHealths,
        totalActiveContainers: groupHealths.filter((g) => g.active).length,
        systemHealthy,
        tickDurationMs,
      };

      writeHealthLog(snapshot);

      // Warn if tick took too long (filesystem latency, too many groups)
      if (tickDurationMs > 5000) {
        logger.warn(
          { tickDurationMs },
          `Heartbeat: tick took ${tickDurationMs}ms (>5s), filesystem may be slow`,
        );
      }

      // Log summary when there are active containers
      const activeGroups = groupHealths.filter((g) => g.active);
      if (activeGroups.length > 0) {
        const summary = activeGroups
          .map((g) => `${g.groupFolder}:${g.percentUsed}%[${g.status}]`)
          .join(', ');
        logger.info(
          { activeContainers: activeGroups.length },
          `Heartbeat: ${summary}`,
        );
      }

      // Periodic cleanup of stale state tracking
      cleanupStaleState(activeGroupFolders);
    } catch (err) {
      logger.error({ err }, 'Heartbeat tick failed');
    }
  };

  // First tick immediately
  tick();

  // Then every intervalMs
  const intervalId = setInterval(tick, intervalMs);

  return {
    stop: () => {
      clearInterval(intervalId);
      logger.info('Heartbeat stopped');
    },
  };
}
