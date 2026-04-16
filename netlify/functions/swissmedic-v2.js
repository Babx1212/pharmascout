/**
 * PharmaScout — Netlify Function : Swissmedic V2
 * Recherche par substance active dans l'Excel "Erweiterte Arzneimittelliste HAM".
 * Retourne : produits monocomposants, combinaisons, produit de référence plausible.
 */

const https = require('https');
const XLSX = require('xlsx');

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type'
};

// Cache mémoire (warm start Netlify — persiste ~5-10 min entre invocations)
let cachedData = null;
let cacheTimestamp = 0;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h — l'Excel change mensuellement

const EXCEL_URL = 'https://www.swissmedic.ch/dam/swissmedic/de/dokumente/internetlisten/erweiterte_ham_ind.xlsx.download.xlsx/Erweiterte_Arzneimittelliste%20HAM.xlsx';

// Colonnes de l'Excel (row 6 = headers, data commence row 7)
const COL = {
  AUTH_NUM: 0,        // Zulassungsnummer / N° d'autorisation
  DOSE_NUM: 1,        // Dosisstärke-nummer
  NAME: 2,            // Bezeichnung / Dénomination
  HOLDER: 3,          // Zulassungsinhaberin / Titulaire
  ATC: 8,             // ATC-Code
  FIRST_AUTH: 9,      // Erstzulassungsdatum / Date première autorisation
  SUBSTANCE: 14,      // Wirkstoff(e) / Principe(s) actif(s)
  STATUS: 23          // Zulassungsstatus / Statut
};

// ──────────────────────────────────────────────────
// HANDLER
// ──────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: HEADERS, body: '' };
  }

  const substance = (event.queryStringParameters?.substance || '').trim();
  if (!substance) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing substance parameter' }) };
  }

  try {
    // 1. Charger et parser l'Excel (avec cache)
    const rows = await loadExcelData();

    // 2. Normaliser la substance saisie et générer les racines de recherche
    const stems = buildSearchStems(substance);

    // 3. Filtrer les produits par substance active
    const matched = filterBySubstance(rows, stems);

    // 4. Dédupliquer par numéro d'autorisation (garder première ligne)
    const deduped = deduplicateByAuth(matched);

    // 5. Séparer mono vs combinaisons
    const { mono, combinations } = separateMonoCombi(deduped, stems);

    // 6. Trier par date de première autorisation
    mono.sort((a, b) => (a.firstAuth || '9999').localeCompare(b.firstAuth || '9999'));
    combinations.sort((a, b) => (a.firstAuth || '9999').localeCompare(b.firstAuth || '9999'));

    // 7. Identifier le produit de référence plausible (monocomposants uniquement)
    const reference = identifyReference(mono);

    // 8. Collecter les titulaires uniques
    const allProducts = [...mono, ...combinations];
    const holders = [...new Set(allProducts.map(p => p.holder).filter(Boolean))];

    // 9. Pharmacovigilance (conserver la logique existante)
    const pvResult = await checkPharmacovigilance(substance);

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        substance,
        matchedAs: stems[0] || substance.toLowerCase(),
        products: mono.slice(0, 15),
        combinations: combinations.slice(0, 10),
        reference,
        meta: {
          totalMono: mono.length,
          totalCombi: combinations.length,
          holders: holders.length,
          holderNames: holders.slice(0, 10),
          source: 'Swissmedic Erweiterte HAM'
        },
        // Champs de compatibilité avec le frontend existant
        totalCHProducts: mono.length + combinations.length,
        pvAlert: pvResult.pvAlert,
        pvDetails: pvResult.pvDetails,
        pvConfidence: pvResult.pvConfidence || 'indicative',
        searchUrl: `https://www.swissmedic.ch/swissmedic/en/home/services/listen_neu.html`
      })
    };

  } catch (e) {
    console.error('swissmedic-v2 error:', e);
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ error: e.message, substance })
    };
  }
};

// ──────────────────────────────────────────────────
// CHARGEMENT EXCEL
// ──────────────────────────────────────────────────

async function loadExcelData() {
  const now = Date.now();
  if (cachedData && (now - cacheTimestamp) < CACHE_TTL) {
    return cachedData;
  }

  const buffer = await fetchBuffer(EXCEL_URL);
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1 });

  // Skip metadata rows (0-6), data starts at row 7
  const rows = [];
  for (let i = 7; i < raw.length; i++) {
    const r = raw[i];
    if (!r || !r[COL.AUTH_NUM]) continue;
    rows.push({
      authNum: r[COL.AUTH_NUM],
      doseNum: r[COL.DOSE_NUM],
      name: cleanStr(r[COL.NAME]),
      holder: cleanStr(r[COL.HOLDER]),
      atc: cleanStr(r[COL.ATC]),
      firstAuth: excelDateToISO(r[COL.FIRST_AUTH]),
      substance: cleanStr(r[COL.SUBSTANCE]),
      status: cleanStr(r[COL.STATUS])
    });
  }

  cachedData = rows;
  cacheTimestamp = now;
  return rows;
}

