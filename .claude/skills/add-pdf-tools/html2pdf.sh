#!/bin/sh
# Renders an HTML file (or URL) to PDF using the Chromium already installed
# for agent-browser — no separate PDF engine needed. Hides the headless
# print-to-pdf flags behind a plain two-arg interface.
#
# Usage: html2pdf <input.html-or-url> <output.pdf>
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: html2pdf <input.html-or-url> <output.pdf>" >&2
  exit 1
fi

INPUT="$1"
OUTPUT="$2"

exec chromium \
  --headless \
  --disable-gpu \
  --no-sandbox \
  --disable-dev-shm-usage \
  --no-pdf-header-footer \
  --print-to-pdf="$OUTPUT" \
  "$INPUT"
