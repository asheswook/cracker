#!/bin/sh
set -eu

sudo apt-get update
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  build-essential ripgrep jq zip python3-venv python3-pip \
  python3-pil python3-numpy python3-pandas python3-matplotlib \
  python3-reportlab python3-openpyxl python3-docx poppler-utils
python3 -c 'import PIL,numpy,pandas,matplotlib,reportlab,openpyxl,docx; print("Image, table, chart, PDF, spreadsheet and document tools ready")'
