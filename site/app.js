const DATASETS = [
  {
    id: "tracemcgill",
    name: "TRaCE McGill",
    chunksPath: "../data/tracemcgill/chunks.jsonl",
    interviewsPath: "../data/tracemcgill/interviews.json",
    isYoutube: false,
  },
  {
    id: "tracephd",
    name: "TRaCE PhD",
    chunksPath: "../data/tracephd/chunks.jsonl",
    interviewsPath: "../data/tracephd/interviews.json",
    isYoutube: false,
  },
  {
    id: "tracetransborder",
    name: "TRaCE Transborder (YouTube)",
    chunksPath: "../data/tracetransborder/chunks.jsonl",
    interviewsPath: "../data/tracetransborder/interviews.json",
    isYoutube: true,
  },
];

const queryInput = document.getElementById("query");
const searchButton = document.getElementById("searchButton");
const sourceFilter = document.getElementById("sourceFilter");
const sortMode = document.getElementById("sortMode");
const limitSelect = document.getElementById("limit");
const statusNode = document.getElementById("status");
const statsGrid = document.getElementById("statsGrid");
const insightsNode = document.getElementById("insights");
const themesNode = document.getElementById("themes");
const resultsNode = document.getElementById("results");
const resultTemplate = document.getElementById("resultTemplate");

let corpus = [];
let interviewIndex = new Map();

const THEME_SUGGESTIONS = [
  "mentorship",
  "international students",
  "career transition",
  "mental health",
  "funding",
  "leaving academia",
  "work-life balance",
  "networking",
  "teaching",
];

function countMatches(haystack, needle) {
  if (!needle) {
    return 0;
  }
  const safeNeedle = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = haystack.match(new RegExp(safeNeedle, "gi"));
  return matches ? matches.length : 0;
}

function scoreRecord(record, terms) {
  const haystackText = [record.title, record.text, (record.tags || []).join(" "), record.source]
    .join("\n")
    .toLowerCase();

  let score = 0;
  for (const term of terms) {
    score += countMatches(haystackText, term) * 3;
    score += countMatches((record.title || "").toLowerCase(), term) * 4;
    score += countMatches(((record.tags || []).join(" ") || "").toLowerCase(), term) * 5;
  }

  const phrase = terms.join(" ");
  if (phrase && haystackText.includes(phrase)) {
    score += 12;
  }

  return score;
}

function snippetFor(record, terms) {
  const text = (record.text || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "No transcript text available.";
  }

  const lowered = text.toLowerCase();
  let hit = -1;
  for (const term of terms) {
    const idx = lowered.indexOf(term);
    if (idx !== -1) {
      hit = idx;
      break;
    }
  }

  if (hit === -1) {
    return text.slice(0, 260) + (text.length > 260 ? "..." : "");
  }

  const start = Math.max(0, hit - 90);
  const end = Math.min(text.length, hit + 170);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return prefix + text.slice(start, end) + suffix;
}

function highlight(text, terms) {
  let highlighted = text;
  for (const term of terms) {
    if (!term) {
      continue;
    }
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    highlighted = highlighted.replace(new RegExp(`(${escaped})`, "gi"), "<mark>$1</mark>");
  }
  return highlighted;
}

function formatMeta(record) {
  const pieces = [record.source];
  if (record.published) {
    pieces.push(record.published);
  }
  if (record.tags && record.tags.length) {
    pieces.push(record.tags.slice(0, 5).join(", "));
  }
  return pieces.join(" | ");
}

function parsePublishedDate(value) {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) {
    return parsed;
  }

  // Handles YYYYMMDD and YYYY-MM-DD variants.
  const compact = value.replace(/-/g, "");
  if (/^\d{8}$/.test(compact)) {
    const normalized = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
    const retry = Date.parse(normalized);
    return Number.isNaN(retry) ? null : retry;
  }

  return null;
}

function buildStats(records) {
  const totalSources = new Set(records.map((r) => r.source)).size;
  const withTags = records.filter((r) => r.tags && r.tags.length).length;
  const tagCount = new Map();

  for (const record of records) {
    for (const tag of record.tags || []) {
      const key = String(tag).toLowerCase().trim();
      if (!key) {
        continue;
      }
      tagCount.set(key, (tagCount.get(key) || 0) + 1);
    }
  }

  const topTagEntry = [...tagCount.entries()].sort((a, b) => b[1] - a[1])[0];
  const topTheme = topTagEntry ? `${topTagEntry[0]} (${topTagEntry[1]})` : "n/a";

  statsGrid.innerHTML = "";
  const cards = [
    { label: "Total Chunks", value: records.length.toLocaleString() },
    { label: "Sources Loaded", value: totalSources.toString() },
    { label: "Chunks With Tags", value: withTags.toLocaleString() },
    { label: "Top Theme Tag", value: topTheme },
  ];

  for (const card of cards) {
    const node = document.createElement("div");
    node.className = "stat-card";
    node.innerHTML = `<span class="stat-label">${card.label}</span><span class="stat-value">${card.value}</span>`;
    statsGrid.appendChild(node);
  }
}

