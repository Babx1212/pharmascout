/**
 * PharmaScout — Netlify Function : EU Products v20
 *
 * FR → BDPM REST API interne (/api/produit/by-substance-active)
 *       Découverte par reverse-engineering du bundle JS de la SPA BDPM (avril 2026)
 *       Paramètres requis : contains, query[], tag=substance, draw, columns[0][data], start, length
 *       Pas de CSV, pas de cache global — simple GET JSON par requête
 * ES → CIMA REST API v1.23 (AEMPS) — substance active (practiv1), multi-case
 * PT → INFARMED INFOMED — scraping JSF/PrimeFaces (pesquisa-avancada.xhtml)
 *       GET page → extrait JSESSIONID + ViewState
 *       POST AJAX PrimeFaces avec mainForm:dci_input=substance
 *       Réponse XML partial-response → parse table HTML
 *       Pagination automatique jusqu'à 50 résultats (5 pages × 10)
 * BE → medicinesdatabase.be (FAMHP) — API REST Angular SPA
 *       Découverte par reverse-engineering du bundle Angular (avril 2026)
 *       Clé HMAC dynamique : GET /api/config → {key}
 *       Token xsrf-token : JWT HS256 signé → sig.jti+exp
 *       Payload JWT : {a: userAgent, exp: now+300, jti: timestamp*rand}
 *       IMPORTANT : champ "a" doit = User-Agent HTTP de la requête (validé côté serveur)
 *       RPP max = 20 — pagination auto jusqu'à 100 résultats (5 pages)
 *       Réponse JSON : {rows: N, data: [{name, company, availability[], ...}]}
 *       Cache : 20 min par substance
 */

const https  = require('https');
const zlib   = require('zlib');
const crypto = require('crypto');

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
  be: 'https://medicinesdatabase.be/human-use',
  de: 'https://www.gelbe-liste.de/',
  it: 'https://medicinali.aifa.gov.it/',
  nl: 'https://db.cbg-meb.nl/ords/f?p=111:1',
  at: 'https://medikamente.basg.gv.at/',
  se: 'https://www.lakemedelsverket.se/en/medicines-and-products/medicines/medicines-database',
  pl: 'https://rejestry.ezdrowie.gov.pl/rpl/search-product'
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

// ─── Helper : POST JSON body + retourner JSON ─────────────────────────────────
async function httpPostJson(url, body, timeoutMs, extraHeaders) {
  const bodyStr = JSON.stringify(body);
  const rawStr  = await httpPostRaw(url, bodyStr, timeoutMs, Object.assign({
    'Content-Type': 'application/json',
    'Accept':       'application/json, */*'
  }, extraHeaders || {}));
  return JSON.parse(rawStr);
}

// ─── Helper : GET retournant {statusCode, headers, body:string} ───────────────
function httpGetRaw(url, timeoutMs, extraHeaders) {
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
        'Accept-Encoding': 'gzip, deflate'
      }, extraHeaders || {})
    };
    const req = https.request(options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        const loc = res.headers.location;
        if (!loc) return reject(new Error('Redirection sans Location'));
        const abs = loc.startsWith('http') ? loc : parsed.protocol + '//' + parsed.host + loc;
        return httpGetRaw(abs, timeoutMs, extraHeaders).then(resolve).catch(reject);
      }
      let stream = res;
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
      if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve({
        statusCode: res.statusCode,
        headers:    res.headers,
        body:       Buffer.concat(chunks).toString('utf8')
      }));
      stream.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout: ' + url.slice(0, 80))); });
    req.on('error', reject);
    req.end();
  });
}

// ─── Helper : POST retournant le body string ──────────────────────────────────
function httpPostRaw(url, postBody, timeoutMs, extraHeaders) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch(e) { return reject(new Error('URL invalide: ' + url)); }
    const bodyBuf = Buffer.from(postBody, 'utf8');
    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      timeout:  timeoutMs,
      headers: Object.assign({
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Length':  String(bodyBuf.length)
      }, extraHeaders || {})
    };
    const req = https.request(options, (res) => {
      let stream = res;
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
      if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout POST: ' + url.slice(0, 80))); });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

// ─── Helper : extraire les cookies depuis les headers Set-Cookie ──────────────
function extractCookies(headers) {
  const sc = headers['set-cookie'];
  if (!sc) return '';
  const arr = Array.isArray(sc) ? sc : [sc];
  return arr.map(c => c.split(';')[0]).join('; ');
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
  // SpecGeneDenom = nom du médicament référent (lien générique→marque), PAS les DCI.
  // Pour les DCI on utilise SpecDenom01 des génériques (ex. "NOMEGESTROL ACETATE/ESTRADIOL VIATRIS")
  // et on cross-enrichit les médicaments de référence via SpecGeneId → SpecId.
  //
  // Ex : ZOELY (SpecId=61335127) ← NOMEGESTROL ACETATE/ESTRADIOL VIATRIS (SpecGeneId=61335127)
  //   → on extrait "nomegestrol" + "estradiol" du nom du générique et on les associe à ZOELY

  // Étape 1 : construire la map SpecId_de_référence → [dci1, dci2, ...]
  const refSubsMap = new Map(); // SpecId (brand) → tableau de termes DCI
  for (const item of data.data) {
    if (!item.SpecGeneId || !item.SpecDenom01 || !item.SpecDenom01.includes('/')) continue;
    const parts = item.SpecDenom01.split('/');
    const subs  = parts.map(part => {
      // Premier mot du fragment avant le premier chiffre ou virgule → terme DCI
      const w0 = part.trim().split(/\s+/)[0] || '';
      return /^\d|,/.test(w0) ? '' : w0.toLowerCase();
    }).filter(s => s.length > 2);
    if (subs.length > 0) {
      if (!refSubsMap.has(item.SpecGeneId)) refSubsMap.set(item.SpecGeneId, []);
      subs.forEach(s => { if (!refSubsMap.get(item.SpecGeneId).includes(s)) refSubsMap.get(item.SpecGeneId).push(s); });
    }
  }

  // Étape 2 : construire chaque produit avec ses _substances
  return data.data
    .filter(item => item.SpecDenom01)
    .map(item => {
      const obj = {
        name:   item.SpecDenom01,
        holder: '',
        status: item.StatutBdm === 1 ? 'Commercialisé' : 'Non commercialisé'
      };
      let subs = [];
      // Génériques combo : extraire DCI du nom lui-même
      if (item.SpecDenom01.includes('/')) {
        const parts = item.SpecDenom01.split('/');
        subs = parts.map(part => {
          const w0 = part.trim().split(/\s+/)[0] || '';
          return /^\d|,/.test(w0) ? '' : w0.toLowerCase();
        }).filter(s => s.length > 2);
      }
      // Médicaments de référence : DCI inférées depuis leurs génériques combo
      const fromRef = refSubsMap.get(item.SpecId) || [];
      subs = [...new Set([...subs, ...fromRef])];
      if (subs.length > 0) obj._substances = subs;
      return obj;
    });
}

// ─── Portugal — INFARMED INFOMED (JSF/PrimeFaces scraping) ───────────────────
// Cache par substance (20 min)
const _ptCache = new Map();
const PT_CACHE_TTL = 20 * 60 * 1000;

// Tous les champs du formulaire pesquisa-avancada (37 champs)
function infomedFormFields(substance, viewState, extraPaginationFields) {
  const base = {
    'mainForm': 'mainForm',
    'mainForm:dci_input': substance,
    'mainForm:ff_focus': '', 'mainForm:ff_input': '',
    'mainForm:dosagem_input': '', 'mainForm:medicamento_input': '',
    'mainForm:taim_input': '', 'mainForm:num-processo': '',
    'mainForm:vias-admin_focus': '', 'mainForm:vias-admin_input': '',
    'mainForm:grupo-produto_focus': '', 'mainForm:grupo-produto_input': '',
    'mainForm:generico_focus': '', 'mainForm:generico_input': '',
    'mainForm:numero-registro': '', 'mainForm:cnpem': '', 'mainForm:chnm': '',
    'mainForm:margem-terap_focus': '', 'mainForm:margem-terap_input': '',
    'mainForm:monit-adicional_focus': '', 'mainForm:monit-adicional_input': '',
    'mainForm:exist-docs-mmr_focus': '', 'mainForm:exist-docs-mmr_input': '',
    'mainForm:estado-aim_focus': '', 'mainForm:estado-aim_input': '',
    'mainForm:estado-aim-de_input': '', 'mainForm:estado-aim-a_input': '',
    'mainForm:estado-comercializacao_focus': '', 'mainForm:estado-comercializacao_input': '',
    'mainForm:classif-dispensa_focus': '', 'mainForm:classif-dispensa_input': '',
    'mainForm:classif-farmacoterapeutica_focus': '', 'mainForm:classif-farmacoterapeutica_input': '',
    'mainForm:classif-atc_focus': '', 'mainForm:classif-atc_input': '',
    'mainForm:dt-medicamentos_rppDD': '10',
    'javax.faces.ViewState': viewState
  };
  return Object.assign(base, extraPaginationFields || {});
}

function toUrlEncoded(fields) {
  return Object.entries(fields)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v || ''))
    .join('&');
}

