"""
BlueDot Atlas — Pydantic models for the query API (Step 2).

These models turn the loose JSON that generation produces into a validated,
typed response. Validation is the guardrail against the failure modes we saw
in the Step 1 spike:

- prose leaking into URL fields (e.g. a website value of
  "https://...org/ (based on general knowledge, ...)"), and
- organizations whose only "source" is the model's parametric memory.

Anything that does not look like a real http(s) URL is discarded rather than
shown to the user.
"""

from __future__ import annotations

import re
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field, field_validator

# A deliberately strict-but-simple URL check: scheme + host with a dot.
_URL_RE = re.compile(r"^https?://[^\s/$.?#].[^\s]*$", re.IGNORECASE)

# Phrases that betray the model answering from memory instead of a source.
_PARAMETRIC_TELLS = (
    "general knowledge",
    "based on my knowledge",
    "not found",
    "could not find",
    "no specific",
    "i could not",
)


def is_valid_url(value: str) -> bool:
    return bool(_URL_RE.match(value.strip()))


def clean_url_list(urls: Optional[list[str]]) -> list[str]:
    """Keep only well-formed http(s) URLs; drop duplicates, preserve order."""
    if not urls:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for raw in urls:
        if not isinstance(raw, str):
            continue
        url = raw.strip()
        if is_valid_url(url) and url not in seen:
            seen.add(url)
            out.append(url)
    return out


class Volunteers(str, Enum):
    yes = "yes"
    no = "no"
    unknown = "unknown"


def _coerce_volunteers(value) -> "Volunteers":
    """Map the model's free-form true/false/unknown into the enum."""
    if isinstance(value, bool):
        return Volunteers.yes if value else Volunteers.no
    text = str(value).strip().lower()
    if text in ("true", "yes", "y"):
        return Volunteers.yes
    if text in ("false", "no", "n"):
        return Volunteers.no
    return Volunteers.unknown


class Issue(BaseModel):
    title: str
    description: str = ""
    source_urls: list[str] = Field(default_factory=list)

    @field_validator("source_urls", mode="before")
    @classmethod
    def _clean_sources(cls, v):
        return clean_url_list(v)


class Organization(BaseModel):
    name: str
    description: str = ""
    website: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    accepts_volunteers: Volunteers = Volunteers.unknown
    source_urls: list[str] = Field(default_factory=list)

    @field_validator("website", mode="before")
    @classmethod
    def _clean_website(cls, v):
        # Reject prose-polluted or parametric-memory website values.
        if not v or not isinstance(v, str):
            return None
        value = v.strip()
        lowered = value.lower()
        if any(tell in lowered for tell in _PARAMETRIC_TELLS):
            return None
        return value if is_valid_url(value) else None

    @field_validator("email", "phone", mode="before")
    @classmethod
    def _blank_to_none(cls, v):
        if v is None:
            return None
        text = str(v).strip()
        return text or None

    @field_validator("accepts_volunteers", mode="before")
    @classmethod
    def _coerce_vol(cls, v):
        return _coerce_volunteers(v)

    @field_validator("source_urls", mode="before")
    @classmethod
    def _clean_sources(cls, v):
        return clean_url_list(v)

    @property
    def is_grounded(self) -> bool:
        """An org is grounded if it has at least one real source URL."""
        return len(self.source_urls) > 0


class QueryResponse(BaseModel):
    lat: float
    lon: float
    radius_km: float
    layer: str
    place_summary: str = ""
    cultural_context: str = ""
    issues: list[Issue] = Field(default_factory=list)
    organizations: list[Organization] = Field(default_factory=list)
    sources: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)

    @classmethod
    def from_generation(
        cls,
        *,
        lat: float,
        lon: float,
        radius_km: float,
        layer: str,
        parsed: Optional[dict],
        grounding_urls: Optional[list[str]] = None,
        drop_ungrounded_orgs: bool = True,
    ) -> "QueryResponse":
        """Build a validated response from raw generation output.

        Ungrounded organizations (no real source URL) are dropped by default,
        with a warning recorded so the caller knows extraction was imperfect.
        """
        parsed = parsed or {}
        warnings: list[str] = []

        issues = [Issue.model_validate(i) for i in parsed.get("issues", []) or []]

        orgs: list[Organization] = []
        dropped = 0
        for raw in parsed.get("organizations", []) or []:
            org = Organization.model_validate(raw)
            if drop_ungrounded_orgs and not org.is_grounded:
                dropped += 1
                continue
            orgs.append(org)
        if dropped:
            warnings.append(
                f"Dropped {dropped} organization(s) with no grounded source URL."
            )

        return cls(
            lat=lat,
            lon=lon,
            radius_km=radius_km,
            layer=layer,
            place_summary=str(parsed.get("place_summary", "") or ""),
            cultural_context=str(parsed.get("cultural_context", "") or ""),
            issues=issues,
            organizations=orgs,
            sources=clean_url_list(grounding_urls),
            warnings=warnings,
        )
