#!/usr/bin/env python3
"""Build ajith.ai. Python standard library only.

What it does:
  1. Validates notes/notes.json.
  2. Renders notes/index.html and one page per note at notes/<id>/index.html.
  3. Fills the "latest notes" block on the home page.
  4. Syncs partials/header.html and partials/footer.html into every page.
  5. Writes sitemap.xml.

Usage:
  python3 scripts/build.py          write everything
  python3 scripts/build.py --check  fail if anything on disk is stale (used in CI)
"""
from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = "https://ajith.ai"
NOTES_JSON = ROOT / "notes" / "notes.json"
NOTES_DIR = ROOT / "notes"
HAND_AUTHORED = ["index.html", "about/index.html", "thyword/index.html", "perfagents/index.html", "404.html"]
LATEST_COUNT = 10
ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
PARTIAL_RE = re.compile(r"(<!-- partial:(\w+) -->)(.*?)(<!-- /partial:\2 -->)", re.S)
LATEST_RE = re.compile(r"(<!-- notes:latest -->)(.*?)(<!-- /notes:latest -->)", re.S)


def esc(text: str) -> str:
    return html.escape(text, quote=True)


# ---------- notes ----------

def load_notes() -> list[dict]:
    try:
        notes = json.loads(NOTES_JSON.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        sys.exit(f"notes/notes.json is not valid JSON: {exc}")
    if not isinstance(notes, list):
        sys.exit("notes/notes.json must be a list of note objects")

    errors, seen = [], set()
    for i, n in enumerate(notes):
        where = f"note #{i + 1} ({n.get('id', 'no id')})"
        for field in ("id", "date", "title", "body"):
            if not isinstance(n.get(field), str) or not n[field].strip():
                errors.append(f"{where}: missing or empty '{field}'")
        nid = n.get("id", "")
        if nid and not ID_RE.match(nid):
            errors.append(f"{where}: id must be lowercase words joined by hyphens")
        if nid in seen:
            errors.append(f"{where}: duplicate id")
        seen.add(nid)
        try:
            dt.date.fromisoformat(n.get("date", ""))
        except ValueError:
            errors.append(f"{where}: date must be YYYY-MM-DD")
        link = n.get("linkedin")
        if link is not None and not str(link).startswith("https://www.linkedin.com/"):
            errors.append(f"{where}: linkedin must be a https://www.linkedin.com/ URL")
        related = n.get("related", [])
        if not isinstance(related, list) or len(related) > 3:
            errors.append(f"{where}: related must be a list of up to 3 note ids")
    ids = {n.get("id") for n in notes}
    for n in notes:
        for r in n.get("related", []) or []:
            if r == n.get("id"):
                errors.append(f"{n['id']}: a note cannot be related to itself")
            elif r not in ids:
                errors.append(f"{n['id']}: related id '{r}' does not exist")
    if errors:
        sys.exit("Notes validation failed:\n  " + "\n  ".join(errors))
    return sorted(notes, key=lambda n: (n["date"], n["id"]), reverse=True)


def inline(text: str) -> str:
    out = html.escape(text, quote=False)
    out = re.sub(r"`([^`]+)`", r"<code>\1</code>", out)

    def link(m: re.Match) -> str:
        label, url = m.group(1), m.group(2).replace('"', "%22")
        ext = url.startswith(("http://", "https://"))
        attrs = ' target="_blank" rel="noopener"' if ext else ""
        return f'<a href="{url}"{attrs}>{label}</a>'

    out = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", link, out)
    out = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", out)
    out = re.sub(r"(?<![*\w])\*([^*\s][^*]*)\*(?![*\w])", r"<em>\1</em>", out)
    return out


def render_body(md: str) -> str:
    """Tiny Markdown: paragraphs, line breaks, lists, quotes, ## headings."""
    blocks = re.split(r"\n\s*\n", md.strip())
    out = []
    for block in blocks:
        lines = [l.rstrip() for l in block.splitlines() if l.strip()]
        if all(re.match(r"\s*[-*]\s+", l) for l in lines):
            items = "".join(f"<li>{inline(re.sub(r'^\s*[-*]\s+', '', l))}</li>" for l in lines)
            out.append(f"<ul>{items}</ul>")
        elif all(re.match(r"\s*\d+\.\s+", l) for l in lines):
            items = "".join(f"<li>{inline(re.sub(r'^\s*\d+\.\s+', '', l))}</li>" for l in lines)
            out.append(f"<ol>{items}</ol>")
        elif all(l.startswith(">") for l in lines):
            inner = "<br>\n".join(inline(l.lstrip("> ").strip()) for l in lines)
            out.append(f"<blockquote><p>{inner}</p></blockquote>")
        elif len(lines) == 1 and lines[0].startswith("## "):
            out.append(f"<h2>{inline(lines[0][3:])}</h2>")
        else:
            out.append("<p>" + "<br>\n".join(inline(l) for l in lines) + "</p>")
    return "\n".join(out)


def excerpt(md: str, limit: int = 150) -> str:
    first = re.split(r"\n\s*\n", md.strip())[0]
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", first)
    text = re.sub(r"[*`>#]", "", text)
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0].rstrip(",.;:")
    return cut + "…"


