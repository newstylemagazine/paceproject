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

MAX_IMAGE_DESCRIPTIONS = 2
MAX_TEXT_EXCERPT_CHARS = 3000

# Rewritten for a genuinely literary, intellectual register, per direct
# feedback that the previous "smart friend, plain and direct" voice read as
# flat and artificial. This is NOT "add poetic flourishes" - it's aiming at
# the register of a real essayist: precise, willing to reach for an allusion
# when it actually earns its place, willing to make an actual interpretive
# claim instead of hedging into blandness.
SYNTHESIS_SYSTEM_PROMPT = (
    "You are a widely-read essayist - the register of someone writing a considered profile for "
    "a serious literary magazine, not a chatbot and not a life coach. You're helping someone "
    "think about their life and path by reading closely: what they've written, anything they've "
    "shared (documents, photos), and real voices from an oral-history archive of people "
    "describing turning points in their own lives.\n\n"
    "Write with real intellectual range. When a genuine literary, historical, philosophical, or "
    "artistic reference actually illuminates something specific in what they wrote, reach for it "
    "- but only when it does real work, never as decoration or name-dropping. Favor precise, "
    "considered prose over casual chattiness or generic affirmation; make an actual interpretive "
    "claim about what you notice, rather than hedging toward blandness. Avoid the rhythm of a "
    "typical AI reply - no three-part lists that just restate what they said back at them, no "
    "relentless positivity, no exclamation points.\n\n"
    "Never corporate ('leverage', 'actionable', 'KPIs', 'professional development', 'synergy'), "
    "never therapist-speak ('sit with', 'hold space', 'journey'), never greeting-card sentiment "
    "or inspirational-poster language, and never forced or ornamental poetry for its own sake - "
    "the best essayistic prose is precise and spare, not purple. Be specific and grounded in "
    "what the person actually shared - an essay about them, never a generic one that could apply "
    "to anyone.\n\n"
    "The person may also include reader_notes - each one a running conversation they had "
    "while reading a specific interview, jotting reactions and being asked real follow-up "
    "questions back. Treat these threads as some of the most direct evidence of what's "
    "actually on their mind, and weave them in concretely where relevant.\n\n"
    "Return only valid JSON with these keys:\n"
    "- mirror_headline: a short phrase (under 12 words) reflecting something true or "
    "surprising back to the person, drawn from their own words or what they shared. Sharp and "
    "specific, not a slogan.\n"
    "- reflection: 2-4 sentences of real essayistic prose connecting what they shared to a "
    "larger pattern - noticing something they might not have said outright, in language with "
    "actual intellectual weight behind it.\n"
    "- threads: an array of 2-4 short prompts (each under 20 words), second person - not "
    "action items, but honest, specific questions worth turning over, written with the same "
    "precision as the reflection.\n"
    "- resonances: an array of up to 4 objects with keys 'slug' (must exactly match one of "
    "the provided interview slugs) and 'why' (one precise, specific sentence, under 25 words, "
    "on what resonates - never say 'keyword match' or anything mechanical, and never "
    "sentimental).\n"
    "- provocation: one closing sentence, direct and specific, nudging them to reconsider a "
    "path without prescribing one. An actual provocation, not an inspirational quote."
)

# The site's premise is a conversation between the person writing and the
# interviewees in the archive - the model's job is to notice and narrate a
# real connection between the two, not to become a conversational partner
# itself. It should read like a narrator pointing at a resonance, never
# like someone addressing the reader directly.
RESONANCE_SYSTEM_PROMPT = (
    "Someone is writing about their life and path. An excerpt from a real interview archive "
    "was surfaced alongside what they wrote because it resonates.\n\n"
    "Write ONE short, specific, third-person note - 2 sentences, 35 to 60 words total - that "
    "stays focused on the INTERVIEWEE, not the person writing. It must: (1) name the "
    "interviewee and reference one specific, concrete detail, decision, or moment from what "
    "they actually said (a short quoted phrase helps - never a vague paraphrase or a single "
    "extracted keyword); (2) point out, as an observer, exactly how that detail connects to "
    "what the person just wrote - show the connection concretely, don't just assert it "
    "exists.\n\n"
    "Do not use the word 'you'. Do not ask a question. Do not address the reader directly or "
    "speak as if having a conversation with them - narrate the resonance between two lives "
    "from the outside, the way a documentary caption would.\n\n"
    "Avoid shallow templates and generic phrasing. Be specific and grounded in real details. "
    "Plain and direct - not corporate, not therapist-speak, not a sentimental quote.\n\n"
    'Return only valid JSON: {"note": "..."}'
)

