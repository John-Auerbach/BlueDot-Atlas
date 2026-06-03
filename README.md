# BlueDot Atlas

Click anywhere on a 3D globe to explore grounded local issues and
organizations for that place. A FastAPI backend calls the Google Gemini API
(with Google Search grounding) and a Globe.gl frontend renders the results.

## Prerequisites

- Python 3.12+
- A free Gemini API key from <https://aistudio.google.com/apikey>

## Setup

Create a virtual environment and install dependencies:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

> Note: invoke tools via `.venv/bin/python -m <tool>` rather than the wrapper
> scripts (`.venv/bin/pip`, `.venv/bin/uvicorn`). If a venv is ever copied or
> its parent folder is renamed, those wrappers keep a stale shebang and fail
> with "Command not found"; going through `python -m` always works.

Configure your API key in a `.env` file at the project root:

```bash
echo 'GEMINI_API_KEY=your_key_here' > .env
```

## Cost protection (hard daily cap)

Every new exploration makes one billable Gemini API call; re-opening a
previously explored place is served from the local SQLite cache and is free.

To prevent surprise charges, the app enforces a **hard daily cap** on billable
calls, counted per UTC day and stored in the database (so it survives
restarts). Once the cap is hit, new explorations return HTTP 429 while cached
places keep working. The limit resets at 00:00 UTC.

Set the cap with `DAILY_API_LIMIT` (default `50`):

```bash
DAILY_API_LIMIT=200 .venv/bin/python -m uvicorn app:app --port 8000
```

Check today's usage at any time:

```bash
curl http://localhost:8000/usage   # {"used":N,"limit":50,"remaining":...}
```

> This code-enforced cutoff is independent of Google Cloud budgets, which only
> send alerts and never actually stop spending. For deployment, set
> `DAILY_API_LIMIT` to a value whose worst-case cost you are comfortable with.

## Run

Start the API + web server:

```bash
.venv/bin/python -m uvicorn app:app --port 8000
```

Then open:

- App (globe UI): <http://localhost:8000/>
- Interactive API docs: <http://localhost:8000/docs>
- Health check: <http://localhost:8000/health>
- Example query:
  <http://localhost:8000/query?lat=-3.46&lon=-62.21&radius=50&layer=conservation>

For auto-reload during development, add `--reload`:

```bash
.venv/bin/python -m uvicorn app:app --reload --port 8000
```

> Tip: after editing files in `web/`, do a hard refresh in the browser to
> bypass the cache and see your changes — `Ctrl+Shift+R` (Linux/Windows) or
> `Cmd+Shift+R` (Mac).

## Stop / close

Press `Ctrl+C` in the terminal running the server.

If it is running in the background or the port is stuck, free port 8000:

```bash
lsof -ti:8000 | xargs -r kill -9
```

## Project structure

```
app.py            FastAPI app: /query, /health, serves the web UI
generate.py       Grounded generation via the Gemini API
models.py         Pydantic models for validated responses
requirements.txt  Python dependencies
web/
  index.html      Globe UI markup and styles
  app.js          Globe.gl frontend logic
```
