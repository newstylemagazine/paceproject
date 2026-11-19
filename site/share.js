// "Share your story": public submissions, held for review.
const QUESTIONS = [
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
const STARTING = [0, 2, 6];

// Dictation: the browser's built-in speech recognition (Chrome, Edge, Safari).
// Where it isn't available (Firefox, some in-app browsers) the button is hidden.
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let activeDictation = null;

function stopDictation() {
  if (activeDictation) activeDictation.stop();
}

function startDictation(textarea, button) {
  if (activeDictation) {
    const same = activeDictation.button === button;
    stopDictation();
    if (same) return;
  }
  const rec = new Recognition();
  rec.lang = document.documentElement.lang === "fr" ? "fr-CA" : navigator.language || "en-CA";
  rec.continuous = true;
  rec.interimResults = true;
  const before = textarea.value.replace(/\s*$/, "");
  let finalText = "";
  const label = button.querySelector(".dictate-label");

  rec.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const piece = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalText += piece;
      else interim += piece;
    }
    const spoken = (finalText + interim).trim();
    textarea.value = [before, spoken].filter(Boolean).join(before ? " " : "");
  };
  rec.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      label.textContent = "Microphone blocked";
    }
  };
  rec.onend = () => {
    button.classList.remove("listening");
    button.setAttribute("aria-pressed", "false");
    if (label.textContent !== "Microphone blocked") label.textContent = "Dictate";
    activeDictation = null;
  };
  rec.button = button;
  activeDictation = rec;
  button.classList.add("listening");
  button.setAttribute("aria-pressed", "true");
  label.textContent = "Listening… tap to stop";
  rec.start();
}

const answersNode = document.getElementById("answers");
const addSelect = document.getElementById("addQuestion");
const form = document.getElementById("shareForm");
const errorNode = document.getElementById("formError");
const submitBtn = document.getElementById("submitBtn");

function shownQuestions() {
  return [...answersNode.querySelectorAll(".answer")].map((n) => n.dataset.question);
}

function refreshSelect() {
  const shown = new Set(shownQuestions());
  const left = QUESTIONS.filter((q) => !shown.has(q));
  addSelect.innerHTML = left.length
    ? `<option value="">Choose another question (${left.length} more)…</option>` + left.map((q) => `<option></option>`).join("")
    : `<option value="">You've added every question</option>`;
  left.forEach((q, i) => { addSelect.options[i + 1].value = q; addSelect.options[i + 1].textContent = q; });
}

function addAnswer(question, focus = false) {
  const box = document.createElement("div");
  box.className = "answer";
  box.dataset.question = question;
  const id = `a${Math.random().toString(36).slice(2, 8)}`;
  box.innerHTML = `<label class="q" for="${id}"></label><textarea id="${id}" maxlength="6000" placeholder="Write here…"></textarea><div class="answer-bar"><button type="button" class="dictate" aria-pressed="false" hidden><span class="mic" aria-hidden="true"></span><span class="dictate-label">Dictate</span></button></div><button type="button" class="remove" aria-label="Remove this question">×</button>`;
  box.querySelector(".q").textContent = question;
  box.querySelector(".remove").addEventListener("click", () => { stopDictation(); box.remove(); refreshSelect(); });
  const dictate = box.querySelector(".dictate");
  if (Recognition) {
    dictate.hidden = false;
    dictate.addEventListener("click", () => startDictation(box.querySelector("textarea"), dictate));
  }
  answersNode.appendChild(box);
  refreshSelect();
  if (focus) box.querySelector("textarea").focus();
}

STARTING.forEach((i) => addAnswer(QUESTIONS[i]));
document.getElementById("addQuestionBtn").addEventListener("click", () => {
  if (addSelect.value) addAnswer(addSelect.value, true);
});

function showError(message) {
  errorNode.textContent = message;
  errorNode.hidden = false;
  errorNode.scrollIntoView({ behavior: "smooth", block: "center" });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  stopDictation();
  errorNode.hidden = true;
  const answers = [...answersNode.querySelectorAll(".answer")]
    .map((n) => ({ question: n.dataset.question, answer: n.querySelector("textarea").value.trim() }))
    .filter((a) => a.answer);
  const words = answers.reduce((n, a) => n + a.answer.split(/\s+/).length, 0);
  if (words < 25) return showError("Please answer at least one question in a few sentences.");
  if (!document.getElementById("consent").checked) return showError("Please confirm the first checkbox so we can use your story.");
  if (!document.getElementById("ownwords").checked) return showError("Please confirm that this is your own experience.");

  const value = (id) => document.getElementById(id).value.trim();
  const payload = {
    name: value("name"), email: value("email"), university: value("university"), program: value("program"),
    years: value("years"), work: value("work"), website: value("website"),
    outcome: form.elements.outcome.value, display: form.elements.display.value,
    followup: document.getElementById("followup").checked, consent: true, answers,
  };
  if (payload.display !== "anonymous" && !payload.name) return showError("Add your name, or choose to appear anonymously.");

  submitBtn.disabled = true;
  submitBtn.textContent = "Sending…";
  try {
    const response = await fetch("/api/stories/submit", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Something went wrong. Please try again.");
    document.getElementById("formView").hidden = true;
    document.getElementById("doneView").hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) {
    showError(error.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Send for review";
  }
});
