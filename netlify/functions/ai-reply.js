import { callTextProvider } from "./_lib/providers.js";
import { findMisattributions, correctionMessage } from "./_lib/attribution.js";

// Every reply on the home page comes from here: to a message, to an
// attached file, or both. It replaced a fixed template ("X was asked: '...'
// What's your own answer to that?") that never saw what the person wrote,
// so it answered "I'm not sure I want to finish" with a question about
// their current job, and could repeat itself word for word.
//
// The model gets the person's recent messages, any attachments, its own
// earlier replies, and a shortlist of interview excerpts - each in its own
// clearly labelled section, so it can't mistake an interviewee's words for
// the person's.

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
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

export const REPLY_SYSTEM_PROMPT = `You are the voice of Trace, a site where graduate students write about what's on their mind and get answered with voices from an oral-history archive.

THE ARCHIVE: interviews with people who completed PhDs (the TRaCE project at McGill and other Canadian universities), about what happened during and after. Everyone in it finished the degree; nobody in it left without one. Some entries are first-person interviews (question and answer). Others are profiles written ABOUT the person by the archive's editors, in the third person: for those, say "her profile says" or "according to his profile", never "she says".

YOU WILL RECEIVE, IN SEPARATE LABELLED SECTIONS:
- THE STUDENT'S MESSAGES: the only words the student wrote. The last one is what you are replying to.
- ATTACHMENTS: files or photo descriptions the student chose to share.
- VOICES: excerpts about OTHER PEOPLE. Nothing in a voice is about the student. Never say "you" or "your" about anything that appears only in a voice.
- YOUR EARLIER REPLIES: what you've already said in this conversation.

WRITE A REPLY of 2 to 4 sentences, under 90 words, speaking to the student directly:
1. If the student asked you something, answer it first, plainly and honestly, from the voices or from what you know about the archive. If the archive can't answer it, say so.
2. Respond to what they actually said, in their terms. If they are dry or sardonic, you can be dry back; never wounded, never cheerful.
3. Bring in ONE voice by name. Say in a short clause why this person (what they share with the student: field, situation, a decision they faced). Give one concrete detail that is actually in that voice's text, quoted briefly if it helps.
4. End with a question only if it opens something real. At most one question. Many replies should end without one.

NEVER: repeat a detail or quote you already used in YOUR EARLIER REPLIES (the same person is fine, the same detail is not); refer to the student in the third person ("the writer", "the user"); praise ("clever", "powerful", "great point"); use words like scaffolding, journey, navigate, resonate, unpack, holding space, leverage; use exclamation points; misspell names or references.

EXAMPLES OF THE VOICE:
Student: "My funding ends in May and my advisor keeps saying I'm close."
Good: "'Close' is doing a lot of work in that sentence. Thomas Collombat, a political scientist, was the first in his cohort to finish and still says 'you always wish that you would do it faster', so even the fast ones felt late. What would 'done' have to look like for you to believe it?"

Student: "Is there anyone in here who quit?"
Good: "No. Everyone in this archive finished, which is a real blind spot when the question is whether to. The nearest is Michelle La Flamme, who writes about the 'serious practical and financial constraints' of those years; her account is worth reading for what it was like before the ending was known."

Bad: "That framing echoes the writer's anxiety about funding, highlighting how both see external support as the scaffolding for intellectual risk. Will the next grant become the catalyst?"

Return only valid JSON: {"reply": "...", "voice": <index of the voice you used, or null>}`;

const MAX_MESSAGES = 6;
const MAX_VOICES = 6;

