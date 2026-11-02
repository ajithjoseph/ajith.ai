#!/usr/bin/env python3
"""Release checks for ajith.ai. Python standard library only.

Fails (exit 1) on:
  - pages missing doctype, lang, charset, viewport, title, description or canonical
  - pages with zero or more than one <h1>
  - images without alt text, new-tab links without rel="noopener"
  - broken internal links, assets or #anchors
  - em dashes in content (house style)
  - email addresses, phone numbers or API keys anywhere in the public repo
"""
from __future__ import annotations

import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
SKIP_DIRS = {".git", "node_modules", "scripts", "preview", "fonts"}
TEXT_EXT = {".html", ".json", ".md", ".txt", ".xml", ".yml", ".yaml", ".css", ".svg"}
STYLE_EXT = {".html", ".json", ".md"}

PRIVACY = [
    ("an email address", re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")),
    ("a phone number", re.compile(r"\(\d{3}\)\s*\d{3}[-.\s]\d{4}|\b\d{3}[-.]\d{3}[-.]\d{4}\b")),
    ("an AWS key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("an API key", re.compile(r"\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}")),
    ("a GitHub token", re.compile(r"\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}")),
    ("a Slack token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}")),
    ("a private key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
]
EM_DASH = re.compile("—|&mdash;|&#8212;")


class Page(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tags: list[tuple[str, dict]] = []
        self.ids: set[str] = set()
        self.h1 = 0
        self.in_title = False
        self.title = ""

    def handle_starttag(self, tag, attrs):
        a = {k: (v or "") for k, v in attrs}
        self.tags.append((tag, a))
        if "id" in a:
            self.ids.add(a["id"])
        if tag == "h1":
            self.h1 += 1
        if tag == "title":
            self.in_title = True

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False

    def handle_data(self, data):
        if self.in_title:
            self.title += data


def files(exts: set[str]) -> list[Path]:
    out = []
    for p in ROOT.rglob("*"):
        if p.is_file() and p.suffix in exts and not (set(p.relative_to(ROOT).parts) & SKIP_DIRS):
            out.append(p)
    return sorted(out)


def resolve(page: Path, url: str) -> Path | None:
    path = urlsplit(url).path
    if not path:
        return page
    target = ROOT / path.lstrip("/") if path.startswith("/") else (page.parent / path)
    if path.endswith("/") or target.is_dir():
        target = target / "index.html"
    return target.resolve()


def main() -> None:
    errors: list[str] = []
    parsed: dict[Path, Page] = {}

    pages = files({".html"})
    pages = [p for p in pages if p.parent.name != "partials"]
    for p in pages:
        text = p.read_text(encoding="utf-8")
        doc = Page()
        doc.feed(text)
        parsed[p.resolve()] = doc
        rel = p.relative_to(ROOT)
        if not text.lower().lstrip().startswith("<!doctype html>"):
            errors.append(f"{rel}: missing <!doctype html>")
        meta = [a for t, a in doc.tags if t == "meta"]
        links = [a for t, a in doc.tags if t == "link"]
        html_tag = next((a for t, a in doc.tags if t == "html"), {})
        if not html_tag.get("lang"):
            errors.append(f"{rel}: <html> needs a lang attribute")
        if not any(a.get("charset", "").lower() == "utf-8" for a in meta):
            errors.append(f"{rel}: missing <meta charset=\"utf-8\">")
        if not any(a.get("name") == "viewport" for a in meta):
            errors.append(f"{rel}: missing viewport meta")
        if not doc.title.strip():
            errors.append(f"{rel}: missing <title>")
        if not any(a.get("name") == "description" and a.get("content", "").strip() for a in meta):
            errors.append(f"{rel}: missing meta description")
        if rel.name != "404.html" and not any(a.get("rel") == "canonical" for a in links):
            errors.append(f"{rel}: missing canonical link")
        if doc.h1 != 1:
            errors.append(f"{rel}: has {doc.h1} <h1> elements, needs exactly 1")
        for t, a in doc.tags:
            if t == "img" and "alt" not in a:
                errors.append(f"{rel}: <img src=\"{a.get('src')}\"> needs alt text")
            if t == "a" and a.get("target") == "_blank" and "noopener" not in a.get("rel", ""):
                errors.append(f"{rel}: link to {a.get('href')} opens a new tab without rel=\"noopener\"")

    for p in pages:
        doc = parsed[p.resolve()]
        rel = p.relative_to(ROOT)
        for t, a in doc.tags:
            url = a.get("href") if t in ("a", "link") else a.get("src") if t in ("img", "script", "source") else None
            if not url or re.match(r"^(https?:|mailto:|tel:|data:)", url):
                continue
            if t == "link" and a.get("rel") in ("canonical",):
                continue
            target = resolve(p, url)
            if target is None or not target.exists():
                errors.append(f"{rel}: broken link {url}")
                continue
            frag = urlsplit(url).fragment
            if frag and target in parsed and frag not in parsed[target].ids:
                errors.append(f"{rel}: anchor #{frag} not found in {target.relative_to(ROOT)}")

    for p in files(TEXT_EXT):
        rel = p.relative_to(ROOT)
        text = p.read_text(encoding="utf-8", errors="replace")
        for n, line in enumerate(text.splitlines(), 1):
            if p.suffix in STYLE_EXT and EM_DASH.search(line):
                errors.append(f"{rel}:{n}: em dash found (house style: no em dashes)")
            for label, rx in PRIVACY:
                if rx.search(line):
                    errors.append(f"{rel}:{n}: looks like {label}; keep it out of the public repo")

    if errors:
        print(f"{len(errors)} problem(s):")
        for e in errors:
            print("  " + e)
        sys.exit(1)
    print(f"All checks passed ({len(pages)} pages).")


if __name__ == "__main__":
    main()
