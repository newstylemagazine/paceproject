#!/usr/bin/env python3

from __future__ import annotations

import http.server
import json
import os
import re
import socketserver
from functools import lru_cache
from pathlib import Path
from typing import Any

import requests


PORT = int(os.environ.get("PORT", "8000"))
ROOT = Path(__file__).resolve().parents[1]
DATASETS = [
    ROOT / "data" / "tracemcgill" / "chunks.jsonl",
    ROOT / "data" / "tracephd" / "chunks.jsonl",
    ROOT / "data" / "tracetransborder" / "chunks.jsonl",
]
STOP_WORDS = {
    "the", "and", "for", "that", "this", "with", "from", "have", "has", "are", "was", "were", "you",
    "your", "our", "their", "about", "into", "after", "before", "will", "would", "should", "could", "can",
    "but", "not", "than", "then", "just", "been", "being", "also", "very", "more", "most", "such", "some",
    "any", "its", "we", "they", "them", "his", "her", "she", "him", "who", "what", "where", "when",
}

SYSTEM_PROMPT = (
    "You generate concise About Me profile JSON for career reflection. "
    "Return only valid JSON with keys: headline, intro, achievements, aspirations, idp, recommendations, uploads. "
    "achievements and aspirations must be arrays of short strings (2-4 items each). "
    "idp must have keys: specific, measurable, abilities, relevant, tenable, support, each a short sentence."
)


def normalize(text: str) -> str:
    return re.sub(r"[^a-z0-9\s]", " ", (text or "").lower())


def extract_terms(text: str, limit: int = 20) -> list[str]:
    counts: dict[str, int] = {}
    for token in normalize(text).split():
        if len(token) <= 2 or token in STOP_WORDS:
            continue
        counts[token] = counts.get(token, 0) + 1
    ranked = sorted(counts.items(), key=lambda item: item[1], reverse=True)
    return [term for term, _ in ranked[:limit]]


def score_text(haystack: str, terms: list[str]) -> int:
    if not haystack:
        return 0
    lower = haystack.lower()
    score = 0
    for term in terms:
        if term in lower:
            score += 1 + min(lower.count(term), 4)
    return score


def sentence_split(text: str) -> list[str]:
    compact = re.sub(r"\s+", " ", text or "").strip()
    if not compact:
        return []
    return [part.strip() for part in re.split(r"(?<=[.!?])\s+", compact) if part.strip()]


def pick_sentences(text: str, pattern: str, limit: int = 3) -> list[str]:
    matcher = re.compile(pattern, flags=re.IGNORECASE)
    return [s for s in sentence_split(text) if matcher.search(s)][:limit]


@lru_cache(maxsize=1)
def load_corpus() -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for path in DATASETS:
        if not path.exists():
            continue
        dataset_id = path.parent.name
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            payload["datasetId"] = dataset_id
            records.append(payload)
    return records


def build_recommendations(text: str, upload_names: list[str]) -> list[dict[str, Any]]:
    terms = extract_terms(text + " " + " ".join(upload_names))
    if not terms:
        return []

    best_by_slug: dict[str, dict[str, Any]] = {}
    for record in load_corpus():
        slug = record.get("slug")
        if not slug:
            continue
        title = str(record.get("title") or "")
        tags = " ".join(record.get("tags") or [])
        body = str(record.get("text") or "")
        score = score_text(title, terms) * 3 + score_text(tags, terms) * 3 + score_text(body, terms)
        if score <= 0:
            continue
        snippet = re.sub(r"\s+", " ", body).strip()[:230]
        current = best_by_slug.get(slug)
        if current and score <= current["score"]:
            continue
        best_by_slug[slug] = {
            "title": title or "Interview",
            "slug": slug,
            "datasetId": record.get("datasetId"),
            "url": record.get("url") or "#",
            "snippet": snippet + ("..." if len(body) > 230 else ""),
            "score": score,
            "matchedTerms": [term for term in terms if term in (title + " " + tags + " " + body).lower()][:4],
        }

    return sorted(best_by_slug.values(), key=lambda item: item["score"], reverse=True)[:6]


def fallback_about_payload(text: str, recommendations: list[dict[str, Any]], uploads: list[dict[str, Any]]) -> dict[str, Any]:
    achievements = pick_sentences(text, r"achiev|built|led|published|created|completed|improved|launched")
    aspirations = pick_sentences(text, r"aspir|aim|goal|want|hope|future|next|plan|impact")
    support = pick_sentences(text, r"mentor|network|support|community|team|advisor|resource", limit=2)
    risks = pick_sentences(text, r"challenge|obstacle|risk|if\s+.*then", limit=2)
    sentences = sentence_split(text)
    intro = " ".join(sentences[:2]) if sentences else "A motivated learner shaping a clear path through reflection and action."

    return {
        "headline": sentences[0] if sentences else "My evolving professional story",
        "intro": intro,
        "achievements": achievements or ["I am actively building evidence of growth through meaningful projects and learning outcomes."],
        "aspirations": aspirations or ["I am defining the next phase of my path with clear goals and purpose."],
        "idp": {
            "specific": aspirations[0] if aspirations else "Develop toward a role where my strengths create social and professional impact.",
            "measurable": "Track milestones every month: one project output, one relationship-building action, and one documented reflection.",
            "abilities": "Strengthen communication, research, collaboration, and strategic decision making through practice and feedback.",
            "relevant": "Align opportunities with values, lived experience, and long-term contribution.",
            "tenable": risks[0] if risks else "If momentum drops, then use mentor check-ins and smaller weekly goals to regain traction.",
            "support": " ".join(support) if support else "Build support through mentors, peers, and communities linked to your direction.",
        },
        "recommendations": recommendations[:4],
        "uploads": uploads,
        "createdAt": "",
    }


