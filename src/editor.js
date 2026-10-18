// CodeMirror 6 setup: the script stays plain Fountain text, and screenplay
// layout is applied as line decorations so the caret always matches the text.
import { EditorState, StateField, StateEffect } from "@codemirror/state";
import { EditorView, Decoration, WidgetType, keymap, drawSelection, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { classify, paginate } from "./fountain.js";

class PageMark extends WidgetType {
  constructor(n) { super(); this.n = n; }
  eq(o) { return o.n === this.n; }
  toDOM() {
    const el = document.createElement("div");
    el.className = "fl-pagebreak";
    el.setAttribute("aria-label", `Page ${this.n}`);
    el.innerHTML = `<span>${this.n}.</span>`;
    return el;
  }
  ignoreEvent() { return true; }
}

function buildDecorations(state) {
  const text = state.doc.toString();
  const { lines, types } = classify(text);
  const { pageStarts, pageOf } = paginate(lines, types);
  const starts = new Set(pageStarts);
  const decos = [];
  let scene = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = state.doc.line(i + 1);
    if (starts.has(i)) {
      decos.push(Decoration.widget({ widget: new PageMark(pageOf[i]), block: true, side: -1 }).range(line.from));
    }
    const ty = types[i];
    const attrs = { class: `fl-${ty}` };
    if (ty === "scene") { scene++; attrs["data-scene"] = String(scene); }
    decos.push(Decoration.line({ attributes: attrs }).range(line.from));
  }
  return Decoration.set(decos, true);
}

const fountainField = StateField.define({
  create: buildDecorations,
  update(deco, tr) { return tr.docChanged ? buildDecorations(tr.state) : deco; },
  provide: (f) => EditorView.decorations.from(f),
});

// Ranges waiting on a Claude rewrite. They map through edits, so the user can
// keep typing elsewhere and an accepted option still lands in the right place.
export const setPending = StateEffect.define();
export const clearPending = StateEffect.define();
const pendingMark = Decoration.mark({ class: "fl-pending" });

export const pendingField = StateField.define({
  create: () => ({ ranges: new Map(), deco: Decoration.none }),
  update(value, tr) {
    let ranges = value.ranges;
    let changed = false;
    if (tr.docChanged && ranges.size) {
      const next = new Map();
      for (const [id, r] of ranges) {
        const from = tr.changes.mapPos(r.from, 1);
        const to = tr.changes.mapPos(r.to, -1);
        next.set(id, { from, to: Math.max(from, to) });
      }
      ranges = next; changed = true;
    }
    for (const e of tr.effects) {
      if (e.is(setPending)) { ranges = new Map(ranges); ranges.set(e.value.id, { from: e.value.from, to: e.value.to }); changed = true; }
      if (e.is(clearPending)) { ranges = new Map(ranges); ranges.delete(e.value); changed = true; }
    }
    if (!changed) return value;
    const sorted = [...ranges.values()].filter((r) => r.to > r.from).sort((a, b) => a.from - b.from);
    const deco = Decoration.set(sorted.map((r) => pendingMark.range(r.from, r.to)), true);
    return { ranges, deco };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

export function getPending(view, id) {
  return view.state.field(pendingField).ranges.get(id);
}

export function createEditor({ parent, doc, onChange, onSelection, extraKeys = [] }) {
  const extensions = [
    history(),
    drawSelection(),
    highlightActiveLine(),
    EditorView.lineWrapping,
    fountainField,
    pendingField,
    keymap.of([...extraKeys, ...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.contentAttributes.of({ spellcheck: "true", autocorrect: "on", "aria-label": "Script" }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onChange?.(u);
      if (u.selectionSet || u.docChanged || u.focusChanged) onSelection?.(u);
    }),
  ];
  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions }) });
  // Swap in a different script with a clean undo history.
  view.load = (text) => view.setState(EditorState.create({ doc: text, extensions }));
  return view;
}

export function replaceDoc(view, text) {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}

export function scrollToLine(view, lineIndex) {
  const line = view.state.doc.line(Math.min(lineIndex + 1, view.state.doc.lines));
  view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "start", yMargin: 40 }) });
  view.focus();
}
