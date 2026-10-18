// PDF reading and writing (runs in the main process).
// Uses MuPDF, which copes with passwords, damaged files and rotated/cropped pages.
// Annotation coordinates are "page points": top-left origin, y down, rotation applied —
// the same as the Android app, so files annotated on either device stay editable on both.

import * as mupdf from "mupdf";

export const MARK_KEY = "PDFMarkupData";

const HIGHLIGHT_ALPHA = 0.4;
const LINE_HEIGHT = 1.25;
const TEXT_PAD = 2;

function openDoc(bytes) {
  return mupdf.Document.openDocument(bytes, "application/pdf").asPDF();
}

function toBytes(buf) {
  return buf.asUint8Array().slice();
}

function readMarkData(annot) {
  try {
    const v = annot.getObject().get(MARK_KEY);
    if (v && v.isString()) return v.asString();
  } catch {}
  return null;
}

/**
 * Opens a PDF for viewing.
 * Returns { status: "ok", viewBytes, marks, canSave, pageSizes }
 *      or { status: "password", wrong } or { status: "error", message }.
 * viewBytes is a decrypted copy without this app's own annotations (they come back as
 * editable marks instead).
 */
export function openForView(bytes, password) {
  let doc;
  try {
    doc = openDoc(bytes);
  } catch (e) {
    return { status: "error", message: "This file couldn't be opened. It may be damaged or not a PDF." };
  }
  try {
    const encrypted = doc.needsPassword();
    if (encrypted) {
      if (!password) return { status: "password", wrong: false };
      if (!doc.authenticatePassword(password)) return { status: "password", wrong: true };
    }
    const n = doc.countPages();
    if (n === 0) return { status: "error", message: "This PDF has no pages." };
    const marks = [];
    const pageSizes = [];
    let removed = false;
    for (let i = 0; i < n; i++) {
      const page = doc.loadPage(i);
      const b = page.getBounds();
      pageSizes.push({ width: b[2] - b[0], height: b[3] - b[1] });
      const ours = [];
      for (const a of page.getAnnotations()) {
        const data = readMarkData(a);
        if (data == null) continue;
        try {
          const m = JSON.parse(data);
          m.p = i;
          marks.push(m);
          ours.push(a);
        } catch {}
      }
      for (const a of ours) page.deleteAnnotation(a);
      if (ours.length) removed = true;
    }
    let viewBytes = bytes;
    let repaired = false;
    try { repaired = doc.wasRepaired(); } catch {}
    if (encrypted || removed || repaired) {
      viewBytes = toBytes(doc.saveToBuffer("encrypt=none"));
    }
    return { status: "ok", viewBytes, marks, canSave: true, pageSizes, encrypted };
  } catch (e) {
    return { status: "error", message: "This file couldn't be opened: " + (e?.message || e) };
  } finally {
    try { doc.destroy?.(); } catch {}
  }
}

/** A clean, decrypted copy for the viewer (used if the viewer can't read the original). */
export function repairForView(bytes, password) {
  const doc = openDoc(bytes);
  if (doc.needsPassword() && password) doc.authenticatePassword(password);
  return toBytes(doc.saveToBuffer("encrypt=none,garbage=compact"));
}

function rgb(color) {
  const c = color >>> 0;
  return [((c >>> 16) & 255) / 255, ((c >>> 8) & 255) / 255, (c & 255) / 255];
}

/** Width of a line of text in points, approximated with Helvetica metrics. */
let measureFont = null;
function textWidth(s, size) {
  try {
    if (!measureFont) measureFont = new mupdf.Font("Helvetica");
    let w = 0;
    for (const ch of s) {
      const g = measureFont.encodeCharacter(ch.codePointAt(0));
      w += g > 0 ? measureFont.advanceGlyph(g, 0) : 0.55;
    }
    return w * size;
  } catch {
    return s.length * size * 0.55;
  }
}

export function textBounds(m) {
  const lines = String(m.txt).split("\n");
  const w = Math.max(...lines.map((l) => textWidth(l, m.s)), m.s);
  return [m.x, m.y, m.x + w + 2 * TEXT_PAD, m.y + lines.length * m.s * LINE_HEIGHT + 2 * TEXT_PAD];
}

function addMark(doc, page, m, sx, sy) {
  const json = JSON.stringify(m);
  if (m.t === "ink") {
    const pts = [];
    for (let i = 0; i + 1 < m.pts.length; i += 2) pts.push([m.pts[i] * sx, m.pts[i + 1] * sy]);
    if (pts.length === 0) return;
    if (pts.length === 1) pts.push([pts[0][0] + 0.01, pts[0][1]]);
    const a = page.createAnnotation("Ink");
    a.setInkList([pts]);
    a.setColor(rgb(m.c));
    a.setBorderWidth(m.w * sx);
    if (m.h) a.setOpacity(HIGHLIGHT_ALPHA);
    a.setAuthor("PDF Markup");
    a.getObject().put(MARK_KEY, doc.newString(json));
    a.update();
  } else if (m.t === "text") {
    const b = textBounds(m);
    const a = page.createAnnotation("FreeText");
    // A little extra width so the viewer's own line-wrapping never kicks in.
    const extra = (b[2] - b[0]) * 0.12 + m.s * 0.5;
    a.setRect([b[0] * sx, b[1] * sy, (b[2] + extra) * sx, b[3] * sy]);
    a.setContents(String(m.txt));
    a.setDefaultAppearance("Helv", m.s * sx, rgb(m.c));
    a.setBorderWidth(0);
    a.setAuthor("PDF Markup");
    a.getObject().put(MARK_KEY, doc.newString(json));
    a.update();
  }
}

/**
 * Returns the original PDF with [marks] added as real PDF annotations.
 * [pageSizes] are the viewer's page sizes, used to scale if they ever differ.
 * Password protection on the original is kept.
 */
export function writeAnnotated(bytes, password, marks, pageSizes) {
  const doc = openDoc(bytes);
  try {
    if (doc.needsPassword()) {
      if (!password || !doc.authenticatePassword(password)) throw new Error("Wrong password");
    }
    const byPage = new Map();
    for (const m of marks) {
      if (!byPage.has(m.p)) byPage.set(m.p, []);
      byPage.get(m.p).push(m);
    }
    const n = doc.countPages();
    for (let i = 0; i < n; i++) {
      const page = doc.loadPage(i);
      const adds = byPage.get(i) || [];
      const old = page.getAnnotations().filter((a) => readMarkData(a) != null);
      if (old.length === 0 && adds.length === 0) continue;
      for (const a of old) page.deleteAnnotation(a);
      const b = page.getBounds();
      const vs = pageSizes?.[i];
      const sx = vs ? (b[2] - b[0]) / vs.width : 1;
      const sy = vs ? (b[3] - b[1]) / vs.height : 1;
      for (const m of adds) {
        try {
          addMark(doc, page, m, sx, sy);
        } catch (e) {
          console.warn("Skipping an annotation that couldn't be written", e);
        }
      }
    }
    return toBytes(doc.saveToBuffer("garbage=compact"));
  } finally {
    try { doc.destroy?.(); } catch {}
  }
}
