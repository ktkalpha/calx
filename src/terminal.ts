import type { PlotSpec } from "./kernel/protocol";

const HELP = `calx — math scratchpad on a Python kernel

  <k>= expr</k>              evaluate          = sqrt(2) * pi
  <k>= lhs = rhs</k>         solve             = x^2 - 5x + 6 = 0
  <k>= eq1 ; eq2</k>         solve a system    = 2x + y = 7 ; x - y = 2
  <k>~ expr ; expr</k>       plot              ~ sin x ; x^2 + y^2 = 9

  calculator lines accept  ^  for powers, implicit multiplication (2x, sin x), π, √
  everything else is regular Python with sympy imported (x y z t n k a b c are symbols)

  <k>plot(*items, x=(a, b), y=(c, d), hold=True)</k>   functions, "y = ...", implicit,
                                                (fx, fy) parametric, xs, ys data
  <k>scatter(xs, ys)</k>          points
  <k>diff integrate limit series solve factor expand simplify Matrix</k>  — sympy
  <k>import numpy, matplotlib</k>  packages load on first import; plt figures show inline

  editor   ⌘↵ run block   ⇧↵ run line   ⌘⇧↵ run all   ⌘. stop/restart   ⌘K clear
  graph    drag to pan · scroll/pinch to zoom · double-click to reset
  prompt   :help  :clear  :restart  ↑/↓ history`;

/** Scrollback log plus a one-line prompt at the bottom. */
export class Terminal {
  private history: string[] = [];
  private histPos = 0;
  private entries = new Map<number, HTMLElement>();

  constructor(
    private log: HTMLElement,
    private input: HTMLInputElement,
    private onSubmit: (line: string) => void,
    private onPlotClick: (spec: PlotSpec) => void,
  ) {
    try {
      this.history = JSON.parse(localStorage.getItem("calx.history") ?? "[]");
    } catch {
      this.history = [];
    }
    this.histPos = this.history.length;
    input.addEventListener("keydown", (e) => this.key(e));
    log.addEventListener("mouseup", () => {
      if (!window.getSelection()?.toString()) input.focus();
    });
  }

  private key(e: KeyboardEvent) {
    if (e.key === "Enter") {
      const line = this.input.value;
      this.input.value = "";
      if (line.trim()) {
        if (this.history.at(-1) !== line) this.history.push(line);
        this.history = this.history.slice(-500);
        try {
          localStorage.setItem("calx.history", JSON.stringify(this.history));
        } catch { /* storage unavailable */ }
      }
      this.histPos = this.history.length;
      this.onSubmit(line);
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      this.histPos = Math.max(0, Math.min(this.history.length, this.histPos + (e.key === "ArrowUp" ? -1 : 1)));
      this.input.value = this.history[this.histPos] ?? "";
    } else if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      this.clear();
    }
  }

  private stick<T>(fn: () => T): T {
    const atBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 40;
    const r = fn();
    if (atBottom) this.log.scrollTop = this.log.scrollHeight;
    return r;
  }

  begin(id: number, code: string) {
    this.stick(() => {
      const entry = el("div", "entry");
      const lines = code.trim().split("\n");
      const head = el("pre", "cmd");
      head.innerHTML = `<b>[${id}]</b> ❯ ${escape(lines[0])}${lines.length > 1 ? ` <span>… +${lines.length - 1} lines</span>` : ""}`;
      entry.append(head);
      this.log.append(entry);
      this.entries.set(id, entry);
    });
  }

  private target(id: number): HTMLElement {
    let e = this.entries.get(id);
    if (!e) {
      e = el("div", "entry");
      this.log.append(e);
      this.entries.set(id, e);
    }
    return e;
  }

  write(id: number, cls: "out" | "warn" | "err" | "res", text: string) {
    this.stick(() => {
      const entry = this.target(id);
      const last = entry.lastElementChild;
      // stream consecutive stdout chunks into one block
      if ((cls === "out" || cls === "warn") && last?.classList.contains(cls)) {
        last.textContent += "\n" + text;
        return;
      }
      const pre = el("pre", cls + (cls === "res" && text.includes("\n") ? " multi" : ""));
      pre.textContent = text;
      entry.append(pre);
    });
  }

  image(id: number, src: string) {
    this.stick(() => {
      const img = document.createElement("img");
      img.src = src;
      img.addEventListener("load", () => (this.log.scrollTop = this.log.scrollHeight));
      this.target(id).append(img);
    });
  }

  plot(id: number, spec: PlotSpec) {
    this.stick(() => {
      const pre = el("pre", "link");
      pre.textContent = `▸ plot ${spec.id}: ${spec.title}`;
      pre.title = "show in graph";
      pre.addEventListener("click", () => this.onPlotClick(spec));
      this.target(id).append(pre);
    });
  }

  done(id: number, ok: boolean, ms: number) {
    this.stick(() => {
      const entry = this.target(id);
      if (!ok || ms > 300) {
        const meta = el("pre", "meta");
        meta.textContent = `${ok ? "✓" : "✗"} ${fmtMs(ms)}`;
        entry.append(meta);
      }
      this.entries.delete(id);
    });
  }

  system(text: string) {
    this.stick(() => {
      const entry = el("div", "entry system");
      const pre = el("pre", "");
      pre.textContent = text;
      entry.append(pre);
      this.log.append(entry);
    });
  }

  help() {
    this.stick(() => {
      const entry = el("div", "entry help");
      const pre = el("pre", "");
      pre.innerHTML = escape(HELP).replace(/&lt;k&gt;(.*?)&lt;\/k&gt;/g, '<span class="k">$1</span>');
      entry.append(pre);
      this.log.append(entry);
    });
  }

  clear() {
    this.log.replaceChildren();
    this.entries.clear();
  }

  focus() {
    this.input.focus();
  }
}

function el(tag: string, cls: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function escape(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function fmtMs(ms: number) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}
