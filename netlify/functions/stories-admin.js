// /api/stories/admin: the review queue. Every request needs the reviewer
// password (REVIEW_KEY) in the X-Review-Key header.
//   GET                    -> all stories, newest first
//   POST {id, action, ...} -> approve | reject | restore | delete | edit
import { allStories, clean, json, reviewerAllowed, storiesStore } from "./_lib/stories.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async (req) => {
  const access = reviewerAllowed(req);
  if (!access.ok) {
    if (access.reason === "not-configured") {
      return json({ error: "The review queue isn't set up yet: add a REVIEW_KEY environment variable in Netlify." }, 503);
    }
    await sleep(800); // slows down password guessing
    return json({ error: "Wrong password." }, 401);
  }

  const store = storiesStore();
  if (req.method === "GET") {
    return json({ stories: await allStories(store) });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
  const id = clean(body.id, 80);
  const key = `story/${id}`;
  const story = await store.get(key, { type: "json" });
  if (!story) return json({ error: "Story not found." }, 404);

  const now = new Date().toISOString();
  switch (body.action) {
    case "approve":
      Object.assign(story, { status: "approved", reviewedAt: now, reviewNote: clean(body.note, 500) });
      break;
    case "reject":
      Object.assign(story, { status: "rejected", reviewedAt: now, reviewNote: clean(body.note, 500) });
      break;
    case "restore":
      Object.assign(story, { status: "pending", reviewedAt: null });
      break;
    case "edit":
      if (Array.isArray(body.answers)) {
        story.answers = story.answers.map((a, i) => ({ ...a, answer: clean(body.answers[i] ?? a.answer, 6000) }));
        story.editedAt = now;
      }
      break;
    case "delete":
      await store.delete(key);
      return json({ ok: true, deleted: id });
    default:
      return json({ error: "Unknown action." }, 400);
  }
  await store.setJSON(key, story);
  return json({ ok: true, story });
};

export const config = { path: "/api/stories/admin", method: ["GET", "POST"] };
