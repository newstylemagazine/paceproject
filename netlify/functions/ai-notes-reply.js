import { callTextProvider } from "./_lib/providers.js";
import { NOTES_REPLY_SYSTEM_PROMPT } from "./_lib/prompts.js";
import { fallbackNotesReply } from "./_lib/fallback.js";
import { findMisattributions, findFabricatedQuotes, correctionMessage } from "./_lib/attribution.js";

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

  // Each speaker gets its own message, so the model sees the interview as a
  // document about someone else and the reader's notes as the reader's.
  // (It used to receive one JSON blob with both inside, and would sometimes
  // ask a reader about "your cheese business" because the interviewee had one.)
  const name = interviewTitle.split(",")[0] || "the interviewee";
  const messages = [
    { role: "system", content: NOTES_REPLY_SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `THE INTERVIEW BEING READ - about ${interviewTitle || "the interviewee"}. ` +
        `This is a different person. The reader did not write any of this:\n<<<\n${interviewContext}\n>>>`,
    },
    {
      role: "assistant",
      content: JSON.stringify({ reply: `Understood: that is ${name}'s story, not the reader's.` }),
    },
  ];
  for (const turn of thread) {
    if (!turn.text) continue;
    messages.push(
      turn.role === "ai"
        ? { role: "assistant", content: JSON.stringify({ reply: turn.text }) }
        : { role: "user", content: `THE READER'S NOTE: ${turn.text}` }
    );
  }
  messages.push({ role: "user", content: `THE READER'S NOTE (reply to this one): ${noteText}` });

  const readerText = [...thread.filter((t) => t.role !== "ai").map((t) => t.text), noteText].join(" ");
  const parse = (result) =>
    result && result.parsed && typeof result.parsed.reply === "string" ? result.parsed.reply.trim() : "";

  const sourceText = `${interviewTitle} ${interviewContext}`;
  const problems = (text) => ({
    borrowed: findMisattributions(text, readerText, sourceText),
    fabricated: findFabricatedQuotes(text, `${sourceText} ${readerText}`),
  });
  let result = await callTextProvider(env, messages);
  let reply = parse(result);
  if (reply) {
    const found = problems(reply);
    if (found.borrowed.length || found.fabricated.length) {
      console.warn("[ai-notes-reply] problems caught:", found);
      result = await callTextProvider(env, [
        ...messages,
        { role: "assistant", content: JSON.stringify({ reply }) },
        { role: "user", content: correctionMessage(found.borrowed, found.fabricated) },
      ]);
      reply = parse(result);
      if (reply) {
        const again = problems(reply);
        if (again.borrowed.length || again.fabricated.length) reply = "";
      }
    }
  }
  if (reply) {
    return { reply, source: result.providerName };
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
