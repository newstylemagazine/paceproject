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

// Rule-based safety net for the notes conversation when no AI provider is
// reachable. Can't actually engage with a specific reference the way the
// real model can, but tries to at least anchor the question on whatever
// proper noun the person just typed, rather than defaulting to something
// completely generic every time.
export function fallbackNotesReply(noteText, interviewTitle) {
  const trimmed = (noteText || "").trim();
  const who = String(interviewTitle || "").split(",")[0].trim() || "the person you're reading";

  if (!trimmed) {
    return "What's the detail here that you keep circling back to?";
  }

  // A blocklist of common sentence-initial words ("This", "That"...) turned
  // out to be an endless whack-a-mole - a persona test caught "Sure, but
  // this AI is just going to tell me..." producing "You mentioned Sure",
  // because "Sure" wasn't on the list. Sentence-initial capitalization is
  // grammatically mandatory in English regardless of whether the word is a
  // proper noun, so it's not a usable signal on its own - strip the first
  // word of every sentence before searching, instead of trying to
  // enumerate every possible non-proper-noun opener.
  const withoutSentenceStarts = trimmed.replace(/(^|[.!?]\s+)[A-Z][a-zA-Z'-]*/g, (_match, boundary) => boundary);
  const properNoun = withoutSentenceStarts.match(/\b[A-Z][a-zA-Z'-]{2,}(?:\s+[A-Z][a-zA-Z'-]{2,})?\b/);
  if (properNoun) {
    return `You mentioned ${properNoun[0]} - what's the specific detail or idea there that made you think of ${who}?`;
  }

  return `Say more about that - what's underneath it, and how does it sit next to ${who}?`;
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
