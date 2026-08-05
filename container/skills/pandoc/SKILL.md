---
name: pandoc
description: Convert documents between formats (Markdown, HTML, DOCX, ODT, EPUB, RST, LaTeX, and more). Use whenever asked to convert, export, or transform a document from one file format to another.
---

# Pandoc

`pandoc` is installed globally in the container. It converts between markup and document formats by reading one and writing another.

## Quick start

```bash
pandoc input.md -o output.html      # Markdown -> HTML
pandoc input.md -o output.docx      # Markdown -> Word
pandoc input.docx -o output.md      # Word -> Markdown
pandoc input.html -o output.md      # HTML -> Markdown
pandoc input.md -o output.epub      # Markdown -> EPUB
```

Pandoc infers format from the file extension on both sides. Use `-f <format>` / `-t <format>` to override (e.g. reading `.txt` as markdown: `pandoc -f markdown -t html input.txt -o out.html`).

## Common flags

```bash
pandoc input.md -o output.html --standalone     # full <html> doc, not a fragment
pandoc input.md -o output.docx --reference-doc=template.docx  # match a Word template's styles
pandoc input.md -o output.html --toc            # add a table of contents
pandoc a.md b.md c.md -o combined.docx          # concatenate multiple inputs
pandoc input.md -o output.html --metadata title="My Doc"
```

List every supported format: `pandoc --list-input-formats` / `pandoc --list-output-formats`.

## PDF output is not available

The image does not include a LaTeX engine (`texlive-xetex` alone is 500MB+, so it isn't installed by default). `pandoc input.md -o output.pdf` will fail with a missing-engine error. Instead:

- Convert to `.html` or `.docx` and suggest the user print/export to PDF from there, or
- If a group genuinely needs native PDF export, it can request `texlive-xetex` (or `wkhtmltopdf`) via the `install_packages` self-mod tool — that's a per-group, approved install, not something to add speculatively.

## Notes

- Pandoc is a pure format converter — it doesn't fetch URLs by default for embedded resources. Pass local file paths, not remote URLs, for images/includes.
- For large batch conversions, glob the inputs and loop rather than relying on pandoc's shell globbing (the shell expands `*.md` before pandoc sees it, which is fine — just don't quote the glob).