// Extraire ViewState depuis HTML ou XML de réponse INFOMED
function extractInfomedViewState(text) {
  // HTML form field
  const m1 = text.match(/name="javax\.faces\.ViewState"[^>]*value="([^"]+)"/);
  if (m1) return m1[1];
  // XML partial-response update
  const m2 = text.match(/<update id="[^"]*ViewState[^"]*"><!\[CDATA\[([^\]]+)\]\]><\/update>/);
  if (m2) return m2[1];
  return null;
}

// Parser la table HTML partielle retournée par PrimeFaces
function parseInfomedTableHtml(tableHtml) {
  if (!tableHtml || tableHtml.includes('ui-datatable-empty-message')) return [];

  const tbodyM = tableHtml.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/);
  if (!tbodyM) return [];

  const products = [];
  const rows = tbodyM[1].split('</tr>');

  for (const row of rows) {
    if (!row.includes('<td')) continue;

    // Nom = lien linkNome dans la colonne 1
    const nameM = row.match(/<a[^>]+id="[^"]*linkNome"[^>]*>([^<]+)<\/a>/);
    if (!nameM) continue;
    const name = nameM[1].trim();

    // Splitter les cellules sur <td
    const parts = row.split('<td');
    // parts[0]=avant 1er td, parts[1]=col0(ID), parts[2]=col1(nom),
    // parts[3]=col2(DCI), parts[4]=col3(forme), parts[5]=col4(dosage),
    // parts[6]=col5(titulaire), parts[7]=col6(icône statut)
    if (parts.length < 7) continue;

    const getCellText = (part) => {
      if (!part) return '';
      const gt = part.indexOf('>');
      if (gt === -1) return '';
      const content = part.slice(gt + 1);
      const end = content.indexOf('</td>');
      const html = end > -1 ? content.slice(0, end) : content;
      return html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    };

    const holder     = getCellText(parts[6]);
    const statusHtml = parts[7] || '';
    const marketed   = statusHtml.includes('ui-icon-truck');

    // parts[3] = colonne DCI — peut contenir plusieurs substances séparées par '/' ou '+'
    // Ex : "LIDOCAÍNA/PRILOCAÍNA", "NOMEGESTROL ACETATO/ESTRADIOL"
    const dciText = getCellText(parts[3]);
    const ptSubs  = dciText
      ? dciText.split(/[/+,;]/).map(s => s.trim().toLowerCase()).filter(s => s.length > 1)
      : [];

    const product = {
      name,
      holder: holder || '',
      status: marketed ? 'Comercializado' : 'Autorizado'
    };
    if (ptSubs.length > 0) product._substances = ptSubs;
    products.push(product);
  }
  return products;
}

