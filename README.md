<div align="center">

<h1>ajith.ai</h1>
<h3>The source for Ajith Joseph's personal site</h3>

<p>
Plain HTML and CSS on GitHub Pages. No framework, no trackers, no remote scripts or fonts.<br />
A small Python script turns <code>notes/notes.json</code> into note pages.
</p>

| Site | Notes | Profile |
|:---:|:---:|:---:|
| [ajith.ai](https://ajith.ai) | [ajith.ai/notes](https://ajith.ai/notes/) | [github.com/ajithjoseph](https://github.com/ajithjoseph) |

</div>

## What's on the site

| Page | What it covers |
|---|---|
| **[Home](https://ajith.ai)** | What I'm building now, dev tools, track record, writing and the latest notes |
| **[ThyWord](https://ajith.ai/thyword/)** | Our voice-first app. Say what's on your heart and get back a Bible verse and a short reflection |
| **[Shepherd](https://ajith.ai/shepherd/)** | Our AI agent for churches, built under ThyWord. One text number per church |
| **[PerfAgents](https://ajith.ai/perfagents/)** | Synthetic monitoring SaaS I founded in 2020. Acquired by Testing Mavens in 2025 |
| **[Notes](https://ajith.ai/notes/)** | Short posts, many first shared on LinkedIn |
| **[About](https://ajith.ai/about/)** | The longer story |

## Other projects

Most of these have their own repo. The site links the ones that are ready.

| Project | What it does | Repo |
|---|---|---|
| **[EvalStack](https://evalstack.dev)** | Open source test kit for AI apps. Scores each reply and says why it passed or failed | [evalstack](https://github.com/ajithjoseph/evalstack) |
| **[ShadowTel](https://shadowtel.com)** | GitHub Action that blocks AI-written code that breaks your schema, APIs or architecture rules. In development | |
| **Arena** | A small first-person duel game in the browser. Plain WebGL, one file | [arena.ajith.ai](https://github.com/ajithjoseph/arena.ajith.ai) |
| **Screenly** | Works out your average daily screen time. One page, data stays in your browser | [screenly.ajith.ai](https://github.com/ajithjoseph/screenly.ajith.ai) |
| **Launch a Day** | Helps makers ship one small app every day, with streaks and a launches feed | [anapp.ajith.ai](https://github.com/ajithjoseph/anapp.ajith.ai) |

## Publishing

Claude Code does the publishing by following [CLAUDE.md](CLAUDE.md). From this folder:

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

| Path | What lives there |
|---|---|
| `index.html`, `about/`, `404.html` | Hand-written pages |
| `thyword/`, `shepherd/`, `perfagents/` | Hand-written project pages |
| `notes/notes.json` | Every note lives here |
| `notes/<id>/index.html` | Generated, one per note |
| `partials/` | Shared header, footer and social tags |
| `assets/` | Stylesheet, images and fonts (Geist, SIL OFL) |
| `scripts/` | Build, check and preview. Python standard library only |
| `.github/workflows/site.yml` | Runs `build.py --check` and `check.py` on every push |

## Hosting

GitHub Pages from the `main` branch root. `CNAME` holds `ajith.ai`, and `.nojekyll` turns off Jekyll.
