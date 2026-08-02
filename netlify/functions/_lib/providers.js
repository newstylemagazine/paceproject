import { IMAGE_DESCRIPTION_PROMPT } from "./prompts.js";

// Groq is tried first because it's free with no credit card required.
function groqConfig(env) {
  const apiKey = (env.GROQ_API_KEY || "").trim();
  if (!apiKey) return null;
  return { apiKey, model: env.GROQ_MODEL || "llama-3.3-70b-versatile" };
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
      throw new Error(`Provider responded ${response.status}: ${await response.text()}`);
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

export async function describeImage(env, dataUrl, filename) {
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
              { type: "text", text: IMAGE_DESCRIPTION_PROMPT },
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

// Tries each configured text provider in order, returns { providerName, parsed } or null.
export async function callTextProvider(env, messages) {
  for (const [providerName, baseUrl, configFn] of TEXT_PROVIDERS) {
    const config = configFn(env);
    if (!config) continue;

    try {
      const content = await chatCompletion({ baseUrl, apiKey: config.apiKey, model: config.model, messages });
      if (!content) continue;
      const parsed = cleanJsonContent(content);
      return { providerName, parsed };
    } catch (error) {
      console.error(`[ai-synthesize] ${providerName} provider failed:`, error);
    }
  }
  return null;
}
