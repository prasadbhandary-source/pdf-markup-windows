// Bridge between the window and the main process.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("api", {
  initialFile: () => ipcRenderer.invoke("initial-file"),
  pickFile: () => ipcRenderer.invoke("pick-file"),
  openFile: (path, password) => ipcRenderer.invoke("open-file", path, password),
  repairView: (id) => ipcRenderer.invoke("repair-view", id),
  save: (id, marks, sizes, saveAs) => ipcRenderer.invoke("save", id, marks, sizes, saveAs),
  sendWhatsApp: (id, marks, sizes) => ipcRenderer.invoke("send-whatsapp", id, marks, sizes),
  shareFile: (id, marks, sizes) => ipcRenderer.invoke("share-file", id, marks, sizes),
  showInFolder: (path) => ipcRenderer.invoke("show-in-folder", path),
  recents: () => ipcRenderer.invoke("recents"),
  removeRecent: (path) => ipcRenderer.invoke("remove-recent", path),
  setPage: (path, page) => ipcRenderer.invoke("set-page", path, page),
  saveDraft: (path, marks) => ipcRenderer.invoke("save-draft", path, marks),
  clearDraft: (path) => ipcRenderer.invoke("clear-draft", path),
  setDirty: (v) => ipcRenderer.invoke("set-dirty", v),
  forceClose: () => ipcRenderer.invoke("force-close"),
  setTitle: (t) => ipcRenderer.invoke("set-title", t),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onOpenRequest: (cb) => ipcRenderer.on("open-request", (_e, p) => cb(p)),
  onCloseRequested: (cb) => ipcRenderer.on("close-requested", () => cb()),
});