// ──────────────────────────────────────────────────
// NORMALISATION ET MATCHING
// ──────────────────────────────────────────────────

/**
 * Construit les racines de recherche à partir de la substance saisie.
 * Ex: "ceftazidime" → ["ceftazidim", "ceftazidime"]
 * Ex: "finasteride" → ["finasterid", "finasteride"]
 * On retire les suffixes latins courants pour élargir le match.
 */
function buildSearchStems(substance) {
  const base = normalize(substance);
  const stems = new Set();
  stems.add(base);

  // Retirer les suffixes latins/français courants pour créer des racines
  const suffixes = ['um', 'um-', 'e', 'ine', 'inum', 'idum', 'ide', 'ate', 'ate-'];
  for (const suf of suffixes) {
    if (base.endsWith(suf) && base.length - suf.length >= 5) {
      stems.add(base.slice(0, -suf.length));
    }
  }

  // Ajouter aussi la forme courte si > 6 chars (filet de sécurité)
  if (base.length > 6) {
    // Ne pas tronquer trop court pour éviter les faux positifs
    const minStem = base.slice(0, Math.max(6, Math.floor(base.length * 0.7)));
    stems.add(minStem);
  }

  // Trier par longueur décroissante (le plus spécifique d'abord)
  return [...stems].sort((a, b) => b.length - a.length);
}

/**
 * Normalise une chaîne : lowercase, trim, suppression accents.
 */
function normalize(str) {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // retirer les accents
    .replace(/[-\s]+/g, ' ')         // normaliser espaces/tirets
    .trim();
}

/**
 * Filtre les lignes de l'Excel par substance active.
 * Match : la colonne Wirkstoff contient au moins une des racines.
 */
function filterBySubstance(rows, stems) {
  return rows.filter(row => {
    if (!row.substance) return false;
    const sub = normalize(row.substance);
    // Au moins une racine doit matcher
    return stems.some(stem => sub.includes(stem));
  });
}

// ──────────────────────────────────────────────────
// DÉDUPLICATION ET SÉPARATION
// ──────────────────────────────────────────────────

/**
 * Déduplique par numéro d'autorisation — ne garder que le premier dosage.
 */
function deduplicateByAuth(rows) {
  const seen = new Map();
  for (const row of rows) {
    const key = String(row.authNum);
    if (!seen.has(key)) {
      seen.set(key, row);
    }
  }
  return [...seen.values()];
}

/**
 * Sépare monocomposants et combinaisons.
 * Heuristique : si le champ substance contient une virgule, c'est une combinaison.
 */
function separateMonoCombi(rows, stems) {
  const mono = [];
  const combinations = [];

  for (const row of rows) {
    const rawSub = row.substance || '';
    // Détecter les combinaisons : virgule dans le champ substance
    const parts = rawSub.split(',').map(s => s.trim()).filter(Boolean);

    if (parts.length > 1) {
      // C'est une combinaison — vérifier que la substance recherchée est bien dedans
      const normParts = parts.map(p => normalize(p));
      const isRelevant = stems.some(stem => normParts.some(np => np.includes(stem)));
      if (isRelevant) {
        combinations.push({
          ...formatProduct(row),
          substances: parts,
          isCombination: true
        });
      }
    } else {
      mono.push({
        ...formatProduct(row),
        isCombination: false
      });
    }
  }

  return { mono, combinations };
}

/**
 * Formate un produit pour la sortie JSON.
 */
function formatProduct(row) {
  return {
    authNum: row.authNum,
    name: simplifyName(row.name),
    fullName: row.name,
    holder: row.holder,
    atc: row.atc || null,
    firstAuth: row.firstAuth,
    status: row.status
  };
}

/**
 * Simplifie le nom du médicament : retire les détails de dosage/forme.
 * "Fortam 500 mg, Pulver zur Herstellung einer Injektionslösung" → "Fortam"
 */
function simplifyName(name) {
  if (!name) return '';
  // Couper au premier chiffre ou à la première virgule
  const match = name.match(/^([A-Za-zÀ-ÿ\s\-\.]+?)(?:\s+\d|\s*,)/);
  return match ? match[1].trim() : name.split(',')[0].trim();
}

// ──────────────────────────────────────────────────
// IDENTIFICATION PRODUIT DE RÉFÉRENCE
// ──────────────────────────────────────────────────

/**
 * Identifie le produit de référence plausible parmi les monocomposants.
 * Règles :
 * - Seuls les monocomposants sont candidats
 * - Le plus ancien par date de première autorisation
 * - Si ex-aequo : "Classification incertaine"
 * - Si un seul produit : "Seul produit autorisé CH"
 * - Jamais "original" ni "originator"
 */
