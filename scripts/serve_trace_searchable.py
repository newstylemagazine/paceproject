#!/usr/bin/env python3

from __future__ import annotations

import http.server
import socketserver
from pathlib import Path


PORT = 8000
ROOT = Path(__file__).resolve().parents[1]


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)


def main() -> None:
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        print(f"Serving TRaCE Searchable at http://localhost:{PORT}/site/")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
