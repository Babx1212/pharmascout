/**
 * PharmaScout — Netlify Function : EMA Proxy (v6)
 * Sources officielles EMA (mises à jour 2x/jour).
 * - Referrals JSON  : procédures PRAC (Art. 30, 31, 107i, etc.)
 * - DHPCs JSON      : communications directes professionnels de santé
 * - PSUSAs JSON     : évaluations périodiques de sécurité (PSUR single assessments)
 * - Medicines JSON  : produits centralement autorisés
 *
 * v6 : correction URL PSUSA + fallbacks noms de champs + matching amélioré
 */

const https = require('https');

// ─── URLs EMA ────────────────────────────────────────────────────────────────
const EMA_REFERRALS_URL = 'https://www.ema.europa.eu/en/documents/report/referrals-output-json-report_en.json';
const EMA_DHPC_URL      = 'https://www.ema.europa.eu/en/documents/report/dhpc-output-json-report_en.json';
const EMA_MEDICINES_URL = 'https://www.ema.europa.eu/en/documents/report/medicines-output-medicines_json-report_en.json';

// PSUSA : deux URL candidates (la première sans le préfixe medicines-output- incorrect)
const EMA_PSUSA_URLS = [
  'https://www.ema.europa.eu/en/documents/report/periodic_safety_update_report_single_assessments-output-json-report_en.json',
  'https://www.ema.europa.eu/en/documents/report/medicines-output-periodic_safety_update_report_single_assessments-output-json-report_en.json'
];

// ─── Cache module-level (warm Lambda — persiste entre invocations) ────────────
let _cache = { referrals: null, dhpcs: null, psusas: null, medicines: null, ts: 0, tsMed: 0 };
const CACHE_TTL     = 6  * 60 * 60 * 1000; // 6h  — referrals/dhpcs/psusas
const CACHE_TTL_MED = 12 * 60 * 60 * 1000; // 12h — medicines (fichier volumineux)

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type'
};

// ─── Helper : extraire un champ depuis un objet avec plusieurs noms candidats ─
function getField(obj, ...keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return '';
}

