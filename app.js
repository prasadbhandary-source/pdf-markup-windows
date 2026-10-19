// PDF Markup — the window: viewer, tools and annotation editing.
import * as pdfjsLib from "./vendor/pdfjs/build/pdf.min.mjs";
import { api } from "./platform.js";

const PDFJS = new URL("./vendor/pdfjs/", import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + "build/pdf.worker.min.mjs";
const $ = (id) => document.getElementById(id);

// ---- constants (shared with the Android app) ----------------------------------------
const PEN_COLORS = [0xff111111, 0xffd32f2f, 0xff1e5bd8, 0xff2e7d32, 0xff8e24aa, 0xffef6c00].map((c) => c | 0);
const HL_COLORS = [0xffffeb3b, 0xff76ff03, 0xff40c4ff, 0xffff80ab, 0xffffab40].map((c) => c | 0);
const HIGHLIGHT_ALPHA = 0.4;
const LINE_HEIGHT = 1.25;
const ASCENT = 0.95;
const TEXT_PAD = 2;
const MIN_SCALE = 0.25;
const MAX_SCALE = 6;
const MAX_CANVAS_PIXELS = 16_000_000;

// ---- settings --------------------------------------------------------------------------
const settings = Object.assign(
  { penColor: PEN_COLORS[2], penWidth: 2, hlColor: HL_COLORS[0], hlWidth: 14, textColor: PEN_COLORS[1], textSize: 14, fingerDraws: false },
  (() => { try { return JSON.parse(localStorage.getItem("settings") || "{}"); } catch { return {}; } })(),
);
const saveSettings = () => { try { localStorage.setItem("settings", JSON.stringify(settings)); } catch {} };

// ---- document state --------------------------------------------------------------------
/** @type {null | {id:number, name:string, path:string, pdf:any, sizes:{width:number,height:number}[], pages:any[]}} */
let doc = null;
let marks = [];
let undoStack = [];
let redoStack = [];
let dirty = false;
let scale = 1;
let fitWidth = true;
let tool = "hand";
let selectedId = null;

const viewer = $("viewer");
const pagesEl = $("pages");

// ---- helpers ---------------------------------------------------------------------------
function css(c, alpha = 1) {
  const u = c >>> 0;
  return `rgba(${(u >>> 16) & 255},${(u >>> 8) & 255},${u & 255},${alpha})`;
}
const newId = () => Math.floor(Math.random() * Number.MAX_SAFE_INTEGER) + 1;
const round2 = (v) => Math.round(v * 100) / 100;

let toastTimer = 0;
function toast(msg, ms = 3200) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function busy(text) {
  $("busy").hidden = !text;
  if (text) $("busy-text").textContent = text;
}
function showDialog(dlg) {
  return new Promise((resolve) => {
    dlg.returnValue = "";
    dlg.addEventListener("close", () => resolve(dlg.returnValue), { once: true });
    dlg.showModal();
  });
}
// Non-primary buttons close their dialog with their value; Enter triggers the primary button.
for (const dlg of document.querySelectorAll("dialog")) {
  for (const b of dlg.querySelectorAll("button:not(.primary)")) {
    b.type = "button";
    b.addEventListener("click", () => dlg.close(b.value));
  }
}
async function info(title, html) {
  $("info-title").textContent = title;
  $("info-msg").innerHTML = html;
  await showDialog($("info-dlg"));
}
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ---- mark geometry ---------------------------------------------------------------------
const measureCtx = document.createElement("canvas").getContext("2d");
const fontFor = (size) => `${size}px Arial, "Segoe UI", sans-serif`;
const linesOf = (m) => String(m.txt).split("\n");

function textBounds(m) {
  measureCtx.font = fontFor(m.s);
  const w = Math.max(...linesOf(m).map((l) => measureCtx.measureText(l).width), m.s);
  return { l: m.x, t: m.y, r: m.x + w + 2 * TEXT_PAD, b: m.y + linesOf(m).length * m.s * LINE_HEIGHT + 2 * TEXT_PAD };
}
const baseline = (m, i) => m.y + TEXT_PAD + m.s * ASCENT + i * m.s * LINE_HEIGHT;

const pathCache = new WeakMap();
function inkPath(pts) {
  const p = new Path2D();
  const n = pts.length / 2;
  if (n === 0) return p;
  p.moveTo(pts[0], pts[1]);
  if (n === 1) { p.lineTo(pts[0] + 0.01, pts[1]); return p; }
  if (n === 2) { p.lineTo(pts[2], pts[3]); return p; }
  for (let i = 1; i < n - 1; i++) {
    const cx = pts[2 * i], cy = pts[2 * i + 1];
    const nx = pts[2 * i + 2], ny = pts[2 * i + 3];
    p.quadraticCurveTo(cx, cy, (cx + nx) / 2, (cy + ny) / 2);
  }
  p.lineTo(pts[2 * n - 2], pts[2 * n - 1]);
  return p;
}
function markPath(m) {
  let p = pathCache.get(m);
  if (!p) { p = inkPath(m.pts); pathCache.set(m, p); }
  return p;
}
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function hitMark(m, x, y, tol) {
  if (m.t === "text") {
    const b = textBounds(m);
    return x >= b.l - tol && x <= b.r + tol && y >= b.t - tol && y <= b.b + tol;
  }
  const reach = m.w / 2 + tol;
  const p = m.pts;
  if (p.length === 2) return Math.hypot(x - p[0], y - p[1]) <= reach;
  for (let i = 0; i + 3 < p.length; i += 2) {
    if (distToSeg(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]) <= reach) return true;
  }
  return false;
}
function simplify(pts, minDist) {
  if (pts.length <= 4) return pts;
  const out = [pts[0], pts[1]];
  for (let i = 2; i < pts.length - 2; i += 2) {
    if (Math.hypot(pts[i] - out[out.length - 2], pts[i + 1] - out[out.length - 1]) >= minDist) out.push(pts[i], pts[i + 1]);
  }
  out.push(pts[pts.length - 2], pts[pts.length - 1]);
  return out.map(round2);
}

