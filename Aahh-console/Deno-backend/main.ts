// ============================================================
// AAHH — Deno Deploy backend layer
// Deploy with: deno deploy create --app aahh-backend
//
// Two jobs live here:
//  1. A proxy endpoint the ESP32 and console can call instead of
//     hitting Supabase directly — keeps a more privileged key on
//     the server only, never on the device or in browser JS.
//  2. A daily cron job that deletes clips older than 24h, so your
//     Storage bucket doesn't fill up with old frame bursts.
//
// Environment variables to set in the Deno Deploy dashboard
// (Settings → Environment Variables), NOT in this file:
//   SUPABASE_URL           = https://your-project-id.supabase.co
//   SUPABASE_SERVICE_KEY   = your service_role key (NOT anon)
// ============================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_KEY")!;

function supabaseHeaders(extra: Record<string, string> = {}) {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

// --- 1. HTTP handler: proxy for telemetry + commands ---
Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // POST /telemetry  — ESP32 posts { last_temp, last_hum, alarm_active }
  if (url.pathname === "/telemetry" && req.method === "POST") {
    const body = await req.json();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/system_controls?id=eq.1`, {
      method: "PATCH",
      headers: supabaseHeaders({ Prefer: "return=minimal" }),
      body: JSON.stringify(body),
    });
    return new Response(await res.text(), { status: res.status });
  }

  // GET /state — console or ESP32 reads current state + commands
  if (url.pathname === "/state" && req.method === "GET") {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/system_controls?id=eq.1`, {
      headers: supabaseHeaders(),
    });
    return new Response(await res.text(), {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  // POST /command — console sends { irrigation_active, record_clip, ... }
  if (url.pathname === "/command" && req.method === "POST") {
    const body = await req.json();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/system_controls?id=eq.1`, {
      method: "PATCH",
      headers: supabaseHeaders({ Prefer: "return=minimal" }),
      body: JSON.stringify(body),
    });
    return new Response(await res.text(), { status: res.status });
  }

  // GET /clips — console reads the 10 most recent recordings
  if (url.pathname === "/clips" && req.method === "GET") {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/clips?order=created_at.desc&limit=10`,
      { headers: supabaseHeaders() }
    );
    return new Response(await res.text(), {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  // GET /clips/:prefix/frames — console fetches frame URLs for one clip
  if (url.pathname.match(/^\/clips\/[^/]+\/frames$/) && req.method === "GET") {
    const prefix = url.pathname.split("/")[2];
    const listRes = await fetch(`${SUPABASE_URL}/storage/v1/object/list/field-clips`, {
      method: "POST",
      headers: supabaseHeaders(),
      body: JSON.stringify({ prefix, limit: 1000 }),
    });
    const objects = await listRes.json();
    const urls = (objects as { name: string }[])
      .filter((o) => o.name?.endsWith(".jpg"))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((o) => `${SUPABASE_URL}/storage/v1/object/public/field-clips/${prefix}/${o.name}`);
    return new Response(JSON.stringify(urls), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response("AAHH backend — see /state, /telemetry, /command, /clips", { status: 200 });
});

// --- 2. Cron: clean up clips older than 24 hours ---
// Deno Deploy reads Deno.cron() calls at deploy time and runs them
// on its own schedule — no external cron service needed.
Deno.cron("cleanup old clips", "0 3 * * *", async () => {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/clips?created_at=lt.${cutoff}`,
    { headers: supabaseHeaders() }
  );
  const oldClips = await res.json();

  for (const clip of oldClips) {
    const prefix = clip.storage_prefix || clip.id;

    // list frames in that clip's folder
    const listRes = await fetch(`${SUPABASE_URL}/storage/v1/object/list/field-clips`, {
      method: "POST",
      headers: supabaseHeaders(),
      body: JSON.stringify({ prefix }),
    });
    const objects = await listRes.json();

    // delete each frame
    for (const obj of objects) {
      await fetch(`${SUPABASE_URL}/storage/v1/object/field-clips/${prefix}/${obj.name}`, {
        method: "DELETE",
        headers: supabaseHeaders(),
      });
    }

    // delete the clip row itself
    await fetch(`${SUPABASE_URL}/rest/v1/clips?id=eq.${clip.id}`, {
      method: "DELETE",
      headers: supabaseHeaders(),
    });
  }

  console.log(`Cleaned up ${oldClips.length} clip(s) older than 24h`);
});
