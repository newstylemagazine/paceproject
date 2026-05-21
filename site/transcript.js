const DATASET_MAP = {
  tracemcgill: {
    name: "TRaCE McGill",
    interviewsPath: "../data/tracemcgill/interviews.json",
    isYoutube: false,
  },
  tracephd: {
    name: "TRaCE PhD",
    interviewsPath: "../data/tracephd/interviews.json",
    isYoutube: false,
  },
  tracetransborder: {
    name: "TRaCE Transborder (YouTube)",
    interviewsPath: "../data/tracetransborder/interviews.json",
    isYoutube: true,
  },
};

const statusNode = document.getElementById("status");
const sourceNameNode = document.getElementById("sourceName");
const titleNode = document.getElementById("title");
const metaNode = document.getElementById("meta");
const transcriptNode = document.getElementById("transcript");
const sourceLink = document.getElementById("sourceLink");
const videoMomentLink = document.getElementById("videoMomentLink");
const videoPanel = document.getElementById("videoPanel");
const videoFrame = document.getElementById("videoFrame");

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function highlightTerms(text, query) {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);

  let output = escapeHtml(text || "");
  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    output = output.replace(new RegExp(`(${escaped})`, "gi"), "<mark>$1</mark>");
  }
  return output;
}

function youtubeEmbedUrl(url, startSeconds) {
  try {
    const parsed = new URL(url);
    const videoId = parsed.searchParams.get("v");
    if (!videoId) {
      return null;
    }
    const embed = new URL(`https://www.youtube.com/embed/${videoId}`);
    if (Number.isFinite(startSeconds) && startSeconds > 0) {
      embed.searchParams.set("start", String(Math.floor(startSeconds)));
    }
    return embed.toString();
  } catch {
    return null;
  }
}

async function loadInterview(dataset, slug) {
  const response = await fetch(dataset.interviewsPath, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Could not load ${dataset.interviewsPath}`);
  }
  const payload = await response.json();
  const interviews = Array.isArray(payload.interviews) ? payload.interviews : [];
  return interviews.find((entry) => entry.slug === slug) || null;
}

async function initialize() {
  const params = new URLSearchParams(window.location.search);
  const sourceId = params.get("source") || "";
  const slug = params.get("slug") || "";
  const query = params.get("q") || "";
  const start = Number.parseInt(params.get("start") || "0", 10);

  const dataset = DATASET_MAP[sourceId];
  if (!dataset || !slug) {
    statusNode.textContent = "Missing source or transcript slug.";
    return;
  }

  sourceNameNode.textContent = dataset.name;

  const interview = await loadInterview(dataset, slug);
  if (!interview) {
    statusNode.textContent = "Transcript not found in dataset.";
    return;
  }

  titleNode.textContent = interview.title || "Transcript";
  metaNode.textContent = [dataset.name, interview.published || "Unknown date"].join(" | ");
  sourceLink.href = interview.url || "#";

  transcriptNode.innerHTML = highlightTerms(interview.transcript_text || "", query);
  statusNode.textContent = query
    ? `Showing full transcript with highlights for: "${query}".`
    : "Showing full transcript.";

  if (dataset.isYoutube && interview.url) {
    const jump = new URL(interview.url);
    if (Number.isFinite(start) && start > 0) {
      jump.searchParams.set("t", `${start}s`);
    }
    videoMomentLink.href = jump.toString();
    videoMomentLink.classList.remove("is-hidden");

    const embed = youtubeEmbedUrl(interview.url, start);
    if (embed) {
      videoFrame.src = embed;
      videoPanel.classList.remove("is-hidden");
    }
  }
}

initialize().catch((error) => {
  statusNode.textContent = `Failed to load transcript: ${error.message}`;
  console.error(error);
});
