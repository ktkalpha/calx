import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { EditorState, StateEffect, StateField, type Text } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

export interface Block {
  from: number;
  to: number;
  code: string;
}

export interface EditorHandlers {
  run(block: Block): Promise<boolean>;
  stop(): void;
  clear(): void;
  onChange(doc: string): void;
  onCursor(line: number, col: number): void;
}

// ── evaluation flash ─────────────────────────────────────────────────────

type FlashKind = "run" | "ok" | "err";
const addFlash = StateEffect.define<{ from: number; to: number; kind: FlashKind }>();
const clearFlash = StateEffect.define<null>();

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(clearFlash)) deco = Decoration.none;
      if (e.is(addFlash)) {
        deco = Decoration.set(
          linesIn(tr.state.doc, e.value.from, e.value.to).map((pos) =>
            Decoration.line({ class: `cm-flash cm-flash-${e.value.kind}` }).range(pos),
          ),
        );
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function linesIn(doc: Text, from: number, to: number): number[] {
  const out: number[] = [];
  for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) out.push(doc.line(n).from);
  return out;
}

let flashTimer = 0;
function flash(view: EditorView, from: number, to: number, kind: FlashKind) {
  clearTimeout(flashTimer);
  view.dispatch({ effects: addFlash.of({ from, to, kind }) });
  if (kind !== "run") flashTimer = window.setTimeout(() => view.dispatch({ effects: clearFlash.of(null) }), 450);
}

// ── block detection ──────────────────────────────────────────────────────

const blank = (s: string) => s.trim() === "";
const indented = (s: string) => /^\s/.test(s) && !blank(s);

/** Paragraph around the cursor; blank lines inside indented bodies (def/for/class) stay in the block. */
export function blockAt(doc: Text, pos: number): Block | null {
  let start = doc.lineAt(pos).number;
  while (start > 1 && blank(doc.line(start).text)) start--;
  if (blank(doc.line(start).text)) return null;
  let end = start;

  const nextNonBlank = (n: number, dir: 1 | -1) => {
    while (n >= 1 && n <= doc.lines && blank(doc.line(n).text)) n += dir;
    return n >= 1 && n <= doc.lines ? n : null;
  };

  for (;;) {
    if (start > 1 && !blank(doc.line(start - 1).text)) { start--; continue; }
    // a gap above an indented line belongs to the enclosing body
    if (indented(doc.line(start).text)) {
      const prev = nextNonBlank(start - 1, -1);
      if (prev) { start = prev; continue; }
    }
    break;
  }
  for (;;) {
    if (end < doc.lines && !blank(doc.line(end + 1).text)) { end++; continue; }
    const next = nextNonBlank(end + 1, 1);
    if (next && indented(doc.line(next).text)) { end = next; continue; }
    break;
  }
  const from = doc.line(start).from;
  const to = doc.line(end).to;
  return { from, to, code: doc.sliceString(from, to) };
}

// ── theme ────────────────────────────────────────────────────────────────

const theme = EditorView.theme(
  {
    "&": { color: "#c9d4c6", backgroundColor: "#0b0e0c", fontSize: "13.5px" },
    ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.6" },
    ".cm-content": { caretColor: "#7ee787", padding: "10px 0" },
    ".cm-cursor, .cm-dropCursor": { borderLeft: "8px solid #7ee78799", marginLeft: "-1px" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "#2a3b2d !important" },
    ".cm-gutters": { backgroundColor: "#0b0e0c", color: "#36423a", border: "none", paddingLeft: "4px" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#7ee787" },
    ".cm-activeLine": { backgroundColor: "#101511" },
    ".cm-matchingBracket": { backgroundColor: "#24332a", outline: "1px solid #3d5543" },
    ".cm-flash": { transition: "background-color 0.4s ease-out" },
    ".cm-flash-run": { backgroundColor: "#7ee78722" },
    ".cm-flash-ok": { backgroundColor: "#7ee78733" },
    ".cm-flash-err": { backgroundColor: "#ff7b7233" },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: "#ff7b72" },
  { tag: [t.operator, t.operatorKeyword], color: "#f0b45b" },
  { tag: [t.string, t.special(t.string)], color: "#a5d6ff" },
  { tag: [t.number, t.bool, t.null], color: "#d2a8ff" },
  { tag: [t.comment, t.lineComment], color: "#4f5d53", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#79c0ff" },
  { tag: t.definition(t.variableName), color: "#7ee787" },
  { tag: [t.className, t.definition(t.className)], color: "#f0b45b" },
  { tag: t.self, color: "#ff7b72" },
  { tag: t.propertyName, color: "#c9d4c6" },
]);

// `= ...` and `~ ...` lines get their own colour since they are calx syntax, not Python
const calxLine = Decoration.line({ class: "cm-calx-line" });
const calxLines = EditorView.decorations.compute(["doc"], (state) => {
  const ranges = [];
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (/^(=(?!=)|~\s)/.test(line.text)) ranges.push(calxLine.range(line.from));
  }
  return Decoration.set(ranges);
});
const calxTheme = EditorView.theme({
  ".cm-calx-line": { color: "#7ee787" },
  ".cm-calx-line span": { color: "inherit !important" },
});

// ── editor ───────────────────────────────────────────────────────────────

export function createEditor(parent: HTMLElement, doc: string, h: EditorHandlers): EditorView {
  const runRange = async (view: EditorView, block: Block | null) => {
    if (!block || !block.code.trim()) return true;
    flash(view, block.from, block.to, "run");
    const ok = await h.run(block);
    flash(view, block.from, block.to, ok ? "ok" : "err");
    return true;
  };

  const selectionOr = (view: EditorView, fallback: () => Block | null): Block | null => {
    const sel = view.state.selection.main;
    if (!sel.empty) return { from: sel.from, to: sel.to, code: view.state.sliceDoc(sel.from, sel.to) };
    return fallback();
  };

  const calxKeys = keymap.of([
    {
      key: "Mod-Enter",
      preventDefault: true,
      run: (v) => (runRange(v, selectionOr(v, () => blockAt(v.state.doc, v.state.selection.main.head))), true),
    },
    {
      key: "Shift-Enter",
      preventDefault: true,
      run: (v) => {
        const block = selectionOr(v, () => {
          const line = v.state.doc.lineAt(v.state.selection.main.head);
          return { from: line.from, to: line.to, code: line.text };
        });
        runRange(v, block);
        // move to the next line like a notebook
        const line = v.state.doc.lineAt(block?.to ?? v.state.selection.main.head);
        if (line.number < v.state.doc.lines) v.dispatch({ selection: { anchor: v.state.doc.line(line.number + 1).to } });
        else v.dispatch({ changes: { from: line.to, insert: "\n" }, selection: { anchor: line.to + 1 } });
        return true;
      },
    },
    {
      key: "Mod-Shift-Enter",
      preventDefault: true,
      run: (v) => (runRange(v, { from: 0, to: v.state.doc.length, code: v.state.doc.toString() }), true),
    },
    { key: "Mod-.", preventDefault: true, run: () => (h.stop(), true) },
    { key: "Mod-k", preventDefault: true, run: () => (h.clear(), true) },
  ]);

  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        calxKeys,
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        python(),
        syntaxHighlighting(highlight),
        calxLines,
        calxTheme,
        theme,
        flashField,
        EditorState.tabSize.of(4),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) h.onChange(u.state.doc.toString());
          if (u.selectionSet || u.docChanged) {
            const head = u.state.selection.main.head;
            const line = u.state.doc.lineAt(head);
            h.onCursor(line.number, head - line.from + 1);
          }
        }),
      ],
    }),
  });
}
