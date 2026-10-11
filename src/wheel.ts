// 把滚轮/触控板事件翻译成“上一张 / 下一张”。
//
// 两种设备送来的事件长得完全不一样：
// - 鼠标滚轮：一格（一个“咔哒”）一个事件，事件之间隔几十到几百毫秒。
//   macOS 还会给滚轮加速：转得越快，每格报的 delta 越大（慢转一格 4px，猛转一格能到几百 px）。
// - 触控板：手指在板上时按屏幕刷新率（60~120Hz，即每 8~16ms）连续送来一串小 delta；
//   手指离开后系统继续送一串逐渐变小的“惯性”事件，模拟甩出去的滑行。
//
// 网页里拿不到“这是鼠标还是触控板”的标记（WebKit 不暴露），只能从事件本身判断。
// 最可靠的线索是**事件之间的间隔**：触控板的事件一个紧挨一个（≤16ms，偶尔掉帧 33ms），
// 而鼠标滚轮哪怕连着转，格与格之间通常也隔着几十毫秒以上。
//
// 策略：
// 1. “独立的一下”——距上个事件超过 notchGapMs，或换了方向，或按行/按页滚动：
//    立即翻一张（零延迟），但两次翻页至少隔 notchIntervalMs。
//    效果：慢慢拨一格就是一张；手快一下甩出好几格，多出来的会被吞掉，不再“一不小心飞过去”。
// 2. 连续事件流——按滑动距离翻页，每满 stepPx 翻一张，两次至少隔 streamIntervalMs。
//    手指一直在推就一直翻，速度跟着手走；距离不往后“攒存货”，手一停就停。
// 3. 惯性滑行（delta 连续变小）只按 momentumWeight 折算距离：甩一下会多滑一两张，但不会飞。

export interface WheelSample {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  timeStamp: number;
}

export interface WheelOptions {
  /** 距上个事件超过它 = 一个“独立的一下”（鼠标的一格，或触控板手势的开头） */
  notchGapMs: number;
  /** “独立的一下”之间最短的翻页间隔 */
  notchIntervalMs: number;
  /** 连续事件流里，每滑多少像素翻一张 */
  stepPx: number;
  /** 连续事件流里最短的翻页间隔（≈ 每秒最多翻 1000/它 张） */
  streamIntervalMs: number;
  /** 单个事件最多算多少像素，压住 macOS 滚轮加速报出来的超大 delta */
  maxEventPx: number;
  /** delta 中途不变大、累计变小多少次视为惯性滑行 */
  momentumEvents: number;
  /** 惯性滑行的距离按多少折算 */
  momentumWeight: number;
}

const DEFAULTS: WheelOptions = {
  notchGapMs: 40,
  notchIntervalMs: 90,
  stepPx: 100,
  streamIntervalMs: 70,
  maxEventPx: 60,
  momentumEvents: 5,
  momentumWeight: 0.35,
};

export class WheelStepper {
  private opts: WheelOptions;
  private lastT = -Infinity;
  private lastStepT = -Infinity;
  private dir = 0;
  private acc = 0;
  private prevMag = 0;
  private falling = 0;

  constructor(opts: Partial<WheelOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  reset(): void {
    this.lastT = -Infinity;
    this.lastStepT = -Infinity;
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
    const turned = dir !== this.dir;
    this.dir = dir;

    // 1. 独立的一下
    if (turned || gap >= o.notchGapMs || e.deltaMode !== 0) {
      this.acc = 0;
      this.prevMag = mag;
      this.falling = 0;
      if (turned || t - this.lastStepT >= o.notchIntervalMs) {
        this.lastStepT = t;
        return dir;
      }
      return 0;
    }

    // 2. 连续事件流（触控板，或鼠标转得飞快）
    // 惯性的 delta 只减不增（尾巴上会有几个相等的值）；手指在推时总会时不时变大一下
    if (mag > this.prevMag) this.falling = 0;
    else if (mag < this.prevMag) this.falling++;
    this.prevMag = mag;
    const weight = this.falling >= o.momentumEvents ? o.momentumWeight : 1;
    this.acc = Math.min(o.stepPx, this.acc + Math.min(mag, o.maxEventPx) * weight);
    if (this.acc >= o.stepPx && t - this.lastStepT >= o.streamIntervalMs) {
      this.acc = 0;
      this.lastStepT = t;
      return dir;
    }
    return 0;
  }
}
