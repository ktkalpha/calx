import type { PlotSpec, Series } from "./kernel/protocol";

export interface Rect {
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
}

type Resampler = (ids: string[], view: Rect, n: number) => Promise<Series[]>;

const AXIS = "#3a463d";
const GRID = "#18201a";
const GRID_MAJOR = "#1f2921";
const LABEL = "#5f6e63";
const FONT = '11px "JetBrains Mono", "SF Mono", Menlo, monospace';

/** Canvas graph with pan/zoom. Dynamic series are re-sampled by the kernel as the view moves. */
export class Graph {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private w = 0;
  private h = 0;
  private series: Series[] = [];
  private view: Rect = { xmin: -10, xmax: 10, ymin: -6, ymax: 6 };
  private home: Rect = { ...this.view };
  private pendingSpec: PlotSpec | null = null;
  private hover: { x: number; y: number } | null = null;
  private inflight = false;
  private again = false;
  private timer = 0;
  plot: PlotSpec | null = null;

  constructor(
    private host: HTMLElement,
    private canvas: HTMLCanvasElement,
    private resample: Resampler,
    private onHover: (text: string) => void,
  ) {
    this.ctx = canvas.getContext("2d")!;
    new ResizeObserver(() => this.resize()).observe(host);
    this.bindPointer();
    this.resize();
  }

  show(spec: PlotSpec) {
    if (this.w === 0) {
      this.pendingSpec = spec;
      return;
    }
    if (spec.hold && this.plot) {
      const ids = new Set(spec.series.map((s) => s.id));
      this.series = [...this.series.filter((s) => !ids.has(s.id)), ...spec.series];
      this.plot = { ...this.plot, series: this.series, title: `${this.plot.title}, ${spec.title}` };
    } else {
      this.plot = spec;
      this.series = spec.series.slice();
      this.home = this.fitView(spec);
      this.view = { ...this.home };
    }
    this.host.classList.add("has-plot");
    this.draw();
    this.scheduleResample(0);
  }

  clear() {
    this.plot = null;
    this.series = [];
    this.host.classList.remove("has-plot");
    this.draw();
  }

  reset() {
    this.view = { ...this.home };
    this.changed();
  }

  zoom(factor: number, cx = this.w / 2, cy = this.h / 2) {
    const { xmin, xmax, ymin, ymax } = this.view;
    const px = xmin + (cx / this.w) * (xmax - xmin);
    const py = ymax - (cy / this.h) * (ymax - ymin);
    this.view = {
      xmin: px - (px - xmin) * factor,
      xmax: px + (xmax - px) * factor,
      ymin: py - (py - ymin) * factor,
      ymax: py + (ymax - py) * factor,
    };
    this.changed();
  }

  // ── view fitting ─────────────────────────────────────────────────────

