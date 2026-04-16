/**
 * PharmaScout — Netlify Function : EU Products v9
 *
 * FR → BDPM REST API interne (/api/produit/by-substance-active)
 *       Découverte par reverse-engineering du bundle JS de la SPA BDPM (avril 2026)
 *       Paramètres requis : contains, query[], tag=substance, draw, columns[0][data], start, length
 *       Pas de CSV, pas de cache global — simple GET JSON par requête
 * ES → CIMA REST API v1.23 (AEMPS) — substance active (practiv1), multi-case
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

// Liens vers les bases nationales officielles
const COUNTRY_LINKS = {
  fr: 'https://base-donnees-publique.medicaments.gouv.fr/',
  es: 'https://cima.aemps.es/cima/publico/home.html',
  pt: 'https://extranet.infarmed.pt/INFOMED-fo/',
  be: 'https://www.famhp.be/en/human_use/medicines/medicines/information_about_medicines/authorised_medicines_in_belgium'
};

// ─── Cache session BDPM (cookie PHP de session, 25 min) ──────────────────────
let _bdpmCookie = null;   // { value: string, ts: number } | null
const BDPM_COOKIE_TTL = 25 * 60 * 1000; // 25min

// ─── Espagne — cache par substance (30min) ────────────────────────────────────
const _esCache = new Map();
const ES_CACHE_TTL = 30 * 60 * 1000;

// ─── Helper : GET HTTP/HTTPS, suit les redirections, retour Buffer ────────────
function httpGet(url, timeoutMs, extraHeaders) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch(e) { return reject(new Error('URL invalide: ' + url)); }

    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      timeout:  timeoutMs,
      headers: Object.assign({
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept':          'application/json, */*',
        'Accept-Encoding': 'gzip, deflate',
        'Accept-Language': 'fr-FR,fr;q=0.9'
      }, extraHeaders || {})
    };

    const req = https.request(options, (res) => {
      // Redirections
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        const loc = res.headers.location;
        if (!loc) return reject(new Error('Redirection sans Location'));
        const abs = loc.startsWith('http') ? loc : parsed.protocol + '//' + parsed.host + loc;
        return httpGet(abs, timeoutMs, extraHeaders).then(resolve).catch(reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode + ' pour ' + url.slice(0, 80)));
      }

      let stream = res;
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
      if (enc === 'deflate') stream = res.pipe(zlib.createInflate());

      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('timeout: ' + url.slice(0, 80))); });
    req.on('error', reject);
    req.end();
  });
}

