const PROFILE_STORAGE_KEY = "trace_profile_intake_v3";
const ABOUT_STORAGE_KEY = "trace_about_me_v3";

function readStorage(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function safeSetStorage(key, payload) {
  try {
    localStorage.setItem(key, JSON.stringify(payload));
  } catch (error) {
    console.error("Storage write failed:", error);
  }
}

// Small non-cryptographic hash so we can tell whether the cached reflection
// still matches the story (and uploads) the user last left on the homepage.
function hashInput(text, uploads, interviewNotes) {
  // interviewNotes[slug] is either the current running-conversation format
  // (an array of {role, text} turns) or the legacy single-string format.
  // Either way, hash on the actual role+text content only (not ts, which
  // would otherwise bust the cache on every render for no real reason).
  const notesPart = Object.entries(interviewNotes || {})
    .map(([slug, raw]) => {
      const thread = Array.isArray(raw)
        ? raw
        : raw
        ? [{ role: "user", text: String(raw) }]
        : [];
      const threadText = thread.map((turn) => `${turn.role}:${turn.text}`).join("~");
      return `${slug}=${threadText}`;
    })
    .join("|");
  const source = `${text}::${(uploads || []).map((u) => u.name).join("|")}::${notesPart}`;
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) | 0;
  }
  return String(hash);
}

function fillThreads(container, threads) {
  container.innerHTML = "";
  const source = threads && threads.length ? threads : ["Write a little more, and a thread will start to show itself."];
  source.forEach((item, index) => {
    const li = document.createElement("li");
    li.textContent = item;
    li.className = "reveal-item";
    li.style.animationDelay = `${index * 90}ms`;
    container.appendChild(li);
  });
}

function renderUploads(container, uploads) {
  container.innerHTML = "";

  if (!uploads || !uploads.length) {
    container.innerHTML = '<p class="empty">Nothing shared yet - a photo, a document, anything lying around helps fill this in.</p>';
    return;
  }

  for (const upload of uploads) {
    const card = document.createElement("article");
    card.className = "upload-item";

    const preview = upload.previewDataUrl
      ? `<img src="${upload.previewDataUrl}" alt="Preview of ${upload.name}" />`
      : '<div class="doc">Document</div>';

    const description = upload.aiDescription ? `<p class="upload-ai-note">${upload.aiDescription}</p>` : "";
    card.innerHTML = `${preview}<p>${upload.name}</p>${description}`;
    container.appendChild(card);
  }
}

function renderKindredVoices(container, voices) {
  container.innerHTML = "";

  if (!voices || !voices.length) {
    container.innerHTML = '<p class="empty">No kindred voices surfaced yet. Write a bit more on the home page and come back.</p>';
    return;
  }

  voices.forEach((voice, index) => {
    const card = document.createElement("article");
    card.className = "rec-card reveal-item";
    card.style.animationDelay = `${index * 90}ms`;

    card.innerHTML = `
      <h3>${voice.title || "Interview"}</h3>
      ${voice.why ? `<p class="rec-why">${voice.why}</p>` : ""}
      ${voice.quote ? `<p class="rec-quote">"${voice.quote}"</p>` : ""}
      <div class="actions">
        <a href="${voice.url || "#"}" target="_blank" rel="noreferrer">Read their full interview</a>
      </div>
    `;

    container.appendChild(card);
  });
}

function els() {
  return {
    headline: document.getElementById("headline"),
    intro: document.getElementById("intro"),
    regenerateButton: document.getElementById("regenerateButton"),
    statusLine: document.getElementById("statusLine"),
    threadList: document.getElementById("threadList"),
    uploadGallery: document.getElementById("uploadGallery"),
    recommendationList: document.getElementById("recommendationList"),
    provocation: document.getElementById("provocation"),
    page: document.querySelector(".about-page"),
  };
}

function renderEmptyState() {
  const e = els();
  e.headline.textContent = "You haven't written anything yet";
  e.intro.textContent = "Go write a few honest lines on the home page - or drop in a document or photo - then come back here.";
  if (e.regenerateButton) e.regenerateButton.hidden = true;
  if (e.statusLine) e.statusLine.textContent = "";
  fillThreads(e.threadList, []);
  renderUploads(e.uploadGallery, []);
  renderKindredVoices(e.recommendationList, []);
  e.provocation.textContent = "";
}

function renderLoadingState() {
  const e = els();
  e.page.classList.add("is-loading");
  e.headline.textContent = "Working through what you wrote…";
  e.intro.textContent = "Reading your story, looking at what you shared, and finding related interviews.";
  if (e.statusLine) e.statusLine.textContent = "This usually takes a couple of seconds.";
  if (e.regenerateButton) e.regenerateButton.hidden = true;
  e.threadList.innerHTML = '<li class="skeleton-line"></li><li class="skeleton-line"></li>';
  e.recommendationList.innerHTML = '<div class="skeleton-block"></div>';
  e.provocation.textContent = "";
}

function renderErrorState(message) {
  const e = els();
  e.page.classList.remove("is-loading");
  e.headline.textContent = "Couldn't put this together";
  e.intro.textContent = message;
  if (e.statusLine) e.statusLine.textContent = "";
  if (e.regenerateButton) e.regenerateButton.hidden = false;
}

function renderAbout(payload, { fromCache } = {}) {
  const e = els();
  e.page.classList.remove("is-loading");
  const about = payload.about || {};

  e.headline.textContent = about.mirror_headline || "Your reflection";
  e.intro.textContent = about.reflection || "A reflection woven from your story and the archive.";

  if (e.regenerateButton) e.regenerateButton.hidden = false;
  if (e.statusLine) {
    e.statusLine.textContent = fromCache
      ? "Showing the last version generated. Write more and regenerate whenever it's ready."
      : "Freshly generated from what you just wrote and shared.";
  }

  fillThreads(e.threadList, about.threads);
  renderUploads(e.uploadGallery, about.uploads || []);
  renderKindredVoices(e.recommendationList, about.kindred_voices || []);
  e.provocation.textContent = about.provocation || "";
}

async function requestSynthesis(profile) {
  const response = await fetch("/api/ai-synthesize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: profile.text,
      uploads: profile.uploads || [],
      interviewNotes: profile.interviewNotes || {},
    }),
  });

  if (!response.ok) {
    throw new Error(`Server responded with ${response.status}`);
  }

  return response.json();
}

async function generate(profile, hash) {
  renderLoadingState();

  try {
    const result = await requestSynthesis(profile);
    safeSetStorage(ABOUT_STORAGE_KEY, { hash, ...result, createdAt: new Date().toISOString() });
    renderAbout(result, { fromCache: false });
  } catch (error) {
    console.error("Reflection synthesis failed:", error);
    renderErrorState(
      "The AI synthesis endpoint isn't reachable. Make sure the local server is running " +
        "(python scripts/start_trace_site.py) and try again."
    );
  }
}

function initialize() {
  const profile = readStorage(PROFILE_STORAGE_KEY);
  const text = String(profile?.text || "").trim();

  if (!profile || !text) {
    renderEmptyState();
    return;
  }

  const hash = hashInput(text, profile.uploads, profile.interviewNotes);
  const cached = readStorage(ABOUT_STORAGE_KEY);

  const regenerateButton = document.getElementById("regenerateButton");
  if (regenerateButton) {
    regenerateButton.addEventListener("click", () => {
      generate(profile, hash);
    });
  }

  if (cached && cached.hash === hash && cached.about) {
    renderAbout(cached, { fromCache: true });
    return;
  }

  generate(profile, hash);
}

initialize();
