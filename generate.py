"""
BlueDot Atlas — Step 1 spike: grounded generation.

Goal: prove that, given a location + radius + layer, we can produce
structured records (issues, organizations with contacts, cultural context)
that are GROUNDED in real web sources — not invented by the model.

This is a standalone script: no API server, no database, no UI yet.
We just want to eyeball the quality of the output for a few hand-picked
locations before building anything else.

Usage:
    export GEMINI_API_KEY=...        # from https://aistudio.google.com/apikey
    python generate.py               # runs the built-in Amazon sample
    python generate.py --lat -3.46 --lon -62.21 --radius 50 --layer conservation

Stack: Google Gemini API with built-in Google Search grounding (free tier).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, asdict

try:
    from google import genai
    from google.genai import types
except ImportError:
    sys.exit(
        "Missing dependency. Install with:\n"
        "    pip install google-genai\n"
    )


class MissingAPIKeyError(RuntimeError):
    """Raised when GEMINI_API_KEY is not configured."""


# ---------------------------------------------------------------------------
# Output schema
# ---------------------------------------------------------------------------
# We ask the model to return JSON matching this shape. Keeping the schema
# small and explicit makes extraction errors easier to spot.

SCHEMA_HINT = {
    "location_title": "a real, specific place name for this location (e.g. the city/town/region and country), 2-6 words",
    "place_summary": "1-3 sentence human introduction to the area",
    "issues": [
        {
            "title": "short name of the issue",
            "description": "what is happening and why it matters, 1-2 sentences",
            "source_urls": ["https://..."],
        }
    ],
    "organizations": [
        {
            "name": "organization name",
            "description": "what they do locally, 1-2 sentences",
            "website": "https://... or null",
            "email": "contact email or null",
            "phone": "contact phone or null",
            "accepts_volunteers": "true/false/unknown",
            "source_urls": ["https://..."],
        }
    ],
    "cultural_context": "optional short cultural/human note about the place",
}


PROMPT_TEMPLATE = """\
You are a grounded research assistant for BlueDot Atlas, a map where users
click a location to learn what is materially happening there and how to help.

Target area:
- Latitude: {lat}
- Longitude: {lon}
- Radius: approximately {radius} km around that point
- Layer / topic focus: {layer}

Task:
Use Google Search to find REAL, current information about this specific area.
Then return structured information.

Hard rules:
- Every factual claim, organization name, contact detail, and issue MUST be
  traceable to a real web source you actually found. Put those URLs in
  source_urls for each item.
- Do NOT invent organizations, phone numbers, emails, or websites. If you
  cannot find a real contact detail, set it to null. A null is far better
  than a guess.
- Prefer LOCAL and regional organizations actually operating in or near this
  area over large global NGOs, when available.
- If you genuinely cannot find grounded information for this area, return
  empty lists rather than fabricating.

