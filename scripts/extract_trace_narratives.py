#!/usr/bin/env python3

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from html import unescape
from pathlib import Path
from typing import Iterable
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup, Tag


BASE_URL = "https://tracemcgill.com"
NARRATIVES_URL = f"{BASE_URL}/narratives/"
USER_AGENT = "paceproject-transcript-extractor/1.0"
TIMEOUT = 30
OUTPUT_DIR = Path("data/tracemcgill")
TRANSCRIPTS_DIR = OUTPUT_DIR / "transcripts"


@dataclass
class AudioClip:
    src: str | None
    caption: str | None


@dataclass
class ListingRecord:
    url: str
    title: str | None
    published: str | None
    tags: list[str]
    summary: str | None


def fetch(url: str) -> str:
    response = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT)
    response.raise_for_status()
    return response.text


def normalize_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", unescape(text)).strip()


def is_question_node(node: Tag, text: str) -> bool:
    if text.startswith("Q:"):
        return True

    strong = node.find("strong")
    if strong is None:
        return False

    strong_text = normalize_whitespace(strong.get_text(" ", strip=True))
    if not strong_text:
        return False

    return strong_text.endswith("?") or text.endswith("?")


def slug_from_url(url: str) -> str:
    path = urlparse(url).path.rstrip("/")
    return path.split("/")[-1]


def parse_narrative_links() -> list[ListingRecord]:
    records: list[ListingRecord] = []
    seen_links: set[str] = set()
    seen_pages: set[str] = set()
    next_page = NARRATIVES_URL

    while next_page and next_page not in seen_pages:
        seen_pages.add(next_page)
        soup = BeautifulSoup(fetch(next_page), "html.parser")

        cards = soup.select(".rt-holder")
        if not cards:
            break

        for card in cards:
            anchor = card.select_one("h2.entry-title a[href]")
            if anchor is None:
                continue

            href = anchor.get("href", "")
            if not href.startswith(BASE_URL) or href in seen_links:
                continue

            date_el = card.select_one(".post-meta-user .date")
            tag_els = card.select(".post-meta-tags a")
            summary_el = card.select_one(".post-content")

            records.append(
                ListingRecord(
                    url=href,
                    title=normalize_whitespace(anchor.get_text(" ", strip=True)) or None,
                    published=normalize_whitespace(date_el.get_text(" ", strip=True)) if date_el else None,
                    tags=[normalize_whitespace(tag.get_text(" ", strip=True)) for tag in tag_els],
                    summary=normalize_whitespace(summary_el.get_text(" ", strip=True)) if summary_el else None,
                )
            )
            seen_links.add(href)

        next_anchor = soup.select_one("a.next.page-numbers[href]")
        next_page = next_anchor.get("href") if next_anchor else None

    return records


def parse_audio_clips(article: Tag) -> list[AudioClip]:
    clips: list[AudioClip] = []
    for figure in article.select("figure.wp-block-audio"):
        audio = figure.find("audio")
        caption = figure.find("figcaption")
        clips.append(
            AudioClip(
                src=audio.get("src") if audio else None,
                caption=normalize_whitespace(caption.get_text(" ", strip=True)) if caption else None,
            )
        )
    return clips