  private fitView(spec: PlotSpec): Rect {
    const { xmin, xmax } = spec.view;
    const aspect = this.h / this.w;
    if (spec.view.ymin != null && spec.view.ymax != null) {
      return { xmin, xmax, ymin: spec.view.ymin, ymax: spec.view.ymax };
    }
    const fns = spec.series.filter((s) => s.kind === "fn");
    if (fns.length) {
      const ys = fns.flatMap((s) => (s.ys ?? []).filter((v): v is number => v != null && isFinite(v)));
      const half = ((xmax - xmin) * aspect) / 2;
      if (!ys.length) return { xmin, xmax, ymin: -half, ymax: half };
      ys.sort((a, b) => a - b);
      const lo = ys[Math.floor(ys.length * 0.02)];
      const hi = ys[Math.ceil(ys.length * 0.98) - 1];
      if (lo >= -half * 0.9 && hi <= half * 0.9) return { xmin, xmax, ymin: -half, ymax: half };
      const pad = (hi - lo || 2) * 0.12;
      return { xmin, xmax, ymin: lo - pad, ymax: hi + pad };
    }
    // implicit / parametric / data: fit the points, equal aspect except for raw data
    const pts = spec.series.flatMap((s) => pointsOf(s));
    if (!pts.length) {
      const half = ((xmax - xmin) * aspect) / 2;
      return { xmin, xmax, ymin: -half, ymax: half };
    }
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [px, py] of pts) {
      x0 = Math.min(x0, px); x1 = Math.max(x1, px);
      y0 = Math.min(y0, py); y1 = Math.max(y1, py);
    }
    const padX = (x1 - x0 || 2) * 0.15, padY = (y1 - y0 || 2) * 0.15;
    let r = { xmin: x0 - padX, xmax: x1 + padX, ymin: y0 - padY, ymax: y1 + padY };
    if (spec.series.every((s) => s.kind !== "data")) r = equalAspect(r, aspect);
    return r;
  }

  // ── sampling ─────────────────────────────────────────────────────────

  private changed() {
    this.draw();
    this.scheduleResample(40);
  }

  private scheduleResample(delay: number) {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.doResample(), delay);
  }

  private async doResample() {
    const ids = this.series.filter((s) => s.dynamic).map((s) => s.id);
    if (!ids.length) return;
    if (this.inflight) {
      this.again = true;
      return;
    }
    this.inflight = true;
    try {
      const fresh = await this.resample(ids, { ...this.view }, Math.min(1600, Math.max(400, this.w)));
      const byId = new Map(fresh.map((s) => [s.id, s]));
      this.series = this.series.map((s) => {
        const f = byId.get(s.id);
        return f ? { ...s, xs: f.xs, ys: f.ys, segs: f.segs } : s;
      });
      this.draw();
    } finally {
      this.inflight = false;
      if (this.again) {
        this.again = false;
        this.scheduleResample(0);
      }
    }
  }

  // ── input ────────────────────────────────────────────────────────────

  private bindPointer() {
    const c = this.canvas;
    let drag: { x: number; y: number; view: Rect } | null = null;
    c.addEventListener("pointerdown", (e) => {
      drag = { x: e.offsetX, y: e.offsetY, view: { ...this.view } };
      c.setPointerCapture(e.pointerId);
      c.classList.add("panning");
    });
    c.addEventListener("pointermove", (e) => {
      if (drag) {
        const dx = ((e.offsetX - drag.x) / this.w) * (drag.view.xmax - drag.view.xmin);
        const dy = ((e.offsetY - drag.y) / this.h) * (drag.view.ymax - drag.view.ymin);
        this.view = {
          xmin: drag.view.xmin - dx,
          xmax: drag.view.xmax - dx,
          ymin: drag.view.ymin + dy,
          ymax: drag.view.ymax + dy,
        };
        this.hover = null;
        this.changed();
      } else {
        this.hover = { x: e.offsetX, y: e.offsetY };
        this.draw();
      }
    });
    const end = (e: PointerEvent) => {
      drag = null;
      c.releasePointerCapture(e.pointerId);
      c.classList.remove("panning");
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    c.addEventListener("pointerleave", () => {
      this.hover = null;
      this.onHover("");
      this.draw();
    });
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const speed = e.ctrlKey ? 0.01 : 0.0015; // ctrlKey = trackpad pinch
        this.zoom(Math.exp(e.deltaY * speed), e.offsetX, e.offsetY);
      },
      { passive: false },
    );
    c.addEventListener("dblclick", () => this.reset());
  }

  private resize() {
    const r = this.host.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const firstSize = this.w === 0;
    const prevH = this.h;
    this.dpr = window.devicePixelRatio || 1;
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    if (firstSize && this.pendingSpec) {
      const spec = this.pendingSpec;
      this.pendingSpec = null;
      this.show(spec);
      return;
    }
    if (!firstSize && prevH) {
      // keep the scale stable when the pane height changes
      const scale = (this.view.ymax - this.view.ymin) / prevH;
      const mid = (this.view.ymax + this.view.ymin) / 2;
      this.view.ymin = mid - (scale * this.h) / 2;
      this.view.ymax = mid + (scale * this.h) / 2;
    }
    this.draw();
  }

  // ── drawing ──────────────────────────────────────────────────────────

  private sx = (x: number) => ((x - this.view.xmin) / (this.view.xmax - this.view.xmin)) * this.w;
  private sy = (y: number) => this.h - ((y - this.view.ymin) / (this.view.ymax - this.view.ymin)) * this.h;

  draw() {
    const { ctx, w, h } = this;
    if (!w) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    this.drawGrid();
    for (const s of this.series) this.drawSeries(s);
    this.drawLegend();
    this.drawHover();
  }

  private drawGrid() {
    const { ctx, w, h, view } = this;
    const xs = niceStep((view.xmax - view.xmin) / Math.max(2, w / 90));
    const ys = niceStep((view.ymax - view.ymin) / Math.max(2, h / 70));

    ctx.lineWidth = 1;
    for (const [step, color] of [[xs / 5, GRID], [xs, GRID_MAJOR]] as const) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (let x = Math.ceil(view.xmin / step) * step; x <= view.xmax; x += step) {
        const px = Math.round(this.sx(x)) + 0.5;
        ctx.moveTo(px, 0);
        ctx.lineTo(px, h);
      }
      ctx.stroke();
    }
    for (const [step, color] of [[ys / 5, GRID], [ys, GRID_MAJOR]] as const) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (let y = Math.ceil(view.ymin / step) * step; y <= view.ymax; y += step) {
        const py = Math.round(this.sy(y)) + 0.5;
        ctx.moveTo(0, py);
        ctx.lineTo(w, py);
      }
      ctx.stroke();
    }

    const ax = clamp(Math.round(this.sx(0)) + 0.5, 0.5, w - 0.5);
    const ay = clamp(Math.round(this.sy(0)) + 0.5, 0.5, h - 0.5);
    ctx.strokeStyle = AXIS;
    ctx.beginPath();
    ctx.moveTo(ax, 0); ctx.lineTo(ax, h);
    ctx.moveTo(0, ay); ctx.lineTo(w, ay);
    ctx.stroke();

    ctx.font = FONT;
    ctx.fillStyle = LABEL;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const labelY = clamp(ay + 4, 4, h - 16);
    for (let x = Math.ceil(view.xmin / xs) * xs; x <= view.xmax; x += xs) {
      if (Math.abs(x) < xs / 2) continue;
      ctx.fillText(fmtTick(x, xs), this.sx(x), labelY);
    }
    const leftSide = ax > w - 50;
    ctx.textAlign = leftSide ? "right" : "left";
    ctx.textBaseline = "middle";
    const labelX = leftSide ? ax - 5 : clamp(ax + 5, 4, w - 40);
    for (let y = Math.ceil(view.ymin / ys) * ys; y <= view.ymax; y += ys) {
      if (Math.abs(y) < ys / 2) continue;
      ctx.fillText(fmtTick(y, ys), labelX, this.sy(y));
    }
  }

  private drawSeries(s: Series) {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.shadowColor = s.color + "66";
    ctx.shadowBlur = 6;

    if (s.segs) {
      ctx.beginPath();
      const g = s.segs;
      for (let i = 0; i + 3 < g.length; i += 4) {
        ctx.moveTo(this.sx(g[i]), this.sy(g[i + 1]));
        ctx.lineTo(this.sx(g[i + 2]), this.sy(g[i + 3]));
      }
      ctx.stroke();
    } else if (s.xs && s.ys) {
      if (s.style === "points") {
        ctx.shadowBlur = 0;
        for (let i = 0; i < s.xs.length; i++) {
          const x = s.xs[i], y = s.ys[i];
          if (x == null || y == null) continue;
          ctx.beginPath();
          ctx.arc(this.sx(x), this.sy(y), 3, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        const jump = (this.view.ymax - this.view.ymin) * 1.5;
        ctx.beginPath();
        let pen = false;
        let prevY = 0;
        for (let i = 0; i < s.xs.length; i++) {
          const x = s.xs[i], y = s.ys[i];
          if (x == null || y == null) {
            pen = false;
            continue;
          }
          // break the line across asymptotes instead of drawing a vertical spike
          if (pen && s.kind === "fn" && Math.abs(y - prevY) > jump) pen = false;
          const px = this.sx(x), py = clamp(this.sy(y), -1e5, 1e5);
          if (pen) ctx.lineTo(px, py);
          else ctx.moveTo(px, py);
          pen = true;
          prevY = y;
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private drawLegend() {
    if (this.series.length < 2 && !this.series.some((s) => s.kind === "implicit")) return;
    const { ctx } = this;
    ctx.font = FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const rows = this.series.map((s) => truncate(s.label, 36));
    const width = Math.max(...rows.map((r) => ctx.measureText(r).width)) + 34;
    const height = rows.length * 18 + 10;
    ctx.fillStyle = "rgba(11, 14, 12, 0.85)";
    ctx.strokeStyle = "#222a24";
    ctx.fillRect(10, 10, width, height);
    ctx.strokeRect(10.5, 10.5, width, height);
    rows.forEach((label, i) => {
      const y = 24 + i * 18;
      ctx.fillStyle = this.series[i].color;
      ctx.fillRect(20, y - 1, 12, 3);
      ctx.fillStyle = "#c9d4c6";
      ctx.fillText(label, 38, y);
    });
  }

  private drawHover() {
    if (!this.hover) return;
    const { ctx, w, h, view } = this;
    const { x: hx, y: hy } = this.hover;
    const x = view.xmin + (hx / w) * (view.xmax - view.xmin);
    const y = view.ymax - (hy / h) * (view.ymax - view.ymin);
    const prec = niceStep((view.xmax - view.xmin) / w);
    this.onHover(`x ${fmtTick(x, prec / 10)}  y ${fmtTick(y, prec / 10)}`);

    ctx.save();
    ctx.strokeStyle = "#2c372f";
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(hx + 0.5, 0); ctx.lineTo(hx + 0.5, h);
    ctx.moveTo(0, hy + 0.5); ctx.lineTo(w, hy + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    // value markers on y = f(x) curves
    ctx.font = FONT;
    ctx.textBaseline = "bottom";
    for (const s of this.series) {
      if (s.kind !== "fn" || !s.xs || !s.ys) continue;
      const v = interpolate(s.xs, s.ys, x);
      if (v == null) continue;
      const py = this.sy(v);
      if (py < 0 || py > h) continue;
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(hx, py, 4, 0, Math.PI * 2);
      ctx.fill();
      const text = fmtTick(v, prec / 10);
      ctx.textAlign = hx > w - 80 ? "right" : "left";
      ctx.fillText(text, hx + (hx > w - 80 ? -8 : 8), py - 4);
    }
    ctx.restore();
  }
}

function pointsOf(s: Series): [number, number][] {
  const out: [number, number][] = [];
  if (s.segs) for (let i = 0; i + 1 < s.segs.length; i += 2) out.push([s.segs[i], s.segs[i + 1]]);
  if (s.xs && s.ys)
    s.xs.forEach((x, i) => {
      const y = s.ys![i];
      if (x != null && y != null) out.push([x, y]);
    });
  return out;
}

function equalAspect(r: Rect, aspect: number): Rect {
  const cx = (r.xmin + r.xmax) / 2, cy = (r.ymin + r.ymax) / 2;
  let wx = r.xmax - r.xmin, wy = r.ymax - r.ymin;
  if (wy / wx > aspect) wx = wy / aspect;
  else wy = wx * aspect;
  return { xmin: cx - wx / 2, xmax: cx + wx / 2, ymin: cy - wy / 2, ymax: cy + wy / 2 };
}

function interpolate(xs: (number | null)[], ys: (number | null)[], x: number): number | null {
  let lo = 0, hi = xs.length - 1;
  if (hi < 1 || xs[0] == null || xs[hi] == null || x < xs[0]! || x > xs[hi]!) return null;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((xs[mid] ?? 0) <= x) lo = mid;
    else hi = mid;
  }
  const x0 = xs[lo], x1 = xs[hi], y0 = ys[lo], y1 = ys[hi];
  if (x0 == null || x1 == null || y0 == null || y1 == null) return null;
  return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0 || 1);
}

function niceStep(raw: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

function fmtTick(v: number, step: number): string {
  if (Math.abs(v) < step * 1e-6) return "0";
  const abs = Math.abs(v);
  if (abs >= 1e6 || abs < 1e-4) return v.toExponential(2).replace("e+", "e");
  const decimals = Math.max(0, Math.min(10, -Math.floor(Math.log10(step))));
  return v.toFixed(decimals);
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
