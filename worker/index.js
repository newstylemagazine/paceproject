// Single Worker entry point for Cloudflare's unified "Workers with static
// assets" deploy model (the dashboard's "Create a Worker -> Import a Git
// repository" flow). This merges what used to be two separate Pages
// Functions routes (functions/api/ai-synthesize.js and ai-question.js)
// into one fetch() handler, because that flow doesn't run a functions/
// folder - see functions/api/*.js for the (still-valid) classic Pages
// Functions version, kept in case this project ever moves to classic
// Pages Git integration instead.
import { buildRecommendations, stripBoilerplate } from "../functions/_lib/matching.js";
import { callTextProvider, describeImage } from "../functions/_lib/providers.js";
import { SYNTHESIS_SYSTEM_PROMPT, RESONANCE_SYSTEM_PROMPT } from "../functions/_lib/prompts.js";
import { fallbackAboutPayload, fallbackResonanceNote } from "../functions/_lib/fallback.js";

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

async function readJsonBody(request) {
  const payload = await request.json();
  if (!payload || typeof payload !== "object") throw new Error("Payload must be an object");
  return payload;
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

async function synthesize(env, requestUrl, payload) {
  const text = String(payload.text || "").trim();
  const uploads = Array.isArray(payload.uploads) ? payload.uploads : [];

  const { extraText, annotatedUploads } = await gatherUploadContext(env, uploads);
  const combinedText = `${text} ${extraText}`.trim();
  const uploadNames = annotatedUploads.map((item) => String(item.name || ""));

  const recommendations = await buildRecommendations(env, requestUrl, combinedText, uploadNames);
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

  const userPayload = {
    user_text: text,
    uploads: uploadContext,
    interview_context: interviewContext,
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

async function getResonanceNote(env, payload) {
  const text = String(payload.text || "").trim();
  const match = payload.match && typeof payload.match === "object" ? payload.match : {};
  const excerptTitle = String(match.title || "");
  const excerptText = stripBoilerplate(String(match.fullText || match.quote || ""));

  const userPayload = {
    user_text: text,
    excerpt_title: excerptTitle,
    excerpt_text: excerptText.slice(0, 1200),
  };

  const result = await callTextProvider(env, [
    { role: "system", content: RESONANCE_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(userPayload) },
  ]);

  if (result && result.parsed && typeof result.parsed === "object" && result.parsed.note) {
    return { note: String(result.parsed.note), source: result.providerName };
  }

  return { note: fallbackResonanceNote(excerptTitle, excerptText), source: "fallback" };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/ai-synthesize") {
      if (request.method === "OPTIONS") return corsPreflight();
      if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
      let payload;
      try {
        payload = await readJsonBody(request);
      } catch {
        return jsonResponse({ error: "Invalid JSON" }, 400);
      }
      try {
        const result = await synthesize(env, request.url, payload);
        return jsonResponse(result);
      } catch (error) {
        console.error("[ai-synthesize] failed:", error);
        return jsonResponse({ error: String(error) }, 500);
      }
    }

    if (url.pathname === "/api/ai-question") {
      if (request.method === "OPTIONS") return corsPreflight();
      if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
      let payload;
      try {
        payload = await readJsonBody(request);
      } catch {
        return jsonResponse({ error: "Invalid JSON" }, 400);
      }
      try {
        const result = await getResonanceNote(env, payload);
        return jsonResponse(result);
      } catch (error) {
        console.error("[ai-question] failed:", error);
        return jsonResponse({ error: String(error) }, 500);
      }
    }

    // Everything else is a static file. Cloudflare normally serves matching
    // static assets before this Worker ever runs; this is just a safety-net
    // fallback (e.g. so an unmatched path still resolves via the assets
    // binding's own 404 handling instead of an unhandled Worker error).
    return env.ASSETS.fetch(request);
  },
};
