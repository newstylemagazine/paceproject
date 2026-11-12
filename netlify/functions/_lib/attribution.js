// Guards against the model attributing an interviewee's life to the person
// using the site - e.g. asking a reader about "your cheese business" because
// the interview they were reading was about one. Prompts alone don't stop
// this reliably, so every reply is checked after it's written.
//
// The check: wherever the reply says "you"/"your" about something, look at
// the next few words. A distinctive word there that appears in the
// interview/voice text but nowhere in anything the person wrote means the
// reply is putting someone else's details in their mouth.

// Generic words an interview and a student both naturally share; "your
// advisor" or "your research" is fine even if the student never typed them.
const GENERIC = new Set([
  "advisor", "adviser", "supervisor", "supervisors", "degree", "degrees", "thesis", "dissertation",
  "research", "work", "working", "career", "careers", "program", "programme", "field", "fields",
  "path", "paths", "life", "time", "years", "year", "family", "future", "writing", "question",
  "questions", "story", "stories", "interview", "archive", "own", "answer", "next", "first",
  "sense", "experience", "experiences", "studies", "study", "doctorate", "phd", "graduate",
  "school", "university", "academia", "academic", "job", "jobs", "plan", "plans", "goals",
  "goal", "choice", "choices", "decision", "decisions", "reason", "reasons", "part", "thing",
  "things", "point", "moment", "moments", "way", "ways", "days", "day", "place", "people",
  "self", "mind", "voice", "words", "note", "notes", "reading", "draft", "chapter", "project",
  "projects", "funding", "money", "colleagues", "cohort", "department", "field's", "feel",
  "feeling", "think", "thinking", "want", "wanted", "need", "might", "would", "could", "should",
  "about", "with", "from", "that", "this", "what", "when", "where", "which", "there", "their",
  "have", "been", "were", "still", "really", "just", "also", "more", "most", "some", "much",
  "very", "into", "than", "then", "them", "they", "your", "yours", "yourself", "you're",
  "you've", "you'd", "you'll", "does", "doing", "done", "make", "made", "take", "took", "keep",
  "kept", "seem", "seems", "sound", "sounds", "like", "know", "knew", "mean", "means", "said",
  "says", "say", "tell", "told", "describe", "described", "mention", "mentioned", "wrote",
  "write", "shared", "share", "looking", "look", "back", "ahead", "today", "now", "right",
  "kind", "sort", "lot", "bit", "whole", "same", "other", "another", "each", "every", "both",
]);

function wordsOf(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9'\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function stem(word) {
  return word.replace(/'s$/, "").replace(/(ies|es|s|ing|ed)$/, "");
}

/**
 * Returns the borrowed words (empty array = clean).
 * studentText: everything the person wrote or shared themselves.
 * otherText: the interview / voices text the reply may draw on.
 */
export function findMisattributions(reply, studentText, otherText) {
  const student = new Set(wordsOf(studentText).map(stem));
  const other = new Set(wordsOf(otherText).map(stem));
  const tokens = wordsOf(reply);
  const flagged = new Set();

  tokens.forEach((token, index) => {
    if (!/^(you|your|you're|you've|you'd|yours|yourself)$/.test(token)) return;
    for (const next of tokens.slice(index + 1, index + 6)) {
      if (next.length < 4 || GENERIC.has(next)) continue;
      const key = stem(next);
      if (other.has(key) && !student.has(key)) flagged.add(next);
    }
  });
  return [...flagged];
}

export function correctionMessage(borrowed) {
  return (
    `Your draft attributed something to the person that only appears in the interview text: ` +
    `${borrowed.map((w) => `"${w}"`).join(", ")}. Those are the interviewee's details, not theirs. ` +
    `Rewrite the reply so that "you" and "your" refer only to things the person actually wrote, ` +
    `and talk about the interviewee by name or as "she"/"he"/"they". Same JSON format.`
  );
}