// ---- edit history ----------------------------------------------------------------------
function setDirty(v) {
  dirty = v;
  $("dirty-dot").hidden = !v;
  api.setDirty(v);
  if (v) scheduleDraft();
}
function commit(before) {
  undoStack.push(before);
  if (undoStack.length > 300) undoStack.shift();
  redoStack = [];
  setDirty(true);
  updateHistoryButtons();
  redrawAll();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(marks);
  marks = undoStack.pop();
  setDirty(true);
  updateHistoryButtons();
  redrawAll();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(marks);
  marks = redoStack.pop();
  setDirty(true);
  updateHistoryButtons();
  redrawAll();
}
function updateHistoryButtons() {
  $("undo-btn").disabled = !undoStack.length;
  $("redo-btn").disabled = !redoStack.length;
}
let draftTimer = 0;
function scheduleDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => { if (doc && dirty) api.saveDraft(doc.path, marks); }, 800);
}

// ---- opening ---------------------------------------------------------------------------
async function confirmUnsaved(title) {
  if (!doc || !dirty) return true;
  $("confirm-title").textContent = title;
  $("confirm-msg").textContent = `You have annotations in “${doc.name}” that aren't saved to the PDF yet.`;
  const r = await showDialog($("confirm-dlg"));
  if (r === "save") return await save(false);
  if (r === "discard") { await api.clearDraft(doc.path); return true; }
  return false;
}

async function askPassword(name, wrong) {
  $("password-msg").textContent = `“${name}” is password-protected.`;
  $("password-wrong").hidden = !wrong;
  $("password-input").value = "";
  setTimeout(() => $("password-input").focus(), 50);
  const r = await showDialog($("password-dlg"));
  return r === "ok" ? $("password-input").value : null;
}

async function loadPdfjs(bytes) {
  const task = pdfjsLib.getDocument({
    // pdf.js takes ownership of the buffer it's given, so hand it a copy and keep the original for saving.
    data: new Uint8Array(bytes),
    cMapUrl: PDFJS + "cmaps/",
    cMapPacked: true,
    standardFontDataUrl: PDFJS + "standard_fonts/",
    wasmUrl: PDFJS + "wasm/",
    iccUrl: PDFJS + "iccs/",
    isEvalSupported: false,
    enableXfa: false,
  });
  return await task.promise;
}

async function openPath(path) {
  if (!path) return;
  if (!(await confirmUnsaved("Save before opening another file?"))) return;
  const name = api.nameOf(path);
  let password = null;
  let r;
  busy(`Opening ${name}…`);
  try {
    for (;;) {
      r = await api.openFile(path, password);
      if (r.status !== "password") break;
      busy(null);
      password = await askPassword(name, r.wrong);
      if (password == null) return;
      busy(`Opening ${name}…`);
    }
    if (r.status === "error") {
      busy(null);
      await info("Couldn't open the file", `<p>${escapeHtml(r.message)}</p>`);
      return;
    }
    let pdf;
    try {
      pdf = await loadPdfjs(r.viewBytes);
    } catch (e) {
      console.warn("Viewer couldn't read the file, repairing", e);
      pdf = await loadPdfjs(await api.repairView(r.id));
    }
    closeDoc(false);
    showDocument(r, pdf);
    if (r.restored) toast("Restored annotations you hadn't saved yet.");
  } catch (e) {
    console.error(e);
    await info("Couldn't open the file", `<p>${escapeHtml(e?.message || e)}</p>`);
  } finally {
    busy(null);
  }
}

function showDocument(r, pdf) {
  doc = { id: r.id, name: r.name, path: r.path, pdf, sizes: r.pageSizes, pages: [] };
  marks = r.marks || [];
  undoStack = [];
  redoStack = [];
  selectedId = null;
  setDirty(!!r.restored);
  updateHistoryButtons();
  $("home").hidden = true;
  $("doc").hidden = false;
  $("doc-name").textContent = r.name;
  $("page-count").textContent = r.pageSizes.length;
  api.setTitle(`${r.name} — PDF Markup`);

  pagesEl.innerHTML = "";
  doc.sizes.forEach((size, i) => {
    const el = document.createElement("div");
    el.className = "page";
    el.dataset.index = i;
    const overlay = document.createElement("canvas");
    overlay.className = "overlay";
    const num = document.createElement("span");
    num.className = "page-num";
    num.textContent = i + 1;
    el.append(overlay, num);
    pagesEl.append(el);
    doc.pages.push({ el, overlay, canvas: null, renderedScale: 0, task: null, visible: false });
    observer.observe(el);
  });
  fitWidth = true;
  scale = fitScale();
  layout();
  const start = Math.min(r.page || 0, doc.sizes.length - 1);
  viewer.scrollTop = start > 0 ? doc.pages[start].el.offsetTop - 12 : 0;
  viewer.scrollLeft = 0;
  viewer.focus();
  updatePageIndicator();
}

