// Fountain parsing for the editor.
// Line-oriented on purpose: the editor needs a type for every source line,
// and the breakdown needs scenes, characters and an honest page estimate.
// Spec reference: https://fountain.io/syntax

const SCENE_RE = /^(?:\.(?!\.)|(?:INT|EXT|EST|INT\.?\/EXT|EXT\.?\/INT|I\/E)[.\s])/i;
const SCENE_NUM_RE = /\s*#([\w.\-]+)#\s*$/;
const TRANSITION_RE = /^[A-Z0-9 .'\-]+TO:$/;
const TRANSITION_EXTRA_RE = /^(FADE (OUT|IN|TO BLACK)|CUT TO BLACK|SMASH CUT|BLACKOUT)\.?:?$/;
const TITLE_KEY_RE = /^([A-Za-z][A-Za-z ]*):\s*(.*)$/;

const isBlank = (s) => s === undefined || s.trim() === "";

function isUpperCue(s) {
  // A character cue: all caps once extensions like (CONT'D) are removed.
  const core = s.replace(/\(.*?\)/g, "").replace(/\^\s*$/, "").trim();
  if (!core || !/[A-Z]/.test(core)) return false;
  if (core !== core.toUpperCase()) return false;
  if (/[.:!?]$/.test(core) && !/\.$/.test(core.replace(/^(MR|MRS|MS|DR|ST)\./, ""))) return false;
  return core.length <= 40;
}

export function cueName(line) {
  return line
    .replace(/^@/, "")
    .replace(/\^\s*$/, "")
    .replace(/\(.*?\)/g, "")
    .trim()
    .toUpperCase();
}

/**
 * Classify every line. Returns an array the same length as `lines`, each
 * { type, text } where type is one of:
 * title-key, title-value, page-break, scene, transition, centered,
 * character, parenthetical, dialogue, lyric, section, synopsis, note,
 * boneyard, action, blank
 */
export function classify(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out = new Array(lines.length);
  let i = 0;

  // Title page: key: value pairs at the very top, ending at the first blank line.
  if (lines.length && TITLE_KEY_RE.test(lines[0]) && !SCENE_RE.test(lines[0])) {
    while (i < lines.length && !isBlank(lines[i])) {
      out[i] = { type: TITLE_KEY_RE.test(lines[i]) && !/^\s/.test(lines[i]) ? "title-key" : "title-value" };
      i++;
    }
  }

  let inDialogue = false;
  let inBoneyard = false;

  for (; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    const prevBlank = i === 0 || isBlank(lines[i - 1]) || out[i - 1]?.type === "page-break";
    const nextBlank = isBlank(lines[i + 1]);

    if (inBoneyard) {
      out[i] = { type: "boneyard" };
      if (t.includes("*/")) inBoneyard = false;
      continue;
    }
    if (t.startsWith("/*")) {
      out[i] = { type: "boneyard" };
      if (!t.includes("*/", 2)) inBoneyard = true;
      continue;
    }

    if (t === "") { out[i] = { type: "blank" }; inDialogue = false; continue; }

    if (inDialogue) {
      out[i] = { type: /^\(.*\)$/.test(t) ? "parenthetical" : "dialogue" };
      continue;
    }

    if (/^={3,}$/.test(t)) { out[i] = { type: "page-break" }; continue; }
    if (/^#+\s?/.test(t)) { out[i] = { type: "section" }; continue; }
    if (/^=(?!=)/.test(t)) { out[i] = { type: "synopsis" }; continue; }
    if (/^\[\[.*\]\]$/.test(t)) { out[i] = { type: "note" }; continue; }
    if (/^~/.test(t)) { out[i] = { type: "lyric" }; continue; }
    if (/^>.*<$/.test(t)) { out[i] = { type: "centered" }; continue; }
    if (/^>/.test(t)) { out[i] = { type: "transition" }; continue; }
    if (/^!/.test(t)) { out[i] = { type: "action" }; continue; }

    if (prevBlank && SCENE_RE.test(t)) { out[i] = { type: "scene" }; continue; }

    if (prevBlank && nextBlank && (TRANSITION_RE.test(t) || TRANSITION_EXTRA_RE.test(t))) {
      out[i] = { type: "transition" }; continue;
    }

    if (prevBlank && !nextBlank && (t.startsWith("@") || isUpperCue(t))) {
      out[i] = { type: "character" };
      inDialogue = true;
      continue;
    }

    out[i] = { type: "action" };
  }

  return { lines, types: out.map((o) => o.type) };
}

export function parseTitlePage(lines, types) {
  const meta = {};
  let key = null;
  for (let i = 0; i < lines.length && (types[i] === "title-key" || types[i] === "title-value"); i++) {
    const m = TITLE_KEY_RE.exec(lines[i]);
    if (types[i] === "title-key" && m) {
      key = m[1].trim().toLowerCase();
      meta[key] = m[2].trim();
    } else if (key) {
      meta[key] = (meta[key] ? meta[key] + "\n" : "") + lines[i].trim();
    }
  }
  return meta;
}

// ---- Page estimate --------------------------------------------------------
// Standard screenplay page: 55 lines, Courier 12pt, 10 chars per inch.
// Widths in characters per element, close to Final Draft defaults.
const WIDTH = {
  action: 60, scene: 60, transition: 60, centered: 60, lyric: 60,
  character: 38, dialogue: 35, parenthetical: 26,
};
export const LINES_PER_PAGE = 55;

function wrapCount(s, width) {
  const words = s.trim().split(/\s+/);
  let lines = 1, col = 0;
  for (const w of words) {
    const len = w.length;
    if (col === 0) col = len;
    else if (col + 1 + len <= width) col += 1 + len;
    else { lines++; col = len; }
  }
  return lines;
}

function stripMarkup(s) {
  return s
    .replace(/^[.@!>~]/, "")
    .replace(/<$/, "")
    .replace(/\^\s*$/, "")
    .replace(SCENE_NUM_RE, "")
    .replace(/\[\[.*?\]\]/g, "")
    .replace(/[*_]/g, "")
    .trim();
}

/**
 * Lay out the script into estimated pages. Returns, for each source line,
 * the page it lands on (title page lines get 0), plus total page count.
 * Elements are kept whole; a speech that would cross the bottom moves to the
 * next page, which is roughly what screenwriting software does.
 */
export function paginate(lines, types) {
  const pageOf = new Array(lines.length).fill(0);
  let page = 1, used = 0, started = false;
  const pageStarts = [];

  // Group lines into blocks: a block is a run of non-blank lines.
  let i = 0;
  while (i < lines.length && (types[i] === "title-key" || types[i] === "title-value")) i++;
  while (i < lines.length && types[i] === "blank") i++;
  // A page break right after the title page just separates it.
  if (types[i] === "page-break") { i++; }

  const hidden = new Set(["section", "synopsis", "note", "boneyard"]);

  while (i < lines.length) {
    if (types[i] === "blank") { i++; continue; }
    if (types[i] === "page-break") {
      if (used > 0) { page++; used = 0; }
      pageOf[i] = page; i++; continue;
    }
    // collect block
    const start = i;
    while (i < lines.length && types[i] !== "blank" && types[i] !== "page-break") i++;
    const end = i; // exclusive

    let height = 0;
    for (let k = start; k < end; k++) {
      if (hidden.has(types[k])) continue;
      const w = WIDTH[types[k]] || 60;
      height += wrapCount(stripMarkup(lines[k]) || " ", w);
    }
    if (height === 0) { for (let k = start; k < end; k++) pageOf[k] = page; continue; }

    const gap = used === 0 ? 0 : 1;
    if (used + gap + height > LINES_PER_PAGE && used > 0) {
      page++; used = 0;
      if (!started) started = true;
      used = height;
      pageStarts.push(start);
    } else {
      used += gap + height;
    }
    started = true;
    for (let k = start; k < end; k++) pageOf[k] = page;
  }

  // Lines that are blank inherit the page of the line before them.
  for (let k = 1; k < pageOf.length; k++) if (!pageOf[k] && types[k] === "blank") pageOf[k] = pageOf[k - 1];
  return { pageOf, pages: started ? page : 0, pageStarts, usedOnLast: used };
}

/** Full breakdown for the stats box. */
export function analyze(text) {
  const { lines, types } = classify(text);
  const meta = parseTitlePage(lines, types);
  const pag = paginate(lines, types);

  // Fractional page position of each line, used for eighths.
  const scenes = [];
  const chars = new Map();
  let current = null;
  let wordCount = 0;
  let dialogueWords = 0;

  for (let i = 0; i < lines.length; i++) {
    const ty = types[i];
    const t = lines[i].trim();
    if (ty === "scene") {
      const numMatch = SCENE_NUM_RE.exec(t);
      current = {
        index: scenes.length,
        number: numMatch ? numMatch[1] : String(scenes.length + 1),
        heading: stripMarkup(t).toUpperCase(),
        line: i,
        page: pag.pageOf[i] || 1,
        endLine: lines.length - 1,
        characters: new Set(),
      };
      if (scenes.length) scenes[scenes.length - 1].endLine = i - 1;
      scenes.push(current);
      continue;
    }
    if (ty === "character") {
      const name = cueName(t);
      if (!chars.has(name)) {
        chars.set(name, { name, firstLine: i, firstScene: current ? current.index : -1, speeches: 0, words: 0, scenes: new Set() });
      }
      const c = chars.get(name);
      c.speeches++;
      if (current) { c.scenes.add(current.index); current.characters.add(name); }
      // count their words
      let k = i + 1;
      while (k < lines.length && (types[k] === "dialogue" || types[k] === "parenthetical")) {
        if (types[k] === "dialogue") {
          const n = lines[k].trim().split(/\s+/).filter(Boolean).length;
          c.words += n; dialogueWords += n;
        }
        k++;
      }
    }
    if (ty === "action" || ty === "dialogue" || ty === "scene" || ty === "parenthetical") {
      wordCount += t.split(/\s+/).filter(Boolean).length;
    }
  }

  // Scene length in eighths of a page, from estimated lines used.
  const lineHeights = estimateLineHeights(lines, types);
  for (const s of scenes) {
    let h = 0;
    for (let k = s.line; k <= s.endLine; k++) h += lineHeights[k];
    s.eighths = Math.max(1, Math.round((h / LINES_PER_PAGE) * 8));
    s.characters = [...s.characters];
  }

  const characters = [...chars.values()]
    .sort((a, b) => a.firstLine - b.firstLine)
    .map((c) => ({ ...c, scenes: c.scenes.size }));

  return {
    meta,
    lines,
    types,
    pageOf: pag.pageOf,
    pageStarts: pag.pageStarts,
    pages: pag.pages,
    scenes,
    characters,
    wordCount,
    dialogueWords,
  };
}

function estimateLineHeights(lines, types) {
  const hidden = new Set(["section", "synopsis", "note", "boneyard", "title-key", "title-value", "page-break"]);
  return lines.map((l, i) => {
    const ty = types[i];
    if (ty === "blank") return 1;
    if (hidden.has(ty)) return 0;
    return wrapCount(stripMarkup(l) || " ", WIDTH[ty] || 60);
  });
}

export function formatEighths(e) {
  const whole = Math.floor(e / 8);
  const rem = e % 8;
  if (!whole) return `${rem}/8`;
  if (!rem) return `${whole}`;
  return `${whole} ${rem}/8`;
}
