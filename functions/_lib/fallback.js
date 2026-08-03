import { sentenceSplit, pickSentences } from "./matching.js";

export function fallbackAboutPayload(text, recommendations) {
  const sentences = sentenceSplit(text);
  const threadsSource = pickSentences(
    text,
    "want|hope|worry|afraid|wonder|dream|stuck|torn|next|maybe",
    3
  );
  const headline = sentences.length ? sentences[0].slice(0, 90) : "Nothing written yet";

  const kindred = recommendations.slice(0, 3).map((rec) => ({
    title: rec.title || "A voice from the archive",
    why: "Their path crosses a few of the same words you just used.",
    quote: rec.snippet || "",
    url: rec.url || "#",
  }));

  return {
    mirror_headline: headline,
    reflection: sentences.length
      ? sentences.slice(0, 3).join(" ")
      : "Not much to work with yet - a few more specific sentences will surface a pattern.",
    threads: threadsSource.length
      ? threadsSource
      : [
          "What part of this haven't you said out loud yet?",
          "If nobody was watching, would you still choose this path?",
        ],
    kindred_voices: kindred,
    provocation: "Write more, and the pattern in your own path gets easier to see.",
  };
}

export function fallbackResonanceNote(excerptTitle, excerptText) {
  // Third-person, no "you", no question - stays about the interviewee, the
  // way the real AI-generated note does. This is only the rule-based
  // safety net for when no AI provider is reachable.
  const clipped = (excerptText || "").replace(/\s+/g, " ").trim().slice(0, 160);
  const name = String(excerptTitle || "").split(",")[0].trim();
  const who = name || "One voice in the archive";
  if (!clipped) {
    return `${who}'s story sits close to what was just written.`;
  }
  return `${who} described this: "${clipped}..." - a detail that sits close to what was just written.`;
}