function closeDoc(showHome = true) {
  if (doc) {
    api.setPage(doc.path, currentPage());
    for (const pg of doc.pages) {
      observer.unobserve(pg.el);
      try { pg.task?.cancel(); } catch {}
    }
    try { doc.pdf.destroy(); } catch {}
  }
  doc = null;
  marks = [];
  pagesEl.innerHTML = "";
  setDirty(false);
  if (showHome) {
    $("doc").hidden = true;
    $("home").hidden = false;
    api.setTitle("PDF Markup");
    refreshRecents();
  }
}

// ---- layout & zoom -------------------------------------------------------------------
function fitScale() {
  const maxW = Math.max(...doc.sizes.map((s) => s.width));
  const avail = viewer.clientWidth - 48 - 4;
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, avail / maxW));
}

function layout() {
  doc.pages.forEach((pg, i) => {
    const s = doc.sizes[i];
    pg.el.style.width = `${Math.round(s.width * scale)}px`;
    pg.el.style.height = `${Math.round(s.height * scale)}px`;
  });
  $("zoom-label").textContent = `${Math.round(scale * 100)}%`;
  scheduleRender();
}

function pageAt(clientX, clientY, slack = 0) {
  if (!doc) return null;
  for (const pg of doc.pages) {
    if (!pg.visible) continue;
    const r = pg.el.getBoundingClientRect();
    if (clientX >= r.left - slack && clientX <= r.right + slack && clientY >= r.top - slack && clientY <= r.bottom + slack) {
      const i = Number(pg.el.dataset.index);
      return { i, x: (clientX - r.left) / scale, y: (clientY - r.top) / scale };
    }
  }
  return null;
}

/** Zooms keeping the point under (clientX, clientY) — or the centre — in place. */
function setScale(newScale, clientX, clientY) {
  if (!doc) return;
  newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
  if (Math.abs(newScale - scale) < 1e-4) return;
  const vr = viewer.getBoundingClientRect();
  if (clientX == null) { clientX = vr.left + vr.width / 2; clientY = vr.top + vr.height / 2; }
  let anchor = pageAt(clientX, clientY, 7);
  if (!anchor) {
    // between pages: use the nearest page
    const i = currentPage();
    const r = doc.pages[i].el.getBoundingClientRect();
    anchor = { i, x: (clientX - r.left) / scale, y: (clientY - r.top) / scale };
  }
  scale = newScale;
  fitWidth = false;
  layout();
  const el = doc.pages[anchor.i].el;
  viewer.scrollLeft = el.offsetLeft + anchor.x * scale - (clientX - vr.left);
  viewer.scrollTop = el.offsetTop + anchor.y * scale - (clientY - vr.top);
}
function zoomStep(dir) {
  const steps = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6];
  const next = dir > 0 ? steps.find((s) => s > scale + 0.001) : [...steps].reverse().find((s) => s < scale - 0.001);
  if (next) setScale(next);
}
function setFitWidth() {
  if (!doc) return;
  const i = currentPage();
  const el = doc.pages[i].el;
  const frac = (viewer.scrollTop - el.offsetTop) / el.offsetHeight;
  scale = fitScale();
  fitWidth = true;
  layout();
  viewer.scrollLeft = 0;
  viewer.scrollTop = el.offsetTop + frac * el.offsetHeight;
}
new ResizeObserver(() => {
  if (doc && fitWidth) setFitWidth();
}).observe(viewer);

function currentPage() {
  if (!doc) return 0;
  const vr = viewer.getBoundingClientRect();
  const mid = vr.top + vr.height * 0.4;
  let best = 0;
  for (const pg of doc.pages) {
    if (!pg.visible) continue;
    const r = pg.el.getBoundingClientRect();
    if (r.top <= mid) best = Number(pg.el.dataset.index);
    if (r.top > mid) break;
  }
  return best;
}
function updatePageIndicator() {
  if (!doc) return;
  if (document.activeElement !== $("page-input")) $("page-input").value = currentPage() + 1;
}
let scrollRaf = 0;
let pageSaveTimer = 0;
viewer.addEventListener("scroll", () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    updatePageIndicator();
    clearTimeout(pageSaveTimer);
    pageSaveTimer = setTimeout(() => { if (doc) api.setPage(doc.path, currentPage()); }, 1500);
  });
});
function goToPage(n) {
  if (!doc) return;
  const i = Math.max(0, Math.min(doc.pages.length - 1, n - 1));
  viewer.scrollTop = doc.pages[i].el.offsetTop - 12;
}

// ---- rendering -------------------------------------------------------------------------
const observer = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const i = Number(e.target.dataset.index);
    const pg = doc?.pages[i];
    if (!pg) continue;
    pg.visible = e.isIntersecting;
    if (!e.isIntersecting) releasePage(pg);
  }
  scheduleRender();
}, { root: viewer, rootMargin: "800px 400px" });

function releasePage(pg) {
  try { pg.task?.cancel(); } catch {}
  pg.task = null;
  if (pg.canvas) {
    pg.canvas.width = 0;
    pg.canvas.height = 0;
    pg.canvas.remove();
    pg.canvas = null;
  }
  pg.renderedScale = 0;
  pg.overlay.width = 0;
  pg.overlay.height = 0;
  pg.overlayScale = 0;
}

let renderTimer = 0;
let rendering = false;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderLoop, 120);
  // Overlays follow zoom immediately (cheap); page images catch up after.
  redrawAll();
}

