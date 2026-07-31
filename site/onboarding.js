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
const quoteNodes = document.getElementById("quoteNodes");
const continuePrompt = document.getElementById("continuePrompt");
const quotePopup = document.getElementById("quotePopup");
const quotePopupTitle = document.getElementById("quotePopupTitle");
const quotePopupBody = document.getElementById("quotePopupBody");
const quotePopupQuestion = document.getElementById("quotePopupQuestion");
const quotePopupLink = document.getElementById("quotePopupLink");
const quotePopupClose = document.getElementById("quotePopupClose");

let corpus = [];
let state = {
  text: "",
  uploads: [],
};
let activeMatches = [];

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
    if (!record.slug) {
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
      const clean = String(record.text || "").replace(/\s+/g, " ").trim();
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

function renderSpiderweb(matches) {
  quoteNodes.innerHTML = "";
  activeMatches = matches;
  if (!matches.length) {
    intakeStage.classList.remove("is-active");
    continuePrompt.textContent = "No close quote matches yet. Add more detail, then press Go again.";
    return;
  }

  const isMobile = window.innerWidth < 760;
  const visibleMatches = matches.slice(0, 6);
  const stageHalfWidth = Math.max(180, (intakeStage.clientWidth || 900) / 2);
  const stageHalfHeight = Math.max(220, (intakeStage.clientHeight || 620) / 2);
  const nodeWidth = isMobile ? Math.min(220, Math.max(150, Math.floor(stageHalfWidth * 0.9))) : 220;
  const nodeHeight = isMobile ? 138 : 130;
  const inputShell = intakeStage.querySelector(".input-shell");
  const stageRect = intakeStage.getBoundingClientRect();
  const shellRect = inputShell ? inputShell.getBoundingClientRect() : null;
  const exclusionHalfX = shellRect ? shellRect.width / 2 + nodeWidth / 2 + 28 : 420;
  const exclusionHalfY = shellRect ? shellRect.height / 2 + nodeHeight / 2 + 28 : 220;
  const exclusionCenterX = shellRect
    ? shellRect.left - stageRect.left + shellRect.width / 2 - stageRect.width / 2
    : 0;
  const exclusionCenterY = shellRect
    ? shellRect.top - stageRect.top + shellRect.height / 2 - stageRect.height / 2
    : 0;

  function intersectsTextbox(point) {
    const relX = point.x - exclusionCenterX;
    const relY = point.y - exclusionCenterY;
    return Math.abs(relX) < exclusionHalfX && Math.abs(relY) < exclusionHalfY;
  }

  function keepOutOfTextbox(point) {
    const relX = point.x - exclusionCenterX;
    const relY = point.y - exclusionCenterY;
    if (Math.abs(relX) < exclusionHalfX && Math.abs(relY) < exclusionHalfY) {
      const pushX = exclusionHalfX - Math.abs(relX) + 12;
      const pushY = exclusionHalfY - Math.abs(relY) + 12;
      if (pushX < pushY) {
        point.x += Math.sign(relX || (Math.random() > 0.5 ? 1 : -1)) * pushX;
      } else {
        point.y += Math.sign(relY || (Math.random() > 0.5 ? 1 : -1)) * pushY;
      }
    }
  }

  const points = visibleMatches.map((_, index) => {
    const ring = index < 3 ? 0 : 1;
    const ringSlots = ring === 0 ? Math.min(3, visibleMatches.length) : Math.max(1, visibleMatches.length - 3);
    const slotIndex = ring === 0 ? index : index - 3;
    const radius = ring === 0 ? (isMobile ? 145 : 175) : (isMobile ? 245 : 305);
    const angleOffset = ring === 0 ? 0 : Math.PI / Math.max(1, ringSlots);
    const angle = (Math.PI * 2 * slotIndex) / ringSlots + angleOffset;
    return {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    };
  });

  const maxX = stageHalfWidth - nodeWidth / 2 - 10;
  const maxY = stageHalfHeight - nodeHeight / 2 - 10;

  for (let iter = 0; iter < 120; iter += 1) {
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const dx = points[j].x - points[i].x;
        const dy = points[j].y - points[i].y;
        const overlapX = nodeWidth - Math.abs(dx);
        const overlapY = nodeHeight - Math.abs(dy);

        if (overlapX > 0 && overlapY > 0) {
          const pushX = (overlapX / 2 + 3) * (dx === 0 ? (Math.random() > 0.5 ? 1 : -1) : Math.sign(dx));
          const pushY = (overlapY / 2 + 3) * (dy === 0 ? (Math.random() > 0.5 ? 1 : -1) : Math.sign(dy));
          points[i].x -= pushX;
          points[j].x += pushX;
          points[i].y -= pushY;
          points[j].y += pushY;
        }
      }
    }

    for (const point of points) {
      keepOutOfTextbox(point);
      point.x = Math.max(-maxX, Math.min(maxX, point.x));
      point.y = Math.max(-maxY, Math.min(maxY, point.y));
      keepOutOfTextbox(point);
    }
  }

  for (const point of points) {
    keepOutOfTextbox(point);
    point.x = Math.max(-maxX, Math.min(maxX, point.x));
    point.y = Math.max(-maxY, Math.min(maxY, point.y));
  }

  visibleMatches.forEach((match, index) => {
    const x = points[index].x;
    const y = points[index].y;

    if (intersectsTextbox({ x, y })) {
      return;
    }

    const node = document.createElement("article");
    node.className = "quote-node";
    node.dataset.matchIndex = String(index);
    node.style.width = `${nodeWidth}px`;
    node.style.minHeight = `${nodeHeight}px`;
    node.style.setProperty("--x", `${x}px`);
    node.style.setProperty("--y", `${y}px`);
    node.style.animationDelay = `${index * 60}ms`;
    node.innerHTML = `
      <h3>${match.title}</h3>
      <p>${match.quote}</p>
    `;
    quoteNodes.appendChild(node);
  });

  intakeStage.classList.add("is-active");
  continuePrompt.textContent = "Click a voice to hear a question grown from their story, or keep writing in response to what resonates.";
}

