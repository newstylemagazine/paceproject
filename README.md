# paceproject

This workspace includes extractors for two TRaCE narrative archives and generated transcript data intended for downstream search or retrieval-augmented QA.

## Extract the corpora

Run:

```bash
python scripts/extract_trace_narratives.py
python scripts/extract_tracephd_narratives.py
```

The scripts crawl the relevant narrative indexes, follow paginated interview listings, and write:

- `data/tracemcgill/interviews.json`: full interview records from `tracemcgill.com`
- `data/tracemcgill/chunks.jsonl`: one retrieval-ready Q/A chunk per line for `tracemcgill.com`
- `data/tracemcgill/transcripts/*.md`: one Markdown transcript per TRaCE McGill interview
- `data/tracephd/interviews.json`: full interview records from `tracephd.com`
- `data/tracephd/chunks.jsonl`: one retrieval-ready Q/A chunk per line for `tracephd.com`
- `data/tracephd/transcripts/*.md`: one Markdown transcript per TRaCE PhD interview

## Notes

- The interview pages already contain written Q/A transcript text, so the extractors normalize published page content instead of performing speech-to-text.
- The two sites use different WordPress themes and markup, so each site has its own dedicated extractor.
- Some `tracemcgill.com` pages also embed audio clips. Those clip URLs and captions are preserved in that output metadata.