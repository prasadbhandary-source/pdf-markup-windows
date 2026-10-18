// Round-trip tests for the PDF engine:  node test/core.test.mjs
import * as mupdf from "mupdf";
import assert from "node:assert/strict";
import fs from "node:fs";
import { openForView, writeAnnotated } from "../pdfcore.js";

function makePdf(opts = "") {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  for (const [rot, crop] of [[0, null], [90, null], [0, [100, 100, 500, 700]], [270, null]]) {
    const res = doc.addObject({ Font: { F1: font } });
    const p = doc.addPage([0, 0, 612, 792], rot, res, `BT /F1 18 Tf 40 700 Td (Page rot ${rot}) Tj ET`);
    doc.insertPage(-1, p);
    if (crop) doc.loadPage(doc.countPages() - 1).setPageBox("CropBox", crop);
  }
  return doc.saveToBuffer(opts).asUint8Array().slice();
}

const marks = [];
for (let p = 0; p < 4; p++) {
  marks.push({ t: "ink", id: 1 + p, p, c: 0xffd32f2f | 0, w: 3, h: false, pts: [30, 30, 120, 40, 200, 30, 200, 120] });
  marks.push({ t: "ink", id: 10 + p, p, c: 0xffffeb3b | 0, w: 14, h: true, pts: [30, 220, 300, 220] });
  marks.push({ t: "text", id: 20 + p, p, x: 30, y: 140, s: 14, c: 0xff1e5bd8 | 0, txt: "Note on page " + (p + 1) + "\nsecond line é" });
}

// 1. Plain file
const plain = makePdf();
const v0 = openForView(plain);
assert.equal(v0.status, "ok");
assert.equal(v0.marks.length, 0);
assert.deepEqual(v0.pageSizes[1], { width: 792, height: 612 });
assert.deepEqual(v0.pageSizes[2], { width: 400, height: 600 });

const saved = writeAnnotated(plain, null, marks, v0.pageSizes);
const v1 = openForView(saved);
assert.equal(v1.status, "ok");
assert.equal(v1.marks.length, marks.length, "marks come back editable");
assert.deepEqual(v1.marks.find((m) => m.id === 22).txt, marks.find((m) => m.id === 22).txt);
// the viewer copy must not contain our annotations (they're drawn by the app instead)
const view = mupdf.Document.openDocument(v1.viewBytes, "application/pdf").asPDF();
for (let i = 0; i < 4; i++) assert.equal(view.loadPage(i).getAnnotations().length, 0);
// but the saved file has real annotations for other viewers
const s = mupdf.Document.openDocument(saved, "application/pdf").asPDF();
assert.deepEqual(s.loadPage(0).getAnnotations().map((a) => a.getType()), ["Ink", "Ink", "FreeText"]);

// 2. Saving again replaces, never duplicates
const resaved = writeAnnotated(saved, null, marks.slice(0, 3), v1.pageSizes);
const r = mupdf.Document.openDocument(resaved, "application/pdf").asPDF();
assert.equal(r.loadPage(0).getAnnotations().length, 3);
assert.equal(r.loadPage(1).getAnnotations().length, 0);

// 3. Other apps' annotations are left alone
{
  const d = mupdf.Document.openDocument(plain, "application/pdf").asPDF();
  const a = d.loadPage(0).createAnnotation("Square");
  a.setRect([300, 300, 400, 400]); a.update();
  const withOther = d.saveToBuffer("").asUint8Array().slice();
  const out = writeAnnotated(withOther, null, marks, v0.pageSizes);
  const t = mupdf.Document.openDocument(out, "application/pdf").asPDF();
  assert.ok(t.loadPage(0).getAnnotations().some((x) => x.getType() === "Square"));
  const vv = openForView(out);
  assert.equal(mupdf.Document.openDocument(vv.viewBytes, "application/pdf").asPDF().loadPage(0).getAnnotations().length, 1);
}

// 4. Password-protected file keeps its password
const locked = makePdf("encrypt=aes-256,user-password=abc,owner-password=xyz");
assert.equal(openForView(locked).status, "password");
assert.equal(openForView(locked, "nope").wrong, true);
const lv = openForView(locked, "abc");
assert.equal(lv.status, "ok");
assert.equal(mupdf.Document.openDocument(lv.viewBytes, "application/pdf").needsPassword(), false);
const lockedOut = writeAnnotated(locked, "abc", marks, lv.pageSizes);
assert.equal(mupdf.Document.openDocument(lockedOut, "application/pdf").needsPassword(), true);
assert.equal(openForView(lockedOut, "abc").marks.length, marks.length);

// 5. Damaged (truncated) file still opens
const broken = plain.slice(0, Math.floor(plain.length * 0.9));
const bv = openForView(broken);
assert.equal(bv.status, "ok");

// 6. Not a PDF
assert.equal(openForView(new TextEncoder().encode("hello world")).status, "error");

fs.mkdirSync("test/out", { recursive: true });
fs.writeFileSync("test/out/annotated.pdf", saved);
for (let i = 0; i < 4; i++) {
  const pm = s.loadPage(i).toPixmap(mupdf.Matrix.scale(0.5, 0.5), mupdf.ColorSpace.DeviceRGB, false, true);
  fs.writeFileSync(`test/out/page${i}.png`, pm.asPNG());
}
console.log("All PDF engine tests passed");
