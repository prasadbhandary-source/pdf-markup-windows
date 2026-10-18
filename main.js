// PDF Markup — main process: windows, files, saving, sharing.
import { app, BrowserWindow, dialog, ipcMain, shell, Menu, nativeImage } from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openForView, writeAnnotated, repairForView } from "./pdfcore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {BrowserWindow | null} */
let win = null;
let dirty = false;
let pendingPath = null;
const docs = new Map(); // id -> { path, name, bytes, password }
let nextDocId = 1;

// ---- single instance: "Open with" on a second file goes to the running app ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    const file = pdfFromArgs(argv);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (file) win.webContents.send("open-request", file);
    }
  });
}

function pdfFromArgs(argv) {
  for (const a of argv.slice(1)) {
    if (a.startsWith("-")) continue;
    if (a.toLowerCase().endsWith(".pdf") && fs.existsSync(a)) return path.resolve(a);
  }
  return null;
}

// ---- small JSON stores in the user's app-data folder --------------------------------
const dataDir = () => app.getPath("userData");
const recentsFile = () => path.join(dataDir(), "recents.json");
const draftsDir = () => path.join(dataDir(), "drafts");

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  } catch (e) { console.warn(e); }
}
const listRecents = () => readJson(recentsFile(), []).filter((r) => fs.existsSync(r.path));
function addRecent(p) {
  const old = readJson(recentsFile(), []);
  const prev = old.find((r) => r.path === p);
  const next = [{ path: p, name: path.basename(p), page: prev?.page || 0, time: Date.now() },
    ...old.filter((r) => r.path !== p)].slice(0, 30);
  writeJson(recentsFile(), next);
}
const draftFile = (p) => path.join(draftsDir(), crypto.createHash("sha1").update(p.toLowerCase()).digest("hex") + ".json");

// ---- window ------------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 640,
    minHeight: 480,
    title: "PDF Markup",
    backgroundColor: "#f4f2f2",
    icon: path.join(__dirname, "renderer", "icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  // Links inside PDFs open in the normal browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());

  win.on("close", (e) => {
    if (dirty) {
      e.preventDefault();
      win.webContents.send("close-requested");
    }
  });
  win.on("closed", () => { win = null; });
}

app.whenReady().then(() => {
  pendingPath = pdfFromArgs(process.argv);
  createWindow();
});
app.on("window-all-closed", () => app.quit());

// ---- IPC -----------------------------------------------------------------------------
ipcMain.handle("initial-file", () => {
  const p = pendingPath;
  pendingPath = null;
  return p;
});

