/**
 * PharmaScout — Netlify Function : EU Products v8
 *
 * FR → BDPM via data.gouv.fr CDN (CSV CIS_COMPO + CIS_bdpm)
 *       Cache module-level 24h — aucune dépendance BDPM serveur (SPA JS inaccessible depuis Lambda)
 *       Stratégie : data.gouv.fr API → URLs CDN dynamiques → téléchargement CSV → parsing → Map en mémoire
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

// ─── Cache BDPM module-level (survit entre appels Lambda warm) ────────────────
// compoMap : substance_norm (lowercase, trim) → Set<CIS_code_string>
// cisMap   : CIS_code_string → { name, holder, status }
let _bdpmCache = null;   // { compoMap: Map, cisMap: Map, ts: number } | null
const BDPM_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

// data.gouv.fr dataset ID (slug officiel)
const DATAGOUV_DATASET_API =
  'https://www.data.gouv.fr/api/1/datasets/base-de-donnees-publique-des-medicaments-base-officielle/';

// ─── Espagne — cache par substance (30min) ────────────────────────────────────
const _esCache = new Map();
const ES_CACHE_TTL = 30 * 60 * 1000;

// ─── Helper : GET HTTP/HTTPS, suit les redirections, retour Buffer ────────────
function httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch(e) { return reject(new Error('URL invalide: ' + url)); }

    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      timeout:  timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PharmaScoutBot/1.0)',
        'Accept':     '*/*',
        'Accept-Encoding': 'gzip, deflate'
      }
    };

    const req = https.request(options, (res) => {
      // Redirections
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        const loc = res.headers.location;
        if (!loc) return reject(new Error('Redirection sans Location'));
        const abs = loc.startsWith('http') ? loc : parsed.protocol + '//' + parsed.host + loc;
        return httpGet(abs, timeoutMs).then(resolve).catch(reject);
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

// ─── Helper : GET JSON ────────────────────────────────────────────────────────
async function httpGetJson(url, timeoutMs) {
  const buf = await httpGet(url, timeoutMs);
  return JSON.parse(buf.toString('utf8'));
}

// ─── Charger (ou renvoyer depuis cache) les deux Maps BDPM ───────────────────
async function loadBdpmMaps() {
  // Cache encore valide ?
  if (_bdpmCache && (Date.now() - _bdpmCache.ts) < BDPM_CACHE_TTL) {
    console.log('[BDPM] Cache chaud — ' + _bdpmCache.compoMap.size + ' substances, ' + _bdpmCache.cisMap.size + ' produits');
    return _bdpmCache;
  }

  console.log('[BDPM] Chargement des CSV via data.gouv.fr...');

  // 1. Récupérer les métadonnées du dataset pour obtenir les URLs CDN actuelles
  const dataset = await httpGetJson(DATAGOUV_DATASET_API, 12000);
  const resources = dataset.resources || [];

  // Chercher CIS_bdpm.txt et CIS_COMPO_bdpm.txt
  const findUrl = (pattern) => {
    // Chercher d'abord dans les ressources communautaires si vide
    const found = resources.find(r =>
      (r.url || '').toLowerCase().includes(pattern.toLowerCase()) ||
      (r.title || '').toLowerCase().includes(pattern.toLowerCase())
    );
    return found ? found.url : null;
  };

  const cisBdpmUrl   = findUrl('CIS_bdpm')   || findUrl('cis_bdpm');
  const cisCompoUrl  = findUrl('CIS_COMPO')  || findUrl('cis_compo') || findUrl('compo');

  if (!cisBdpmUrl || !cisCompoUrl) {
    // Tentative de secours : lister toutes les ressources pour debug
    console.warn('[BDPM] Ressources trouvées: ' + resources.map(r => r.title + '|' + r.url).join(', ').slice(0, 400));
    throw new Error('URLs CIS_bdpm ou CIS_COMPO introuvables dans data.gouv.fr (ressources: ' + resources.length + ')');
  }

  console.log('[BDPM] CIS_bdpm: '  + cisBdpmUrl.slice(0, 80));
  console.log('[BDPM] CIS_COMPO: ' + cisCompoUrl.slice(0, 80));

  // 2. Télécharger les deux CSV en parallèle (timeout 25s chacun)
  const [cisBuf, compoBuf] = await Promise.all([
    httpGet(cisBdpmUrl,  25000),
    httpGet(cisCompoUrl, 25000)
  ]);

  console.log('[BDPM] Tailles brutes: CIS=' + cisBuf.length + ', COMPO=' + compoBuf.length);

  // 3. Décoder (UTF-8 avec éventuel BOM)
  const decode = (buf) => {
    let s = buf.toString('utf8');
    // Retirer BOM UTF-8 (EF BB BF)
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    // Parfois encodé Latin-1 → réessayer
    if (s.includes('\uFFFD') && s.length < buf.length * 1.1) {
      s = buf.toString('latin1');
    }
    return s;
  };

  const cisText   = decode(cisBuf);
  const compoText = decode(compoBuf);

  // 4. Parser CIS_bdpm.txt
  //    Colonnes (tab-separated, pas d'en-tête) :
  //    0=CIS  1=denomination  2=forme  3=voie  4=statut_AMM  5=type_procedure
  //    6=etat_commercialisation  7=date_AMM  8=statut_BdM  9=num_aut_europ
  //    10=titulaires  11=surveillance_renforcee
  const cisMap = new Map();
  for (const line of cisText.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (cols.length < 5) continue;
    const cis    = cols[0].trim();
    const name   = (cols[1] || '').trim();
    const status = (cols[4] || '').trim();   // statut AMM
    const etat   = (cols[6] || '').trim();   // état commercialisation
    const holder = (cols[10] || '').trim();
    if (!cis || !name) continue;
    cisMap.set(cis, { name, holder, status, etat });
  }
  console.log('[BDPM] CIS map: ' + cisMap.size + ' produits');

  // 5. Parser CIS_COMPO_bdpm.txt
  //    Colonnes (tab-separated, pas d'en-tête) :
  //    0=CIS  1=designation_element  2=code_substance  3=denomination_substance(INN)
  //    4=dosage  5=ref_dosage  6=nature_composant  7=num_liaison
  const compoMap = new Map(); // substance_norm → Set<CIS_code>
  for (const line of compoText.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (cols.length < 4) continue;
    const cis      = cols[0].trim();
    const substRaw = (cols[3] || '').trim();
    if (!cis || !substRaw) continue;
    const substNorm = substRaw.toLowerCase();
    if (!compoMap.has(substNorm)) compoMap.set(substNorm, new Set());
    compoMap.get(substNorm).add(cis);
  }
  console.log('[BDPM] COMPO map: ' + compoMap.size + ' substances');

  _bdpmCache = { compoMap, cisMap, ts: Date.now() };
  return _bdpmCache;
}

// ─── France — BDPM CSV (via data.gouv.fr CDN) ────────────────────────────────
async function fetchFrance(substance) {
  const maps = await loadBdpmMaps();
  const { compoMap, cisMap } = maps;

  // Chercher la substance (exact + préfixe + contient) en ordre décroissant de précision
  const substLow = substance.toLowerCase().trim();

  let cisCodes = new Set();

  // 1. Match exact
  if (compoMap.has(substLow)) {
    compoMap.get(substLow).forEach(c => cisCodes.add(c));
  }

  // 2. Si 0 résultat exact : chercher les substances qui contiennent le terme
  if (cisCodes.size === 0) {
    for (const [key, codes] of compoMap) {
      // la substance BDPM contient le terme recherché (ex: "prilocaïne" dans "prilocaïne + lidocaïne")
      // OU le terme recherché contient la substance BDPM (ex: "prilocaïne" dans "prilocaïne chlorhydrate")
      if (key.includes(substLow) || substLow.includes(key)) {
        codes.forEach(c => cisCodes.add(c));
      }
    }
  }

  // 3. Recherche par préfixe (3 premiers mots du terme recherché, au minimum 5 chars)
  if (cisCodes.size === 0 && substLow.length >= 5) {
    const prefix = substLow.slice(0, Math.min(substLow.length, 8));
    for (const [key, codes] of compoMap) {
      if (key.startsWith(prefix)) {
        codes.forEach(c => cisCodes.add(c));
      }
    }
  }

  if (cisCodes.size === 0) {
    console.log('[BDPM] 0 CIS trouvés pour substance: ' + substance);
    return [];
  }

  console.log('[BDPM] ' + cisCodes.size + ' CIS trouvés pour: ' + substance);

  // Construire liste de produits depuis cisMap
  const products = [];
  const seenNames = new Set();

  for (const cis of cisCodes) {
    const prod = cisMap.get(cis);
    if (!prod) continue;

    // Filtrer : garder uniquement les AMM actives
    // Statuts AMM actifs connus :
    //   "Autorisation active", "AMO active", "AMO"
    // Statuts à exclure : "Retrait de l'AMM", "Retrait de l'autorisation par l'entreprise", etc.
    const statusLow = prod.status.toLowerCase();
    const isActive = !statusLow.includes('retrait') && !statusLow.includes('suspendu') &&
                     !statusLow.includes('abrogé') && !statusLow.includes('archivé');

    // Garder aussi les produits avec état de commercialisation = "Commercialisé" ou "Déclaration d'arrêt de commercialisation"
    // On ne filtre PAS sur l'état de commercialisation car certains "non commercialisés" peuvent être intéressants
    // mais on exclut les AMM retirées
    if (!isActive) continue;

    const nameKey = prod.name.toUpperCase().slice(0, 60);
    if (seenNames.has(nameKey)) continue;
    seenNames.add(nameKey);

    products.push({
      name:   prod.name,
      holder: prod.holder || '',
      status: prod.etat || prod.status || 'Autorisé'
    });
  }

  // Trier : produits commercialisés en premier
  products.sort((a, b) => {
    const aComm = a.status.toLowerCase().includes('commerciali');
    const bComm = b.status.toLowerCase().includes('commerciali');
    if (aComm && !bComm) return -1;
    if (!aComm && bComm) return 1;
    return a.name.localeCompare(b.name, 'fr');
  });

  console.log('[BDPM] ' + products.length + ' produits uniques pour: ' + substance);
  return products.slice(0, 50);
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