async function fetchPortugal(substance) {
  const cached = _ptCache.get(substance);
  if (cached && (Date.now() - cached.ts) < PT_CACHE_TTL) {
    console.log('[INFOMED] Cache hit: ' + substance);
    return cached.products;
  }

  const BASE = 'https://extranet.infarmed.pt/INFOMED-fo/pesquisa-avancada.xhtml';
  const AJAX_HEADERS = {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'Accept': 'application/xml, text/xml, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
    'Faces-Request': 'partial/ajax',
    'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.8',
    'Referer': BASE,
    'Origin': 'https://extranet.infarmed.pt'
  };

  // 1. GET → JSESSIONID + ViewState
  console.log('[INFOMED] GET page...');
  const getRes = await httpGetRaw(BASE, 12000, {
    'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
    'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.8'
  });
  if (getRes.statusCode < 200 || getRes.statusCode >= 300) {
    throw new Error('INFOMED GET status ' + getRes.statusCode);
  }

  const cookie    = extractCookies(getRes.headers);
  let   viewState = extractInfomedViewState(getRes.body);
  if (!viewState) throw new Error('INFOMED ViewState introuvable');
  console.log('[INFOMED] Session obtenue, ViewState: ' + viewState.slice(0, 20) + '...');

  const reqHeaders = Object.assign({ 'Cookie': cookie }, AJAX_HEADERS);

  // 2. POST recherche (page 1)
  const searchFields = Object.assign(infomedFormFields(substance, viewState), {
    'javax.faces.partial.ajax': 'true',
    'javax.faces.source': 'mainForm:btnDoSearch',
    'javax.faces.partial.execute': 'mainForm:pnlCriterios mainForm:btnDoSearch',
    'javax.faces.partial.render': 'messages minLenghtMessage mainForm:dt-medicamentos mainForm:dg-medicamentos mainForm:dciMessage mainForm:nomeMessage mainForm:taimMessage mainForm:numProcessoMessage mainForm:nrRegistoMessage mainForm:cnpemMessage mainForm:chnmMessage mainForm:data-invertida-message',
    'mainForm:btnDoSearch': 'mainForm:btnDoSearch'
  });

  console.log('[INFOMED] POST recherche: ' + substance);
  const searchXml = await httpPostRaw(BASE, toUrlEncoded(searchFields), 15000, reqHeaders);

  // Extraire la table et le total
  const tblM = searchXml.match(/<update id="mainForm:dt-medicamentos"><!\[CDATA\[([\s\S]*?)\]\]><\/update>/);
  if (!tblM) {
    console.log('[INFOMED] Pas de table dans la réponse XML');
    _ptCache.set(substance, { products: [], ts: Date.now() });
    return [];
  }

  let allProducts = parseInfomedTableHtml(tblM[1]);
  console.log('[INFOMED] Page 1: ' + allProducts.length + ' produits');

  // Extraire total depuis texte paginateur
  const totalM = searchXml.match(/A mostrar \d+ - \d+ de um total de (\d+) registos/);
  const total  = totalM ? parseInt(totalM[1], 10) : allProducts.length;
  console.log('[INFOMED] Total: ' + total + ' produits');

  // Mettre à jour ViewState depuis la réponse XML
  const newVs = extractInfomedViewState(searchXml);
  if (newVs) viewState = newVs;

  // 3. Pagination si nécessaire (max 5 pages = 50 résultats)
  const ROWS_PER_PAGE = 10;
  const MAX_PAGES     = 5;
  const totalPages    = Math.ceil(total / ROWS_PER_PAGE);
  const pagesToFetch  = Math.min(totalPages, MAX_PAGES);

  for (let page = 2; page <= pagesToFetch; page++) {
    const offset = (page - 1) * ROWS_PER_PAGE;
    const pageFields = Object.assign(infomedFormFields(substance, viewState), {
      'javax.faces.partial.ajax': 'true',
      'javax.faces.source': 'mainForm:dt-medicamentos',
      'javax.faces.partial.execute': 'mainForm:dt-medicamentos',
      'javax.faces.partial.render': 'mainForm:dt-medicamentos',
      'mainForm:dt-medicamentos': 'mainForm:dt-medicamentos',
      'mainForm:dt-medicamentos_pagination': 'true',
      'mainForm:dt-medicamentos_first': String(offset),
      'mainForm:dt-medicamentos_rows': String(ROWS_PER_PAGE),
      'mainForm:dt-medicamentos_encodeFeature': 'true'
    });

    try {
      console.log('[INFOMED] Page ' + page + ' (first=' + offset + ')...');
      const pageXml = await httpPostRaw(BASE, toUrlEncoded(pageFields), 12000, reqHeaders);
      const pageTblM = pageXml.match(/<update id="mainForm:dt-medicamentos"><!\[CDATA\[([\s\S]*?)\]\]><\/update>/);
      if (pageTblM) {
        const pageProducts = parseInfomedTableHtml(pageTblM[1]);
        console.log('[INFOMED] Page ' + page + ': ' + pageProducts.length + ' produits');
        allProducts = allProducts.concat(pageProducts);
      }
      const vs2 = extractInfomedViewState(pageXml);
      if (vs2) viewState = vs2;
    } catch (e) {
      console.warn('[INFOMED] Erreur page ' + page + ': ' + e.message);
      break;
    }
  }

  // Dédupliquer (même nom + même titulaire)
  const seen = new Set();
  const unique = allProducts.filter(p => {
    const key = (p.name + '|' + p.holder).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log('[INFOMED] ' + unique.length + ' produits uniques pour: ' + substance);

  // Fallback DCI portugais : si 0 résultat et substance se termine par 'e',
  // tenter la variante en 'a' (finasteride→finasterida, dutasteride→dutasterida, etc.)
  if (unique.length === 0 && substance.endsWith('e')) {
    const ptVariant = substance.slice(0, -1) + 'a';
    console.log('[INFOMED] 0 résultat — retry variante PT: ' + ptVariant);
    // On ne met pas en cache la version vide, on relance avec la variante
    return fetchPortugal(ptVariant);
  }

  _ptCache.set(substance, { products: unique, ts: Date.now() });
  return unique;
}

// ─── Belgique — medicinesdatabase.be (FAMHP) API REST Angular ────────────────
// Découverte par reverse-engineering du bundle Angular main-K24IBCSL.js (avril 2026)
// Méthode ConfigService.getT() :
//   r = (Date.now() * Math.floor(Math.random()*1e4)).toString()  // JTI
//   o = Math.floor(Date.now()/1000 + 300)                        // exp
//   JWT payload = {a: userAgent, exp: o, jti: r}
//   token = jwt.split('.').pop() + '.' + r + o.toString()
//   → token = base64url(HMAC-SHA256(header.payload)) + '.' + jti + exp
// Clé HMAC : GET /api/config → {key: "L4a};kgv(F30", ...}  (publique, sans auth)
// Réponse   : GET /api/products?term=X&usage=human&v=... → {rows:N, data:[{...}]}
const _beCache     = new Map();
const BE_CACHE_TTL = 20 * 60 * 1000;

// Cache de la config FAMHP (clé HMAC + version API, 1h)
let _beConfigCache = null;
const BE_CONFIG_TTL = 60 * 60 * 1000;

// User-Agent fixe utilisé à la fois dans le JWT (champ "a") et dans la requête HTTP
const BE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function getBelgiumConfig() {
  if (_beConfigCache && (Date.now() - _beConfigCache.ts) < BE_CONFIG_TTL) {
    return _beConfigCache;
  }
  console.log('[FAMHP] Récupération /api/config...');
  const data = await httpGetJson('https://medicinesdatabase.be/api/config', 8000, {
    'Accept':       'application/json',
    'Referer':      'https://medicinesdatabase.be/',
    'User-Agent':   BE_UA
  });
  _beConfigCache = {
    key:     data.key,
    version: data.version || '1.4.132-en',
    ts:      Date.now()
  };
  console.log('[FAMHP] Config: key=' + data.key.slice(0, 4) + '***');
  return _beConfigCache;
}

function generateBelgiumToken(configKey) {
  const r       = (Date.now() * Math.floor(Math.random() * 1e4)).toString();
  const o       = Math.floor(Date.now() / 1e3 + 300);
  const payload = { a: BE_UA, exp: o, jti: r };
  const header  = { alg: 'HS256', typ: 'JWT' };
  const encH    = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encP    = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sigInput = encH + '.' + encP;
  const sig     = crypto.createHmac('sha256', Buffer.from(configKey, 'utf8'))
                        .update(sigInput)
                        .digest('base64url');
  return sig + '.' + r + o.toString();
}

async function fetchBelgium(substance) {
  const cached = _beCache.get(substance);
  if (cached && (Date.now() - cached.ts) < BE_CACHE_TTL) {
    console.log('[FAMHP] Cache hit: ' + substance);
    return cached.products;
  }

  const config  = await getBelgiumConfig();
  const RPP     = 20;   // max accepté par l'API medicinesdatabase.be
  const MAX_ROW = 100;  // on récupère au max 100 produits (5 pages × 20)
  const BASE_HEADERS = {
    'Accept':     'application/json',
    'Referer':    'https://medicinesdatabase.be/',
    'Origin':     'https://medicinesdatabase.be',
    'User-Agent': BE_UA
  };

  // Page 1
  const token1  = generateBelgiumToken(config.key);
  const url1    = 'https://medicinesdatabase.be/api/products'
    + '?startRow=0&RPP=' + RPP + '&orderBy%5B%5D=name%20asc'
    + '&term='    + encodeURIComponent(substance)
    + '&usage=human'
    + '&v='       + encodeURIComponent(config.version);

  console.log('[FAMHP] GET products (page 1): ' + substance);
  const data1 = await httpGetJson(url1, 12000, Object.assign({ 'xsrf-token': token1 }, BASE_HEADERS));

  if (!data1.data || !Array.isArray(data1.data)) {
    console.log('[FAMHP] Réponse inattendue: ' + JSON.stringify(data1).slice(0, 100));
    _beCache.set(substance, { products: [], ts: Date.now() });
    return [];
  }

  const total = data1.rows || 0;
  console.log('[FAMHP] ' + total + ' produits pour: ' + substance);

  let allData = data1.data.slice();

  // Pagination — jusqu'à MAX_ROW résultats si nécessaire
  let startRow = RPP;
  while (allData.length < total && startRow < MAX_ROW) {
    try {
      const tokenN = generateBelgiumToken(config.key);
      const urlN   = 'https://medicinesdatabase.be/api/products'
        + '?startRow=' + startRow + '&RPP=' + RPP + '&orderBy%5B%5D=name%20asc'
        + '&term='    + encodeURIComponent(substance)
        + '&usage=human'
        + '&v='       + encodeURIComponent(config.version);
      console.log('[FAMHP] Page startRow=' + startRow + '...');
      const dataN = await httpGetJson(urlN, 10000, Object.assign({ 'xsrf-token': tokenN }, BASE_HEADERS));
      if (!dataN.data || !Array.isArray(dataN.data) || dataN.data.length === 0) break;
      allData = allData.concat(dataN.data);
      startRow += RPP;
    } catch (e) {
      console.warn('[FAMHP] Erreur pagination startRow=' + startRow + ': ' + e.message);
      break;
    }
  }

  // availability est un tableau : ["available"], ["not_commercialised"], ou les deux
  const products = allData.map(p => {
    const avail  = Array.isArray(p.availability) ? p.availability : [];
    const status = avail.includes('available') ? 'Commercialisé' : 'Non commercialisé';
    // activeSubstanceShort inclus pour le filtrage combo côté handler
    const obj = { name: p.name || '', holder: p.company || '', status };
    if (Array.isArray(p.activeSubstanceShort) && p.activeSubstanceShort.length > 0) {
      obj._substances = p.activeSubstanceShort.map(s => s.toLowerCase());
    }
    return obj;
  }).filter(p => p.name);

  console.log('[FAMHP] ' + products.length + ' produits retenus pour: ' + substance);
  _beCache.set(substance, { products, ts: Date.now() });
  return products;
}

// ─── Allemagne — Gelbe Liste / BfArM ─────────────────────────────────────────
// Gelbe Liste n'expose pas d'API publique JSON documentée.
// La base officielle BfArM/ABDA est uniquement disponible via abonnement professionnel.
async function fetchGermany(substance) {
  return null; // Pas d'API publique — renvoie note avec lien officiel
}

// ─── Italie — AIFA Banca Dati Farmaci ────────────────────────────────────────
// Nouveau domaine SPA : medicinali.aifa.gov.it (Angular)
// API REST découverte : https://api.aifa.gov.it/aifa-bdf-eif-be/1.0.0/
// Étape 1 : autocomplete?query={term}&nos=5 → DCI en italien (PARACETAMOLO etc.)
// Étape 2 : formadosaggio/ricerca?query={dci-it}&spellingCorrection=false&page=0&size=100
//   Réponse : {data:{content:[{medicinale:{denominazioneMedicinale,aziendaTitolare,...},revocato,sospeso,confezioni:[{flagCommercio}]}],...}}
async function fetchItaly(substance) {
  const BASE  = 'https://api.aifa.gov.it/aifa-bdf-eif-be/1.0.0';
  const EXTRA = {
    'Accept':  'application/json',
    'Origin':  'https://medicinali.aifa.gov.it',
    'Referer': 'https://medicinali.aifa.gov.it/'
  };

  // ── Étape 1 : nom DCI en italien ──────────────────────────────────────────
  let italianName = substance.toUpperCase();
  try {
    const autoUrl = BASE + '/autocomplete?query=' + encodeURIComponent(substance) + '&nos=5';
    const suggestions = await httpGetJson(autoUrl, 8000, EXTRA);
    if (Array.isArray(suggestions) && suggestions.length > 0) {
      const pa = suggestions.find(s => typeof s === 'string' && s.includes('(PRINCIPIO ATTIVO)'));
      if (pa)                            italianName = pa.split('(')[0].trim();
      else if (typeof suggestions[0] === 'string') italianName = suggestions[0].split('(')[0].trim();
      console.log('[AIFA] DCI italienne: ' + italianName + ' (recherche: ' + substance + ')');
    }
  } catch(e) {
    console.warn('[AIFA] autocomplete error: ' + e.message);
  }

  // ── Étape 2 : recherche paginée ───────────────────────────────────────────
  const allProducts = [];
  let page = 0, totalPages = 1;

  while (page < totalPages && page < 5) {
    const searchUrl = BASE + '/formadosaggio/ricerca'
      + '?query=' + encodeURIComponent(italianName)
      + '&spellingCorrection=false'
      + '&page=' + page + '&size=100';

    const data = await httpGetJson(searchUrl, 12000, EXTRA);
    if (!data || !data.data || !Array.isArray(data.data.content)) break;

    totalPages = data.data.totalPages || 1;

    for (const item of data.data.content) {
      const med  = item.medicinale || {};
      const name = med.denominazioneMedicinale || '';
      if (!name) continue;

      let status = 'Autorizzato';
      if (item.revocato)     status = 'Revocato';
      else if (item.sospeso) status = 'Sospeso';
      else {
        const confezioni = item.confezioni || [];
        const inCommercio = confezioni.some(c =>
          c.flagCommercio === true || c.flagCommercio === 'true' || c.flagCommercio === 1);
        if (confezioni.length > 0 && !inCommercio) status = 'Non in commercio';
      }
      allProducts.push({ name, holder: med.aziendaTitolare || '', status });
    }
    page++;
  }

  console.log('[AIFA] ' + allProducts.length + ' produits pour: ' + substance);
  return allProducts;
}

// ─── Pays-Bas — CBG-MEB (Oracle APEX, HTML parsing) ──────────────────────────
// Base Geneesmiddelen Databank : db.cbg-meb.nl/ords/f?p=111:2
// Recherche par werkzame stof (substance active) — APEX LOV : \VALUE\ (backslash-enclosed)
// Le tableau HTML Classic Report renvoie : Registratienummer | Productnaam | ATC | Werkzame stof
// Pas de titulaire dans la vue liste ; status = "Geregistreerd"
async function fetchNetherlands(substance) {
  const subUpper = substance.toUpperCase();
  // Oracle APEX LOV format : \VALUE\ → URL-encoded → %5CVALUE%5C
  const subEnc = '%5C' + encodeURIComponent(subUpper) + '%5C';

  const url = 'https://db.cbg-meb.nl/ords/f?p=111:2::SEARCH::2:'
    + 'P2_WERKZAAMSTOFFEN,P2_TAAL,P2_SOORT,P2_RIJEN:'
    + subEnc + ',NL,H,100';

  const raw = await httpGetRaw(url, 15000, {
    'Accept':          'text/html,application/xhtml+xml,*/*',
    'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8',
    'Referer':         'https://db.cbg-meb.nl/ords/f?p=111:1'
  });

  if (raw.statusCode < 200 || raw.statusCode >= 300) {
    console.warn('[CBG-MEB] HTTP ' + raw.statusCode + ' pour: ' + substance);
    return null;
  }

  // Parser les lignes <tr>/<td> du Classic Report APEX
  const products = [];
  const html     = raw.body;
  const stripHtml = s => s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '').trim();

  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    // Ignorer les lignes d'en-tête (contiennent <th> mais pas <td>)
    if (!rowHtml.includes('<td')) continue;
    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cm;
    while ((cm = cellRe.exec(rowHtml)) !== null) cells.push(stripHtml(cm[1]));
    if (cells.length < 2) continue;
    const name = cells[1] || '';
    if (!name || name === 'Productnaam') continue;
    products.push({ name, holder: '', status: 'Geregistreerd' });
  }

  console.log('[CBG-MEB] ' + products.length + ' produits pour: ' + substance);
  return products.length > 0 ? products : [];
}

