import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";

export class AssessmentCancelled extends Error { constructor() { super("Assessment cancelled."); } }
export interface AIUsage { model: string; operation: string; input_tokens: number; output_tokens: number; cached_tokens: number; estimated_cost_usd: number | null; error_message: string | null }
interface AIContext { check: () => Promise<void>; record: (usage: AIUsage) => Promise<void> }
const context = new AsyncLocalStorage<AIContext>();
export const withAIContext = <T>(value: AIContext, run: () => Promise<T>) => context.run(value, run);
export function estimateCost(model: string, input: number, output: number, cached = 0) {
  const rates = model.startsWith("gpt-6-luna") ? [0.10, 0.50, 0.01] : model.startsWith("gpt-4.1-mini") ? [0.40, 1.60, 0.10] : null;
  return rates ? ((input - cached) * rates[0]! + output * rates[1]! + cached * rates[2]!) / 1_000_000 : null;
}

export async function structuredOpenAI(name: string, schema: object, system: string, data: unknown, options: { model?: string } = {}): Promise<unknown> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not configured.");
  const model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-6-luna";
  const reasoning = /^gpt-[56]/.test(model);
  const scope = context.getStore();
  for (let attempt = 0; attempt < 3; attempt++) {
    await scope?.check();
    const controller = new AbortController();
    let checking = false;
    const timer = scope ? setInterval(() => {
      if (checking) return;
      checking = true;
      scope.check().catch(error => controller.abort(error)).finally(() => { checking = false; });
    }, 1500) : undefined;
    const usage: AIUsage = { model, operation: name, input_tokens: 0, output_tokens: 0, cached_tokens: 0, estimated_cost_usd: null, error_message: null };
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model, ...(reasoning ? { reasoning_effort: process.env.OPENAI_REASONING_EFFORT ?? "none" } : { temperature: 0 }),
          max_completion_tokens: 12000,
          response_format: { type: "json_schema", json_schema: { name, strict: true, schema } },
          messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(data) }],
        }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const error = new Error(`OpenAI request failed (${response.status}). ${response.status >= 500 ? "Temporary provider/server failure." : "Check provider access, quota, and model configuration."}`);
        usage.error_message = error.message;
        await scope?.record(usage);
        if ((response.status === 429 || response.status >= 500) && attempt < 2) { await delay(1000 * 2 ** attempt); continue; }
        throw error;
      }
      const result = await response.json() as { usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }; choices?: { finish_reason?: string; message?: { content?: string | null } }[] };
      usage.input_tokens = result.usage?.prompt_tokens ?? 0;
      usage.output_tokens = result.usage?.completion_tokens ?? 0;
      usage.cached_tokens = result.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      usage.estimated_cost_usd = result.usage ? estimateCost(model, usage.input_tokens, usage.output_tokens, usage.cached_tokens) : null;
      await scope?.record(usage);
      await scope?.check();
      const choice = result.choices?.[0];
      if (!choice?.message?.content || choice.finish_reason !== "stop") throw new Error("OpenAI returned incomplete or refused structured output.");
      return JSON.parse(choice.message.content);
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError")) {
        usage.error_message = "OpenAI network/timeout failure";
        await scope?.record(usage);
        if (attempt < 2) { await delay(1000 * 2 ** attempt); continue; }
      }
      throw error;
    } finally { if (timer) clearInterval(timer); }
  }
  throw new Error("OpenAI retries exhausted.");
}
