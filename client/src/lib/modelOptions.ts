export type ModelOption = { id: string; label: string };

/**
 * Kept in sync with `builtInModels` in `server/src/index.js`. Merged with `/api/models`
 * so the UI shows every option even if the dev server was not restarted after an update.
 */
export const DEFAULT_BUILT_IN_MODELS: ModelOption[] = [
  { id: "gpt-4o", label: "GPT-4o — OpenAI" },
  { id: "gpt-4o-mini", label: "GPT-4o mini — OpenAI" },
  { id: "o3-mini", label: "o3-mini — OpenAI" },
  { id: "o1", label: "o1 — OpenAI" },
  { id: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet — Anthropic" },
  { id: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku — Anthropic" },
  {
    id: "google/gemini-3-flash-preview",
    label: "Gemini 3 Flash (preview) — Google API key (AI Studio)",
  },
];

export function mergeModelListFromApi(fromApi: ModelOption[]): ModelOption[] {
  const apiById = new Map(fromApi.map((m) => [m.id, m]));
  const seen = new Set<string>();
  const out: ModelOption[] = [];
  for (const d of DEFAULT_BUILT_IN_MODELS) {
    out.push(apiById.get(d.id) ?? d);
    seen.add(d.id);
  }
  for (const m of fromApi) {
    if (!seen.has(m.id)) {
      out.push(m);
      seen.add(m.id);
    }
  }
  return out;
}
