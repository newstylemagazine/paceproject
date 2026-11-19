// Shared helpers for community-submitted stories ("Share your story").
// Submissions live in Netlify Blobs, one JSON record per story, under
// the key "story/<id>". Nothing here is public until a reviewer approves it.
import { getStore } from "@netlify/blobs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const CONSENT_VERSION = "2026-11-18";

export const QUESTIONS = [
  "What made you decide to start graduate school?",
  "How would you describe your overall experience of the degree?",
  "Was there a moment you thought about leaving? What happened?",
  "How was your relationship with your supervisor?",
  "How did you pay for your degree, and how did money shape your choices?",
  "What do you wish you had known before you started?",
  "What do you do now, and how did you get there?",
  "What skills from your degree turned out to matter most?",
  "Did you feel you belonged in your department? Why or why not?",
  "How did graduate school affect your health, family or personal life?",
  "What was the job search like after you finished or left?",
  "If you left before finishing, how did you make that decision, and how do you see it now?",
  "What advice would you give someone in the middle of their degree right now?",
];

export const OUTCOMES = {
  finished: "Finished the degree",
  left: "Left before finishing",
  switched: "Switched programs",
  current: "Still in the program",
};

export const DISPLAY = {
  name: "With my name",
  first: "First name and field only",
  anonymous: "Anonymously",
};

export function storiesStore() {
  return getStore({ name: "stories", consistency: "strong" });
}

export function newId() {
  return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

export function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extraHeaders },
  });
}

export function clean(value, max) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .trim()
    .slice(0, max);
}

export function hashIp(req) {
  const ip = (req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  const day = new Date().toISOString().slice(0, 10);
  return createHash("sha256").update(`${ip}|${day}|trace-stories`).digest("hex").slice(0, 24);
}

// Reviewer access: the request must carry the password set in the
// REVIEW_KEY environment variable (Netlify > Site configuration > Environment variables).
export function reviewerAllowed(req) {
  const expected = (process.env.REVIEW_KEY || "").trim();
  if (!expected) return { ok: false, reason: "not-configured" };
  const given = (req.headers.get("x-review-key") || "").trim();
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b) && given.length > 0 ? { ok: true } : { ok: false, reason: "wrong-key" };
}

// How the person's name appears publicly, per their choice.
export function publicName(story) {
  const program = story.program || "Graduate studies";
  if (story.display === "name" && story.name) return `${story.name}, ${program}`;
  if (story.display === "first" && story.name) return `${story.name.split(/\s+/)[0]}, ${program}`;
  return `Anonymous, ${program}`;
}

// Approved story -> the same shape as the archive's interviews.json entries.
export function toInterview(story) {
  const slug = `story-${story.id}`;
  const title = publicName(story);
  const intro = [OUTCOMES[story.outcome], story.university, story.years].filter(Boolean).join(" · ");
  const qa = story.answers.map((a) => ({ question: `Q: ${a.question}`, answer: a.answer }));
  return {
    slug,
    url: `/site/transcript.html?source=community&slug=${slug}`,
    title,
    published: (story.reviewedAt || story.submittedAt || "").slice(0, 10),
    tags: [OUTCOMES[story.outcome], story.university].filter(Boolean),
    intro,
    qa_pairs: qa,
    audio_clips: [],
    transcript_text: [intro, ...qa.map((q) => `${q.question}\n\n${q.answer}`)].filter(Boolean).join("\n\n"),
    community: true,
  };
}

export function toChunks(story) {
  const interview = toInterview(story);
  return interview.qa_pairs.map((qa, i) => ({
    id: `${interview.slug}#qa-${i + 1}`,
    slug: interview.slug,
    title: interview.title,
    url: interview.url,
    published: interview.published,
    tags: interview.tags,
    question: qa.question,
    answer: qa.answer,
    text: `${qa.question}\n\n${qa.answer}`,
  }));
}

export async function allStories(store) {
  const { blobs } = await store.list({ prefix: "story/" });
  const records = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
  return records.filter(Boolean).sort((a, b) => (b.submittedAt || "").localeCompare(a.submittedAt || ""));
}
