const ABOUT_STORAGE_KEY = "trace_about_me_v2";

function readPayload() {
  const raw = localStorage.getItem(ABOUT_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function fillList(container, items, fallback) {
  container.innerHTML = "";
  const source = items && items.length ? items : [fallback];
  for (const item of source) {
    const li = document.createElement("li");
    li.textContent = item;
    container.appendChild(li);
  }
}

function renderIDPLines(container, idp) {
  container.innerHTML = "";

  const lines = [
    ["Specific", idp?.specific],
    ["Measurable", idp?.measurable],
    ["Abilities", idp?.abilities],
    ["Relevant", idp?.relevant],
    ["Tenable", idp?.tenable],
    ["Support", idp?.support],
  ];

  for (const [label, value] of lines) {
    const line = document.createElement("div");
    line.className = "idp-line";
    line.innerHTML = `<strong>${label}:</strong> ${value || "To be expanded in your next revision."}`;
    container.appendChild(line);
  }
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

  for (const rec of recs) {
    const card = document.createElement("article");
    card.className = "rec-card";

    card.innerHTML = `
      <h3>${rec.title || "Interview"}</h3>
      <p>${rec.snippet || "Relevant transcript excerpt"}</p>
      <div class="actions">
        <a href="${rec.transcriptUrl || "index.html"}">Read transcript</a>
        <a href="${rec.url || "#"}" target="_blank" rel="noreferrer">Original source</a>
      </div>
    `;

    container.appendChild(card);
  }
}

function initialize() {
  const payload = readPayload();

  const headline = document.getElementById("headline");
  const intro = document.getElementById("intro");
  const achievementList = document.getElementById("achievementList");
  const aspirationList = document.getElementById("aspirationList");
  const idpLines = document.getElementById("idpLines");
  const uploadGallery = document.getElementById("uploadGallery");
  const recommendationList = document.getElementById("recommendationList");

  if (!payload) {
    headline.textContent = "Your About Me is waiting";
    intro.textContent = "Write your narrative on the homepage, then synthesize it to generate this page.";
    fillList(achievementList, [], "Add your first achievement on the home page.");
    fillList(aspirationList, [], "Add a future aspiration on the home page.");
    renderIDPLines(idpLines, {});
    renderUploads(uploadGallery, []);
    renderRecommendations(recommendationList, []);
    return;
  }

  headline.textContent = payload.headline || "My About Me";
  intro.textContent = payload.intro || "A reflective profile generated from your narrative.";

  fillList(
    achievementList,
    payload.achievements,
    "Continue adding concrete outcomes to strengthen this section."
  );
  fillList(
    aspirationList,
    payload.aspirations,
    "Continue adding future-focused goals to strengthen this section."
  );

  renderIDPLines(idpLines, payload.idp || {});
  renderUploads(uploadGallery, payload.uploads || []);
  renderRecommendations(recommendationList, payload.recommendations || []);
}

initialize();
