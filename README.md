# paceproject

This workspace includes extractors for two TRaCE narrative archives and generated transcript data intended for downstream search or retrieval-augmented QA.

## Quick Start (Simple)

If you just want the site running with AI available for everyone:

1. Install requirements:

```bash
pip install -r requirements.txt
```

2. Create your env file:

```bash
cp .env.example .env
```

3. Open `.env` and paste a free Groq API key after `GROQ_API_KEY=`
   (get one in ~30 seconds at https://console.groq.com/keys - no credit card
   required). OpenAI is also supported as a paid alternative if you'd rather
   use `OPENAI_API_KEY` instead.

4. Start the site:

```bash
python scripts/start_trace_site.py
```

5. Open:

- `http://localhost:8000/site/`

Notes:

- If you skip the key, the site still works, but uses fallback mode instead of full AI.
- With a key in `.env`, AI is shared for all visitors to your deployed app (users do not need their own key).
- If both `GROQ_API_KEY` and `OPENAI_API_KEY` are set, Groq is used first.

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

### Optional: Enable AI synthesis for About Me

The local server includes an API endpoint at `/api/ai-synthesize`. When you write your
story on the homepage and open **About Me**, the page sends your text (plus any matched
interview quotes) to this endpoint, which synthesizes a headline, achievements,
aspirations, and an IDP (Individual Development Plan) worksheet.

To enable real model-backed synthesis for free, set a Groq key:

```bash
export GROQ_API_KEY="your_groq_api_key"
export GROQ_MODEL="llama-3.3-70b-versatile"   # optional
python scripts/serve_trace_searchable.py
```

Get a free Groq key (no credit card) at https://console.groq.com/keys.

OpenAI is also supported if you'd rather use a paid key instead:

```bash
export OPENAI_API_KEY="your_api_key"
export OPENAI_MODEL="gpt-4o-mini"   # optional
python scripts/serve_trace_searchable.py
```

If neither key is set, the site still works and uses a local, rule-based fallback
synthesizer instead of a model.

## Deploying the AI backend (Cloudflare)

GitHub Pages only serves static files, so it can't run the Python server
above. The AI logic (`/api/ai-synthesize`, `/api/ai-question`) has been
ported to JavaScript twice, for two different Cloudflare deploy flows -
use whichever one the dashboard gives you:

- `worker/index.js` + `wrangler.jsonc` - for the dashboard's **"Create a
  Worker" -> Import a Git repository** flow (this is what Cloudflare
  defaults new Git-connected projects to as of 2026).
- `functions/api/*.js` - classic Cloudflare Pages Functions, for the
  older **Workers & Pages -> Create application -> Pages -> Connect to
  Git** flow, if that's still available on your account.

Both read from the same shared logic in `functions/_lib/`, so there's
only one place to fix things if the AI behavior ever needs to change.

To deploy:

1. Go to the Cloudflare dashboard (dash.cloudflare.com) -> **Workers &
   Pages** -> **Create application** -> import this GitHub repository.
2. If you land in a "Create a Worker" flow (asks for an API token name
   and has a "Variable name/value" field), it will auto-detect
   `wrangler.jsonc` and use `worker/index.js`. Add an environment
   variable named `GROQ_API_KEY` with a free key from
   https://console.groq.com/keys, click **Encrypt**, then **Deploy**.
3. If you land in a classic Pages flow instead, set build command blank
   and build output directory to `/`, then add `GROQ_API_KEY` under
   Settings -> Environment variables after the first deploy.

Either way, Cloudflare redeploys automatically on every push to `main`.
The frontend needs no changes - it already calls the same relative
`/api/...` paths, which resolve against whichever domain serves the
page.

## Notes

- The interview pages already contain written Q/A transcript text, so the extractors normalize published page content instead of performing speech-to-text.
- The two sites use different WordPress themes and markup, so each site has its own dedicated extractor.
- Some `tracemcgill.com` pages also embed audio clips. Those clip URLs and captions are preserved in that output metadata.