// ─── Handler principal ────────────────────────────────────────────────────────
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

    // --- 1. Charger/rafraîchir le cache EMA (referrals + DHPCs + PSUSAs) ---
    if (!_cache.referrals || (now - _cache.ts) > CACHE_TTL) {
      const [refData, dhpcData, psusaData] = await Promise.all([
        fetchJson(EMA_REFERRALS_URL, 25000),
        fetchJson(EMA_DHPC_URL, 25000).catch(() => ({ data: [] })),
        fetchPsusaJson()
      ]);
      _cache.referrals = extractArray(refData);
      _cache.dhpcs     = extractArray(dhpcData);
      _cache.psusas    = extractArray(psusaData);
      _cache.ts = now;
      console.log(`EMA cache loaded: ${_cache.referrals.length} referrals, ${_cache.dhpcs.length} DHPCs, ${_cache.psusas.length} PSUSAs`);
    }

    // --- 1b. Charger les médicaments (fichier volumineux, cache séparé) ---
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

    // --- 2. Mots-clés de recherche ---
    // Pour les combinaisons (ex: "prilocaine + lidocaine"), on split sur +
    const parts = substance.replace(/[^a-z0-9\s+]/g, ' ').split(/\s*\+\s*/).map(s => s.trim()).filter(Boolean);
    const allKeywords = [];
    for (const part of parts) {
      const words = part.split(/\s+/).filter(w => w.length >= 4);
      if (words.length > 0) allKeywords.push(...words);
      else if (part.length >= 3) allKeywords.push(part);
    }
    const keywords = [...new Set(allKeywords)];
    if (keywords.length === 0) keywords.push(substance);

    function matchesSubstance(text) {
      const t = (text || '').toLowerCase();
      return keywords.some(k => t.includes(k));
    }

    // --- 3. Referrals ---
    const matchingReferrals = _cache.referrals.filter(r => {
      if (r.category !== 'Human') return false;
      return matchesSubstance(r.international_non_proprietary_name_inn_common_name)
          || matchesSubstance(r.referral_name);
    });

    matchingReferrals.sort((a, b) => {
      if (a.safety_referral === 'Yes' && b.safety_referral !== 'Yes') return -1;
      if (a.safety_referral !== 'Yes' && b.safety_referral === 'Yes') return 1;
      return (b.european_commission_decision_date || '').localeCompare(a.european_commission_decision_date || '');
    });

    const pracActive = matchingReferrals.length > 0;
    const mainRef    = matchingReferrals[0] || null;
    const safetyRefs = matchingReferrals.filter(r => r.safety_referral === 'Yes');

    // --- 4. DHPCs ---
    const matchingDhpcs = _cache.dhpcs.filter(d => {
      return matchesSubstance(d.active_substances)
          || matchesSubstance(d.name_of_medicine);
    }).map(d => ({
      name:    d.name_of_medicine   || '',
      url:     d.dhpc_url           || '',
      date:    d.dissemination_date || '',
      outcome: d.regulatory_outcome || '',
      type:    d.dhpc_type          || ''
    }));

    // --- 5. PSUSAs ---
    // Le JSON PSUSA peut utiliser différents noms de champs selon la version EMA.
    // On essaie plusieurs variantes pour chaque champ.
    const matchingPsusas = _cache.psusas.filter(p => {
      const subField = getField(p,
        'active_substances_in_scope_of_procedure',
        'active_substance',
        'inn',
        'international_non_proprietary_name',
        'substances'
      );
      const medField = getField(p,
        'related_medicines',
        'medicine_name',
        'medicines_included',
        'product_name'
      );
      return matchesSubstance(subField) || matchesSubstance(medField)
          || matchesSubstance(p.referral_name || '') || matchesSubstance(p.procedure_number || '');
    }).map(p => {
      const substanceVal = getField(p,
        'active_substances_in_scope_of_procedure',
        'active_substance', 'inn', 'international_non_proprietary_name', 'substances'
      );
      const medicinesVal = getField(p,
        'related_medicines', 'medicine_name', 'medicines_included', 'product_name'
      );
      const procedureVal = getField(p,
        'procedure_number', 'psusa_procedure_number', 'procedure_id', 'referral_name'
      );
      const outcomeVal = getField(p,
        'regulatory_outcome', 'outcome', 'psusa_outcome', 'recommendation'
      );
      const urlVal = getField(p,
        'psusa_url', 'procedure_url', 'url', 'referral_url'
      );
      const updatedVal = getField(p,
        'last_updated_date', 'date_of_opinion', 'opinion_date', 'updated_date', 'date'
      );
      return { substance: substanceVal, medicines: medicinesVal, procedure: procedureVal,
               outcome: outcomeVal, url: urlVal, updated: updatedVal };
    });

    matchingPsusas.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));

    // --- 6. Médicaments autorisés EMA ---
    const emaProducts = _cache.medicines.filter(r => {
      return r.active_substance && r.active_substance.toLowerCase().includes(
        keywords[0] || substance
      );
    }).slice(0, 30).map(r => ({
      name:   r.name_of_medicine || '—',
      holder: r.marketing_authorisation_developer_applicant_holder || '—',
      status: r.medicine_status  || '—'
    }));

    // --- 7. Réponse ---
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        substance,

        // Signal global (pour onglet Sécurité)
        pvSignal: pracActive ? (safetyRefs.length > 0 ? 'safety' : 'prac')
                             : (matchingPsusas.length > 0 ? 'psusa'
                             : (matchingDhpcs.length > 0  ? 'dhpc' : 'none')),

        // Referrals
        pracActive,
        pracDetails:        mainRef ? mainRef.referral_name                     : null,
        pracUrl:            mainRef ? mainRef.referral_url                      : null,
        pracStatus:         mainRef ? mainRef.current_status                    : null,
        pracRecommendation: mainRef ? mainRef.prac_recommendation               : null,
        pracDecisionDate:   mainRef ? mainRef.european_commission_decision_date : null,
        pracType:           mainRef ? mainRef.referral_type                     : null,
        isSafetyReferral:   mainRef ? (mainRef.safety_referral === 'Yes')       : false,
        referralMentions:   matchingReferrals.length,
        safetyReferralCount: safetyRefs.length,

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

        // PSUSAs
        psusas:      matchingPsusas,
        totalPsusas: matchingPsusas.length,

        // DHPCs
        dhpcs:   matchingDhpcs,
        hasDhpc: matchingDhpcs.length > 0,

        // Médicaments EMA
        totalEUProducts: emaProducts.length,
        products: emaProducts,

        // Meta
        searchUrl: `https://www.ema.europa.eu/en/search?search_api_fulltext=${encodeURIComponent(substance)}`,
        cacheAge:  Math.round((now - _cache.ts) / 1000 / 60),
        psusaCount: _cache.psusas.length // pour diagnostiquer si le cache PSUSA est chargé
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

// ─── Télécharger le JSON PSUSA (essaie plusieurs URLs) ────────────────────────
async function fetchPsusaJson() {
  for (const url of EMA_PSUSA_URLS) {
    try {
      const data = await fetchJson(url, 25000);
      const arr = extractArray(data);
      if (arr.length > 0) {
        console.log(`PSUSA loaded from: ${url} (${arr.length} items)`);
        return data;
      }
    } catch(e) {
      console.warn(`PSUSA fetch failed for ${url}: ${e.message}`);
    }
  }
  console.warn('PSUSA: all URLs failed, returning empty');
  return { data: [] };
}

// ─── Extrait un tableau depuis une réponse JSON EMA ───────────────────────────
function extractArray(jsonData) {
  if (!jsonData) return [];
  if (Array.isArray(jsonData)) return jsonData;
  if (jsonData.data && Array.isArray(jsonData.data)) return jsonData.data;
  // Chercher récursivement le premier tableau de taille raisonnable
  for (const val of Object.values(jsonData)) {
    if (Array.isArray(val) && val.length > 0) return val;
  }
  return [];
}

// ─── Télécharge et parse un fichier JSON via HTTPS ────────────────────────────
function fetchJson(url, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PharmaScout/2.0)',
        'Accept':     'application/json, */*'
      }
    }, (res) => {
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
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
  });
}
