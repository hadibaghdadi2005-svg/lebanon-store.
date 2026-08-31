// Handles a customer submitting proof of a Wish-transfer payment (a screenshot or a
// transaction reference) for an order awaiting verification. Runs entirely server-side
// with the service-role key so it can write to the admin-only `orders` payment columns
// and the private `payment-proofs` storage bucket, neither of which customers have direct
// RLS access to (see the migration this shipped with). Unlike ai-chat, this verifies the
// caller's identity from their own JWT rather than trusting a client-supplied id, since
// it's touching payment data.
// Requires the RESEND_API_KEY secret (Dashboard -> Edge Functions -> Secrets, or
// `supabase secrets set RESEND_API_KEY=...`) to send the admin notification email.
// SUPABASE_URL/SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY are auto-provided.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const ADMIN_EMAIL_TO = "hadibaghdadi11@gmail.com";
const DASHBOARD_LINK = "https://hadibaghdadi2005-svg.github.io/lebanon-store./#admin-payments";

function jsonResponse(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function buildAdminEmailHtml(vars: { orderNum: string; customerName: string; total: string; timestamp: string; confirmationType: string }) {
  return `<p>Hi Hadi,</p>
<p>A new order is waiting for payment verification on Habibi Store.</p>
<p>
Order #: ${vars.orderNum}<br>
Customer: ${vars.customerName}<br>
Amount: ${vars.total}<br>
Submitted: ${vars.timestamp}<br>
Confirmation type: ${vars.confirmationType}
</p>
<p>Please check the admin dashboard to review and verify this payment before it auto-cancels in 24 hours.</p>
<p><a href="${DASHBOARD_LINK}">View Order</a></p>`;
}

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, cors);

  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader) return jsonResponse({ error: "Not authenticated" }, 401, cors);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400, cors);
  }

  const orderId = body.order_id;
  const reference = typeof body.reference === "string" ? body.reference.trim() : "";
  const screenshotBase64 = typeof body.screenshot_base64 === "string" ? body.screenshot_base64 : "";
  const screenshotExt = (typeof body.screenshot_ext === "string" ? body.screenshot_ext : "jpg").replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 5) || "jpg";

  if (typeof orderId !== "string" || (!reference && !screenshotBase64)) {
    return jsonResponse({ error: "Invalid request body" }, 400, cors);
  }
  if (reference.length > 200) return jsonResponse({ error: "Reference is too long" }, 400, cors);
  if (screenshotBase64.length > 7_000_000) return jsonResponse({ error: "Screenshot is too large" }, 400, cors);

  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userErr } = await callerClient.auth.getUser();
  if (userErr || !userData?.user?.email) return jsonResponse({ error: "Not authenticated" }, 401, cors);
  const callerEmail = userData.user.email;

  try {
    const { data: order, error: orderErr } = await admin.from("orders").select("*").eq("id", orderId).single();
    if (orderErr || !order) return jsonResponse({ error: "Order not found" }, 404, cors);

    if (!order.customer_id) return jsonResponse({ error: "This order has no linked account" }, 403, cors);
    const { data: customer, error: custErr } = await admin.from("customers").select("email").eq("id", order.customer_id).single();
    if (custErr || !customer || customer.email !== callerEmail) return jsonResponse({ error: "This isn't your order" }, 403, cors);

    if (order.payment_status !== "pending_verification") {
      return jsonResponse({ error: "This order can no longer accept a payment confirmation" }, 409, cors);
    }

    let proofPath: string | null = null;
    if (screenshotBase64) {
      const bytes = Uint8Array.from(atob(screenshotBase64), (c) => c.charCodeAt(0));
      proofPath = `order-${orderId}-${Date.now()}.${screenshotExt}`;
      const { error: upErr } = await admin.storage.from("payment-proofs").upload(proofPath, bytes, {
        contentType: `image/${screenshotExt === "jpg" ? "jpeg" : screenshotExt}`,
        upsert: false,
      });
      if (upErr) throw upErr;
    }

    const update: Record<string, unknown> = { payment_submitted_at: new Date().toISOString() };
    if (reference) update.payment_reference = reference;
    if (proofPath) update.payment_proof_path = proofPath;

    const { error: updErr } = await admin.from("orders").update(update).eq("id", orderId);
    if (updErr) throw updErr;

    if (RESEND_API_KEY) {
      try {
        const html = buildAdminEmailHtml({
          orderNum: order.num,
          customerName: order.customer_name || "—",
          total: `$${Number(order.total).toFixed(2)}`,
          timestamp: new Date().toLocaleString("en-GB", { timeZone: "Asia/Beirut", dateStyle: "medium", timeStyle: "short" }),
          confirmationType: proofPath ? "Screenshot" : "Transaction reference",
        });
        const emailRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "Habibi Store <onboarding@resend.dev>",
            to: [ADMIN_EMAIL_TO],
            subject: "New Order Pending Payment Verification — Habibi Store",
            html,
          }),
        });
        if (!emailRes.ok) console.error("Resend request failed:", emailRes.status, await emailRes.text());
      } catch (e) {
        console.error("Admin email failed:", e);
      }
    }

    return jsonResponse({ ok: true }, 200, cors);
  } catch (e) {
    console.error("submit-payment-proof failed:", e);
    return jsonResponse({ error: "Could not submit payment confirmation" }, 502, cors);
  }
});
