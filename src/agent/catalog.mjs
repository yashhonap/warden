// Where models come from. Every source here speaks the OpenAI-compatible API except "anthropic".
// listModels() returns a normalised list: { id, ctx, free, tools } (null = the source does not say).
//
// Checked live on 2026-11-11: OpenRouter, Hugging Face and NVIDIA publish their model lists without a key;
// Groq, Cerebras, Mistral and DeepSeek need a key to list models.

const NON_CHAT = /embed|rerank|safety|guard|reward|whisper|tts|speech|transcri|moderation|ocr|parse|clip|retriever|detector|image-gen|flux|stable-diffusion/i;

export const CATALOG = {
  openrouter: {
    label: "OpenRouter", api: "openai", baseUrl: "https://openrouter.ai/api/v1", keyEnv: ["OPENROUTER_API_KEY"],
    keyUrl: "https://openrouter.ai/keys", blurb: "hundreds of models, some free (Nemotron, Qwen, Llama…)", publicList: true,
    async list(fetchJson) {
      const j = await fetchJson("https://openrouter.ai/api/v1/models");
      return (j.data || []).map((m) => ({
        id: m.id, ctx: m.context_length ?? null,
        free: m.pricing ? Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0 : null,
        tools: Array.isArray(m.supported_parameters) ? m.supported_parameters.includes("tools") : null,
      }));
    },
  },
  huggingface: {
    label: "Hugging Face", api: "openai", baseUrl: "https://router.huggingface.co/v1", keyEnv: ["HF_TOKEN", "HUGGINGFACE_API_KEY"],
    keyUrl: "https://huggingface.co/settings/tokens", blurb: "open models (DeepSeek, Qwen, Nemotron…), free monthly credits", publicList: true,
    async list(fetchJson) {
      const j = await fetchJson("https://router.huggingface.co/v1/models");
      return (j.data || []).map((m) => {
        const live = (m.providers || []).filter((p) => p.status !== "error");
        return {
          id: m.id,
          ctx: live.reduce((n, p) => Math.max(n, p.context_length || 0), 0) || null,
          free: live.some((p) => p.is_free) || null,
          tools: live.length ? live.some((p) => p.supports_tools) : null,
        };
      });
    },
  },
  nvidia: {
    label: "NVIDIA", api: "openai", baseUrl: "https://integrate.api.nvidia.com/v1", keyEnv: ["NVIDIA_API_KEY"],
    keyUrl: "https://build.nvidia.com", blurb: "Nemotron, DeepSeek, Llama…, free credits", publicList: true,
    async list(fetchJson) {
      const j = await fetchJson("https://integrate.api.nvidia.com/v1/models");
      return (j.data || []).filter((m) => !NON_CHAT.test(m.id)).map((m) => ({ id: m.id, ctx: null, free: null, tools: null }));
    },
  },
  gemini: {
    label: "Google Gemini", api: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    keyUrl: "https://aistudio.google.com/apikey", blurb: "free tier",
  },
  groq: {
    label: "Groq", api: "openai", baseUrl: "https://api.groq.com/openai/v1", keyEnv: ["GROQ_API_KEY"],
    keyUrl: "https://console.groq.com/keys", blurb: "free tier, very fast",
  },
  cerebras: {
    label: "Cerebras", api: "openai", baseUrl: "https://api.cerebras.ai/v1", keyEnv: ["CEREBRAS_API_KEY"],
    keyUrl: "https://cloud.cerebras.ai", blurb: "free tier, very fast",
  },
  mistral: {
    label: "Mistral", api: "openai", baseUrl: "https://api.mistral.ai/v1", keyEnv: ["MISTRAL_API_KEY"],
    keyUrl: "https://console.mistral.ai/api-keys", blurb: "free tier (Experiment plan)",
  },
  deepseek: {
    label: "DeepSeek", api: "openai", baseUrl: "https://api.deepseek.com", keyEnv: ["DEEPSEEK_API_KEY"],
    keyUrl: "https://platform.deepseek.com/api_keys", blurb: "official API, cheap but not free",
  },
  ollama: {
    label: "Ollama", api: "openai", baseUrl: "http://127.0.0.1:11434/v1", keyEnv: [], local: true,
    keyUrl: "https://ollama.com/download", blurb: "models on your own PC, no key",
  },
  lmstudio: {
    label: "LM Studio", api: "openai", baseUrl: "http://127.0.0.1:1234/v1", keyEnv: [], local: true,
    keyUrl: "https://lmstudio.ai", blurb: "models on your own PC, no key",
  },
  openai: {
    label: "OpenAI", api: "openai", baseUrl: "https://api.openai.com/v1", keyEnv: ["OPENAI_API_KEY"], maxTokensParam: "max_completion_tokens",
    keyUrl: "https://platform.openai.com/api-keys", blurb: "paid",
  },
  anthropic: {
    label: "Anthropic", api: "anthropic", baseUrl: "https://api.anthropic.com/v1", keyEnv: ["ANTHROPIC_API_KEY"],
    keyUrl: "https://console.anthropic.com/settings/keys", blurb: "paid",
  },
};

// Order shown by /add: the easiest free option first (Gemini: tested live, native tool calling), then other free sources.
export const ADD_ORDER = ["gemini", "openrouter", "huggingface", "nvidia", "groq", "cerebras", "mistral", "deepseek", "ollama", "lmstudio", "openai", "anthropic"];
