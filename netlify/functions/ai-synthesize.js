import { buildRecommendations } from "./_lib/matching.js";
import { callTextProvider, describeImage } from "./_lib/providers.js";
import { SYNTHESIS_SYSTEM_PROMPT } from "./_lib/prompts.js";
import { fallbackAboutPayload } from "./_lib/fallback.js";

const MAX_IMAGE_DESCRIPTIONS = 2;
const MAX_TEXT_EXCERPT_CHARS = 3000;

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function corsPreflight() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

async function gatherUploadContext(env, uploads) {
  const extraTextParts = [];
  let imageBudget = MAX_IMAGE_DESCRIPTIONS;
  const annotated = [];

  for (const upload of uploads) {
    if (!upload || typeof upload !== "object") continue;
    const item = { ...upload };

    const textExcerpt = String(item.textExcerpt || "").trim();
    if (textExcerpt) {
      extraTextParts.push(textExcerpt.slice(0, MAX_TEXT_EXCERPT_CHARS));
    }

    if (item.previewDataUrl && imageBudget > 0) {
      try {
        const description = await describeImage(env, item.previewDataUrl, item.name || "photo");
        if (description) {
          item.aiDescription = description;
          extraTextParts.push(description);
          imageBudget -= 1;
        }
      } catch (error) {
        console.error("[ai-vision] image description failed:", error);
      }
    }

    annotated.push(item);
  }

  return { extraText: extraTextParts.join(" "), annotatedUploads: annotated };
}

// interviewNotes[slug] can be either the legacy single-string format or
// the current running-conversation format (an array of {role, text} turns
// - "user" for the person's own notes, "ai" for the follow-up questions
// the notes panel asked back). Both are normalized to a turn array here so
// the rest of synthesis doesn't need to care which shape it got.
function normalizeNoteEntry(raw) {
  if (typeof raw === "string") {
    const text = raw.trim();
    return text ? [{ role: "user", text }] : [];
  }
  if (Array.isArray(raw)) {
    return raw
      .map((turn) => ({
        role: turn && turn.role === "ai" ? "ai" : "user",
        text: String((turn && turn.text) || "").trim(),
      }))
      .filter((turn) => turn.text);
  }
  return [];
}

// Only the person's own words are a useful signal for keyword matching -
// the AI's own follow-up questions would just skew scoring toward archive
// vocabulary it already picked.
function gatherInterviewNotes(interviewNotes) {
  if (!interviewNotes || typeof interviewNotes !== "object") return "";
  const parts = [];
  for (const raw of Object.values(interviewNotes)) {
    for (const turn of normalizeNoteEntry(raw)) {
      if (turn.role === "user") parts.push(turn.text);
    }
  }
  return parts.join(" ");
}

async function synthesize(env, requestUrl, payload) {
  const text = String(payload.text || "").trim();
  const uploads = Array.isArray(payload.uploads) ? payload.uploads : [];
  const notesText = gatherInterviewNotes(payload.interviewNotes);

  const { extraText, annotatedUploads } = await gatherUploadContext(env, uploads);
  const combinedText = `${text} ${extraText} ${notesText}`.trim();
  const uploadNames = annotatedUploads.map((item) => String(item.name || ""));

  const recommendations = await buildRecommendations(requestUrl, combinedText, uploadNames);
  const recsBySlug = new Map(recommendations.map((rec) => [rec.slug, rec]));

  let about = null;
  let source = "fallback";

  const interviewContext = recommendations.slice(0, 5).map((rec) => ({
    slug: rec.slug,
    title: rec.title,
    snippet: rec.snippet,
  }));
  const uploadContext = annotatedUploads.map((item) => ({
    name: item.name,
    aiDescription: item.aiDescription,
    textExcerpt: (item.textExcerpt || "").slice(0, 500),
  }));

  // The full back-and-forth (not just the person's side) gives the
  // synthesis model real conversational context - what they said, and
  // what a sharp follow-up question drew out of them.
  const readerNotes = Object.entries(payload.interviewNotes || {})
    .map(([slug, raw]) => ({ slug, thread: normalizeNoteEntry(raw) }))
    .filter((item) => item.thread.length);

  const userPayload = {
    user_text: text,
    uploads: uploadContext,
    interview_context: interviewContext,
    reader_notes: readerNotes,
  };

  const result = await callTextProvider(env, [
    { role: "system", content: SYNTHESIS_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(userPayload) },
  ]);

  if (result && result.parsed && typeof result.parsed === "object") {
    const parsed = result.parsed;
    const kindredVoices = [];
    for (const item of (parsed.resonances || []).slice(0, 4)) {
      if (!item || typeof item !== "object") continue;
      const rec = recsBySlug.get(item.slug);
      if (!rec) continue;
      kindredVoices.push({
        title: rec.title,
        why: item.why || "",
        quote: rec.snippet,
        url: rec.url,
      });
    }
    about = {
      mirror_headline: parsed.mirror_headline || "",
      reflection: parsed.reflection || "",
      threads: parsed.threads || [],
      kindred_voices: kindredVoices,
      provocation: parsed.provocation || "",
    };
    source = result.providerName;
  }

  if (!about) {
    about = fallbackAboutPayload(text, recommendations);
  }

  about.uploads = annotatedUploads;

  return { source, recommendations, about };
}

export default async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let payload;
  try {
    payload = await req.json();
    if (!payload || typeof payload !== "object") throw new Error("Payload must be an object");
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  try {
    const result = await synthesize(process.env, req.url, payload);
    return jsonResponse(result);
  } catch (error) {
    console.error("[ai-synthesize] failed:", error);
    return jsonResponse({ error: String(error) }, 500);
  }
};

export const config = { path: "/api/ai-synthesize", method: ["POST", "OPTIONS"] };
