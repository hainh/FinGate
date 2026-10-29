/**
 * Chu kỳ sao lưu trong tiến trình (ADM-14): đúng nhịp, bỏ qua khi DB chưa lên, không chồng lượt,
 * lỗi không làm dừng chu kỳ, và stop() dừng hẳn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startBackupLoop } from './index.ts';

const INTERVAL = 30 * 60_000;
const log = { info: vi.fn(), error: vi.fn() };

describe('startBackupLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    log.info.mockReset();
    log.error.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('chạy task mỗi chu kỳ khi DB đã lên', async () => {
    const task = vi.fn(async () => ({ ok: true }));
    const stop = startBackupLoop(log, { ready: () => true, intervalMs: INTERVAL, task });
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(task).toHaveBeenCalledTimes(3);
    stop();
  });

  it('bỏ qua lượt khi DB chưa lên', async () => {
    const task = vi.fn(async () => ({}));
    const stop = startBackupLoop(log, { ready: () => false, intervalMs: INTERVAL, task });
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(task).not.toHaveBeenCalled();
    stop();
  });

  it('không chồng lượt khi lượt trước chưa xong', async () => {
    let finish!: () => void;
    const task = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const stop = startBackupLoop(log, { ready: () => true, intervalMs: INTERVAL, task });
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(task).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(task).toHaveBeenCalledTimes(2);
    stop();
  });

  it('lỗi được ghi log và chu kỳ vẫn chạy tiếp', async () => {
    const task = vi.fn().mockRejectedValueOnce(new Error('mongodump lỗi')).mockResolvedValue({});
    const stop = startBackupLoop(log, { ready: () => true, intervalMs: INTERVAL, task });
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(task).toHaveBeenCalledTimes(2);
    stop();
  });

  it('stop() dừng hẳn chu kỳ', async () => {
    const task = vi.fn(async () => ({}));
    const stop = startBackupLoop(log, { ready: () => true, intervalMs: INTERVAL, task });
    stop();
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(task).not.toHaveBeenCalled();
  });
});
