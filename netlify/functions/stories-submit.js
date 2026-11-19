// POST /api/stories/submit: a public "Share your story" submission.
// Saved as "pending"; nothing is shown anywhere until a reviewer approves it.
import { callTextProvider } from "./_lib/providers.js";
import {
  CONSENT_VERSION, DISPLAY, OUTCOMES, QUESTIONS, clean, hashIp, json, newId, storiesStore,
} from "./_lib/stories.js";

const MAX_PER_DAY = 5;

const CHECK_PROMPT = `You screen stories submitted to an archive where people describe their experience of graduate school, for a human reviewer. Do not judge quality or opinions. Flag only:
- "names_others": the story names or clearly identifies a private individual other than the author (a supervisor, classmate, family member). Public institutions are fine.
- "contact_details": phone numbers, emails, home addresses, social handles.
- "off_topic": the text is not about the author's own graduate studies or career (spam, ads, tests, gibberish).
- "abusive": harassment, hate, threats or sexual content.
- "distress": the author seems to be in crisis or at risk of harm.
Return only JSON: {"flags": [list of the flag names that apply], "note": "one short sentence for the reviewer, or empty"}`;

async function screen(answers) {
  const text = answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n\n").slice(0, 8000);
  const flags = new Set();
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(text) || /(\+?\d[\s().-]?){9,}/.test(text)) flags.add("contact_details");
  let note = "";
  try {
    const result = await callTextProvider(process.env, [
      { role: "system", content: CHECK_PROMPT },
      { role: "user", content: text },
    ]);
    const parsed = result && result.parsed;
    if (parsed && Array.isArray(parsed.flags)) {
      for (const f of parsed.flags) {
        if (["names_others", "contact_details", "off_topic", "abusive", "distress"].includes(f)) flags.add(f);
      }
      note = clean(parsed.note, 300);
    }
  } catch (error) {
    console.error("[stories-submit] screening failed:", error.message);
    note = "Automatic screening was unavailable; please read carefully.";
  }
  return { flags: [...flags], note };
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }

  // Honeypot: a hidden field people never see. Bots fill it in.
  if (clean(body.website, 200)) return json({ ok: true });

  const answers = (Array.isArray(body.answers) ? body.answers : [])
    .map((a) => ({ question: clean(a && a.question, 300), answer: clean(a && a.answer, 6000) }))
    .filter((a) => a.answer && QUESTIONS.includes(a.question))
    .slice(0, QUESTIONS.length);
  const words = answers.reduce((n, a) => n + a.answer.split(/\s+/).length, 0);

  if (!answers.length || words < 25) return json({ error: "Please answer at least one question in a few sentences." }, 400);
  if (body.consent !== true) return json({ error: "Please confirm the consent statement so we can use your story." }, 400);
  const outcome = Object.hasOwn(OUTCOMES, body.outcome) ? body.outcome : "";
  const display = Object.hasOwn(DISPLAY, body.display) ? body.display : "anonymous";
  const email = clean(body.email, 200);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "That email address doesn't look right." }, 400);

  const store = storiesStore();
  const ipKey = `ratelimit/${hashIp(req)}`;
  const seen = (await store.get(ipKey, { type: "json" })) || { count: 0 };
  if (seen.count >= MAX_PER_DAY) return json({ error: "Too many submissions today. Please try again tomorrow." }, 429);
  await store.setJSON(ipKey, { count: seen.count + 1 });

  const story = {
    id: newId(),
    status: "pending",
    source: "public",
    submittedAt: new Date().toISOString(),
    name: clean(body.name, 120),
    email,
    university: clean(body.university, 160),
    program: clean(body.program, 160),
    years: clean(body.years, 40),
    work: clean(body.work, 200),
    outcome,
    display,
    followup: body.followup === true,
    consent: { given: true, version: CONSENT_VERSION, at: new Date().toISOString() },
    answers,
  };
  story.screening = await screen(answers);

  await store.setJSON(`story/${story.id}`, story);
  return json({ ok: true, id: story.id });
};

export const config = { path: "/api/stories/submit", method: ["POST"] };
