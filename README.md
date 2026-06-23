# paceproject

This workspace includes extractors for two TRaCE narrative archives and generated transcript data intended for downstream search or retrieval-augmented QA.

It also includes:

- a YouTube caption extractor for the TRaCE Transborder channel
- a local web search experience named TRaCE Searchable

## Extract the corpora

Run:

```bash
pip install -r requirements.txt
python scripts/extract_trace_narratives.py
python scripts/extract_tracephd_narratives.py
python scripts/extract_trace_transborder_youtube.py
```

If YouTube rate limits or bot-checks caption extraction, export your logged-in YouTube cookies to:

- `data/tracetransborder/youtube-cookies.txt`

Then rerun:

```bash
python scripts/extract_trace_transborder_youtube.py
```

The scripts crawl the relevant narrative indexes, follow paginated interview listings, and write:

- `data/tracemcgill/interviews.json`: full interview records from `tracemcgill.com`
- `data/tracemcgill/chunks.jsonl`: one retrieval-ready Q/A chunk per line for `tracemcgill.com`
- `data/tracemcgill/transcripts/*.md`: one Markdown transcript per TRaCE McGill interview
- `data/tracephd/interviews.json`: full interview records from `tracephd.com`
- `data/tracephd/chunks.jsonl`: one retrieval-ready Q/A chunk per line for `tracephd.com`
- `data/tracephd/transcripts/*.md`: one Markdown transcript per TRaCE PhD interview
- `data/tracetransborder/interviews.json`: full transcript records from YouTube captions on `@TRaCETransborder`
- `data/tracetransborder/chunks.jsonl`: retrieval-ready transcript chunks per video
- `data/tracetransborder/transcripts/*.md`: one Markdown transcript per YouTube video

## Run TRaCE Searchable

Start a local server from the repository root:

```bash
python scripts/serve_trace_searchable.py
```

Then open:

- `http://localhost:8000/site/`

Open any result via **Read full transcript** to load the full text in the local viewer at:

- `http://localhost:8000/site/transcript.html`

For YouTube-based results, the viewer includes:

- a direct **Watch relevant moment** link
- an embedded player starting near the matched timestamp (when timestamp data is available)

The site reads all available corpus chunk files directly from:

- `data/tracemcgill/chunks.jsonl`
- `data/tracephd/chunks.jsonl`
- `data/tracetransborder/chunks.jsonl`

## Notes

- The interview pages already contain written Q/A transcript text, so the extractors normalize published page content instead of performing speech-to-text.
- The two sites use different WordPress themes and markup, so each site has its own dedicated extractor.
- Some `tracemcgill.com` pages also embed audio clips. Those clip URLs and captions are preserved in that output metadata.