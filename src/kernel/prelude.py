# calx kernel prelude — runs once when the Python kernel starts.
# Everything defined here is visible in the user's namespace.
import json as _json
import math as _math
import os as _os
import re as _re
import sys as _sys
import traceback as _traceback

_os.environ.setdefault("MPLBACKEND", "Agg")

import calx_js as _js
from sympy import *  # noqa: F401,F403
from sympy.parsing.sympy_parser import (
    convert_xor as _convert_xor,
    implicit_multiplication_application as _implicit,
    parse_expr as _parse_expr,
    standard_transformations as _std,
)

x, y, z, t, n, k, a, b, c = symbols("x y z t n k a b c")
f, g, h = symbols("f g h", cls=Function)

_TRANSFORMS = _std + (_implicit, _convert_xor)
_PALETTE = ["#7ee787", "#79c0ff", "#f0b45b", "#ff7b72", "#d2a8ff", "#56d4dd", "#ffa198", "#e3b341"]
_series_registry = {}
_series_counter = [0]
_color_counter = [0]
_plot_counter = [0]


def _emit(kind, **payload):
    _js.emit(kind, _json.dumps(payload, default=_json_default))


def _json_default(o):
    try:
        return float(o)
    except Exception:
        return str(o)


# ── display ──────────────────────────────────────────────────────────────


def _format(value):
    if isinstance(value, (Basic, MatrixBase)) or (
        isinstance(value, (list, tuple, dict, set)) and _contains_sympy(value)
    ):
        try:
            return pretty(value, use_unicode=True)
        except Exception:
            pass
    return repr(value)


def _contains_sympy(v):
    if isinstance(v, (Basic, MatrixBase)):
        return True
    if isinstance(v, dict):
        return any(_contains_sympy(a) or _contains_sympy(b) for a, b in v.items())
    if isinstance(v, (list, tuple, set)):
        return any(_contains_sympy(a) for a in v)
    return False


def _show(value):
    if value is None:
        return
    _emit("result", text=_format(value))


# ── math shorthand:  `= expr`  and  `~ expr` ─────────────────────────────


def _parse(src):
    src = src.strip().replace("π", "pi").replace("√", "sqrt ").replace("·", "*").replace("×", "*")
    return _parse_expr(src, transformations=_TRANSFORMS, local_dict=_user_ns())


def _user_ns():
    ns = {}
    for key, val in _NS.items():
        if not key.startswith("_"):
            ns[key] = val
    return ns


def _split_eq(src):
    """'lhs = rhs' -> Eq(lhs, rhs); plain expressions pass through."""
    parts = _re.split(r"(?<![<>=!])=(?!=)", src)
    if len(parts) == 2:
        return Eq(_parse(parts[0]), _parse(parts[1]))
    if len(parts) > 2:
        raise SyntaxError("only one '=' per equation")
    return _parse(src)


def _calc(src):
    """`= ...` lines: evaluate an expression or solve equation(s)."""
    pieces = [p for p in (s.strip() for s in src.split(";")) if p]
    items = [_split_eq(p) for p in pieces]
    eqs = [e for e in items if isinstance(e, Equality)]
    if eqs and len(eqs) == len(items):
        if len(eqs) == 1:
            sol = solve(eqs[0], dict=True)
        else:
            syms = sorted(set().union(*(e.free_symbols for e in eqs)), key=str)
            sol = solve(eqs, *syms, dict=True)
        if not sol:
            _emit("result", text="no solution")
            return
        lines = []
        for s in sol:
            for var, val in s.items():
                exact = pretty(val, use_unicode=True)
                approx = _approx(val)
                lines.append(f"{var} = {exact}" + (f"   ≈ {approx}" if approx else ""))
            if len(s) > 1 and s is not sol[-1]:
                lines.append("")
        _emit("result", text="\n".join(lines))
        return
    for e in items:
        val = e if isinstance(e, Equality) else simplify(e)
        approx = _approx(val)
        text = pretty(val, use_unicode=True)
        if approx and "\n" not in text:
            text += f"   ≈ {approx}"
        elif approx:
            text += f"\n≈ {approx}"
        _emit("result", text=text)


def _approx(val):
    try:
        if not isinstance(val, Basic) or val.free_symbols or val.is_Integer:
            return None
        num = N(val, 15)
        if num == val:
            return None
        if num.is_real:
            return _fmt_num(float(num))
        re_, im_ = (float(p) for p in num.as_real_imag())
        return f"{_fmt_num(re_)} {'+' if im_ >= 0 else '-'} {_fmt_num(abs(im_))}i"
    except Exception:
        return None


