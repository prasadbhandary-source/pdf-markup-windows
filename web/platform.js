// Browser implementation of the app's file, storage and sharing functions.
// Files are "refs": { handle?: FileSystemFileHandle, file?: File, key?: number, name }.
// A handle lets the app save back into the original file; a plain File can only be saved as a copy.

import { openForView, writeAnnotated, repairForView } from "./pdfcore.js";

// ---- tiny IndexedDB wrapper ------------------------------------------------------------
const dbp = new Promise((resolve, reject) => {
  const req = indexedDB.open("pdf-markup", 1);
  req.onupgradeneeded = () => {
    const db = req.result;
    db.createObjectStore("recents", { keyPath: "key", autoIncrement: true });
    db.createObjectStore("drafts");
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function tx(store, mode, fn) {
  const db = await dbp;
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const idbAll = (store) => tx(store, "readonly", (s) => s.getAll());
const idbGet = (store, key) => tx(store, "readonly", (s) => s.get(key));
const idbPut = (store, value, key) => tx(store, "readwrite", (s) => (key === undefined ? s.put(value) : s.put(value, key)));
const idbDelete = (store, key) => tx(store, "readwrite", (s) => s.delete(key));

// ---- helpers -------------------------------------------------------------------------
const hasPickers = "showOpenFilePicker" in window;
const docs = new Map();
let nextDocId = 1;
let pendingLaunch = null;
let openRequestCb = null;
let dirty = false;
let appStarted = false;

async function ensurePermission(handle, mode) {
  if (typeof handle.queryPermission !== "function") return true;
  try {
    if ((await handle.queryPermission({ mode })) === "granted") return true;
    return (await handle.requestPermission({ mode })) === "granted";
  } catch {
    return false;
  }
}

async function findRecent(ref) {
  if (ref.key != null) return idbGet("recents", ref.key);
  if (!ref.handle) return null;
  for (const r of await idbAll("recents")) {
    try {
      if (r.handle && (await r.handle.isSameEntry(ref.handle))) return r;
    } catch {}
  }
  return null;
}

async function remember(ref) {
  if (!ref.handle) return; // only files the app can reopen go into Recent
  const existing = await findRecent(ref);
  const rec = { ...(existing || { page: 0 }), handle: ref.handle, name: ref.name, time: Date.now() };
  const key = await idbPut("recents", rec);
  ref.key = existing?.key ?? key;
  // keep the list short
  const all = (await idbAll("recents")).sort((a, b) => b.time - a.time);
  for (const r of all.slice(30)) await idbDelete("recents", r.key);
}

function draftKey(ref) {
  return ref.key != null ? `r${ref.key}` : null;
}

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const pdfName = (n) => (/\.pdf$/i.test(n) ? n : n + ".pdf");

// ---- the API used by app.js -------------------------------------------------------------
export const api = {
  nameOf: (ref) => ref?.name || "Document.pdf",

  initialFile: async () => {
    appStarted = true;
    const r = pendingLaunch;
    pendingLaunch = null;
    return r;
  },

  pickFile: async () => {
    if (hasPickers) {
      try {
        const [handle] = await window.showOpenFilePicker({
          id: "pdf-markup-open",
          types: [{ description: "PDF files", accept: { "application/pdf": [".pdf"] } }],
        });
        return { handle, name: handle.name };
      } catch {
        return null; // cancelled
      }
    }
    // Fallback for browsers without file pickers.
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/pdf,.pdf";
      input.onchange = () => resolve(input.files[0] ? { file: input.files[0], name: input.files[0].name } : null);
      input.click();
    });
  },

  openFile: async (ref, password) => {
    let bytes;
    try {
      if (ref.handle) await ensurePermission(ref.handle, "read");
      const file = ref.handle ? await ref.handle.getFile() : ref.file;
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch (e) {
      return { status: "error", message: `Couldn't read the file: ${e?.message || e}` };
    }
    const r = openForView(bytes, password);
    if (r.status !== "ok") return r;
    const id = nextDocId++;
    docs.clear();
    // Keep a private copy for saving, so nothing the viewer does to its copy can affect it.
    docs.set(id, { ref, bytes: bytes.slice(), password: password || null });
    await remember(ref);
    let marks = r.marks;
    let restored = false;
    const dk = draftKey(ref);
    const draft = dk ? await idbGet("drafts", dk) : null;
    if (Array.isArray(draft)) {
      marks = draft.filter((m) => m.p < r.pageSizes.length);
      restored = true;
    }
    const page = (await findRecent(ref))?.page || 0;
    return {
      status: "ok", id, name: ref.name, path: ref,
      viewBytes: r.viewBytes === bytes ? bytes.slice() : r.viewBytes, marks, restored, pageSizes: r.pageSizes, page,
    };
  },

  repairView: async (id) => {
    const d = docs.get(id);
    return repairForView(d.bytes, d.password);
  },

  save: async (id, marks, sizes, saveAs) => {
    const d = docs.get(id);
    if (!d) return { status: "error", message: "The document is no longer open." };
    try {
      let target = saveAs ? null : d.ref.handle;
      if (target && !(await ensurePermission(target, "readwrite"))) {
        return { status: "error", message: "Permission to change this file wasn't given. Try “Save a copy”." };
      }
      if (!target) {
        if (!hasPickers) {
          const out = writeAnnotated(d.bytes, d.password, marks, sizes);
          const name = d.ref.name.replace(/\.pdf$/i, "") + " (annotated).pdf";
          download(out, name);
          return { status: "ok", path: d.ref, name: d.ref.name, downloaded: name };
        }
        try {
          target = await window.showSaveFilePicker({
            id: "pdf-markup-save",
            suggestedName: d.ref.name.replace(/\.pdf$/i, "") + " (annotated).pdf",
            types: [{ description: "PDF files", accept: { "application/pdf": [".pdf"] } }],
          });
        } catch {
          return { status: "cancelled" };
        }
      }
      const out = writeAnnotated(d.bytes, d.password, marks, sizes);
      const w = await target.createWritable();
      await w.write(out);
      await w.close();
      const oldDraft = draftKey(d.ref);
      if (oldDraft) await idbDelete("drafts", oldDraft);
      if (target !== d.ref.handle) {
        // Carry on editing the new copy.
        d.ref = { handle: target, name: target.name };
        await remember(d.ref);
      }
      return { status: "ok", path: d.ref, name: d.ref.name };
    } catch (e) {
      const locked = e?.name === "NoModificationAllowedError" || e?.name === "InvalidStateError";
      return {
        status: "error",
        message: locked
          ? "Windows wouldn't let the app write to this file. It may be open in another program or read-only. Try “Save a copy”."
          : `Couldn't save: ${e?.message || e}`,
      };
    }
  },

  /** Shares through the Windows Share window (WhatsApp is listed there when installed). */
  sendWhatsApp: async (id, marks, sizes) => {
    const d = docs.get(id);
    if (!d) return { status: "error", message: "The document is no longer open." };
    let out;
    try {
      out = writeAnnotated(d.bytes, d.password, marks, sizes);
    } catch (e) {
      return { status: "error", message: `Couldn't prepare the file: ${e?.message || e}` };
    }
    const file = new File([out], pdfName(d.ref.name), { type: "application/pdf" });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: file.name });
        return { status: "ok", shared: true };
      } catch (e) {
        if (e?.name === "AbortError") return { status: "cancelled" };
        if (e?.name === "NotAllowedError") return { status: "retry", file };
        // fall through to the download route
      }
    }
    download(out, file.name);
    window.open("https://web.whatsapp.com/", "_blank", "noopener");
    return { status: "ok", downloaded: file.name };
  },

  /** Converts the open PDF to Word and saves it. Returns { status, name, pages, scannedPages }. */
  convertToWord: async (id, onProgress) => {
    const d = docs.get(id);
    if (!d) return { status: "error", message: "The document is no longer open." };
    const name = d.ref.name.replace(/\.pdf$/i, "") + ".docx";
    const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    // Ask where to save first, while the click still counts as the user's action.
    let target = null;
    if (hasPickers) {
      try {
        target = await window.showSaveFilePicker({
          id: "pdf-markup-word", suggestedName: name,
          types: [{ description: "Word document", accept: { [DOCX]: [".docx"] } }],
        });
      } catch {
        return { status: "cancelled" };
      }
    }
    try {
      const { pdfToDocx } = await import("./toword.js");
      const r = await pdfToDocx(d.bytes.slice(), d.password, onProgress);
      if (target) {
        const w = await target.createWritable();
        await w.write(r.bytes);
        await w.close();
      } else {
        const url = URL.createObjectURL(new Blob([r.bytes], { type: DOCX }));
        const a = document.createElement("a");
        a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      return { status: "ok", name: target?.name || name, downloaded: !target, pages: r.pages, scannedPages: r.scannedPages };
    } catch (e) {
      return { status: "error", message: `Couldn't convert: ${e?.message || e}` };
    }
  },

  /** The annotated PDF as a File, for sending. */
  exportFile: (id, marks, sizes) => {
    const d = docs.get(id);
    if (!d) throw new Error("The document is no longer open.");
    const out = writeAnnotated(d.bytes, d.password, marks, sizes);
    return new File([out], pdfName(d.ref.name), { type: "application/pdf" });
  },
  canShareFile: (file) => !!navigator.canShare?.({ files: [file] }),
  downloadFile: async (file) => download(new Uint8Array(await file.arrayBuffer()), file.name),
  openLink: (url) => window.open(url, "_blank", "noopener"),

  /** Opens the Windows Share window. Returns "ok", "cancelled", "blocked" (needs a fresh click) or "failed". */
  shareNow: async (file) => {
    try {
      await navigator.share({ files: [file], title: file.name });
      return "ok";
    } catch (e) {
      if (e?.name === "AbortError") return "cancelled";
      if (e?.name === "NotAllowedError") return "blocked";
      return "failed";
    }
  },

  recents: async () => {
    const all = (await idbAll("recents")).sort((a, b) => b.time - a.time);
    return all.map((r) => ({ path: { handle: r.handle, name: r.name, key: r.key }, name: r.name, time: r.time, page: r.page || 0 }));
  },
  removeRecent: async (ref) => {
    if (ref.key != null) {
      await idbDelete("recents", ref.key);
      await idbDelete("drafts", `r${ref.key}`);
    }
  },
  setPage: async (ref, page) => {
    const r = await findRecent(ref).catch(() => null);
    if (r) { r.page = page; await idbPut("recents", r); }
  },
  saveDraft: async (ref, marks) => {
    const k = draftKey(ref);
    if (k) await idbPut("drafts", marks, k);
  },
  clearDraft: async (ref) => {
    const k = draftKey(ref);
    if (k) await idbDelete("drafts", k);
  },
  setDirty: (v) => { dirty = !!v; },
  forceClose: () => { dirty = false; },
  setTitle: (t) => { document.title = t; },

  /** Turns a dropped item into a ref, keeping the file handle when the browser gives one. */
  refFromDrop: async (dataTransfer) => {
    const items = [...(dataTransfer?.items || [])].filter((i) => i.kind === "file");
    for (const it of items) {
      if (it.getAsFileSystemHandle) {
        try {
          const h = await it.getAsFileSystemHandle();
          if (h?.kind === "file") return { handle: h, name: h.name };
        } catch {}
      }
    }
    const f = [...(dataTransfer?.files || [])].find((x) => /\.pdf$/i.test(x.name)) || dataTransfer?.files?.[0];
    return f ? { file: f, name: f.name } : null;
  },

  onOpenRequest: (cb) => { openRequestCb = cb; },
  onCloseRequested: () => {},
  canSaveInPlace: (ref) => !!ref?.handle,
};

// Files opened from File Explorer ("Open with → PDF Markup") arrive here.
if ("launchQueue" in window) {
  window.launchQueue.setConsumer((params) => {
    const h = params.files?.[0];
    if (!h) return;
    const ref = { handle: h, name: h.name };
    if (openRequestCb && appStarted) openRequestCb(ref);
    else pendingLaunch = ref;
  });
}

window.addEventListener("beforeunload", (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
