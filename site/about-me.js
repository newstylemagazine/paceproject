const PROFILE_STORAGE_KEY = "trace_profile_intake_v3";
const ABOUT_STORAGE_KEY = "trace_about_me_v2";

const PROVIDER_LABELS = {
  groq: "Groq AI",
  openai: "OpenAI",
  fallback: "Local fallback",
};

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

// Small non-cryptographic hash so we can tell whether the cached About Me
// page still matches the story text the user last wrote on the homepage.
function hashInput(text, uploads) {
  const source = `${text}::${(uploads || []).map((u) => u.name).join("|")}`;
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) | 0;
  }
  return String(hash);
}

function fillList(container, items, fallback) {
  container.innerHTML = "";
  const source = items && items.length ? items : [fallback];
  source.forEach((item, index) => {
    const li = document.createElement("li");
    li.textContent = item;
    li.style.animationDelay = `${index * 70}ms`;
    li.classList.add("reveal-item");
    container.appendChild(li);
  });
}

function renderIDPLines(container, idp) {
  container.innerHTML = "";

  const lines = [
    ["S", "Specific", idp?.specific],
    ["M", "Measurable", idp?.measurable],
    ["A", "Abilities", idp?.abilities],
    ["R", "Relevant", idp?.relevant],
    ["T", "Tenable", idp?.tenable],
    ["+", "Support", idp?.support],
  ];

  lines.forEach(([initial, label, value], index) => {
    const line = document.createElement("div");
    line.className = "idp-line reveal-item";
    line.style.animationDelay = `${index * 80}ms`;
    line.innerHTML = `
      <span class="idp-badge">${initial}</span>
      <div>
        <strong>${label}</strong>
        <p>${value || "To be expanded in your next revision."}</p>
      </div>
    `;
    container.appendChild(line);
  });
}

function renderUploads(container, uploads) {
  container.innerHTML = "";

  if (!uploads || !uploads.length) {
    container.innerHTML = '<p class="empty">No uploaded artifacts were included yet.</p>';
    return;
  }

  for (const upload of uploads) {
    const card = document.createElement("article");
    card.className = "upload-item";

    const preview = upload.previewDataUrl
      ? `<img src="${upload.previewDataUrl}" alt="Preview of ${upload.name}" />`
      : '<div class="doc">Document</div>';

    card.innerHTML = `${preview}<p>${upload.name}</p>`;
    container.appendChild(card);
  }
}

function renderRecommendations(container, recs) {
  container.innerHTML = "";

  if (!recs || !recs.length) {
    container.innerHTML = '<p class="empty">No interview matches were generated. Add more detail on the home page to get recommendations.</p>';
    return;
  }

  recs.forEach((rec, index) => {
    const card = document.createElement("article");
    card.className = "rec-card reveal-item";
    card.style.animationDelay = `${index * 90}ms`;

    const chips = (rec.matchedTerms || [])
      .map((term) => `<span class="tag-chip">${term}</span>`)
      .join("");

    card.innerHTML = `
      <h3>${rec.title || "Interview"}</h3>
      <p>${rec.snippet || "Relevant transcript excerpt"}</p>
      ${chips ? `<div class="tag-row">${chips}</div>` : ""}
      <div class="actions">
        <a href="${rec.transcriptUrl || rec.url || "index.html"}" target="_blank" rel="noreferrer">Read transcript</a>
        <a href="${rec.url || "#"}" target="_blank" rel="noreferrer">Original source</a>
      </div>
    `;

    container.appendChild(card);
  });
}

function renderBadge(badgeEl, source) {
  if (!badgeEl) return;
  const label = PROVIDER_LABELS[source] || "Local fallback";
  badgeEl.textContent = source === "fallback" ? label : `${label} ✨`;
  badgeEl.className = `source-badge source-${source === "fallback" ? "fallback" : "ai"}`;
}