# Unlike RESONANCE_SYSTEM_PROMPT (third person, never addresses the reader,
# never asks a question) - this one is deliberately different. It powers the
# notes panel specifically, a space the person explicitly asked to be a real
# back-and-forth while they read. Here the model DOES speak directly to them
# and DOES ask a real question.
NOTES_REPLY_SYSTEM_PROMPT = (
    "Someone is reading a specific interview from an oral-history archive and taking notes "
    "as they go, in a running conversation with themselves (and now with you). They just "
    "wrote a note. Write ONE genuine, specific follow-up question back to them - a real "
    "back-and-forth, the way a sharp, well-read friend would respond in the margin of a "
    "book, not a customer-service check-in.\n\n"
    "If their note names something specific - a book, author, thinker, historical event, "
    "concept, or work (Proust, Homer, a particular theory, whatever it is) - engage with that "
    "directly and substantively. Show you actually know the thing they mentioned; ask about a "
    "real detail, tension, or idea within it, never a vague 'what does that mean to you'. "
    "Where it genuinely fits, connect it to something specific the interviewee actually said "
    "or lived (using interview_context below) - but never force a connection that isn't "
    "there; a good question about their own reference, on its own, is enough.\n\n"
    "Use recent_thread for continuity - don't repeat a question already asked, and let the "
    "conversation actually build.\n\n"
    "Write in second person, directly to them. One question, 1-2 sentences, under 45 words. "
    "Plain and direct - not corporate, not therapist-speak, not a lecture. Specific, never "
    "generic ('how did that make you feel' is banned).\n\n"
    'Return only valid JSON: {"reply": "..."}'
)

IMAGE_DESCRIPTION_PROMPT = (
    "Someone shared this photo as part of thinking about their life and work. In 1-2 plain, "
    "specific sentences, describe what stands out about it and what it might reveal about "
    "their life, work, or state of mind right now. Be concrete about what you actually see - "
    "avoid generic phrases and avoid sentimental language."
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


# Some scraped transcripts have a "Narrative | <date>" (or "Blog Narrative |
# <date>") label baked directly into the start of the text - scrub it so
# snippets and AI context show the actual voice, not the label.
_BOILERPLATE_PREFIX = re.compile(r"^(?:blog\s+)?narrative\s*\|[^\n]*\n+", re.IGNORECASE)


def strip_boilerplate(text: str) -> str:
    return _BOILERPLATE_PREFIX.sub("", text or "").strip()


# A handful of scraped rows are site navigation ("Find more PhD Narratives on
# our TRaCE McGill website"), not an actual interview - skip them so they
# never surface as a "recommendation".
_JUNK_TITLE = re.compile(r"^find more .*narratives?", re.IGNORECASE)


def is_junk_record(record: dict[str, Any]) -> bool:
    return bool(_JUNK_TITLE.match(str(record.get("title") or "")))


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
        if not slug or is_junk_record(record):
            continue
        title = str(record.get("title") or "")
        tags = " ".join(record.get("tags") or [])
        body = strip_boilerplate(record.get("text") or "")
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


def gather_upload_context(uploads: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    """Read whatever content the browser already extracted from uploads (text
    excerpts for documents, base64 previews for images), describe a couple of
    images with a vision model if a key is available, and return combined
    free text plus the (possibly annotated) uploads list."""

    extra_text_parts: list[str] = []
    image_budget = MAX_IMAGE_DESCRIPTIONS
    annotated: list[dict[str, Any]] = []

    for upload in uploads:
        if not isinstance(upload, dict):
            continue
        item = dict(upload)

        text_excerpt = str(item.get("textExcerpt") or "").strip()
        if text_excerpt:
            extra_text_parts.append(text_excerpt[:MAX_TEXT_EXCERPT_CHARS])

        data_url = item.get("previewDataUrl")
        if data_url and image_budget > 0:
            try:
                description = describe_image(data_url, str(item.get("name") or "photo"))
            except Exception as error:  # noqa: BLE001
                print(f"[ai-vision] image description failed: {error}")
                description = None
            if description:
                item["aiDescription"] = description
                extra_text_parts.append(description)
                image_budget -= 1

        annotated.append(item)

    return " ".join(extra_text_parts), annotated


def _chat_completion(
    *,
    base_url: str,
    api_key: str,
    model: str,
    messages: list[dict[str, Any]],
    json_mode: bool = True,
    timeout: int = 35,
) -> str | None:
    body: dict[str, Any] = {
        "model": model,
        "temperature": 0.6,
        "messages": messages,
    }
    if json_mode:
        body["response_format"] = {"type": "json_object"}

    response = requests.post(
        base_url,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json=body,
        timeout=timeout,
    )
    response.raise_for_status()
    payload = response.json()
    content = payload["choices"][0]["message"]["content"]
    return content if isinstance(content, str) else None


def _clean_json_content(content: str) -> Any:
    content = content.strip()
    if content.startswith("```"):
        content = re.sub(r"^```[a-zA-Z]*\n", "", content)
        content = re.sub(r"\n```$", "", content)
    return json.loads(content)


# --- Provider configuration -------------------------------------------------
# Groq is tried first because it's free with no credit card required.

def _groq_config() -> tuple[str, str] | None:
    api_key = os.environ.get("GROQ_API_KEY", "").strip()
    if not api_key:
        return None
    return api_key, os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")


def _openai_config() -> tuple[str, str] | None:
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        return None
    return api_key, os.environ.get("OPENAI_MODEL", "gpt-4o-mini")


TEXT_PROVIDERS = (
    ("groq", "https://api.groq.com/openai/v1/chat/completions", _groq_config),
    ("openai", "https://api.openai.com/v1/chat/completions", _openai_config),
)

VISION_PROVIDERS = (
    ("groq", "https://api.groq.com/openai/v1/chat/completions", _groq_config, "qwen/qwen3.6-27b"),
    ("openai", "https://api.openai.com/v1/chat/completions", _openai_config, "gpt-4o-mini"),
)


def describe_image(data_url: str, filename: str) -> str | None:
    for provider_name, base_url, config_fn, model in VISION_PROVIDERS:
        config = config_fn()
        if not config:
            continue
        api_key, _text_model = config
        try:
            content = _chat_completion(
                base_url=base_url,
                api_key=api_key,
                model=model,
                json_mode=False,
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": IMAGE_DESCRIPTION_PROMPT},
                            {"type": "image_url", "image_url": {"url": data_url}},
                        ],
                    }
                ],
            )
        except Exception as error:  # noqa: BLE001
            print(f"[ai-vision] {provider_name} failed on {filename}: {error}")
            continue
        if content:
            return content.strip()
    return None


