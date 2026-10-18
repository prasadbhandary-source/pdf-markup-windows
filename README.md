# PDF Markup for Windows

A personal Windows app (for a Surface laptop) to open and annotate PDFs —
the desktop companion to the PDF Markup Android app.

## What it does
- Opens any PDF: **Open a PDF** (Ctrl+O), drag a file onto the window, or right-click a PDF in
  File Explorer → **Open with → PDF Markup**.
- Password-protected and damaged files are handled; the password stays on the file when saving.
- Tools: **Move**, **Pen**, **Highlighter**, **Text notes**, **Eraser** — with colours and sizes.
  - Surface Pen and mouse draw; fingers scroll and pinch-zoom (tick **Draw with finger** to draw with touch).
  - The Surface Pen's eraser end erases.
  - Text notes: click to add, click to edit, drag to move.
- Undo/redo, zoom (Ctrl + scroll, pinch, Ctrl +/−, Ctrl+0 fits width), page jump.
- **Save** (Ctrl+S) writes real PDF annotations into the file, so they show in Acrobat, Edge,
  Chrome, Drive… **Save a copy** (Ctrl+Shift+S) writes a new file.
- **WhatsApp**: copies the annotated PDF and opens WhatsApp (or WhatsApp Web) — paste with Ctrl+V into a chat.
- Annotations made here or in the Android app stay editable in both.
- Unsaved work is kept as a draft; recent files remember your page.

Keyboard: V move · P pen · H highlighter · T text · E eraser · Esc back to move.

## Build
Push to `main`. The **Build Windows installer** workflow tests the PDF engine, builds
`PDF-Markup-Setup-<version>.exe` (Intel/AMD and ARM in one installer) and publishes it as a GitHub Release.

## Install
Download the setup file from the latest release and run it. Windows may show
"Windows protected your PC" because the app isn't signed: click **More info → Run anyway**.
New builds install over the old one.

Uses [MuPDF](https://mupdf.com) (AGPL) and [PDF.js](https://mozilla.github.io/pdf.js/).