function els() {
  return {
    headline: document.getElementById("headline"),
    intro: document.getElementById("intro"),
    badge: document.getElementById("sourceBadge"),
    regenerateButton: document.getElementById("regenerateButton"),
    statusLine: document.getElementById("statusLine"),
    achievementList: document.getElementById("achievementList"),
    aspirationList: document.getElementById("aspirationList"),
    idpLines: document.getElementById("idpLines"),
    uploadGallery: document.getElementById("uploadGallery"),
    recommendationList: document.getElementById("recommendationList"),
    page: document.querySelector(".about-page"),
  };
}

function renderEmptyState() {
  const e = els();
  e.headline.textContent = "Your About Me is waiting";
  e.intro.textContent = "Write your narrative on the homepage, then open About Me to synthesize this page.";
  if (e.badge) e.badge.textContent = "";
  if (e.regenerateButton) e.regenerateButton.hidden = true;
  if (e.statusLine) e.statusLine.textContent = "";
  fillList(e.achievementList, [], "Add your first achievement on the home page.");
  fillList(e.aspirationList, [], "Add a future aspiration on the home page.");
  renderIDPLines(e.idpLines, {});
  renderUploads(e.uploadGallery, []);
  renderRecommendations(e.recommendationList, []);
}

function renderLoadingState() {
  const e = els();
  e.page.classList.add("is-loading");
  e.headline.textContent = "Synthesizing your About Me…";
  e.intro.textContent = "Reading your story and matching it against the interview archive.";
  if (e.statusLine) e.statusLine.textContent = "This usually takes a couple of seconds.";
  if (e.regenerateButton) e.regenerateButton.hidden = true;
  e.achievementList.innerHTML = '<li class="skeleton-line"></li><li class="skeleton-line"></li>';
  e.aspirationList.innerHTML = '<li class="skeleton-line"></li><li class="skeleton-line"></li>';
  e.idpLines.innerHTML = '<div class="skeleton-block"></div>';
  e.recommendationList.innerHTML = '<div class="skeleton-block"></div>';
}

function renderErrorState(message) {
  const e = els();
  e.page.classList.remove("is-loading");
  e.headline.textContent = "Couldn't generate your About Me";
  e.intro.textContent = message;
  if (e.statusLine) e.statusLine.textContent = "";
  if (e.regenerateButton) e.regenerateButton.hidden = false;
}

function renderAbout(payload, { fromCache } = {}) {
  const e = els();
  e.page.classList.remove("is-loading");
  const about = payload.about || {};

  e.headline.textContent = about.headline || "My About Me";
  e.intro.textContent = about.intro || "A reflective profile generated from your narrative.";

  renderBadge(e.badge, payload.source || "fallback");
  if (e.regenerateButton) e.regenerateButton.hidden = false;
  if (e.statusLine) {
    e.statusLine.textContent = fromCache
      ? "Showing your last generated profile. Edit your story and regenerate for an update."
      : "Freshly generated from your current story.";
  }

  fillList(e.achievementList, about.achievements, "Continue adding concrete outcomes to strengthen this section.");
  fillList(e.aspirationList, about.aspirations, "Continue adding future-focused goals to strengthen this section.");
  renderIDPLines(e.idpLines, about.idp || {});
  renderUploads(e.uploadGallery, about.uploads || []);
  renderRecommendations(e.recommendationList, payload.recommendations || about.recommendations || []);
}

async function requestSynthesis(profile) {
  const response = await fetch("/api/ai-synthesize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: profile.text, uploads: profile.uploads || [] }),
  });

  if (!response.ok) {
    throw new Error(`Server responded with ${response.status}`);
  }

  return response.json();
}

async function generate(profile, hash, { silent } = {}) {
  if (!silent) {
    renderLoadingState();
  }

  try {
    const result = await requestSynthesis(profile);
    safeSetStorage(ABOUT_STORAGE_KEY, { hash, ...result, createdAt: new Date().toISOString() });
    renderAbout(result, { fromCache: false });
  } catch (error) {
    console.error("About Me synthesis failed:", error);
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

  const hash = hashInput(text, profile.uploads);
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
