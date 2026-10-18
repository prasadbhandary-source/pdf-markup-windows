# PDF Markup for Windows

The Windows companion to the PDF Markup Android app: open any PDF and annotate it.
It's an installable web app — install it from Microsoft Edge and it runs in its own
window, works offline, and shows up in **Open with** for PDF files. No .exe to download,
so Windows security can't block it.

**App:** https://prasadbhandary-source.github.io/pdf-markup-windows/

## Install (once)
1. Open the link above in **Microsoft Edge**.
2. Click **Install** on the start screen (or the "App available" icon in the address bar) → **Install**.
3. To open PDFs with it: right-click a PDF → **Open with → Choose another app → PDF Markup**
   (tick "Always" to make it the default).

## What it does
- Open: button (Ctrl+O), drag a PDF onto the window, Open with from File Explorer, or Recent.
- Password-protected and damaged files are handled; the password stays on the file.
- Tools: Move, Pen, Highlighter, Text notes, Eraser — colours and sizes.
  Surface Pen and mouse draw; fingers scroll and pinch-zoom (tick **Draw with finger** to draw by touch).
  The pen's eraser end erases.
- Undo/redo, zoom (Ctrl + scroll, pinch, Ctrl +/−, Ctrl+0), page jump.
- **Save** (Ctrl+S) writes real PDF annotations into the original file; **Save a copy** makes a new one.
- **WhatsApp**: opens the Windows Share window with the annotated PDF — pick WhatsApp.
- Annotations from the Android app stay editable here and vice versa.
- Unsaved work is kept as a draft; Recent remembers your page.

Keyboard: V move · P pen · H highlighter · T text · E eraser · Esc back to move.

## Build
Pushing to `main` runs the tests, builds the site and publishes it to the `gh-pages` branch.
Installed copies update themselves the next time they're opened online.

Uses [MuPDF](https://mupdf.com) (AGPL) and [PDF.js](https://mozilla.github.io/pdf.js/).
