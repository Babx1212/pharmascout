/**
 * PharmaScout — Netlify Function : EU Products v3
 * Sources :
 *   FR → BDPM officiel (streaming CSV CIS_COMPO + CIS — telechargement.php)
 *   ES → CIMA REST API v1.23 (cima.aemps.es — practiv1)
 *   PT → graceful empty (INFARMED sans API publique)
 *   BE → graceful empty (SAM/FAMHP sans API publique)
 */

const https = require('https');
const zlib  = require('zlib');

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type'
};

// ─── Helper : stream lignes d'une URL texte (encoding latin1) ───────────────
function streamLines(url, onLine, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'PharmaScout/1.0',
        'Accept-Encoding': 'gzip, deflate',
        'Accept': 'text/plain'
      }
    };
    const req = https.request(options, (res) => {
      // Gérer la redirection 302
      if (res.statusCode === 301 || res.statusCode === 302) {
        streamLines(res.headers.location, onLine, timeoutMs).then(resolve).catch(reject);
        return;
      }
      let stream = res;
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
      if (enc === 'deflate') stream = res.pipe(zlib.createInflate());

      let buf = '';
      stream.on('data', chunk => {
        // BDPM files are ISO-8859-1
        buf += chunk.toString('latin1');
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const l of lines) { if (onLine(l) === 'STOP') { req.destroy(); resolve(); return; } }
      });
      stream.on('end', () => { if (buf) onLine(buf); resolve(); });
      stream.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('stream timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// ─── Helper : GET JSON ───────────────────────────────────────────────────────
function httpGetJson(url, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const req = https.request({
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      timeout: timeoutMs,
      headers: { 'User-Agent': 'PharmaScout/1.0', 'Accept': 'application/json' }
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: null }); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// ─── France — BDPM officiel (streaming CSV) ──────────────────────────────────
// CIS_COMPO_bdpm.txt : colonnes tab-séparées
//   0:codeCIS  3:denomSubstance  (identifie la DCI)
// CIS_bdpm.txt : colonnes tab-séparées
//   0:codeCIS  1:denomination  6:etatCommercialisation  10:titulaire
const BDPM_COMPO = 'https://base-donnees-publique.medicaments.gouv.fr/telechargement.php?fichier=CIS_COMPO_bdpm.txt';
const BDPM_CIS   = 'https://base-donnees-publique.medicaments.gouv.fr/telechargement.php?fichier=CIS_bdpm.txt';

async function fetchFrance(substance) {
  try {
    const substLower = substance.toLowerCase();
    const cisCodes   = new Set();

    // Passe 1 : trouver les codes CIS contenant la substance
    await streamLines(BDPM_COMPO, line => {
      const p = line.split('\t');
      if (p.length >= 4 && p[3].toLowerCase().includes(substLower)) {
        cisCodes.add(p[0].trim());
      }
    });

    if (cisCodes.size === 0) return [];

    const products = [];
    // Passe 2 : récupérer les détails des spécialités
    await streamLines(BDPM_CIS, line => {
      const p = line.split('\t');
      if (p.length >= 11 && cisCodes.has(p[0].trim())) {
        products.push({
          name:   (p[1]  || '').trim(),
          holder: (p[10] || '').trim(),
          status: (p[6]  || 'Autorisé').trim()
        });
      }
    });

    return products.filter(p => p.name).slice(0, 40);
  } catch(e) {
    console.warn('France BDPM error:', e.message);
    return null;
  }
}

// ─── Espagne — CIMA REST API v1.23 (AEMPS) ──────────────────────────────────
async function fetchSpain(substance) {
  try {
    const url = `https://cima.aemps.es/cima/rest/medicamentos?practiv1=${encodeURIComponent(substance)}&pageSize=30&pageNumber=1`;
    const res = await httpGetJson(url);
    if (res.status === 200 && res.body) {
      return (res.body.resultados || []).map(p => ({
        name:   p.nombre     || '',
        holder: p.labtitular || '',
        status: p.estado?.nombre || 'Autorizado'
      })).filter(p => p.name);
    }
  } catch(e) {
    console.warn('Spain CIMA error:', e.message);
  }
  return null;
}

// ─── Portugal — pas d'API publique ──────────────────────────────────────────
async function fetchPortugal() { return null; }

// ─── Belgique — pas d'API publique ──────────────────────────────────────────
async function fetchBelgium()  { return null; }

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

  const SOURCES = {
    fr: { label: 'BDPM / ANSM',  fetch: () => fetchFrance(substance)  },
    es: { label: 'CIMA / AEMPS', fetch: () => fetchSpain(substance)   },
    pt: { label: 'INFARMED',     fetch: () => fetchPortugal()          },
    be: { label: 'SAM / FAMHP',  fetch: () => fetchBelgium()           }
  };

  const meta = SOURCES[country];
  if (!meta) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Pays non supporté: ' + country }) };
  }

  try {
    const products = await meta.fetch();
    const countryData = !products
      ? { country, source: meta.label, products: [], total: 0, note: 'Source non disponible via API publique' }
      : { country, source: meta.label, products, total: products.length };

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ countries: [countryData] }) };
  } catch(err) {
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ countries: [{ country, source: meta.label, products: [], total: 0, error: err.message }] })
    };
  }
};
