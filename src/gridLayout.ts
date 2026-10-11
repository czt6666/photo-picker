// 网格的“分段排版”：连续翻动时几个相册首尾相接，每个相册另起一行，相册之间有一条分界线（带相册名）。
// 纯计算，不碰 DOM，方便单测：给出每段的位置，回答“第 i 张在哪”“这段高度里是哪些照片”“光标往下一行是哪张”。

export interface Section {
  /** 相册路径（Photo.dir） */
  dir: string;
  /** 这一段第一张照片在列表里的下标 */
  start: number;
  count: number;
}

/** 把照片列表按“连续的同一个文件夹”切成段 */
export function splitSections(photos: { dir: string }[]): Section[] {
  const out: Section[] = [];
  for (let i = 0; i < photos.length; i++) {
    const last = out[out.length - 1];
    if (last && last.dir === photos[i].dir) last.count++;
    else out.push({ dir: photos[i].dir, start: i, count: 1 });
  }
  return out;
}

export interface Band extends Section {
  /** 这一段顶部（分界线的上边）的 y */
  top: number;
  /** 分界线高度；没有分界线为 0 */
  head: number;
  rows: number;
}

export interface Metrics {
  cols: number;
  /** 行高（含行间距） */
  rowH: number;
  gap: number;
  pad: number;
  /** 分界线高度 */
  headH: number;
  /** 第一段上面要不要也放一条（看单个相册时不用，顶栏已经写着相册名） */
  headFirst: boolean;
}

export class GridLayout {
  readonly bands: Band[] = [];
  /** 内容总高度 */
  readonly height: number;
  readonly cols: number;
  private rowH: number;

  constructor(sections: Section[], m: Metrics) {
    this.cols = Math.max(1, m.cols);
    this.rowH = m.rowH;
    let y = m.pad;
    sections.forEach((s, k) => {
      const head = k > 0 || m.headFirst ? m.headH : 0;
      const rows = Math.ceil(s.count / this.cols);
      this.bands.push({ ...s, top: y, head, rows });
      y += head + rows * m.rowH;
    });
    this.height = this.bands.length ? y - m.gap + m.pad : 0;
  }

  /** 第 i 张照片所在的段 */
  bandOf(i: number): Band | undefined {
    let lo = 0;
    let hi = this.bands.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.bands[mid].start <= i) lo = mid;
      else hi = mid - 1;
    }
    return this.bands[lo];
  }

  /** 高度 y 落在哪一段（在第一段之上算第一段，超出末尾算最后一段） */
  bandAt(y: number): Band | undefined {
    let lo = 0;
    let hi = this.bands.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.bands[mid].top <= y) lo = mid;
      else hi = mid - 1;
    }
    return this.bands[lo];
  }

  /** 第 i 张照片的位置：段内第几行、第几列，以及格子顶部的 y */
  pos(i: number): { band: Band; row: number; col: number; y: number } | undefined {
    const band = this.bandOf(i);
    if (!band) return undefined;
    const k = i - band.start;
    const row = Math.floor(k / this.cols);
    return { band, row, col: k % this.cols, y: band.top + band.head + row * this.rowH };
  }

  private rowAt(b: Band, y: number): number {
    return Math.max(0, Math.min(b.rows - 1, Math.floor((y - b.top - b.head) / this.rowH)));
  }

  /** 高度 y 处那一行的第一张照片 */
  firstIndexAt(y: number): number {
    const b = this.bandAt(y);
    return b ? b.start + this.rowAt(b, y) * this.cols : 0;
  }

  /** 高度范围 [y0, y1] 里出现的照片下标 [from, to) */
  range(y0: number, y1: number): [number, number] {
    const a = this.bandAt(y0);
    const b = this.bandAt(y1);
    if (!a || !b) return [0, 0];
    const from = a.start + this.rowAt(a, y0) * this.cols;
    // 只露出了分界线、还没露出第一行照片
    const to = y1 < b.top + b.head ? b.start : Math.min(b.start + b.count, b.start + (this.rowAt(b, y1) + 1) * this.cols);
    return [from, Math.max(from, to)];
  }

  /**
   * 键盘光标从第 i 张移动：dx=±1 前后一张，dy=±1 上下一行。
   * 上下跨相册时保持在同一列（那一行没这么多张就落在最后一张）。
   */
  step(i: number, dx: number, dy: number, total: number): number {
    if (total <= 0) return -1;
    if (i < 0) return dx < 0 || dy < 0 ? total - 1 : 0;
    let next = Math.max(0, Math.min(total - 1, i + dx));
    for (let n = Math.abs(dy); n > 0; n--) {
      const p = this.pos(next);
      if (!p) break;
      const b = p.band;
      const k = this.bands.indexOf(b);
      if (dy > 0) {
        if (p.row < b.rows - 1) next = Math.min(b.start + b.count - 1, next + this.cols);
        else if (this.bands[k + 1]) next = this.bands[k + 1].start + Math.min(p.col, this.bands[k + 1].count - 1);
        else next = total - 1;
      } else if (p.row > 0) {
        next -= this.cols;
      } else if (k > 0) {
        const prev = this.bands[k - 1];
        next = Math.min(prev.start + prev.count - 1, prev.start + (prev.rows - 1) * this.cols + p.col);
      } else {
        next = 0;
      }
    }
    return next;
  }
}
