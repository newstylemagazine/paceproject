#!/usr/bin/env python3

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from html import unescape
from pathlib import Path
from typing import Iterable
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup, Tag


BASE_URL = "https://tracephd.com"
NARRATIVES_URL = f"{BASE_URL}/category/narrative/"
REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}
TIMEOUT = 30
OUTPUT_DIR = Path("data/tracephd")
TRANSCRIPTS_DIR = OUTPUT_DIR / "transcripts"


@dataclass
class ListingRecord:
    url: str
    title: str | None
    published: str | None
    tags: list[str]
    summary: str | None


def fetch(url: str) -> str:
    response = requests.get(url, headers=REQUEST_HEADERS, timeout=TIMEOUT)
    response.raise_for_status()
    return response.text


def normalize_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", unescape(text)).strip()


def slug_from_url(url: str) -> str:
    path = urlparse(url).path.rstrip("/")
    return path.split("/")[-1]


def parse_listing_date(article: Tag) -> str | None:
    heading = article.find("h2")
    if heading is None:
        return None

    text = normalize_whitespace(heading.get_text(" ", strip=True))
    match = re.search(r"\|\s*([A-Za-z]+\s+\d{1,2},\s+\d{4})", text)
    if match:
        return match.group(1)
    return None


def parse_listing_title(article: Tag) -> str | None:
    candidates: list[str] = []
    for anchor in article.select("a[href]"):
        href = anchor.get("href", "")
        text = normalize_whitespace(anchor.get_text(" ", strip=True))
        if not href.startswith(BASE_URL):
            continue
        if not text or text == "View Article":
            continue
        if "/tag/" in href or "/category/" in href:
            continue
        candidates.append(text)

    if not candidates:
        return None

    return max(candidates, key=len)


def parse_listing_summary(article: Tag) -> str | None:
    for paragraph in article.find_all("p"):
        text = normalize_whitespace(paragraph.get_text(" ", strip=True))
        if text and not text.startswith("Q:"):
            return text
    return None


def parse_narrative_links() -> list[ListingRecord]:
    records: list[ListingRecord] = []
    seen_links: set[str] = set()
    seen_pages: set[str] = set()
    next_page = NARRATIVES_URL

    while next_page and next_page not in seen_pages:
        seen_pages.add(next_page)
        soup = BeautifulSoup(fetch(next_page), "html.parser")
        articles = soup.select("article.category-narrative")
        if not articles:
            break

        for article in articles:
            primary_link = None
            for anchor in article.select("a[href]"):
                href = anchor.get("href", "")
                text = normalize_whitespace(anchor.get_text(" ", strip=True))
                if not href.startswith(BASE_URL):
                    continue
                if "/tag/" in href or "/category/" in href:
                    continue
                if text == "View Article" or not text:
                    continue
                primary_link = href
                break

            if primary_link is None or primary_link in seen_links:
                continue

            tags = [normalize_whitespace(tag.get_text(" ", strip=True)) for tag in article.select('a[href*="/tag/"]')]
            records.append(
                ListingRecord(
                    url=primary_link,
                    title=parse_listing_title(article),
                    published=parse_listing_date(article),
                    tags=tags,
                    summary=parse_listing_summary(article),
                )
            )
            seen_links.add(primary_link)

        next_anchor = soup.select_one("a.next[href], a[rel='next']")
        next_page = next_anchor.get("href") if next_anchor else None

    return records


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


def dedupe_pairs(qa_pairs: list[dict]) -> list[dict]:
    deduped: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for qa in qa_pairs:
        key = (qa["question"], qa["answer"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(qa)
    return deduped


def parse_article(listing: ListingRecord) -> dict:
    soup = BeautifulSoup(fetch(listing.url), "html.parser")
    article = soup.select_one("article") or soup

    title = None
    for heading in soup.select("h1"):
        text = normalize_whitespace(heading.get_text(" ", strip=True))
        if text:
            title = text
            break
    if title is None:
        title = listing.title or slug_from_url(listing.url)

    qa_pairs: list[dict] = []
    current_question: str | None = None
    current_answer_parts: list[str] = []
    intro_parts: list[str] = []

    for node in article.find_all(["p", "h2", "h3", "li"], recursive=True):
        text = normalize_whitespace(node.get_text(" ", strip=True))
        if not text:
            continue
        if text == title:
            continue

        if is_question_node(node, text):
            if current_question is not None:
                answer = "\n\n".join(current_answer_parts).strip()
                qa_pairs.append({"question": current_question, "answer": answer})
            current_question = text
            current_answer_parts = []
            continue

        if current_question is None:
            intro_parts.append(text)
            continue

        current_answer_parts.append(text)

    if current_question is not None:
        answer = "\n\n".join(current_answer_parts).strip()
        qa_pairs.append({"question": current_question, "answer": answer})

    qa_pairs = dedupe_pairs(qa_pairs)

    intro = None
    if intro_parts:
        intro = intro_parts[0]
    elif listing.summary:
        intro = listing.summary

    transcript_parts: list[str] = []
    if intro:
        transcript_parts.append(intro)
    for qa in qa_pairs:
        transcript_parts.append(qa["question"])
        if qa["answer"]:
            transcript_parts.append(qa["answer"])

    return {
        "slug": slug_from_url(listing.url),
        "url": listing.url,
        "title": title,
        "published": listing.published,
        "tags": listing.tags,
        "intro": intro,
        "qa_pairs": qa_pairs,
        "transcript_text": "\n\n".join(transcript_parts).strip(),
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
        "",
    ]

    if record["intro"]:
        lines.extend([record["intro"], ""])

    for qa in record["qa_pairs"]:
        lines.append(f"## {qa['question']}")
        lines.append("")
        if qa["answer"]:
            lines.append(qa["answer"])
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