function summarizeInsights(records, terms) {
  insightsNode.innerHTML = "";
  if (!records.length) {
    return;
  }

  const bySource = new Map();
  for (const record of records) {
    bySource.set(record.source, (bySource.get(record.source) || 0) + 1);
  }

  const sourceSummary = [...bySource.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([source, count]) => `${source}: ${count}`)
    .join(" | ");

  const topTags = new Map();
  for (const record of records) {
    for (const tag of record.tags || []) {
      const key = String(tag).trim();
      if (!key) {
        continue;
      }
      topTags.set(key, (topTags.get(key) || 0) + 1);
    }
  }

  const themeSummary = [...topTags.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag]) => tag)
    .join(", ");

  const items = [
    `Interesting spread: ${sourceSummary}`,
    themeSummary ? `Common themes in these results: ${themeSummary}` : "No theme tags available for these results.",
    `Your query terms: ${terms.join(", ")}`,
  ];

  for (const text of items) {
    const insight = document.createElement("div");
    insight.className = "insight-card";
    insight.textContent = text;
    insightsNode.appendChild(insight);
  }
}

function scoreLabel(score) {
  if (score >= 40) {
    return "Strong Match";
  }
  if (score >= 20) {
    return "Good Match";
  }
  return "Related";
}

function whyThisMatched(record, terms) {
  const matchesTitle = terms.filter((term) => (record.title || "").toLowerCase().includes(term));
  const matchesTags = terms.filter((term) => (record.tags || []).join(" ").toLowerCase().includes(term));

  if (matchesTitle.length) {
    return `Why this appears: matching title term(s): ${matchesTitle.join(", ")}.`;
  }
  if (matchesTags.length) {
    return `Why this appears: matching theme tag(s): ${matchesTags.join(", ")}.`;
  }
  return "Why this appears: matching terms found in the transcript text.";
}

function renderResults(query) {
  resultsNode.innerHTML = "";
  insightsNode.innerHTML = "";

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);

  if (!terms.length) {
    statusNode.textContent = "Type one or more terms to search the corpus.";
    return;
  }

  const sourceValue = sourceFilter.value;
  const limit = Number.parseInt(limitSelect.value, 10);

  const filtered = corpus
    .filter((record) => sourceValue === "all" || record.source === sourceValue)
    .map((record) => ({ ...record, _score: scoreRecord(record, terms) }))
    .filter((record) => record._score > 0)
    .sort((a, b) => {
      if (sortMode.value === "recent") {
        const da = parsePublishedDate(a.published) || 0;
        const db = parsePublishedDate(b.published) || 0;
        if (db !== da) {
          return db - da;
        }
      }
      return b._score - a._score;
    });

  const visible = filtered.slice(0, limit);

  statusNode.textContent = `Found ${filtered.length} results for "${query}". Showing top ${visible.length}.`;
  summarizeInsights(visible, terms);

  if (!visible.length) {
    const empty = document.createElement("article");
    empty.className = "result-card";
    empty.innerHTML = "<p class=\"snippet\">No direct matches found. Try broader terms such as mentorship, supervision, career, or wellbeing.</p>";
    resultsNode.appendChild(empty);
    return;
  }

  for (const record of visible) {
    const clone = resultTemplate.content.cloneNode(true);
    const titleNode = clone.querySelector(".result-title");
    const scoreNode = clone.querySelector(".score-badge");
    const metaNode = clone.querySelector(".meta");
    const whyNode = clone.querySelector(".why-match");
    const snippetNode = clone.querySelector(".snippet");
    const tagRow = clone.querySelector(".tag-row");
    const transcriptLink = clone.querySelector(".transcript-link");
    const videoLink = clone.querySelector(".video-link");
    const sourceLink = clone.querySelector(".source-link");
    const copyQuoteButton = clone.querySelector(".copy-quote");

    const snippetText = snippetFor(record, terms);

    titleNode.textContent = record.title || "Untitled transcript";
    scoreNode.textContent = scoreLabel(record._score);
    metaNode.textContent = formatMeta(record);
    whyNode.textContent = whyThisMatched(record, terms);
    snippetNode.innerHTML = highlight(snippetText, terms);
    const transcriptUrl = new URL("transcript.html", window.location.href);
    transcriptUrl.searchParams.set("source", record.datasetId || "");
    transcriptUrl.searchParams.set("slug", record.slug || "");
    transcriptUrl.searchParams.set("q", query);
    if (typeof record.start_sec === "number") {
      transcriptUrl.searchParams.set("start", `${Math.floor(record.start_sec)}`);
    }
    transcriptLink.href = transcriptUrl.toString();
    sourceLink.href = record.url || "#";

    const canJumpToVideo = record.isYoutube && typeof record.start_sec === "number";
    if (canJumpToVideo) {
      const jumpUrl = new URL(record.url || "https://www.youtube.com");
      jumpUrl.searchParams.set("t", `${Math.floor(record.start_sec)}s`);
      videoLink.href = jumpUrl.toString();
      videoLink.classList.remove("is-hidden");
    } else {
      videoLink.classList.add("is-hidden");
      videoLink.href = "#";
    }

    const chips = [...(record.tags || []).slice(0, 5), record.source].filter(Boolean);
    for (const chip of chips) {
      const tag = document.createElement("span");
      tag.className = "tag-chip";
      tag.textContent = chip;
      tagRow.appendChild(tag);
    }

    copyQuoteButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(`${record.title}\n${snippetText}\n${record.url || ""}`.trim());
        copyQuoteButton.textContent = "Copied";
        window.setTimeout(() => {
          copyQuoteButton.textContent = "Copy quote";
        }, 1200);
      } catch (error) {
        copyQuoteButton.textContent = "Copy failed";
        console.error(error);
      }
    });

    resultsNode.appendChild(clone);
  }
}

