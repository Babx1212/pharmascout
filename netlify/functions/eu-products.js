/**
 * PharmaScout — Netlify Function : EU Products v2
 * Sources :
 *   FR → open-medicaments.fr  (API JSON sur les CSV BDPM/ANSM, mise à jour 2x/jour)
 *   ES → CIMA REST API v1.23   (cima.aemps.es)
 *   PT → graceful empty (INFARMED sans API JSON publique)
 *   BE → graceful empty (SAM/FAMHP sans API JSON publique)
 */

const https = require('https');

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type'
};

// ─── Helper HTTP GET ────────────────────────────────────────────────────────
function httpGet(url, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'PharmaScout/1.0 (pharmacovigilance research tool)',
        'Accept': 'application/json'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch(e) {
          resolve({ status: res.statusCode, body: null });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// ─── France — open-medicaments.fr (wrape les CSV BDPM/ANSM) ─────────────────
// Docs : https://open-medicaments.fr  |  GET /api/v1/medicaments?query={q}
async function fetchFrance(substance) {
  try {
    const url = `https://open-medicaments.fr/api/v1/medicaments?query=${encodeURIComponent(substance)}&rdisplay=false`;
    const res = await httpGet(url);
    if (res.status === 200 && Array.isArray(res.body)) {
      return res.body.slice(0, 40).map(p => ({
        name:   p.denomination || '',
        holder: (p.titulaires || []).map(t => t.nom).join(', ') || '',
        status: p.etatCommercialisation || p.statutAdministratifAMM || 'Autorisé'
      })).filter(p => p.name);
    }
  } catch(e) {
    console.warn('France fetch error:', e.message);
  }
  return null;
}

// ─── Espagne — CIMA REST API v1.23 (AEMPS) ──────────────────────────────────
// Docs : https://cima.aemps.es/cima/rest/  |  GET /medicamentos?practiv1={q}
async function fetchSpain(substance) {
  try {
    const url = `https://cima.aemps.es/cima/rest/medicamentos?practiv1=${encodeURIComponent(substance)}&pageSize=30&pageNumber=1`;
    const res = await httpGet(url);
    if (res.status === 200 && res.body) {
      const items = res.body.resultados || [];
      return items.map(p => ({
        name:   p.nombre || '',
        holder: p.labtitular || '',
        status: p.estado?.nombre || 'Autorizado'
      })).filter(p => p.name);
    }
  } catch(e) {
    console.warn('Spain fetch error:', e.message);
  }
  return null;
}

// ─── Portugal — INFARMED (pas d'API JSON publique) ───────────────────────────
async function fetchPortugal(substance) {
  // INFARMED (INFOMED) ne dispose pas d'une API JSON ouverte sans authentification.
  // Les données sont disponibles sur demande formelle (infarmed@infarmed.pt).
  return null;
}

// ─── Belgique — SAM/FAMHP (pas d'API JSON publique) ─────────────────────────
async function fetchBelgium(substance) {
  // Le SAM/CBIP belge ne dispose pas d'une API REST publique.
  return null;
}

// ─── Handler principal ───────────────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: HEADERS, body: '' };
  }

  const substance = (event.queryStringParameters?.substance || '').trim().toLowerCase();
  const country   = (event.queryStringParameters?.country   || '').trim().toLowerCase();

  if (!substance) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Substance manquante' }) };
  }

  const COUNTRY_META = {
    fr: { source: 'BDPM / ANSM',   fetch: fetchFrance   },
    es: { source: 'CIMA / AEMPS',  fetch: fetchSpain    },
    pt: { source: 'INFARMED',      fetch: fetchPortugal  },
    be: { source: 'SAM / FAMHP',   fetch: fetchBelgium  }
  };

  const meta = COUNTRY_META[country];
  if (!meta) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Pays non supporté: ' + country }) };
  }

  try {
    const products = await meta.fetch(substance);

    const countryData = products === null
      ? { country, source: meta.source, products: [], total: 0, note: 'Source non disponible via API publique' }
      : { country, source: meta.source, products, total: products.length };

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ countries: [countryData] })
    };
  } catch(err) {
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ countries: [{ country, source: meta.source, products: [], total: 0, error: err.message }] })
    };
  }
};
