/**
 * Agent WhatsApp + boîte de réception — BÉCANE ET ÉQUIPEMENT SARL
 * Cloudflare Worker : WhatsApp Cloud API (Meta) + Claude Haiku (Anthropic), avec bascule automatique
 * vers l'IA gratuite de Cloudflare (Workers AI) si Claude est indisponible ou sans crédit.
 *
 * Numéro WhatsApp de l'agent : +229 01 41 66 33 33
 * L'agent répond seul. Le gérant lit et écrit aux clients depuis /inbox (même numéro) ;
 * dès qu'il écrit à un client, l'agent se met en pause pour ce client.
 *
 * Liaison (Settings > Bindings) :
 *   DB                    -> base D1 "becane-equipement"
 *   AI                    -> Workers AI (IA gratuite de secours)
 * Secrets (Settings > Variables and Secrets) :
 *   ANTHROPIC_API_KEY     -> clé API Claude (facultatif : sans elle, l'agent utilise seulement l'IA gratuite)
 *   WHATSAPP_TOKEN        -> jeton d'accès permanent Meta
 *   WHATSAPP_PHONE_ID     -> "Phone number ID" du +229 01 41 66 33 33
 *   VERIFY_TOKEN          -> mot libre, à recopier dans Meta (webhook)
 *   INBOX_PASSWORD        -> mot de passe de la boîte de réception
 *   APP_SECRET            -> (recommandé) "App secret" de l'application Meta
 *   RESEND_API_KEY        -> (optionnel) alertes e-mail
 * Variables facultatives : NOTIFY_EMAIL, CLAUDE_MODEL, FREE_MODEL, PAUSE_HOURS, CALL_PHONE
 */