// ─── Autriche — BASG Arzneimittel-Datenbank ──────────────────────────────────
// SPA Angular medikamente.basg.gv.at — API REST découverte
// POST /api/api/v1/medication/search?page=1&size=100 avec body {substance: term}
async function fetchAustria(substance) {
  const url  = 'https://medikamente.basg.gv.at/api/api/v1/medication/search?page=1&size=100';
  const body = { substance };

  const data = await httpPostJson(url, body, 12000, {
    'Origin':  'https://medikamente.basg.gv.at',
    'Referer': 'https://medikamente.basg.gv.at/'
  });

  // Normaliser selon la structure de réponse (tableau direct ou enveloppé)
  const items = Array.isArray(data) ? data
    : (data && Array.isArray(data.content)) ? data.content
    : (data && Array.isArray(data.data))    ? data.data
    : (data && Array.isArray(data.results)) ? data.results
    : [];

  const products = items.map(item => ({
    name:   item.name || item.bezeichnung || item.productName || item.tradeName || '',
    holder: item.holder || item.zulassungsinhaber || item.marketingAuthorizationHolder
            || item.company || '',
    status: item.status || item.zulassungsstatus || item.registrationStatus || 'Zugelassen'
  })).filter(p => p.name);

  console.log('[BASG] ' + products.length + ' produits pour: ' + substance);
  return products;
}

