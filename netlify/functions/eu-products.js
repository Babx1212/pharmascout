/**
 * PharmaScout — Netlify Function : EU Products v7
 *
 * FR → BDPM HTML search par substance (remplace téléchargement CSV)
 *       Cache par substance 30min TTL — requête ciblée, User-Agent navigateur
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

// ─── Cache par substance pour la France (30min TTL) ──────────────────────────
const _frCache = new Map(); // substance → { products: [], ts: number }
const FR_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// ─── Helper : requête HTML avec User-Agent navigateur ────────────────────────
function fetchHtml(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch(e) { return reject(e); }
    const req = https.request({
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate',
        'Referer': 'https://base-donnees-publique.medicaments.gouv.fr/'
      }
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303) {
        res.resume();
        const loc = res.headers.location;
        if (!loc) return reject(new Error('Redirect sans Location'));
        const absLoc = loc.startsWith('http') ? loc : 'https://' + parsedUrl.hostname + loc;
        fetchHtml(absLoc, timeoutMs).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      let stream = res;
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
      if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout ' + url.slice(0,80))); });
    req.on('error', reject);
    req.end();
  });
}

// ─── Helper : décoder les entités HTML basiques ───────────────────────────────
function decodeHtml(s) {
  return (s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                  .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&eacute;/g, 'é')
                  .replace(/&egrave;/g, 'è').replace(/&agrave;/g, 'à').replace(/&ccedil;/g, 'ç')
                  .replace(/&nbsp;/g, ' ');
}

// ─── Parser HTML résultats BDPM ───────────────────────────────────────────────
// Extrait les produits depuis la page de résultats de recherche BDPM.
// Cherche les liens extrait.php?specif=CIS (présents dans toutes les versions du site).
function parseBdpmResults(html) {
  const products = [];
  const seen = new Set();

  // Pattern principal : href="extrait.php?specif=12345678..."  >NOM</a>
  const reLink = /href="extrait\.php\?specif=(\d{5,10})[^"]*"[^>]*>([\s\S]{2,120}?)<\/a/gi;
  let m;
  while ((m = reLink.exec(html)) !== null) {
    const raw  = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const name = decodeHtml(raw);
    if (!name || name.length < 4) continue;
    // Ignorer les textes de navigation (trop courts ou mots-clés UI)
    if (/^(retour|imprimer|haut|bas|suivant|précédent|accueil|\d+)$/i.test(name)) continue;
    const key = name.slice(0, 50).toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    products.push({ name, holder: '', status: 'Autorisé' });
  }

  return products.slice(0, 40);
}

// ─── France — BDPM HTML Search ────────────────────────────────────────────────
// Retourne :
//   []             → BDPM accessible, substance non trouvée
//   [products...]  → BDPM accessible, produits trouvés
//   { bdpmError }  → BDPM inaccessible (timeout, réseau, erreur serveur)
async function fetchFrance(substance) {
  // Cache par substance
  const cached = _frCache.get(substance);
  if (cached && (Date.now() - cached.ts) < FR_CACHE_TTL) {
    console.log('[BDPM] Cache hit: ' + substance + ' (' + cached.products.length + ' produits)');
    return cached.products;
  }

  const encSubst = encodeURIComponent(substance);

  // Essayer plusieurs URL de recherche BDPM (les deux interfaces historiques)
  const searchUrls = [
    // Interface principale — recherche par spécialité/DCI
    'https://base-donnees-publique.medicaments.gouv.fr/index.php?typRecherche=spec&spec=' + encSubst + '&btnRecherche=Rechercher',
    // Interface alternative — recherche par substance active
    'https://base-donnees-publique.medicaments.gouv.fr/index.php?typRecherche=sa&nomSA='  + encSubst + '&btnRecherche=Rechercher',
  ];

  let lastError = null;

  for (const url of searchUrls) {
    try {
      const html = await fetchHtml(url, 9000);
      if (!html || html.length < 300) continue;

      // Détecter explicitement "aucun résultat" → retourner [] (substance absente, pas erreur)
      if (/aucun.{0,60}r[eé]sultat|pas de m[eé]dicament|0 r[eé]sultat|aucune sp[eé]cialit/i.test(html)
          && !html.includes('extrait.php')) {
        console.log('[BDPM] 0 résultat valide pour: ' + substance);
        _frCache.set(substance, { products: [], ts: Date.now() });
        return [];
      }

      const products = parseBdpmResults(html);

      if (products.length > 0) {
        console.log('[BDPM] ' + products.length + ' produits via HTML pour: ' + substance);
        _frCache.set(substance, { products, ts: Date.now() });
        return products;
      }

      // Réponse valide mais aucun lien extrait.php → substance absente
      if (html.toLowerCase().includes('medicament') || html.toLowerCase().includes('bdpm')) {
        console.log('[BDPM] Page valide mais 0 produit parsé pour: ' + substance + ' (url: ' + url.slice(0,80) + ')');
        _frCache.set(substance, { products: [], ts: Date.now() });
        return [];
      }

      // Page inattendue, essayer URL suivante
      console.warn('[BDPM] Page inattendue (' + html.length + ' chars), essai URL suivante');
    } catch(e) {
      lastError = e;
      console.warn('[BDPM] Erreur URL ' + url.slice(0,80) + ' : ' + e.message);
    }
  }

  // Toutes les URL ont échoué
  console.warn('[BDPM] Toutes les URL ont échoué pour: ' + substance);
  return { bdpmError: lastError ? lastError.message : 'Serveur BDPM inaccessible' };
}

// ─── Espagne — CIMA REST API v1.23 ───────────────────────────────────────────
// Tente lowercase, Titlecase, UPPERCASE si 0 résultat (CIMA est case-sensitive)
// Retourne :
//   [products...]  → CIMA accessible, produits (ou [] si substance absente)
//   null           → CIMA inaccessible (toutes les tentatives ont échoué)
async function fetchSpain(substance) {
  const toTitle = s => s.replace(/\b\w/g, c => c.toUpperCase());
  const variants = [...new Set([substance.toLowerCase(), toTitle(substance), substance.toUpperCase()])];
  let gotAnyOk = false;

  for (const v of variants) {
    try {
      const url = 'https://cima.aemps.es/cima/rest/medicamentos?practiv1=' + encodeURIComponent(v) + '&pageSize=30&pageNumber=1';
      const res = await httpGetJson(url, 7000);
      if (res.status === 200 && res.body) {
        gotAnyOk = true;
        const list = (res.body.resultados || []).map(p => ({
          name:   p.nombre     || '',
          holder: p.labtitular || '',
          status: p.estado?.nombre || 'Autorizado'
        })).filter(p => p.name);
        if (list.length > 0) {
          console.log('[CIMA] ' + list.length + ' résultats pour variant: ' + v);
          return list;
        }
        console.log('[CIMA] 0 résultat pour variant: ' + v);
      }
    } catch(e) {
      console.warn('[CIMA] Erreur variant ' + v + ': ' + e.message);
    }
  }

  return gotAnyOk ? [] : null;
}

// ─── Helper : GET JSON ────────────────────────────────────────────────────────
function httpGetJson(url, timeoutMs) {
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
    fr: { label: 'BDPM / ANSM',  fetch: () => fetchFrance(substance) },
    es: { label: 'CIMA / AEMPS', fetch: () => fetchSpain(substance)  },
    pt: { label: 'INFARMED',     fetch: () => Promise.resolve(null)  },
    be: { label: 'SAM / FAMHP',  fetch: () => Promise.resolve(null)  }
  };

  const meta = SOURCES[country];
  if (!meta) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Pays non supporté: ' + country }) };
  }

  // Pays avec une API publique (null = API inaccessible, pas "pas d'API")
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
    } else if (result && result.bdpmError) {
      countryData = {
        country, source: meta.label,
        products: [], total: 0,
        error: 'Base BDPM temporairement inaccessible (' + result.bdpmError + ')',
        link: COUNTRY_LINKS[country] || null
      };
    } else {
      const products = Array.isArray(result) ? result : [];
      countryData = {
        country, source: meta.label,
        products, total: products.length
      };
    }

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ countries: [countryData] }) };
  } catch(err) {
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        countries: [{
          country, source: meta.label,
          products: [], total: 0,
          error: err.message,
          link: COUNTRY_LINKS[country] || null
        }]
      })
    };
  }
};