const DEFAULTS = {
  CLAUDE_MODEL: "claude-haiku-5-5",
  FREE_MODEL: "@cf/mistralai/mistral-small-3.1-24b-instruct",
  NOTIFY_EMAIL: "becaneequipement@gmail.com",
  FROM_EMAIL: "Assistant WhatsApp <contact@becaneetequipement.com>",
  GRAPH_VERSION: "v23.0",
  CALL_PHONE: "+229 01 41 66 33 33",
  PAUSE_HOURS: 12,
  MAX_USER_MSGS_PER_DAY: 60,
  HISTORY_MESSAGES: 24,
  NOTIFY_EVERY_MIN: 30,
};
const FOREVER = "9999-12-31 00:00:00";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS wa_contacts (phone TEXT PRIMARY KEY, name TEXT, paused_until TEXT, unread INTEGER NOT NULL DEFAULT 0,
     last_at TEXT, last_text TEXT, last_client_at TEXT, notified_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS wa_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL, role TEXT NOT NULL,
     author TEXT NOT NULL DEFAULT 'agent', content TEXT NOT NULL, wamid TEXT, media_id TEXT, media_type TEXT, status TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE INDEX IF NOT EXISTS idx_wa_messages_phone ON wa_messages(phone, id)`,
  `CREATE INDEX IF NOT EXISTS idx_wa_messages_wamid ON wa_messages(wamid)`,
  `CREATE TABLE IF NOT EXISTS wa_kv (k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS wa_seen (wamid TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS wa_leads (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL, profile_name TEXT, first_name TEXT,
     reason TEXT, interest TEXT, visit TEXT, summary TEXT, status TEXT NOT NULL DEFAULT 'nouveau', created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
];
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  for (const sql of SCHEMA) await env.DB.prepare(sql).run();
  schemaReady = true;
}

const cfg = (env, k) => (env[k] !== undefined && env[k] !== "" ? env[k] : DEFAULTS[k]);
const fcfa = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " FCFA";
const nowSql = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const plusHoursSql = (h) => new Date(Date.now() + h * 3600e3).toISOString().slice(0, 19).replace("T", " ");
const isTest = (phone) => String(phone).startsWith("test");

/* ------------------------------------------------------------------ */
/* Stock en direct                                                     */
/* ------------------------------------------------------------------ */

function vehicleLabel(v) {
  const brand = (v.brand || "").trim();
  const B = brand ? brand[0].toUpperCase() + brand.slice(1).toLowerCase() : "";
  const model = (v.model || "").trim();
  const M = model.toUpperCase();
  const cc = Number(v.displacement) || 0;
  if (M.includes("PCX")) return `${B} PCX ${cc >= 145 ? "160" : "125"}`;
  if (M.includes("FORZA")) return `${B} Forza ${cc >= 700 ? "750" : cc >= 320 ? "350" : cc >= 250 ? "300" : "125"}`;
  if (M.includes("ADV")) return `${B} ADV ${cc >= 300 ? "350" : "160"}`;
  return `${B} ${model}${cc ? " " + cc + " cm³" : ""}`.trim();
}

async function loadStock(env) {
  const { results } = await env.DB.prepare(
    `SELECT ref, brand, model, year, mileage, displacement, color, condition, warranty, price, promo_price, promo_until, description, equipment,
            (SELECT COUNT(*) FROM photos p WHERE p.owner_type = 'vehicle' AND p.owner_id = vehicles.id AND (p.mime LIKE '%jp%g' OR p.mime LIKE '%png')) AS nphotos
       FROM vehicles WHERE status = 'disponible' AND published = 1 AND price IS NOT NULL ORDER BY price ASC`
  ).all();
  const today = new Date().toISOString().slice(0, 10);
  return (results || []).map((v, i) => {
    const promo = v.promo_price && (!v.promo_until || v.promo_until >= today);
    const parts = [
      `${i + 1}. ${vehicleLabel(v)}`,
      v.year ? String(v.year) : null,
      v.color ? v.color.toLowerCase() : null,
      v.mileage ? `${String(v.mileage).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} km` : "kilométrage à confirmer en boutique",
      v.condition === "neuf" ? "neuf" : "occasion",
      v.warranty ? `garantie ${v.warranty.toLowerCase()}` : null,
      promo ? `PROMO ${fcfa(v.promo_price)} au lieu de ${fcfa(v.price)}${v.promo_until ? " jusqu'au " + v.promo_until : ""}` : fcfa(v.price),
      `réf. ${v.ref}`,
      v.nphotos ? `${v.nphotos} photo${v.nphotos > 1 ? "s" : ""} disponible${v.nphotos > 1 ? "s" : ""}` : "pas de photo",
    ].filter(Boolean);
    let line = parts.join(" — ");
    const extra = [v.equipment, v.description && !/^Véhicule repris/i.test(v.description) ? v.description : null]
      .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    if (extra) line += `\n   Détails : ${extra.slice(0, 400)}`;
    return line;
  });
}

/* ------------------------------------------------------------------ */
/* Instructions de l'agent                                             */
/* ------------------------------------------------------------------ */

function systemPrompt(env, stockLines, profileName) {
  const call = cfg(env, "CALL_PHONE");
  const today = new Date().toLocaleDateString("fr-FR", { timeZone: "Africa/Porto-Novo", weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return `Tu es l'assistant WhatsApp de BÉCANE ET ÉQUIPEMENT SARL, concession de scooters et motos d'occasion importés (surtout Honda PCX et Forza) à Godomey, Abomey-Calavi, Bénin. Un conseiller client de la concession lit aussi cette conversation et peut répondre lui-même ICI, sur ce même numéro. Nous sommes le ${today}.
${profileName ? `Le nom WhatsApp du client est « ${profileName} » (ce n'est pas forcément son vrai prénom).` : ""}

STYLE (WhatsApp)
- Français simple, chaleureux, professionnel. Vouvoiement.
- Réponses COURTES : 1 à 4 phrases. Une seule question à la fois.
- Texte brut : pas de titres, pas de ** ni de #. Pour une liste de scooters, une ligne par scooter commençant par « • ».
- 1 emoji maximum par message, pas obligatoire.
- Prix en FCFA avec espaces : « 1 350 000 FCFA ».
- Si le client écrit en anglais, réponds en anglais.

COORDONNÉES
- Showroom : Godomey, Abomey-Calavi, Bénin. Itinéraire : après la boulangerie St Daniel et l'hôtel Paradisia, avant d'arriver à la station MRS.
- Pour appeler : ${call} (c'est aussi ce numéro WhatsApp). Ne donne aucun autre numéro.
- Site : becaneetequipement.com — e-mail : contact@becaneetequipement.com

STOCK DISPONIBLE EN CE MOMENT (seule source de vérité, lu en direct dans le logiciel) :
${stockLines.length ? stockLines.join("\n") : "(aucun scooter affiché en ce moment — propose au client de laisser son besoin pour être prévenu des prochains arrivages)"}
Sauf mention contraire : occasion, boîte automatique, essence. Consommation indicative : PCX environ 2 L/100 km, Forza 350 environ 3,4 L/100 km.

CONNAISSANCES GÉNÉRALES AUTORISÉES
Tu peux expliquer les différences générales entre modèles Honda (PCX 125, PCX 160, Forza 350, ADV) : usage en ville ou trajets plus longs, confort, puissance, coffre sous la selle, Smart Key et Idling Stop sur les PCX récents. Reste général ; pour un équipement précis d'un scooter du stock, propose de vérifier en boutique.

MESSAGES DU CONSEILLER
Dans l'historique, les messages qui commencent par « [Conseiller client] » ont été écrits par un conseiller de la concession. Ce qu'il a dit fait foi (prix accordé, rendez-vous, disponibilité) : reste cohérent avec lui et ne le contredis jamais.

RÈGLES STRICTES
- N'invente JAMAIS : prix, remise, disponibilité, kilométrage, année, équipement, horaires d'ouverture, moyens de paiement, crédit ou paiement en plusieurs fois, livraison, délais d'importation, papiers fournis. Si l'information n'est pas écrite ici, dis qu'un conseiller client va lui répondre très vite (et appelle l'outil enregistrer_contact avec le motif question-sans-reponse).
- Ne négocie jamais et n'accorde aucune remise : « Pour le prix, un conseiller client va vous répondre très vite. »
- Ne dis jamais qu'un scooter est réservé ou mis de côté.
- Reprise de l'ancien scooter : oui, la concession fait des reprises, mais la valeur est fixée uniquement après inspection en boutique. Aucune estimation chiffrée. Demande marque, modèle, année et kilométrage.
- Aucune information interne : prix d'achat, coûts, marges, numéros de châssis ou moteur, anciens propriétaires, autres clients.
- Reste sur le sujet de la concession (scooters, motos, équipements, entretien). Recentre poliment sinon.
- Si on te demande si tu es un robot : réponds honnêtement que tu es l'assistant automatique de la concession et qu'un conseiller client peut aussi lui répondre ici.
- Ne redirige jamais le client vers un autre numéro WhatsApp : tout se passe dans cette conversation.

OBJECTIF
1. Comprendre le besoin : budget, usage (ville, longs trajets, travail, zémidjan), modèle ou couleur préférés.
2. Proposer 1 à 3 scooters du stock qui correspondent, avec prix et un point fort chacun.
3. Inviter à venir voir et essayer au showroom de Godomey.
4. Obtenir le prénom et le moment où il compte passer (son numéro est déjà connu, ne le redemande pas).

PHOTOS
Tu peux envoyer les vraies photos d'un scooter du stock avec l'outil envoyer_photos (avec sa réf.). Utilise-le dès que le client demande des photos, ou quand il s'intéresse à un scooter précis. Maximum 2 scooters par message. Après l'envoi, écris une seule phrase courte (par exemple « Voici la PCX 125 bleue de 2022 en photos. Elle vous plaît ? »). Ne promets jamais de photos d'un scooter qui n'en a pas : dis alors qu'un conseiller client va vous en envoyer.

OUTIL enregistrer_contact
Appelle-le UNE fois dès que le client veut acheter, réserver, négocier, faire une reprise, prendre rendez-vous, se plaint, demande à parler à quelqu'un, ou pose une question à laquelle tu ne peux pas répondre — ou dès qu'il a donné son prénom et un scooter qui l'intéresse. Ensuite dis-lui : « Un conseiller client va vous répondre très vite. » Continue à répondre aux questions simples en attendant. Ne le rappelle pas dans la même conversation sauf si une information importante change.`;
}

const TOOLS = [
  {
    name: "enregistrer_contact",
    description: "Prévient le gérant qu'un client est intéressé ou qu'une demande nécessite un humain. Le numéro WhatsApp du client est ajouté automatiquement.",
    input_schema: {
      type: "object",
      properties: {
        prenom: { type: "string", description: "Prénom ou nom donné par le client, si connu" },
        motif: { type: "string", enum: ["achat", "reservation", "negociation", "reprise", "rendez-vous", "reclamation", "question-sans-reponse", "autre"] },
        interet: { type: "string", description: "Scooter(s) qui intéressent le client, avec la réf. si connue" },
        passage_prevu: { type: "string", description: "Quand le client compte passer au showroom, si indiqué" },
        resume: { type: "string", description: "Résumé en 1 à 3 phrases de la demande (budget, reprise proposée, question, etc.)" },
      },
      required: ["motif", "resume"],
    },
  },
  {
    name: "envoyer_photos",
    description: "Envoie au client, sur WhatsApp, les vraies photos d'un scooter du stock (issues du logiciel de gestion).",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Référence du scooter, ex. VEH-2026-0013" },
        nombre: { type: "integer", description: "Nombre de photos à envoyer (1 à 4, défaut 3)" },
      },
      required: ["ref"],
    },
  },
];

/* ------------------------------------------------------------------ */
/* Photos des scooters                                                 */
/* ------------------------------------------------------------------ */

async function sendPhotos(env, phone, ref, n, origin) {
  const max = Math.min(Math.max(Number(n) || 3, 1), 4);
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.mime, v.ref, v.brand, v.model, v.displacement, v.year, v.color
       FROM photos p JOIN vehicles v ON v.id = p.owner_id
      WHERE p.owner_type = 'vehicle' AND v.ref = ? AND v.status = 'disponible' AND v.published = 1
      ORDER BY p.position, p.id LIMIT ?`
  ).bind(String(ref || "").trim().toUpperCase(), max).all();
  const rows = (results || []).filter((r) => /jpe?g|png/i.test(r.mime || ""));
  if (!rows.length) return `aucune photo disponible pour ${ref} — dis au client qu'un conseiller client va lui en envoyer`;
  const v = rows[0];
  const caption = `${vehicleLabel(v)}${v.year ? " " + v.year : ""}${v.color ? " — " + v.color.toLowerCase() : ""}`;
  if (isTest(phone)) return `mode test : ${rows.length} photo(s) de ${caption} seraient envoyées au client`;
  let sent = 0;
  for (let i = 0; i < rows.length; i++) {
    try {
      const wamid = (await graph(env, { to: phone, type: "image", image: { link: `${origin}/photo/${rows[i].id}`, ...(i === 0 ? { caption } : {}) } }))?.messages?.[0]?.id;
      await recordMessage(env, { phone, author: "agent", content: `📷 Photo ${i + 1}/${rows.length} : ${caption}`, wamid, status: "sent" });
      sent++;
    } catch (e) { console.error("photo", e.message); }
  }
  return sent ? `${sent} photo(s) de ${caption} envoyée(s) au client` : "l'envoi des photos a échoué — dis au client qu'un conseiller client va les lui envoyer";
}

async function servePhoto(env, id) {
  const row = await env.DB.prepare(
    `SELECT p.mime, p.data FROM photos p JOIN vehicles v ON v.id = p.owner_id
      WHERE p.id = ? AND p.owner_type = 'vehicle' AND v.published = 1`
  ).bind(Number(id) || 0).first();
  if (!row || !row.data) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(row.data), { headers: { "content-type": row.mime || "image/jpeg", "cache-control": "public, max-age=86400" } });
}

/* ------------------------------------------------------------------ */
/* Claude                                                              */
/* ------------------------------------------------------------------ */

async function callClaude(env, system, messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: cfg(env, "CLAUDE_MODEL"), max_tokens: 700, system, tools: TOOLS, messages }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return res.json();
}

async function runClaude(env, system, history, phone, profileName, origin) {
  const messages = [...history];
  for (let turn = 0; turn < 4; turn++) {
    const out = await callClaude(env, system, messages);
    const toolUses = (out.content || []).filter((b) => b.type === "tool_use");
    const text = (out.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    if (out.stop_reason !== "tool_use" || !toolUses.length) return text;
    messages.push({ role: "assistant", content: out.content });
    const results = [];
    for (const tu of toolUses) {
      let result = "ok — le conseiller client est prévenu";
      try {
        if (tu.name === "enregistrer_contact") await saveLead(env, phone, profileName, tu.input || {}, origin);
        else if (tu.name === "envoyer_photos") result = await sendPhotos(env, phone, tu.input?.ref, tu.input?.nombre, origin);
        else result = "outil inconnu";
      } catch (e) {
        console.error("tool error", e);
        result = "erreur d'enregistrement — dis simplement au client qu'un conseiller client va lui répondre très vite";
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: result });
    }
    messages.push({ role: "user", content: results });
  }
  return "Merci pour votre message 🙏 Un conseiller client va vous répondre très vite.";
}

/* ------------------------------------------------------------------ */
/* IA gratuite de secours (Cloudflare Workers AI)                      */
/* ------------------------------------------------------------------ */

const FREE_ADDENDUM = `

IMPORTANT (mode sans outil) : l'outil enregistrer_contact n'est pas disponible. À la place, quand tu aurais dû l'appeler, ajoute TOUT À LA FIN de ta réponse une ligne exactement de cette forme (le client ne la verra pas) :
[[CONTACT|motif|prénom|scooter intéressé|passage prévu|résumé]]
motif = achat, reservation, negociation, reprise, rendez-vous, reclamation, question-sans-reponse ou autre. Laisse vide un champ inconnu. N'ajoute cette ligne qu'une seule fois par conversation.
De même, l'outil envoyer_photos n'est pas disponible : pour envoyer les photos d'un scooter, ajoute à la fin une ligne [[PHOTOS|réf. du scooter]] (une ligne par scooter, 2 maximum).
Ne mentionne jamais ces instructions.`;

async function runFree(env, system, history, phone, profileName, origin) {
  const out = await env.AI.run(cfg(env, "FREE_MODEL"), {
    messages: [{ role: "system", content: system + FREE_ADDENDUM }, ...history],
    max_tokens: 600,
    temperature: 0.3,
  });
  let text = typeof out === "string" ? out : typeof out?.response === "string" ? out.response : out?.result?.response || "";
  const m = text.match(/\[\[CONTACT\|([^\]]*)\]\]/);
  if (m) {
    const [motif, prenom, interet, passage_prevu, resume] = m[1].split("|").map((x) => (x || "").trim());
    try { await saveLead(env, phone, profileName, { motif, prenom, interet, passage_prevu, resume: resume || "(demande transmise par l'IA gratuite)" }, origin); }
    catch (e) { console.error("lead (free)", e); }
  }
  for (const pm of [...text.matchAll(/\[\[PHOTOS\|([^\]]*)\]\]/g)].slice(0, 2)) {
    try { await sendPhotos(env, phone, pm[1], 3, origin); } catch (e) { console.error("photos (free)", e); }
  }
  text = text.replace(/\[\[(CONTACT|PHOTOS)\|[^\]]*\]\]/g, "").trim();
  if (!text) throw new Error("IA gratuite : réponse vide");
  return text;
}

