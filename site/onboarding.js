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
const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;
const MAX_TEXT_CHARS = 20000;
const TEXT_LIKE_EXTENSIONS = /\.(txt|md|markdown)$/i;
const PDF_EXTENSION = /\.pdf$/i;
const DOCX_EXTENSION = /\.docx$/i;

const PDFJS_BASE = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.1.200/";
const MAMMOTH_URL = "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.11.0/mammoth.browser.min.js";

const storyInput = document.getElementById("storyInput");
const dropZone = document.getElementById("dropZone");
const uploadInput = document.getElementById("uploadInput");
const letsGoButton = document.getElementById("letsGoButton");
const wordCount = document.getElementById("wordCount");
const uploadTray = document.getElementById("uploadTray");
const intakeStage = document.getElementById("intakeStage");
const quoteFeed = document.getElementById("quoteFeed");
const continuePrompt = document.getElementById("continuePrompt");
const readerPanel = document.getElementById("readerPanel");
const readerBackdrop = document.getElementById("readerBackdrop");
const readerTitle = document.getElementById("readerTitle");
const readerSourceLink = document.getElementById("readerSourceLink");
const readerClose = document.getElementById("readerClose");
const readerBody = document.getElementById("readerBody");
const readerNotesInput = document.getElementById("readerNotesInput");
const readerNotesHint = document.getElementById("readerNotesHint");

let corpus = [];
let state = {
  text: "",
  uploads: [],
  interviewNotes: {},
};
let activeMatches = [];
// Per-item fetched questions, keyed by index into activeMatches. Cleared
// every time activeMatches is replaced by a fresh render.
let feedNotes = new Map();

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

const MAX_MATCHES = 20;
const MAX_MATCHES_PER_SLUG = 3;

// Unlike the old version, this does NOT collapse to one excerpt per
// interviewee - a person can surface more than once if several of their
// answers genuinely resonate, which is what makes "lots of excerpts"
// possible. MAX_MATCHES_PER_SLUG just keeps any one interview from
// crowding out everyone else.
function buildMatches(text, uploads) {
  const uploadTerms = uploads
    .map((item) => `${item.name.replace(/\.[^.]+$/, "")} ${item.textExcerpt || ""}`)
    .join(" ");
  const terms = extractTerms(`${text} ${uploadTerms}`);
  if (!terms.length) {
    return [];
  }

  const scored = [];
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

    const clean = stripBoilerplate(record.text || "").replace(/\s+/g, " ").trim();
    // Real Q&A entries carry the interviewer's actual question - when it
    // exists, that becomes the prompt shown to the reader (an invitation
    // to answer the same question themselves), instead of anything
    // synthesized. Narrative-only entries (no discrete question) fall
    // back to an AI-written connecting note elsewhere.
    const question = String(record.question || "").replace(/^Q:\s*/i, "").trim();
    scored.push({
      slug: record.slug,
      chunkId: record.id || `${record.slug}-${scored.length}`,
      title: record.title || "Interview voice",
      question,
      quote: clean.slice(0, 140) + (clean.length > 140 ? "..." : ""),
      fullText: clean,
      url: record.url || "#",
      score: total,
    });
  }

  scored.sort((a, b) => b.score - a.score);

  const perSlugCount = new Map();
  const picked = [];
  for (const match of scored) {
    const count = perSlugCount.get(match.slug) || 0;
    if (count >= MAX_MATCHES_PER_SLUG) {
      continue;
    }
    perSlugCount.set(match.slug, count + 1);
    picked.push(match);
    if (picked.length >= MAX_MATCHES) {
      break;
    }
  }

  return picked;
}

// Every chunk belonging to one interview, in original order, for the
// full-transcript reading panel.
function getInterviewChunks(slug) {
  return corpus
    .filter((record) => record.slug === slug && !isJunkRecord(record))
    .map((record) => ({
      id: record.id,
      question: String(record.question || "").replace(/^Q:\s*/i, "").trim(),
      text: stripBoilerplate(record.text || record.answer || "").trim(),
      order: (() => {
        const match = /#qa-(\d+)/.exec(String(record.id || ""));
        return match ? Number(match[1]) : 0;
      })(),
    }))
    .sort((a, b) => a.order - b.order);
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
    const note = item.extractionFailed
      ? `<small class="upload-note">Couldn't read this file's text - it won't inform your reflection.</small>`
      : "";
    chip.innerHTML = `
      ${thumb}
      <div class="file-meta">
        <p>${item.name}</p>
        <small>${Number.isFinite(item.size) ? `${(item.size / 1024).toFixed(1)} KB` : "Unknown size"}</small>
        ${note}
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

// pdf.js only ships as an ES module build on cdnjs, but dynamic import()
// works fine from inside a plain (non-module) script like this one - no
// need to load anything up front, or pay the cost, unless someone actually
// uploads a PDF.
let pdfjsLibPromise = null;
function loadPdfjs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import(`${PDFJS_BASE}pdf.min.mjs`).then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}pdf.worker.min.mjs`;
      return mod;
    });
  }
  return pdfjsLibPromise;
}

