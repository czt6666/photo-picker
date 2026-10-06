// 把滚轮/触控板事件翻译成“上一张 / 下一张”。
//
// 难点在于两种设备的事件长得完全不一样：
// - 鼠标滚轮：一格（一个“咔哒”）一个事件，delta 较大，间隔几十毫秒。用户期望一格 = 一张。
// - 触控板：一次滑动产生几十个小 delta 的事件（60~120Hz），手指离开后还有一串逐渐衰减的
//   “惯性”事件。若按事件数翻页，轻轻一划就飞过去二三十张；若简单节流，又会显得迟钝。
//
// 策略：
// 1. 手势开头立即翻一张（不管什么设备，第一下都零延迟响应）；
// 2. 认出是滚轮的格子事件，后续每格翻一张（最短间隔 discreteIntervalMs 防止抖动）；
// 3. 触控板事件累计位移，每满 stepPx 翻一张，且两次翻页至少隔 minIntervalMs；
// 4. 翻页后若 delta 持续单调变小 → 判定为惯性滑行，不再累计，直到用户再次发力或停下。

export interface WheelSample {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  timeStamp: number;
  /** 非标准属性：WebKit/Chromium 上鼠标滚轮每格为 ±120 的倍数 */
  wheelDeltaY?: number;
}

export interface WheelOptions {
  gapMs: number;
  stepPx: number;
  minIntervalMs: number;
  discreteIntervalMs: number;
  /** 连续多少个不增大的 delta 视为惯性 */
  decayEvents: number;
}

const DEFAULTS: WheelOptions = {
  gapMs: 180,
  stepPx: 140,
  minIntervalMs: 110,
  discreteIntervalMs: 30,
  decayEvents: 3,
};

export class WheelStepper {
  private opts: WheelOptions;
  private lastT = -Infinity;
  private lastStepT = -Infinity;
  private dir = 0;
  private acc = 0;
  private prevMag = 0;
  private decay = 0;

  constructor(opts: Partial<WheelOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  reset(): void {
    this.lastT = -Infinity;
    this.dir = 0;
  }

  /** 返回 -1（上一张）、0（不动）、1（下一张） */
  feed(e: WheelSample): -1 | 0 | 1 {
    const o = this.opts;
    let d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (e.deltaMode === 1) d *= 40; // 按行
    else if (e.deltaMode === 2) d *= 800; // 按页
    if (d === 0) return 0;

    const dir = d > 0 ? 1 : -1;
    const mag = Math.abs(d);
    const t = e.timeStamp;
    const gap = t - this.lastT;
    this.lastT = t;

    // 新手势：停顿过，或者换了方向
    if (gap > o.gapMs || dir !== this.dir) {
      this.dir = dir;
      this.acc = 0;
      this.prevMag = mag;
      this.decay = 0;
      this.lastStepT = t;
      return dir;
    }

    if (isDiscrete(e)) {
      if (t - this.lastStepT >= o.discreteIntervalMs) {
        this.lastStepT = t;
        return dir;
      }
      return 0;
    }

    // 触控板：识别惯性
    this.decay = mag <= this.prevMag ? this.decay + 1 : 0;
    this.prevMag = mag;
    if (this.decay >= o.decayEvents) {
      this.acc = 0;
      return 0;
    }
    this.acc += mag;
    if (this.acc >= o.stepPx && t - this.lastStepT >= o.minIntervalMs) {
      this.acc = 0;
      this.lastStepT = t;
      return dir;
    }
    return 0;
  }
}

function isDiscrete(e: WheelSample): boolean {
  if (e.deltaMode !== 0) return true;
  const w = e.wheelDeltaY;
  return typeof w === 'number' && w !== 0 && w % 120 === 0;
}