def _fmt_num(v):
    return f"{v:.12g}"


def _plot_src(src):
    """`~ ...` lines: plot one or more expressions separated by ';'."""
    exprs = [p.strip() for p in src.split(";") if p.strip()]
    plot(*exprs)


# ── plotting ─────────────────────────────────────────────────────────────


def _next_color():
    col = _PALETTE[_color_counter[0] % len(_PALETTE)]
    _color_counter[0] += 1
    return col


def _to_expr(obj):
    if isinstance(obj, str):
        return _split_eq(obj)
    return obj


def _lambdify1(var, expr):
    fn = lambdify(var, expr, modules=["math", "mpmath", "sympy"])

    def safe(v):
        try:
            r = fn(v)
            r = complex(r)
            if abs(r.imag) > 1e-9:
                return _math.nan
            return float(r.real)
        except Exception:
            return _math.nan

    return safe


def _lambdify2(vx, vy, expr):
    fn = lambdify((vx, vy), expr, modules=["math", "mpmath", "sympy"])

    def safe(px, py):
        try:
            r = complex(fn(px, py))
            if abs(r.imag) > 1e-9:
                return _math.nan
            return float(r.real)
        except Exception:
            return _math.nan

    return safe


def _sample_fn(fn, xmin, xmax, n):
    n = max(2, int(n))
    step = (xmax - xmin) / (n - 1)
    xs = [xmin + i * step for i in range(n)]
    ys = [fn(v) for v in xs]
    return {"xs": xs, "ys": [v if _math.isfinite(v) else None for v in ys]}


def _sample_param(fx, fy, tmin, tmax, n):
    n = max(2, int(n))
    step = (tmax - tmin) / (n - 1)
    ts = [tmin + i * step for i in range(n)]
    xs = [fx(v) for v in ts]
    ys = [fy(v) for v in ts]
    ok = lambda v: v if _math.isfinite(v) else None  # noqa: E731
    return {"xs": [ok(v) for v in xs], "ys": [ok(v) for v in ys]}


def _march(fn, xmin, xmax, ymin, ymax, nx, ny):
    """Marching squares on F(x, y) = 0. Returns flat [x1, y1, x2, y2, ...] segments."""
    nx, ny = max(8, int(nx)), max(8, int(ny))
    dx, dy = (xmax - xmin) / nx, (ymax - ymin) / ny
    grid = [[fn(xmin + i * dx, ymin + j * dy) for i in range(nx + 1)] for j in range(ny + 1)]
    segs = []

    def interp(p1, p2, v1, v2):
        tt = v1 / (v1 - v2) if v1 != v2 else 0.5
        return (p1[0] + tt * (p2[0] - p1[0]), p1[1] + tt * (p2[1] - p1[1]))

    for j in range(ny):
        y0 = ymin + j * dy
        row0, row1 = grid[j], grid[j + 1]
        for i in range(nx):
            v = (row0[i], row0[i + 1], row1[i + 1], row1[i])
            if any(not _math.isfinite(q) for q in v):
                continue
            idx = (v[0] > 0) | ((v[1] > 0) << 1) | ((v[2] > 0) << 2) | ((v[3] > 0) << 3)
            if idx in (0, 15):
                continue
            x0 = xmin + i * dx
            p = ((x0, y0), (x0 + dx, y0), (x0 + dx, y0 + dy), (x0, y0 + dy))
            edges = []
            for e in range(4):
                a_, b_ = e, (e + 1) % 4
                if (v[a_] > 0) != (v[b_] > 0):
                    edges.append(interp(p[a_], p[b_], v[a_], v[b_]))
            # discard sign flips across poles (e.g. 1/x): both values huge
            if max(abs(q) for q in v) > 1e6 * (dx + dy):
                continue
            for s in range(0, len(edges) - 1, 2):
                (ax, ay), (bx, by) = edges[s], edges[s + 1]
                segs.extend((ax, ay, bx, by))
    return {"segs": segs}


def _register(kind, label, sampler, data, dynamic, color=None, style="line"):
    _series_counter[0] += 1
    sid = f"s{_series_counter[0]}"
    if dynamic:
        _series_registry[sid] = sampler
    return {
        "id": sid,
        "kind": kind,
        "label": label,
        "color": color or _next_color(),
        "dynamic": dynamic,
        "style": style,
        **data,
    }


