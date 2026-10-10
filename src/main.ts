import "./style.css";
import { createEditor } from "./editor";
import { Graph } from "./graph";
import { Kernel, type KernelState } from "./kernel/client";
import type { FromKernel } from "./kernel/protocol";
import { Terminal } from "./terminal";

const WELCOME = `# calx — ⌘↵ runs the block under the cursor, ⇧↵ runs one line
# type :help in the terminal for everything else

= x^2 - 5x + 6 = 0

= integrate(sin(x)^2, x)

= 2x + y = 7 ; x - y = 2

~ sin(x) ; x^2/8 - 3 ; x^2 + y^2 = 16

# regular python works too
def collatz(n):
    steps = 0
    while n != 1:
        n = n // 2 if n % 2 == 0 else 3 * n + 1
        steps += 1
    return steps

plot(list(range(1, 60)), [collatz(i) for i in range(1, 60)], title="collatz")

series(exp(x) * cos(x), x, 0, 6)
`;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const load = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
const save = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch { /* storage unavailable */ }
};

// ── status ───────────────────────────────────────────────────────────────

const statusEl = $("#kernel-status");
function setStatus(state: KernelState, detail?: string) {
  statusEl.className = `status ${state}`;
  statusEl.querySelector("span")!.textContent = detail ?? state;
}

// ── wiring ───────────────────────────────────────────────────────────────

const terminal = new Terminal(
  $("#log"),
  $<HTMLInputElement>("#prompt-input"),
  (line) => submit(line),
  (spec) => graph.show({ ...spec, hold: false }),
);

const kernel = new Kernel(onKernel, setStatus);

const graph = new Graph(
  $("#graph"),
  $<HTMLCanvasElement>("#graph canvas"),
  (ids, view, n) => kernel.sample(ids, view, n),
  (text) => ($("#graph-coords").textContent = text),
);

function onKernel(msg: FromKernel) {
  switch (msg.type) {
    case "ready":
      terminal.system(`calx · python ${msg.python} · pyodide ${msg.version} · ready in ${(msg.ms / 1000).toFixed(1)}s`);
      break;
    case "fatal":
      terminal.system(`kernel failed to start:\n${msg.text}`);
      break;
    case "stdout":
      terminal.write(msg.id, "out", msg.text);
      break;
    case "stderr":
      terminal.write(msg.id, "warn", msg.text);
      break;
    case "result":
      terminal.write(msg.id, "res", msg.text);
      break;
    case "error":
      terminal.write(msg.id, "err", msg.text);
      break;
    case "image":
      terminal.image(msg.id, msg.src);
      break;
    case "plot":
      graph.show(msg.plot);
      $("#graph-title").textContent = graph.plot?.title ?? "";
      terminal.plot(msg.id, msg.plot);
      break;
    case "help":
      terminal.help();
      break;
    case "done":
      terminal.done(msg.id, msg.ok, msg.ms);
      break;
  }
}

function runCode(code: string) {
  const { id, done } = kernel.run(code);
  terminal.begin(id, code);
  return done;
}

function stop() {
  if (kernel.state === "booting") return;
  kernel.restart();
  graph.clear();
  $("#graph-title").textContent = "";
  terminal.system("kernel restarted — variables were cleared");
}

function submit(line: string) {
  const cmd = line.trim();
  if (!cmd) return;
  if (cmd === ":help" || cmd === "help") return terminal.help();
  if (cmd === ":clear" || cmd === "clear") return terminal.clear();
  if (cmd === ":restart") return stop();
  runCode(line);
}

let saveTimer = 0;
const editor = createEditor($("#editor"), load("calx.buffer", WELCOME), {
  run: (block) => runCode(block.code),
  stop,
  clear: () => terminal.clear(),
  onChange: (doc) => {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => save("calx.buffer", doc), 300);
  },
  onCursor: (line, col) => ($("#cursor-pos").textContent = `${line}:${col}`),
});
editor.focus();

$("#graph-reset").addEventListener("click", () => graph.reset());
$("#graph-zoom-in").addEventListener("click", () => graph.zoom(1 / 1.5));
$("#graph-zoom-out").addEventListener("click", () => graph.zoom(1.5));
$("#term-clear").addEventListener("click", () => terminal.clear());

// global shortcuts that should work outside the editor too
window.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key === ".") {
    e.preventDefault();
    stop();
  } else if (e.key === "k") {
    e.preventDefault();
    terminal.clear();
  } else if (e.key === "j") {
    e.preventDefault();
    terminal.focus();
  } else if (e.key === "e") {
    e.preventDefault();
    editor.focus();
  }
});

// ── splitters ────────────────────────────────────────────────────────────

const root = document.documentElement;
for (const bar of document.querySelectorAll<HTMLElement>(".splitter")) {
  const axis = bar.dataset.split as "col" | "row";
  const saved = load(`calx.${axis}`, "");
  if (saved) root.style.setProperty(`--${axis}`, saved);
  bar.addEventListener("pointerdown", (e) => {
    bar.setPointerCapture(e.pointerId);
    bar.classList.add("dragging");
    const box = (axis === "col" ? $("#workspace") : $("#side")).getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const frac = axis === "col" ? (ev.clientX - box.left) / box.width : (ev.clientY - box.top) / box.height;
      const pct = `${Math.min(85, Math.max(15, frac * 100)).toFixed(1)}%`;
      root.style.setProperty(`--${axis}`, pct);
      save(`calx.${axis}`, pct);
    };
    const up = () => {
      bar.classList.remove("dragging");
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", up);
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
  });
}
