// GET /api/stories?format=chunks|interviews: approved community stories, in
// the same formats as the archive's data files, so the site can treat them
// as one more collection. Emails and anything not approved never leave here.
import { allStories, storiesStore, toChunks, toInterview } from "./_lib/stories.js";

export default async (req) => {
  const format = new URL(req.url).searchParams.get("format") || "interviews";
  let approved = [];
  try {
    approved = (await allStories(storiesStore())).filter((s) => s.status === "approved");
  } catch (error) {
    console.error("[stories] could not read store:", error.message);
  }
  const headers = { "Cache-Control": "public, max-age=60" };
  if (format === "chunks") {
    const lines = approved.flatMap(toChunks).map((c) => JSON.stringify(c)).join("\n");
    return new Response(lines, { headers: { ...headers, "Content-Type": "application/x-ndjson; charset=utf-8" } });
  }
  const interviews = approved.map(toInterview);
  return new Response(
    JSON.stringify({ source: "Trace community stories", interview_count: interviews.length, interviews }),
    { headers: { ...headers, "Content-Type": "application/json" } }
  );
};

export const config = { path: "/api/stories", method: ["GET"] };