async function openQuotePopup(match) {
  if (!quotePopup || !quotePopupTitle || !quotePopupBody || !quotePopupLink) {
    return;
  }

  quotePopupTitle.textContent = match.title || "Interview voice";
  quotePopupBody.textContent = match.fullText || match.quote || "No additional text available.";
  quotePopupLink.href = match.url || "#";
  quotePopupQuestion.textContent = "Thinking of a question worth asking...";
  quotePopupQuestion.classList.add("is-loading");
  quotePopup.classList.add("is-open");
  quotePopup.setAttribute("aria-hidden", "false");

  try {
    const response = await fetch("/api/ai-question", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: state.text, match }),
    });
    if (!response.ok) {
      throw new Error(`Server responded ${response.status}`);
    }
    const result = await response.json();
    quotePopupQuestion.textContent = result.question || "";
  } catch (error) {
    console.error("Could not fetch a question:", error);
    quotePopupQuestion.textContent = "";
  } finally {
    quotePopupQuestion.classList.remove("is-loading");
  }
}

function closeQuotePopup() {
  if (!quotePopup) {
    return;
  }
  quotePopup.classList.remove("is-open");
  quotePopup.setAttribute("aria-hidden", "true");
}

function refreshWordCount() {
  state.text = storyInput.value;
  wordCount.textContent = `${countWords(state.text)} words`;
  safeSetStorage(PROFILE_STORAGE_KEY, state);
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

  quoteNodes.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const node = target.closest(".quote-node");
    if (!(node instanceof HTMLElement)) {
      return;
    }

    const index = Number.parseInt(node.dataset.matchIndex || "", 10);
    if (!Number.isInteger(index) || index < 0 || index >= activeMatches.length) {
      return;
    }
    openQuotePopup(activeMatches[index]);
  });

  if (quotePopupClose) {
    quotePopupClose.addEventListener("click", closeQuotePopup);
  }

  if (quotePopup) {
    quotePopup.addEventListener("click", (event) => {
      if (event.target === quotePopup) {
        closeQuotePopup();
      }
    });
  }

  letsGoButton.addEventListener("click", () => {
    const text = storyInput.value.trim();
    if (!text) {
      continuePrompt.textContent = "Write a few honest lines first, then press Go.";
      storyInput.focus();
      return;
    }

    const matches = buildMatches(text, state.uploads);
    renderSpiderweb(matches);
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

  wireEvents();
  await loadCorpus();
}

initialize().catch((error) => {
  console.error("Failed to initialize homepage interaction:", error);
  continuePrompt.textContent = "Could not load interview voices yet. Refresh and try again.";
});
