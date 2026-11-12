import { callTextProvider, describeImage } from "./_lib/providers.js";

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

// When the turn includes a newly attached file (a document, or a photo
// that's been described by the vision model first), the reply engages
// with the file itself AND always points to one specific interview -
// the archive is the point of the tool, so every reply should open a door
// into it. The client sends a shortlist of matched interviews (voices);
// the model picks the one with the most real connection.
export const ATTACHMENT_SYSTEM_PROMPT = [
  "You're the voice of a tool built on TRaCE, an oral-history archive of people who did PhDs ",
  "talking about what happened next. Someone just shared a file (attachments: each has a name, ",
  "a kind - document or photo - and its text; for a photo the text is a description of what's ",
  "in it, starting with whatever writing was legible). They may have typed a line too (typed). ",
  "voices is a shortlist of real interview excerpts from the archive, each with an index, the ",
  "interviewee's name, the question they were asked, and what they said.\n\n",
  "Reply in at most three sentences, under 80 words, speaking to the person directly:\n",
  "1. Respond to the file itself. For a document, work out what kind it is and respond in ",
  "kind (craft and image for creative writing, the argument for an essay, a pattern or gap ",
  "for a CV) - name one concrete detail and say something true about it. For a photo, name ",
  "specific things you can see: book titles, authors, papers, notes. If a photo has nothing ",
  "legible (just a cluttered desk, a shelf, a room), be curious about what it shows of how ",
  "they work - how they organize (or don't), what piles up, where the work actually happens, ",
  "what's within reach.\n",
  "2. Always point to ONE interviewee from voices, by name, with one concrete detail from what ",
  "they actually said, and make the link to this person's file explicit. Choose the voice with ",
  "the most genuine connection; if none connects closely, choose the most interesting contrast ",
  "and say so honestly. Never invent anything an interviewee didn't say.\n",
  "3. End with one pithy question that ties the file, the interviewee, and their own research ",
  "or life together.\n\n",
  "Never summarize the whole file. Never guess at titles that aren't in the description. ",
  "Banned: praise inflation ('beautiful', 'powerful', 'stunning'), 'Thank you for sharing', ",
  "explaining the tool, therapist-speak, exclamation points.\n\n",
  'Return only valid JSON: {"question": "<your reply>", "voice": <index of the voice you chose>}',
].join("");

// The vision step, for photos. Transcribing legible text first is what
// lets the reply mention actual books and papers rather than "a desk".
export const PHOTO_READING_PROMPT = [
  "Someone shared this photo while reflecting on their research and life - often their desk, ",
  "shelves, or workspace. Write plain text, under 130 words, in two parts:\n",
  "Legible: transcribe every piece of writing you can actually read - book titles and authors ",
  "on spines and covers, titles or headings of papers, handwritten notes, what's on a screen. ",
  "Mark uncertain readings with (?). Never guess at text you can't read. If nothing is ",
  "legible, write 'Legible: nothing'.\n",
  "Scene: describe concretely what's there - objects, how ordered or cluttered it is, signs of ",
  "work in progress, anything personal. No interpretation of their feelings.",
].join("");

const MAX_VOICES = 6;
const MAX_IMAGE_DATA_URL_CHARS = 4_500_000;

const MAX_ATTACHMENT_CHARS = 6000;

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

  const attachments = Array.isArray(payload.attachments)
    ? payload.attachments.slice(0, 4).map((item) => ({
        name: String((item && item.name) || "").slice(0, 120),
        kind: item && item.kind === "photo" ? "photo" : "document",
        text: String((item && item.text) || "").slice(0, MAX_ATTACHMENT_CHARS),
      }))
    : [];
  const voices = Array.isArray(payload.voices)
    ? payload.voices.slice(0, MAX_VOICES).map((voice, index) => ({
        index,
        name: String((voice && voice.name) || "").slice(0, 160),
        asked: String((voice && voice.question) || "").slice(0, 300),
        said: String((voice && voice.excerpt) || "").slice(0, 900),
      }))
    : [];

  const result = attachments.length
    ? await callTextProvider(env, [
        { role: "system", content: ATTACHMENT_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify({ typed, attachments, voices, recent_thread: thread }) },
      ])
    : await callTextProvider(env, [
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
    const voice = Number.isInteger(result.parsed.voice) && result.parsed.voice >= 0 && result.parsed.voice < voices.length
      ? result.parsed.voice
      : 0;
    return { question, voice: voices.length ? voice : null, source: result.providerName };
  }
  if (attachments.length) {
    const name = attachments[0].name.replace(/\.[^.]+$/, "") || "that file";
    const readable = attachments.some((item) => item.text.trim());
    return {
      question: readable
        ? `What made you want to bring ${name} here - what is it circling that your research or your life is circling too?`
        : `${name} couldn't be read here. What is it, and why did you bring it?`,
      voice: voices.length ? 0 : null,
      source: "fallback",
    };
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
    // Step one for a photo: read it. The client then matches the
    // description against the archive and calls back with voices.
    if (typeof payload.describe === "string") {
      if (!payload.describe.startsWith("data:image/") || payload.describe.length > MAX_IMAGE_DATA_URL_CHARS) {
        return jsonResponse({ error: "Expected an image data URL under ~3MB" }, 400);
      }
      const raw = await describeImage(
        process.env,
        payload.describe,
        String(payload.name || "photo").slice(0, 120),
        PHOTO_READING_PROMPT
      );
      // Some vision models prepend their reasoning in <think> tags.
      const description = String(raw || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      return jsonResponse({ description });
    }
    return jsonResponse(await getOpener(process.env, payload));
  } catch (error) {
    console.error("[ai-opener] failed:", error);
    return jsonResponse({ error: String(error) }, 500);
  }
};

export const config = { path: "/api/ai-opener", method: ["POST", "OPTIONS"] };