// ─── Suède — Läkemedelsverket ─────────────────────────────────────────────────
// SPA Next.js — API REST interne découverte
// POST /api/lmfrest/searchmedprod avec body {medProdName, status:"4", take:100, skip:0}
// status "4" = Godkänt (autorisé)
async function fetchSweden(substance) {
  const url  = 'https://www.lakemedelsverket.se/api/lmfrest/searchmedprod';
  const body = { medProdName: substance, status: '4', take: 100, skip: 0 };

  const data = await httpPostJson(url, body, 12000, {
    'Origin':  'https://www.lakemedelsverket.se',
    'Referer': 'https://www.lakemedelsverket.se/'
  });

  const items = Array.isArray(data) ? data
    : (data && Array.isArray(data.results))  ? data.results
    : (data && Array.isArray(data.data))     ? data.data
    : (data && Array.isArray(data.content))  ? data.content
    : [];

  const products = items.map(item => ({
    name:   item.productName || item.medProdName || item.tradeName || item.name || '',
    holder: item.applicantName || item.holder || item.company
            || item.marketingAuthorizationHolder || '',
    status: item.statusText || item.status || 'Godkänt'
  })).filter(p => p.name);

  console.log('[LV] ' + products.length + ' produits pour: ' + substance);
  return products;
}

