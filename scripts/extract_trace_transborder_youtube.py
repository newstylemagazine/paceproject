The terminal process "/bin/bash" terminated with exit code: 1.#!/usr/bin/env python3

from __future__ import annotations

import json
import re
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import requests
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import YouTubeRequestFailed
from yt_dlp import YoutubeDL


CHANNEL_URL = "https://www.youtube.com/@TRaCETransborder/videos"
OUTPUT_DIR = Path("data/tracetransborder")
TRANSCRIPTS_DIR = OUTPUT_DIR / "transcripts"
TMP_DIR = OUTPUT_DIR / ".tmp"
COOKIE_FILE = Path("data/tracetransborder/youtube-cookies.txt")


@dataclass
class VideoRecord:
    video_id: str
    url: str
    title: str
    published: str | None
    channel: str | None
    tags: list[str]
    transcript_text: str
    segments: list[dict]


@dataclass
class Cue:
    start_sec: float
    end_sec: float
    text: str


def normalize_space(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower())
    slug = re.sub(r"-+", "-", slug).strip("-")
    return slug or "video"


def format_upload_date(date_text: str | None) -> str | None:
    if not date_text or len(date_text) != 8:
        return None
    try:
        dt = datetime.strptime(date_text, "%Y%m%d")
        return dt.strftime("%Y-%m-%d")
    except ValueError:
        return None


def parse_timestamp(value: str) -> float:
    # Accepts HH:MM:SS.mmm or MM:SS.mmm formats.
    cleaned = value.replace(",", ".").strip()
    parts = cleaned.split(":")
    try:
        if len(parts) == 3:
            hours, minutes, seconds = parts
            return int(hours) * 3600 + int(minutes) * 60 + float(seconds)
        if len(parts) == 2:
            minutes, seconds = parts
            return int(minutes) * 60 + float(seconds)
    except ValueError:
        return 0.0
    return 0.0


def parse_vtt_cues(vtt_path: Path) -> list[Cue]:
    lines = vtt_path.read_text(encoding="utf-8", errors="ignore").splitlines()
    cues: list[Cue] = []

    current_start: float | None = None
    current_end: float | None = None
    current_text: list[str] = []

    def flush() -> None:
        nonlocal current_start, current_end, current_text
        if current_start is None or current_end is None:
            current_text = []
            return

        text = normalize_space(" ".join(current_text))
        if not text:
            current_text = []
            return

        if cues and cues[-1].text == text and abs(cues[-1].start_sec - current_start) < 0.25:
            current_text = []
            return

        cues.append(Cue(start_sec=current_start, end_sec=current_end, text=text))
        current_text = []

    for raw in lines:
        line = raw.strip()
        if not line:
            flush()
            current_start = None
            current_end = None
            continue
        if line.startswith("WEBVTT"):
            continue
        if re.fullmatch(r"\d+", line):
            continue
        if "-->" in line:
            flush()
            left, right = line.split("-->", maxsplit=1)
            start = parse_timestamp(left)
            end = parse_timestamp(right.split()[0])
            current_start = start
            current_end = end
            current_text = []
            continue

        cleaned = re.sub(r"<[^>]+>", "", line)
        cleaned = re.sub(r"\s*align:[^\s]+", "", cleaned)
        cleaned = re.sub(r"\s*position:[^\s]+", "", cleaned)
        cleaned = normalize_space(cleaned)
        if cleaned:
            current_text.append(cleaned)

    flush()
    return cues


def discover_video_ids(channel_url: str) -> list[str]:
    opts = {
        "quiet": True,
        "skip_download": True,
        "extract_flat": True,
        "ignoreerrors": True,
        "extractor_args": {"youtube": {"player_client": ["android", "web", "tv_embedded"]}},
    }
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(channel_url, download=False)

    entries = info.get("entries", []) if isinstance(info, dict) else []
    video_ids: list[str] = []

    for entry in entries:
        if not isinstance(entry, dict):
            continue
        video_id = entry.get("id")
        if not video_id:
            continue
        video_ids.append(str(video_id))

    return video_ids