Return ONLY a JSON object (no markdown fences, no commentary) matching this
shape exactly:
{schema}
"""


@dataclass
class GenerationResult:
    lat: float
    lon: float
    radius_km: float
    layer: str
    raw_text: str
    parsed: dict | None = None
    grounding_urls: list[str] = field(default_factory=list)


def build_prompt(lat: float, lon: float, radius: float, layer: str) -> str:
    return PROMPT_TEMPLATE.format(
        lat=lat,
        lon=lon,
        radius=radius,
        layer=layer,
        schema=json.dumps(SCHEMA_HINT, indent=2),
    )


def extract_json(text: str) -> dict | None:
    """Best-effort: strip code fences and parse the first JSON object."""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        # remove leading ```json / ``` and trailing ```
        cleaned = cleaned.split("```", 2)[1]
        if cleaned.startswith("json"):
            cleaned = cleaned[len("json"):]
    cleaned = cleaned.strip().strip("`").strip()
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1:
        return None
    try:
        return json.loads(cleaned[start : end + 1])
    except json.JSONDecodeError:
        return None


def load_env_file(path: str = ".env") -> None:
    """Minimal .env loader (no dependency). Sets vars not already in env."""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            os.environ.setdefault(key, value)


def generate(
    lat: float,
    lon: float,
    radius_km: float,
    layer: str,
    model: str = "gemini-2.5-flash",
    resolve_links: bool = True,
) -> GenerationResult:
    """Run one grounded generation for a location + layer."""
    load_env_file()
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise MissingAPIKeyError(
            "GEMINI_API_KEY is not set. Get a free key at "
            "https://aistudio.google.com/apikey and put it in .env "
            "(GEMINI_API_KEY=...) or export it in your shell."
        )

    client = genai.Client(api_key=api_key)
    prompt = build_prompt(lat, lon, radius_km, layer)

    # Enable the built-in Google Search grounding tool.
    config = types.GenerateContentConfig(
        tools=[types.Tool(google_search=types.GoogleSearch())],
        temperature=0.2,
    )

    response = client.models.generate_content(
        model=model,
        contents=prompt,
        config=config,
    )

    raw_text = response.text or ""
    parsed = extract_json(raw_text)

    # Pull the actual sources Gemini used for grounding, as a cross-check
    # against the URLs the model self-reported in the JSON.
    grounding_urls: list[str] = []
    try:
        for cand in response.candidates or []:
            meta = getattr(cand, "grounding_metadata", None)
            if not meta:
                continue
            for chunk in getattr(meta, "grounding_chunks", None) or []:
                web = getattr(chunk, "web", None)
                if web and getattr(web, "uri", None):
                    grounding_urls.append(web.uri)
    except Exception:
        pass

    result = GenerationResult(
        lat=lat,
        lon=lon,
        radius_km=radius_km,
        layer=layer,
        raw_text=raw_text,
        parsed=parsed,
        grounding_urls=grounding_urls,
    )

    if resolve_links:
        apply_url_resolution(result)

    return result


# ---------------------------------------------------------------------------
# URL resolution
# ---------------------------------------------------------------------------
# Gemini grounding returns opaque vertexaisearch redirect links that expire and
# hide the real publisher. Each link returns an HTTP 3xx whose Location header
# already points at the real destination, so we read that header directly
# instead of following through to the (often slow or blocking) destination page.

_REDIRECT_HOST = "vertexaisearch.cloud.google.com"
_META_REFRESH_RE = re.compile(r"""url=['"]?([^'">\s]+)""", re.IGNORECASE)
_JS_REDIRECT_RE = re.compile(
    r"""(?:location\.(?:replace|href)\s*=\s*|location\s*=\s*)['"]([^'"]+)['"]""",
    re.IGNORECASE,
)
_USER_AGENT = "Mozilla/5.0 (compatible; BlueDotAtlas/0.1; +https://example.org)"


class _CaptureRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Stop urllib from auto-following redirects.

    Returning None from redirect_request makes urllib hand back the raw 3xx
    response instead of fetching the destination, so we can read its Location
    header directly — fast and robust even when the destination is slow or
    blocks bots.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None


_NO_FOLLOW_OPENER = urllib.request.build_opener(_CaptureRedirectHandler())


def resolve_redirect(url: str, timeout: float = 6.0) -> str:
    """Resolve a Google grounding redirect to its real publisher URL.

    Reads the Location header from the redirect response without following it.
    Falls back to parsing a meta-refresh / JS redirect out of an interstitial
    HTML body. Returns the original url unchanged on any failure, so resolution
    can never break generation.
    """
    if not url or _REDIRECT_HOST not in url:
        return url

    req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
    try:
        resp = _NO_FOLLOW_OPENER.open(req, timeout=timeout)
    except urllib.error.HTTPError as err:
        # A 3xx surfaces here as HTTPError; its headers still carry Location.
        resp = err
    except (urllib.error.URLError, ValueError, OSError):
        return url

    try:
        location = resp.headers.get("Location")
        if location and _REDIRECT_HOST not in location:
            return location
        # No usable Location header: inspect the body for a meta/JS redirect.
        body = resp.read(65536).decode("utf-8", errors="ignore")
    except (OSError, ValueError):
        return url
    finally:
        try:
            resp.close()
        except Exception:
            pass

    for pattern in (_META_REFRESH_RE, _JS_REDIRECT_RE):
        match = pattern.search(body)
        if match:
            candidate = match.group(1).strip()
            if candidate.startswith("http") and _REDIRECT_HOST not in candidate:
                return candidate
    return url


