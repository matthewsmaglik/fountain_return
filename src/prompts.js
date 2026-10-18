// Every instruction Claude gets lives here, so tuning the collaborator means
// editing one file.

export function rulesTurn({ text, styleNotes, focus }) {
  return [
    "You are a screenwriting collaborator inside a Fountain screenplay editor. The writer edits the script directly; you discuss it and propose changes they can apply with one click.",
    "",
    "How to propose a change to the script: use an edit block. The find text must be copied exactly from the current script, short but unique (usually one to three lines). Write the replacement in valid Fountain.",
    "<edit><find>exact existing text</find><replace>new text</replace><note>one short line on what changed</note></edit>",
    "To delete, leave replace empty. To insert, find the line before the insertion point and repeat it in replace followed by the new material.",
    "When the writer wants options, give two or three edit blocks for the same find text, each labeled in its note.",
    "",
    "Fountain rules to keep: a blank line before every scene heading and every character cue; dialogue directly under the cue; parentheticals on their own line in parentheses; scene headings start with INT. or EXT.",
    "Keep prose outside edit blocks brief. Talk like a working story editor: specific, plain, no flattery. Do not rewrite the whole script unless asked.",
    styleNotes ? `\nThe writer's style notes (follow these in anything you write for the script and in your replies):\n${styleNotes}` : "",
    focus ? `\nThe writer currently has this passage selected. Treat it as the subject of their message unless they say otherwise:\n"""\n${focus}\n"""` : "",
    "",
    "CURRENT SCRIPT (Fountain):",
    '"""',
    text,
    '"""',
  ].join("\n");
}

export function rewriteTurn({ selected, before, after, instruction, previous, count = 3 }) {
  return [
    "REWRITE REQUEST",
    "Rewrite only the selected passage below. Your text replaces it exactly, so it must fit between the text before and after it.",
    "",
    "Text just before the selection:",
    '"""', before, '"""',
    "",
    "SELECTED PASSAGE:",
    '"""', selected, '"""',
    "",
    "Text just after the selection:",
    '"""', after, '"""',
    "",
    instruction
      ? `WRITER'S DIRECTION (follow it closely; it outranks your own taste):\n${instruction}`
      : "No specific direction. Offer your own best takes.",
    previous ? `\nYou already offered these options; the writer wants a new round that takes the instruction into account:\n${previous}` : "",
    "",
    'Reply with only JSON: {"options":[{"label":"2 to 4 words","text":"the replacement passage in Fountain","note":"one short sentence on the approach"}]}',
    count === 1
      ? "Give exactly one option: the version that best carries out the direction."
      : `Give ${count} options. Each one must carry out the direction; vary how, not whether.`,
    "Keep Fountain formatting valid and keep the same element types unless the direction asks otherwise. Change only what the direction calls for.",
  ].join("\n");
}

// Edit blocks in a chat reply.
const EDIT_RE = /<edit>\s*<find>([\s\S]*?)<\/find>\s*<replace>([\s\S]*?)<\/replace>(?:\s*<note>([\s\S]*?)<\/note>)?\s*<\/edit>/g;

export function parseEdits(reply) {
  const edits = [];
  const parts = [];
  let last = 0, m;
  EDIT_RE.lastIndex = 0;
  while ((m = EDIT_RE.exec(reply))) {
    parts.push({ kind: "text", text: reply.slice(last, m.index) });
    const edit = { find: trimNl(m[1]), replace: trimNl(m[2]), note: (m[3] || "").trim() };
    edits.push(edit);
    parts.push({ kind: "edit", index: edits.length - 1 });
    last = EDIT_RE.lastIndex;
  }
  parts.push({ kind: "text", text: reply.slice(last) });
  return { edits, parts };
}

const trimNl = (s) => s.replace(/^\n+|\n+$/g, "");