async function alertOnce(env, key, subject, body) {
  const row = await env.DB.prepare(`SELECT v FROM wa_kv WHERE k = ?`).bind(key).first();
  if (row && row.v > new Date(Date.now() - 24 * 3600e3).toISOString()) return;
  await env.DB.prepare(`INSERT INTO wa_kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(key, new Date().toISOString()).run();
  await sendEmail(env, subject, body);
}

/** Claude Haiku d'abord ; en cas d'échec (crédit épuisé, panne), IA gratuite Cloudflare. */
async function runAgent(env, phone, profileName, history, origin) {
  const system = systemPrompt(env, await loadStock(env), profileName);
  let claudeError = null;
  if (env.ANTHROPIC_API_KEY) {
    try { return { text: await runClaude(env, system, history, phone, profileName, origin), engine: "claude" }; }
    catch (e) {
      claudeError = e;
      console.error("claude", e.message);
      if (/credit balance|billing|insufficient/i.test(e.message || ""))
        await alertOnce(env, "credit_alert", "⚠️ Crédit Claude épuisé — l'agent WhatsApp est passé en mode gratuit",
          "Le crédit Claude de l'agent WhatsApp est épuisé. L'agent continue de répondre avec l'IA gratuite de Cloudflare (environ 100 réponses par jour).\n\nPour revenir à Claude : platform.claude.com → Ajouter des fonds.").catch(() => {});
    }
  }
  if (env.AI) return { text: await runFree(env, system, history, phone, profileName, origin), engine: "gratuit" };
  throw claudeError || new Error("Aucune IA configurée (ni ANTHROPIC_API_KEY, ni liaison AI)");
}

const cleanReply = (t) => (t || "").replace(/\*\*(.+?)\*\*/g, "*$1*").replace(/^#+\s*/gm, "").trim();

/* ------------------------------------------------------------------ */
/* Base : contacts, messages, prospects                                */
/* ------------------------------------------------------------------ */

async function upsertContact(env, phone, name) {
  await env.DB.prepare(
    `INSERT INTO wa_contacts (phone, name) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET name = COALESCE(excluded.name, wa_contacts.name)`
  ).bind(phone, name || null).run();
  return env.DB.prepare(`SELECT * FROM wa_contacts WHERE phone = ?`).bind(phone).first();
}

async function recordMessage(env, m) {
  const r = await env.DB.prepare(
    `INSERT INTO wa_messages (phone, role, author, content, wamid, media_id, media_type, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(m.phone, m.author === "client" ? "user" : "assistant", m.author, String(m.content).slice(0, 4000), m.wamid || null,
         m.media_id || null, m.media_type || null, m.status || null).run();
  const snippet = (m.author === "client" ? "" : m.author === "agent" ? "🤖 " : "Vous : ") + String(m.content).slice(0, 120);
  await env.DB.prepare(
    `UPDATE wa_contacts SET last_at = datetime('now'), last_text = ?,
       unread = unread + ?, last_client_at = CASE WHEN ? THEN datetime('now') ELSE last_client_at END WHERE phone = ?`
  ).bind(snippet, m.author === "client" ? 1 : 0, m.author === "client" ? 1 : 0, m.phone).run();
  return r;
}

const isPaused = (c) => !!(c && c.paused_until && c.paused_until > nowSql());

async function loadHistory(env, phone) {
  const { results } = await env.DB.prepare(
    `SELECT role, author, content FROM wa_messages WHERE phone = ? AND created_at >= datetime('now', '-3 days') ORDER BY id DESC LIMIT ?`
  ).bind(phone, cfg(env, "HISTORY_MESSAGES")).all();
  const msgs = [];
  for (const r of (results || []).reverse()) {
    const content = r.author === "gerant" ? `[Conseiller client] ${r.content}` : r.content;
    if (!msgs.length && r.role !== "user") continue; // Claude veut commencer par le client
    const last = msgs[msgs.length - 1];
    if (last && last.role === r.role) last.content += "\n" + content;
    else msgs.push({ role: r.role, content });
  }
  return msgs;
}

async function userMsgsToday(env, phone) {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM wa_messages WHERE phone = ? AND author = 'client' AND created_at >= datetime('now', '-1 day')`
  ).bind(phone).first();
  return r ? Number(r.n) : 0;
}

async function sendEmail(env, subject, text) {
  if (!env.RESEND_API_KEY) return;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: cfg(env, "FROM_EMAIL"), to: [cfg(env, "NOTIFY_EMAIL")], subject: subject.slice(0, 150), text }),
  });
  if (!r.ok) console.error("resend", r.status, await r.text());
}

async function saveLead(env, phone, profileName, i, origin) {
  await env.DB.prepare(
    `INSERT INTO wa_leads (phone, profile_name, first_name, reason, interest, visit, summary) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(phone, profileName || null, i.prenom || null, i.motif || null, i.interet || null, i.passage_prevu || null, i.resume || null).run();
  const who = i.prenom || profileName || "+" + phone;
  const motif = i.motif ? i.motif[0].toUpperCase() + i.motif.slice(1) : "Contact";
  await sendEmail(env,
    `${isTest(phone) ? "[TEST] " : ""}📲 ${motif} — ${who}${i.interet ? " — " + i.interet : ""}`,
    [
      `Nouveau contact WhatsApp — ${i.motif || "demande"}`, ``,
      `Client : ${i.prenom || profileName || "(prénom non donné)"}`,
      `Numéro : +${phone}`,
      i.interet ? `Intéressé par : ${i.interet}` : null,
      i.passage_prevu ? `Passage prévu : ${i.passage_prevu}` : null, ``,
      `Résumé : ${i.resume || ""}`, ``,
      origin ? `Répondre au client : ${origin}/inbox#${phone}` : null,
      `— Assistant WhatsApp Bécane et Équipement`,
    ].filter((l) => l !== null).join("\n"));
}

async function notifyNewMessage(env, contact, text, origin, why) {
  const every = Number(cfg(env, "NOTIFY_EVERY_MIN"));
  const since = new Date(Date.now() - every * 60e3).toISOString().slice(0, 19).replace("T", " ");
  if (contact.notified_at && contact.notified_at > since) return;
  await env.DB.prepare(`UPDATE wa_contacts SET notified_at = datetime('now') WHERE phone = ?`).bind(contact.phone).run();
  await sendEmail(env, `💬 ${contact.name || "+" + contact.phone} vous a écrit`,
    `${why}\n\n${contact.name || ""} (+${contact.phone}) : « ${String(text).slice(0, 500)} »\n\n${origin ? "Répondre : " + origin + "/inbox#" + contact.phone : ""}`);
}

/* ------------------------------------------------------------------ */
/* WhatsApp (Graph API)                                                */
/* ------------------------------------------------------------------ */

async function graph(env, body) {
  const res = await fetch(`https://graph.facebook.com/${cfg(env, "GRAPH_VERSION")}/${env.WHATSAPP_PHONE_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("whatsapp", res.status, JSON.stringify(data));
    const err = new Error(data?.error?.message || `WhatsApp ${res.status}`);
    err.code = data?.error?.code;
    throw err;
  }
  return data;
}
async function sendText(env, to, text) {
  const d = await graph(env, { to, type: "text", text: { preview_url: true, body: text.slice(0, 4000) } });
  return d?.messages?.[0]?.id || null;
}
const markRead = (env, id) => graph(env, { status: "read", message_id: id }).catch(() => {});

/** Envoi d'une réponse de l'agent : enregistrée puis envoyée. */
async function agentSay(env, phone, text) {
  let wamid = null, status = "sent";
  try { wamid = await sendText(env, phone, text); } catch (e) { status = "failed"; }
  await recordMessage(env, { phone, author: "agent", content: text, wamid, status });
}

function describeIncoming(m) {
  switch (m.type) {
    case "text": return { text: m.text?.body || "" };
    case "button": return { text: m.button?.text || "" };
    case "interactive": return { text: m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || "" };
    case "image": return { text: m.image?.caption ? `📷 ${m.image.caption}` : "📷 Photo", media_id: m.image?.id, media_type: "image", readable: !!m.image?.caption };
    case "audio": return { text: "🎤 Message vocal", media_id: m.audio?.id, media_type: "audio", readable: false };
    case "video": return { text: m.video?.caption ? `🎬 ${m.video.caption}` : "🎬 Vidéo", media_id: m.video?.id, media_type: "video", readable: !!m.video?.caption };
    case "document": return { text: `📄 ${m.document?.filename || "Document"}`, media_id: m.document?.id, media_type: "document", readable: false };
    case "sticker": return { text: "Autocollant", media_id: m.sticker?.id, media_type: "image", readable: false };
    case "location": return { text: `📍 Position partagée${m.location?.name ? " : " + m.location.name : ""}` };
    default: return { text: `(${m.type})`, readable: false };
  }
}

async function handleMessage(env, m, profile, origin) {
  const phone = m.from;
  const seen = await env.DB.prepare(`INSERT OR IGNORE INTO wa_seen (wamid) VALUES (?)`).bind(m.id).run();
  if (seen.meta && seen.meta.changes === 0) return; // déjà reçu (Meta renvoie parfois)

  const contact = await upsertContact(env, phone, profile?.name);
  const d = describeIncoming(m);
  if (!d.text.trim()) return;
  await recordMessage(env, { phone, author: "client", content: d.text, wamid: m.id, media_id: d.media_id, media_type: d.media_type });

  // Le gérant a pris la main : l'agent se tait, on prévient le gérant.
  if (isPaused(contact)) {
    await notifyNewMessage(env, contact, d.text, origin, "L'agent est en pause pour ce client : c'est à vous de répondre.");
    return;
  }
  await markRead(env, m.id);

  if (d.readable === false) {
    const msg = m.type === "audio"
      ? "Merci pour votre message vocal 🙏 Je suis l'assistant automatique et je ne lis que l'écrit : pouvez-vous m'écrire votre question ? Sinon, un conseiller client va vous répondre très vite."
      : "Merci ! Je ne lis que les messages écrits : pouvez-vous m'écrire votre question ? Sinon, un conseiller client va vous répondre très vite.";
    await agentSay(env, phone, msg);
    await notifyNewMessage(env, contact, d.text, origin, "Le client a envoyé un vocal, une photo ou un fichier que l'agent ne peut pas lire.");
    return;
  }

  const max = Number(cfg(env, "MAX_USER_MSGS_PER_DAY"));
  const n = await userMsgsToday(env, phone);
  if (n > max) return;
  if (n === max) {
    await agentSay(env, phone, "Merci pour tous vos messages 🙏 Un conseiller client va vous répondre très vite.");
    await notifyNewMessage(env, contact, d.text, origin, "Ce client a envoyé beaucoup de messages aujourd'hui : l'agent s'arrête et vous laisse la main.");
    return;
  }

  let reply;
  try {
    reply = cleanReply((await runAgent(env, phone, contact?.name, await loadHistory(env, phone), origin)).text);
  } catch (e) {
    console.error(e);
    reply = "Merci pour votre message 🙏 Un conseiller client va vous répondre très vite.";
    await notifyNewMessage(env, contact, d.text, origin, "L'agent n'a pas pu répondre (Claude indisponible ou crédit épuisé) : répondez vous-même.");
  }
  // Si le gérant a pris la main pendant que l'agent réfléchissait, on n'envoie rien.
  const fresh = await env.DB.prepare(`SELECT paused_until FROM wa_contacts WHERE phone = ?`).bind(phone).first();
  if (reply && !isPaused(fresh)) await agentSay(env, phone, reply);
}

async function handleStatus(env, s) {
  const map = { sent: "sent", delivered: "delivered", read: "read", failed: "failed" };
  if (!map[s.status]) return;
  // ne jamais redescendre (read > delivered > sent)
  const rank = { sent: 1, delivered: 2, read: 3, failed: 4 };
  const row = await env.DB.prepare(`SELECT id, status FROM wa_messages WHERE wamid = ?`).bind(s.id).first();
  if (!row) return;
  if ((rank[row.status] || 0) >= rank[s.status] && s.status !== "failed") return;
  await env.DB.prepare(`UPDATE wa_messages SET status = ? WHERE id = ?`).bind(map[s.status], row.id).run();
}

/* ------------------------------------------------------------------ */
/* Sécurité                                                            */
/* ------------------------------------------------------------------ */

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
async function validSignature(env, raw, header) {
  if (!env.APP_SECRET) return true;
  if (!header || !header.startsWith("sha256=")) return false;
  return safeEqual(header.slice(7), await hmacHex(env.APP_SECRET, raw));
}
const inboxPassword = (env) => env.INBOX_PASSWORD || env.VERIFY_TOKEN || "";
const sessionToken = async (env) => hmacHex(inboxPassword(env), "becane-inbox-v1");
async function authed(env, request) {
  if (!inboxPassword(env)) return false;
  const m = (request.headers.get("cookie") || "").match(/(?:^|;\s*)bx=([a-f0-9]{64})/);
  return !!m && safeEqual(m[1], await sessionToken(env));
}

/* ------------------------------------------------------------------ */
/* Boîte de réception                                                  */
/* ------------------------------------------------------------------ */

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function inboxApi(env, request, url, origin) {
  const path = url.pathname.replace(/^\/inbox\/api\//, "");

  if (request.method === "GET" && path === "conversations") {
    const { results } = await env.DB.prepare(
      `SELECT c.phone, c.name, c.unread, c.last_at, c.last_text, c.last_client_at, c.paused_until,
              EXISTS(SELECT 1 FROM wa_leads l WHERE l.phone = c.phone) AS lead
         FROM wa_contacts c WHERE c.phone NOT LIKE 'test%' AND c.last_at IS NOT NULL ORDER BY c.last_at DESC LIMIT 300`
    ).all();
    const now = nowSql();
    return json({ now, conversations: (results || []).map((c) => ({ ...c, paused: !!(c.paused_until && c.paused_until > now) })) });
  }

  if (request.method === "GET" && path === "messages") {
    const phone = url.searchParams.get("phone") || "";
    const after = Number(url.searchParams.get("after") || 0);
    const { results } = await env.DB.prepare(
      `SELECT id, author, content, media_id, media_type, status, created_at FROM wa_messages WHERE phone = ? AND id > ? ORDER BY id ASC LIMIT 500`
    ).bind(phone, after).all();
    // statuts mis à jour des 50 derniers messages envoyés
    const { results: st } = await env.DB.prepare(
      `SELECT id, status FROM wa_messages WHERE phone = ? AND author != 'client' ORDER BY id DESC LIMIT 50`
    ).bind(phone).all();
    await env.DB.prepare(`UPDATE wa_contacts SET unread = 0 WHERE phone = ?`).bind(phone).run();
    const contact = await env.DB.prepare(`SELECT phone, name, paused_until, last_client_at FROM wa_contacts WHERE phone = ?`).bind(phone).first();
    const leads = (await env.DB.prepare(`SELECT reason, interest, visit, summary, created_at FROM wa_leads WHERE phone = ? ORDER BY id DESC LIMIT 3`).bind(phone).all()).results || [];
    const now = nowSql();
    return json({
      now, messages: results || [], statuses: st || [], leads,
      contact: contact ? { ...contact, paused: !!(contact.paused_until && contact.paused_until > now) } : null,
    });
  }

  if (request.method === "POST" && path === "send") {
    const { phone, text } = await request.json().catch(() => ({}));
    const body = String(text || "").trim();
    if (!phone || !body) return json({ error: "Message vide" }, 400);
    const c = await env.DB.prepare(`SELECT * FROM wa_contacts WHERE phone = ?`).bind(phone).first();
    if (!c) return json({ error: "Conversation inconnue" }, 404);
    const windowOpen = c.last_client_at && c.last_client_at > new Date(Date.now() - 24 * 3600e3).toISOString().slice(0, 19).replace("T", " ");
    if (!windowOpen) return json({ error: "Le client ne vous a pas écrit depuis plus de 24 h : WhatsApp n'autorise pas à lui écrire librement. Attendez qu'il vous réécrive, ou appelez-le." }, 409);
    // l'agent se met en pause pour ce client
    const until = c.paused_until === FOREVER ? FOREVER : plusHoursSql(Number(cfg(env, "PAUSE_HOURS")));
    await env.DB.prepare(`UPDATE wa_contacts SET paused_until = ? WHERE phone = ?`).bind(until, phone).run();
    let wamid;
    try { wamid = await sendText(env, phone, body); }
    catch (e) {
      const msg = e.code === 131047 ? "Plus de 24 h depuis le dernier message du client : WhatsApp refuse l'envoi." : `Envoi refusé par WhatsApp : ${e.message}`;
      return json({ error: msg }, 502);
    }
    await recordMessage(env, { phone, author: "gerant", content: body, wamid, status: "sent" });
    return json({ ok: true, paused_until: until });
  }

  if (request.method === "POST" && path === "agent") {
    const { phone, action } = await request.json().catch(() => ({}));
    const value = action === "pause" ? FOREVER : null;
    await env.DB.prepare(`UPDATE wa_contacts SET paused_until = ? WHERE phone = ?`).bind(value, phone).run();
    return json({ ok: true, paused: action === "pause" });
  }

  return json({ error: "Not found" }, 404);
}

async function mediaProxy(env, id) {
  const meta = await fetch(`https://graph.facebook.com/${cfg(env, "GRAPH_VERSION")}/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}` } });
  if (!meta.ok) return new Response("Média introuvable (les médias WhatsApp expirent après quelques semaines)", { status: 404 });
  const { url, mime_type } = await meta.json();
  const file = await fetch(url, { headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}` } });
  if (!file.ok) return new Response("Média indisponible", { status: 404 });
  return new Response(file.body, { headers: { "content-type": mime_type || file.headers.get("content-type") || "application/octet-stream", "cache-control": "private, max-age=86400" } });
}

const LOGIN_PAGE = (error) => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp Bécane</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b141a;font-family:system-ui,sans-serif;color:#e9edef}
form{background:#202c33;padding:28px 22px;border-radius:14px;width:min(340px,90vw);display:flex;flex-direction:column;gap:12px}
h1{font-size:18px;margin:0}p{margin:0;color:#8696a0;font-size:14px}.e{color:#f15c6d}
input{border:0;border-radius:10px;padding:13px;background:#2a3942;color:#e9edef;font-size:16px}
button{border:0;border-radius:10px;padding:13px;background:#00a884;color:#fff;font-weight:600;font-size:16px}
</style></head><body><form method="post" action="/inbox/login"><h1>Bécane et Équipement</h1><p>Boîte de réception WhatsApp</p>
${error ? '<p class="e">Mot de passe incorrect</p>' : ""}<input type="password" name="password" placeholder="Mot de passe" autofocus required>
<button>Entrer</button></form></body></html>`;

const INBOX_PAGE = String.raw`<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#202c33"><title>WhatsApp Bécane</title><style>
:root{--bg:#0b141a;--panel:#111b21;--head:#202c33;--in:#202c33;--agent:#0f3d36;--me:#005c4b;--txt:#e9edef;--mut:#8696a0;--acc:#00a884;--warn:#f0b232;--red:#f15c6d}
*{box-sizing:border-box}[hidden]{display:none!important}html,body{height:100%}body{margin:0;background:var(--bg);color:var(--txt);font:15px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
#app{display:flex;height:100%;max-width:1200px;margin:auto}
#side{width:380px;max-width:100%;display:flex;flex-direction:column;background:var(--panel);border-right:1px solid #222d34}
#main{flex:1;display:flex;flex-direction:column;min-width:0;background:var(--bg)}
header{background:var(--head);padding:12px 16px;display:flex;align-items:center;gap:12px;min-height:60px}
header h1{font-size:17px;margin:0;flex:1}header small{color:var(--mut);display:block;font-size:12.5px}
#list{overflow-y:auto;flex:1}
.conv{display:flex;gap:12px;padding:12px 16px;border-bottom:1px solid #1f2a30;cursor:pointer;align-items:center}
.conv:hover,.conv.on{background:#202c33}
.av{width:44px;height:44px;border-radius:50%;background:#2a3942;display:grid;place-items:center;font-weight:600;flex:none;color:#cfd8dc}
.cm{flex:1;min-width:0}.cr{display:flex;justify-content:space-between;gap:8px}.cn{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ct{color:var(--mut);font-size:12px;flex:none}.cs{color:var(--mut);font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.badge{background:var(--acc);color:#111;border-radius:10px;padding:0 7px;font-size:12px;font-weight:700;flex:none}
.tag{font-size:11px;padding:1px 6px;border-radius:6px;margin-left:6px;vertical-align:1px;font-weight:600}
.tag.p{background:#3b2f10;color:var(--warn)}.tag.l{background:#103b2f;color:#4fd1a5}
#empty{color:var(--mut);padding:30px;text-align:center}
#thread{flex:1;overflow-y:auto;padding:14px 4% 8px;display:flex;flex-direction:column;gap:4px}
.msg{max-width:min(78%,560px);padding:7px 10px 5px;border-radius:9px;white-space:pre-wrap;word-wrap:break-word;position:relative}
.msg.client{align-self:flex-start;background:var(--in);border-top-left-radius:2px}
.msg.agent{align-self:flex-end;background:var(--agent);border-top-right-radius:2px}
.msg.gerant{align-self:flex-end;background:var(--me);border-top-right-radius:2px}
.who{font-size:11.5px;font-weight:700;margin-bottom:2px;color:#7fd1bd}.msg.gerant .who{color:#b5f5d9}
.meta{font-size:11px;color:#a0b3bc;text-align:right;margin-top:2px}.meta .r{color:#53bdeb}.meta .f{color:var(--red)}
.msg img{max-width:100%;border-radius:6px;display:block;margin-bottom:4px}.msg audio{max-width:240px;display:block;margin-bottom:4px}
.day{align-self:center;background:#182229;color:var(--mut);font-size:12px;padding:4px 10px;border-radius:8px;margin:8px 0}
#bar{background:#182229;color:var(--mut);font-size:13px;padding:8px 14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
#bar b{color:var(--txt)}#bar .sp{flex:1}
.btn{border:0;border-radius:18px;padding:7px 14px;font-weight:600;font-size:13px;cursor:pointer}
.btn.pause{background:#3b2f10;color:var(--warn)}.btn.resume{background:var(--acc);color:#111}
#lead{background:#102a24;color:#bfe9dc;font-size:13px;padding:8px 14px;border-top:1px solid #1d3a32}
#compose{display:flex;gap:8px;padding:8px 10px calc(8px + env(safe-area-inset-bottom));background:var(--head);align-items:flex-end}
#compose textarea{flex:1;resize:none;border:0;border-radius:20px;padding:10px 14px;background:#2a3942;color:var(--txt);font:inherit;max-height:140px}
#compose button{border:0;width:46px;height:46px;border-radius:50%;background:var(--acc);color:#111;font-size:20px;flex:none;cursor:pointer}
#compose button:disabled{opacity:.4}#closed{background:#2b1d10;color:#ffd59a;font-size:13px;padding:10px 14px}
#err{background:#3a1418;color:#ffc0c7;font-size:13px;padding:8px 14px;display:none}
.back{background:none;border:0;color:var(--txt);font-size:22px;padding:0 4px;cursor:pointer}
a.call{color:var(--acc);text-decoration:none;font-size:20px}
#placeholder{flex:1;display:grid;place-items:center;color:var(--mut);text-align:center;padding:30px}
@media (max-width:800px){#side{width:100%;border:0}#main{display:none}body.chat #side{display:none}body.chat #main{display:flex}}
@media (min-width:801px){.back{display:none}}
</style></head><body>
<div id="app">
 <section id="side"><header><div class="av" style="background:#00a884;color:#111">B</div><h1>Bécane et Équipement<small>WhatsApp · +229 01 41 66 33 33</small></h1></header><div id="list"><div id="empty">Chargement…</div></div></section>
 <section id="main">
  <div id="placeholder">Choisissez une conversation.<br>L'agent répond seul ; dès que vous écrivez à un client, il se met en pause pour lui.</div>
  <header id="chead" hidden><button class="back" onclick="closeChat()">←</button><div class="av" id="cav"></div><h1 id="cname"></h1><a class="call" id="ccall" href="#" title="Appeler">📞</a></header>
  <div id="bar" hidden></div>
  <div id="lead" hidden></div>
  <div id="thread" hidden></div>
  <div id="err"></div>
  <div id="closed" hidden>Le client ne vous a pas écrit depuis plus de 24 h : WhatsApp n'autorise plus à lui écrire librement. Attendez qu'il vous réécrive, ou appelez-le.</div>
  <form id="compose" hidden><textarea id="txt" rows="1" placeholder="Écrire au client…"></textarea><button id="send" title="Envoyer">➤</button></form>
 </section>
</div>
<script>
var cur=null,lastId=0,convs=[],srvNow="",sending=false;
function $(i){return document.getElementById(i)}
function el(t,c,txt){var e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e}
function d(s){return s?new Date(s.replace(" ","T")+"Z"):null}
var TZ="Africa/Porto-Novo";
function hm(s){var x=d(s);return x?x.toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit",timeZone:TZ}):""}
function dayKey(s){var x=d(s);return x?x.toLocaleDateString("fr-FR",{timeZone:TZ}):""}
function dayLabel(s){var x=d(s),t=new Date();var k=dayKey(s);if(k===t.toLocaleDateString("fr-FR",{timeZone:TZ}))return"Aujourd'hui";var y=new Date(Date.now()-864e5);if(k===y.toLocaleDateString("fr-FR",{timeZone:TZ}))return"Hier";return x.toLocaleDateString("fr-FR",{weekday:"long",day:"numeric",month:"long",timeZone:TZ})}
function when(s){var x=d(s);if(!x)return"";return dayKey(s)===new Date().toLocaleDateString("fr-FR",{timeZone:TZ})?hm(s):x.toLocaleDateString("fr-FR",{day:"2-digit",month:"2-digit",timeZone:TZ})}
function fmtPhone(p){p=String(p);return p.indexOf("229")===0&&p.length===13?"+229 "+p.slice(3,5)+" "+p.slice(5,7)+" "+p.slice(7,9)+" "+p.slice(9,11)+" "+p.slice(11):"+"+p}
function nm(c){return c.name||fmtPhone(c.phone)}
function initials(c){var n=(c.name||"").trim();return n?n[0].toUpperCase():"#"}
async function api(p,o){var r=await fetch("/inbox/api/"+p,o);if(r.status===401||r.redirected){location.href="/inbox";throw new Error("auth")}var j=await r.json();if(!r.ok)throw new Error(j.error||("Erreur "+r.status));return j}
async function loadConvs(){try{var j=await api("conversations");convs=j.conversations;srvNow=j.now;renderList()}catch(e){}}
function renderList(){var L=$("list");L.innerHTML="";if(!convs.length){L.appendChild(el("div",null,"Aucune conversation pour l'instant."));L.firstChild.id="empty";return}
 convs.forEach(function(c){var r=el("div","conv"+(cur===c.phone?" on":""));r.onclick=function(){openChat(c.phone)};
  r.appendChild(el("div","av",initials(c)));var m=el("div","cm");var a=el("div","cr");var n=el("div","cn",nm(c));
  if(c.lead){n.appendChild(el("span","tag l","prospect"))}if(c.paused){n.appendChild(el("span","tag p","agent en pause"))}
  a.appendChild(n);a.appendChild(el("div","ct",when(c.last_at)));var b=el("div","cr");b.appendChild(el("div","cs",c.last_text||""));
  if(c.unread>0&&cur!==c.phone)b.appendChild(el("span","badge",String(c.unread)));m.appendChild(a);m.appendChild(b);r.appendChild(m);L.appendChild(r)})}
function openChat(p){cur=p;lastId=0;$("thread").innerHTML="";location.hash=p;document.body.classList.add("chat");
 ["chead","thread","compose","bar"].forEach(function(i){$(i).hidden=false});$("placeholder").hidden=true;$("err").style.display="none";
 var c=convs.find(function(x){return x.phone===p})||{phone:p};$("cname").textContent=nm(c);$("cav").textContent=initials(c);$("ccall").href="tel:+"+p;
 loadMsgs();renderList();$("txt").focus()}
function closeChat(){cur=null;location.hash="";document.body.classList.remove("chat");["chead","thread","compose","bar","lead","closed"].forEach(function(i){$(i).hidden=true});$("placeholder").hidden=false;loadConvs()}
var MOTIF={achat:"Veut acheter",reservation:"Veut réserver",negociation:"Négociation","reprise":"Reprise","rendez-vous":"Rendez-vous",reclamation:"Réclamation","question-sans-reponse":"Question pour vous",autre:"Demande"};
var STAT={sent:"✓",delivered:"✓✓",read:"✓✓",failed:"⚠ non envoyé"};
function bubble(m){var b=el("div","msg "+m.author);b.dataset.id=m.id;
 if(m.author==="agent")b.appendChild(el("div","who","🤖 Assistant"));if(m.author==="gerant")b.appendChild(el("div","who","Vous"));
 if(m.media_id&&m.media_type==="image"){var i=el("img");i.loading="lazy";i.src="/inbox/media/"+encodeURIComponent(m.media_id);b.appendChild(i)}
 if(m.media_id&&m.media_type==="audio"){var a=el("audio");a.controls=true;a.preload="none";a.src="/inbox/media/"+encodeURIComponent(m.media_id);b.appendChild(a)}
 if(m.media_id&&(m.media_type==="video"||m.media_type==="document")){var l=el("a",null,"Ouvrir le fichier");l.href="/inbox/media/"+encodeURIComponent(m.media_id);l.target="_blank";l.style.color="#53bdeb";b.appendChild(l);b.appendChild(el("br"))}
 b.appendChild(document.createTextNode(m.content));var mt=el("div","meta",hm(m.created_at));
 if(m.author!=="client"&&m.status){var s=el("span",m.status==="read"?"r":m.status==="failed"?"f":"", " "+STAT[m.status]);s.dataset.st="1";mt.appendChild(s)}
 b.appendChild(mt);return b}
var lastDay="";
async function loadMsgs(){if(!cur)return;var p=cur;try{var j=await api("messages?phone="+encodeURIComponent(p)+"&after="+lastId);if(p!==cur)return;
 var T=$("thread"),atEnd=T.scrollHeight-T.scrollTop-T.clientHeight<80,first=lastId===0;if(first)lastDay="";
 j.messages.forEach(function(m){var k=dayKey(m.created_at);if(k!==lastDay){T.appendChild(el("div","day",dayLabel(m.created_at)));lastDay=k}T.appendChild(bubble(m));lastId=m.id});
 j.statuses.forEach(function(s){var b=T.querySelector('[data-id="'+s.id+'"] .meta');if(!b||!s.status)return;var o=b.querySelector("[data-st]");if(o)o.remove();var n=el("span",s.status==="read"?"r":s.status==="failed"?"f":""," "+STAT[s.status]);n.dataset.st="1";b.appendChild(n)});
 var c=j.contact||{};renderBar(c);var open=c.last_client_at&&(d(j.now)-d(c.last_client_at))<24*3600e3;$("closed").hidden=!!open;$("compose").hidden=!open;
 var L=$("lead");if(j.leads&&j.leads.length){var x=j.leads[0];L.hidden=false;L.textContent="⭐ "+(MOTIF[x.reason]||x.reason||"Prospect")+(x.interest?" — "+x.interest:"")+(x.visit?" — passage : "+x.visit:"")+(x.summary?"\n"+x.summary:"");L.style.whiteSpace="pre-wrap"}else L.hidden=true;
 if(first||(j.messages.length&&atEnd))T.scrollTop=T.scrollHeight
 }catch(e){}}
function renderBar(c){var B=$("bar");B.innerHTML="";var s=el("span");
 if(c.paused){var forever=String(c.paused_until).indexOf("9999")===0;s.innerHTML="";s.appendChild(document.createTextNode("Agent "));s.appendChild(el("b",null,"en pause"));s.appendChild(document.createTextNode(forever?" — vous gérez ce client":" jusqu'à "+hm(c.paused_until)+" — vous gérez ce client"))}
 else{s.appendChild(document.createTextNode("Agent "));s.appendChild(el("b",null,"actif"));s.appendChild(document.createTextNode(" — il répond à ce client"))}
 B.appendChild(s);B.appendChild(el("span","sp"));var btn=el("button","btn "+(c.paused?"resume":"pause"),c.paused?"Réactiver l'agent":"Mettre en pause");
 btn.onclick=async function(){btn.disabled=true;try{await api("agent",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({phone:cur,action:c.paused?"resume":"pause"})});await loadMsgs();loadConvs()}catch(e){showErr(e.message)}btn.disabled=false};B.appendChild(btn)}
function showErr(t){var E=$("err");E.textContent=t;E.style.display="block";setTimeout(function(){E.style.display="none"},8000)}
$("compose").onsubmit=async function(e){e.preventDefault();var t=$("txt").value.trim();if(!t||sending||!cur)return;sending=true;$("send").disabled=true;
 try{await api("send",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({phone:cur,text:t})});$("txt").value="";autoGrow();await loadMsgs();var T=$("thread");T.scrollTop=T.scrollHeight;loadConvs()}catch(x){showErr(x.message)}
 sending=false;$("send").disabled=false};
function autoGrow(){var t=$("txt");t.style.height="auto";t.style.height=Math.min(t.scrollHeight,140)+"px"}
$("txt").addEventListener("input",autoGrow);
$("txt").addEventListener("keydown",function(e){if(e.key==="Enter"&&!e.shiftKey&&window.innerWidth>800){e.preventDefault();$("compose").requestSubmit()}});
window.addEventListener("hashchange",function(){var h=location.hash.slice(1);if(h&&h!==cur)openChat(h)});
loadConvs().then(function(){var h=location.hash.slice(1);if(h)openChat(h)});
setInterval(loadConvs,5000);setInterval(loadMsgs,3000);
</script></body></html>`;

/* ------------------------------------------------------------------ */
/* Page de test (sans WhatsApp)                                        */
/* ------------------------------------------------------------------ */

const TEST_PAGE = String.raw`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Test de l'agent</title><style>
body{font-family:system-ui,sans-serif;background:#0b141a;margin:0;color:#e9edef}
header{background:#202c33;padding:14px 16px;font-weight:600}header small{display:block;font-weight:400;color:#8696a0}
#c{padding:16px;display:flex;flex-direction:column;gap:8px;max-width:720px;margin:auto;padding-bottom:90px}
.m{max-width:80%;padding:8px 11px;border-radius:8px;white-space:pre-wrap;line-height:1.4;font-size:15px}
.u{align-self:flex-start;background:#202c33}.a{align-self:flex-end;background:#0f3d36}
form{position:fixed;bottom:0;left:0;right:0;background:#202c33;display:flex;gap:8px;padding:10px}
input{flex:1;border:0;border-radius:20px;padding:11px 14px;background:#2a3942;color:#e9edef;font-size:16px}
button{border:0;border-radius:20px;padding:0 18px;background:#00a884;color:#111;font-weight:600}
</style></head><body><header>Test de l'assistant<small>Vous jouez le client. Rien n'est envoyé sur WhatsApp.</small></header>
<div id="c"></div><form id="f"><input id="i" placeholder="Écrivez comme un client…" autocomplete="off"><button>Envoyer</button></form>
<script>
var sid="test"+Math.floor(Math.random()*1e9),c=document.getElementById("c"),i=document.getElementById("i");
function add(t,k){var d=document.createElement("div");d.className="m "+k;d.textContent=t;c.appendChild(d);scrollTo(0,1e9);return d}
document.getElementById("f").onsubmit=async function(e){e.preventDefault();var t=i.value.trim();if(!t)return;i.value="";add(t,"u");var w=add("…","a");
try{var r=await fetch("/test",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({from:sid,text:t})});var j=await r.json();w.textContent=(j.reply||j.error)+(j.engine?"\n\n— "+(j.engine==="claude"?"Claude":"IA gratuite"):"")}catch(x){w.textContent="Erreur : "+x}scrollTo(0,1e9)};
</script></body></html>`;

/* ------------------------------------------------------------------ */
/* Politique de confidentialité (exigée par Meta)                      */
/* ------------------------------------------------------------------ */

const PRIVACY_PAGE = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Confidentialité — Assistant WhatsApp Bécane et Équipement</title><style>
body{font-family:system-ui,sans-serif;max-width:760px;margin:auto;padding:24px 16px;line-height:1.6;color:#0b1a33;background:#fff}
h1{font-size:1.5rem}h2{font-size:1.1rem;margin-top:1.6em}</style></head><body>
<h1>Politique de confidentialité — Assistant WhatsApp</h1>
<p><b>BÉCANE ET ÉQUIPEMENT SARL</b>, Godomey, Abomey-Calavi, Bénin — contact@becaneetequipement.com — +229 01 41 66 33 33.</p>
<h2>Ce que nous recevons</h2>
<p>Quand vous nous écrivez sur WhatsApp au +229 01 41 66 33 33, nous recevons votre numéro, votre nom de profil WhatsApp et le contenu de vos messages (texte, photos, messages vocaux).</p>
<h2>Pourquoi</h2>
<p>Uniquement pour répondre à vos questions sur nos scooters, motos et services, et pour vous recontacter au sujet de votre demande (achat, reprise, rendez-vous). Nous ne vendons pas vos données et ne les utilisons pas pour de la publicité.</p>
<h2>Assistant automatique</h2>
<p>Les premières réponses peuvent être rédigées par un assistant automatique. Vos messages sont alors transmis à notre prestataire d'intelligence artificielle (Anthropic) uniquement pour produire la réponse. Un conseiller client peut reprendre la conversation à tout moment.</p>
<h2>Conservation et sécurité</h2>
<p>Les conversations sont conservées dans notre logiciel de gestion hébergé chez Cloudflare, accessible uniquement par la concession, le temps nécessaire au suivi commercial de votre demande.</p>
<h2>Vos droits</h2>
<p>Vous pouvez demander à consulter, corriger ou supprimer vos données à tout moment : écrivez « supprimer mes données » sur WhatsApp ou à contact@becaneetequipement.com. Nous traitons la demande dans les meilleurs délais.</p>
</body></html>`;

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

const html = (s, status = 200, extra = {}) => new Response(s, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...extra } });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = url.origin;
    await ensureSchema(env);

    // 1) Vérification du webhook par Meta
    if (request.method === "GET" && url.pathname === "/webhook") {
      if (url.searchParams.get("hub.mode") === "subscribe" && env.VERIFY_TOKEN && url.searchParams.get("hub.verify_token") === env.VERIFY_TOKEN)
        return new Response(url.searchParams.get("hub.challenge") || "", { status: 200 });
      return new Response("Forbidden", { status: 403 });
    }

    // 2) Messages et statuts entrants
    if (request.method === "POST" && url.pathname === "/webhook") {
      const raw = await request.text();
      if (!(await validSignature(env, raw, request.headers.get("x-hub-signature-256")))) return new Response("Bad signature", { status: 401 });
      let body;
      try { body = JSON.parse(raw); } catch { return new Response("ok"); }
      const jobs = [];
      for (const entry of body.entry || [])
        for (const change of entry.changes || []) {
          const v = change.value || {};
          if (env.WHATSAPP_PHONE_ID && v.metadata?.phone_number_id && v.metadata.phone_number_id !== env.WHATSAPP_PHONE_ID) continue;
          for (const m of v.messages || []) {
            const profile = (v.contacts || []).find((c) => c.wa_id === m.from)?.profile;
            jobs.push(handleMessage(env, m, profile, origin).catch((e) => console.error("message", e)));
          }
          for (const s of v.statuses || []) jobs.push(handleStatus(env, s).catch((e) => console.error("status", e)));
        }
      ctx.waitUntil(Promise.all(jobs));
      return new Response("ok");
    }

    // 3) Boîte de réception
    if (url.pathname === "/inbox/login" && request.method === "POST") {
      const form = await request.formData().catch(() => null);
      const pw = form ? String(form.get("password") || "") : "";
      if (!inboxPassword(env) || !safeEqual(pw, inboxPassword(env))) return html(LOGIN_PAGE(true), 401);
      const next = url.searchParams.get("next") === "test" ? "/test" : "/inbox";
      return new Response(null, { status: 303, headers: { location: next, "set-cookie": `bx=${await sessionToken(env)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${90 * 86400}` } });
    }
    if (url.pathname === "/inbox" || url.pathname.startsWith("/inbox/")) {
      const ok = await authed(env, request);
      if (url.pathname === "/inbox") return ok ? html(INBOX_PAGE) : html(LOGIN_PAGE(false));
      if (!ok) return json({ error: "Non connecté" }, 401);
      if (url.pathname.startsWith("/inbox/api/")) return inboxApi(env, request, url, origin);
      if (url.pathname.startsWith("/inbox/media/")) return mediaProxy(env, decodeURIComponent(url.pathname.slice(13)));
      if (url.pathname === "/inbox/logout") return new Response(null, { status: 303, headers: { location: "/inbox", "set-cookie": "bx=; Path=/; Max-Age=0" } });
    }

    // 4) Page de test (même connexion que la boîte de réception)
    if (url.pathname === "/test") {
      if (!(await authed(env, request))) return request.method === "GET" ? html(LOGIN_PAGE(false).replace('action="/inbox/login"', 'action="/inbox/login?next=test"')) : json({ error: "Non connecté" }, 401);
      if (request.method === "GET") return html(TEST_PAGE);
      if (request.method === "POST") {
        const { from, text } = await request.json().catch(() => ({}));
        const phone = "test" + String(from || "").replace(/[^0-9]/g, "").slice(0, 12);
        await upsertContact(env, phone, "Client test");
        await recordMessage(env, { phone, author: "client", content: String(text || "").slice(0, 2000) });
        try {
          const out = await runAgent(env, phone, "Client test", await loadHistory(env, phone), origin);
          const reply = cleanReply(out.text);
          await recordMessage(env, { phone, author: "agent", content: reply || "(pas de réponse)" });
          return json({ reply, engine: out.engine });
        } catch (e) {
          return json({ error: String(e.message || e) }, 500);
        }
      }
    }

    if (url.pathname === "/confidentialite") return html(PRIVACY_PAGE);
    if (request.method === "GET" && url.pathname.startsWith("/photo/")) return servePhoto(env, url.pathname.slice(7));
    if (url.pathname === "/") return new Response("Assistant WhatsApp Bécane et Équipement — en ligne ✅  ·  Boîte de réception : /inbox  ·  Test : /test", { headers: { "content-type": "text/plain; charset=utf-8" } });
    return new Response("Not found", { status: 404 });
  },
};
