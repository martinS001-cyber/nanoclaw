---
name: pdf-tools
description: Read text out of PDFs and generate new PDFs from HTML or Markdown. Use whenever asked to extract, summarize, or search a PDF's contents, or to export/produce a PDF document.
---

# PDF Tools

Two independent capabilities, both installed globally in the container.

## Reading PDFs (poppler-utils)

```bash
pdftotext input.pdf output.txt     # extract text to a file
pdftotext input.pdf -              # extract text to stdout
pdftotext -layout input.pdf -      # preserve column/table layout
pdfinfo input.pdf                  # metadata: page count, size, title, etc.
pdftoppm -png input.pdf page       # render pages to page-1.png, page-2.png, ...
```

`pdftotext` is the default choice for reading a PDF's contents — pipe its stdout straight into your own processing. Use `-layout` when the PDF has tables or columns you need to keep aligned. `pdftoppm` is for when you need to *see* a page (e.g. it's mostly images/diagrams `pdftotext` can't capture) — render it to PNG and view the image.

## Generating PDFs (html2pdf)

There's no LaTeX engine or heavyweight HTML-to-PDF stack in this image on purpose (weasyprint alone pulls ~900MB, wkhtmltopdf ~400MB). Instead, `html2pdf` reuses the Chromium already installed for `agent-browser` to print HTML to PDF:

```bash
html2pdf input.html output.pdf
html2pdf https://example.com output.pdf   # works on a live URL too
```

To produce a PDF from Markdown, convert to HTML first with pandoc (see the `pandoc` skill), then render:

```bash
pandoc input.md -o /tmp/doc.html --standalone --metadata title="My Doc"
html2pdf /tmp/doc.html output.pdf
```

Add `--css=style.css` to pandoc's standalone HTML step first if you need custom styling (page margins, fonts) — `html2pdf` just prints whatever the HTML/CSS renders as.

## Notes

- `html2pdf` fails on stderr with Chromium's normal headless noise (dbus connection warnings) — these are harmless; check the exit code and that the output file was written, not stderr content.
- For very large PDFs, prefer `pdftotext` over rendering every page as an image — it's far cheaper and returns immediately usable text.