def resolve_urls(urls: list[str], max_workers: int = 8) -> dict[str, str]:
    """Resolve a list of redirect URLs in parallel; returns {original: final}."""
    unique = [u for u in dict.fromkeys(urls) if u]
    if not unique:
        return {}
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        resolved = list(pool.map(resolve_redirect, unique))
    return dict(zip(unique, resolved))


def apply_url_resolution(result: "GenerationResult") -> None:
    """Rewrite redirect URLs to their real destination in place.

    Any link that still points at the Google redirect host after resolution is
    a dead/expired token; we drop it so the output never carries broken
    citations.
    """
    all_urls: list[str] = list(result.grounding_urls)
    parsed = result.parsed or {}
    for section in ("issues", "organizations"):
        for item in parsed.get(section, []) or []:
            if isinstance(item, dict):
                all_urls.extend(item.get("source_urls", []) or [])

    mapping = resolve_urls(all_urls)
    if not mapping:
        return

    def clean(urls: list[str]) -> list[str]:
        out = []
        for u in urls:
            resolved = mapping.get(u, u)
            if _REDIRECT_HOST in resolved:
                continue  # unresolved/expired redirect — drop it
            out.append(resolved)
        return out

    result.grounding_urls = clean(result.grounding_urls)
    for section in ("issues", "organizations"):
        for item in parsed.get(section, []) or []:
            if isinstance(item, dict) and item.get("source_urls"):
                item["source_urls"] = clean(item["source_urls"])


def print_result(result: GenerationResult) -> None:
    print("=" * 70)
    print(f"Location: ({result.lat}, {result.lon})  radius={result.radius_km}km")
    print(f"Layer: {result.layer}")
    print("=" * 70)

    if result.parsed is None:
        print("\n[!] Could not parse JSON. Raw model output:\n")
        print(result.raw_text)
    else:
        print(json.dumps(result.parsed, indent=2, ensure_ascii=False))

    print("\n--- Grounding sources Gemini actually used ---")
    if result.grounding_urls:
        for url in result.grounding_urls:
            print(f"  - {url}")
    else:
        print("  (none reported)")


def main() -> None:
    parser = argparse.ArgumentParser(description="BlueDot Atlas grounded generation spike")
    parser.add_argument("--lat", type=float, default=-3.4653, help="latitude")
    parser.add_argument("--lon", type=float, default=-62.2159, help="longitude")
    parser.add_argument("--radius", type=float, default=50.0, help="radius in km")
    parser.add_argument("--layer", type=str, default="conservation", help="layer/topic")
    parser.add_argument("--model", type=str, default="gemini-2.5-flash", help="Gemini model")
    parser.add_argument("--json-only", action="store_true", help="print parsed JSON only")
    parser.add_argument(
        "--no-resolve",
        action="store_true",
        help="skip resolving Google redirect links to real publisher URLs",
    )
    args = parser.parse_args()

    try:
        result = generate(
            args.lat,
            args.lon,
            args.radius,
            args.layer,
            model=args.model,
            resolve_links=not args.no_resolve,
        )
    except MissingAPIKeyError as exc:
        sys.exit(str(exc))

    if args.json_only and result.parsed is not None:
        print(json.dumps(result.parsed, indent=2, ensure_ascii=False))
    else:
        print_result(result)


if __name__ == "__main__":
    main()
