#!/usr/bin/env python3
"""Write data/apps.json from GitHub repos tagged with the "ajith-app" topic.

Python standard library only. Run by .github/workflows/apps.yml once a day.

A repo shows up on the home page when all of these are true:
  - it is public, owned by ajithjoseph and not archived
  - it has the topic "ajith-app"
  - its website (homepage) is set to an https URL, for example https://screenly.ajith.ai/
  - it has a description (that becomes the line on the tile)

Tile kind: "Game" if the repo also has the topic "game", otherwise "Tool".
Tile name: the first label of the website host, capitalized (screenly.ajith.ai -> Screenly).

If the GitHub call fails, the script exits with an error and changes nothing.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "apps.json"
OWNER = "ajithjoseph"
TOPIC = "ajith-app"
API = f"https://api.github.com/search/repositories?q=user:{OWNER}+topic:{TOPIC}+archived:false+is:public&per_page=100"


def fetch() -> list[dict]:
    req = urllib.request.Request(API, headers={"Accept": "application/vnd.github+json", "User-Agent": "ajith.ai-apps"})
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.load(resp)
    if data.get("incomplete_results"):
        sys.exit("GitHub returned incomplete results. Not changing data/apps.json.")
    return data.get("items", [])


def to_app(repo: dict) -> dict | None:
    url = (repo.get("homepage") or "").strip()
    line = (repo.get("description") or "").strip()
    if not url.startswith("https://") or not line:
        print(f"skip {repo['full_name']}: needs an https website and a description")
        return None
    if not url.endswith("/"):
        url += "/"
    host = urlparse(url).hostname or ""
    return {
        "name": host.split(".")[0].capitalize(),
        "kind": "Game" if "game" in repo.get("topics", []) else "Tool",
        "line": line,
        "url": url,
        "repo": repo["full_name"],
    }


def main() -> None:
    apps = [a for a in (to_app(r) for r in fetch()) if a]
    apps.sort(key=lambda a: a["name"].lower())
    text = json.dumps(apps, indent=2, ensure_ascii=False) + "\n"
    if OUT.exists() and OUT.read_text(encoding="utf-8") == text:
        print(f"data/apps.json is up to date ({len(apps)} apps).")
        return
    OUT.write_text(text, encoding="utf-8")
    print(f"wrote data/apps.json ({len(apps)} apps).")


if __name__ == "__main__":
    main()