def call_text_provider(messages: list[dict[str, Any]]) -> tuple[str, Any] | None:
    """Try each configured text provider in order, return (provider_name, parsed_json)."""
    for provider_name, base_url, config_fn in TEXT_PROVIDERS:
        config = config_fn()
        if not config:
            continue
        api_key, model = config
        try:
            content = _chat_completion(base_url=base_url, api_key=api_key, model=model, messages=messages)
            if not content:
                continue
            parsed = _clean_json_content(content)
        except Exception as error:  # noqa: BLE001
            print(f"[ai-synthesize] {provider_name} provider failed: {error}")
            continue
        return provider_name, parsed
    return None


def fallback_about_payload(text: str, recommendations: list[dict[str, Any]]) -> dict[str, Any]:
    sentences = sentence_split(text)
    threads_source = pick_sentences(text, r"want|hope|worry|afraid|wonder|dream|stuck|torn|next|maybe", limit=3)
    headline = sentences[0][:90] if sentences else "Nothing written yet"

    kindred = []
    for rec in recommendations[:3]:
        kindred.append({
            "title": rec.get("title") or "A voice from the archive",
            "why": "Their path crosses a few of the same words you just used.",
            "quote": rec.get("snippet") or "",
            "url": rec.get("url") or "#",
        })

    return {
        "mirror_headline": headline,
        "reflection": (
            " ".join(sentences[:3])
            if sentences
            else "Not much to work with yet - a few more specific sentences will surface a pattern."
        ),
        "threads": threads_source or [
            "What part of this haven't you said out loud yet?",
            "If nobody was watching, would you still choose this path?",
        ],
        "kindred_voices": kindred,
        "provocation": "Write more, and the pattern in your own path gets easier to see.",
    }


