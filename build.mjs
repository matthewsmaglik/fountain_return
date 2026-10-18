// Builds one self-contained HTML page: dist/fountain-studio.html
// It is what gets published as the claude.ai Artifact, and it also runs
// opened straight from disk (browser storage, no Claude).
import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "fs/promises";

const out = await build({
  entryPoints: ["src/app.js"],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2020",
  write: false,
  legalComments: "none",
});
const js = out.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const tpl = await readFile("src/template.html", "utf8");
const html = tpl + `\n<script>\n${js}\n</script>\n`;
await mkdir("dist", { recursive: true });
await writeFile("dist/fountain-studio.html", html);
console.log(`dist/fountain-studio.html  ${(html.length / 1024).toFixed(0)} KB`);
