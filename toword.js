// PDF → Word (.docx) conversion.
// Text becomes editable paragraphs (keeping fonts, sizes, bold/italic, colours and rough
// position); pictures are kept; pages with no text (scans, photos) become full-page pictures.

import * as mupdf from "mupdf";
import {
  Document, Packer, Paragraph, TextRun, ImageRun, AlignmentType,
} from "docx";

const TWIP = 20; // twips per point
const PX = 96 / 72; // pixels per point (Word images are sized in 96-dpi pixels)
const MAX_PAGE_TWIPS = 31680; // Word's largest page size: 22 inches

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function hex(color) {
  // mupdf colours are arrays of 0..1 in the text's colour space
  if (!color || !color.length) return "000000";
  let r, g, b;
  if (color.length === 1) r = g = b = color[0];
  else if (color.length === 3) [r, g, b] = color;
  else if (color.length === 4) {
    const [c, m, y, k] = color;
    r = (1 - c) * (1 - k); g = (1 - m) * (1 - k); b = (1 - y) * (1 - k);
  } else return "000000";
  return [r, g, b].map((v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
}

function fontInfo(font) {
  let name = "";
  try { name = font.getName() || ""; } catch {}
  const clean = name.replace(/^[A-Z]{6}\+/, ""); // drop subset prefix like ABCDEF+
  const lower = clean.toLowerCase();
  let bold = false, italic = false, mono = false, serif = false;
  try { bold = font.isBold(); } catch {}
  try { italic = font.isItalic(); } catch {}
  try { mono = font.isMono(); } catch {}
  try { serif = font.isSerif(); } catch {}
  bold ||= /bold|black|heavy|semibold|demi/.test(lower);
  italic ||= /italic|oblique/.test(lower);
  mono ||= /courier|mono|consol/.test(lower);
  serif ||= /times|serif|georgia|garamond|cambria|minion|palatino|book/.test(lower) && !/sans/.test(lower);
  const family = mono ? "Courier New" : serif ? "Times New Roman" : /calibri/.test(lower) ? "Calibri" : "Arial";
  return { bold, italic, family };
}

/** Reads one page into blocks of lines of styled runs. */
function readPage(page) {
  const blocks = [];
  let block = null;
  let line = null;
  const st = page.toStructuredText("preserve-images,preserve-whitespace");
  st.walk({
    onImageBlock(bbox, _transform, image) {
      blocks.push({ type: "image", bbox, image });
    },
    beginTextBlock(bbox) {
      block = { type: "text", bbox, lines: [] };
    },
    beginLine(bbox) {
      line = { bbox, runs: [] };
    },
    onChar(c, _origin, font, size, _quad, color) {
      if (!line) return;
      const f = fontInfo(font);
      const style = { ...f, size: Math.round(size * 2) / 2, color: hex(color) };
      const last = line.runs[line.runs.length - 1];
      if (last && last.bold === style.bold && last.italic === style.italic && last.family === style.family &&
          last.size === style.size && last.color === style.color) {
        last.text += c;
      } else {
        line.runs.push({ ...style, text: c });
      }
    },
    endLine() {
      if (line && line.runs.length) block?.lines.push(line);
      line = null;
    },
    endTextBlock() {
      if (block && block.lines.length) blocks.push(block);
      block = null;
    },
  });
  try { st.destroy?.(); } catch {}
  return blocks;
}

function imageData(image) {
  let pix = image.toPixmap();
  const cs = pix.getColorSpace?.();
  const isRGBorGray = cs && (cs.isRGB?.() || cs.isGray?.());
  if (!isRGBorGray) pix = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, pix.getAlpha?.() > 0);
  const hasAlpha = (pix.getAlpha?.() || 0) > 0;
  const big = pix.getWidth() * pix.getHeight() > 250_000;
  if (big && !hasAlpha) return { type: "jpg", data: pix.asJPEG(85) };
  return { type: "png", data: pix.asPNG() };
}

function pageImage(page, w, h) {
  // ~150 dpi, capped so huge pages stay a sensible size
  let scale = 150 / 72;
  const px = w * scale * h * scale;
  if (px > 12_000_000) scale *= Math.sqrt(12_000_000 / px);
  const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
  return { type: "jpg", data: pix.asJPEG(85) };
}

/** Lines in a block → runs, joining wrapped lines with spaces and keeping real line breaks. */
function blockRuns(block) {
  const width = block.bbox[2] - block.bbox[0];
  const out = [];
  block.lines.forEach((ln, i) => {
    const runs = ln.runs.map((r) => ({ ...r }));
    if (i > 0) {
      const prev = block.lines[i - 1];
      const prevWidth = prev.bbox[2] - prev.bbox[0];
      const prevRuns = out;
      const lastRun = prevRuns[prevRuns.length - 1];
      const wrapped = prevWidth >= width * 0.8;
      if (wrapped && lastRun) {
        if (/[A-Za-z]-$/.test(lastRun.text)) lastRun.text = lastRun.text.slice(0, -1); // re-join hyphenated word
        else if (!/\s$/.test(lastRun.text)) lastRun.text += " ";
      } else if (lastRun) {
        out.push({ ...lastRun, text: "", lineBreak: true });
      }
    }
    out.push(...runs);
  });
  return out;
}

function textParagraph(block, margins, prevBottom, contentWidth) {
  const runs = blockRuns(block).map((r) =>
    r.lineBreak
      ? new TextRun({ text: "", break: 1, size: Math.round(r.size * 2), font: r.family })
      : new TextRun({
          text: r.text.replace(/\s+$/, (m) => (m.length ? " " : "")),
          bold: r.bold, italics: r.italic, font: r.family,
          size: Math.max(2, Math.round(r.size * 2)), color: r.color,
        }),
  );
  const left = clamp(block.bbox[0] - margins.left, 0, contentWidth * 0.75);
  const before = prevBottom == null ? 0 : clamp(block.bbox[1] - prevBottom, 0, 48);
  const first = block.lines[0];
  const lineH = first ? first.bbox[3] - first.bbox[1] : 12;
  // Centred if the block sits roughly in the middle and doesn't span the width.
  const pageCentre = margins.left + contentWidth / 2;
  const blockCentre = (block.bbox[0] + block.bbox[2]) / 2;
  const blockWidth = block.bbox[2] - block.bbox[0];
  const centred = blockWidth < contentWidth * 0.7 && Math.abs(blockCentre - pageCentre) < contentWidth * 0.04 && left > 24;
  return new Paragraph({
    children: runs,
    alignment: centred ? AlignmentType.CENTER : AlignmentType.LEFT,
    indent: centred ? undefined : { left: Math.round(left * TWIP) },
    spacing: { before: Math.round(before * TWIP), after: 0, line: Math.round(clamp(lineH, 6, 72) * TWIP), lineRule: "atLeast" },
  });
}

function imageParagraph(img, width, height, indentLeft, before) {
  return new Paragraph({
    children: [new ImageRun({
      type: img.type, data: img.data,
      transformation: { width: Math.max(1, Math.round(width * PX)), height: Math.max(1, Math.round(height * PX)) },
    })],
    indent: { left: Math.round(indentLeft * TWIP) },
    spacing: { before: Math.round(before * TWIP), after: 0 },
  });
}

/**
 * Converts a PDF to a Word document.
 * Returns { bytes: Uint8Array, pages, scannedPages }.
 */
export async function pdfToDocx(bytes, password, onProgress) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  if (doc.needsPassword() && !(password && doc.authenticatePassword(password))) throw new Error("Wrong password");
  const n = doc.countPages();
  const sections = [];
  let scannedPages = 0;
  for (let i = 0; i < n; i++) {
    onProgress?.(i, n);
    const page = doc.loadPage(i);
    const b = page.getBounds();
    const w = b[2] - b[0], h = b[3] - b[1];
    const pageW = clamp(Math.round(w * TWIP), 2880, MAX_PAGE_TWIPS);
    const pageH = clamp(Math.round(h * TWIP), 2880, MAX_PAGE_TWIPS);
    const blocks = readPage(page);
    const hasText = blocks.some((bl) => bl.type === "text" && bl.lines.some((l) => l.runs.some((r) => r.text.trim())));
    const children = [];
    let margins;

    if (!hasText) {
      // A scan or picture: put the whole page in as an image.
      scannedPages++;
      margins = { top: 0, right: 0, bottom: 0, left: 0 };
      const img = pageImage(page, w, h);
      // Slightly smaller than the page so Word doesn't push it onto a second page.
      const s = 0.97;
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new ImageRun({ type: img.type, data: img.data, transformation: { width: Math.round(w * s * PX), height: Math.round(h * s * PX) } })],
        spacing: { before: 0, after: 0 },
      }));
    } else {
      // Margins from where the content actually sits (within sensible limits).
      const minX = Math.min(...blocks.map((bl) => bl.bbox[0]));
      const maxX = Math.max(...blocks.map((bl) => bl.bbox[2]));
      const minY = Math.min(...blocks.map((bl) => bl.bbox[1]));
      margins = {
        left: clamp(minX - b[0], 18, 108),
        right: clamp(b[2] - maxX, 18, 108),
        top: clamp(minY - b[1], 18, 108),
        bottom: 36,
      };
      const contentWidth = w - margins.left - margins.right;
      let prevBottom = null;
      for (const bl of blocks) {
        if (bl.type === "text") {
          children.push(textParagraph(bl, { left: b[0] + margins.left }, prevBottom, contentWidth));
          prevBottom = bl.bbox[3];
        } else {
          try {
            const img = imageData(bl.image);
            let iw = bl.bbox[2] - bl.bbox[0];
            let ih = bl.bbox[3] - bl.bbox[1];
            if (iw < 2 || ih < 2) continue;
            const fit = Math.min(1, contentWidth / iw, (h - margins.top - margins.bottom) / ih);
            iw *= fit; ih *= fit;
            const left = clamp(bl.bbox[0] - b[0] - margins.left, 0, Math.max(0, contentWidth - iw));
            const before = prevBottom == null ? 0 : clamp(bl.bbox[1] - prevBottom, 0, 48);
            children.push(imageParagraph(img, iw, ih, left, before));
            prevBottom = bl.bbox[3];
          } catch (e) {
            console.warn("Skipping a picture that couldn't be converted", e);
          }
        }
      }
    }
    if (!children.length) children.push(new Paragraph(""));
    sections.push({
      properties: {
        page: {
          size: { width: pageW, height: pageH },
          margin: {
            top: Math.round(margins.top * TWIP), right: Math.round(margins.right * TWIP),
            bottom: Math.round(margins.bottom * TWIP), left: Math.round(margins.left * TWIP),
            header: 0, footer: 0, gutter: 0,
          },
        },
      },
      children,
    });
    try { page.destroy?.(); } catch {}
    // Let the window repaint between pages on long documents.
    await new Promise((r) => setTimeout(r, 0));
  }
  onProgress?.(n, n);
  try { doc.destroy?.(); } catch {}
  const word = new Document({
    creator: "PDF Markup",
    styles: { default: { document: { run: { font: "Arial" } } } },
    sections,
  });
  const out = new Uint8Array(await Packer.toArrayBuffer(word));
  return { bytes: out, pages: n, scannedPages };
}