def normalize_note_entry(raw: Any) -> list[dict[str, str]]:
    # interviewNotes[slug] can be either the legacy single-string format or
    # the current running-conversation format (a list of {role, text} turns
    # - "user" for the person's own notes, "ai" for the follow-up questions
    # the notes panel asked back). Both are normalized to a turn list here.
    if isinstance(raw, str):
        text = raw.strip()
        return [{"role": "user", "text": text}] if text else []
    if isinstance(raw, list):
        turns = []
        for turn in raw:
            if not isinstance(turn, dict):
                continue
            text = str(turn.get("text") or "").strip()
            if not text:
                continue
            role = "ai" if turn.get("role") == "ai" else "user"
            turns.append({"role": role, "text": text})
        return turns
    return []


def gather_interview_notes(interview_notes: Any) -> str:
    if not isinstance(interview_notes, dict):
        return ""
    parts = []
    for raw in interview_notes.values():
        for turn in normalize_note_entry(raw):
            if turn["role"] == "user":
                parts.append(turn["text"])
    return " ".join(parts)


def synthesize(payload: dict[str, Any]) -> dict[str, Any]:
    text = str(payload.get("text") or "").strip()
    uploads = payload.get("uploads") or []
    interview_notes = payload.get("interviewNotes") or {}
    notes_text = gather_interview_notes(interview_notes)

    extra_text, annotated_uploads = gather_upload_context(uploads)
    combined_text = (text + " " + extra_text + " " + notes_text).strip()
    upload_names = [str(item.get("name") or "") for item in annotated_uploads if isinstance(item, dict)]

    recommendations = build_recommendations(combined_text, upload_names)
    recs_by_slug = {rec["slug"]: rec for rec in recommendations}

    about = None
    source = "fallback"

    context = [
        {"slug": rec["slug"], "title": rec["title"], "snippet": rec["snippet"]}
        for rec in recommendations[:5]
    ]
    upload_context = [
        {"name": item.get("name"), "aiDescription": item.get("aiDescription"), "textExcerpt": (item.get("textExcerpt") or "")[:500]}
        for item in annotated_uploads
    ]
    reader_notes = [
        {"slug": slug, "thread": normalize_note_entry(raw)}
        for slug, raw in interview_notes.items()
        if isinstance(interview_notes, dict) and normalize_note_entry(raw)
    ]
    user_payload = {
        "user_text": text,
        "uploads": upload_context,
        "interview_context": context,
        "reader_notes": reader_notes,
    }

    result = call_text_provider(
        [
            {"role": "system", "content": SYNTHESIS_SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(user_payload)},
        ]
    )

    if result:
        provider_name, parsed = result
        if isinstance(parsed, dict):
            kindred_voices = []
            for item in (parsed.get("resonances") or [])[:4]:
                if not isinstance(item, dict):
                    continue
                rec = recs_by_slug.get(item.get("slug"))
                if not rec:
                    continue
                kindred_voices.append({
                    "title": rec["title"],
                    "why": item.get("why") or "",
                    "quote": rec["snippet"],
                    "url": rec["url"],
                })
            about = {
                "mirror_headline": parsed.get("mirror_headline") or "",
                "reflection": parsed.get("reflection") or "",
                "threads": parsed.get("threads") or [],
                "kindred_voices": kindred_voices,
                "provocation": parsed.get("provocation") or "",
            }
            source = provider_name

    if not about:
        about = fallback_about_payload(text, recommendations)

    about["uploads"] = annotated_uploads

    return {
        "source": source,
        "recommendations": recommendations,
        "about": about,
    }


def fallback_resonance_note(excerpt_title: str, excerpt_text: str) -> str:
    # Third-person, no "you", no question - stays about the interviewee,
    # the way the real AI-generated note does. Rule-based safety net only.
    clipped = re.sub(r"\s+", " ", excerpt_text or "").strip()[:160]
    name = str(excerpt_title or "").split(",")[0].strip()
    who = name or "One voice in the archive"
    if not clipped:
        return f"{who}'s story sits close to what was just written."
    return f'{who} described this: "{clipped}..." - a detail that sits close to what was just written.'


