import { callTextProvider } from "./_lib/providers.js";

// When someone types "testing", "hi", a keyboard mash - anything with
// nothing the archive can match against - the home page asks this
// endpoint for one short, thoughtful question about their research or
// life instead of surfacing a random interview that happens to contain
// the word "testing". The aim is to get them writing something real,
// which is what makes the archive (and the interview reader) useful.

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

export const OPENER_SYSTEM_PROMPT = [
  "You're the opening voice of a tool built on TRaCE, an oral-history archive of people who ",
  "did PhDs talking about what happened next: academic and non-academic careers, supervisors, ",
  "funding, burnout, family, leaving or staying, what they'd tell their younger selves. ",
  "Whatever someone writes gets matched to these interviews.\n\n",
  "The person just typed something with nothing in it to match yet (typed) - a test, a ",
  "greeting, a keyboard mash, a shrug. Ask ONE pithy, thoughtful question that gets them to ",
  "write something real about their research or their life - the kind of answer that would ",
  "surface a kindred voice in the archive.\n\n",
  "Rules: second person; one question; under 22 words. Concrete and a little unexpected - it ",
  "should feel like it came from someone curious about them, not a form. Banned: small talk ",
  "('How are you?', 'What brings you here?'), 'Tell me about yourself', therapist-speak, ",
  "corporate words, exclamation points. Don't comment on what they typed, don't say 'test', ",
  "don't explain the tool, no preamble.\n\n",
  "If recent_thread shows things they've already said, build on those instead of starting ",
  "over. Never repeat the angle of anything in previous_questions.\n\n",
  'Return only valid JSON: {"question": "..."}',
].join("");

export const OPENER_FALLBACK_QUESTIONS = [
  "What does your research actually ask - the version you'd never put in a grant application?",
  "When did you last lose track of time working? What were you doing?",
  "Who do you call when the work goes badly, and what do you tell them?",
  "What part of your degree would you do again, even unpaid?",
  "If your program ended tomorrow, what would you miss first?",
  "What did you think academia would be like before you started? What turned out different?",
  "What's a skill you've picked up that never shows up on your CV?",
  "Who outside the university really understands what you do all day?",
  "What decision about your career are you putting off right now?",
  "What do you study, and what got you hooked on it in the first place?",
];

function fallbackOpener(previousQuestions) {
  const used = new Set(previousQuestions);
  const fresh = OPENER_FALLBACK_QUESTIONS.filter((question) => !used.has(question));
  const pool = fresh.length ? fresh : OPENER_FALLBACK_QUESTIONS;
  return pool[Math.floor(Math.random() * pool.length)];
}

async function getOpener(env, payload) {
  const typed = String(payload.typed || "").trim().slice(0, 200);
  const thread = Array.isArray(payload.thread)
    ? payload.thread.slice(-MAX_THREAD_TURNS).map((turn) => ({
        role: turn && turn.role === "ai" ? "ai" : "user",
        text: String((turn && turn.text) || "").slice(0, 400),
      }))
    : [];
  const previousQuestions = Array.isArray(payload.previousQuestions)
    ? payload.previousQuestions.slice(-8).map((q) => String(q || "").slice(0, 200))
    : [];

  const result = await callTextProvider(env, [
    { role: "system", content: OPENER_SYSTEM_PROMPT },
    {
      role: "user",
      content: JSON.stringify({ typed, recent_thread: thread, previous_questions: previousQuestions }),
    },
  ]);

  const question = result && result.parsed && typeof result.parsed.question === "string"
    ? result.parsed.question.trim()
    : "";
  if (question) {
    return { question, source: result.providerName };
  }
  return { question: fallbackOpener(previousQuestions), source: "fallback" };
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
    return jsonResponse(await getOpener(process.env, payload));
  } catch (error) {
    console.error("[ai-opener] failed:", error);
    return jsonResponse({ error: String(error) }, 500);
  }
};

export const config = { path: "/api/ai-opener", method: ["POST", "OPTIONS"] };
