# calx native kernel — runs under the user's own python3, launched by the Tauri backend.
#
# Protocol: one JSON message per line. Requests arrive on stdin; replies go out on the
# process's original stdout. fd 1 is then pointed at stderr, so anything that writes to the
# raw file descriptor (C extensions, os.system, subprocesses) can't corrupt the protocol;
# the backend shows that stream as plain output.
import ast
import builtins
import collections
import io
import json
import os
import platform
import sys
import threading
import time
import types

_t0 = time.time()
_proto = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
os.dup2(2, 1)
_requests = io.TextIOWrapper(os.fdopen(os.dup(0), "rb", buffering=0), encoding="utf-8")
os.environ.setdefault("MPLBACKEND", "Agg")

_lock = threading.Lock()
_current = [0]
_pending = collections.deque()


def send(msg):
    line = json.dumps(msg, default=str)
    with _lock:
        _proto.write(line + "\n")
        _proto.flush()


class _Stream(io.TextIOBase):
    """sys.stdout / sys.stderr replacement that forwards whole lines to the UI."""

    def __init__(self, kind):
        self.kind = kind
        self.buf = ""

    def writable(self):
        return True

    def isatty(self):
        return False

    @property
    def encoding(self):
        return "utf-8"

    def write(self, s):
        if not isinstance(s, str):
            raise TypeError(f"write() argument must be str, not {type(s).__name__}")
        self.buf += s
        if "\n" in self.buf:
            *lines, self.buf = self.buf.split("\n")
            send({"type": self.kind, "id": _current[0], "text": "\n".join(lines)})
        return len(s)

    def flush(self):
        if self.buf:
            text, self.buf = self.buf, ""
            send({"type": self.kind, "id": _current[0], "text": text})


def _flush_streams():
    sys.stdout.flush()
    sys.stderr.flush()


def _next_request():
    if _pending:
        return _pending.popleft()
    line = _requests.readline()
    if not line:
        raise SystemExit(0)
    return json.loads(line)


def _input(prompt=""):
    """input() asks the UI; the reply comes back as an {"type": "input"} request."""
    _flush_streams()
    send({"type": "input_request", "id": _current[0], "prompt": str(prompt)})
    while True:
        line = _requests.readline()
        if not line:
            raise EOFError
        msg = json.loads(line)
        if msg.get("type") == "input":
            if msg.get("eof"):
                raise EOFError
            return msg.get("value", "")
        _pending.append(msg)


class _Stdin(io.TextIOBase):
    def readable(self):
        return True

    def isatty(self):
        return False

    def readline(self, size=-1):
        try:
            return _input() + "\n"
        except EOFError:
            return ""

    def read(self, size=-1):
        return self.readline()


sys.stdout = _Stream("stdout")
sys.stderr = _Stream("stderr")
sys.stdin = _Stdin()
builtins.input = _input


# ── bridge used by the shared prelude ────────────────────────────────────


def _emit(kind, payload_json):
    _flush_streams()
    payload = json.loads(payload_json)
    if kind == "plot":
        send({"type": "plot", "id": _current[0], "plot": payload})
    else:
        send({"type": kind, "id": _current[0], **payload})


_bridge = types.ModuleType("calx_js")
_bridge.emit = _emit
sys.modules["calx_js"] = _bridge

_here = os.path.dirname(os.path.abspath(__file__))
core = {"__name__": "calx_core"}
with open(os.path.join(_here, "calx_prelude.py"), encoding="utf-8") as fh:
    exec(compile(fh.read(), "<calx-prelude>", "exec"), core)

# A fresh __main__ for user code: plain Python, plus calx's plotting helpers.
_main = types.ModuleType("__main__")
_main.__dict__.update({
    "__builtins__": builtins,
    "plot": core["plot"],
    "scatter": core["scatter"],
    # targets of the rewritten `= ...` / `~ ...` lines
    "_calc": core["_calc"],
    "_plot_src": core["_plot_src"],
})
sys.modules["__main__"] = _main
ns = _main.__dict__
core["_NS"] = ns
sys.path.insert(0, os.getcwd())


# ── execution ────────────────────────────────────────────────────────────


def run(rid, code):
    _current[0] = rid
    t0 = time.time()
    ok = True
    try:
        src = core["_prepare"](code)
        tree = ast.parse(src, "<calx>", "exec")
        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr) and not src.rstrip().endswith(";"):
            last = ast.Expression(tree.body.pop().value)
        exec(compile(tree, "<calx>", "exec"), ns)
        value = eval(compile(last, "<calx>", "eval"), ns) if last is not None else None
        _flush_streams()
        core["_finish"](value)
    except BaseException as e:  # noqa: BLE001 — includes KeyboardInterrupt and SystemExit
        _flush_streams()
        core["_fail"](e)
        ok = False
    _flush_streams()
    send({"type": "done", "id": rid, "ok": ok, "ms": (time.time() - t0) * 1000})


def sample(msg):
    out = core["_resample"](json.dumps(msg))
    send({"type": "samples", "reqId": msg["reqId"], "series": json.loads(out)})


send({
    "type": "ready",
    "kernel": "native",
    "version": platform.python_implementation().lower(),
    "python": platform.python_version(),
    "executable": sys.executable,
    "missing": [] if core["_HAS_SYMPY"] else ["sympy"],
    "ms": (time.time() - _t0) * 1000,
})

while True:
    try:
        msg = _next_request()
        if msg["type"] == "run":
            run(msg["id"], msg["code"])
        elif msg["type"] == "sample":
            sample(msg)
    except KeyboardInterrupt:
        # an interrupt that lands while idle is harmless
        continue
    except SystemExit:
        break
