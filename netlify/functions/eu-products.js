/**
 * PharmaScout — Netlify Function : EU Products v4
 *
 * FR → BDPM officiel (CIS_COMPO + CIS) avec cache Lambda 24h
 *       Téléchargements parallèles pour tenir dans le timeout Netlify (10s)
 * ES → CIMA REST API v1.23 (AEMPS) — substance active (practiv1)
 * PT → Graceful empty — INFARMED INFOMED sans API JSON publique ouverte
 * BE → Graceful empty — SAM/FAMHP sans API JSON publique ouverte
 */

const https = require('https');
const zlib  = require('zlib');

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type'
};

// ─── Cache module-level BDPM (warm Lambda — comme swissmedic-v2.js) ───────────
let _bdpmCache = { compo: null, cis: null, ts: 0 };
const BDPM_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

const BDPM_COMPO_URL = 'https://base-donnees-publique.medicaments.gouv.fr/telechargement.php?fichier=CIS_COMPO_bdpm.txt';
const BDPM_CIS_URL   = 'https://base-donnees-publique.medicaments.gouv.fr/telechargement.php?fichier=CIS_bdpm.txt';

// Liens de redirection vers les bases nationales (quand pas d'API)
const COUNTRY_LINKS = {
  pt: 'https://extranet.infarmed.pt/INFOMED-fo/',
  be: 'https://www.famhp.be/en/human_use/medicines/medicines/information_about_medicines/authorised_medicines_in_belgium'
};

// ─── Helper : télécharger un fichier texte CSV en entier (Latin-1) ────────────
function downloadTextFile(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const req = https.request({
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'PharmaScout/1.0',
        'Accept-Encoding': 'gzip, deflate',
        'Accept': 'text/plain'
      }
    }, (res) => {
      // Gérer les redirections
      if (res.statusCode === 301 || res.statusCode === 302) {
        res.resume();
        downloadTextFile(res.headers.location, timeoutMs).then(resolve).catch(reject);
        return;
      }
      let stream = res;
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
      if (enc === 'deflate') stream = res.pipe(zlib.createInflate());

      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
      stream.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// ─── Charger BDPM (avec cache 24h) ───────────────────────────────────────────
async function loadBdpmCache() {
  const now = Date.now();
  if (_bdpmCache.compo && _bdpmCache.cis && (now - _bdpmCache.ts) < BDPM_CACHE_TTL) {
    return _bdpmCache;
  }
  // Téléchargements en parallèle
  const [compoRaw, cisRaw] = await Promise.all([
    downloadTextFile(BDPM_COMPO_URL, 8000),
    downloadTextFile(BDPM_CIS_URL,   8000)
  ]);

  // Parser CIS_COMPO : CIS → Set of substances (champ idx 3, séparateur tab)
  const compoMap = new Map(); // CIS → [substanceName...]
  for (const line of compoRaw.split('\n')) {
    const p = line.split('\t');
    if (p.length >= 4 && p[0]) {
      const cis  = p[0].trim();
      const subst = (p[3] || '').trim().toLowerCase();
      if (!compoMap.has(cis)) compoMap.set(cis, []);
      compoMap.get(cis).push(subst);
    }
  }

  // Parser CIS_bdpm : CIS → { name, holder, status }
  const cisMap = new Map();
  for (const line of cisRaw.split('\n')) {
    const p = line.split('\t');
    if (p.length >= 11 && p[0]) {
      cisMap.set(p[0].trim(), {
        name:   (p[1]  || '').trim(),
        holder: (p[10] || '').trim(),
        status: (p[6]  || 'Autorisé').trim()
      });
    }
  }

  _bdpmCache = { compo: compoMap, cis: cisMap, ts: now };
  return _bdpmCache;
}

// ─── France — BDPM ────────────────────────────────────────────────────────────
async function fetchFrance(substance) {
  try {
    const cache = await loadBdpmCache();
    const substLower = substance.toLowerCase();

    // Trouver les CIS codes dont la composition contient la substance
    const matchingCIS = new Set();
    for (const [cis, substances] of cache.compo) {
      if (substances.some(s => s.includes(substLower))) {
        matchingCIS.add(cis);
      }
    }

    if (matchingCIS.size === 0) return [];

    // Récupérer les détails depuis CIS map
    const products = [];
    for (const cis of matchingCIS) {
      const prod = cache.cis.get(cis);
      if (prod && prod.name) {
        products.push({ ...prod });
      }
    }

    // Dédupliquer par nom (certains CIS ont plusieurs dosages)
    const seen = new Set();
    const deduped = products.filter(p => {
      // Clé = nom simplifié (jusqu'au premier chiffre ou virgule)
      const key = p.name.split(/[\d,]/)[0].trim().toUpperCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return deduped.slice(0, 40);
  } catch(e) {
    console.warn('France BDPM error:', e.message);
    return null; // null = erreur, pas de données
  }
}

// ─── Espagne — CIMA REST API v1.23 ───────────────────────────────────────────
async function fetchSpain(substance) {
  try {
    const url = `https://cima.aemps.es/cima/rest/medicamentos?practiv1=${encodeURIComponent(substance)}&pageSize=30&pageNumber=1`;
    const res = await httpGetJson(url, 7000);
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

// ─── Helper : GET JSON ────────────────────────────────────────────────────────
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

// ─── Handler principal ────────────────────────────────────────────────────────
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
    fr: { label: 'BDPM / ANSM', fetch: () => fetchFrance(substance) },
    es: { label: 'CIMA / AEMPS', fetch: () => fetchSpain(substance)  },
    pt: { label: 'INFARMED',    fetch: () => Promise.resolve(null)   },
    be: { label: 'SAM / FAMHP', fetch: () => Promise.resolve(null)   }
  };

  const meta = SOURCES[country];
  if (!meta) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Pays non supporté: ' + country }) };
  }

  try {
    const products = await meta.fetch();

    let countryData;
    if (products === null) {
      // Aucune API JSON publique disponible — message clair avec lien direct
      countryData = {
        country,
        source: meta.label,
        products: [],
        total: 0,
        note: 'Pas d\'API JSON publique disponible',
        link: COUNTRY_LINKS[country] || null
      };
    } else {
      countryData = {
        country,
        source: meta.label,
        products,
        total: products.length
      };
    }

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ countries: [countryData] }) };
  } catch(err) {
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        countries: [{
          country,
          source: meta.label,
          products: [],
          total: 0,
          error: err.message,
          link: COUNTRY_LINKS[country] || null
        }]
      })
    };
  }
};
