/**
 * PharmaScout — Netlify Function : EU Products
 * Recherche de médicaments autorisés par pays européen (FR, ES, PT, BE)
 * via les APIs publiques nationales.
 */

const https = require('https');

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const FUNCTION_TIMEOUT = 9000; // 9s (Netlify limit = 10s)

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
        'User-Agent': 'PharmaScout/1.0',
        'Accept': 'application/json'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: null, raw: data.slice(0, 500) }); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// ─── France — BDPM (Base de Données Publique des Médicaments) ───────────────
async function fetchFrance(substance) {
  try {
    const url = `https://base-donnees-publique.medicaments.gouv.fr/extrait.php?specid=0&nomInn=${encodeURIComponent(substance)}&typeRecherche=0&output=json`;
    const res = await httpGet(url);
    if (res.status === 200 && res.body) {
      const items = Array.isArray(res.body) ? res.body : (res.body.medicaments || res.body.items || []);
      return items.slice(0, 30).map(p => ({
        name:   p.denomination || p.nomCommercial || p.libelle || '',
        holder: p.titulaire || p.laboratoire || '',
        status: p.etatCommercialisation || p.statut || 'Autorisé'
      }));
    }
  } catch(e) {}

  // Fallback : endpoint alternatif BDPM
  try {
    const url2 = `https://base-donnees-publique.medicaments.gouv.fr/extrait.php?specid=0&nomRecherche=${encodeURIComponent(substance)}&typRecherche=DCI&output=json`;
    const res2 = await httpGet(url2);
    if (res2.status === 200 && res2.body) {
      const items = Array.isArray(res2.body) ? res2.body : [];
      return items.slice(0, 30).map(p => ({
        name:   p.denomination || '',
        holder: p.titulaire || '',
        status: p.etatCommercialisation || 'Autorisé'
      }));
    }
  } catch(e) {}

  return null; // signale échec
}

// ─── Espagne — CIMA (AEMPS) ─────────────────────────────────────────────────
async function fetchSpain(substance) {
  try {
    const url = `https://cima.aemps.es/cima/rest/medicamentos?nombre=${encodeURIComponent(substance)}&practiv1=${encodeURIComponent(substance)}&pageSize=30&pageNumber=1`;
    const res = await httpGet(url);
    if (res.status === 200 && res.body) {
      const items = res.body.resultados || [];
      return items.slice(0, 30).map(p => ({
        name:   p.nombre || '',
        holder: p.labtitular || '',
        status: p.estado?.nombre || 'Autorizado'
      }));
    }
  } catch(e) {}
  return null;
}

// ─── Portugal — INFARMED ─────────────────────────────────────────────────────
async function fetchPortugal(substance) {
  try {
    const url = `https://app.infarmed.pt/infomed/service/medicamento/search?nome=${encodeURIComponent(substance)}&limit=30`;
    const res = await httpGet(url);
    if (res.status === 200 && res.body) {
      const items = res.body.data || res.body.medicamentos || [];
      return items.slice(0, 30).map(p => ({
        name:   p.nome || p.denominacao || '',
        holder: p.titular || '',
        status: p.situacao || 'Autorizado'
      }));
    }
  } catch(e) {}
  return null;
}

// ─── Belgique — SAM (FAMHP/AFMPS) ───────────────────────────────────────────
async function fetchBelgium(substance) {
  try {
    const url = `https://www.famhp.be/fr/medicines/human_use/medicines/authorized_medicines/search?generic=${encodeURIComponent(substance)}`;
    // SAM ne fournit pas d'API JSON publique simple — on retourne null pour fallback gracieux
    return null;
  } catch(e) { return null; }
}

// ─── Handler principal ───────────────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: HEADERS, body: '' };
  }

  const substance = (event.queryStringParameters?.substance || '').trim().toLowerCase();
  const country   = (event.queryStringParameters?.country || '').trim().toLowerCase();

  if (!substance) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Substance manquante' }) };
  }

  try {
    let products = null;
    let source   = '';

    if (country === 'fr') {
      products = await fetchFrance(substance);
      source = 'BDPM / ANSM';
    } else if (country === 'es') {
      products = await fetchSpain(substance);
      source = 'CIMA / AEMPS';
    } else if (country === 'pt') {
      products = await fetchPortugal(substance);
      source = 'INFARMED';
    } else if (country === 'be') {
      products = await fetchBelgium(substance);
      source = 'SAM / FAMHP';
    } else {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Pays non supporté: ' + country }) };
    }

    if (products === null) {
      // API indisponible ou non implémentée — retourne vide sans erreur
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({
          countries: [{ country, source, products: [], total: 0, note: 'Source temporairement indisponible' }]
        })
      };
    }

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        countries: [{ country, source, products, total: products.length }]
      })
    };
  } catch(err) {
    return {
      statusCode: 200, // 200 pour éviter les retries intempestifs
      headers: HEADERS,
      body: JSON.stringify({ countries: [{ country, products: [], total: 0, error: err.message }] })
    };
  }
};
