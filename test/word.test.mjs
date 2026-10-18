// PDF → Word conversion test:  node test/word.test.mjs
import * as mupdf from "mupdf";
import assert from "node:assert/strict";
import { pdfToDocx } from "../toword.js";
import { inflateRawSync } from "node:zlib";

function makePdf() {
  const doc = new mupdf.PDFDocument();
  const reg = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  const bold = doc.addSimpleFont(new mupdf.Font("Helvetica-Bold"));
  const res = doc.addObject({ Font: { F1: reg, F2: bold } });
  const body = "BT /F2 20 Tf 72 720 Td (Feeding Guideline) Tj ET " +
    "BT /F1 11 Tf 72 690 Td 14 TL (Check abdominal girth every shift and escalate) Tj T* (concerns to the attending neonatologist.) Tj ET";
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, body));
  doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, doc.addObject({}), "0 0 1 rg 100 100 300 300 re f")); // no text: "scan"
  return doc.saveToBuffer("").asUint8Array().slice();
}

// Minimal zip reader to pull word/document.xml out of the .docx
function readZipEntry(buf, name) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = buf.length - 22;
  while (dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
  let p = dv.getUint32(eocd + 16, true);
  const count = dv.getUint16(eocd + 10, true);
  for (let i = 0; i < count; i++) {
    const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const n = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nlen));
    if (n === name) {
      const lnl = dv.getUint16(off + 26, true), lel = dv.getUint16(off + 28, true);
      const data = buf.subarray(off + 30 + lnl + lel, off + 30 + lnl + lel + size);
      return new TextDecoder().decode(method === 8 ? inflateRawSync(data) : data);
    }
    p += 46 + nlen + elen + clen;
  }
  return null;
}

const r = await pdfToDocx(makePdf(), null);
assert.equal(r.pages, 2);
assert.equal(r.scannedPages, 1);
const xml = readZipEntry(r.bytes, "word/document.xml");
assert.ok(xml, "document.xml present");
const text = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");
assert.ok(text.includes("Feeding Guideline"));
assert.ok(text.includes("escalate concerns"), "wrapped lines join into one paragraph");
assert.ok(xml.includes("<w:b/>") || xml.includes("<w:b "), "bold kept");
assert.ok(xml.includes("<pic:pic"), "scanned page included as a picture");
console.log("Word conversion tests passed");