ipcMain.handle("pick-file", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "Open a PDF",
    properties: ["openFile"],
    filters: [{ name: "PDF files", extensions: ["pdf"] }, { name: "All files", extensions: ["*"] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle("open-file", (_e, filePath, password) => {
  let bytes;
  try {
    bytes = new Uint8Array(fs.readFileSync(filePath));
  } catch (e) {
    return { status: "error", message: `Couldn't read the file: ${e.code === "ENOENT" ? "it no longer exists" : e.message}` };
  }
  const r = openForView(bytes, password);
  if (r.status !== "ok") return r;
  const id = nextDocId++;
  docs.clear(); // one document at a time
  docs.set(id, { path: filePath, name: path.basename(filePath), bytes, password: password || null });
  addRecent(filePath);
  let marks = r.marks;
  let restored = false;
  const draft = readJson(draftFile(filePath), null);
  if (Array.isArray(draft)) {
    marks = draft.filter((m) => m.p < r.pageSizes.length);
    restored = true;
  }
  const page = listRecents().find((x) => x.path === filePath)?.page || 0;
  return {
    status: "ok", id, name: path.basename(filePath), path: filePath,
    viewBytes: r.viewBytes, marks, restored, pageSizes: r.pageSizes, page,
  };
});

ipcMain.handle("repair-view", (_e, id) => {
  const d = docs.get(id);
  return repairForView(d.bytes, d.password);
});

function buildAnnotated(id, marks, pageSizes) {
  const d = docs.get(id);
  if (!d) throw new Error("The document is no longer open.");
  return { d, out: writeAnnotated(d.bytes, d.password, marks, pageSizes) };
}

function writeFileSafely(target, bytes) {
  const tmp = target + ".pdfmarkup-tmp";
  fs.writeFileSync(tmp, bytes);
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    // Renaming over a file can fail on Windows (e.g. it's open elsewhere); try writing directly.
    try {
      fs.writeFileSync(target, bytes);
      fs.rmSync(tmp, { force: true });
    } catch (e2) {
      fs.rmSync(tmp, { force: true });
      throw e2;
    }
  }
}

ipcMain.handle("save", (_e, id, marks, pageSizes, saveAs) => {
  try {
    const d = docs.get(id);
    let target = d.path;
    if (saveAs) {
      const base = d.name.replace(/\.pdf$/i, "");
      const picked = dialog.showSaveDialogSync(win, {
        title: "Save a copy",
        defaultPath: path.join(path.dirname(d.path), `${base} (annotated).pdf`),
        filters: [{ name: "PDF files", extensions: ["pdf"] }],
      });
      if (!picked) return { status: "cancelled" };
      target = picked;
    }
    const { out } = buildAnnotated(id, marks, pageSizes);
    writeFileSafely(target, out);
    if (saveAs) {
      // Carry on editing the new copy.
      fs.rmSync(draftFile(d.path), { force: true });
      d.path = target;
      d.name = path.basename(target);
      addRecent(target);
    }
    fs.rmSync(draftFile(d.path), { force: true });
    return { status: "ok", path: d.path, name: d.name };
  } catch (e) {
    const busy = e.code === "EBUSY" || e.code === "EPERM" || e.code === "EACCES";
    return {
      status: "error",
      message: busy
        ? "Windows wouldn't let the app write to this file. It may be open in another program or read-only. Try “Save a copy”."
        : `Couldn't save: ${e.message}`,
    };
  }
});

/** Writes the annotated PDF to a temporary folder for sending. */
function exportForSharing(id, marks, pageSizes) {
  const { d, out } = buildAnnotated(id, marks, pageSizes);
  const dir = path.join(os.tmpdir(), "PDF Markup");
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
  const file = path.join(dir, d.name.toLowerCase().endsWith(".pdf") ? d.name : d.name + ".pdf");
  fs.writeFileSync(file, out);
  return file;
}

function copyFileToClipboard(file) {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve(false);
    const ps = `Set-Clipboard -LiteralPath '${file.replace(/'/g, "''")}'`;
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true },
      (err) => resolve(!err));
  });
}

/** True if the WhatsApp desktop app is installed (it registers the whatsapp: link type). */
function hasWhatsAppApp() {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve(false);
    execFile("reg", ["query", "HKCR\\whatsapp"], { windowsHide: true }, (err) => resolve(!err));
  });
}

ipcMain.handle("send-whatsapp", async (_e, id, marks, pageSizes) => {
  try {
    const file = exportForSharing(id, marks, pageSizes);
    const copied = await copyFileToClipboard(file);
    let opened = "web";
    if (await hasWhatsAppApp()) {
      try {
        await shell.openExternal("whatsapp://");
        opened = "app";
      } catch {}
    }
    if (opened === "web") await shell.openExternal("https://web.whatsapp.com/");
    return { status: "ok", copied, opened, file };
  } catch (e) {
    return { status: "error", message: `Couldn't prepare the file: ${e.message}` };
  }
});

ipcMain.handle("share-file", async (_e, id, marks, pageSizes) => {
  try {
    const file = exportForSharing(id, marks, pageSizes);
    shell.showItemInFolder(file);
    return { status: "ok", file };
  } catch (e) {
    return { status: "error", message: `Couldn't prepare the file: ${e.message}` };
  }
});

ipcMain.handle("show-in-folder", (_e, p) => shell.showItemInFolder(p));
ipcMain.handle("recents", () => listRecents());
ipcMain.handle("remove-recent", (_e, p) => writeJson(recentsFile(), readJson(recentsFile(), []).filter((r) => r.path !== p)));
ipcMain.handle("set-page", (_e, p, page) => {
  const items = readJson(recentsFile(), []);
  const it = items.find((r) => r.path === p);
  if (it) { it.page = page; writeJson(recentsFile(), items); }
});
ipcMain.handle("save-draft", (_e, p, marks) => writeJson(draftFile(p), marks));
ipcMain.handle("clear-draft", (_e, p) => fs.rmSync(draftFile(p), { force: true }));
ipcMain.handle("set-dirty", (_e, v) => { dirty = !!v; });
ipcMain.handle("force-close", () => { dirty = false; win?.close(); });
ipcMain.handle("set-title", (_e, t) => win?.setTitle(t));
