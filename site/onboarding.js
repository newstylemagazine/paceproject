const PROFILE_STORAGE_KEY = "trace_profile_intake_v3";

const DATASETS = [
  { id: "tracemcgill", chunksPath: "../data/tracemcgill/chunks.jsonl" },
  { id: "tracephd", chunksPath: "../data/tracephd/chunks.jsonl" },
  { id: "tracetransborder", chunksPath: "../data/tracetransborder/chunks.jsonl" },
];

const STOP_WORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "have", "has", "are", "was", "were", "you",
  "your", "our", "their", "about", "into", "after", "before", "will", "would", "should", "could", "can",
  "but", "not", "than", "then", "just", "been", "being", "also", "very", "more", "most", "such", "some",
  "any", "its", "it's", "we", "they", "them", "his", "her", "she", "him", "who", "what", "where", "when",
]);

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_TEXT_CHARS = 20000;
const TEXT_LIKE_EXTENSIONS = /\.(txt|md|markdown)$/i;

const storyInput = document.getElementById("storyInput");
const dropZone = document.getElementById("dropZone");
const uploadInput = document.getElementById("uploadInput");
const letsGoButton = document.getElementById("letsGoButton");
const wordCount = document.getElementById("wordCount");
const uploadTray = document.getElementById("uploadTray");
const intakeStage = document.getElementById("intakeStage");
const quoteFeed = document.getElementById("quoteFeed");
const continuePrompt = document.getElementById("continuePrompt");

let corpus = [];
let state = {
  text: "",
  uploads: [],
};
let activeMatches = [];
// Per-item fetched questions, keyed by index into activeMatches. Cleared
// every time activeMatches is replaced by a fresh render.
let feedQuestions = new Map();

