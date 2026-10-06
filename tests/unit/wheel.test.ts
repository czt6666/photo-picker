import { describe, expect, it } from 'vitest';
import { WheelStepper, type WheelSample } from '../../src/wheel';

const ev = (t: number, deltaY: number, extra: Partial<WheelSample> = {}): WheelSample => ({
  deltaX: 0,
  deltaY,
  deltaMode: 0,
  timeStamp: t,
  ...extra,
});

function run(s: WheelStepper, events: WheelSample[]): number[] {
  return events.map((e) => s.feed(e)).filter((x) => x !== 0);
}

describe('WheelStepper', () => {
  it('鼠标滚一格翻一张，零延迟', () => {
    const s = new WheelStepper();
    expect(s.feed(ev(1000, 100, { wheelDeltaY: -120 }))).toBe(1);
  });

  it('快速连续滚 5 格 → 翻 5 张', () => {
    const s = new WheelStepper();
    const evs = [0, 45, 90, 135, 180].map((t) => ev(1000 + t, 100, { wheelDeltaY: -120 }));
    expect(run(s, evs)).toEqual([1, 1, 1, 1, 1]);
  });

  it('按行滚动（deltaMode=1）也认作滚轮格', () => {
    const s = new WheelStepper();
    const evs = [0, 50, 100].map((t) => ev(t, -3, { deltaMode: 1 }));
    expect(run(s, evs)).toEqual([-1, -1, -1]);
  });

  it('停顿后的单格总是立即响应', () => {
    const s = new WheelStepper();
    expect(s.feed(ev(0, 4))).toBe(1);
    expect(s.feed(ev(500, 4))).toBe(1);
    expect(s.feed(ev(1000, -4))).toBe(-1);
  });

  it('触控板轻扫 + 惯性衰减 → 只翻 1 张', () => {
    const s = new WheelStepper();
    const evs: WheelSample[] = [];
    let t = 0;
    // 手指滑动：delta 先增后减，共约 200px
    for (const d of [3, 8, 15, 22, 25, 24, 20, 18, 15, 12]) evs.push(ev((t += 16), d));
    // 惯性：指数衰减，持续约 1 秒
    for (let d = 14; d >= 1; d *= 0.9) evs.push(ev((t += 16), Math.round(d)));
    expect(run(s, evs)).toEqual([1]);
  });

  it('触控板持续用力拖动 → 稳定地多翻几张，但不会飞', () => {
    const s = new WheelStepper();
    const evs: WheelSample[] = [];
    let t = 0;
    // 1 秒内来回波动的较大 delta（手指一直在推）
    for (let i = 0; i < 60; i++) evs.push(ev((t += 16), 20 + (i % 3) * 6));
    const steps = run(s, evs);
    expect(steps.length).toBeGreaterThanOrEqual(3);
    expect(steps.length).toBeLessThanOrEqual(9);
  });

  it('换方向立即响应', () => {
    const s = new WheelStepper();
    expect(s.feed(ev(0, 10))).toBe(1);
    expect(s.feed(ev(16, -10))).toBe(-1);
  });

  it('横向滑动也能翻页', () => {
    const s = new WheelStepper();
    expect(s.feed({ deltaX: 30, deltaY: 2, deltaMode: 0, timeStamp: 0 })).toBe(1);
  });
});