async function renderLoop() {
  if (rendering || !doc) return;
  rendering = true;
  try {
    for (;;) {
      if (!doc) break;
      const cur = currentPage();
      const todo = doc.pages
        .map((pg, i) => ({ pg, i }))
        .filter(({ pg }) => pg.visible && Math.abs(pg.renderedScale - scale) > 1e-4)
        .sort((a, b) => Math.abs(a.i - cur) - Math.abs(b.i - cur));
      if (!todo.length) break;
      await renderPage(todo[0].i);
    }
  } finally {
    rendering = false;
  }
}

async function renderPage(i) {
  const d = doc;
  const pg = d.pages[i];
  const target = scale;
  try {
    const page = await d.pdf.getPage(i + 1);
    const dpr = window.devicePixelRatio || 1;
    const base = page.getViewport({ scale: 1 });
    let s = target * dpr;
    const px = base.width * s * base.height * s;
    if (px > MAX_CANVAS_PIXELS) s *= Math.sqrt(MAX_CANVAS_PIXELS / px);
    const vp = page.getViewport({ scale: s });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(vp.width));
    canvas.height = Math.max(1, Math.floor(vp.height));
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const task = page.render({ canvasContext: ctx, canvas, viewport: vp, background: "#ffffff" });
    pg.task = task;
    await task.promise;
    pg.task = null;
    if (doc !== d || !pg.visible) { canvas.width = 0; return; }
    if (pg.canvas) { pg.canvas.width = 0; pg.canvas.remove(); }
    pg.canvas = canvas;
    pg.el.insertBefore(canvas, pg.overlay);
    pg.renderedScale = target;
  } catch (e) {
    pg.task = null;
    if (e?.name !== "RenderingCancelledException") {
      console.warn("Page render failed", i, e);
      pg.renderedScale = target; // don't retry forever
    }
  }
}

// ---- drawing annotations -----------------------------------------------------------
let live = null; // { page, pts, color, width, highlighter }
let redrawRaf = 0;
function redrawAll() {
  if (redrawRaf) return;
  redrawRaf = requestAnimationFrame(() => {
    redrawRaf = 0;
    if (!doc) return;
    doc.pages.forEach((pg, i) => { if (pg.visible) drawOverlay(i); });
  });
}

function drawOverlay(i) {
  const pg = doc.pages[i];
  const size = doc.sizes[i];
  let k = scale * (window.devicePixelRatio || 1);
  const px = size.width * k * size.height * k;
  if (px > MAX_CANVAS_PIXELS) k *= Math.sqrt(MAX_CANVAS_PIXELS / px);
  const w = Math.max(1, Math.round(size.width * k));
  const h = Math.max(1, Math.round(size.height * k));
  const ov = pg.overlay;
  if (ov.width !== w || ov.height !== h) { ov.width = w; ov.height = h; }
  const ctx = ov.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.setTransform(w / size.width, 0, 0, h / size.height, 0, 0);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const m of marks) if (m.p === i) drawMark(ctx, m);
  if (live && live.page === i && live.pts.length) {
    drawInk(ctx, inkPath(live.pts), live.color, live.width, live.highlighter);
  }
}

function drawInk(ctx, path, color, width, highlighter) {
  ctx.lineWidth = width;
  ctx.strokeStyle = css(color, highlighter ? HIGHLIGHT_ALPHA : 1);
  ctx.stroke(path);
}

function drawMark(ctx, m) {
  if (m.t === "ink") {
    drawInk(ctx, markPath(m), m.c, m.w, m.h);
  } else if (m.t === "text") {
    if (m.id === selectedId) {
      const b = textBounds(m);
      ctx.save();
      ctx.setLineDash([3, 2]);
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = "#1e5bd8";
      ctx.strokeRect(b.l, b.t, b.r - b.l, b.b - b.t);
      ctx.restore();
    }
    ctx.font = fontFor(m.s);
    ctx.fillStyle = css(m.c);
    ctx.textBaseline = "alphabetic";
    linesOf(m).forEach((line, li) => ctx.fillText(line, m.x + TEXT_PAD, baseline(m, li)));
  }
}

// ---- pointer input -------------------------------------------------------------------
// Pen and mouse draw with the drawing tools; fingers scroll and pinch-zoom
// (or draw too, when "Draw with finger" is on). The Surface Pen's eraser end erases.
const touches = new Map();
let g = null; // the current gesture
let pinch = null;
let inertia = 0;

function stopInertia() { cancelAnimationFrame(inertia); inertia = 0; }

function startInertia(vx, vy) {
  stopInertia();
  let last = performance.now();
  const step = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    viewer.scrollLeft -= vx * dt;
    viewer.scrollTop -= vy * dt;
    const decay = Math.exp(-3.5 * dt);
    vx *= decay; vy *= decay;
    if (Math.abs(vx) > 20 || Math.abs(vy) > 20) inertia = requestAnimationFrame(step);
    else inertia = 0;
  };
  if (Math.abs(vx) > 150 || Math.abs(vy) > 150) inertia = requestAnimationFrame(step);
}

function cancelGesture() {
  if (!g) return;
  if (g.mode === "draw") { live = null; redrawAll(); }
  if ((g.mode === "erase" || g.mode === "text-drag") && g.changed) { marks = g.before; redrawAll(); }
  g = null;
}

function eraseAt(clientX, clientY) {
  const hit = pageAt(clientX, clientY);
  if (!hit) return;
  const tol = 8 / scale;
  const keep = marks.filter((m) => !(m.p === hit.i && hitMark(m, hit.x, hit.y, tol)));
  if (keep.length !== marks.length) {
    marks = keep;
    g.changed = true;
    redrawAll();
  }
}

