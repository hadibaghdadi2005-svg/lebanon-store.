// Proxies the site's AI chat to the Anthropic API, keeping the API key server-side.
// Two modes:
//   mode:'product' — stateless Q&A for the per-product assistant widget (unchanged legacy shape).
//   mode:'support' — the persisted "Ask us" store-support agent. Finds-or-creates the
//     customer's one conversation, stores every turn in chat_conversations/chat_messages
//     (via the service-role key, bypassing RLS — see the migration for why), and lets Claude
//     call the escalate_to_human tool whenever a question isn't about the store, flipping the
//     conversation to 'needs_human' so the admin's realtime subscription picks it up.
// Requires the ANTHROPIC_API_KEY secret (Dashboard -> Edge Functions -> Secrets, or
// `supabase secrets set ANTHROPIC_API_KEY=...`). SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are
// auto-provided by the platform, no manual setup needed for those.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Anthropic from "npm:@anthropic-ai/sdk@0.71.0";
import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = new Set(["https://hadibaghdadi2005-svg.github.io"]);

function corsHeaders(origin: string | null) {
  const allow = origin && (ALLOWED_ORIGINS.has(origin) || origin.startsWith("http://localhost") || origin.startsWith("http://127.0.0.1"))
    ? origin
    : "https://hadibaghdadi2005-svg.github.io";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

const MODEL = "claude-opus-5";
const MAX_TOKENS = 1024;
const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
const client = anthropicKey ? new Anthropic({ apiKey: anthropicKey }) : null;
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const HANDOFF_MESSAGE = {
  en: "That's outside what I can help with directly — I've flagged this for our team and they'll jump in shortly!",
  ar: "هذا خارج ما يمكنني مساعدتك به مباشرة — لقد أبلغت فريقنا وسيتواصلون معك قريبًا!",
};

const ESCALATE_TOOL = {
  name: "escalate_to_human",
  description: "Call this when the customer's question is not about the HABIBI store — its products, prices, stock, categories, shipping fees, delivery time, coupons, return policy, or the customer's own orders. Never guess at or answer unrelated topics yourself; escalate instead.",
  input_schema: {
    type: "object" as const,
    properties: { reason: { type: "string", description: "Brief reason for escalating, for the store admin's benefit" } },
    required: ["reason"],
  },
};

async function callAnthropic(system: string, messages: { role: string; content: string }[], withEscalation: boolean) {
  const response = await client!.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages: messages as Anthropic.MessageParam[],
    output_config: { effort: "low" },
    ...(withEscalation ? { tools: [ESCALATE_TOOL] } : {}),
  });
  const escalated = response.content.some((b) => b.type === "tool_use" && b.name === "escalate_to_human");
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return { escalated, text };
}

// Anthropic requires strictly alternating user/assistant turns; this conversation model
// (customer/ai/admin, with status flipping between AI- and human-driven) can produce
// consecutive rows that map to the same role, so adjacent same-role turns are merged.
function mergeHistory(rows: { sender: string; content: string }[]) {
  const merged: { role: string; content: string }[] = [];
  for (const r of rows) {
    const role = r.sender === "customer" ? "user" : "assistant";
    const last = merged[merged.length - 1];
    if (last && last.role === role) last.content += "\n" + r.content;
    else merged.push({ role, content: r.content });
  }
  return merged;
}

function jsonResponse(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, cors);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400, cors);
  }

  if (body.mode === "product") {
    const system = body.system;
    const messages = body.messages;
    if (typeof system !== "string" || !Array.isArray(messages) || messages.length === 0 || messages.length > 40) {
      return jsonResponse({ error: "Invalid request body" }, 400, cors);
    }
    if (messages.some((m) => typeof m.content !== "string" || m.content.length > 4000)) {
      return jsonResponse({ error: "Invalid request body" }, 400, cors);
    }
    if (!client) return jsonResponse({ error: "AI not configured" }, 500, cors);
    try {
      const { text } = await callAnthropic(system, messages, false);
      return jsonResponse({ text }, 200, cors);
    } catch (e) {
      console.error("Anthropic request failed (product mode):", e);
      return jsonResponse({ error: "AI request failed" }, 502, cors);
    }
  }

  if (body.mode === "support") {
    const customerId = body.customerId;
    const customerName = typeof body.customerName === "string" ? body.customerName : null;
    const system = body.system;
    const message = body.message;
    const useAr = body.lang === "ar";
    if (typeof customerId !== "string" || typeof system !== "string" || typeof message !== "string" || message.length === 0 || message.length > 4000) {
      return jsonResponse({ error: "Invalid request body" }, 400, cors);
    }

    try {
      let { data: convo, error: convoErr } = await admin
        .from("chat_conversations")
        .select("*")
        .eq("customer_id", customerId)
        .maybeSingle();
      if (convoErr) throw convoErr;

      if (!convo) {
        const { data: created, error: createErr } = await admin
          .from("chat_conversations")
          .insert({ customer_id: customerId, customer_name: customerName, status: "ai" })
          .select()
          .single();
        if (createErr) throw createErr;
        convo = created;
      } else if (convo.status === "resolved") {
        const { data: updated, error: updateErr } = await admin
          .from("chat_conversations")
          .update({ status: "ai" })
          .eq("id", convo.id)
          .select()
          .single();
        if (updateErr) throw updateErr;
        convo = updated;
      }

      const { error: msgErr } = await admin.from("chat_messages").insert({
        conversation_id: convo.id, customer_id: customerId, sender: "customer", content: message,
      });
      if (msgErr) throw msgErr;

      if (convo.status === "needs_human" || convo.status === "human") {
        await admin.from("chat_conversations").update({ updated_at: new Date().toISOString() }).eq("id", convo.id);
        return jsonResponse({ handoff: true }, 200, cors);
      }

      if (!client) return jsonResponse({ error: "AI not configured" }, 500, cors);

      const { data: historyRows, error: histErr } = await admin
        .from("chat_messages")
        .select("sender, content")
        .eq("conversation_id", convo.id)
        .order("created_at", { ascending: true });
      if (histErr) throw histErr;

      const { escalated, text } = await callAnthropic(system, mergeHistory(historyRows || []), true);

      if (escalated) {
        const canned = useAr ? HANDOFF_MESSAGE.ar : HANDOFF_MESSAGE.en;
        await admin.from("chat_messages").insert({ conversation_id: convo.id, customer_id: customerId, sender: "ai", content: canned });
        await admin.from("chat_conversations").update({ status: "needs_human", updated_at: new Date().toISOString() }).eq("id", convo.id);
        return jsonResponse({ text: canned, handoff: true }, 200, cors);
      }

      const answer = text || (useAr ? "عذرًا، لم أتمكن من إيجاد إجابة مناسبة." : "Sorry, I couldn't find a good answer.");
      await admin.from("chat_messages").insert({ conversation_id: convo.id, customer_id: customerId, sender: "ai", content: answer });
      await admin.from("chat_conversations").update({ updated_at: new Date().toISOString() }).eq("id", convo.id);
      return jsonResponse({ text: answer, handoff: false }, 200, cors);
    } catch (e) {
      console.error("Support chat failed:", e);
      return jsonResponse({ error: "AI request failed" }, 502, cors);
    }
  }

  return jsonResponse({ error: "Unknown mode" }, 400, cors);
});
