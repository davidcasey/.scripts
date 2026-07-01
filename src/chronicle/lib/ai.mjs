/**
 * lib/ai.mjs — single AI entry point for all chronicle scripts.
 * Provider is chosen by AI_PROVIDER (anthropic | openai | ollama); model by
 * AI_MODEL. Reads process.env at call time, so loadEnv() must run first.
 */
export async function callAI(prompt, maxTokens = 2048) {
  const provider = (process.env.AI_PROVIDER || "anthropic").toLowerCase();
  const modelOverride = process.env.AI_MODEL;

  if (provider === "openai" || provider === "ollama") {
    const isOllama = provider === "ollama";
    const baseURL = process.env.OPENAI_BASE_URL || (isOllama ? "http://localhost:11434/v1" : "https://api.openai.com/v1");
    const apiKey  = process.env.OPENAI_API_KEY || (isOllama ? "ollama" : "");
    if (!apiKey) { console.error("OPENAI_API_KEY not set"); process.exit(1); }
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey, baseURL });
    const model = modelOverride || (isOllama ? "llama3.1" : "gpt-4o");
    const r = await client.chat.completions.create({
      model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }],
    });
    return r.choices[0].message.content.trim();
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { console.error("ANTHROPIC_API_KEY not set"); process.exit(1); }
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: key });
  const model = modelOverride || "claude-sonnet-4-6";
  const m = await client.messages.create({
    model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }],
  });
  return m.content[0].text.trim();
}