viewer.addEventListener("pointerdown", (e) => {
  if (!doc || e.button === 2) return;
  stopInertia();
  if (e.pointerType === "touch") {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) {
      cancelGesture();
      const [a, b] = [...touches.values()];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, scale };
      viewer.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (touches.size > 2 || pinch) return;
  }
  if (g) return;

  const penEraser = e.pointerType === "pen" && (e.button === 5 || (e.buttons & 32) !== 0);
  const effTool = penEraser ? "eraser" : tool;
  const fingerBlocked = e.pointerType === "touch" && !settings.fingerDraws;
  const base = { id: e.pointerId, type: e.pointerType, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, moved: 0, samples: [] };

  if (e.button === 1) {
    g = { ...base, mode: "pan" };
  } else if ((effTool === "pen" || effTool === "highlight") && !fingerBlocked) {
    const hit = pageAt(e.clientX, e.clientY, 20);
    if (hit) {
      const hl = effTool === "highlight";
      live = {
        page: hit.i, pts: [hit.x, hit.y],
        color: hl ? settings.hlColor : settings.penColor,
        width: hl ? settings.hlWidth : settings.penWidth,
        highlighter: hl,
      };
      g = { ...base, mode: "draw" };
      redrawAll();
    } else g = { ...base, mode: "pan" };
  } else if (effTool === "eraser" && !fingerBlocked) {
    g = { ...base, mode: "erase", before: marks, changed: false };
    eraseAt(e.clientX, e.clientY);
  } else if (effTool === "text") {
    const hit = pageAt(e.clientX, e.clientY);
    let note = null;
    if (hit) {
      const tol = 4 / scale;
      note = [...marks].reverse().find((m) => m.t === "text" && m.p === hit.i && hitMark(m, hit.x, hit.y, tol)) || null;
    }
    g = { ...base, mode: "text-pending", hit, note, before: marks };
  } else {
    g = { ...base, mode: "pan" };
  }
  if (g.mode === "pan" && e.pointerType === "mouse") viewer.classList.add("grabbing");
  viewer.setPointerCapture(e.pointerId);
  e.preventDefault();
});

viewer.addEventListener("pointermove", (e) => {
  if (e.pointerType === "touch" && touches.has(e.pointerId)) {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && touches.size >= 2) {
      const [a, b] = [...touches.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      viewer.scrollLeft -= mx - pinch.mx;
      viewer.scrollTop -= my - pinch.my;
      if (pinch.dist > 10) setScale(pinch.scale * (dist / pinch.dist), mx, my);
      pinch.mx = mx; pinch.my = my;
      return;
    }
  }
  if (!g || e.pointerId !== g.id) return;
  const dx = e.clientX - g.lx, dy = e.clientY - g.ly;
  g.moved += Math.hypot(dx, dy);
  g.lx = e.clientX; g.ly = e.clientY;

  if (g.mode === "draw") {
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const pg = doc.pages[live.page].el.getBoundingClientRect();
    for (const ce of events.length ? events : [e]) {
      live.pts.push((ce.clientX - pg.left) / scale, (ce.clientY - pg.top) / scale);
    }
    redrawAll();
  } else if (g.mode === "erase") {
    eraseAt(e.clientX, e.clientY);
  } else if (g.mode === "pan") {
    viewer.scrollLeft -= dx;
    viewer.scrollTop -= dy;
    g.samples.push({ t: e.timeStamp, dx, dy });
    if (g.samples.length > 6) g.samples.shift();
  } else if (g.mode === "text-pending" || g.mode === "text-drag") {
    if (g.mode === "text-pending" && g.moved > 6) {
      if (g.note) {
        g.mode = "text-drag";
        selectedId = g.note.id;
      } else {
        g.mode = "pan";
        return;
      }
    }
    if (g.mode === "text-drag") {
      const ox = (e.clientX - g.sx) / scale, oy = (e.clientY - g.sy) / scale;
      const moved = { ...g.note, x: round2(g.note.x + ox), y: round2(g.note.y + oy) };
      marks = g.before.map((m) => (m.id === g.note.id ? moved : m));
      g.changed = true;
      redrawAll();
    }
  }
});

function endPointer(e, cancelled) {
  if (e.pointerType === "touch") {
    touches.delete(e.pointerId);
    if (pinch) {
      if (touches.size < 2) pinch = null;
      if (touches.size === 0) g = null;
      return;
    }
  }
  if (!g || e.pointerId !== g.id) return;
  viewer.classList.remove("grabbing");
  const gesture = g;
  g = null;
  if (cancelled) { g = gesture; cancelGesture(); return; }

  if (gesture.mode === "draw") {
    const l = live;
    live = null;
    if (l && l.pts.length) {
      const before = marks;
      marks = [...marks, {
        t: "ink", id: newId(), p: l.page, c: l.color, w: l.width, h: l.highlighter,
        pts: simplify(l.pts, 0.5 / scale),
      }];
      commit(before);
    } else redrawAll();
  } else if (gesture.mode === "erase") {
    if (gesture.changed) commit(gesture.before);
  } else if (gesture.mode === "text-drag") {
    if (gesture.changed) commit(gesture.before);
    selectedId = null;
    redrawAll();
  } else if (gesture.mode === "text-pending") {
    if (gesture.hit) editText(gesture.hit, gesture.note);
  } else if (gesture.mode === "pan" && gesture.type === "touch") {
    const s = gesture.samples;
    if (s.length >= 2) {
      const dt = (s[s.length - 1].t - s[0].t) / 1000;
      if (dt > 0 && e.timeStamp - s[s.length - 1].t < 80) {
        const sx = s.slice(1).reduce((a, v) => a + v.dx, 0);
        const sy = s.slice(1).reduce((a, v) => a + v.dy, 0);
        startInertia(sx / dt, sy / dt);
      }
    }
  }
}
viewer.addEventListener("pointerup", (e) => endPointer(e, false));
viewer.addEventListener("pointercancel", (e) => endPointer(e, true));

