// Review queue. The password stays in this browser tab only (sessionStorage)
// and is sent with each request; the server checks it against REVIEW_KEY.
const KEY_STORE = "trace_review_key";
const FLAG_LABELS = {
  names_others: "Names another person", contact_details: "Contact details", off_topic: "Off topic",
  abusive: "Abusive", distress: "Author may be in distress",
};
const OUTCOMES = { finished: "Finished", left: "Left before finishing", switched: "Switched programs", current: "Still in it" };
const DISPLAY = { name: "With name", first: "First name and field", anonymous: "Anonymous" };

let stories = [];
let filter = "pending";
const listNode = document.getElementById("list");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(method, body) {
  const response = await fetch("/api/stories/admin", {
    method,
    headers: { "Content-Type": "application/json", "X-Review-Key": sessionStorage.getItem(KEY_STORE) || "" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function counts() {
  const by = { pending: 0, approved: 0, rejected: 0 };
  stories.forEach((s) => { by[s.status] = (by[s.status] || 0) + 1; });
  document.querySelectorAll(".tabs button").forEach((b) => {
    const base = { pending: "Needs review", approved: "Published", rejected: "Declined" }[b.dataset.status];
    b.textContent = `${base} · ${by[b.dataset.status] || 0}`;
  });
}

function render() {
  counts();
  const shown = stories.filter((s) => s.status === filter);
  if (!shown.length) {
    listNode.innerHTML = `<p class="empty">Nothing here.</p>`;
    return;
  }
  listNode.innerHTML = shown.map((s) => {
    const flags = (s.screening && s.screening.flags) || [];
    const first = (s.answers[0] && s.answers[0].answer) || "";
    const badges = [
      `<span class="badge b-${s.status}">${{ pending: "Needs review", approved: "Published", rejected: "Declined" }[s.status]}</span>`,
      ...flags.map((f) => `<span class="badge b-flag">${esc(FLAG_LABELS[f] || f)}</span>`),
    ].join("");
    const qa = s.answers.map((a, i) => `<div class="qa"><h4>${esc(a.question)}</h4><textarea data-i="${i}">${esc(a.answer)}</textarea></div>`).join("");
    const actions = s.status === "pending"
      ? `<button class="btn small primary" data-act="approve">Approve and publish</button><input placeholder="Note (optional, kept with the story)" data-note /><button class="btn small" data-act="edit">Save edits</button><button class="btn small danger" data-act="reject">Decline</button>`
      : `<button class="btn small" data-act="restore">Move back to review</button><button class="btn small" data-act="edit">Save edits</button><button class="btn small danger" data-act="delete">Delete permanently</button>`;
    return `<article class="story" data-id="${esc(s.id)}">
      <div class="story-head" tabindex="0" role="button" aria-expanded="false">
        <div><div class="who">${esc(s.name || "No name given")}</div>
          <div class="meta">${esc([s.program, s.university, OUTCOMES[s.outcome], new Date(s.submittedAt).toLocaleDateString()].filter(Boolean).join(" · "))}</div>
          <div class="excerpt">“${esc(first.slice(0, 160))}${first.length > 160 ? "…" : ""}”</div></div>
        <div class="badges">${badges}</div>
      </div>
      <div class="story-body" hidden>
        <dl>
          <dt>Shows as</dt><dd>${esc(DISPLAY[s.display] || s.display)}</dd>
          <dt>Email</dt><dd>${s.email ? `<a href="mailto:${esc(s.email)}">${esc(s.email)}</a>` : "Not given"}</dd>
          <dt>Years</dt><dd>${esc(s.years || "Not given")}</dd>
          <dt>Now</dt><dd>${esc(s.work || "Not given")}</dd>
          <dt>Follow-ups</dt><dd>${s.followup ? "Open to a student's question" : "No"}</dd>
          <dt>Consent</dt><dd>${s.consent && s.consent.given ? `Given (${esc(s.consent.version)})` : "Missing"}</dd>
          ${s.screening && s.screening.note ? `<dt>Screening</dt><dd>${esc(s.screening.note)}</dd>` : ""}
          ${s.reviewNote ? `<dt>Review note</dt><dd>${esc(s.reviewNote)}</dd>` : ""}
        </dl>
        ${qa}
        <div class="row-actions">${actions}</div>
      </div>
    </article>`;
  }).join("");
}

listNode.addEventListener("click", async (event) => {
  const head = event.target.closest(".story-head");
  if (head) {
    const body = head.nextElementSibling;
    body.hidden = !body.hidden;
    head.setAttribute("aria-expanded", String(!body.hidden));
    return;
  }
  const btn = event.target.closest("[data-act]");
  if (!btn) return;
  const card = btn.closest(".story");
  const act = btn.dataset.act;
  if (act === "delete" && !window.confirm("Delete this story permanently? This can't be undone.")) return;
  const payload = { id: card.dataset.id, action: act };
  const note = card.querySelector("[data-note]");
  if (note) payload.note = note.value;
  if (act === "edit" || act === "approve") {
    const edits = [...card.querySelectorAll("textarea[data-i]")].map((t) => t.value);
    if (act === "approve") await api("POST", { id: card.dataset.id, action: "edit", answers: edits });
    else payload.answers = edits;
  }
  btn.disabled = true;
  try {
    await api("POST", payload);
    await load();
  } catch (error) {
    alert(error.message);
    btn.disabled = false;
  }
});
listNode.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.classList.contains("story-head")) e.target.click(); });

document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
  filter = b.dataset.status;
  document.querySelectorAll(".tabs button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  render();
}));

async function load() {
  const data = await api("GET");
  stories = data.stories || [];
  render();
}

function showQueue(on) {
  document.getElementById("loginView").hidden = on;
  document.getElementById("queueView").hidden = !on;
  document.getElementById("signOut").hidden = !on;
}

document.getElementById("loginView").addEventListener("submit", async (event) => {
  event.preventDefault();
  const err = document.getElementById("loginError");
  err.hidden = true;
  sessionStorage.setItem(KEY_STORE, document.getElementById("password").value);
  try {
    await load();
    showQueue(true);
  } catch (error) {
    sessionStorage.removeItem(KEY_STORE);
    err.textContent = error.message;
    err.hidden = false;
  }
});
document.getElementById("signOut").addEventListener("click", () => {
  sessionStorage.removeItem(KEY_STORE);
  showQueue(false);
});

if (sessionStorage.getItem(KEY_STORE)) {
  load().then(() => showQueue(true)).catch(() => sessionStorage.removeItem(KEY_STORE));
}
