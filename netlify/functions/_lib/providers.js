import { IMAGE_DESCRIPTION_PROMPT } from "./prompts.js";

// Groq is tried first because it's free with no credit card required.
function groqConfig(env) {
  const apiKey = (env.GROQ_API_KEY || "").trim();
  if (!apiKey) return null;
  return { apiKey, model: env.GROQ_MODEL || "openai/gpt-oss-120b" };
}

function openaiConfig(env) {
  const apiKey = (env.OPENAI_API_KEY || "").trim();
  if (!apiKey) return null;
  return { apiKey, model: env.OPENAI_MODEL || "gpt-4o-mini" };
}

const TEXT_PROVIDERS = [
  ["groq", "https://api.groq.com/openai/v1/chat/completions", groqConfig],
  ["openai", "https://api.openai.com/v1/chat/completions", openaiConfig],
];

const VISION_PROVIDERS = [
  ["groq", "https://api.groq.com/openai/v1/chat/completions", groqConfig, "qwen/qwen3.6-27b"],
  ["openai", "https://api.openai.com/v1/chat/completions", openaiConfig, "gpt-4o-mini"],
];

async function chatCompletion({ baseUrl, apiKey, model, messages, jsonMode = true, timeoutMs = 35000 }) {
  const body = { model, temperature: 0.6, messages };
  if (jsonMode) {
    body.response_format = { type: "json_object" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      const error = new Error(`Provider responded ${response.status}: ${text}`);
      error.status = response.status;
      // Groq says how long to wait, in a header or in the message
      // ("Please try again in 1.2s").
      const header = Number(response.headers.get("retry-after"));
      const inText = /try again in ([\d.]+)s/i.exec(text);
      error.retryAfter = Number.isFinite(header) && header > 0 ? header : inText ? Number(inText[1]) : null;
      throw error;
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : null;
  } finally {
    clearTimeout(timer);
  }
}

function cleanJsonContent(content) {
  let cleaned = content.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```[a-zA-Z]*\n/, "").replace(/\n```$/, "");
  }
  return JSON.parse(cleaned);
}

export async function describeImage(env, dataUrl, filename, prompt = IMAGE_DESCRIPTION_PROMPT) {
  for (const [providerName, baseUrl, configFn, model] of VISION_PROVIDERS) {
    const config = configFn(env);
    if (!config) continue;

    try {
      const content = await chatCompletion({
        baseUrl,
        apiKey: config.apiKey,
        model,
        jsonMode: false,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      });
      if (content) {
        return content.trim();
      }
    } catch (error) {
      console.error(`[ai-vision] ${providerName} failed on ${filename}:`, error);
    }
  }
  return null;
}

// The free Groq tier limits each model to a few thousand tokens a minute,
// so two or three replies in quick succession get a 429. When that
// happens: wait briefly if Groq says the wait is short, otherwise try the
// next model (each model has its own limit), then the next provider.
const GROQ_FALLBACK_MODELS = ["openai/gpt-oss-20b", "llama-3.1-8b-instant"];
const MAX_RATE_LIMIT_WAIT_S = 3;

function modelsFor(providerName, config, env) {
  if (providerName !== "groq") return [config.model];
  const extra = (env.GROQ_FALLBACK_MODELS || "").split(",").map((m) => m.trim()).filter(Boolean);
  return [...new Set([config.model, ...(extra.length ? extra : GROQ_FALLBACK_MODELS)])];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Tries each configured text provider (and model) in order, returns { providerName, parsed } or null.
export async function callTextProvider(env, messages) {
  for (const [providerName, baseUrl, configFn] of TEXT_PROVIDERS) {
    const config = configFn(env);
    if (!config) continue;

    for (const model of modelsFor(providerName, config, env)) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const content = await chatCompletion({ baseUrl, apiKey: config.apiKey, model, messages });
          if (!content) break;
          return { providerName, model, parsed: cleanJsonContent(content) };
        } catch (error) {
          const shortWait = error.status === 429 && error.retryAfter && error.retryAfter <= MAX_RATE_LIMIT_WAIT_S;
          console.error(`[ai] ${providerName}/${model} failed (attempt ${attempt + 1}):`, error.message);
          if (attempt === 0 && shortWait) {
            await sleep(error.retryAfter * 1000 + 150);
            continue;
          }
          break;
        }
      }
    }
  }
  return null;
}
