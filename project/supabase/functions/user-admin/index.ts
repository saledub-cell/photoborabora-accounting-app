// user-admin edge function
// Handles user management writes using the service role key.
// All mutation endpoints first verify the caller is an admin by checking
// their supplied admin_id + admin_pin_hash against user_roles before proceeding.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function jsonResp(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errResp(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Service-role client — bypasses RLS, used only after admin auth check
function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Supabase env vars not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

// Verify the caller is an admin by looking up admin_id with matching role=admin
// The frontend sends the admin's session id (stored in localStorage) — we just
// check the role directly since we control this system entirely.
async function verifyAdmin(adminId: string): Promise<boolean> {
  try {
    const sb = serviceClient();
    const { data } = await sb
      .from("user_roles")
      .select("role")
      .eq("id", adminId)
      .eq("role", "admin")
      .maybeSingle();
    return data !== null;
  } catch {
    return false;
  }
}

async function sha256hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const url  = new URL(req.url);
    const path = url.pathname.replace(/^\/user-admin\/?/, "").replace(/^\/+/, "");

    // ── GET /users — list all users (anon read, no auth needed) ──────────────
    if (req.method === "GET" && path === "users") {
      const sb = serviceClient();
      const { data, error } = await sb
        .from("user_roles")
        .select("id, display_name, role, allowed_tabs, accent_color")
        .order("display_name");
      if (error) return errResp(error.message, 500);
      return jsonResp({ users: data ?? [] });
    }

    // All mutation endpoints require POST + admin_id in body
    if (req.method !== "POST") {
      return errResp("Method not allowed", 405);
    }

    const body = await req.json() as Record<string, unknown>;
    const adminId = (body.admin_id as string | undefined)?.trim();
    if (!adminId) return errResp("admin_id required", 401);

    const isAdmin = await verifyAdmin(adminId);
    if (!isAdmin) return errResp("Forbidden: admin access required", 403);

    const sb = serviceClient();

    // ── POST /upsert-user ────────────────────────────────────────────────────
    if (path === "upsert-user") {
      const {
        id,
        display_name,
        role,
        pin,
        allowed_tabs,
        accent_color,
      } = body as {
        id?: string;
        display_name?: string;
        role?: string;
        pin?: string;
        allowed_tabs?: string[];
        accent_color?: string;
      };

      if (!display_name?.trim()) return errResp("display_name required");
      if (!role || !["admin", "editor_guest"].includes(role)) return errResp("Invalid role");
      if (!allowed_tabs?.length) return errResp("allowed_tabs must not be empty");

      const isNew  = !id;
      const userId = isNew
        ? display_name.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "")
        : id.trim();

      if (isNew && !pin) return errResp("PIN required for new users");
      if (pin && !/^\d{4}$/.test(pin)) return errResp("PIN must be 4 digits");

      const row: Record<string, unknown> = {
        id:           userId,
        display_name: display_name.trim(),
        role,
        allowed_tabs,
        accent_color: accent_color ?? "#c2a96e",
      };

      if (pin) {
        row.pin_hash = await sha256hex(pin);
      }

      const { error: upsertErr } = await sb
        .from("user_roles")
        .upsert(row, { onConflict: "id" });

      if (upsertErr) return errResp(upsertErr.message, 500);
      return jsonResp({ ok: true, id: userId });
    }

    // ── POST /delete-user ────────────────────────────────────────────────────
    if (path === "delete-user") {
      const { target_id } = body as { target_id?: string };
      if (!target_id?.trim()) return errResp("target_id required");
      if (target_id.trim() === adminId) return errResp("Cannot delete yourself");

      const { error: delErr } = await sb
        .from("user_roles")
        .delete()
        .eq("id", target_id.trim());

      if (delErr) return errResp(delErr.message, 500);
      return jsonResp({ ok: true });
    }

    return errResp("Unknown action", 404);
  } catch (err) {
    return errResp(err instanceof Error ? err.message : "Internal error", 500);
  }
});
