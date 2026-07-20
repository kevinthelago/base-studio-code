/** Wh per 1k tokens by model tier — directional coefficients, not metered readings. */
const WH_PER_1K: Record<"large" | "medium" | "small" | "local", { in: number; out: number }> = {
  large: { in: 0.05, out: 0.9 },
  medium: { in: 0.03, out: 0.4 },
  small: { in: 0.01, out: 0.15 },
  local: { in: 0, out: 0 },
};

/** Classify a model name into an energy tier by name pattern; unknown hosted models fall to medium. */
function tier(model: string): keyof typeof WH_PER_1K {
  const m = model.toLowerCase();
  if (/local|ollama|llama|mistral|qwen|deepseek|phi/.test(m)) return "local";
  if (/opus|ultra|gpt-4(?!o)|gpt4(?!o)/.test(m)) return "large";
  if (/haiku|mini|flash|nano|small|lite/.test(m)) return "small";
  return "medium";
}

/** Estimated Wh for an input/output token split at the model's tier. Directional, not metered. */
export function estimateEnergyWh(model: string, inputTokens: number, outputTokens: number): number {
  const k = WH_PER_1K[tier(model)];
  return (inputTokens / 1000) * k.in + (outputTokens / 1000) * k.out;
}
