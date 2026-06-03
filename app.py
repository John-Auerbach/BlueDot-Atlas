"""
BlueDot Atlas — Step 2 API.

Wraps the grounded generation in an HTTP endpoint with validated output.

Run:
    .venv/bin/uvicorn app:app --reload --port 8000

Then open:
    http://localhost:8000/query?lat=-3.46&lon=-62.21&radius=50&layer=conservation
    http://localhost:8000/docs        (interactive API docs)

Step 2 deliberately has no cache or verification yet — those are later steps.
Every request runs a fresh generation.
"""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

import generate
import db
from models import QueryResponse

# Load .env early so environment-based settings (e.g. DAILY_API_LIMIT) are
# available when this module is imported, not just inside generate().
generate.load_env_file()

_WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

app = FastAPI(
    title="BlueDot Atlas API",
    version="0.2.0",
    description="Click a location, get grounded local issues and organizations.",
)

# Allow a browser frontend (the future globe) to call us during local dev.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)

# generate() is blocking (network I/O); run it off the event loop so the
# server stays responsive.
_executor = ThreadPoolExecutor(max_workers=4)

# Hard daily cap on billable generation calls (cache hits are free and do not
# count). Set DAILY_API_LIMIT in the environment to override. This is a code-
# enforced cutoff so the app can never run up a surprise bill in production,
# independent of any Google Cloud budget (which only alerts, never stops).
DAILY_API_LIMIT = int(os.environ.get("DAILY_API_LIMIT", "50"))

# Ensure the persistence layer exists before serving requests.
db.init_db()


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/usage")
def usage() -> dict:
    """Today's billable API usage against the hard daily cap."""
    used = db.usage_today()
    return {
        "used": used,
        "limit": DAILY_API_LIMIT,
        "remaining": max(0, DAILY_API_LIMIT - used),
    }


@app.get("/markers")
def markers() -> list[dict]:
    """All saved explorations as lightweight markers for the globe."""
    return db.list_markers()


@app.get("/query", response_model=QueryResponse)
async def query(
    lat: float = Query(..., ge=-90, le=90, description="latitude"),
    lon: float = Query(..., ge=-180, le=180, description="longitude"),
    radius: float = Query(50.0, gt=0, le=1000, description="radius in km"),
    layer: str = Query("conservation", min_length=1, max_length=64),
) -> QueryResponse:
    """Generate grounded, validated info for a location + layer."""
    import asyncio

    # Return the originally recorded result if this exact place + radius +
    # layer was explored before (survives server restarts).
    cached = db.get_exploration(lat, lon, radius, layer)
    if cached is not None:
        return QueryResponse.model_validate_json(cached)

    # Hard cutoff: refuse new (billable) generations once the daily cap is hit.
    # Checked only on a cache miss, so revisiting saved places always works.
    if db.usage_today() >= DAILY_API_LIMIT:
        raise HTTPException(
            status_code=429,
            detail=(
                f"Daily exploration limit reached ({DAILY_API_LIMIT}). "
                "This cap protects against unexpected API charges. "
                "Previously explored places are still available, and the "
                "limit resets at 00:00 UTC."
            ),
        )

    # Reserve a slot up-front so concurrent requests can't overshoot the cap.
    if db.increment_usage() > DAILY_API_LIMIT:
        raise HTTPException(
            status_code=429,
            detail=f"Daily exploration limit reached ({DAILY_API_LIMIT}).",
        )

    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            _executor,
            lambda: generate.generate(lat, lon, radius, layer),
        )
    except generate.MissingAPIKeyError as exc:
        # Misconfiguration, not the client's fault — 503. No API call was made,
        # so refund the reserved slot.
        db.decrement_usage()
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        # Upstream model errors (e.g. Gemini 503 high demand) surface here.
        raise HTTPException(
            status_code=502,
            detail=f"Generation failed: {type(exc).__name__}: {exc}",
        ) from exc

    if result.parsed is None:
        raise HTTPException(
            status_code=502,
            detail="Generation returned unparseable output.",
        )

    response = QueryResponse.from_generation(
        lat=lat,
        lon=lon,
        radius_km=radius,
        layer=layer,
        parsed=result.parsed,
        grounding_urls=result.grounding_urls,
    )

    # Persist so this marker is restored on reload and re-clicks are instant.
    db.save_exploration(lat, lon, radius, layer, response.model_dump_json())
    return response


# Serve the Globe.gl frontend. Mounted last so /health and /query take
# precedence. html=True makes "/" return web/index.html.
if os.path.isdir(_WEB_DIR):
    app.mount("/", StaticFiles(directory=_WEB_DIR, html=True), name="web")