def fetch_video_metadata(video_url: str) -> dict:
    opts = {
        "quiet": True,
        "skip_download": True,
        "ignoreerrors": False,
        "extractor_args": {"youtube": {"player_client": ["android", "web", "tv_embedded"]}},
    }
    if COOKIE_FILE.exists():
        opts["cookiefile"] = str(COOKIE_FILE)

    with YoutubeDL(opts) as ydl:
        return ydl.extract_info(video_url, download=False)


def download_subtitles(video_url: str, tmp_dir: Path) -> Path | None:
    opts = {
        "quiet": True,
        "skip_download": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": ["en", "en-US", "en-CA", "en.*"],
        "subtitlesformat": "vtt",
        "outtmpl": str(tmp_dir / "%(id)s.%(ext)s"),
        "ignoreerrors": True,
        "extractor_args": {"youtube": {"player_client": ["android", "web", "tv_embedded"]}},
    }
    if COOKIE_FILE.exists():
        opts["cookiefile"] = str(COOKIE_FILE)

    with YoutubeDL(opts) as ydl:
        ydl.download([video_url])

    candidates = sorted(tmp_dir.glob("*.vtt"), key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[0] if candidates else None


def chunk_cues(cues: list[Cue], max_chars: int = 850, max_span_sec: float = 140.0) -> Iterable[dict]:
    current_text: list[str] = []
    current_start: float | None = None
    current_end: float | None = None

    for cue in cues:
        candidate_text = " ".join([*current_text, cue.text]).strip()
        span_would_be = (cue.end_sec - (current_start if current_start is not None else cue.start_sec))

        if current_text and (len(candidate_text) > max_chars or span_would_be > max_span_sec):
            yield {
                "start_sec": current_start or 0.0,
                "end_sec": current_end or (current_start or 0.0),
                "text": " ".join(current_text).strip(),
            }
            current_text = []
            current_start = None
            current_end = None

        if current_start is None:
            current_start = cue.start_sec
        current_end = cue.end_sec
        current_text.append(cue.text)

    if current_text:
        yield {
            "start_sec": current_start or 0.0,
            "end_sec": current_end or (current_start or 0.0),
            "text": " ".join(current_text).strip(),
        }


def fetch_transcript_via_api(video_id: str) -> list[Cue] | None:
    try:
        segments = YouTubeTranscriptApi.get_transcript(video_id, languages=["en"])
    except AttributeError:
        # Newer versions expose an instance API.
        try:
            api = YouTubeTranscriptApi()
            transcript = api.fetch(video_id, languages=["en"])
            segments = [
                {
                    "text": snippet.text,
                    "start": float(getattr(snippet, "start", 0.0)),
                    "duration": float(getattr(snippet, "duration", 0.0)),
                }
                for snippet in transcript
                if getattr(snippet, "text", "").strip()
            ]
        except Exception:  # noqa: BLE001
            return None
    except YouTubeRequestFailed:
        return None
    except Exception:  # noqa: BLE001
        return None

    cues: list[Cue] = []
    for segment in segments:
        text = normalize_space(str(segment.get("text", "")))
        if not text:
            continue

        start = float(segment.get("start", 0.0) or 0.0)
        duration = float(segment.get("duration", 0.0) or 0.0)
        end = start + max(duration, 0.1)
        cues.append(Cue(start_sec=start, end_sec=end, text=text))

    if not cues:
        return None

    deduped: list[Cue] = []
    for cue in cues:
        if deduped and deduped[-1].text == cue.text:
            continue
        deduped.append(cue)
    return deduped


def fetch_oembed_title(video_url: str) -> str | None:
    endpoint = "https://www.youtube.com/oembed"
    try:
        response = requests.get(endpoint, params={"url": video_url, "format": "json"}, timeout=20)
        response.raise_for_status()
        payload = response.json()
    except Exception:  # noqa: BLE001
        return None

    title = normalize_space(str(payload.get("title", "")))
    return title or None


def build_record(video_id: str, tmp_dir: Path) -> VideoRecord | None:
    video_url = f"https://www.youtube.com/watch?v={video_id}"

    metadata: dict = {}
    try:
        metadata = fetch_video_metadata(video_url)
    except Exception as exc:  # noqa: BLE001
        print(f"Metadata fallback for {video_id}: {exc}")

    subtitle_path = download_subtitles(video_url, tmp_dir)
    cues = parse_vtt_cues(subtitle_path) if subtitle_path is not None else []
    if not cues:
        cues = fetch_transcript_via_api(video_id) or []

    transcript_text = "\n".join(cue.text for cue in cues).strip()

    if not transcript_text:
        print(f"Skipping {video_id}: subtitles were empty")
        return None

    title = normalize_space(str(metadata.get("title", "")))
    if not title:
        title = fetch_oembed_title(video_url) or f"YouTube video {video_id}"

    channel_name = metadata.get("channel")
    tags = metadata.get("tags") or []
    if not isinstance(tags, list):
        tags = []

    return VideoRecord(
        video_id=video_id,
        url=video_url,
        title=title,
        published=format_upload_date(metadata.get("upload_date")),
        channel=channel_name,
        tags=[normalize_space(str(tag)) for tag in tags if str(tag).strip()],
        transcript_text=transcript_text,
        segments=[
            {
                "start_sec": round(cue.start_sec, 3),
                "end_sec": round(cue.end_sec, 3),
                "text": cue.text,
            }
            for cue in cues
        ],
    )


def write_markdown(record: VideoRecord) -> None:
    slug = slugify(record.title)
    path = TRANSCRIPTS_DIR / f"{slug}-{record.video_id}.md"

    lines = [
        f"# {record.title}",
        "",
        f"- Source: {record.url}",
        f"- Published: {record.published or 'Unknown'}",
        f"- Channel: {record.channel or 'Unknown'}",
        f"- Tags: {', '.join(record.tags) if record.tags else 'None'}",
        "",
        "## Transcript",
        "",
        record.transcript_text,
        "",
    ]
    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
    TMP_DIR.mkdir(parents=True, exist_ok=True)

    video_ids = discover_video_ids(CHANNEL_URL)
    print(f"Found {len(video_ids)} videos on channel")

    records: list[VideoRecord] = []

    if not shutil.which("node"):
        print("Note: Node.js not found. yt-dlp may be less reliable for some YouTube pages.")
    if not COOKIE_FILE.exists():
        print("Note: data/tracetransborder/youtube-cookies.txt not found. If YouTube blocks extraction, export cookies and rerun.")

    for index, video_id in enumerate(video_ids, start=1):
        print(f"[{index}/{len(video_ids)}] Processing {video_id}")
        try:
            record = build_record(video_id, TMP_DIR)
        except Exception as exc:  # noqa: BLE001
            print(f"Skipping {video_id}: {exc}")
            continue
        if record is None:
            continue
        records.append(record)

    records.sort(key=lambda rec: rec.published or "")

    interviews: list[dict] = []
    chunks: list[dict] = []
    for record in records:
        slug = f"{slugify(record.title)}-{record.video_id}"
        interviews.append(
            {
                "slug": slug,
                "url": record.url,
                "title": record.title,
                "published": record.published,
                "tags": record.tags,
                "channel": record.channel,
                "intro": None,
                "qa_pairs": [],
                "audio_clips": [],
                "transcript_text": record.transcript_text,
                "segments": record.segments,
            }
        )

        record_cues = [Cue(start_sec=seg["start_sec"], end_sec=seg["end_sec"], text=seg["text"]) for seg in record.segments]
        for chunk_index, chunk in enumerate(chunk_cues(record_cues), start=1):
            chunks.append(
                {
                    "id": f"{slug}#chunk-{chunk_index}",
                    "slug": slug,
                    "title": record.title,
                    "url": record.url,
                    "published": record.published,
                    "tags": record.tags,
                    "question": "",
                    "answer": "",
                    "text": chunk["text"],
                    "start_sec": round(chunk["start_sec"], 3),
                    "end_sec": round(chunk["end_sec"], 3),
                }
            )

        write_markdown(record)

    manifest = {
        "source": CHANNEL_URL,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "interview_count": len(interviews),
        "chunk_count": len(chunks),
        "interviews": interviews,
    }

    (OUTPUT_DIR / "interviews.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    with (OUTPUT_DIR / "chunks.jsonl").open("w", encoding="utf-8") as handle:
        for chunk in chunks:
            handle.write(json.dumps(chunk, ensure_ascii=False) + "\n")

    for temp_file in TMP_DIR.glob("*"):
        temp_file.unlink(missing_ok=True)

    print(f"Extracted {len(interviews)} caption transcripts and {len(chunks)} chunks into {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
