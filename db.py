"""
BlueDot Atlas — SQLite persistence (Step 4).

Stores every successful exploration so that:
  - results survive a server restart, and
  - re-clicking a saved marker returns the original recorded info instantly
    (a cache hit) instead of running a fresh, costly generation.

The cache key is the rounded location plus the radius and layer the user
originally chose. Locations are rounded to 4 decimals (~11 m) so that a click
on the "same" spot reliably matches a stored row.
"""

from __future__ import annotations

import os
import sqlite3
from contextlib import closing
from typing import Optional

_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "atlas.sqlite")

# Decimal places used when rounding coordinates for the cache key.
_COORD_PRECISION = 4


def round_coord(value: float) -> float:
    return round(float(value), _COORD_PRECISION)


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    """Create the explorations table if it does not exist."""
    with closing(_connect()) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS explorations (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                lat           REAL NOT NULL,
                lon           REAL NOT NULL,
                radius_km     REAL NOT NULL,
                layer         TEXT NOT NULL,
                response_json TEXT NOT NULL,
                created_at    TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(lat, lon, radius_km, layer)
            )
            """
        )
        # Per-UTC-day counter of real (billable) generation calls. Used to
        # enforce a hard daily cap so the app can never run up a surprise bill.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS api_usage (
                day   TEXT PRIMARY KEY,   -- 'YYYY-MM-DD' in UTC
                count INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        conn.commit()


def _utc_day() -> str:
    with closing(_connect()) as conn:
        return conn.execute("SELECT strftime('%Y-%m-%d', 'now')").fetchone()[0]


def usage_today() -> int:
    """Number of billable generation calls made so far today (UTC)."""
    with closing(_connect()) as conn:
        row = conn.execute(
            "SELECT count FROM api_usage WHERE day = ?", (_utc_day(),)
        ).fetchone()
    return row["count"] if row else 0


def increment_usage() -> int:
    """Record one billable generation call; return the new count for today."""
    day = _utc_day()
    with closing(_connect()) as conn:
        conn.execute(
            """
            INSERT INTO api_usage (day, count) VALUES (?, 1)
            ON CONFLICT(day) DO UPDATE SET count = count + 1
            """,
            (day,),
        )
        conn.commit()
        row = conn.execute(
            "SELECT count FROM api_usage WHERE day = ?", (day,)
        ).fetchone()
    return row["count"]


def decrement_usage() -> None:
    """Refund one reserved slot (e.g. when no billable call actually ran)."""
    with closing(_connect()) as conn:
        conn.execute(
            "UPDATE api_usage SET count = MAX(0, count - 1) WHERE day = ?",
            (_utc_day(),),
        )
        conn.commit()


def get_exploration(
    lat: float, lon: float, radius_km: float, layer: str
) -> Optional[str]:
    """Return the stored response JSON string for this key, or None."""
    with closing(_connect()) as conn:
        row = conn.execute(
            """
            SELECT response_json FROM explorations
            WHERE lat = ? AND lon = ? AND radius_km = ? AND layer = ?
            """,
            (round_coord(lat), round_coord(lon), float(radius_km), layer),
        ).fetchone()
    return row["response_json"] if row else None


def save_exploration(
    lat: float, lon: float, radius_km: float, layer: str, response_json: str
) -> None:
    """Insert or replace the stored response for this key."""
    with closing(_connect()) as conn:
        conn.execute(
            """
            INSERT INTO explorations (lat, lon, radius_km, layer, response_json)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(lat, lon, radius_km, layer)
            DO UPDATE SET response_json = excluded.response_json,
                          created_at    = datetime('now')
            """,
            (
                round_coord(lat),
                round_coord(lon),
                float(radius_km),
                layer,
                response_json,
            ),
        )
        conn.commit()


def list_markers() -> list[dict]:
    """Return all saved markers as lightweight dicts for the frontend."""
    with closing(_connect()) as conn:
        rows = conn.execute(
            """
            SELECT id, lat, lon, radius_km, layer
            FROM explorations
            ORDER BY created_at ASC
            """
        ).fetchall()
    return [dict(r) for r in rows]