// Ctrl + mouse wheel and touchpad pinch zoom around the pointer.
viewer.addEventListener("wheel", (e) => {
  if (!doc) return;
  stopInertia();
  if (e.ctrlKey) {
    e.preventDefault();
    const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025));
    setScale(scale * f, e.clientX, e.clientY);
  }
}, { passive: false });

// ---- text notes ----------------------------------------------------------------------
let textColor = settings.textColor;
async function editText(hit, note) {
  selectedId = note?.id ?? null;
  redrawAll();
  $("text-dlg-title").textContent = note ? "Edit text" : "Add text";
  $("text-input").value = note ? note.txt : "";
  $("text-delete").hidden = !note;
  textColor = note ? note.c : settings.textColor;
  $("text-size").value = note ? note.s : settings.textSize;
  $("text-size-value").textContent = $("text-size").value;
  buildSwatches($("text-swatches"), PEN_COLORS, () => textColor, (c) => { textColor = c; });
  setTimeout(() => $("text-input").focus(), 50);
  const r = await showDialog($("text-dlg"));
  selectedId = null;
  const txt = $("text-input").value.replace(/\s+$/, "");
  const size = Number($("text-size").value);
  const before = marks;
  if (r === "delete" && note) {
    marks = marks.filter((m) => m.id !== note.id);
    commit(before);
  } else if (r === "ok") {
    settings.textColor = textColor;
    settings.textSize = size;
    saveSettings();
    refreshToolUi();
    if (note) {
      marks = txt.trim()
        ? marks.map((m) => (m.id === note.id ? { ...m, txt, c: textColor, s: size } : m))
        : marks.filter((m) => m.id !== note.id);
      commit(before);
    } else if (txt.trim()) {
      marks = [...marks, {
        t: "text", id: newId(), p: hit.i, x: round2(hit.x), y: round2(hit.y - size * 0.6), s: size, c: textColor, txt,
      }];
      commit(before);
    }
  }
  redrawAll();
}
$("text-size").addEventListener("input", () => { $("text-size-value").textContent = $("text-size").value; });
$("text-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); $("text-dlg").close("ok"); }
});

// ---- tools UI --------------------------------------------------------------------------
function buildSwatches(container, colors, get, set) {
  container.innerHTML = "";
  for (const c of colors) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch" + (c === get() ? " active" : "");
    b.style.background = css(c);
    b.title = "Colour";
    b.addEventListener("click", () => {
      set(c);
      for (const s of container.children) s.classList.toggle("active", s === b);
    });
    container.append(b);
  }
}

const HINTS = {
  hand: "Drag to move around. Ctrl + scroll or pinch to zoom.",
  pen: "Write with the pen or mouse.",
  highlight: "Drag over text to highlight it.",
  text: "Click the page to add a note. Click a note to edit it, drag to move it.",
  eraser: "Drag over ink, highlights or notes to erase them.",
};

function refreshToolUi() {
  for (const b of document.querySelectorAll("button.tool")) b.classList.toggle("active", b.dataset.tool === tool);
  viewer.className = { hand: "grab", pen: "draw", highlight: "draw", text: "text", eraser: "erase" }[tool];
  const sw = $("swatches");
  const slider = $("size-slider");
  const group = $("size-group");
  sw.hidden = false;
  group.hidden = false;
  if (tool === "pen") {
    buildSwatches(sw, PEN_COLORS, () => settings.penColor, (c) => { settings.penColor = c; saveSettings(); });
    Object.assign(slider, { min: 0.5, max: 10, step: 0.5 });
    slider.value = settings.penWidth;
    $("size-label").textContent = "Thickness";
  } else if (tool === "highlight") {
    buildSwatches(sw, HL_COLORS, () => settings.hlColor, (c) => { settings.hlColor = c; saveSettings(); });
    Object.assign(slider, { min: 6, max: 36, step: 1 });
    slider.value = settings.hlWidth;
    $("size-label").textContent = "Thickness";
  } else if (tool === "text") {
    buildSwatches(sw, PEN_COLORS, () => settings.textColor, (c) => { settings.textColor = c; saveSettings(); });
    Object.assign(slider, { min: 8, max: 40, step: 1 });
    slider.value = settings.textSize;
    $("size-label").textContent = "Size";
  } else {
    sw.hidden = true;
    group.hidden = true;
  }
  $("size-value").textContent = slider.value;
  $("tool-hint").textContent = HINTS[tool];
  $("finger-draws").checked = settings.fingerDraws;
}
$("size-slider").addEventListener("input", () => {
  const v = Number($("size-slider").value);
  if (tool === "pen") settings.penWidth = v;
  else if (tool === "highlight") settings.hlWidth = v;
  else if (tool === "text") settings.textSize = v;
  $("size-value").textContent = v;
  saveSettings();
});
$("finger-draws").addEventListener("change", () => {
  settings.fingerDraws = $("finger-draws").checked;
  saveSettings();
});
function setTool(t) {
  tool = t;
  refreshToolUi();
}
for (const b of document.querySelectorAll("button.tool")) b.addEventListener("click", () => setTool(b.dataset.tool));

