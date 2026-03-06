# FlowDiff

A vanilla JavaScript frontend that visualizes code diffs as flows: functions linked by call relationships. Paste a GitHub PR URL, and FlowDiff extracts changed/added Python functions and builds a call graph. Each flow is named after its root (entry) function.

## Features

- **60/20/20 layout**: Code view (left), selected flow tree (middle), flow list (right)
- **Flow tree**: Indented function tree preserving call order (e.g. func2, func5 under func1; func3, func4 under func2)
- **Synced expansion**: Expanding a function in the flow tree expands it inline in the code view
- **Python only**: Extracts `def` functions from `.py` files; builds call graph from function calls
- **Public repos only**: Fetches diffs directly from GitHub API (no backend)

## Run

**Do not open `index.html` directly** — ES modules require HTTP. Serve the app:

```bash
npm run serve
# or: npm run dev   (uses Python's http.server)

# Open http://localhost:3333 in your browser
# Paste a GitHub PR URL (e.g. https://github.com/owner/repo/pull/123) and click Analyze
```

## Test

```bash
npm test
```

## Structure

- `frontend/` – Static app (HTML, CSS, vanilla JS)
- `frontend/src/` – Main, UI, state, GitHub fetch, parser
- `test/` – Fixtures and smoke tests
