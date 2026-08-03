import { callTextProvider } from "./_lib/providers.js";
import { NOTES_REPLY_SYSTEM_PROMPT } from "./_lib/prompts.js";
import { fallbackNotesReply } from "./_lib/fallback.js";

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

const MAX_THREAD_TURNS = 6;
const MAX_CONTEXT_CHARS = 3000;

async function getNotesReply(env, payload) {
  const noteText = String(payload.noteText || "").trim();
  const thread = Array.isArray(payload.thread)
    ? payload.thread.slice(-MAX_THREAD_TURNS).map((turn) => ({
        role: turn && turn.role === "ai" ? "ai" : "user",
        text: String((turn && turn.text) || "").slice(0, 600),
      }))
    : [];
  const interviewTitle = String(payload.interviewTitle || "");
  const interviewContext = String(payload.interviewContext || "").slice(0, MAX_CONTEXT_CHARS);

  const userPayload = {
    note: noteText,
    recent_thread: thread,
    interview_title: interviewTitle,
    interview_context: interviewContext,
  };

  const result = await callTextProvider(env, [
    { role: "system", content: NOTES_REPLY_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(userPayload) },
  ]);

  if (result && result.parsed && typeof result.parsed === "object" && result.parsed.reply) {
    return { reply: String(result.parsed.reply), source: result.providerName };
  }

  return { reply: fallbackNotesReply(noteText, interviewTitle), source: "fallback" };
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

  if (!String(payload.noteText || "").trim()) {
    return jsonResponse({ error: "noteText is required" }, 400);
  }

  try {
    const result = await getNotesReply(process.env, payload);
    return jsonResponse(result);
  } catch (error) {
    console.error("[ai-notes-reply] failed:", error);
    return jsonResponse({ error: String(error) }, 500);
  }
};

export const config = { path: "/api/ai-notes-reply", method: ["POST", "OPTIONS"] };