function clip(text, max) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function buildPrompt(payload) {
  const messages = (Array.isArray(payload.messages) ? payload.messages : [])
    .slice(-MAX_MESSAGES)
    .map((m) => clip(m, 1200))
    .filter(Boolean);
  const earlier = (Array.isArray(payload.earlierReplies) ? payload.earlierReplies : [])
    .slice(-4)
    .map((r) => clip(r, 500))
    .filter(Boolean);
  const attachments = (Array.isArray(payload.attachments) ? payload.attachments : []).slice(0, 4).map((a) => ({
    name: clip(a && a.name, 120),
    kind: a && a.kind === "photo" ? "photo (description of what's in it)" : "document",
    text: clip(a && a.text, 5000),
  }));
  const voices = (Array.isArray(payload.voices) ? payload.voices : []).slice(0, MAX_VOICES).map((v) => ({
    name: clip(v && v.name, 160),
    form: v && v.form === "profile" ? "profile written about them by the archive's editors" : "first-person interview",
    asked: clip(v && v.question, 300),
    text: clip(v && v.excerpt, 900),
  }));

  const sections = [];
  sections.push(
    "THE STUDENT'S MESSAGES (oldest first; reply to the last one):\n" +
      (messages.length ? messages.map((m, i) => `[${i + 1}] ${m}`).join("\n") : "(none - they only attached something)")
  );
  if (attachments.length) {
    sections.push(
      "ATTACHMENTS THE STUDENT SHARED:\n" +
        attachments
          .map((a) => `=== ${a.name} - ${a.kind} ===\n${a.text || "(could not be read)"}`)
          .join("\n\n")
    );
  }
  if (earlier.length) {
    sections.push("YOUR EARLIER REPLIES (don't reuse their details):\n" + earlier.map((r) => `- ${r}`).join("\n"));
  }
  sections.push(
    "VOICES FROM THE ARCHIVE (other people - NOT the student):\n" +
      (voices.length
        ? voices
            .map(
              (v, i) =>
                `[${i}] ${v.name} (${v.form})` + (v.asked ? `\nAsked: "${v.asked}"` : "") + `\nText: "${v.text}"`
            )
            .join("\n\n")
        : "(none matched)")
  );
  return {
    prompt: sections.join("\n\n"),
    studentText: [...messages, ...attachments.map((a) => a.text)].join(" "),
    voicesText: voices.map((v) => `${v.name} ${v.asked} ${v.text}`).join(" "),
    voiceCount: voices.length,
  };
}

function parseReply(result, voiceCount) {
  const parsed = result && result.parsed;
  const reply = parsed && typeof parsed.reply === "string" ? parsed.reply.trim() : "";
  const voice = parsed && Number.isInteger(parsed.voice) && parsed.voice >= 0 && parsed.voice < voiceCount ? parsed.voice : null;
  return { reply, voice };
}

export async function getReply(env, payload) {
  const { prompt, studentText, voicesText, voiceCount } = buildPrompt(payload);
  const messages = [
    { role: "system", content: REPLY_SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ];

  let result = await callTextProvider(env, messages);
  let { reply, voice } = parseReply(result, voiceCount);
  if (!reply) return { reply: "", voice: null, source: "none" };

  // Second line of defence: if the reply still puts a voice's details in
  // the student's mouth, ask for one rewrite; if that fails too, return
  // nothing and let the page fall back to a plain, safe line.
  const borrowed = findMisattributions(reply, studentText, voicesText);
  if (borrowed.length) {
    console.warn("[ai-reply] misattribution caught:", borrowed);
    result = await callTextProvider(env, [
      ...messages,
      { role: "assistant", content: JSON.stringify({ reply, voice }) },
      { role: "user", content: correctionMessage(borrowed) },
    ]);
    ({ reply, voice } = parseReply(result, voiceCount));
    if (!reply || findMisattributions(reply, studentText, voicesText).length) {
      return { reply: "", voice: null, source: "rejected" };
    }
  }
  return { reply, voice, source: result.providerName };
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
    return jsonResponse(await getReply(process.env, payload));
  } catch (error) {
    console.error("[ai-reply] failed:", error);
    return jsonResponse({ error: String(error) }, 500);
  }
};

export const config = { path: "/api/ai-reply", method: ["POST", "OPTIONS"] };