function parseJsonLines(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function safeSetStorage(key, payload) {
  try {
    localStorage.setItem(key, JSON.stringify(payload));
  } catch (error) {
    console.error("Storage write failed:", error);
  }
}

function readStorage(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function normalize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
}

function extractTerms(text, limit = 20) {
  const counts = new Map();
  for (const token of normalize(text).split(/\s+/)) {
    const part = token.trim();
    if (part.length <= 2 || STOP_WORDS.has(part)) {
      continue;
    }
    counts.set(part, (counts.get(part) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([term]) => term);
}

function scoreText(haystack, terms) {
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

// Some of the scraped transcripts have a "Narrative | <date>" (or "Blog
// Narrative | <date>") label baked directly into the start of the text -
// scrub it so quote cards and questions show the actual voice, not the
// label.
const BOILERPLATE_PREFIX = /^(?:blog\s+)?narrative\s*\|[^\n]*\n+/i;

function stripBoilerplate(text) {
  return (text || "").replace(BOILERPLATE_PREFIX, "").trim();
}

// A handful of scraped rows are site navigation ("Find more PhD Narratives
// on our TRaCE McGill website"), not an actual interview - skip them so
// they never show up as a "match".
function isJunkRecord(record) {
  return /^find more .*narratives?/i.test(record.title || "");
}

function buildMatches(text, uploads) {
  const uploadTerms = uploads
    .map((item) => `${item.name.replace(/\.[^.]+$/, "")} ${item.textExcerpt || ""}`)
    .join(" ");
  const terms = extractTerms(`${text} ${uploadTerms}`);
  if (!terms.length) {
    return [];
  }

  const bestBySlug = new Map();
  for (const record of corpus) {
    if (!record.slug || isJunkRecord(record)) {
      continue;
    }

    const titleScore = scoreText(record.title || "", terms) * 3;
    const tagScore = scoreText((record.tags || []).join(" "), terms) * 3;
    const bodyScore = scoreText(record.text || "", terms);
    const total = titleScore + tagScore + bodyScore;

    if (total <= 0) {
      continue;
    }

    const existing = bestBySlug.get(record.slug);
    if (!existing || total > existing.score) {
      const clean = stripBoilerplate(record.text || "").replace(/\s+/g, " ").trim();
      bestBySlug.set(record.slug, {
        title: record.title || "Interview voice",
        quote: clean.slice(0, 140) + (clean.length > 140 ? "..." : ""),
        fullText: clean,
        url: record.url || "#",
        score: total,
      });
    }
  }

  return [...bestBySlug.values()].sort((a, b) => b.score - a.score).slice(0, 8);
}

function renderUploads() {
  if (!uploadTray) {
    return;
  }

  uploadTray.innerHTML = "";
  if (!state.uploads.length) {
    return;
  }

  for (const item of state.uploads) {
    const chip = document.createElement("article");
    chip.className = "upload-chip";
    const thumb = item.previewDataUrl
      ? `<img src="${item.previewDataUrl}" alt="" />`
      : `<div class="file-icon">${item.textExcerpt ? "TXT" : "DOC"}</div>`;
    chip.innerHTML = `
      ${thumb}
      <div class="file-meta">
        <p>${item.name}</p>
        <small>${Number.isFinite(item.size) ? `${(item.size / 1024).toFixed(1)} KB` : "Unknown size"}</small>
      </div>
      <button type="button" data-file-id="${item.id}" aria-label="Remove ${item.name}">Remove</button>
    `;
    uploadTray.appendChild(chip);
  }
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

async function toUploadRecord(file) {
  const record = {
    id: `${file.name}-${file.lastModified}-${Math.random().toString(16).slice(2, 8)}`,
    name: file.name,
    size: file.size,
    type: file.type || "application/octet-stream",
  };

  try {
    if (file.type.startsWith("image/") && file.size <= MAX_IMAGE_BYTES) {
      record.previewDataUrl = await readFileAsDataURL(file);
    } else if (
      (file.type.startsWith("text/") || TEXT_LIKE_EXTENSIONS.test(file.name)) &&
      file.size <= MAX_IMAGE_BYTES
    ) {
      const raw = await readFileAsText(file);
      record.textExcerpt = raw.slice(0, MAX_TEXT_CHARS);
    }
  } catch (error) {
    console.error(`Could not read ${file.name}:`, error);
  }

  return record;
}

async function addFiles(fileList) {
  const records = await Promise.all(Array.from(fileList).map(toUploadRecord));
  state.uploads = [...state.uploads, ...records].slice(0, 12);
  renderUploads();
  safeSetStorage(PROFILE_STORAGE_KEY, state);
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderQuoteFeed(matches) {
  quoteFeed.innerHTML = "";
  activeMatches = matches;
  feedQuestions = new Map();

  if (!matches.length) {
    quoteFeed.hidden = true;
    return;
  }

  quoteFeed.hidden = false;

  matches.slice(0, 8).forEach((match, index) => {
    const item = document.createElement("article");
    item.className = "quote-feed-item";
    item.dataset.matchIndex = String(index);
    item.setAttribute("role", "button");
    item.setAttribute("tabindex", "0");
    item.innerHTML = `
      <h3>${escapeHtml(match.title)}</h3>
      <p class="snippet">${escapeHtml(match.quote)}</p>
      <div class="full-text">${escapeHtml(match.fullText)}</div>
      <p class="feed-question" hidden></p>
      <a class="feed-link" href="${match.url}" target="_blank" rel="noreferrer">Read the full interview</a>
    `;
    quoteFeed.appendChild(item);
  });
}

async function toggleFeedItem(item, index) {
  const isExpanded = item.classList.toggle("is-expanded");
  if (!isExpanded) {
    return;
  }

  const questionEl = item.querySelector(".feed-question");
  const match = activeMatches[index];
  if (!questionEl || !match) {
    return;
  }

  if (feedQuestions.has(index)) {
    questionEl.hidden = false;
    questionEl.textContent = feedQuestions.get(index);
    return;
  }

  questionEl.hidden = false;
  questionEl.classList.add("is-loading");
  questionEl.textContent = "Thinking of a question worth asking...";

  try {
    const question = await fetchQuestion(match);
    const text = question || "";
    feedQuestions.set(index, text);
    questionEl.textContent = text;
    questionEl.hidden = !text;
  } catch (error) {
    console.error("Could not fetch a question:", error);
    questionEl.hidden = true;
  } finally {
    questionEl.classList.remove("is-loading");
  }
}


let autoMatchTimer = null;
let lastMatchedText = "";
const AUTO_MATCH_IDLE_MS = 1400;
const AUTO_MATCH_MIN_WORDS = 6;

async function fetchQuestion(match) {
  const response = await fetch("/api/ai-question", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: state.text, match }),
  });
  if (!response.ok) {
    throw new Error(`Server responded ${response.status}`);
  }
  const result = await response.json();
  return result.question || "";
}

async function askAboutTopMatch(match) {
  continuePrompt.classList.add("is-loading");
  continuePrompt.textContent = "Thinking of a question worth asking...";

  try {
    const question = await fetchQuestion(match);
    continuePrompt.textContent = question
      ? `${match.title} asked something close to this: “${question}” Keep writing and I'll follow up again.`
      : "Keep writing - new questions will show up here as you go.";
  } catch (error) {
    console.error("Could not fetch a question:", error);
    continuePrompt.textContent = "Keep writing - new questions will show up here as you go.";
  } finally {
    continuePrompt.classList.remove("is-loading");
  }
}

function triggerMatch(text) {
  const trimmed = text.trim();
  if (!trimmed || trimmed === lastMatchedText) {
    return;
  }
  lastMatchedText = trimmed;
  const matches = buildMatches(trimmed, state.uploads);
  renderQuoteFeed(matches);
  if (matches.length) {
    askAboutTopMatch(matches[0]);
  } else {
    continuePrompt.classList.remove("is-loading");
    continuePrompt.textContent = "No close quote matches yet. Add more detail, then keep writing.";
  }
}

function refreshWordCount() {
  state.text = storyInput.value;
  wordCount.textContent = `${countWords(state.text)} words`;
  safeSetStorage(PROFILE_STORAGE_KEY, state);

  clearTimeout(autoMatchTimer);
  if (countWords(state.text) >= AUTO_MATCH_MIN_WORDS) {
    autoMatchTimer = setTimeout(() => triggerMatch(state.text), AUTO_MATCH_IDLE_MS);
  }
}

async function loadCorpus() {
  const loaded = await Promise.allSettled(
    DATASETS.map(async (dataset) => {
      const response = await fetch(dataset.chunksPath, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Could not load ${dataset.chunksPath}`);
      }
      const text = await response.text();
      return parseJsonLines(text).map((entry) => ({ ...entry, datasetId: dataset.id }));
    })
  );

  const merged = [];
  for (const result of loaded) {
    if (result.status === "fulfilled") {
      merged.push(...result.value);
    }
  }
  corpus = merged;
}

function wireEvents() {
  storyInput.addEventListener("input", refreshWordCount);

  if (uploadInput) {
    uploadInput.addEventListener("change", async (event) => {
      const files = Array.from(event.target.files || []);
      if (!files.length) {
        return;
      }
      await addFiles(files);
      uploadInput.value = "";
    });
  }

  if (dropZone && uploadInput) {
    dropZone.addEventListener("click", () => uploadInput.click());
    dropZone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        uploadInput.click();
      }
    });
    dropZone.addEventListener("dragover", (event) => {
      event.preventDefault();
      dropZone.classList.add("is-dragover");
    });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("is-dragover"));
    dropZone.addEventListener("drop", async (event) => {
      event.preventDefault();
      dropZone.classList.remove("is-dragover");
      const files = Array.from(event.dataTransfer?.files || []);
      if (!files.length) {
        return;
      }
      await addFiles(files);
    });
  }

  if (uploadTray) {
    uploadTray.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLButtonElement)) {
        return;
      }
      const fileId = target.dataset.fileId;
      if (!fileId) {
        return;
      }
      state.uploads = state.uploads.filter((item) => item.id !== fileId);
      renderUploads();
      safeSetStorage(PROFILE_STORAGE_KEY, state);
    });
  }

  quoteFeed.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    // Let the "Read the full interview" link behave like a normal link
    // instead of also toggling the card open/closed.
    if (target.closest(".feed-link")) {
      return;
    }

    const item = target.closest(".quote-feed-item");
    if (!(item instanceof HTMLElement)) {
      return;
    }

    const index = Number.parseInt(item.dataset.matchIndex || "", 10);
    if (!Number.isInteger(index) || index < 0 || index >= activeMatches.length) {
      return;
    }
    toggleFeedItem(item, index);
  });

  quoteFeed.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const item = target.closest(".quote-feed-item");
    if (!(item instanceof HTMLElement)) {
      return;
    }
    event.preventDefault();
    const index = Number.parseInt(item.dataset.matchIndex || "", 10);
    if (!Number.isInteger(index) || index < 0 || index >= activeMatches.length) {
      return;
    }
    toggleFeedItem(item, index);
  });

  letsGoButton.addEventListener("click", () => {
    const text = storyInput.value.trim();
    if (!text) {
      continuePrompt.textContent = "Write a few honest lines first, then press Go.";
      storyInput.focus();
      return;
    }

    clearTimeout(autoMatchTimer);
    lastMatchedText = "";
    triggerMatch(text);
  });
}

async function initialize() {
  const saved = readStorage(PROFILE_STORAGE_KEY);
  if (saved && typeof saved === "object") {
    state.text = String(saved.text || "");
    state.uploads = Array.isArray(saved.uploads) ? saved.uploads : [];
  }

  storyInput.value = state.text;
  wordCount.textContent = `${countWords(state.text)} words`;
  renderUploads();

  // The archive (corpus) loads asynchronously. Without this, a click on Go
  // before it finishes would silently run against an empty corpus (0
  // matches) and look like the button did nothing - the archive would only
  // be ready by the time someone clicked a second time.
  letsGoButton.disabled = true;
  letsGoButton.textContent = "Loading archive...";

  wireEvents();
  await loadCorpus();

  letsGoButton.disabled = false;
  letsGoButton.textContent = "Go";
}

initialize().catch((error) => {
  console.error("Failed to initialize homepage interaction:", error);
  continuePrompt.textContent = "Could not load interview voices yet. Refresh and try again.";
});