async function extractPdfText(file) {
  const pdfjsLib = await loadPdfjs();
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const maxPages = Math.min(pdf.numPages, 20);
  const parts = [];
  for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    parts.push(content.items.map((item) => item.str || "").join(" "));
  }
  return parts.join("\n\n");
}

// mammoth.js only ships a classic (non-module) UMD build, so it's loaded
// as a plain <script> tag the first time it's needed, rather than via
// import().
let mammothLoadPromise = null;
function loadMammoth() {
  if (window.mammoth) {
    return Promise.resolve(window.mammoth);
  }
  if (!mammothLoadPromise) {
    mammothLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = MAMMOTH_URL;
      script.onload = () => resolve(window.mammoth);
      script.onerror = () => reject(new Error("Could not load mammoth.js"));
      document.head.appendChild(script);
    });
  }
  return mammothLoadPromise;
}

async function extractDocxText(file) {
  const mammoth = await loadMammoth();
  const buffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
  return result.value || "";
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
    } else if (
      (file.type === "application/pdf" || PDF_EXTENSION.test(file.name)) &&
      file.size <= MAX_DOCUMENT_BYTES
    ) {
      const raw = await extractPdfText(file);
      if (raw.trim()) {
        record.textExcerpt = raw.slice(0, MAX_TEXT_CHARS);
      } else {
        record.extractionFailed = true;
      }
    } else if (
      (file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        DOCX_EXTENSION.test(file.name)) &&
      file.size <= MAX_DOCUMENT_BYTES
    ) {
      const raw = await extractDocxText(file);
      if (raw.trim()) {
        record.textExcerpt = raw.slice(0, MAX_TEXT_CHARS);
      } else {
        record.extractionFailed = true;
      }
    }
  } catch (error) {
    console.error(`Could not read ${file.name}:`, error);
    record.extractionFailed = true;
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
  feedNotes = new Map();

  if (!matches.length) {
    quoteFeed.hidden = true;
    return;
  }

  quoteFeed.hidden = false;

  matches.forEach((match, index) => {
    const item = document.createElement("article");
    item.className = "quote-feed-item";
    item.dataset.matchIndex = String(index);
    item.setAttribute("role", "button");
    item.setAttribute("tabindex", "0");
    // Staggered fade-in, capped so a long list doesn't take forever to
    // finish appearing - the archive visibly "comes alive" in response to
    // what was just written, rather than just snapping into place.
    item.style.animationDelay = `${Math.min(index, 10) * 55}ms`;

    // Real interview questions are the prompt whenever one exists - they
    // are literally what the archive is "asking", not something invented.
    const promptHtml = match.question
      ? `<p class="feed-prompt">They were asked: &ldquo;${escapeHtml(match.question)}&rdquo;</p>`
      : "";

    item.innerHTML = `
      <h3>${escapeHtml(match.title)}</h3>
      ${promptHtml}
      <p class="snippet">${escapeHtml(match.quote)}</p>
      <span class="feed-cta">Read the full interview &rarr;</span>
    `;
    quoteFeed.appendChild(item);
  });
}

let autoMatchTimer = null;
let lastMatchedText = "";
const AUTO_MATCH_IDLE_MS = 1400;
const AUTO_MATCH_MIN_WORDS = 6;

async function fetchResonanceNote(match) {
  const response = await fetch("/api/ai-question", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: state.text, match }),
  });
  if (!response.ok) {
    throw new Error(`Server responded ${response.status}`);
  }
  const result = await response.json();
  return result.note || "";
}

// Spotlights the top match above the textbox. A real interview question is
// used whenever the match has one - it's literally the interviewee's own
// question, an invitation to answer it too, not the AI inventing a
// conversational turn. Only narrative-only excerpts (no discrete question)
// fall back to an AI-written connecting note.
async function spotlightTopMatch(match) {
  if (match.question) {
    continuePrompt.classList.remove("is-loading");
    continuePrompt.classList.add("has-note");
    continuePrompt.textContent = `${match.title} was asked: “${match.question}” - what's your own answer to that?`;
    return;
  }

  continuePrompt.classList.add("is-loading");
  continuePrompt.classList.remove("has-note");
  continuePrompt.textContent = "Looking for a connection in the archive...";

  try {
    const note = await fetchResonanceNote(match);
    feedNotes.set(0, note);
    if (note) {
      continuePrompt.textContent = note;
      continuePrompt.classList.add("has-note");
    } else {
      continuePrompt.textContent = "Keep writing - related voices will surface below.";
    }
  } catch (error) {
    console.error("Could not fetch a resonance note:", error);
    continuePrompt.textContent = "Keep writing - related voices will surface below.";
  } finally {
    continuePrompt.classList.remove("is-loading");
  }
}

let readerObserver = null;
let currentReaderSlug = null;
let currentReaderIndex = null;
let notesSaveTimer = null;

