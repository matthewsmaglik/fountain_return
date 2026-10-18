import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyze, classify } from "../src/fountain.js";

const pvc = readFileSync(new URL("../samples/PVC_draft16A.fountain", import.meta.url), "utf8");

test("title page", () => {
  const a = analyze(pvc);
  assert.equal(a.meta.title, "PVC");
  assert.equal(a.meta.author, "Matthew Smaglik");
});

test("scenes and characters", () => {
  const a = analyze(pvc);
  assert.equal(a.scenes.length, 11);
  assert.equal(a.scenes[0].heading, "INT. BASEMENT - DAY");
  assert.deepEqual(a.characters.map((c) => c.name), ["TOM", "CAITLYN"]);
});

test("mixed-case POV lines stay action", () => {
  const { lines, types } = classify(pvc);
  const i = lines.findIndex((l) => l.startsWith("TOM'S POV"));
  assert.equal(types[i], "action");
});

test("forced elements", () => {
  const { types } = classify("\n.FLASHBACK\n\n@McCLANE\nYippee.\n\n> CUT TO:\n\n>THE END<\n");
  assert.deepEqual(types.filter((t) => t !== "blank"), ["scene", "character", "dialogue", "transition", "centered"]);
});
