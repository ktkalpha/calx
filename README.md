# calx

A terminal-style macOS scratchpad for math and Python. Graph functions, solve equations and run Python
from one REPL-style editor, in the spirit of [Strudel](https://strudel.cc).

```
= x^2 - 5x + 6 = 0              →  x = 2, x = 3
= 2x + y = 7 ; x - y = 2         →  x = 3, y = 1
= integrate(sin(x)^2, x)         →  x/2 - sin(2x)/4
~ sin x ; x^2 + y^2 = 16         →  draws both in the graph pane
```

Lines that don't start with `=` or `~` are plain Python.

## Kernels

| | **python3** (default in the app) | **pyodide** (built-in fallback) |
|---|---|---|
| Interpreter | the python3 on your Mac (Homebrew, pyenv, conda, venv…) | CPython 3.14 compiled to WebAssembly, bundled |
| Packages | anything you `pip install` | sympy/numpy/matplotlib bundled, other Pyodide packages on demand |
| Files, network, subprocess | yes | sandboxed |
| Namespace | plain Python (`plot`/`scatter` added) | sympy pre-imported, `x y z t n k a b c` are symbols |
| `⌘.` | KeyboardInterrupt, variables kept | restarts the kernel |

calx finds python3 through your login shell's PATH. If none is found it falls back to Pyodide.
`= …` / `~ …` lines need sympy in the interpreter you use (`python3 -m pip install sympy`).

Terminal commands: `:kernel native`, `:kernel pyodide`, `:python ~/.venvs/sci/bin/python` (use a specific interpreter), `:python` (back to PATH lookup), `:restart`.
You can also click the kernel badge in the title bar to switch. `input()` is answered from the terminal prompt.

## Features

- **Live-coding editor**: `⌘↵` runs the block under the cursor, `⇧↵` runs one line, `⌘⇧↵` runs the whole buffer. The block that ran flashes green on success, red on error.
- **Calculator syntax**: `= …` evaluates, solves or solves a system. Supports `^`, implicit multiplication (`2x`, `sin x`), `π` and `√`. Prints the exact result plus a decimal approximation.
- **Graphs**: `~ …` or `plot(...)` handles y = f(x), `y = …`, implicit curves (`x^2 + y^2 = 9`), parametric curves `(cos(t), sin(t))`, and data `plot(xs, ys)` / `scatter`. Drag to pan, scroll or pinch to zoom; curves re-sample as you move. Hovering shows coordinates and each curve's value.
- **Python**: your own python3 by default, or the built-in [Pyodide](https://pyodide.org) as a fallback. `plt` figures render inline in the terminal.
- **Terminal**: one-line prompt (`calx ❯`) with history, plus `:help`, `:clear` and `:restart`.
- `⌘.` interrupts a long-running run. The editor buffer is saved automatically.

## Development

Requirements: Node 20+, Rust (stable), Xcode Command Line Tools.

```sh
npm install
npm run tauri dev          # desktop app with hot reload
npm run tauri build        # → src-tauri/target/release/bundle/{macos,dmg}
```

`npm run dev` runs the UI in a browser at http://localhost:1420, which is handy for frontend work.

`scripts/fetch-pyodide.mjs` runs automatically before dev and build. It copies the Pyodide runtime into `public/pyodide/`
and bundles sympy, numpy and matplotlib (with their dependencies) so the app works offline. Any other Pyodide
package is fetched from the jsDelivr CDN the first time it is imported. Set `CALX_BUNDLE=sympy,numpy` to change what gets bundled.

## Layout

```
src/
  main.ts            UI wiring, shortcuts, splitters
  editor.ts          CodeMirror setup, block detection, eval flash
  terminal.ts        scrollback + prompt
  graph.ts           canvas plotter (pan/zoom, auto-fit, asymptote breaks)
  kernel/
    client.ts        kernel session: run / sample / input / interrupt / restart
    transports.ts    pyodide worker or native python3 (via Tauri)
    worker.ts        Pyodide in a Web Worker
    native.py        kernel loop for system python3 (JSON lines over stdio)
    prelude.py       calx's Python layer shared by both: = / ~ syntax, plot(), resampling, matplotlib hook
src-tauri/
  src/kernel.rs      finds python3, spawns native.py, forwards I/O, SIGINT for ⌘.
```