def _label(obj):
    if isinstance(obj, Equality):
        return f"{_label(obj.lhs)} = {_label(obj.rhs)}"
    if isinstance(obj, Basic):
        return sstr(obj).replace("**", "^")
    return getattr(obj, "__name__", None) or str(obj)


def _as_numbers(v):
    try:
        return [float(q) for q in v]
    except Exception:
        return None


def plot(*args, x=(-10, 10), y=None, t=(0, 2 * _math.pi), title=None, hold=False, n=800, color=None):
    """Plot functions, equations, parametric curves or data.

    plot(sin(x))                    y = f(x)
    plot("x^2", "2x + 1")           strings use calculator syntax
    plot("x^2 + y^2 = 4")           implicit curve
    plot((cos(t), sin(t)))          parametric curve over t
    plot([1, 2, 3], [1, 4, 9])      data
    plot(..., x=(-5, 5), y=(-2, 2), title="...", hold=True)
    """
    xmin, xmax = (float(v) for v in x)
    ymin, ymax = (float(v) for v in y) if y else (None, None)
    series = []
    items = list(args)
    i = 0
    while i < len(items):
        obj = items[i]
        # plot(xs, ys) data pair
        if isinstance(obj, (list, tuple)) and i + 1 < len(items):
            xs, ys = _as_numbers(obj), _as_numbers(items[i + 1])
            if xs is not None and ys is not None and len(xs) == len(ys):
                series.append(_register("data", f"data[{len(xs)}]", None, {"xs": xs, "ys": ys}, False, color))
                i += 2
                continue
        obj = _to_expr(obj)
        series.append(_make_series(obj, xmin, xmax, ymin, ymax, t, n, color))
        i += 1

    if not series:
        raise ValueError("plot() needs at least one thing to plot")
    _plot_counter[0] += 1
    _emit(
        "plot",
        id=_plot_counter[0],
        title=title or ", ".join(s["label"] for s in series),
        series=series,
        view={"xmin": xmin, "xmax": xmax, "ymin": ymin, "ymax": ymax},
        hold=bool(hold),
    )


def scatter(xs, ys, color=None, title=None, hold=False):
    xs, ys = _as_numbers(xs), _as_numbers(ys)
    s = _register("data", f"scatter[{len(xs)}]", None, {"xs": xs, "ys": ys}, False, color, style="points")
    pad = lambda lo, hi: (lo - (hi - lo or 1) * 0.1, hi + (hi - lo or 1) * 0.1)  # noqa: E731
    x0, x1 = pad(min(xs), max(xs))
    y0, y1 = pad(min(ys), max(ys))
    _plot_counter[0] += 1
    _emit("plot", id=_plot_counter[0], title=title or s["label"], series=[s],
          view={"xmin": x0, "xmax": x1, "ymin": y0, "ymax": y1}, hold=bool(hold))


def _make_series(obj, xmin, xmax, ymin, ymax, trange, n, color):
    # parametric (x(t), y(t))
    if isinstance(obj, tuple) and len(obj) == 2:
        ex, ey = (_to_expr(o) for o in obj)
        syms = set()
        for e in (ex, ey):
            if isinstance(e, Basic):
                syms |= e.free_symbols
        var = sorted(syms, key=str)[0] if syms else Symbol("t")
        fx = _lambdify1(var, ex) if isinstance(ex, Basic) else ex
        fy = _lambdify1(var, ey) if isinstance(ey, Basic) else ey
        t0, t1 = (float(v) for v in trange)
        data = _sample_param(fx, fy, t0, t1, n)
        return _register("param", f"({_label(ex)}, {_label(ey)})", None, data, False, color)

    # python callable
    if callable(obj) and not isinstance(obj, Basic):
        def fn(v, _f=obj):
            try:
                return float(_f(v))
            except Exception:
                return _math.nan
        sampler = lambda view, npts: _sample_fn(fn, view["xmin"], view["xmax"], npts)  # noqa: E731
        return _register("fn", _label(obj), sampler, _sample_fn(fn, xmin, xmax, n), True, color)

    obj = sympify(obj)
    if isinstance(obj, Equality):
        free = obj.free_symbols
        # y = f(x) with y isolated on one side → treat as a function graph
        if obj.lhs == Symbol("y") and Symbol("y") not in obj.rhs.free_symbols:
            return _make_fn(obj.rhs, xmin, xmax, n, color, label=_label(obj))
        expr = obj.lhs - obj.rhs
        vx, vy = Symbol("x"), Symbol("y")
        if not free <= {vx, vy}:
            raise ValueError(f"implicit plots use x and y, got {sorted(map(str, free))}")
        fn = _lambdify2(vx, vy, expr)
        y0 = ymin if ymin is not None else xmin * 0.6
        y1 = ymax if ymax is not None else xmax * 0.6
        sampler = lambda view, npts: _march(  # noqa: E731
            fn, view["xmin"], view["xmax"], view["ymin"], view["ymax"], 160, 160)
        return _register("implicit", _label(obj), sampler, _march(fn, xmin, xmax, y0, y1, 160, 160), True, color)

    return _make_fn(obj, xmin, xmax, n, color)


