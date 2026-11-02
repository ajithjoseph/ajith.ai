# ajith.ai

The source for [ajith.ai](https://ajith.ai), Ajith Joseph's personal site.

Plain HTML and CSS on GitHub Pages. No framework. A small Python script turns `notes/notes.json` into note pages, and Claude Code does the publishing by following [CLAUDE.md](CLAUDE.md).

## Day to day

In Claude Code, from this folder:

```
/note Here is the thing I want to say today...
```

Claude adds the note, builds the pages, runs the checks, shows desktop and phone previews, and pushes only after a yes.

## By hand

```
python3 scripts/build.py      # render notes, sync header and footer, write sitemap
python3 scripts/check.py      # page rules, links, house style, privacy guard
python3 scripts/preview.py /  # screenshots in preview/ (needs Playwright)
python3 -m http.server 8000   # browse at http://localhost:8000
```

## Layout

```
index.html, about/, 404.html   hand-written pages
notes/notes.json               every note lives here
notes/<id>/index.html          generated, one per note
partials/                      shared header and footer
assets/                        stylesheet and fonts (Geist, SIL OFL)
scripts/                       build, check, preview
.github/workflows/site.yml     runs build --check and check on every push
```