function renderReaderChunks(slug) {
  const chunks = getInterviewChunks(slug);
  readerBody.innerHTML = chunks
    .map(
      (chunk) => `
        <section class="reader-chunk" data-chunk-id="${escapeHtml(chunk.id)}">
          ${chunk.question ? `<p class="reader-question">They were asked: &ldquo;${escapeHtml(chunk.question)}&rdquo;</p>` : ""}
          <p class="reader-answer">${escapeHtml(chunk.text)}</p>
        </section>
      `
    )
    .join("");
  return chunks;
}

function setupReaderObserver(slug, chunks) {
  if (readerObserver) {
    readerObserver.disconnect();
    readerObserver = null;
  }
  if (typeof IntersectionObserver !== "function") {
    return;
  }
  readerObserver = new IntersectionObserver(
    (entries) => {
      const mostVisible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!mostVisible) return;
      const chunk = chunks.find((c) => c.id === mostVisible.target.dataset.chunkId);
      if (!chunk || !readerNotesHint) return;
      readerNotesHint.textContent = chunk.question
        ? `Reacting to: “${chunk.question}”`
        : "What stands out to you here?";
    },
    { root: readerBody, threshold: [0.4, 0.6] }
  );
  readerBody.querySelectorAll(".reader-chunk").forEach((el) => readerObserver.observe(el));
}

function openReader(index) {
  const match = activeMatches[index];
  if (!match || !readerPanel) return;

  currentReaderSlug = match.slug;
  currentReaderIndex = index;

  if (readerTitle) readerTitle.textContent = match.title;
  if (readerSourceLink) readerSourceLink.href = match.url || "#";

  const chunks = renderReaderChunks(match.slug);

  if (readerNotesInput) {
    readerNotesInput.value = (state.interviewNotes && state.interviewNotes[match.slug]) || "";
  }
  if (readerNotesHint) {
    readerNotesHint.textContent = match.question ? `Reacting to: “${match.question}”` : "What stands out to you here?";
  }

  readerPanel.classList.add("is-open");
  readerPanel.setAttribute("aria-hidden", "false");
  document.body.classList.add("reader-open");

  const target = Array.from(readerBody.querySelectorAll(".reader-chunk")).find(
    (el) => el.dataset.chunkId === match.chunkId
  );
  if (target && typeof target.scrollIntoView === "function") {
    target.scrollIntoView({ block: "start" });
    target.classList.add("is-highlighted");
    setTimeout(() => target.classList.remove("is-highlighted"), 1600);
  }

  setupReaderObserver(match.slug, chunks);
}

function closeReader() {
  if (!readerPanel) return;
  readerPanel.classList.remove("is-open");
  readerPanel.setAttribute("aria-hidden", "true");
  document.body.classList.remove("reader-open");
  if (readerObserver) {
    readerObserver.disconnect();
    readerObserver = null;
  }
  currentReaderSlug = null;
  currentReaderIndex = null;
}

function saveCurrentNote() {
  if (!currentReaderSlug || !readerNotesInput) return;
  state.interviewNotes = state.interviewNotes || {};
  const value = readerNotesInput.value.trim();
  if (value) {
    state.interviewNotes[currentReaderSlug] = value;
  } else {
    delete state.interviewNotes[currentReaderSlug];
  }
  safeSetStorage(PROFILE_STORAGE_KEY, state);
}

function handleNotesInput() {
  clearTimeout(notesSaveTimer);
  notesSaveTimer = setTimeout(saveCurrentNote, 500);
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
    spotlightTopMatch(matches[0]);
  } else {
    continuePrompt.classList.remove("is-loading", "has-note");
    continuePrompt.textContent = "No close matches yet - keep writing and the archive will respond.";
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
    const item = target.closest(".quote-feed-item");
    if (!(item instanceof HTMLElement)) {
      return;
    }
    const index = Number.parseInt(item.dataset.matchIndex || "", 10);
    if (!Number.isInteger(index) || index < 0 || index >= activeMatches.length) {
      return;
    }
    openReader(index);
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
    openReader(index);
  });

  // The spotlight above the textbox points at a specific interview - make
  // it open the same reader, so following the connection through feels
  // like one continuous action.
  if (continuePrompt) {
    continuePrompt.addEventListener("click", () => {
      if (activeMatches.length && continuePrompt.classList.contains("has-note")) {
        openReader(0);
      }
    });
  }

  if (readerClose) {
    readerClose.addEventListener("click", () => {
      saveCurrentNote();
      closeReader();
    });
  }

  if (readerBackdrop) {
    readerBackdrop.addEventListener("click", () => {
      saveCurrentNote();
      closeReader();
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && readerPanel && readerPanel.classList.contains("is-open")) {
      saveCurrentNote();
      closeReader();
    }
  });

  if (readerNotesInput) {
    readerNotesInput.addEventListener("input", handleNotesInput);
  }

  letsGoButton.addEventListener("click", () => {
    const text = storyInput.value.trim();
    if (!text) {
      continuePrompt.classList.remove("has-note", "is-loading");
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
    state.interviewNotes = saved.interviewNotes && typeof saved.interviewNotes === "object" ? saved.interviewNotes : {};
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
