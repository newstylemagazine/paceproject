// Keyword matching against the interview corpus - a direct port of the
// scoring logic in scripts/serve_trace_searchable.py (build_recommendations
// et al). Kept in its own module so both API routes can share it.

// Expanded after a persona test (a humanities researcher writing about
// Proust and Ruskin) surfaced generic filler verbs/adverbs ("like",
// "still", "know") dominating match scoring - they show up in nearly
// every personal narrative, so treating them as content words let
// administrative boilerplate and barely-related interviews outscore
// genuinely relevant ones just by sharing a lot of small talk.
const STOP_WORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "have", "has", "are", "was", "were", "you",
  "your", "our", "their", "about", "into", "after", "before", "will", "would", "should", "could", "can",
  "but", "not", "than", "then", "just", "been", "being", "also", "very", "more", "most", "such", "some",
  "any", "its", "we", "they", "them", "his", "her", "she", "him", "who", "what", "where", "when",
  "like", "likes", "liked", "still", "know", "knew", "known", "get", "gets", "got", "getting",
  "go", "goes", "going", "went", "gone", "make", "makes", "made", "making",
  "think", "thinks", "thought", "thinking", "feel", "feels", "felt", "feeling",
  "want", "wants", "wanted", "wanting", "look", "looks", "looked", "looking",
  "come", "comes", "came", "coming", "keep", "keeps", "kept", "keeping",
  "really", "actually", "quite", "well", "yet", "again", "always", "never",
  "often", "sometimes", "even", "only", "much", "many", "lot", "lots",
  "little", "few", "all", "every", "each", "other", "another", "same",
  "am", "is", "be", "do", "does", "did", "doing",
]);

const DATASETS = [
  ["tracemcgill", "/data/tracemcgill/chunks.jsonl"],
  ["tracephd", "/data/tracephd/chunks.jsonl"],
  ["tracetransborder", "/data/tracetransborder/chunks.jsonl"],
];

export function normalize(text) {
  return (text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ");
}

export function extractTerms(text, limit = 20) {
  const counts = new Map();
  for (const token of normalize(text).split(/\s+/)) {
    const part = token.trim();
    if (!part || part.length <= 2 || STOP_WORDS.has(part)) {
      continue;
    }
    counts.set(part, (counts.get(part) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([term]) => term);
}

export function scoreText(haystack, terms) {
  if (!haystack || !terms.length) {
    return 0;
  }
  const lower = haystack.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (lower.includes(term)) {
      score += 1 + Math.min(lower.split(term).length - 1, 4);
    }
  }
  return score;
}

// Some scraped transcripts have a "Narrative | <date>" (or "Blog Narrative |
// <date>") label baked directly into the start of the text - scrub it so
// snippets and AI context show the actual voice, not the label.
const BOILERPLATE_PREFIX = /^(?:blog\s+)?narrative\s*\|[^\n]*\n+/i;
// One record in the corpus (a milestone "50th narrative" post) opens with
// a whole paragraph of site-editorial framing before the interviewee's
// actual reflection starts - strip that too, the same way the date label
// above it is stripped, so it never outweighs or gets quoted as their own
// words.
const EDITOR_NOTE_PREFIX = /^editor.s note:[^\n]*\n+/i;

export function stripBoilerplate(text) {
  return (text || "")
    .replace(BOILERPLATE_PREFIX, "")
    .replace(EDITOR_NOTE_PREFIX, "")
    .trim();
}

// A handful of titles are prefixed with an archive milestone marker
// ("50th Narrative: ...") that's about the archive, not the person -
// strip it so cards/headers show just their name and role.
const TITLE_MILESTONE_PREFIX = /^\d+(?:st|nd|rd|th)\s+narrative:\s*/i;

export function cleanTitle(title) {
  return String(title || "").replace(TITLE_MILESTONE_PREFIX, "").trim();
}

// A handful of scraped rows are site navigation ("Find more PhD Narratives
// on our TRaCE McGill website"), not an actual interview - skip them so
// they never surface as a "recommendation".
function isJunkRecord(record) {
  return /^find more .*narratives?/i.test(record.title || "");
}

export function sentenceSplit(text) {
  const compact = (text || "").replace(/\s+/g, " ").trim();
  if (!compact) {
    return [];
  }
  return compact
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function pickSentences(text, pattern, limit = 3) {
  const matcher = new RegExp(pattern, "i");
  return sentenceSplit(text)
    .filter((sentence) => matcher.test(sentence))
    .slice(0, limit);
}

// A couple of Cloudflare Pages Functions invocations on a warm isolate can
// share this - it's a soft optimization, not something correctness depends
// on (a cold isolate just refetches).
let corpusCache = null;

async function loadDataset(env, requestUrl, path) {
  try {
    const url = new URL(path, requestUrl);
    const response = await env.ASSETS.fetch(url);
    if (!response.ok) {
      return [];
    }
    const text = await response.text();
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (error) {
    console.error(`Could not load ${path}:`, error);
    return [];
  }
}

export async function loadCorpus(env, requestUrl) {
  if (corpusCache) {
    return corpusCache;
  }
  const records = [];
  for (const [datasetId, path] of DATASETS) {
    const rows = await loadDataset(env, requestUrl, path);
    for (const row of rows) {
      row.datasetId = datasetId;
      records.push(row);
    }
  }
  corpusCache = records;
  return records;
}

export async function buildRecommendations(env, requestUrl, text, uploadNames) {
  const terms = extractTerms(`${text} ${uploadNames.join(" ")}`);
  if (!terms.length) {
    return [];
  }

  const corpus = await loadCorpus(env, requestUrl);
  const bestBySlug = new Map();

  for (const record of corpus) {
    const slug = record.slug;
    if (!slug || isJunkRecord(record)) continue;

    const title = String(record.title || "");
    const tags = (record.tags || []).join(" ");
    const body = stripBoilerplate(record.text || "");
    const score = scoreText(title, terms) * 3 + scoreText(tags, terms) * 3 + scoreText(body, terms);
    if (score <= 0) continue;

    const snippet = body.replace(/\s+/g, " ").trim().slice(0, 230);
    const existing = bestBySlug.get(slug);
    if (existing && score <= existing.score) continue;

    const haystack = `${title} ${tags} ${body}`.toLowerCase();
    bestBySlug.set(slug, {
      title: cleanTitle(title) || "Interview",
      slug,
      datasetId: record.datasetId,
      url: record.url || "#",
      snippet: snippet + (body.length > 230 ? "..." : ""),
      score,
      matchedTerms: terms.filter((term) => haystack.includes(term)).slice(0, 4),
    });
  }

  return [...bestBySlug.values()].sort((a, b) => b.score - a.score).slice(0, 6);
}