def fallback_notes_reply(note_text: str, interview_title: str) -> str:
    # Rule-based safety net for the notes conversation when no AI provider
    # is reachable. Can't actually engage with a specific reference the way
    # the real model can, but tries to anchor on whatever proper noun the
    # person just typed, rather than defaulting to something fully generic.
    trimmed = (note_text or "").strip()
    who = str(interview_title or "").split(",")[0].strip() or "the person you're reading"

    if not trimmed:
        return "What's the detail here that you keep circling back to?"

    # Skip common sentence-initial capitals ("This", "That", "I"...) so the
    # fallback anchors on an actual proper noun (Proust, Homer, ...) instead
    # of just grabbing the first word of the sentence.
    common_capitalized_starters = {
        "This", "That", "These", "Those", "The", "A", "An", "My", "Our", "Your",
        "Their", "His", "Her", "Its", "It", "I", "We", "They", "He", "She", "You",
    }
    candidates = re.findall(r"\b[A-Z][a-zA-Z'-]{2,}(?:\s+[A-Z][a-zA-Z'-]{2,})?\b", trimmed)
    proper_noun = next((word for word in candidates if word.split(" ")[0] not in common_capitalized_starters), None)
    if proper_noun:
        return f"You mentioned {proper_noun} - what's the specific detail or idea there that made you think of {who}?"

    return f"Say more about that - what's underneath it, and how does it sit next to {who}?"


def notes_reply(payload: dict[str, Any]) -> dict[str, Any]:
    note_text = str(payload.get("noteText") or "").strip()
    raw_thread = payload.get("thread") or []
    thread = [
        {
            "role": "ai" if isinstance(turn, dict) and turn.get("role") == "ai" else "user",
            "text": str((turn or {}).get("text") or "")[:600],
        }
        for turn in (raw_thread if isinstance(raw_thread, list) else [])
    ][-6:]
    interview_title = str(payload.get("interviewTitle") or "")
    interview_context = str(payload.get("interviewContext") or "")[:3000]

    user_payload = {
        "note": note_text,
        "recent_thread": thread,
        "interview_title": interview_title,
        "interview_context": interview_context,
    }

    result = call_text_provider(
        [
            {"role": "system", "content": NOTES_REPLY_SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(user_payload)},
        ]
    )

    if result:
        _provider_name, parsed = result
        if isinstance(parsed, dict) and parsed.get("reply"):
            return {"reply": str(parsed["reply"]), "source": _provider_name}

    return {"reply": fallback_notes_reply(note_text, interview_title), "source": "fallback"}


def ask_question(payload: dict[str, Any]) -> dict[str, Any]:
    text = str(payload.get("text") or "").strip()
    match = payload.get("match") or {}
    excerpt_title = str(match.get("title") or "")
    excerpt_text = strip_boilerplate(str(match.get("fullText") or match.get("quote") or ""))

    user_payload = {
        "user_text": text,
        "excerpt_title": excerpt_title,
        "excerpt_text": excerpt_text[:1200],
    }

    result = call_text_provider(
        [
            {"role": "system", "content": RESONANCE_SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(user_payload)},
        ]
    )

    if result:
        _provider_name, parsed = result
        if isinstance(parsed, dict) and parsed.get("note"):
            return {"note": str(parsed["note"]), "source": _provider_name}

    return {"note": fallback_resonance_note(excerpt_title, excerpt_text), "source": "fallback"}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _read_json_body(self) -> dict[str, Any] | None:
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
            return None
        return payload

    def _send_json(self, obj: dict[str, Any], status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(obj).encode("utf-8"))

    def do_POST(self) -> None:
        route = self.path.rstrip("/")

        if route == "/api/ai-synthesize":
            payload = self._read_json_body()
            if payload is None:
                self.send_error(400, "Invalid JSON")
                return
            try:
                self._send_json(synthesize(payload))
            except Exception as error:
                self._send_json({"error": str(error)}, status=500)
            return

        if route == "/api/ai-question":
            payload = self._read_json_body()
            if payload is None:
                self.send_error(400, "Invalid JSON")
                return
            try:
                self._send_json(ask_question(payload))
            except Exception as error:
                self._send_json({"error": str(error)}, status=500)
            return

        if route == "/api/ai-notes-reply":
            payload = self._read_json_body()
            if payload is None:
                self.send_error(400, "Invalid JSON")
                return
            if not str(payload.get("noteText") or "").strip():
                self._send_json({"error": "noteText is required"}, status=400)
                return
            try:
                self._send_json(notes_reply(payload))
            except Exception as error:
                self._send_json({"error": str(error)}, status=500)
            return

        self.send_error(404, "Not found")


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
        print(f"AI endpoints available at /api/ai-synthesize and /api/ai-question (provider: {active_provider})")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