// ─── Helper : GET HTTP/HTTPS + retourner headers de réponse ──────────────────
function httpGetWithHeaders(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch(e) { return reject(new Error('URL invalide: ' + url)); }

    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      timeout:  timeoutMs,
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':          'text/html,application/xhtml+xml,*/*',
        'Accept-Encoding': 'gzip, deflate',
        'Accept-Language': 'fr-FR,fr;q=0.9'
      }
    };

    const req = https.request(options, (res) => {
      res.resume(); // on ne lit pas le body, juste les headers
      resolve({ statusCode: res.statusCode, headers: res.headers });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('timeout session BDPM')); });
    req.on('error', reject);
    req.end();
  });
}

// ─── Helper : GET JSON ────────────────────────────────────────────────────────
async function httpGetJson(url, timeoutMs, extraHeaders) {
  const buf = await httpGet(url, timeoutMs, extraHeaders);
  return JSON.parse(buf.toString('utf8'));
}

// ─── Obtenir (ou renouveler) le cookie de session BDPM ───────────────────────
async function getBdpmSessionCookie() {
  if (_bdpmCookie && (Date.now() - _bdpmCookie.ts) < BDPM_COOKIE_TTL) {
    return _bdpmCookie.value;
  }
  try {
    const { headers } = await httpGetWithHeaders('https://base-donnees-publique.medicaments.gouv.fr/', 8000);
    const setCookie = headers['set-cookie'];
    if (setCookie) {
      // Extraire seulement nom=valeur (sans les attributs Path, HttpOnly, etc.)
      const cookieStr = Array.isArray(setCookie)
        ? setCookie.map(c => c.split(';')[0]).join('; ')
        : setCookie.split(';')[0];
      _bdpmCookie = { value: cookieStr, ts: Date.now() };
      console.log('[BDPM] Cookie session obtenu: ' + cookieStr.slice(0, 40));
      return cookieStr;
    }
  } catch(e) {
    console.warn('[BDPM] Impossible d\'obtenir le cookie de session: ' + e.message);
  }
  return null;
}

// ─── France — BDPM REST API interne ──────────────────────────────────────────
// Endpoint découvert par reverse-engineering du bundle JS de la SPA BDPM (avril 2026)
// URL : /api/produit/by-substance-active?contains=X&query[]=X&tag=substance&...
// Réponse JSON : { data: [{SpecDenom01, SpecId, StatutBdm, SpecGeneDenom, ...}], recordsTotal, ... }
async function fetchFrance(substance) {
  // 1. Obtenir le cookie de session BDPM (l'API semble le requérir)
  const cookie = await getBdpmSessionCookie();

  // 2. Construire l'URL avec les paramètres exacts requis par le DataTable BDPM
  const sub = encodeURIComponent(substance);
  const url = 'https://base-donnees-publique.medicaments.gouv.fr/api/produit/by-substance-active'
    + '?contains=' + sub
    + '&query%5B%5D=' + sub
    + '&tag=substance'
    + '&draw=1&page=1&limit=100&start=0&length=100'
    + '&columns%5B0%5D%5Bdata%5D=SpecDenom01'
    + '&columns%5B0%5D%5Bname%5D='
    + '&columns%5B0%5D%5Bsearchable%5D=true'
    + '&columns%5B0%5D%5Borderable%5D=false'
    + '&columns%5B0%5D%5Bsearch%5D%5Bvalue%5D='
    + '&columns%5B0%5D%5Bsearch%5D%5Bregex%5D=false'
    + '&search%5Bvalue%5D=&search%5Bregex%5D=false';

  const extraHeaders = {
    'Referer': 'https://base-donnees-publique.medicaments.gouv.fr/',
    'Origin':  'https://base-donnees-publique.medicaments.gouv.fr'
  };
  if (cookie) extraHeaders['Cookie'] = cookie;

  console.log('[BDPM] GET API substance: ' + substance);
  const data = await httpGetJson(url, 12000, extraHeaders);

  if (!data.data || !Array.isArray(data.data)) {
    console.log('[BDPM] Réponse inattendue: ' + JSON.stringify(data).slice(0, 100));
    return [];
  }

  console.log('[BDPM] ' + data.recordsTotal + ' produits pour: ' + substance);

  // StatutBdm : 1 = Commercialisé, 0 = Non commercialisé / retiré
  return data.data
    .filter(item => item.SpecDenom01)
    .map(item => ({
      name:   item.SpecDenom01,
      holder: '',
      status: item.StatutBdm === 1 ? 'Commercialisé' : 'Non commercialisé'
    }));
}

// ─── Espagne — CIMA REST API v1.23 ───────────────────────────────────────────
// Tente lowercase, Titlecase, UPPERCASE si 0 résultat (CIMA est case-sensitive)
async function fetchSpain(substance) {
  // Cache par substance
  const cached = _esCache.get(substance);
  if (cached && (Date.now() - cached.ts) < ES_CACHE_TTL) {
    console.log('[CIMA] Cache hit: ' + substance);
    return cached.products;
  }

  const toTitle = s => s.replace(/\b\w/g, c => c.toUpperCase());
  const variants = [...new Set([substance.toLowerCase(), toTitle(substance), substance.toUpperCase()])];
  let gotAnyOk = false;

  for (const v of variants) {
    try {
      const url = 'https://cima.aemps.es/cima/rest/medicamentos?practiv1=' + encodeURIComponent(v) + '&pageSize=30&pageNumber=1';
      const data = await httpGetJson(url, 7000);
      gotAnyOk = true;
      const list = (data.resultados || []).map(p => ({
        name:   p.nombre     || '',
        holder: p.labtitular || '',
        status: p.estado?.nombre || 'Autorizado'
      })).filter(p => p.name);
      if (list.length > 0) {
        console.log('[CIMA] ' + list.length + ' résultats pour variant: ' + v);
        _esCache.set(substance, { products: list, ts: Date.now() });
        return list;
      }
      console.log('[CIMA] 0 résultat pour variant: ' + v);
    } catch(e) {
      console.warn('[CIMA] Erreur variant ' + v + ': ' + e.message);
    }
  }

  const result = gotAnyOk ? [] : null;
  if (result !== null) _esCache.set(substance, { products: result, ts: Date.now() });
  return result;
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
    fr: { label: 'BDPM / ANSM',  fetch: () => fetchFrance(substance) },
    es: { label: 'CIMA / AEMPS', fetch: () => fetchSpain(substance)  },
    pt: { label: 'INFARMED',     fetch: () => Promise.resolve(null)  },
    be: { label: 'SAM / FAMHP',  fetch: () => Promise.resolve(null)  }
  };

  const meta = SOURCES[country];
  if (!meta) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Pays non supporté: ' + country }) };
  }

  // Pays avec une API/données publiques accessibles (null = inaccessible, pas "pas d'API")
  const HAS_API = new Set(['fr', 'es']);

  try {
    const result = await meta.fetch();
    let countryData;

    if (result === null) {
      if (HAS_API.has(country)) {
        countryData = {
          country, source: meta.label,
          products: [], total: 0,
          error: meta.label + ' temporairement inaccessible.',
          link: COUNTRY_LINKS[country] || null
        };
      } else {
        // PT, BE — pas d'API JSON publique
        countryData = {
          country, source: meta.label,
          products: [], total: 0,
          note: 'Pas d\'API JSON publique disponible pour ce pays.',
          link: COUNTRY_LINKS[country] || null
        };
      }
    } else {
      const products = Array.isArray(result) ? result : [];
      countryData = {
        country, source: meta.label,
        products, total: products.length
      };
    }

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ countries: [countryData] }) };
  } catch(err) {
    console.error('[eu-products] Erreur ' + country + '/' + substance + ': ' + err.message);
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        countries: [{
          country, source: meta.label,
          products: [], total: 0,
          error: 'Données ' + meta.label + ' temporairement indisponibles (' + err.message.slice(0, 120) + ')',
          link: COUNTRY_LINKS[country] || null
        }]
      })
    };
  }
};
