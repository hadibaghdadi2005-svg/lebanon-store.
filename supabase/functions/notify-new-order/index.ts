// Emails the admin the moment a customer places an order.
//
// WHY THIS EXISTS: submit-payment-proof already emails on payment confirmation, but that
// only fires if the customer actually types a reference or uploads a screenshot. Someone
// who orders and closes the tab produced no notification at all, and the order sat in
// pending_verification until the 24h cron auto-cancelled it. That is the "sometimes I get
// an email, sometimes I don't" the store owner reported.
//
// HOW IT IS CALLED: an AFTER INSERT trigger on public.orders fires net.http_post at this
// URL, and a once-a-minute pg_cron sweeper re-posts for any order still unnotified. The
// trigger gives immediacy; the sweeper is what makes it reliable, covering a pg_net
// hiccup, a Resend outage, or a cold start that timed out.
//
// WHY verify_jwt IS OFF, and why that is safe here: Postgres has no session to present, so
// requiring a JWT would mean parking a service-role key in the database for the trigger to
// replay - a far worse trade. Authorization is instead structural: this endpoint takes only
// an order id and its single effect is idempotent. claim_order_notification() atomically
// refuses to hand out a row that has already been notified or has burnt its attempts, so a
// caller who somehow guesses an order's uuid can cause at most ONE email - the exact email
// the admin was going to receive anyway. There is no amplification, no data returned to the
// caller, and no way to send anywhere but the hardcoded admin address. Contrast ai-chat,
// which had to be locked down (see CLAUDE.md item 51) precisely because its effect was
// unbounded and billable.
//
// Requires the RESEND_API_KEY secret. SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are
// auto-provided by the platform.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

// Resend's shared test domain only delivers to the Resend account's own verified address,
// which is not the same as ADMIN_EMAIL in index.html. See CLAUDE.md for the history.
const ADMIN_EMAIL_TO = "hadibaghdadi2005@gmail.com";
const DASHBOARD_LINK = "https://hadibaghdadi2005-svg.github.io/lebanon-store./#admin-payments";

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Order fields are customer-typed. They are about to be interpolated into HTML that opens
// in a mail client, so they get escaped for the same reason the storefront escapes them.
function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

type Item = { name_en?: string; name_ar?: string; variant?: string; size?: string; qty?: number; price?: number };

function itemRows(items: unknown): string {
  if (!Array.isArray(items) || items.length === 0) return "<tr><td colspan='3'>(no items recorded)</td></tr>";
  return (items as Item[]).map((it) => {
    const opts = [it.variant, it.size].filter(Boolean).join(" · ");
    const name = esc(it.name_en || it.name_ar || "Item") + (opts ? ` <span style="color:#666">(${esc(opts)})</span>` : "");
    const line = typeof it.price === "number" ? `$${(it.price * (it.qty ?? 1)).toFixed(2)}` : "—";
    return `<tr>
      <td style="padding:4px 10px 4px 0">${name}</td>
      <td style="padding:4px 10px 4px 0;text-align:center">x${esc(it.qty ?? 1)}</td>
      <td style="padding:4px 0;text-align:right">${esc(line)}</td>
    </tr>`;
  }).join("");
}

function buildEmailHtml(o: Record<string, unknown>) {
  const placed = new Date(String(o.created_at ?? Date.now()))
    .toLocaleString("en-GB", { timeZone: "Asia/Beirut", dateStyle: "medium", timeStyle: "short" });
  return `<p>Hi Hadi,</p>
<p><strong>A new order was just placed on Habibi Store.</strong></p>
<p>
Order #: ${esc(o.num)}<br>
Customer: ${esc(o.customer_name || "—")}<br>
Phone: ${esc(o.phone || "—")}<br>
Governorate: ${esc(o.gov || "—")}<br>
Total: $${Number(o.total ?? 0).toFixed(2)}<br>
Placed: ${esc(placed)}
</p>
<table style="border-collapse:collapse;font-size:14px">${itemRows(o.items)}</table>
<p style="margin-top:16px">The customer has <em>not</em> paid yet — they still need to send the Wish
transfer and submit their confirmation. You'll get a second email when they do. If nothing is
submitted within 24 hours the order auto-cancels.</p>
<p><a href="${DASHBOARD_LINK}">Open the admin dashboard</a></p>`;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const orderId = body.order_id;
  if (typeof orderId !== "string") return json({ error: "order_id is required" }, 400);

  // Atomic claim: bumps the attempt counter and hands back the row only if this order is
  // still unnotified and under the attempt cap. Two callers racing (the insert trigger and
  // the sweeper) cannot both win, so the customer's order can never generate two emails.
  const { data: claimed, error: claimErr } = await admin
    .rpc("claim_order_notification", { p_order_id: orderId });
  if (claimErr) {
    console.error("claim_order_notification failed:", claimErr);
    return json({ error: "Claim failed" }, 500);
  }
  const order = Array.isArray(claimed) ? claimed[0] : claimed;
  if (!order) return json({ ok: true, skipped: "already notified, exhausted, or unknown order" }, 200);

  if (!RESEND_API_KEY) {
    await admin.from("orders")
      .update({ admin_notify_error: "RESEND_API_KEY secret is not set on this project" })
      .eq("id", orderId);
    console.error("RESEND_API_KEY is not set; cannot send the new-order email");
    return json({ error: "Email not configured" }, 500);
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Habibi Store <onboarding@resend.dev>",
        to: [ADMIN_EMAIL_TO],
        subject: `New order ${order.num ?? ""} — Habibi Store`,
        html: buildEmailHtml(order),
      }),
    });
    if (!res.ok) {
      // Deliberately NOT swallowed: leaving admin_notified_at null is what lets the sweeper
      // try again, and the recorded reason is what makes a silent drop diagnosable later.
      const detail = `${res.status} ${(await res.text()).slice(0, 400)}`;
      await admin.from("orders").update({ admin_notify_error: detail }).eq("id", orderId);
      console.error("Resend rejected the new-order email:", detail);
      return json({ error: "Email send failed", detail }, 502);
    }
    await admin.from("orders")
      .update({ admin_notified_at: new Date().toISOString(), admin_notify_error: null })
      .eq("id", orderId);
    return json({ ok: true }, 200);
  } catch (e) {
    const detail = String(e).slice(0, 400);
    await admin.from("orders").update({ admin_notify_error: detail }).eq("id", orderId);
    console.error("New-order email failed:", e);
    return json({ error: "Email send failed" }, 502);
  }
});