def parse_article(listing: ListingRecord) -> dict:
    url = listing.url
    soup = BeautifulSoup(fetch(url), "html.parser")
    article = soup.select_one("article") or soup.select_one("main")
    if article is None:
        article = soup.select_one("#content") or soup

    title_el = soup.select_one("h1.entry-title") or soup.select_one("h1")
    title = normalize_whitespace(title_el.get_text(" ", strip=True)) if title_el else (listing.title or slug_from_url(url))

    published = listing.published

    tags = listing.tags

    paragraphs: list[str] = []
    qa_pairs: list[dict] = []
    current_question: str | None = None
    current_answer_parts: list[str] = []

    content_root = article.select_one(".entry-content") or article
    for node in content_root.find_all(["p", "h2", "h3", "li"], recursive=True):
        if node.find_parent("figure", class_="wp-block-audio"):
            continue

        text = normalize_whitespace(node.get_text(" ", strip=True))
        if not text:
            continue

        if is_question_node(node, text):
            if current_question is not None:
                answer = "\n\n".join(current_answer_parts).strip()
                qa_pairs.append({"question": current_question, "answer": answer})
                paragraphs.append(current_question)
                if answer:
                    paragraphs.append(answer)
            current_question = text
            current_answer_parts = []
            continue

        if current_question is None:
            paragraphs.append(text)
            continue

        current_answer_parts.append(text)

    if current_question is not None:
        answer = "\n\n".join(current_answer_parts).strip()
        qa_pairs.append({"question": current_question, "answer": answer})
        paragraphs.append(current_question)
        if answer:
            paragraphs.append(answer)

    intro = None
    if paragraphs and not paragraphs[0].startswith("Q:"):
        intro = paragraphs[0]
    elif listing.summary:
        intro = listing.summary

    audio_clips = [clip.__dict__ for clip in parse_audio_clips(article)]
    transcript_text = "\n\n".join(paragraphs).strip()

    return {
        "slug": slug_from_url(url),
        "url": url,
        "title": title,
        "published": published,
        "tags": tags,
        "intro": intro,
        "qa_pairs": qa_pairs,
        "audio_clips": audio_clips,
        "transcript_text": transcript_text,
    }


def chunk_record(record: dict) -> Iterable[dict]:
    for index, qa in enumerate(record["qa_pairs"], start=1):
        text = "\n\n".join(part for part in [qa["question"], qa["answer"]] if part).strip()
        if not text:
            continue
        yield {
            "id": f"{record['slug']}#qa-{index}",
            "slug": record["slug"],
            "title": record["title"],
            "url": record["url"],
            "published": record["published"],
            "tags": record["tags"],
            "question": qa["question"],
            "answer": qa["answer"],
            "text": text,
        }


def write_markdown(record: dict) -> None:
    lines = [
        f"# {record['title']}",
        "",
        f"- Source: {record['url']}",
        f"- Published: {record['published'] or 'Unknown'}",
        f"- Tags: {', '.join(record['tags']) if record['tags'] else 'None'}",
    ]

    if record["audio_clips"]:
        lines.append(f"- Audio clips: {len(record['audio_clips'])}")

    lines.append("")

    if record["intro"]:
        lines.extend([record["intro"], ""])

    for qa in record["qa_pairs"]:
        lines.append(f"## {qa['question']}")
        lines.append("")
        if qa["answer"]:
            lines.append(qa["answer"])
            lines.append("")

    if record["audio_clips"]:
        lines.extend(["## Embedded Audio Clips", ""])
        for clip in record["audio_clips"]:
            lines.append(f"- URL: {clip['src'] or 'Unknown'}")
            lines.append(f"- Caption: {clip['caption'] or 'None'}")
            lines.append("")

    markdown = "\n".join(lines).rstrip() + "\n"
    (TRANSCRIPTS_DIR / f"{record['slug']}.md").write_text(markdown, encoding="utf-8")


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)

    listings = parse_narrative_links()
    records = [parse_article(listing) for listing in listings]
    records = [record for record in records if record["qa_pairs"]]
    records.sort(key=lambda item: item["published"] or "")

    chunks = [chunk for record in records for chunk in chunk_record(record)]
    generated_at = datetime.now(timezone.utc).isoformat()

    manifest = {
        "source": NARRATIVES_URL,
        "generated_at": generated_at,
        "interview_count": len(records),
        "chunk_count": len(chunks),
        "interviews": records,
    }

    (OUTPUT_DIR / "interviews.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    with (OUTPUT_DIR / "chunks.jsonl").open("w", encoding="utf-8") as handle:
        for chunk in chunks:
            handle.write(json.dumps(chunk, ensure_ascii=False) + "\n")

    for record in records:
        write_markdown(record)

    print(f"Extracted {len(records)} interviews and {len(chunks)} Q/A chunks into {OUTPUT_DIR}")


if __name__ == "__main__":
    main()