def nice_date(iso: str) -> str:
    d = dt.date.fromisoformat(iso)
    return f"{d.strftime('%B')} {d.day}, {d.year}"


# ---------- pages ----------

def page(*, title: str, description: str, path: str, body: str, og_type: str = "website") -> str:
    url = SITE + path
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title>
<meta name="description" content="{esc(description)}">
<link rel="canonical" href="{url}">
<meta property="og:title" content="{esc(title)}">
<meta property="og:description" content="{esc(description)}">
<meta property="og:url" content="{url}">
<meta property="og:type" content="{og_type}">
<!-- partial:social -->
<!-- /partial:social -->
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/assets/fonts/Geist-Variable.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/site.css">
</head>
<body>
<!-- partial:header -->
<!-- /partial:header -->
<main id="main">
{body}
</main>
<!-- partial:footer -->
<!-- /partial:footer -->
</body>
</html>
"""


def blurb(n: dict, limit: int = 150) -> str:
    """Excerpt for a note list, skipping the opening words when they repeat the title."""
    def clean(t: str) -> str:
        t = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", t)
        return " ".join(re.sub(r"[*`>#★]", "", t).split())
    text = clean(re.sub(r"(?m)^\s*(?:[-*]|\d+\.)\s+", "", n["body"]))
    title = clean(n["title"])
    if not title.endswith("…") and text.startswith(title):
        text = text[len(title):].lstrip(" ,:;.!?")
    if len(text) <= limit:
        return text
    return text[:limit].rsplit(" ", 1)[0].rstrip(",.;:") + "…"


def note_list(notes: list[dict], blurbs: bool = True) -> str:
    items = []
    for n in notes:
        extra = f"<p>{esc(b)}</p>" if blurbs and (b := blurb(n)) else ""
        items.append(
            f'<li><time datetime="{n["date"]}">{nice_date(n["date"])}</time>'
            f'<a href="/notes/{n["id"]}/">{esc(n["title"])}</a>{extra}</li>'
        )
    return '<ul class="note-list">\n' + "\n".join(items) + "\n</ul>"


def related_ids(notes: list[dict]) -> dict[str, list[str]]:
    """Explicit links plus their reciprocal, capped at three, explicit first."""
    rel: dict[str, list[str]] = {n["id"]: list(n.get("related", []) or []) for n in notes}
    for n in notes:
        for r in n.get("related", []) or []:
            if n["id"] not in rel[r]:
                rel[r].append(n["id"])
    return {k: v[:3] for k, v in rel.items()}


def render_note(n: dict, by_id: dict, rel: list[str]) -> str:
    parts = [
        '<article class="note">',
        f'<p class="note-meta"><a href="/notes/">Notes</a> · <time datetime="{n["date"]}">{nice_date(n["date"])}</time></p>',
        f"<h1>{esc(n['title'])}</h1>",
        f'<div class="prose">\n{render_body(n["body"])}\n</div>',
    ]
    if n.get("linkedin"):
        parts.append(
            f'<p class="origin"><a href="{esc(n["linkedin"])}" target="_blank" rel="noopener">Also on LinkedIn</a></p>'
        )
    parts.append("</article>")
    if rel:
        parts.append('<section class="related" aria-labelledby="related-h">')
        parts.append('<h2 id="related-h">Related</h2>')
        parts.append(note_list([by_id[r] for r in rel]))
        parts.append("</section>")
    return page(
        title=f"{n['title']} · Ajith Joseph",
        description=excerpt(n["body"], 155),
        path=f"/notes/{n['id']}/",
        body="\n".join(parts),
        og_type="article",
    )


def render_notes_index(notes: list[dict]) -> str:
    body = (
        "<h1>Notes</h1>\n"
        '<p class="lede">Short thinking, mostly about building. Newest first.</p>\n'
        + (note_list(notes) if notes else "<p>Nothing here yet.</p>")
    )
    return page(
        title="Notes · Ajith Joseph",
        description="Short notes by Ajith Joseph on building AI products, cloud platforms and companies.",
        path="/notes/",
        body=body,
    )


def render_sitemap(notes: list[dict]) -> str:
    latest = notes[0]["date"] if notes else None
    urls = [("/", latest)]
    urls += [(url_path(f), None) for f in HAND_AUTHORED if f not in ("index.html", "404.html")]
    urls.append(("/notes/", latest))
    urls += [(f"/notes/{n['id']}/", n["date"]) for n in notes]
    rows = []
    for path, lastmod in urls:
        lm = f"<lastmod>{lastmod}</lastmod>" if lastmod else ""
        rows.append(f"  <url><loc>{SITE}{path}</loc>{lm}</url>")
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "\n".join(rows)
        + "\n</urlset>\n"
    )


def sync_partials(text: str, path: str) -> str:
    def fill(m: re.Match) -> str:
        name = m.group(2)
        src = ROOT / "partials" / f"{name}.html"
        if not src.exists():
            sys.exit(f"Missing partial: partials/{name}.html")
        content = src.read_text(encoding="utf-8").strip()
        if name == "header":
            section = "/notes/" if path.startswith("/notes/") else path
            if section in ("/notes/", "/about/"):
                content = content.replace(f'href="{section}"', f'href="{section}" aria-current="page"', 1)
        return f"{m.group(1)}\n{content}\n{m.group(4)}"

    return PARTIAL_RE.sub(fill, text)


def url_path(rel_file: str) -> str:
    if rel_file == "index.html":
        return "/"
    if rel_file.endswith("/index.html"):
        return "/" + rel_file[: -len("index.html")]
    return "/" + rel_file


def build() -> tuple[dict[str, str], list[Path]]:
    notes = load_notes()
    by_id = {n["id"]: n for n in notes}
    rel = related_ids(notes)
    out: dict[str, str] = {}

    out["notes/index.html"] = render_notes_index(notes)
    for n in notes:
        out[f"notes/{n['id']}/index.html"] = render_note(n, by_id, rel[n["id"]])

    for rel_file in HAND_AUTHORED:
        src = ROOT / rel_file
        if not src.exists():
            sys.exit(f"Missing page: {rel_file}")
        text = src.read_text(encoding="utf-8")
        if rel_file == "index.html":
            if not LATEST_RE.search(text):
                sys.exit("index.html is missing the <!-- notes:latest --> block")
            text = LATEST_RE.sub(
                lambda m: f"{m.group(1)}\n{note_list(notes[:LATEST_COUNT], blurbs=False)}\n{m.group(3)}", text
            )
        out[rel_file] = text

    out = {f: sync_partials(t, url_path(f)) for f, t in out.items()}
    out["sitemap.xml"] = render_sitemap(notes)

    keep = {n["id"] for n in notes}
    stale = [d for d in NOTES_DIR.iterdir() if d.is_dir() and d.name not in keep]
    return out, stale


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="fail if generated files are stale")
    args = ap.parse_args()

    out, stale = build()
    if args.check:
        problems = [f for f, t in out.items() if not (ROOT / f).exists() or (ROOT / f).read_text(encoding="utf-8") != t]
        problems += [f"notes/{d.name}/ (no matching note)" for d in stale]
        if problems:
            print("Generated files are stale. Run: python3 scripts/build.py")
            for p in problems:
                print("  " + p)
            sys.exit(1)
        print(f"Build is up to date ({len(out)} files).")
        return

    for f, t in out.items():
        dest = ROOT / f
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not dest.exists() or dest.read_text(encoding="utf-8") != t:
            dest.write_text(t, encoding="utf-8")
            print("wrote " + f)
    for d in stale:
        shutil.rmtree(d)
        print(f"removed notes/{d.name}/")
    print("Build done.")


if __name__ == "__main__":
    main()
