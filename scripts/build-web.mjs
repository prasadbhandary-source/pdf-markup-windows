// Assembles the installable web app into _site/ (published to GitHub Pages).
import fs from "node:fs";
import path from "node:path";

const out = "_site";
const build = process.env.GITHUB_RUN_NUMBER || `dev-${Date.now()}`;
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const copy = (from, to) => {
  fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true });
  fs.cpSync(from, path.join(out, to), { recursive: true });
};

for (const f of fs.readdirSync("web")) copy(path.join("web", f), f);

// The PDF engine, pointed at the browser copy of MuPDF.
const core = fs.readFileSync("pdfcore.js", "utf8").replace('from "mupdf"', 'from "./vendor/mupdf/mupdf.js"');
if (!core.includes("./vendor/mupdf/mupdf.js")) throw new Error("pdfcore import not rewritten");
fs.writeFileSync(path.join(out, "pdfcore.js"), core);

for (const f of ["mupdf.js", "mupdf-wasm.js", "mupdf-wasm.wasm"]) copy(`node_modules/mupdf/dist/${f}`, `vendor/mupdf/${f}`);
copy("node_modules/mupdf/LICENSE", "vendor/mupdf/LICENSE");
for (const f of ["pdf.min.mjs", "pdf.worker.min.mjs"]) copy(`node_modules/pdfjs-dist/legacy/build/${f}`, `vendor/pdfjs/build/${f}`);
for (const d of ["cmaps", "standard_fonts", "wasm", "iccs"]) copy(`node_modules/pdfjs-dist/${d}`, `vendor/pdfjs/${d}`);
copy("node_modules/pdfjs-dist/LICENSE", "vendor/pdfjs/LICENSE");

// Version the offline cache so updates reach installed copies.
const sw = path.join(out, "sw.js");
fs.writeFileSync(sw, fs.readFileSync(sw, "utf8").replace("__BUILD__", build));
fs.writeFileSync(path.join(out, ".nojekyll"), "");
fs.writeFileSync(path.join(out, "version.txt"), build + "\n");
console.log(`Built web app (build ${build}) into ${out}/`);
