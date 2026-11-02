#!/usr/bin/env python3
"""Screenshot pages at desktop and phone widths before publishing.

Needs Playwright once:  pip install playwright && python3 -m playwright install chromium
Usage:  python3 scripts/preview.py / /about/ /notes/
Screenshots land in preview/ (git-ignored).
"""
from __future__ import annotations

import functools
import http.server
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "preview"
SIZES = {"desktop": (1280, 900), "phone": (390, 844)}


def main() -> None:
    from playwright.sync_api import sync_playwright

    paths = sys.argv[1:] or ["/"]
    OUT.mkdir(exist_ok=True)
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    handler = functools.partial(Quiet, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"

    with sync_playwright() as p:
        browser = p.chromium.launch()
        for name, (w, h) in SIZES.items():
            ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=2 if name == "phone" else 1)
            page = ctx.new_page()
            for path in paths:
                page.goto(base + path, wait_until="networkidle")
                slug = path.strip("/").replace("/", "_") or "home"
                file = OUT / f"{slug}-{name}.png"
                page.screenshot(path=str(file), full_page=True)
                print(file.relative_to(ROOT))
            ctx.close()
        browser.close()
    server.shutdown()


if __name__ == "__main__":
    main()
