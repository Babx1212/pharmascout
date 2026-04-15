/**
 * PharmaScout — Netlify Function : EMA Proxy (v5)
 * Utilise les JSON data files officiels de l'EMA (mis à jour 2x/jour).
 * - Referrals JSON  : tous les referrals PRAC (Art. 30, 31, 107i, etc.)
 * - DHPCs JSON      : communications directes professionnels de santé
 * - PSUSAs JSON     : évaluations périodiques de sécurité (NEW v5)
 * - Medicines JSON  : produits centralement autorisés
 * Cache module-level (persist entre invocations warm Lambda).
 */

const https = require('https');

const EMA_REFERRALS_URL = 'https://www.ema.europa.eu/en/documents/report/referrals-output-json-report_en.json';
const EMA_DHPC_URL      = 'https://www.ema.europa.eu/en/documents/report/dhpc-output-json-report_en.json';
const EMA_PSUSA_URL     = 'https://www.ema.europa.eu/en/documents/report/medicines-output-periodic_safety_update_report_single_assessments-output-json-report_en.json';
const EMA_MEDICINES_URL = 'https://www.ema.europa.eu/en/documents/report/medicines-output-medicines_json-report_en.json';

// Cache module-level (warm Lambda instances)
let _cache = { referrals: null, dhpcs: null, psusas: null, medicines: null, ts: 0, tsMed: 0 };
const CACHE_TTL     = 6 * 60 * 60 * 1000;  // 6h for referrals/dhpcs/psusas
const CACHE_TTL_MED = 12 * 60 * 60 * 1000; // 12h for medicines (large file)

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: HEADERS, body: '' };
  }

  const substance = (event.queryStringParameters?.substance || '').trim().toLowerCase();
  if (!substance) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing substance parameter' }) };
  }

  try {
    const now = Date.now();

    // --- 1. Charger / rafraîchir le cache EMA (referrals + DHPCs + PSUSAs) ---
    if (!_cache.referrals || (now - _cache.ts) > CACHE_TTL) {
      const [refData, dhpcData, psusaData] = await Promise.all([
        fetchJson(EMA_REFERRALS_URL, 25000),
        fetchJson(EMA_DHPC_URL, 25000).catch(() => ({ data: [] })),
        fetchJson(EMA_PSUSA_URL, 25000).catch(() => ({ data: [] }))
      ]);
      _cache.referrals = extractArray(refData);
      _cache.dhpcs     = extractArray(dhpcData);
      _cache.psusas    = extractArray(psusaData);
      _cache.ts = now;
    }

    // --- 1b. Charger les médicaments (séparé car fichier très volumineux) ---
    if (!_cache.medicines || (now - _cache.tsMed) > CACHE_TTL_MED) {
      try {
        const medData = await Promise.race([
          fetchJson(EMA_MEDICINES_URL, 20000),
          new Promise(r => setTimeout(() => r(null), 12000))
        ]);
        _cache.medicines = medData ? extractArray(medData) : [];
        _cache.tsMed = now;
      } catch (_) {
        if (!_cache.medicines) _cache.medicines = [];
      }
    }

    // --- 2. Construire les mots-clés de recherche ---
    const substanceClean = substance.replace(/[^a-z0-9\s]/g, ' ').trim();
    const keywords = [...new Set(
      substanceClean.split(/\s+/).filter(w => w.length >= 4)
    )];
    if (keywords.length === 0) keywords.push(substanceClean);

    function matchesSubstance(text) {
      const t = (text || '').toLowerCase();
      return keywords.some(k => t.includes(k));
    }

    // --- 3. Recherche dans les Referrals ---
    const matchingReferrals = _cache.referrals.filter(r => {
      if (r.category !== 'Human') return false;
      return matchesSubstance(r.international_non_proprietary_name_inn_common_name)
          || matchesSubstance(r.referral_name);
    });

    // Trier : safety referrals en premier, puis par date de décision (plus récent)
    matchingReferrals.sort((a, b) => {
      if (a.safety_referral === 'Yes' && b.safety_referral !== 'Yes') return -1;
      if (a.safety_referral !== 'Yes' && b.safety_referral === 'Yes') return 1;
      return (b.european_commission_decision_date || '').localeCompare(a.european_commission_decision_date || '');
    });

    const pracActive  = matchingReferrals.length > 0;
    const mainRef     = matchingReferrals[0] || null;
    const safetyRefs  = matchingReferrals.filter(r => r.safety_referral === 'Yes');

    // --- 4. Recherche dans les DHPCs ---
    const matchingDhpcs = _cache.dhpcs.filter(d => {
      return matchesSubstance(d.active_substances)
          || matchesSubstance(d.name_of_medicine);
    }).map(d => ({
      name:     d.name_of_medicine   || '',
      url:      d.dhpc_url           || '',
      date:     d.dissemination_date || '',
      outcome:  d.regulatory_outcome || '',
      type:     d.dhpc_type          || ''
    }));

    // --- 5. Recherche dans les PSUSAs (NEW v5) ---
    const matchingPsusas = _cache.psusas.filter(p => {
      return matchesSubstance(p.active_substances_in_scope_of_procedure)
          || matchesSubstance(p.related_medicines);
    }).map(p => ({
      substance:  p.active_substances_in_scope_of_procedure || '',
      medicines:  p.related_medicines || '',
      procedure:  p.procedure_number  || '',
      outcome:    p.regulatory_outcome || '',
      url:        p.psusa_url         || '',
      updated:    p.last_updated_date || ''
    }));

    // Trier PSUSAs par date de mise à jour (plus récent d'abord)
    matchingPsusas.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));

    // --- 6. Recherche dans les Médicaments autorisés ---
    const emaProducts = _cache.medicines.filter(r => {
      return r.active_substance && r.active_substance.toLowerCase().includes(substance);
    }).slice(0, 30).map(r => ({
      name:   r.name_of_medicine || '—',
      holder: r.marketing_authorisation_developer_applicant_holder || '—',
      status: r.medicine_status || '—'
    }));

    // --- 7. Construire la réponse ---
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        substance,

        // Produits centralement autorisés par l'EMA
        totalEUProducts: emaProducts.length,
        products: emaProducts,

        // Signal de sécurité PRAC (referrals)
        pracActive,
        pracDetails:        mainRef ? mainRef.referral_name                          : null,
        pracUrl:            mainRef ? mainRef.referral_url                           : null,
        pracStatus:         mainRef ? mainRef.current_status                         : null,
        pracRecommendation: mainRef ? mainRef.prac_recommendation                   : null,
        pracDecisionDate:   mainRef ? mainRef.european_commission_decision_date      : null,
        pracType:           mainRef ? mainRef.referral_type                          : null,
        isSafetyReferral:   mainRef ? (mainRef.safety_referral === 'Yes')            : false,

        // Tous les referrals correspondants
        allReferrals: matchingReferrals.map(r => ({
          name:           r.referral_name,
          url:            r.referral_url,
          inn:            r.international_non_proprietary_name_inn_common_name,
          status:         r.current_status,
          type:           r.referral_type,
          isSafety:       r.safety_referral === 'Yes',
          recommendation: r.prac_recommendation,
          startDate:      r.procedure_start_date,
          decisionDate:   r.european_commission_decision_date
        })),

        // PSUSAs (NEW v5)
        psusas: matchingPsusas,
        totalPsusas: matchingPsusas.length,

        // DHPCs (communications sécurité)
        dhpcs: matchingDhpcs,
        hasDhpc: matchingDhpcs.length > 0,

        // Compteurs
        referralMentions: matchingReferrals.length,
        safetyReferralCount: safetyRefs.length,

        // Lien de recherche EMA
        searchUrl: `https://www.ema.europa.eu/en/search?search_api_fulltext=${encodeURIComponent(substance)}`,
        cacheAge: Math.round((now - _cache.ts) / 1000 / 60)
      })
    };

  } catch (e) {
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ error: e.message, substance })
    };
  }
};

/**
 * Extrait un tableau depuis une réponse JSON EMA.
 * Les fichiers EMA encapsulent les données dans { data: [...] } ou retournent directement un tableau.
 */
function extractArray(jsonData) {
  if (!jsonData) return [];
  if (Array.isArray(jsonData)) return jsonData;
  if (jsonData.data && Array.isArray(jsonData.data)) return jsonData.data;
  return [];
}

/**
 * Télécharge et parse un fichier JSON depuis une URL HTTPS.
 * Suit les redirections HTTP 3xx.
 */
function fetchJson(url, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PharmaScout/2.0)',
        'Accept':     'application/json, */*'
      }
    }, (res) => {
      // Suivre les redirections
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        const next = loc.startsWith('http') ? loc : 'https://www.ema.europa.eu' + loc;
        res.resume();
        fetchJson(next, timeout).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(new Error('JSON parse error: ' + e.message));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
  });
}
