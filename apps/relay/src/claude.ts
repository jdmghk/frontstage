// Claude writing for the web editor through the relay: the user's own Anthropic key arrives in the
// X-Anthropic-Key header (browser-resident, like the fal/OpenRouter keys) and is used for this one
// request only. Request rules come from the shared claude-wire module (same as proxy and desktop).

import Anthropic from "@anthropic-ai/sdk";
import { buildClaudeParams, claudeErrorResult, interpretClaudeMessage } from "@frontstage/ai/claude-wire";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const MAX_BODY = 25 * 1024 * 1024;

export async function handleClaudeRun(request: Request, makeClient: (key: string) => Anthropic = (key) => new Anthropic({ apiKey: key, maxRetries: 3 })): Promise<Response> {
  const key = request.headers.get("X-Anthropic-Key");
  if (!key) return json({ ok: false, kind: "no-key", error: "Add your Anthropic API key in Settings." }, 401);
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY) return json({ ok: false, kind: "invalid", error: "request body too large" }, 413);
  let params: Record<string, unknown>;
  try {
    params = buildClaudeParams(await request.json());
  } catch (e) {
    return json({ ok: false, kind: "invalid", error: e instanceof Error ? e.message : String(e) }, 400);
  }
  try {
    const message = await makeClient(key).beta.messages.stream(params as never).finalMessage();
    return json(interpretClaudeMessage(message as never));
  } catch (err) {
    return json(claudeErrorResult(err));
  }
}
