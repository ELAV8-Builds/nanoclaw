import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ChildProcess } from 'child_process';

// Mock config
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-heartbeat-test/data',
  GROUPS_DIR: '/tmp/nanoclaw-heartbeat-test/groups',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { startHeartbeat, HealthSnapshot, _resetState } from './heartbeat.js';
import { logger } from './logger.js';

const TEST_DIR = '/tmp/nanoclaw-heartbeat-test';
const DATA_DIR = path.join(TEST_DIR, 'data');
const GROUPS_DIR = path.join(TEST_DIR, 'groups');

describe('heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    _resetState(); // Clear module-level state between tests
    fs.mkdirSync(path.join(DATA_DIR, 'health'), { recursive: true });
    fs.mkdirSync(path.join(DATA_DIR, 'sessions'), { recursive: true });
    fs.mkdirSync(GROUPS_DIR, { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  function makeGroups(
    entries: Array<{
      jid: string;
      groupFolder: string;
      active: boolean;
      transcriptSizeBytes?: number;
      processAlive?: boolean;
    }>,
  ) {
    const map = new Map<
      string,
      {
        active: boolean;
        process: ChildProcess | null;
        containerName: string | null;
        groupFolder: string | null;
      }
    >();

    for (const entry of entries) {
      if (entry.transcriptSizeBytes && entry.transcriptSizeBytes > 0) {
        const sessDir = path.join(
          DATA_DIR, 'sessions', entry.groupFolder, '.claude', 'projects', 'test-project',
        );
        fs.mkdirSync(sessDir, { recursive: true });
        fs.writeFileSync(path.join(sessDir, 'session.jsonl'), 'x'.repeat(entry.transcriptSizeBytes));
      }

      let proc: ChildProcess | null = null;
      if (entry.active && entry.processAlive !== false) {
        proc = { pid: process.pid, killed: false } as unknown as ChildProcess;
      } else if (entry.active && entry.processAlive === false) {
        proc = { pid: 999999999, killed: false } as unknown as ChildProcess;
      }

      map.set(entry.jid, {
        active: entry.active,
        process: proc,
        containerName: entry.active ? `nanoclaw-${entry.groupFolder}-123` : null,
        groupFolder: entry.groupFolder,
      });
    }

    return map;
  }

  function readSnapshot(): HealthSnapshot {
    return JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, 'health', 'current.json'), 'utf-8'),
    );
  }

  // -----------------------------------------------------------------------
  // Basic functionality
  // -----------------------------------------------------------------------

  it('starts and runs first tick immediately', () => {
    const hb = startHeartbeat({
      getActiveGroups: () => makeGroups([]),
      intervalMs: 60_000,
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ intervalMs: 60_000 }),
      expect.stringContaining('Heartbeat started'),
    );
    hb.stop();
  });

  it('returns a stop function that clears the interval', () => {
    const getActive = vi.fn(() => makeGroups([]));
    const hb = startHeartbeat({ getActiveGroups: getActive, intervalMs: 60_000 });

    expect(getActive).toHaveBeenCalledTimes(1);
    hb.stop();

    vi.advanceTimersByTime(120_000);
    expect(getActive).toHaveBeenCalledTimes(1); // No more ticks after stop
  });

  it('writes health log for active containers', () => {
    const hb = startHeartbeat({
      getActiveGroups: () => makeGroups([
        { jid: 'g1@g.us', groupFolder: 'main', active: true, transcriptSizeBytes: 10_000 },
      ]),
      intervalMs: 60_000,
    });

    const snapshot = readSnapshot();
    expect(snapshot.totalActiveContainers).toBe(1);
    expect(snapshot.systemHealthy).toBe(true);
    expect(snapshot.groups).toHaveLength(1);
    expect(snapshot.groups[0].groupFolder).toBe('main');
    expect(snapshot.groups[0].status).toBe('healthy');
    expect(snapshot.groups[0].action).toBe('none');
    hb.stop();
  });

  it('includes tickDurationMs in health snapshot', () => {
    const hb = startHeartbeat({
      getActiveGroups: () => makeGroups([
        { jid: 'g1@g.us', groupFolder: 'main', active: true, transcriptSizeBytes: 100 },
      ]),
      intervalMs: 60_000,
    });

    const snapshot = readSnapshot();
    expect(snapshot.tickDurationMs).toBeDefined();
    expect(typeof snapshot.tickDurationMs).toBe('number');
    expect(snapshot.tickDurationMs).toBeGreaterThanOrEqual(0);
    hb.stop();
  });

  // -----------------------------------------------------------------------
  // Status classification
  // -----------------------------------------------------------------------

  it('marks healthy when transcript is small', () => {
    const hb = startHeartbeat({
      getActiveGroups: () => makeGroups([
        { jid: 'g1@g.us', groupFolder: 'test', active: true, transcriptSizeBytes: 10_000 },
      ]),
      intervalMs: 60_000,
    });
    expect(readSnapshot().groups[0].status).toBe('healthy');
    hb.stop();
  });

  it('marks filling when transcript is moderate (40-65%)', () => {
    // 400KB = ~100K tokens = 50%
    const hb = startHeartbeat({
      getActiveGroups: () => makeGroups([
        { jid: 'g1@g.us', groupFolder: 'test', active: true, transcriptSizeBytes: 400_000 },
      ]),
      intervalMs: 60_000,
    });
    const s = readSnapshot();
    expect(s.groups[0].status).toBe('filling');
    expect(s.groups[0].action).toBe('warn');
    hb.stop();
  });

  it('writes checkpoint when context is high after hysteresis (65-85%)', () => {
    const gf = 'high-ctx';
    fs.mkdirSync(path.join(GROUPS_DIR, gf), { recursive: true });

    const hb = startHeartbeat({
      getActiveGroups: () => makeGroups([
        { jid: 'g1@g.us', groupFolder: gf, active: true, transcriptSizeBytes: 600_000 },
      ]),
      intervalMs: 60_000,
    });

    // First tick: HIGH detected but hysteresis prevents checkpoint (need 2 consecutive ticks)
    const s1 = readSnapshot();
    expect(s1.groups[0].status).toBe('high');
    expect(s1.groups[0].action).toBe('checkpoint');
    expect(fs.existsSync(path.join(GROUPS_DIR, gf, 'CONTINUE.md'))).toBe(false);

    // Warning logged on first tick (transition detection)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ groupFolder: gf }),
      expect.stringContaining('HIGH'),
    );

    // Second tick: now hysteresis satisfied, checkpoint written
    vi.advanceTimersByTime(60_000);
    expect(fs.existsSync(path.join(GROUPS_DIR, gf, 'CONTINUE.md'))).toBe(true);
    hb.stop();
  });

  it('force-resets when context is critical (>85%) — bypasses hysteresis', () => {
    const gf = 'critical';
    fs.mkdirSync(path.join(GROUPS_DIR, gf), { recursive: true });
    fs.mkdirSync(path.join(DATA_DIR, 'ipc', gf, 'tasks'), { recursive: true });

    const hb = startHeartbeat({
      getActiveGroups: () => makeGroups([
        { jid: 'g1@g.us', groupFolder: gf, active: true, transcriptSizeBytes: 800_000 },
      ]),
      intervalMs: 60_000,
    });

    const s = readSnapshot();
    expect(s.groups[0].status).toBe('critical');
    expect(s.groups[0].action).toBe('force-reset');
    expect(s.systemHealthy).toBe(false);
    // Critical acts immediately — no hysteresis delay
    expect(fs.existsSync(path.join(GROUPS_DIR, gf, 'CONTINUE.md'))).toBe(true);

    // IPC reset signal written
    const ipcDir = path.join(DATA_DIR, 'ipc', gf, 'tasks');
    const ipcFiles = fs.readdirSync(ipcDir).filter(f => f.endsWith('.json'));
    expect(ipcFiles.length).toBeGreaterThanOrEqual(1);
    const signal = JSON.parse(fs.readFileSync(path.join(ipcDir, ipcFiles[0]), 'utf-8'));
    expect(signal.type).toBe('reset_context');
    expect(signal.groupFolder).toBe(gf);
    expect(signal.chatJid).toBe('g1@g.us');
    expect(signal.summary).toContain('Heartbeat auto-reset');
    expect(signal.timestamp).toBeDefined();
    hb.stop();
  });

  // -----------------------------------------------------------------------
  // Hysteresis behavior
  // -----------------------------------------------------------------------

  it('does not write checkpoint on first HIGH tick (hysteresis)', () => {
    const gf = 'hyst-test';
    fs.mkdirSync(path.join(GROUPS_DIR, gf), { recursive: true });

    const hb = startHeartbeat({
      getActiveGroups: () => makeGroups([
        { jid: 'g1@g.us', groupFolder: gf, active: true, transcriptSizeBytes: 600_000 },
      ]),
      intervalMs: 60_000,
    });

    // First tick: HIGH but hysteresis prevents action
    expect(fs.existsSync(path.join(GROUPS_DIR, gf, 'CONTINUE.md'))).toBe(false);
    hb.stop();
  });

  it('resets hysteresis counter when status changes', () => {
    const gf = 'hyst-reset';
    fs.mkdirSync(path.join(GROUPS_DIR, gf), { recursive: true });

    // Start with HIGH transcript
    let transcriptSize = 600_000;
    const hb = startHeartbeat({
      getActiveGroups: () => makeGroups([
        { jid: 'g1@g.us', groupFolder: gf, active: true, transcriptSizeBytes: transcriptSize },
      ]),
      intervalMs: 60_000,
    });

    // Tick 1: HIGH (count = 1)
    expect(readSnapshot().groups[0].status).toBe('high');
    expect(fs.existsSync(path.join(GROUPS_DIR, gf, 'CONTINUE.md'))).toBe(false);

    // Drop below threshold — status changes to filling, resets counter
    transcriptSize = 400_000;
    const sessDir = path.join(DATA_DIR, 'sessions', gf, '.claude', 'projects', 'test-project');
    fs.writeFileSync(path.join(sessDir, 'session.jsonl'), 'x'.repeat(transcriptSize));
    vi.advanceTimersByTime(60_000);
    expect(readSnapshot().groups[0].status).toBe('filling');

    // Go back to HIGH — counter resets to 1
    transcriptSize = 600_000;
    fs.writeFileSync(path.join(sessDir, 'session.jsonl'), 'x'.repeat(transcriptSize));
    vi.advanceTimersByTime(60_000);
    expect(readSnapshot().groups[0].status).toBe('high');
    expect(fs.existsSync(path.join(GROUPS_DIR, gf, 'CONTINUE.md'))).toBe(false); // Still no checkpoint (count = 1)

    // Second consecutive HIGH — now writes
    vi.advanceTimersByTime(60_000);
    expect(fs.existsSync(path.join(GROUPS_DIR, gf, 'CONTINUE.md'))).toBe(true);

    hb.stop();
  });

  // -----------------------------------------------------------------------
  // Process health
  // -----------------------------------------------------------------------

  it('detects dead container processes', () => {
    const hb = startHeartbeat({
      getActiveGroups: () => makeGroups([
        { jid: 'g1@g.us', groupFolder: 'dead', active: true, processAlive: false },
      ]),
      intervalMs: 60_000,
    });

    expect(readSnapshot().systemHealthy).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ groupFolder: 'dead' }),
      expect.stringContaining('DEAD'),
    );
    hb.stop();
  });

  it('skips inactive groups', () => {
    const hb = startHeartbeat({
      getActiveGroups: () => makeGroups([
        { jid: 'g1@g.us', groupFolder: 'inactive', active: false },
      ]),
      intervalMs: 60_000,
    });

    const s = readSnapshot();
    expect(s.totalActiveContainers).toBe(0);
    expect(s.groups).toHaveLength(0);
    hb.stop();
  });

  it('skips groups with null groupFolder', () => {
    const map = new Map();
    map.set('g1@g.us', {
      active: true,
      process: null,
      containerName: 'test-container',
      groupFolder: null,
    });

    const hb = startHeartbeat({
      getActiveGroups: () => map,
      intervalMs: 60_000,
    });

    const s = readSnapshot();
    expect(s.totalActiveContainers).toBe(0);
    expect(s.groups).toHaveLength(0);
    hb.stop();
  });

  // -----------------------------------------------------------------------
  // Interval and lifecycle
  // -----------------------------------------------------------------------

  it('runs on interval', () => {
    const getActive = vi.fn(() => makeGroups([
      { jid: 'g1@g.us', groupFolder: 'ticker', active: true, transcriptSizeBytes: 100 },
    ]));

    const hb = startHeartbeat({ getActiveGroups: getActive, intervalMs: 60_000 });

    expect(getActive).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(getActive).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60_000);
    expect(getActive).toHaveBeenCalledTimes(3);
    hb.stop();
  });

  it('maintains health history ring buffer', () => {
    const hb = startHeartbeat({
      getActiveGroups: () => makeGroups([
        { jid: 'g1@g.us', groupFolder: 'hist', active: true, transcriptSizeBytes: 100 },
      ]),
      intervalMs: 1_000,
    });

    for (let i = 0; i < 4; i++) vi.advanceTimersByTime(1_000);

    const history = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, 'health', 'history.json'), 'utf-8'),
    );
    expect(history).toHaveLength(5); // 1 immediate + 4 ticks
    hb.stop();
  });

  // -----------------------------------------------------------------------
  // Multi-group
  // -----------------------------------------------------------------------

  it('handles multiple active groups simultaneously', () => {
    fs.mkdirSync(path.join(GROUPS_DIR, 'group-b'), { recursive: true });

    const hb = startHeartbeat({
      getActiveGroups: () => makeGroups([
        { jid: 'g1@g.us', groupFolder: 'group-a', active: true, transcriptSizeBytes: 10_000 },
        { jid: 'g2@g.us', groupFolder: 'group-b', active: true, transcriptSizeBytes: 600_000 },
        { jid: 'g3@g.us', groupFolder: 'group-c', active: false },
      ]),
      intervalMs: 60_000,
    });

    const s = readSnapshot();
    expect(s.totalActiveContainers).toBe(2);
    expect(s.groups).toHaveLength(2);

    const gA = s.groups.find((g: { groupFolder: string }) => g.groupFolder === 'group-a');
    const gB = s.groups.find((g: { groupFolder: string }) => g.groupFolder === 'group-b');
    expect(gA!.status).toBe('healthy');
    expect(gB!.status).toBe('high');
    hb.stop();
  });

  // -----------------------------------------------------------------------
  // Cooldown behavior
  // -----------------------------------------------------------------------

  it('does not spam checkpoints within cooldown period', () => {
    const gf = 'cooldown-check';
    fs.mkdirSync(path.join(GROUPS_DIR, gf), { recursive: true });

    const hb = startHeartbeat({
      getActiveGroups: () => makeGroups([
        { jid: 'g1@g.us', groupFolder: gf, active: true, transcriptSizeBytes: 600_000 },
      ]),
      intervalMs: 60_000,
    });

    // First tick: HIGH but hysteresis blocks (need 2 ticks)
    expect(fs.existsSync(path.join(GROUPS_DIR, gf, 'CONTINUE.md'))).toBe(false);

    // Second tick: hysteresis satisfied, checkpoint written
    vi.advanceTimersByTime(60_000);
    expect(fs.existsSync(path.join(GROUPS_DIR, gf, 'CONTINUE.md'))).toBe(true);
    const mtime1 = fs.statSync(path.join(GROUPS_DIR, gf, 'CONTINUE.md')).mtimeMs;

    // Third tick (1 minute later) — should be on cooldown (5 min cooldown)
    vi.advanceTimersByTime(60_000);
    const mtime2 = fs.statSync(path.join(GROUPS_DIR, gf, 'CONTINUE.md')).mtimeMs;
    expect(mtime2).toBe(mtime1); // File not overwritten

    // After cooldown expires (5 min from last checkpoint)
    vi.advanceTimersByTime(5 * 60_000);
    const mtime3 = fs.statSync(path.join(GROUPS_DIR, gf, 'CONTINUE.md')).mtimeMs;
    expect(mtime3).toBeGreaterThan(mtime1); // New checkpoint written

    hb.stop();
  });

  it('does not spam resets within cooldown period', () => {
    const gf = 'cooldown-reset';
    fs.mkdirSync(path.join(GROUPS_DIR, gf), { recursive: true });
    fs.mkdirSync(path.join(DATA_DIR, 'ipc', gf, 'tasks'), { recursive: true });

    const hb = startHeartbeat({
      getActiveGroups: () => makeGroups([
        { jid: 'g1@g.us', groupFolder: gf, active: true, transcriptSizeBytes: 800_000 },
      ]),
      intervalMs: 60_000,
    });

    // First tick: CRITICAL → immediate reset signal
    const ipcDir = path.join(DATA_DIR, 'ipc', gf, 'tasks');
    const count1 = fs.readdirSync(ipcDir).filter(f => f.endsWith('.json')).length;
    expect(count1).toBe(1);

    // Second tick: still CRITICAL but on cooldown (10 min cooldown)
    vi.advanceTimersByTime(60_000);
    const count2 = fs.readdirSync(ipcDir).filter(f => f.endsWith('.json')).length;
    expect(count2).toBe(1); // No additional reset signal

    // After cooldown expires (10 min)
    vi.advanceTimersByTime(10 * 60_000);
    const count3 = fs.readdirSync(ipcDir).filter(f => f.endsWith('.json')).length;
    expect(count3).toBe(2); // Second reset signal written

    hb.stop();
  });

  it('only logs warning on status transition, not every tick', () => {
    const gf = 'transition-log';
    fs.mkdirSync(path.join(GROUPS_DIR, gf), { recursive: true });

    const hb = startHeartbeat({
      getActiveGroups: () => makeGroups([
        { jid: 'g1@g.us', groupFolder: gf, active: true, transcriptSizeBytes: 600_000 },
      ]),
      intervalMs: 60_000,
    });

    // First tick: transition to HIGH → should log (even though hysteresis blocks action)
    const warnCalls1 = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('HIGH'),
    );
    expect(warnCalls1).toHaveLength(1);

    // Second tick: still HIGH → should NOT log again
    vi.advanceTimersByTime(60_000);
    const warnCalls2 = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('HIGH'),
    );
    expect(warnCalls2).toHaveLength(1); // Still just 1

    hb.stop();
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  it('handles errors gracefully without crashing', () => {
    const getActive = vi.fn(() => {
      throw new Error('Simulated failure');
    });

    const hb = startHeartbeat({
      getActiveGroups: getActive as unknown as () => Map<string, never>,
      intervalMs: 60_000,
    });

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('Heartbeat tick failed'),
    );

    vi.advanceTimersByTime(60_000);
    expect(getActive).toHaveBeenCalledTimes(2); // Continues after error
    hb.stop();
  });

  it('handles missing sessions directory gracefully', () => {
    const hb = startHeartbeat({
      getActiveGroups: () => makeGroups([
        { jid: 'g1@g.us', groupFolder: 'no-sessions', active: true },
      ]),
      intervalMs: 60_000,
    });

    const s = readSnapshot();
    expect(s.groups[0].transcriptSizeKB).toBe(0);
    expect(s.groups[0].percentUsed).toBe(0);
    expect(s.groups[0].status).toBe('healthy');
    hb.stop();
  });

  it('recovers from corrupted history.json', () => {
    // Write corrupted JSON to history file
    fs.writeFileSync(
      path.join(DATA_DIR, 'health', 'history.json'),
      '{"not": "an array"}',
    );

    const hb = startHeartbeat({
      getActiveGroups: () => makeGroups([
        { jid: 'g1@g.us', groupFolder: 'corrupt', active: true, transcriptSizeBytes: 100 },
      ]),
      intervalMs: 60_000,
    });

    // Should recover and write valid history
    const history = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, 'health', 'history.json'), 'utf-8'),
    );
    expect(Array.isArray(history)).toBe(true);
    expect(history).toHaveLength(1);
    hb.stop();
  });

  it('handles subagents directory in transcript measurement', () => {
    const gf = 'subagent-test';
    const sessDir = path.join(
      DATA_DIR, 'sessions', gf, '.claude', 'projects', 'test-project',
    );
    const subagentsDir = path.join(sessDir, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, 'main.jsonl'), 'x'.repeat(10_000));
    fs.writeFileSync(path.join(subagentsDir, 'sub1.jsonl'), 'x'.repeat(5_000));
    fs.writeFileSync(path.join(subagentsDir, 'sub2.jsonl'), 'x'.repeat(5_000));

    const hb = startHeartbeat({
      getActiveGroups: () => makeGroups([
        { jid: 'g1@g.us', groupFolder: gf, active: true },
      ]),
      intervalMs: 60_000,
    });

    const s = readSnapshot();
    // Total: 10KB + 5KB + 5KB = 20KB
    expect(s.groups[0].transcriptSizeKB).toBeGreaterThanOrEqual(19); // ~20KB
    hb.stop();
  });

  // -----------------------------------------------------------------------
  // Integration features
  // -----------------------------------------------------------------------

  it('includes SPEC_TRACKER.md in checkpoint when available', () => {
    const gf = 'spec-group';
    fs.mkdirSync(path.join(GROUPS_DIR, gf), { recursive: true });
    fs.writeFileSync(
      path.join(GROUPS_DIR, gf, 'SPEC_TRACKER.md'),
      '# Feature Tracker\n- [x] Feature 1\n- [ ] Feature 2',
    );

    const hb = startHeartbeat({
      getActiveGroups: () => makeGroups([
        { jid: 'g1@g.us', groupFolder: gf, active: true, transcriptSizeBytes: 600_000 },
      ]),
      intervalMs: 60_000,
    });

    // Wait for hysteresis (2 ticks for HIGH)
    vi.advanceTimersByTime(60_000);

    const content = fs.readFileSync(path.join(GROUPS_DIR, gf, 'CONTINUE.md'), 'utf-8');
    expect(content).toContain('Feature 1');
    expect(content).toContain('Feature 2');
    expect(content).toContain('Auto-saved by Heartbeat Service');
    expect(content).toContain('Expires:');
    hb.stop();
  });

  it('uses atomic writes (temp + rename) for health logs', () => {
    const hb = startHeartbeat({
      getActiveGroups: () => makeGroups([
        { jid: 'g1@g.us', groupFolder: 'atomic', active: true, transcriptSizeBytes: 100 },
      ]),
      intervalMs: 60_000,
    });

    // No .tmp files should remain after write
    const healthFiles = fs.readdirSync(path.join(DATA_DIR, 'health'));
    const tmpFiles = healthFiles.filter(f => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
    hb.stop();
  });

  it('_resetState clears all module-level tracking', () => {
    const gf = 'reset-state';
    fs.mkdirSync(path.join(GROUPS_DIR, gf), { recursive: true });

    // Run heartbeat to populate state maps
    const hb1 = startHeartbeat({
      getActiveGroups: () => makeGroups([
        { jid: 'g1@g.us', groupFolder: gf, active: true, transcriptSizeBytes: 800_000 },
      ]),
      intervalMs: 60_000,
    });
    hb1.stop();

    // Reset all state
    _resetState();

    // After reset, a new heartbeat should act as if it's the first time
    // (no previous status tracked = logs transition warning again)
    vi.clearAllMocks();
    const hb2 = startHeartbeat({
      getActiveGroups: () => makeGroups([
        { jid: 'g1@g.us', groupFolder: gf, active: true, transcriptSizeBytes: 800_000 },
      ]),
      intervalMs: 60_000,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ groupFolder: gf }),
      expect.stringContaining('CRITICAL'),
    );
    hb2.stop();
  });

  // -----------------------------------------------------------------------
  // Boundary conditions
  // -----------------------------------------------------------------------

  it('handles exact boundary at 40% (healthy/filling)', () => {
    // 40% of 200K tokens = 80K tokens * 4 chars = 320KB
    const hb = startHeartbeat({
      getActiveGroups: () => makeGroups([
        { jid: 'g1@g.us', groupFolder: 'boundary-40', active: true, transcriptSizeBytes: 320_000 },
      ]),
      intervalMs: 60_000,
    });

    // 320KB / 4 = 80K tokens / 200K = 40% → "filling" (>= boundary)
    expect(readSnapshot().groups[0].status).toBe('filling');
    hb.stop();
  });

  it('handles exact boundary at 65% (filling/high)', () => {
    // 65% of 200K tokens = 130K tokens * 4 chars = 520KB
    const hb = startHeartbeat({
      getActiveGroups: () => makeGroups([
        { jid: 'g1@g.us', groupFolder: 'boundary-65', active: true, transcriptSizeBytes: 520_000 },
      ]),
      intervalMs: 60_000,
    });

    expect(readSnapshot().groups[0].status).toBe('high');
    hb.stop();
  });

  it('handles exact boundary at 85% (high/critical)', () => {
    // 85% of 200K tokens = 170K tokens * 4 chars = 680KB
    const hb = startHeartbeat({
      getActiveGroups: () => makeGroups([
        { jid: 'g1@g.us', groupFolder: 'boundary-85', active: true, transcriptSizeBytes: 680_000 },
      ]),
      intervalMs: 60_000,
    });

    expect(readSnapshot().groups[0].status).toBe('critical');
    hb.stop();
  });

  it('handles zero-size transcript', () => {
    const hb = startHeartbeat({
      getActiveGroups: () => makeGroups([
        { jid: 'g1@g.us', groupFolder: 'empty', active: true, transcriptSizeBytes: 0 },
      ]),
      intervalMs: 60_000,
    });

    const s = readSnapshot();
    expect(s.groups[0].percentUsed).toBe(0);
    expect(s.groups[0].estimatedTokens).toBe(0);
    expect(s.groups[0].status).toBe('healthy');
    hb.stop();
  });

  it('handles empty groups map', () => {
    const hb = startHeartbeat({
      getActiveGroups: () => new Map(),
      intervalMs: 60_000,
    });

    const s = readSnapshot();
    expect(s.totalActiveContainers).toBe(0);
    expect(s.groups).toHaveLength(0);
    expect(s.systemHealthy).toBe(true);
    hb.stop();
  });

  // -----------------------------------------------------------------------
  // Action log
  // -----------------------------------------------------------------------

  it('writes action log for CRITICAL (force-reset)', () => {
    const gf = 'action-critical';
    fs.mkdirSync(path.join(GROUPS_DIR, gf), { recursive: true });
    fs.mkdirSync(path.join(DATA_DIR, 'ipc', gf, 'tasks'), { recursive: true });

    const hb = startHeartbeat({
      getActiveGroups: () => makeGroups([
        { jid: 'g1@g.us', groupFolder: gf, active: true, transcriptSizeBytes: 800_000 },
      ]),
      intervalMs: 60_000,
    });

    const logPath = path.join(DATA_DIR, 'health', 'actions', `${gf}.jsonl`);
    expect(fs.existsSync(logPath)).toBe(true);
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.action).toBe('force-reset');
    expect(entry.status).toBe('critical');
    expect(entry.result).toBe('executed');
    expect(entry.groupFolder).toBe(gf);
    hb.stop();
  });

  it('writes action log with hysteresis result for first HIGH tick', () => {
    const gf = 'action-hyst';
    fs.mkdirSync(path.join(GROUPS_DIR, gf), { recursive: true });

    const hb = startHeartbeat({
      getActiveGroups: () => makeGroups([
        { jid: 'g1@g.us', groupFolder: gf, active: true, transcriptSizeBytes: 600_000 },
      ]),
      intervalMs: 60_000,
    });

    const logPath = path.join(DATA_DIR, 'health', 'actions', `${gf}.jsonl`);
    expect(fs.existsSync(logPath)).toBe(true);
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(lines[0]);
    expect(entry.action).toBe('checkpoint');
    expect(entry.result).toBe('hysteresis');
    expect(entry.detail).toContain('1/2');

    // Second tick: should now be 'executed'
    vi.advanceTimersByTime(60_000);
    const lines2 = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    const entry2 = JSON.parse(lines2[lines2.length - 1]);
    expect(entry2.result).toBe('executed');
    hb.stop();
  });

  it('writes action log with cooldown result when checkpoint is on cooldown', () => {
    const gf = 'action-cd';
    fs.mkdirSync(path.join(GROUPS_DIR, gf), { recursive: true });

    const hb = startHeartbeat({
      getActiveGroups: () => makeGroups([
        { jid: 'g1@g.us', groupFolder: gf, active: true, transcriptSizeBytes: 600_000 },
      ]),
      intervalMs: 60_000,
    });

    // Tick 1: hysteresis
    // Tick 2: executed (checkpoint written)
    vi.advanceTimersByTime(60_000);
    // Tick 3: cooldown (within 5 min)
    vi.advanceTimersByTime(60_000);

    const logPath = path.join(DATA_DIR, 'health', 'actions', `${gf}.jsonl`);
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    const lastEntry = JSON.parse(lines[lines.length - 1]);
    expect(lastEntry.result).toBe('cooldown');
    hb.stop();
  });
});