// ---- save / share ----------------------------------------------------------------------
async function save(saveAs) {
  if (!doc) return false;
  busy(saveAs ? null : "Saving…");
  try {
    const r = await api.save(doc.id, marks, doc.sizes, saveAs);
    if (r.status === "cancelled") return false;
    if (r.status === "error") {
      busy(null);
      await info("Couldn't save", `<p>${escapeHtml(r.message)}</p>`);
      return false;
    }
    doc.path = r.path;
    doc.name = r.name;
    $("doc-name").textContent = r.name;
    api.setTitle(`${r.name} — PDF Markup`);
    setDirty(false);
    if (r.downloaded) {
      await info("Saved to Downloads", `<p>Your browser can't save straight into files, so the annotated PDF was saved to your Downloads folder as “${escapeHtml(r.downloaded)}”.</p>`);
      setDirty(false);
      return true;
    }
    toast(saveAs ? `Saved a copy: ${r.name}` : "Saved");
    return true;
  } finally {
    busy(null);
  }
}

async function sendWhatsApp() {
  if (!doc) return;
  busy("Preparing…");
  let r;
  try {
    r = await api.sendWhatsApp(doc.id, marks, doc.sizes);
  } finally {
    busy(null);
  }
  if (r.status === "cancelled" || (r.status === "ok" && r.shared)) return;
  if (r.status === "retry") {
    // The share window needs a fresh click.
    await info("Ready to share", `<p>Click <b>OK</b>, then pick <b>WhatsApp</b> in the Share window.</p>`);
    await api.shareNow(r.file);
    return;
  }
  if (r.status !== "ok") {
    await info("Couldn't send", `<p>${escapeHtml(r.message)}</p>`);
    return;
  }
  await info("Send in WhatsApp", `
    <p>The PDF${marks.length ? ", with your annotations," : ""} was saved to your Downloads folder as “${escapeHtml(r.downloaded)}”, and WhatsApp Web is opening.</p>
    <p>Open the chat you want, drag the file in (or click the paperclip and pick it), then press <b>Send</b>.</p>`);
}

async function prepareFile() {
  busy("Preparing…");
  try {
    return api.exportFile(doc.id, marks, doc.sizes);
  } catch (e) {
    await info("Couldn't prepare the file", `<p>${escapeHtml(e?.message || e)}</p>`);
    return null;
  } finally {
    busy(null);
  }
}

async function sendGmail() {
  if (!doc) return;
  const file = await prepareFile();
  if (!file) return;
  await api.downloadFile(file);
  const subject = encodeURIComponent(file.name.replace(/\.pdf$/i, ""));
  api.openLink(`https://mail.google.com/mail/?view=cm&fs=1&su=${subject}`);
  await info("Send by Gmail", `
    <p>A new Gmail message is opening, and the PDF${marks.length ? " with your annotations" : ""} was saved to your Downloads folder as “${escapeHtml(file.name)}”.</p>
    <ol><li>In the message, click the <b>paperclip</b> (Attach files).</li>
    <li>Pick “${escapeHtml(file.name)}” from <b>Downloads</b>, or drag it in from the browser's download list.</li>
    <li>Add the recipient and press <b>Send</b>.</li></ol>`);
}

async function sendOutlook() {
  if (!doc) return;
  const file = await prepareFile();
  if (!file) return;
  if (api.canShareFile(file)) {
    // Windows Share window: Outlook attaches the file itself.
    let r = await api.shareNow(file);
    if (r === "blocked") {
      await info("Send by Outlook", `<p>Click <b>OK</b>, then pick <b>Outlook</b> in the Share window. The PDF will already be attached.</p>`);
      r = await api.shareNow(file);
    }
    if (r === "ok" || r === "cancelled") return;
  }
  await api.downloadFile(file);
  const subject = encodeURIComponent(file.name.replace(/\.pdf$/i, ""));
  api.openLink(`https://outlook.live.com/mail/0/deeplink/compose?subject=${subject}`);
  await info("Send by Outlook", `
    <p>A new Outlook message is opening on the web, and the PDF was saved to your Downloads folder as “${escapeHtml(file.name)}”.</p>
    <ol><li>Click <b>Attach</b> (paperclip) → <b>Browse this computer</b>.</li>
    <li>Pick the file from <b>Downloads</b>, add the recipient and press <b>Send</b>.</li></ol>`);
}

async function convertToWord() {
  if (!doc) return;
  busy("Converting to Word…");
  let r;
  try {
    r = await api.convertToWord(doc.id, (i, n) => busy(n > 1 ? `Converting page ${Math.min(i + 1, n)} of ${n}…` : "Converting to Word…"));
  } finally {
    busy(null);
  }
  if (r.status === "cancelled") return;
  if (r.status !== "ok") {
    await info("Couldn't convert", `<p>${escapeHtml(r.message)}</p>`);
    return;
  }
  const where = r.downloaded ? `to your Downloads folder as “${escapeHtml(r.name)}”` : `as “${escapeHtml(r.name)}”`;
  const notes = [];
  if (r.scannedPages) {
    notes.push(r.scannedPages === r.pages
      ? "This PDF is a scan or picture, so its pages went in as pictures — the text isn't editable."
      : `${r.scannedPages} of the ${r.pages} pages ${r.scannedPages === 1 ? "is a scan, so it went in as a picture" : "are scans, so they went in as pictures"}.`);
  }
  if (marks.length) notes.push("Your pen marks, highlights and notes aren't included — the Word file has the document's own content.");
  await info("Converted to Word", `<p>Saved ${where}. Open it in Word to edit.</p>
    ${notes.map((n) => `<p class="muted small">${n}</p>`).join("")}
    <p class="muted small">Layouts with columns or tables may need some tidying in Word.</p>`);
}