function parseJsonLines(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function loadDataset(dataset) {
  const response = await fetch(dataset.chunksPath, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Could not load ${dataset.chunksPath}: HTTP ${response.status}`);
  }
  const text = await response.text();
  return parseJsonLines(text).map((entry) => ({
    ...entry,
    source: dataset.name,
    datasetId: dataset.id,
    isYoutube: dataset.isYoutube,
  }));
}

async function loadInterviewManifest(dataset) {
  const response = await fetch(dataset.interviewsPath, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Could not load ${dataset.interviewsPath}: HTTP ${response.status}`);
  }
  const payload = await response.json();
  const interviews = Array.isArray(payload.interviews) ? payload.interviews : [];

  for (const interview of interviews) {
    if (!interview || !interview.slug) {
      continue;
    }
    interviewIndex.set(`${dataset.id}:${interview.slug}`, {
      ...interview,
      source: dataset.name,
      datasetId: dataset.id,
      isYoutube: dataset.isYoutube,
    });
  }
}

async function initialize() {
  statusNode.textContent = "Loading transcript index from all sources...";

  for (const theme of THEME_SUGGESTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "theme-button";
    button.textContent = theme;
    button.addEventListener("click", () => {
      queryInput.value = theme;
      renderResults(theme);
    });
    themesNode.appendChild(button);
  }

  for (const dataset of DATASETS) {
    const option = document.createElement("option");
    option.value = dataset.name;
    option.textContent = dataset.name;
    sourceFilter.appendChild(option);
  }

  const loaded = await Promise.allSettled(DATASETS.map(loadDataset));
  const manifestLoaded = await Promise.allSettled(DATASETS.map(loadInterviewManifest));
  const records = [];
  let failures = 0;

  for (const result of loaded) {
    if (result.status === "fulfilled") {
      records.push(...result.value);
    } else {
      failures += 1;
      console.error(result.reason);
    }
  }

  for (const result of manifestLoaded) {
    if (result.status === "rejected") {
      failures += 1;
      console.error(result.reason);
    }
  }

  corpus = records;

  if (!corpus.length) {
    statusNode.textContent = "No datasets were loaded. Run the extractor scripts and refresh.";
    return;
  }

  buildStats(corpus);

  const message = failures
    ? `Loaded ${corpus.length} chunks with ${failures} dataset load errors.`
    : `Loaded ${corpus.length} chunks. Enter a query to begin.`;
  statusNode.textContent = message;
}

queryInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    renderResults(queryInput.value.trim());
  }
});

searchButton.addEventListener("click", () => renderResults(queryInput.value.trim()));
sourceFilter.addEventListener("change", () => renderResults(queryInput.value.trim()));
sortMode.addEventListener("change", () => renderResults(queryInput.value.trim()));
limitSelect.addEventListener("change", () => renderResults(queryInput.value.trim()));

initialize().catch((error) => {
  statusNode.textContent = `Failed to initialize search: ${error.message}`;
  console.error(error);
});
