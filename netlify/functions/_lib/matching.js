// Same keyword-matching logic as functions/_lib/matching.js (the Cloudflare
// version), adapted for Netlify: instead of an env.ASSETS binding, this
// just fetches the corpus files over plain HTTPS from the site's own
// public URL, since they're already static files served alongside it.
const STOP_WORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "have", "has", "are", "was", "were", "you",
  "your", "our", "their", "about", "into", "after", "before", "will", "would", "should", "could", "can",
  "but", "not", "than", "then", "just", "been", "being", "also", "very", "more", "most", "such", "some",
  "any", "its", "we", "they", "them", "his", "her", "she", "him", "who", "what", "where", "when",
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

let corpusCache = null;

async function loadDataset(requestUrl, path) {
  try {
    const url = new URL(path, requestUrl);
    const response = await fetch(url);
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

export async function loadCorpus(requestUrl) {
  if (corpusCache) {
    return corpusCache;
  }
  const records = [];
  for (const [datasetId, path] of DATASETS) {
    const rows = await loadDataset(requestUrl, path);
    for (const row of rows) {
      row.datasetId = datasetId;
      records.push(row);
    }
  }
  corpusCache = records;
  return records;
}

export async function buildRecommendations(requestUrl, text, uploadNames) {
  const terms = extractTerms(`${text} ${uploadNames.join(" ")}`);
  if (!terms.length) {
    return [];
  }

  const corpus = await loadCorpus(requestUrl);
  const bestBySlug = new Map();

  for (const record of corpus) {
    const slug = record.slug;
    if (!slug) continue;

    const title = String(record.title || "");
    const tags = (record.tags || []).join(" ");
    const body = String(record.text || "");
    const score = scoreText(title, terms) * 3 + scoreText(tags, terms) * 3 + scoreText(body, terms);
    if (score <= 0) continue;

    const snippet = body.replace(/\s+/g, " ").trim().slice(0, 230);
    const existing = bestBySlug.get(slug);
    if (existing && score <= existing.score) continue;

    const haystack = `${title} ${tags} ${body}`.toLowerCase();
    bestBySlug.set(slug, {
      title: title || "Interview",
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