def _call_openai_compatible(
    *,
    base_url: str,
    api_key: str,
    model: str,
    text: str,
    recommendations: list[dict[str, Any]],
    uploads: list[dict[str, Any]],
    timeout: int = 35,
) -> dict[str, Any] | None:
    """Call any OpenAI-compatible /chat/completions endpoint (OpenAI, Groq, etc.)."""

    top_context = [
        {
            "title": rec.get("title"),
            "snippet": rec.get("snippet"),
            "matchedTerms": rec.get("matchedTerms"),
        }
        for rec in recommendations[:4]
    ]

    user_payload = {
        "user_text": text,
        "recommended_interview_context": top_context,
        "uploads": uploads,
    }

    response = requests.post(
        base_url,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": model,
            "temperature": 0.4,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": json.dumps(user_payload)},
            ],
        },
        timeout=timeout,
    )
    response.raise_for_status()
    payload = response.json()
    content = payload["choices"][0]["message"]["content"]
    if not isinstance(content, str):
        return None

    # Strip markdown fences if the model wraps its JSON.
    content = content.strip()
    if content.startswith("```"):
        content = re.sub(r"^```[a-zA-Z]*\n", "", content)
        content = re.sub(r"\n```$", "", content)

    parsed = json.loads(content)
    if not isinstance(parsed, dict):
        return None

    parsed["recommendations"] = recommendations[:4]
    parsed["uploads"] = uploads
    return parsed


def call_groq_about(text: str, recommendations: list[dict[str, Any]], uploads: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Free-tier AI provider (https://console.groq.com) - no credit card required."""

    api_key = os.environ.get("GROQ_API_KEY", "").strip()
    if not api_key:
        return None

    model = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")
    return _call_openai_compatible(
        base_url="https://api.groq.com/openai/v1/chat/completions",
        api_key=api_key,
        model=model,
        text=text,
        recommendations=recommendations,
        uploads=uploads,
    )


def call_openai_about(text: str, recommendations: list[dict[str, Any]], uploads: list[dict[str, Any]]) -> dict[str, Any] | None:
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        return None

    model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
    return _call_openai_compatible(
        base_url="https://api.openai.com/v1/chat/completions",
        api_key=api_key,
        model=model,
        text=text,
        recommendations=recommendations,
        uploads=uploads,
    )


# Providers are tried in order. Groq is first because it's free with no credit
# card required, so it's the best default for anyone forking this project.
PROVIDERS = (
    ("groq", call_groq_about),
    ("openai", call_openai_about),
)


def synthesize(payload: dict[str, Any]) -> dict[str, Any]:
    text = str(payload.get("text") or "").strip()
    uploads = payload.get("uploads") or []
    upload_names = [str(item.get("name") or "") for item in uploads if isinstance(item, dict)]

    recommendations = build_recommendations(text, upload_names)

    about = None
    source = "fallback"
    for provider_name, provider_fn in PROVIDERS:
        try:
            about = provider_fn(text, recommendations, uploads)
        except Exception as error:  # noqa: BLE001 - never let a provider outage break the page
            print(f"[ai-synthesize] {provider_name} provider failed: {error}")
            about = None
        if about:
            source = provider_name
            break

    if not about:
        about = fallback_about_payload(text, recommendations, uploads)

    return {
        "source": source,
        "recommendations": recommendations,
        "about": about,
    }


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_POST(self) -> None:
        if self.path.rstrip("/") != "/api/ai-synthesize":
            self.send_error(404, "Not found")
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        raw = self.rfile.read(content_length) if content_length > 0 else b"{}"

        try:
            payload = json.loads(raw.decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("Payload must be object")
        except Exception:
            self.send_error(400, "Invalid JSON")
            return

        try:
            result = synthesize(payload)
        except Exception as error:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(error)}).encode("utf-8"))
            return

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(result).encode("utf-8"))


class ReusableThreadingTCPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> None:
    with ReusableThreadingTCPServer(("", PORT), Handler) as httpd:
        active_provider = "fallback (no API key set)"
        if os.environ.get("GROQ_API_KEY", "").strip():
            active_provider = "Groq"
        elif os.environ.get("OPENAI_API_KEY", "").strip():
            active_provider = "OpenAI"
        print(f"Serving TRaCE Searchable at http://localhost:{PORT}/site/")
        print(f"AI endpoint available at /api/ai-synthesize (provider: {active_provider})")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
