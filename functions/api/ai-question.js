import { callTextProvider } from "../_lib/providers.js";
import { stripBoilerplate } from "../_lib/matching.js";
import { QUESTION_SYSTEM_PROMPT } from "../_lib/prompts.js";
import { fallbackQuestion } from "../_lib/fallback.js";

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function askQuestion(env, payload) {
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
    { role: "system", content: QUESTION_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(userPayload) },
  ]);

  if (result && result.parsed && typeof result.parsed === "object" && result.parsed.question) {
    return { question: String(result.parsed.question), source: result.providerName };
  }

  return { question: fallbackQuestion(excerptTitle, excerptText), source: "fallback" };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let payload;
  try {
    payload = await request.json();
    if (!payload || typeof payload !== "object") throw new Error("Payload must be an object");
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  try {
    const result = await askQuestion(env, payload);
    return jsonResponse(result);
  } catch (error) {
    console.error("[ai-question] failed:", error);
    return jsonResponse({ error: String(error) }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
