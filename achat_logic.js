// Calculs partagés avec la page du Bureau d'achat.
/* Logique pure de l'application (testée avec Node, puis collée dans la page). */
const EUR_XOF = 655.957;
const CURRENCIES = {
  IDR: { name: "Roupie indonésienne", unit: 1000 },
  USD: { name: "Dollar américain", unit: 1 },
  EUR: { name: "Euro", unit: 1, fixed: EUR_XOF },
  CNY: { name: "Yuan chinois", unit: 1 },
  THB: { name: "Baht thaïlandais", unit: 1 },
  XOF: { name: "Franc CFA", unit: 1, fixed: 1 },
};
const num = (v) => { const n = Number(String(v ?? "").replace(/\s/g, "").replace(",", ".")); return Number.isFinite(n) && n > 0 ? n : 0; };
const roundUp5k = (n) => Math.ceil(n / 5000) * 5000;

/**
 * Coût de revient et rentabilité d'une opération d'importation.
 * rate / usdRate : FCFA pour 1 unité de la devise. Montants « lot » pour toute l'opération, « U » par unité.
 */
function computeCost(i) {
  const q = Math.max(0, Math.floor(num(i.qty)));
  const rate = num(i.rate), usd = num(i.usdRate);
  const achat = q * num(i.unitPrice) * rate;
  const change = achat * num(i.fxPct) / 100;
  const prep = q * num(i.prepU);
  let fournisseur = 0, fret = 0, arrivee = 0;
  if (i.mode === "rapide") arrivee = q * num(i.approachU);
  else {
    fournisseur = (num(i.localFees) + num(i.inland) + num(i.exportDocs)) * rate;
    fret = (num(i.freight) + num(i.insurance)) * usd;
    arrivee = num(i.port) + num(i.transit) + num(i.duties) + num(i.vat) + num(i.lastMile) + num(i.other);
  }
  const total = achat + fournisseur + fret + arrivee + prep + change;
  const revient = q ? total / q : 0;
  const venteU = num(i.saleU);
  const ca = venteU * q;
  const marge = ca - total;
  return {
    q, achat, fournisseur, fret, arrivee, prep, change, total, revient, venteU, ca, marge,
    margeU: venteU ? venteU - revient : 0,
    tauxSurCout: total && venteU ? marge / total : 0,
    tauxSurVente: ca ? marge / ca : 0,
    seuil: venteU ? Math.ceil(total / venteU) : 0,
    prixConseille: revient ? roundUp5k(revient * (1 + num(i.targetPct) / 100)) : 0,
    ok: q > 0 && num(i.unitPrice) > 0 && rate > 0,
    missing: [q ? null : "la quantité", num(i.unitPrice) ? null : "le prix d'achat", rate ? null : "le taux de change",
      i.mode !== "rapide" && (num(i.freight) + num(i.insurance)) > 0 && !usd ? "le taux du dollar" : null].filter(Boolean),
  };
}

function vehicleLabel(v) {
  const brand = String(v.brand || "").trim();
  const B = brand ? brand[0].toUpperCase() + brand.slice(1).toLowerCase() : "";
  const model = String(v.model || "").trim();
  const M = model.toUpperCase();
  const cc = Number(v.displacement) || 0;
  if (M.includes("PCX")) return `${B} PCX ${cc >= 145 ? "160" : "125"}`;
  if (M.includes("FORZA")) return `${B} Forza ${cc >= 700 ? "750" : cc >= 320 ? "350" : cc >= 250 ? "300" : "125"}`;
  if (M.includes("ADV")) return `${B} ADV ${cc >= 300 ? "350" : "160"}`;
  return `${B} ${model}${cc ? " " + cc + " cm³" : ""}`.trim();
}
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const daysBetween = (a, b) => { const d = (Date.parse(String(b).slice(0, 10)) - Date.parse(String(a).slice(0, 10))) / 864e5; return Number.isFinite(d) && d >= 0 ? d : null; };

/** Chiffres réels par modèle et année, à partir des lignes du logiciel (véhicules + vente éventuelle). */
function concessionStats(rows) {
  const groups = new Map();
  const add = (key, label, year, r) => {
    if (!groups.has(key)) groups.set(key, { key, label, year, rows: [] });
    groups.get(key).rows.push(r);
  };
  for (const r of rows || []) {
    const label = vehicleLabel(r);
    add("*", "Tous les modèles", null, r);
    add(label, label, null, r);
    if (r.year) add(label + "|" + r.year, label, Number(r.year), r);
  }
  const n0 = (v) => Number(v) || 0;
  return [...groups.values()].map((g) => {
    const sold = g.rows.filter((r) => n0(r.sold) > 0);
    const withCost = g.rows.filter((r) => n0(r.cost_purchase) > 0);
    const full = (r) => n0(r.cost_purchase) + n0(r.cost_transport) + n0(r.cost_customs) + n0(r.prep);
    const soldCost = sold.filter((r) => n0(r.cost_purchase) > 0);
    const delays = sold.map((r) => daysBetween(r.created_at, r.sale_date)).filter((d) => d !== null);
    return {
      key: g.key, label: g.label, year: g.year,
      nVehicles: g.rows.length, nSold: sold.length,
      inStock: g.rows.filter((r) => r.status === "disponible").length,
      avgPurchase: Math.round(avg(withCost.map((r) => n0(r.cost_purchase)))),
      avgTransport: Math.round(avg(withCost.map((r) => n0(r.cost_transport)))),
      avgCustoms: Math.round(avg(withCost.map((r) => n0(r.cost_customs)))),
      avgPrep: Math.round(avg(withCost.map((r) => n0(r.prep)))),
      avgSold: Math.round(avg(sold.map((r) => n0(r.sold)))),
      avgMargin: soldCost.length ? Math.round(avg(soldCost.map((r) => n0(r.sold) - full(r)))) : null,
      avgDays: delays.length ? Math.round(avg(delays)) : null,
    };
  }).sort((a, b) => (a.key === "*" ? -1 : b.key === "*" ? 1 : a.label.localeCompare(b.label) || (a.year || 0) - (b.year || 0)));
}

/** Extrait les lignes d'une réponse du connecteur Cloudflare, quelle que soit son enveloppe. */
function extractRows(p) {
  if (typeof p === "string") { try { p = JSON.parse(p); } catch { return []; } }
  if (Array.isArray(p)) return Array.isArray(p[0]?.results) ? p[0].results : p.every((x) => x && typeof x === "object" && !("results" in x)) ? p : [];
  if (Array.isArray(p?.results)) return p.results;
  if (Array.isArray(p?.result)) return extractRows(p.result);
  return [];
}
/** Résultats de recherche web réduits à l'essentiel. */
function compactSearch(p, max = 6) {
  if (typeof p === "string") { try { p = JSON.parse(p); } catch { return [{ titre: "", url: "", extrait: p.slice(0, 1500) }]; } }
  const list = p?.data?.web || p?.web || (Array.isArray(p?.data) ? p.data : null) || (Array.isArray(p) ? p : null) || [];
  return list.slice(0, max).map((r) => ({
    titre: String(r.title || "").slice(0, 160), url: String(r.url || r.link || ""),
    extrait: String(r.description || r.snippet || r.markdown || "").replace(/\s+/g, " ").slice(0, 500),
  })).filter((r) => r.url);
}
const fcfa = (n) => (Number.isFinite(n) ? String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " FCFA" : "—");
const pct = (x) => (Number.isFinite(x) ? (x * 100).toFixed(1).replace(".", ",") + " %" : "—");

export { concessionStats, computeCost, vehicleLabel };
