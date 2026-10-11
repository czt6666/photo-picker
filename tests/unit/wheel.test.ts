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

/** 模拟触控板：每 16ms 一个事件 */
function stream(deltas: number[], t0 = 0): WheelSample[] {
  return deltas.map((d, i) => ev(t0 + (i + 1) * 16, d));
}

describe('WheelStepper：鼠标滚轮', () => {
  it('滚一格翻一张，零延迟', () => {
    const s = new WheelStepper();
    expect(s.feed(ev(1000, 4))).toBe(1);
  });

  it('macOS 慢转滚轮（每格只报 4px）：一格一张，一格不丢', () => {
    // 旧实现把这种小 delta 当成触控板，连着转 3 格以上就判成“惯性”，后面全被吞掉
    const s = new WheelStepper();
    const evs = [0, 150, 300, 450, 600, 750].map((t) => ev(t, 4));
    expect(run(s, evs)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('手快甩一下（3 格挤在 70ms 内）→ 不会连翻 3 张', () => {
    const s = new WheelStepper();
    const evs = [0, 35, 70].map((t) => ev(t, 8));
    expect(run(s, evs)).toEqual([1]);
  });

  it('macOS 滚轮加速报出的超大 delta 不会一下翻好几张', () => {
    const s = new WheelStepper();
    const evs = [0, 20, 40, 60, 80].map((t, i) => ev(t, [40, 200, 600, 900, 900][i]));
    expect(run(s, evs).length).toBeLessThanOrEqual(2);
  });

  it('一直猛转（每格 45ms）→ 稳定地翻，速度有上限', () => {
    const s = new WheelStepper();
    const evs = Array.from({ length: 22 }, (_, i) => ev(i * 45, 40)); // 约 1 秒
    const n = run(s, evs).length;
    expect(n).toBeGreaterThanOrEqual(6);
    expect(n).toBeLessThanOrEqual(12);
  });

  it('按行滚动（deltaMode=1）也认作滚轮格', () => {
    const s = new WheelStepper();
    const evs = [0, 100, 200].map((t) => ev(t, -3, { deltaMode: 1 }));
    expect(run(s, evs)).toEqual([-1, -1, -1]);
  });
});

describe('WheelStepper：触控板', () => {
  it('手势开头立即翻一张', () => {
    const s = new WheelStepper();
    expect(s.feed(ev(0, 2))).toBe(1);
  });

  it('轻扫 + 惯性 → 一两张，不会飞', () => {
    const s = new WheelStepper();
    const deltas = [3, 8, 15, 22, 25, 24, 20, 18, 15, 12];
    for (let d = 11; d >= 1; d *= 0.92) deltas.push(Math.round(d)); // 惯性：接着手指的速度逐渐衰减，约 0.5 秒
    const steps = run(s, stream(deltas));
    expect(steps.length).toBeGreaterThanOrEqual(1);
    expect(steps.length).toBeLessThanOrEqual(2);
    expect(steps.every((x) => x === 1)).toBe(true);
  });

  it('手指一直匀速推（delta 不变）→ 能连续翻，不会停住', () => {
    // 旧实现把连续 3 个“不变大”的 delta 判成惯性，匀速推着推着就不翻了
    const s = new WheelStepper();
    const steps = run(s, stream(new Array(60).fill(8))); // 约 1 秒、480px
    expect(steps.length).toBeGreaterThanOrEqual(4);
    expect(steps.length).toBeLessThanOrEqual(6);
  });

  it('手指时快时慢地推 → 一直在翻', () => {
    const s = new WheelStepper();
    const deltas: number[] = [];
    for (let i = 0; i < 90; i++) deltas.push(6 + Math.round(5 * Math.sin(i / 4))); // 1.5 秒，忽快忽慢
    const steps = run(s, stream(deltas));
    expect(steps.length).toBeGreaterThanOrEqual(6);
    // 后半段也在翻（没有被误判成惯性而卡住）
    const late = stream(deltas).map((e) => e.timeStamp);
    const s2 = new WheelStepper();
    const stepTimes = stream(deltas)
      .map((e) => [e.timeStamp, s2.feed(e)] as const)
      .filter(([, x]) => x !== 0)
      .map(([t]) => t);
    expect(stepTimes.some((t) => t > late[late.length - 1] * 0.75)).toBe(true);
  });

  it('慢推比快推翻得少：速度跟着手走', () => {
    const slow = run(new WheelStepper(), stream(new Array(60).fill(4))).length;
    const fast = run(new WheelStepper(), stream(new Array(60).fill(20))).length;
    expect(fast).toBeGreaterThan(slow * 2);
    expect(fast).toBeLessThanOrEqual(15); // 上限：每 70ms 最多一张
  });

  it('手一停，多余的距离不会接着翻', () => {
    const s = new WheelStepper();
    // 很快地推 10 帧（每帧 60px），然后停
    const steps = run(s, stream(new Array(10).fill(60)));
    expect(steps.length).toBeLessThanOrEqual(3);
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
