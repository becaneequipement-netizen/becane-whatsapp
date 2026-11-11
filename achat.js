/**
 * Bureau d'achat — agent d'achat et d'importation de BECANE ET EQUIPEMENT SARL, indépendant de l'application Claude.
 * Servi par ce Worker sur achat.becaneetequipement.com (et sur /achat de l'adresse workers.dev).
 *
 * Secrets (Settings > Variables and Secrets) :
 *   ACHAT_API_KEY   -> clé API Claude réservée à l'agent d'achat (facultatif : à défaut, la clé ANTHROPIC_API_KEY de l'agent WhatsApp)
 *   ACHAT_PASSWORD  -> mot de passe de l'application (à défaut : INBOX_PASSWORD)
 * Variable facultative : ACHAT_MODEL (défaut : claude-sonnet-5-5)
 *
 * Données : table achat_docs de la base D1 (fournisseurs, missions, taux). Le logiciel n'est lu qu'en lecture.
 * L'agent ne paie rien, ne signe rien et n'envoie aucun message : il prépare, le gérant valide.
 */
import PAGE from "./achat_page.js";
import { concessionStats } from "./achat_logic.js";

const MODEL = "claude-sonnet-5-5";
const QUICK_MODEL = "claude-haiku-5-5";
const SQL_STATS = `SELECT v.brand, v.model, v.displacement, v.year, v.status, v.created_at, v.cost_purchase, v.cost_transport, v.cost_customs,
  (v.cost_paint + v.cost_repair + v.cost_maintenance + v.cost_parts + v.cost_other) AS prep, s.price AS sold, s.sale_date
  FROM vehicles v LEFT JOIN sales s ON s.vehicle_id = v.id AND s.status != 'annulee' ORDER BY v.id`;