function identifyReference(mono) {
  if (mono.length === 0) {
    return {
      found: false,
      label: null,
      product: null,
      confidence: null
    };
  }

  if (mono.length === 1) {
    return {
      found: true,
      label: 'Seul produit autorisé CH',
      product: mono[0],
      confidence: 'unique'
    };
  }

  // Trié par date — le premier est le plus ancien
  const oldest = mono[0];
  const secondOldest = mono[1];

  // Vérifier ex-aequo (même date)
  if (oldest.firstAuth && secondOldest.firstAuth &&
      oldest.firstAuth === secondOldest.firstAuth) {
    return {
      found: false,
      label: 'Classification incertaine',
      product: null,
      confidence: 'ambiguous'
    };
  }

  // Le plus ancien est le candidat
  return {
    found: true,
    label: 'Produit de référence plausible',
    product: oldest,
    confidence: 'date'
  };
}

// ──────────────────────────────────────────────────
// PHARMACOVIGILANCE (conservée de swissmedic.js)
// ──────────────────────────────────────────────────

/**
 * Vérification pharmacovigilance Swissmedic.
 * Scrape deux pages Vigilance News. Le match est contextuel :
 * la substance doit apparaître dans le CONTENU principal de la page
 * (titres, paragraphes), pas seulement dans les URLs ou menus de navigation.
 *
 * pvAlert = true si mention identifiée dans le contenu éditorial.
 * pvConfidence = 'indicative' (match de substring dans page HTML,
 *   pas une confirmation pharmacovigilance formelle).
 */
async function checkPharmacovigilance(substance) {
  let pvAlert = false;
  let pvDetails = null;
  const pvConfidence = 'indicative';

  const pvPages = [
    'https://www.swissmedic.ch/swissmedic/en/home/humanarzneimittel/market-surveillance/pharmacovigilance/vigilance-news/vigilance-news.html',
    'https://www.swissmedic.ch/swissmedic/en/home/humanarzneimittel/market-surveillance/pharmacovigilance/vigilance-news.html'
  ];

  const stems = buildSearchStems(substance);
  // Exiger au moins 6 caractères pour éviter les faux positifs sur les stems courts
  const validStems = stems.filter(s => s.length >= 6);
  if (validStems.length === 0) return { pvAlert: false, pvDetails: null, pvConfidence };

  for (const pvUrl of pvPages) {
    try {
      const pvHtml = await fetchText(pvUrl, 8000);

      // Extraire uniquement le contenu éditorial (balises <p>, <h2>, <h3>, <li>, <td>)
      // Exclure les URLs href, attributs HTML et balises de navigation
      const contentBlocks = [];
      const blockPattern = /<(?:p|h[1-6]|li|td|th|div|span)[^>]*>([^<]{10,})<\/(?:p|h[1-6]|li|td|th|div|span)>/gi;
      let m;
      while ((m = blockPattern.exec(pvHtml)) !== null) {
        contentBlocks.push(m[1].toLowerCase());
      }
      const editorialContent = contentBlocks.join(' ');

      // Si l'extraction a échoué (page vide ou format différent), fallback sur le texte brut
      // mais en supprimant d'abord les balises HTML et les URLs
      const textContent = editorialContent.length > 200
        ? editorialContent
        : pvHtml.replace(/<[^>]+>/g, ' ').replace(/https?:\/\/\S+/g, ' ').toLowerCase();

      let matchedStem = null;
      for (const stem of validStems) {
        if (textContent.includes(stem)) {
          matchedStem = stem;
          break;
        }
      }

      if (matchedStem) {
        pvAlert = true;
        // Chercher un lien contextuel dans le HTML brut
        const escaped = matchedStem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const linkPattern = new RegExp(
          `<a[^>]+href="([^"#][^"]*)"[^>]*>[^<]{0,100}${escaped}[^<]{0,100}<\\/a>`, 'i'
        );
        const linkMatch = pvHtml.match(linkPattern);
        if (linkMatch) {
          pvDetails = linkMatch[1].startsWith('http')
            ? linkMatch[1]
            : 'https://www.swissmedic.ch' + linkMatch[1];
        } else {
          pvDetails = pvUrl;
        }
        break;
      }
    } catch (_) { /* non bloquant */ }
  }

  return { pvAlert, pvDetails, pvConfidence };
}

// ──────────────────────────────────────────────────
// UTILITAIRES
// ──────────────────────────────────────────────────

function cleanStr(val) {
  if (val == null) return '';
  return String(val).trim();
}

/**
 * Convertit un numéro de série Excel en date ISO (YYYY-MM-DD).
 */
function excelDateToISO(val) {
  if (!val) return null;
  if (typeof val === 'string') return val; // déjà une chaîne
  if (typeof val === 'number') {
    // Numéro de série Excel : jours depuis 1900-01-01 (avec bug du 29 fév 1900)
    const d = new Date((val - 25569) * 86400000);
    return d.toISOString().split('T')[0];
  }
  return null;
}

/**
 * Télécharge une URL et retourne un Buffer.
 */
function fetchBuffer(url, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PharmaScout/2.0)',
        'Accept': '*/*'
      }
    }, (res) => {
      // Suivre les redirections
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        fetchBuffer(redirectUrl, timeout).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/**
 * Télécharge une URL et retourne le texte.
 */
function fetchText(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PharmaScout/2.0)',
        'Accept': 'text/html'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        fetchText(redirectUrl, timeout).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}