def _make_fn(expr, xmin, xmax, n, color, label=None):
    free = sorted(expr.free_symbols, key=str)
    if len(free) > 1:
        raise ValueError(f"y = f(x) plots need one variable, got {', '.join(map(str, free))}")
    var = free[0] if free else Symbol("x")
    fn = _lambdify1(var, expr)
    sampler = lambda view, npts: _sample_fn(fn, view["xmin"], view["xmax"], npts)  # noqa: E731
    return _register("fn", label or _label(expr), sampler, _sample_fn(fn, xmin, xmax, n), True, color)


def _resample(request_json):
    req = _json.loads(request_json)
    view, npts = req["view"], req.get("n", 800)
    out = []
    for sid in req["ids"]:
        sampler = _series_registry.get(sid)
        if sampler is None:
            continue
        try:
            out.append({"id": sid, **sampler(view, npts)})
        except Exception:
            pass
    return _json.dumps(out)


# ── matplotlib integration ───────────────────────────────────────────────


def _flush_figures():
    mpl = _sys.modules.get("matplotlib.pyplot")
    if mpl is None:
        return
    import base64
    import io

    for num in mpl.get_fignums():
        fig = mpl.figure(num)
        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=144, facecolor="#0b0e0c", bbox_inches="tight")
        _emit("image", src="data:image/png;base64," + base64.b64encode(buf.getvalue()).decode())
    mpl.close("all")


def _patch_matplotlib():
    mpl = _sys.modules.get("matplotlib.pyplot")
    if mpl is None or getattr(mpl, "_calx_patched", False):
        return
    mpl.show = lambda *a, **kw: _flush_figures()
    mpl.style.use("dark_background")
    mpl._calx_patched = True


# ── code runner ──────────────────────────────────────────────────────────

_CALC_LINE = _re.compile(r"^=(?!=)\s*(.*)$")
_PLOT_LINE = _re.compile(r"^~\s+(.*)$")


def _transform(code):
    out = []
    for line in code.split("\n"):
        m = _CALC_LINE.match(line)
        if m:
            out.append(f"_calc({m.group(1)!r})")
            continue
        m = _PLOT_LINE.match(line)
        if m:
            out.append(f"_plot_src({m.group(1)!r})")
            continue
        out.append(line)
    return "\n".join(out)


async def _run(code):
    from pyodide.code import eval_code_async

    try:
        src = _transform(code)
        if "matplotlib" in src:
            import matplotlib  # noqa: F401
            import matplotlib.pyplot  # noqa: F401
            _patch_matplotlib()
        value = await eval_code_async(src, _NS, filename="<calx>")
        _show(value)
        _flush_figures()
        return True
    except BaseException as e:  # noqa: BLE001
        _flush_figures()
        _emit("error", text=_format_exc(e))
        return False


def _format_exc(e):
    if isinstance(e, SyntaxError) and e.filename in ("<calx>", "<unknown>", None):
        lines = [f"  line {e.lineno}" if e.lineno else ""]
        if e.text:
            lines.append("    " + e.text.rstrip())
            if e.offset:
                lines.append("    " + " " * (e.offset - 1) + "^")
        lines.append(f"SyntaxError: {e.msg}")
        return "\n".join(l for l in lines if l)
    frames = [fr for fr in _traceback.extract_tb(e.__traceback__) if fr.filename == "<calx>"]
    parts = [f"  line {fr.lineno}, in {fr.name}" for fr in frames[-3:]]
    parts.append(f"{type(e).__name__}: {e}")
    return "\n".join(parts)


def help():  # noqa: A001
    _emit("help")


_NS = globals()