const PATH_RE = /^(suppliers|missions|settings)\/[A-Za-z0-9_-]{1,64}$/;
const COLLS = ["suppliers", "missions", "settings"];
const SUP_KEYS = ["nom", "type", "pays", "ville", "site", "adresse", "contact", "email", "produits", "prix", "moq", "paiement", "exportation", "justification", "sources"];

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const html = (s, status = 200, extra = {}) => new Response(s, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", ...extra } });
const apiKey = (env) => env.ACHAT_API_KEY || env.ANTHROPIC_API_KEY || "";
const password = (env) => env.ACHAT_PASSWORD || env.INBOX_PASSWORD || "";

async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const sessionToken = (env) => hmacHex(password(env), "achat-session-v1");
async function authed(request, env) {
  if (!password(env)) return false;
  const m = (request.headers.get("cookie") || "").match(/(?:^|;\s*)ax=([a-f0-9]{64})/);
  return !!m && safeEqual(m[1], await sessionToken(env));
}

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS achat_docs (path TEXT PRIMARY KEY, coll TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`).run();
  schemaReady = true;
}
const parse = (t) => { try { return JSON.parse(t); } catch { return {}; } };
async function getDoc(env, path) {
  const r = await env.DB.prepare(`SELECT data FROM achat_docs WHERE path = ?`).bind(path).first();
  return r ? parse(r.data) : null;
}
async function putDoc(env, path, data) {
  const body = JSON.stringify(data);
  if (body.length > 250000) throw new Error("Document trop volumineux.");
  await env.DB.prepare(`INSERT INTO achat_docs (path, coll, data, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(path) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`).bind(path, path.split("/")[0], body).run();
}
async function listDocs(env, coll) {
  const { results } = await env.DB.prepare(`SELECT path, data FROM achat_docs WHERE coll = ? ORDER BY path LIMIT 500`).bind(coll).all();
  return (results || []).map((r) => ({ id: r.path.split("/")[1], data: parse(r.data) }));
}

/* ---------- Outils de l'agent, exécutés ici ---------- */
async function saveSupplier(env, inp) {
  const nom = String(inp.nom || "").trim().slice(0, 400);
  if (!nom) throw new Error("Nom manquant.");
  if (!/https?:\/\//i.test(String(inp.sources || ""))) throw new Error("Lien de source manquant : n'enregistre qu'un fournisseur vu sur une page.");
  const d = {};
  for (const k of SUP_KEYS) if (inp[k] != null && String(inp[k]).trim()) d[k] = String(inp[k]).trim().slice(0, ["justification", "sources"].includes(k) ? 3000 : 400);
  if (Number.isFinite(Number(inp.fiabilite)) && inp.fiabilite !== "" && inp.fiabilite != null) d.fiabilite = Math.max(0, Math.min(100, Math.round(Number(inp.fiabilite))));
  const now = new Date().toISOString();
  const existing = (await listDocs(env, "suppliers")).find((s) => String(s.data.nom || "").toLowerCase() === nom.toLowerCase());
  if (existing) await putDoc(env, "suppliers/" + existing.id, { ...existing.data, ...d, updatedAt: now });
  else await putDoc(env, "suppliers/" + crypto.randomUUID().replace(/-/g, "").slice(0, 20), { statut: "À vérifier", ...d, origine: "agent", journal: [], createdAt: now, updatedAt: now });
  return { ok: true, nom };
}
const TOOLS = [
  { name: "chiffres_concession", description: "Chiffres réels de la concession, par modèle et par année : nombre de motos, vendues, en stock, prix d'achat moyen, transport moyen, douane moyenne, remise en état moyenne, prix de vente moyen, marge moyenne et délai de vente moyen en jours. Montants en FCFA.", input_schema: { type: "object", properties: {} } },
  { name: "enregistrer_fournisseur", description: "Enregistre ou met à jour un fournisseur dans la base du gérant. Uniquement pour un fournisseur réellement trouvé sur une page, avec le lien dans sources.",
    input_schema: { type: "object", properties: { nom: { type: "string" }, type: { type: "string" }, pays: { type: "string" }, ville: { type: "string" }, site: { type: "string" }, adresse: { type: "string" }, contact: { type: "string" }, email: { type: "string" }, produits: { type: "string" }, prix: { type: "string" }, moq: { type: "string" }, paiement: { type: "string" }, exportation: { type: "string" }, fiabilite: { type: "number" }, justification: { type: "string" }, sources: { type: "string" } }, required: ["nom", "sources"] } },
];
const WEB_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 8 };

async function runTool(env, name, input) {
  if (name === "chiffres_concession") {
    const { results } = await env.DB.prepare(SQL_STATS).all();
    return concessionStats(results || []).map(({ key, ...s }) => s);
  }
  if (name === "enregistrer_fournisseur") return saveSupplier(env, input || {});
  throw new Error("Outil inconnu.");
}
async function callClaude(env, body) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey(env), "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) { const e = new Error((await res.text()).slice(0, 500)); e.status = res.status; throw e; }
  return res.json();
}
function frError(e) {
  const m = String(e && e.message || "");
  if (e && e.status === 401) return "La clé Claude de l'application est refusée. Vérifie la clé Claude installée dans Cloudflare.";
  if (/credit balance|billing|insufficient/i.test(m)) return "Le crédit de la clé Claude est épuisé. Recharge-le sur platform.claude.com.";
  if (e && e.status === 429) return "Trop de demandes en même temps. Réessaie dans une minute.";
  if (e && e.status === 404) return "Le modèle Claude demandé est introuvable. Vérifie la variable ACHAT_MODEL.";
  if (e && e.status >= 500) return "Claude est momentanément indisponible. Réessaie dans un moment.";
  return "L'agent n'a pas pu répondre. Réessaie." + (m ? " (" + m.slice(0, 160) + ")" : "");
}
async function runAgent(env, input) {
  if (!apiKey(env)) return { error: "Aucune clé Claude n'est installée dans Cloudflare (secret ACHAT_API_KEY ou ANTHROPIC_API_KEY)." };
  const turns = (Array.isArray(input.messages) ? input.messages : []).filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim());
  if (!turns.length || turns[turns.length - 1].role !== "user") return { error: "Demande vide." };
  if (JSON.stringify(turns).length > 400000) return { error: "Cette mission est devenue trop longue. Lance une nouvelle mission." };
  // Le premier message porte les consignes de l'agent ; les suivants sont la conversation.
  const system = turns.length > 1 ? turns[0].content : "Tu es l'agent d'achat de BECANE ET EQUIPEMENT SARL. N'invente jamais un prix, un taux ou un fournisseur : vérifie avec web_search et cite la page.";
  const messages = (turns.length > 1 ? turns.slice(1) : turns).map((m) => ({ role: m.role, content: m.content }));
  if (messages[0].role !== "user") messages.shift();
  const images = (Array.isArray(input.images) ? input.images : []).filter((i) => i && /^image\/(jpeg|png|webp)$/.test(i.type) && typeof i.data === "string" && i.data.length < 3000000).slice(0, 4);
  if (images.length) { const last = messages[messages.length - 1]; last.content = [...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.type, data: i.data } })), { type: "text", text: last.content }]; }
  const body = { model: input.quick ? QUICK_MODEL : env.ACHAT_MODEL || MODEL, max_tokens: 8000, system, messages, tools: [WEB_TOOL, ...TOOLS] };
  const parts = []; let truncated = false, note = "";
  try {
    for (let turn = 0; turn < 6; turn++) {
      let out;
      try { out = await callClaude(env, body); }
      catch (e) {
        // Recherche web refusée par l'API pour ce modèle ou cette clé : on répond sans elle, en le disant.
        if (e.status === 400 && body.tools.includes(WEB_TOOL) && /web_search|tool/i.test(e.message)) {
          body.tools = TOOLS; turn--;
          note = "⚠️ La recherche web n'a pas pu être utilisée pour cette réponse : rien de ce qui suit n'a été vérifié sur une page.\n\n";
          continue;
        }
        throw e;
      }
      const text = (out.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      if (text) parts.push(text);
      if (out.stop_reason === "max_tokens") { truncated = true; break; }
      if (out.stop_reason === "pause_turn") { body.messages.push({ role: "assistant", content: out.content }); continue; }
      const uses = (out.content || []).filter((b) => b.type === "tool_use");
      if (out.stop_reason !== "tool_use" || !uses.length) break;
      const results = [];
      for (const u of uses) {
        let content, is_error = false;
        try { content = JSON.stringify(await runTool(env, u.name, u.input)).slice(0, 60000); } catch (e) { content = "Erreur : " + String(e.message || e); is_error = true; }
        results.push({ type: "tool_result", tool_use_id: u.id, content, is_error });
      }
      body.messages.push({ role: "assistant", content: out.content }, { role: "user", content: results });
    }
  } catch (e) {
    console.error("achat", e.status, e.message);
    if (!parts.length) return { error: frError(e) };
    truncated = true;
  }
  const text = note + parts.join("\n\n");
  return text.trim() ? { text, truncated } : { error: "L'agent n'a rien répondu. Simplifie la demande." };
}
/** Réponse longue : des espaces sont envoyés pendant le travail pour garder la connexion ouverte, puis le JSON final. */
function keepAlive(ctx, work) {
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter(), enc = new TextEncoder();
  const timer = setInterval(() => { w.write(enc.encode(" ")).catch(() => {}); }, 8000);
  ctx.waitUntil((async () => {
    let out;
    try { out = await work(); } catch (e) { console.error("achat", e); out = { error: "L'agent n'a pas pu répondre. Réessaie." }; }
    clearInterval(timer);
    try { await w.write(enc.encode(JSON.stringify(out))); await w.close(); } catch {}
  })());
  return new Response(readable, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

const LOGIN = (base, error) => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Bureau d'achat BECANE</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0B1F3A;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#0A1626}
form{background:#fff;border-radius:18px;padding:28px 24px;width:min(88vw,360px);display:grid;gap:14px;box-shadow:0 20px 50px rgba(0,0,0,.35)}
h1{margin:0;font-size:22px}p{margin:0;color:#56677B;font-size:14px}label{display:grid;gap:6px;font-size:14px;color:#56677B}
input{font:inherit;padding:12px;border:1px solid #CFDAE6;border-radius:10px}button{font:inherit;font-weight:600;padding:12px;border:0;border-radius:10px;background:#4FB3E8;color:#06203A}
.e{color:#A8271B;font-size:14px}</style></head><body><form method="post" action="${base}/login"><h1>Bureau d'achat</h1><p>BECANE ET EQUIPEMENT SARL</p>
<label>Mot de passe<input id="p" name="password" type="password" autocomplete="current-password" required autofocus></label>${error ? `<div class="e">${error}</div>` : ""}<button type="submit">Entrer</button></form></body></html>`;
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#0B1F3A"/><path d="M128 300h256l-28 64H156z" fill="#4FB3E8"/><path d="M176 220h160v64H176z" fill="#EAF4FC"/><path d="M244 140h24v80h-24z" fill="#4FB3E8"/></svg>`;

/** path : chemin après /achat ("" , "/login", "/api/…"). base : préfixe des liens ("" sur achat.…, "/achat" ailleurs). */
export async function handleAchat(request, env, ctx, path, base) {
  const url = new URL(request.url);
  if (path === "/icon.svg") return new Response(ICON, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
  if (path === "/manifest.webmanifest") return new Response(JSON.stringify({ name: "Bureau d'achat BECANE", short_name: "Bureau d'achat", start_url: base + "/", scope: base + "/", display: "standalone", background_color: "#0B1F3A", theme_color: "#0B1F3A", icons: [{ src: base + "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }] }), { headers: { "content-type": "application/manifest+json" } });
  if (path === "/login" && request.method === "POST") {
    const form = await request.formData().catch(() => null);
    const given = String(form?.get("password") || "");
    if (!password(env) || !safeEqual(await hmacHex("achat-login", given), await hmacHex("achat-login", password(env)))) {
      await new Promise((r) => setTimeout(r, 800));
      return html(LOGIN(base, password(env) ? "Mot de passe incorrect." : "Aucun mot de passe n'est configuré pour cette application."), 401);
    }
    return new Response(null, { status: 303, headers: { location: base + "/", "set-cookie": `ax=${await sessionToken(env)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${90 * 86400}` } });
  }
  if (path === "/logout") return new Response(null, { status: 303, headers: { location: base + "/", "set-cookie": "ax=; Path=/; Max-Age=0" } });
  const ok = await authed(request, env);
  if (path === "" || path === "/") return ok ? html(PAGE) : html(LOGIN(base, ""));
  if (!path.startsWith("/api/")) return new Response("Introuvable", { status: 404 });
  if (!ok) return json({ error: "Session expirée.", code: "session_expired" }, 401);
  // Les écritures ne sont acceptées que depuis l'application elle-même.
  if (request.method !== "GET") { const o = request.headers.get("origin"); if (o && o !== url.origin) return json({ error: "Origine refusée." }, 403); }
  await ensureSchema(env);
  const route = path.slice(5);
  try {
    if (route === "status" && request.method === "GET") return json({ key: !!apiKey(env) });
    if (route === "stats" && request.method === "GET") { const { results } = await env.DB.prepare(SQL_STATS).all(); return json({ rows: results || [] }); }
    if (route === "docs" && request.method === "GET") {
      const coll = url.searchParams.get("coll") || "";
      if (!COLLS.includes(coll)) return json({ error: "Collection inconnue." }, 400);
      return json({ docs: await listDocs(env, coll) });
    }
    if (route === "doc") {
      if (request.method === "GET" || request.method === "DELETE") {
        const p = url.searchParams.get("path") || "";
        if (!PATH_RE.test(p)) return json({ error: "Chemin invalide." }, 400);
        if (request.method === "GET") return json({ data: await getDoc(env, p) });
        await env.DB.prepare(`DELETE FROM achat_docs WHERE path = ?`).bind(p).run();
        return json({ ok: true });
      }
      if (request.method === "PUT") {
        const b = await request.json().catch(() => null);
        if (!b || !PATH_RE.test(String(b.path || "")) || !b.data || typeof b.data !== "object" || Array.isArray(b.data)) return json({ error: "Demande invalide." }, 400);
        let data = b.data;
        if (b.merge) { const cur = await getDoc(env, b.path); if (!cur) return json({ error: "Document introuvable.", code: "invalid_argument" }, 404); data = { ...cur, ...b.data }; }
        await putDoc(env, b.path, data);
        return json({ ok: true });
      }
    }
    if (route === "chat" && request.method === "POST") {
      const b = await request.json().catch(() => null);
      if (!b) return json({ error: "Demande invalide." }, 400);
      return keepAlive(ctx, () => runAgent(env, b));
    }
  } catch (e) { console.error("achat api", e); return json({ error: "Erreur du serveur. Réessaie." }, 500); }
  return json({ error: "Introuvable." }, 404);
}