$("word-btn").addEventListener("click", convertToWord);
$("gmail-btn").addEventListener("click", sendGmail);
$("outlook-btn").addEventListener("click", sendOutlook);
$("save-btn").addEventListener("click", () => save(false));
$("saveas-btn").addEventListener("click", () => save(true));
$("wa-btn").addEventListener("click", sendWhatsApp);
$("undo-btn").addEventListener("click", undo);
$("redo-btn").addEventListener("click", redo);
$("zoom-in").addEventListener("click", () => zoomStep(1));
$("zoom-out").addEventListener("click", () => zoomStep(-1));
$("zoom-label").addEventListener("click", setFitWidth);
$("home-btn").addEventListener("click", async () => {
  if (await confirmUnsaved("Save before closing?")) closeDoc(true);
});
$("page-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    goToPage(parseInt($("page-input").value, 10) || 1);
    viewer.focus();
  }
});
$("page-input").addEventListener("blur", updatePageIndicator);

// ---- keyboard --------------------------------------------------------------------------
window.addEventListener("keydown", (e) => {
  if (document.querySelector("dialog[open]")) return;
  const inField = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || "");
  const k = e.key.toLowerCase();
  if (e.ctrlKey && k === "o") { e.preventDefault(); pickAndOpen(); return; }
  if (!doc) return;
  if (e.ctrlKey && k === "s") { e.preventDefault(); save(e.shiftKey); return; }
  if (inField) return;
  if (e.ctrlKey && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (e.ctrlKey && k === "y") { e.preventDefault(); redo(); return; }
  if (e.ctrlKey && (k === "=" || k === "+")) { e.preventDefault(); zoomStep(1); return; }
  if (e.ctrlKey && k === "-") { e.preventDefault(); zoomStep(-1); return; }
  if (e.ctrlKey && k === "0") { e.preventDefault(); setFitWidth(); return; }
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const map = { v: "hand", p: "pen", h: "highlight", t: "text", e: "eraser", escape: "hand" };
  if (map[k]) { setTool(map[k]); return; }
  if (k === "home") { goToPage(1); e.preventDefault(); }
  if (k === "end") { goToPage(doc.pages.length); e.preventDefault(); }
});

// ---- home / recents ------------------------------------------------------------------
async function pickAndOpen() {
  const p = await api.pickFile();
  if (p) openPath(p);
}
$("open-btn").addEventListener("click", pickAndOpen);

function timeAgo(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString();
}

async function refreshRecents() {
  const items = await api.recents();
  const ul = $("recent-list");
  ul.innerHTML = "";
  $("recent-title").hidden = items.length === 0;
  for (const r of items) {
    const li = document.createElement("li");
    li.innerHTML = `
      <svg class="file-ico" viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zM13 9V3.5L18.5 9H13z"/></svg>
      <div class="meta"><div class="name"></div><div class="sub"></div></div>
      <button class="icon" title="Remove from list"><svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>`;
    li.querySelector(".name").textContent = r.name;
    li.querySelector(".sub").textContent = `${timeAgo(r.time)}${r.page ? ` · page ${r.page + 1}` : ""}`;
    li.addEventListener("click", () => openPath(r.path));
    li.querySelector("button").addEventListener("click", async (e) => {
      e.stopPropagation();
      await api.removeRecent(r.path);
      refreshRecents();
    });
    ul.append(li);
  }
}

// ---- drag and drop ---------------------------------------------------------------------
let dragDepth = 0;
window.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; $("drop-hint").hidden = false; });
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("drop-hint").hidden = true; } });
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("drop-hint").hidden = true;
  api.refFromDrop(e.dataTransfer).then((ref) => { if (ref) openPath(ref); });
});

// ---- window events ---------------------------------------------------------------------
api.onOpenRequest((p) => openPath(p));
api.onCloseRequested(async () => {
  if (await confirmUnsaved("Save before closing?")) api.forceClose();
});

// ---- install & offline -----------------------------------------------------------------
let installPrompt = null;
const installed = () => matchMedia("(display-mode: standalone)").matches;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  $("install-card").hidden = installed();
});
window.addEventListener("appinstalled", () => { $("install-card").hidden = true; installPrompt = null; });
$("install-btn").addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  $("install-card").hidden = true;
});
if (installed()) $("install-tip").innerHTML = "You can also right-click a PDF in File Explorer and choose <b>Open with → PDF Markup</b>.";
if ("serviceWorker" in navigator && location.protocol === "https:") {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" })
    .then((reg) => reg.update())
    .catch((e) => console.warn("Offline support unavailable", e));
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) return; // first install, nothing to refresh
    if (dirty) toast("An update is ready. Save your work, then close and reopen PDF Markup.", 8000);
    else location.reload();
  });
}
fetch("version.txt", { cache: "no-store" }).then((r) => (r.ok ? r.text() : "")).then((v) => {
  if (v.trim()) $("version").textContent = `Version ${v.trim()}`;
}).catch(() => {});

// ---- start ---------------------------------------------------------------------------
refreshToolUi();
updateHistoryButtons();
refreshRecents();
api.initialFile().then((p) => { if (p) openPath(p); });

// For automated checks.
window.__pdfMarkup = {
  get state() { return { doc: doc && { name: doc.name, pages: doc.pages.length }, marks, dirty, scale, tool }; },
  openPath, setTool, save,
};