// ─── Pologne — Rejestr Produktów Leczniczych (ezdrowie.gov.pl) ────────────────
// GET /api/rpl/medicinal-products/search/public?name={term}&subjectRolesIds=1&...
// Réponse Spring Data Page : {content:[...], totalElements, totalPages, ...}
async function fetchPoland(substance) {
  const url = 'https://rejestry.ezdrowie.gov.pl/api/rpl/medicinal-products/search/public'
    + '?name='                + encodeURIComponent(substance)
    + '&subjectRolesIds=1'
    + '&isAdvancedSearch=false'
    + '&size=100&page=0'
    + '&sort=name,ASC';

  const data = await httpGetJson(url, 12000, {
    'Accept':  'application/json',
    'Origin':  'https://rejestry.ezdrowie.gov.pl',
    'Referer': 'https://rejestry.ezdrowie.gov.pl/'
  });

  const items = (data && Array.isArray(data.content)) ? data.content
    : Array.isArray(data) ? data
    : [];

  const products = items.map(item => ({
    name:   item.name || item.tradeName || item.medicinalProductName || '',
    holder: item.holder || item.marketingAuthorizationHolder
            || item.applicant || item.company || '',
    status: item.status || item.registrationStatus || item.decisionType || 'Zarejestrowany'
  })).filter(p => p.name);

  console.log('[RPL] ' + products.length + ' produits pour: ' + substance);
  return products;
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
  // Variantes ES : lowercase, Titlecase, UPPERCASE + adaptation DCI espagnole
  // CIMA utilise les DCI espagnoles : la majorité des DCI anglaises en -e finissent en -a
  // finasteride→finasterida, prilocaine→prilocaina, betamethasone→betamethasona, etc.
  const low = substance.toLowerCase();
  const esVariant = (low.length > 4 && low.endsWith('e')) ? low.slice(0, -1) + 'a' : '';
  const variants = [...new Set([
    low,
    toTitle(substance),
    substance.toUpperCase(),
    ...(esVariant ? [esVariant, toTitle(esVariant)] : [])
  ])];
  let gotAnyOk = false;

  for (const v of variants) {
    try {
      const url = 'https://cima.aemps.es/cima/rest/medicamentos?practiv1=' + encodeURIComponent(v) + '&pageSize=30&pageNumber=1';
      const data = await httpGetJson(url, 7000);
      gotAnyOk = true;
      // vtm.nombre : DCI combinée ex. "lidocaína + prilocaína" → _substances pour filtrage combo
      const list = (data.resultados || []).map(p => {
        const obj = {
          name:   p.nombre     || '',
          holder: p.labtitular || '',
          status: p.estado?.nombre || (p.comerc ? 'Autorizado' : 'No comercializado')
        };
        if (p.vtm && p.vtm.nombre) {
          const subs = p.vtm.nombre
            .split(/[+/,;]/)
            .map(s => s.trim().toLowerCase())
            .filter(s => s.length > 1);
          if (subs.length > 0) obj._substances = subs;
        }
        return obj;
      }).filter(p => p.name);
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

// ─── Helper : filtrage combinaison A/B ────────────────────────────────────────
// Si la substance contient '/', on cherche avec la partie principale (avant /)
// et on filtre les résultats dont le nom contient les autres parties.
// Ex : "calcipotriol/betamethasone dipropionate"
//      → cherche "calcipotriol", filtre résultats contenant "betamethasone"
function parseCombo(raw) {
  const parts = raw.split('/').map(s => s.trim()).filter(Boolean);
  if (parts.length <= 1) return { primary: raw, filters: [] };
  // Pour chaque terme secondaire, garder le premier mot significatif (>4 chars)
  // pour le matching souple : "betamethasone dipropionate" → match "betamethasone"
  const filters = parts.slice(1).map(term => {
    const words = term.split(/\s+/).filter(w => w.length > 4);
    return words[0] || term;   // premier mot long, ou terme entier si court
  });
  return { primary: parts[0], filters };
}

// Normalise les accents pour comparaison cross-langue (lidocaína → lidocaina)
function stripAccents(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Match souple : préfixe bidirectionnel + tolérance suffixe linguistique (-aine/-aína, -one/-ona…)
// Betamethason ↔ betamethasone ✅   lidocaine ↔ lidocaína ✅   nomegestrol ↔ nomegestrol ✅
function substMatch(fl, t) {
  const nfl = stripAccents(fl);
  const nt  = stripAccents(t);
  if (nfl.startsWith(nt) || nt.startsWith(nfl)) return true;
  // Même radical avec terminaison différente (ex: lidocain-e vs lidocain-a)
  const minLen = Math.min(nfl.length, nt.length);
  if (minLen >= 6 && nfl.slice(0, minLen - 1) === nt.slice(0, minLen - 1)) return true;
  return false;
}

function applyComboFilter(products, filters) {
  if (!filters || filters.length === 0) return products;
  return products.filter(p => {
    const nameLow  = (p.name || '').toLowerCase();
    // _substances : tableau de DCI (BE=néerlandais, ES=espagnol, FR/PT=local)
    const subsLow  = (p._substances || []).map(s => s.toLowerCase());
    // Tokeniser nom + DCI pour le matching
    const tokens = (nameLow + ' ' + subsLow.join(' '))
      .split(/[\s,/\-()[\]]+/)
      .filter(t => t.length > 3);
    return filters.every(f => {
      const fl = f.toLowerCase();
      return tokens.some(t => substMatch(fl, t));
    });
  });
}

// ─── Resolver : normalisation et résolution des entrées utilisateur ──────────
// Architecture :
//   1. Dict curé (sync, O(1)) — classes, ambiguïtés, divergences US/EU, EU brands absents de RxNorm
//   2. RxNorm API (async, NIH/NLM, publique, gratuite) — résolution dynamique de tout le reste
//      approximateTerm → score de confiance + rxcui → allrelated → ingrédients (TTY=IN)
//   3. Passthrough — si RxNorm ne trouve rien (comportement actuel préservé)
//
// Types de sortie :
//   substance   → DCI/INN déjà canonique (confirmé par RxNorm ou dict)
//   synonym     → synonyme clair (acetaminophen → paracetamol)
//   latin       → forme latine (lidocainum → lidocaine)
//   brand       → nom de marque → DCI (Humira → adalimumab, Symbicort → budesonide/formoterol)
//   combo       → combinaison multi-substances (via séparateurs +/and ou marque multi-ingrédient)
//   acronym     → acronyme non ambigu (ASA → acetylsalicylic acid)
//   class       → classe thérapeutique → pas d'analyse directe, suggestions exposées
//   ambiguous   → terme ambigu → analyse avec avertissement
//   passthrough → non reconnu → envoyé tel quel
//
// Clés du dict : toutes en lowercase, sans accents (comparaison via stripAccents)

// Cache des résolutions RxNorm (1h) — évite la latence sur les répétitions
const _resolverCache    = new Map();
const RESOLVER_CACHE_TTL = 60 * 60 * 1000;

// Divergences INN US → INN EU (appliqué sur la sortie RxNorm si besoin)
const US_TO_EU_INN = {
  'acetaminophen':     'paracetamol',
  'epinephrine':       'adrenaline',
  'norepinephrine':    'noradrenaline',
  'albuterol':         'salbutamol',
  'dextroamphetamine': 'dexamfetamine',
  'methylphenidate':   'methylphenidate',  // same in EU — placeholder pour la structure
};

// Résolution dynamique via l'API RxNorm (2 appels max, ~300ms à froid, 0ms en cache)
async function resolveViaRxNorm(term) {
  const cached = _resolverCache.get(term);
  if (cached && (Date.now() - cached.ts) < RESOLVER_CACHE_TTL) {
    console.log('[rxnorm] cache hit: ' + term);
    return cached.result;
  }

  const BASE = 'https://rxnav.nlm.nih.gov/REST';
  const store = (result) => { _resolverCache.set(term, { result, ts: Date.now() }); return result; };

  try {
    // ── Étape 1 : correspondance approchée → score de confiance + rxcui ────
    const approx = await httpGetJson(
      BASE + '/approximateTerm.json?term=' + encodeURIComponent(term) + '&maxEntries=1',
      5000
    );
    const candidates = approx?.approximateGroup?.candidate || [];
    if (!candidates.length) { console.log('[rxnorm] aucun match: ' + term); return store({ resolved: false }); }

    const score  = parseInt(candidates[0].score, 10) || 0;
    const rxcui  = candidates[0].rxcui;
    if (score < 60) { console.log('[rxnorm] score trop faible (' + score + '): ' + term); return store({ resolved: false }); }

    const confidence = score >= 80 ? 'high' : 'medium';

    // ── Étape 2 : récupérer tous les concepts liés → ingrédients TTY=IN/PIN ─
    const rel    = await httpGetJson(BASE + '/rxcui/' + rxcui + '/allrelated.json', 5000);
    const groups = rel?.allRelatedGroup?.conceptGroup || [];

    const ingredients = [];
    const seen = new Set();
    for (const g of groups) {
      if (g.tty !== 'IN' && g.tty !== 'PIN') continue;
      for (const p of (g.conceptProperties || [])) {
        if (!p.rxcui || !p.name || seen.has(p.rxcui)) continue;
        seen.add(p.rxcui);
        const eu = US_TO_EU_INN[p.name.toLowerCase()] || p.name.toLowerCase();
        if (!ingredients.includes(eu)) ingredients.push(eu);
      }
    }

    if (!ingredients.length) { console.log('[rxnorm] aucun ingrédient pour ' + rxcui + ' (' + term + ')'); return store({ resolved: false }); }

    // Si l'input est déjà l'un des ingrédients → passthrough (déjà canonique)
    const isInn = ingredients.some(i => stripAccents(i) === stripAccents(term));
    const type  = isInn ? 'passthrough' : 'brand';

    console.log('[rxnorm] "' + term + '" → [' + ingredients.join(', ') + '] score=' + score + ' type=' + type);
    return store({ resolved: true, type, canonical: ingredients, confidence, score });

  } catch(e) {
    console.warn('[rxnorm] erreur "' + term + '": ' + e.message.slice(0, 80));
    return store({ resolved: false });
  }
}

const RESOLVER_DICT = {

  // ── Synonymes / variantes orthographiques ────────────────────────────────
  'acetaminophen':              { type: 'synonym',   canonical: ['paracetamol'] },
  'paracetamolum':              { type: 'latin',     canonical: ['paracetamol'] },
  'lignocaine':                 { type: 'synonym',   canonical: ['lidocaine'] },
  'lidocainum':                 { type: 'latin',     canonical: ['lidocaine'] },
  'lignocainum':                { type: 'latin',     canonical: ['lidocaine'] },
  'epinephrine':                { type: 'synonym',   canonical: ['adrenaline'] },
  'adrenalin':                  { type: 'synonym',   canonical: ['adrenaline'] },
  'cyclosporin':                { type: 'synonym',   canonical: ['ciclosporin'] },
  'cyclosporine':               { type: 'synonym',   canonical: ['ciclosporin'] },
  'ciclosporine':               { type: 'synonym',   canonical: ['ciclosporin'] },
  'salbutamol':                 { type: 'substance', canonical: ['salbutamol'] },
  'albuterol':                  { type: 'synonym',   canonical: ['salbutamol'] },
  'acetylsalicylate':           { type: 'synonym',   canonical: ['acetylsalicylic acid'] },
  'acide acetylsalicylique':    { type: 'synonym',   canonical: ['acetylsalicylic acid'] },
  'acido acetilsalicilico':     { type: 'synonym',   canonical: ['acetylsalicylic acid'] },

  // ── Acronymes non ambigus ─────────────────────────────────────────────────
  'asa':    { type: 'acronym',   canonical: ['acetylsalicylic acid'] },
  'hcq':    { type: 'acronym',   canonical: ['hydroxychloroquine'] },
  'hcqs':   { type: 'acronym',   canonical: ['hydroxychloroquine'] },
  'cbd':    { type: 'acronym',   canonical: ['cannabidiol'] },
  'thc':    { type: 'acronym',   canonical: ['dronabinol'] },
  'gcs':    { type: 'ambiguous', canonical: [], warning: 'GCS peut désigner les glucocorticoïdes (classe) ou le Glasgow Coma Scale.' },

  // ── Marques → DCI ─────────────────────────────────────────────────────────
  // Immunologie / biothérapies
  'humira':     { type: 'brand', canonical: ['adalimumab'] },
  'remicade':   { type: 'brand', canonical: ['infliximab'] },
  'enbrel':     { type: 'brand', canonical: ['etanercept'] },
  'stelara':    { type: 'brand', canonical: ['ustekinumab'] },
  'dupixent':   { type: 'brand', canonical: ['dupilumab'] },
  'entyvio':    { type: 'brand', canonical: ['vedolizumab'] },
  'simponi':    { type: 'brand', canonical: ['golimumab'] },
  'cimzia':     { type: 'brand', canonical: ['certolizumab'] },
  'cosentyx':   { type: 'brand', canonical: ['secukinumab'] },
  // Oncologie
  'keytruda':   { type: 'brand', canonical: ['pembrolizumab'] },
  'opdivo':     { type: 'brand', canonical: ['nivolumab'] },
  'herceptin':  { type: 'brand', canonical: ['trastuzumab'] },
  'avastin':    { type: 'brand', canonical: ['bevacizumab'] },
  'rituxan':    { type: 'brand', canonical: ['rituximab'] },
  'mabthera':   { type: 'brand', canonical: ['rituximab'] },
  'tafinlar':   { type: 'brand', canonical: ['dabrafenib'] },
  'mekinist':   { type: 'brand', canonical: ['trametinib'] },
  // Analgésiques / AINS
  'doliprane':  { type: 'brand', canonical: ['paracetamol'] },
  'efferalgan': { type: 'brand', canonical: ['paracetamol'] },
  'dafalgan':   { type: 'brand', canonical: ['paracetamol'] },
  'tylenol':    { type: 'brand', canonical: ['paracetamol'] },
  'advil':      { type: 'brand', canonical: ['ibuprofen'] },
  'nurofen':    { type: 'brand', canonical: ['ibuprofen'] },
  'brufen':     { type: 'brand', canonical: ['ibuprofen'] },
  'aspirin':    { type: 'brand', canonical: ['acetylsalicylic acid'] },
  'aspirine':   { type: 'brand', canonical: ['acetylsalicylic acid'] },
  'aspegic':    { type: 'brand', canonical: ['acetylsalicylic acid'] },
  'kardegic':   { type: 'brand', canonical: ['acetylsalicylic acid'] },
  'voltaren':   { type: 'brand', canonical: ['diclofenac'] },
  'celebrex':   { type: 'brand', canonical: ['celecoxib'] },
  // Anesthésiques locaux / combos
  'emla':       { type: 'brand', canonical: ['lidocaine', 'prilocaine'] },
  'versatis':   { type: 'brand', canonical: ['lidocaine'] },
  // Contraceptifs
  'zoely':      { type: 'brand', canonical: ['nomegestrol acetate', 'estradiol'] },
  'qlaira':     { type: 'brand', canonical: ['estradiol valerate', 'dienogest'] },
  // Dermatologie
  'dovobet':    { type: 'brand', canonical: ['calcipotriol', 'betamethasone dipropionate'] },
  'enstilum':   { type: 'brand', canonical: ['calcipotriol', 'betamethasone dipropionate'] },
  'crysalis':   { type: 'brand', canonical: ['calcipotriol', 'betamethasone dipropionate'] },
  // Diabétologie / obésité
  'ozempic':    { type: 'brand', canonical: ['semaglutide'] },
  'wegovy':     { type: 'brand', canonical: ['semaglutide'] },
  'trulicity':  { type: 'brand', canonical: ['dulaglutide'] },
  'victoza':    { type: 'brand', canonical: ['liraglutide'] },
  'jardiance':  { type: 'brand', canonical: ['empagliflozin'] },
  'glucophage': { type: 'brand', canonical: ['metformin'] },
  'lantus':     { type: 'brand', canonical: ['insulin glargine'] },
  // Cardiovasculaire / anticoagulants
  'xarelto':    { type: 'brand', canonical: ['rivaroxaban'] },
  'eliquis':    { type: 'brand', canonical: ['apixaban'] },
  'pradaxa':    { type: 'brand', canonical: ['dabigatran'] },
  'plavix':     { type: 'brand', canonical: ['clopidogrel'] },
  'lipitor':    { type: 'brand', canonical: ['atorvastatin'] },
  'tahor':      { type: 'brand', canonical: ['atorvastatin'] },
  'crestor':    { type: 'brand', canonical: ['rosuvastatin'] },
  'zocor':      { type: 'brand', canonical: ['simvastatin'] },
  // Respiratoire
  'ventolin':   { type: 'brand', canonical: ['salbutamol'] },
  'symbicort':  { type: 'brand', canonical: ['budesonide', 'formoterol'] },
  'seretide':   { type: 'brand', canonical: ['salmeterol', 'fluticasone'] },
  // Neurologie / psychiatrie
  'prozac':     { type: 'brand', canonical: ['fluoxetine'] },
  'zoloft':     { type: 'brand', canonical: ['sertraline'] },
  'lexapro':    { type: 'brand', canonical: ['escitalopram'] },
  'cipralex':   { type: 'brand', canonical: ['escitalopram'] },
  'xanax':      { type: 'brand', canonical: ['alprazolam'] },
  'valium':     { type: 'brand', canonical: ['diazepam'] },
  'temesta':    { type: 'brand', canonical: ['lorazepam'] },
  // Gastro / PPIs
  'nexium':     { type: 'brand', canonical: ['esomeprazole'] },
  'losec':      { type: 'brand', canonical: ['omeprazole'] },
  'mopral':     { type: 'brand', canonical: ['omeprazole'] },
  // Antibiotiques / anti-infectieux
  'zavicefta':  { type: 'brand', canonical: ['ceftazidime', 'avibactam'] },
  'avycaz':     { type: 'brand', canonical: ['ceftazidime', 'avibactam'] },

  // ── Classes thérapeutiques ────────────────────────────────────────────────
  // → pas d'analyse directe, on expose les suggestions à l'UI
  'anti-tnf':            { type: 'class', canonical: [], suggestions: ['adalimumab', 'infliximab', 'etanercept', 'certolizumab', 'golimumab'] },
  'anti tnf':            { type: 'class', canonical: [], suggestions: ['adalimumab', 'infliximab', 'etanercept', 'certolizumab', 'golimumab'] },
  'tnf inhibitor':       { type: 'class', canonical: [], suggestions: ['adalimumab', 'infliximab', 'etanercept'] },
  'tnf inhibitors':      { type: 'class', canonical: [], suggestions: ['adalimumab', 'infliximab', 'etanercept'] },
  'beta-blocker':        { type: 'class', canonical: [], suggestions: ['metoprolol', 'bisoprolol', 'atenolol', 'carvedilol'] },
  'beta blocker':        { type: 'class', canonical: [], suggestions: ['metoprolol', 'bisoprolol', 'atenolol', 'carvedilol'] },
  'beta-blockers':       { type: 'class', canonical: [], suggestions: ['metoprolol', 'bisoprolol', 'atenolol', 'carvedilol'] },
  'ssri':                { type: 'class', canonical: [], suggestions: ['fluoxetine', 'sertraline', 'escitalopram', 'paroxetine', 'citalopram'] },
  'ssris':               { type: 'class', canonical: [], suggestions: ['fluoxetine', 'sertraline', 'escitalopram', 'paroxetine'] },
  'snri':                { type: 'class', canonical: [], suggestions: ['venlafaxine', 'duloxetine', 'desvenlafaxine'] },
  'snris':               { type: 'class', canonical: [], suggestions: ['venlafaxine', 'duloxetine'] },
  'nsaid':               { type: 'class', canonical: [], suggestions: ['ibuprofen', 'naproxen', 'diclofenac', 'celecoxib'] },
  'nsaids':              { type: 'class', canonical: [], suggestions: ['ibuprofen', 'naproxen', 'diclofenac', 'celecoxib'] },
  'ppi':                 { type: 'class', canonical: [], suggestions: ['omeprazole', 'pantoprazole', 'esomeprazole', 'lansoprazole'] },
  'ppis':                { type: 'class', canonical: [], suggestions: ['omeprazole', 'pantoprazole', 'esomeprazole'] },
  'ace inhibitor':       { type: 'class', canonical: [], suggestions: ['ramipril', 'perindopril', 'lisinopril', 'enalapril'] },
  'ace inhibitors':      { type: 'class', canonical: [], suggestions: ['ramipril', 'perindopril', 'lisinopril', 'enalapril'] },
  'arb':                 { type: 'class', canonical: [], suggestions: ['losartan', 'valsartan', 'irbesartan', 'candesartan'] },
  'statin':              { type: 'class', canonical: [], suggestions: ['atorvastatin', 'rosuvastatin', 'simvastatin', 'pravastatin'] },
  'statins':             { type: 'class', canonical: [], suggestions: ['atorvastatin', 'rosuvastatin', 'simvastatin', 'pravastatin'] },
  'checkpoint inhibitor':{ type: 'class', canonical: [], suggestions: ['pembrolizumab', 'nivolumab', 'atezolizumab', 'durvalumab'] },
  'immunosuppressant':   { type: 'class', canonical: [], suggestions: ['azathioprine', 'ciclosporin', 'tacrolimus', 'mycophenolate'] },

};

// Résoudre une entrée brute en substance(s) canonique(s)
async function resolveInput(raw) {
  const input   = raw.trim();
  const key     = stripAccents(input.toLowerCase());

  // 1. Normaliser les séparateurs combo alternatifs (+ / and / &) → slash
  const keyNorm = key.replace(/\s*[+&]\s*/g, '/').replace(/\s+and\s+/g, '/');

  // 2. Détecter combo issu de séparateur alternatif (pas encore slash dans l'input original)
  if (!key.includes('/') && keyNorm.includes('/')) {
    const parts = keyNorm.split('/').map(s => s.trim()).filter(Boolean);
    return {
      canonical: parts.join('/'), type: 'combo',
      displayLabel: parts.join(' + '), aliasesMatched: [], confidence: 'high', warning: null
    };
  }

  // 3. Déjà au format combo slash → passer tel quel
  if (key.includes('/')) {
    return {
      canonical: key, type: 'combo',
      displayLabel: key.split('/').map(s => s.trim()).join(' + '),
      aliasesMatched: [], confidence: 'high', warning: null
    };
  }

  // 4. Lookup dictionnaire (clés normalisées = sans accents, lowercase)
  const entry = RESOLVER_DICT[key];
  if (entry) {
    if (entry.type === 'class') {
      return {
        canonical: null, type: 'class', displayLabel: key,
        aliasesMatched: [], confidence: 'none',
        warning: 'Classe thérapeutique détectée — précisez une substance active.',
        suggestions: entry.suggestions || []
      };
    }
    if (entry.type === 'ambiguous') {
      return {
        canonical: key, type: 'ambiguous', displayLabel: key,
        aliasesMatched: [], confidence: 'low',
        warning: entry.warning || 'Terme ambigu — résultats non garantis.'
      };
    }
    const c = entry.canonical || [];
    if (c.length === 0) {
      return { canonical: null, type: entry.type, displayLabel: key, aliasesMatched: [], confidence: 'none', warning: null };
    }
    return {
      canonical:      c.join('/'),
      type:           entry.type,
      displayLabel:   c.length > 1 ? c.join(' + ') : c[0],
      aliasesMatched: [key],
      confidence:     'high',
      warning:        null
    };
  }

  // 5. RxNorm — résolution dynamique pour les termes inconnus du dictionnaire
  const rxResult = await resolveViaRxNorm(key);
  if (rxResult.resolved && rxResult.canonical && rxResult.canonical.length > 0) {
    const canonStr   = rxResult.canonical.join('/');
    const isPassthru = rxResult.type === 'passthrough';
    const label      = rxResult.canonical.length > 1
      ? rxResult.canonical.join(' + ')
      : rxResult.canonical[0];
    console.log('[rxnorm] "' + key + '" → ' + canonStr + ' (' + rxResult.type + ', score=' + rxResult.score + ')');
    return {
      canonical:      canonStr,
      type:           rxResult.type,
      displayLabel:   label,
      aliasesMatched: isPassthru ? [] : [key],
      confidence:     rxResult.confidence,
      warning: rxResult.confidence === 'medium'
        ? 'Correspondance approchée via RxNorm — vérifiez la substance.'
        : null
    };
  }

  // 6. Passthrough — comportement actuel préservé (aucune résolution trouvée)
  return {
    canonical: key, type: 'passthrough',
    displayLabel: key, aliasesMatched: [], confidence: 'high', warning: null
  };
}

// ─── Handler principal ────────────────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: HEADERS, body: '' };
  }

  const rawSubstance = (event.queryStringParameters?.substance || '').trim();
  const country      = (event.queryStringParameters?.country   || '').trim().toLowerCase();

  if (!rawSubstance) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Substance manquante' }) };
  }

  // ── Résolution de l'entrée utilisateur ───────────────────────────────────
  const resolved = await resolveInput(rawSubstance);

  // Objet complet (toujours rempli, même pour passthrough) — utilisé par resolve_only
  const resolverFull = {
    type:          resolved.type,
    canonical:     resolved.canonical,
    displayLabel:  resolved.displayLabel || resolved.canonical || rawSubstance,
    aliasesMatched:resolved.aliasesMatched || [],
    confidence:    resolved.confidence || 'high',
    warning:       resolved.warning || null,
    ...(resolved.suggestions ? { suggestions: resolved.suggestions } : {})
  };

  // resolverMeta est null pour les passthroughs (rétro-compat JSON réponse normale)
  const resolverMeta = (resolved.type !== 'passthrough') ? resolverFull : null;

  console.log('[resolver] "' + rawSubstance + '" → type=' + resolved.type
    + ' canonical=' + resolved.canonical + ' confidence=' + resolved.confidence);

  // ── Mode resolve_only : retourner uniquement la résolution, sans appels réseau ──
  if (event.queryStringParameters?.resolve_only === '1') {
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ resolver: resolverFull }) };
  }

  // Classe thérapeutique ou entrée non résoluble → pas d'analyse lancée
  if (!resolved.canonical) {
    return {
      statusCode: 200, headers: HEADERS,
      body: JSON.stringify({ resolver: resolverMeta, countries: [] })
    };
  }

  // Gestion des combinaisons A/B (ex: "calcipotriol/betamethasone dipropionate")
  const { primary: substance, filters: comboFilters } = parseCombo(resolved.canonical);
  if (comboFilters.length > 0) {
    console.log('[combo] Recherche "' + resolved.canonical + '" → primary="' + substance + '" filters=' + JSON.stringify(comboFilters));
  }

  const SOURCES = {
    fr: { label: 'BDPM / ANSM',              fetch: () => fetchFrance(substance)      },
    es: { label: 'CIMA / AEMPS',             fetch: () => fetchSpain(substance)       },
    pt: { label: 'INFARMED',                 fetch: () => fetchPortugal(substance)    },
    be: { label: 'medicinesdatabase / FAMHP', fetch: () => fetchBelgium(substance)    },
    de: { label: 'Gelbe Liste / BfArM',       fetch: () => fetchGermany(substance)    },
    it: { label: 'AIFA',                      fetch: () => fetchItaly(substance)      },
    nl: { label: 'Geneesmiddelen DB / CBG-MEB', fetch: () => fetchNetherlands(substance) },
    at: { label: 'BASG Arzneimittel-DB',      fetch: () => fetchAustria(substance)    },
    se: { label: 'Läkemedelsverket',          fetch: () => fetchSweden(substance)     },
    pl: { label: 'Rejestr Prod. Leczniczych', fetch: () => fetchPoland(substance)     }
  };

  const meta = SOURCES[country];
  if (!meta) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Pays non supporté: ' + country }) };
  }

  // Pays avec une API/données publiques accessibles (null = inaccessible, pas "pas d'API")
  const HAS_API = new Set(['fr', 'es', 'pt', 'be', 'it', 'nl', 'at', 'se', 'pl']);

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
        // Pays sans API publique connue
        countryData = {
          country, source: meta.label,
          products: [], total: 0,
          note: 'Pas d\'API JSON publique disponible pour ce pays.',
          link: COUNTRY_LINKS[country] || null
        };
      }
    } else {
      let products = Array.isArray(result) ? result : [];
      // ─── Filtrage combinaison A/B ─────────────────────────────────────────────
      if (comboFilters.length > 0) {
        const before = products.length;

        if (country === 'fr') {
          // France — BDPM ne retourne pas les DCI dans ses résultats.
          // Stratégie : intersection par nom de produit entre les recherches des
          // différentes substances (ex : ceftazidime ∩ avibactam → ZAVICEFTA).
          // On lance les recherches des filtres en parallèle pour limiter la latence.
          const filterResults = await Promise.all(
            comboFilters.map(f => fetchFrance(f).catch(() => []))
          );
          const filterSets = filterResults.map(r => new Set((r || []).map(p => p.name)));
          products = products.filter(p => filterSets.every(ns => ns.has(p.name)));
          console.log('[combo:FR] Intersection ' + comboFilters.join('+') + ': ' + before + ' → ' + products.length);
        } else {
          // BE / ES / PT — filtrage via _substances (DCI stockées par chaque fetch)
          products = applyComboFilter(products, comboFilters);
          console.log('[combo] Filtre "' + comboFilters.join('+') + '": ' + before + ' → ' + products.length + ' produits');
        }
      }
      // Supprimer le champ interne _substances avant de retourner au client
      products = products.map(({ _substances, ...rest }) => rest);
      countryData = {
        country, source: meta.label,
        products, total: products.length
      };
    }

    const responseBody = { countries: [countryData] };
    if (resolverMeta) responseBody.resolver = resolverMeta;
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(responseBody) };
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
