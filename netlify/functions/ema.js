/**
 * PharmaScout â Netlify Function : EMA Proxy (v4)
 * Utilise les JSON data files officiels de l'EMA (mis Ã  jour 2x/jour).
 * - Referrals JSON : 709 KB, contient tous les referrals PRAC
 * - DHPCs JSON    : communications directes professionnels de santÃ©
 * Cache module-level (persist entre invocations warm Lambda).
 */

const https = require('https');

const EMA_REFERRALS_URL = 'https://www.ema.europa.eu/en/documents/report/referrals-output-json-report_en.json';
const EMA_DHPC_URL      = 'https://www.ema.europa.eu/en/documents/report/dhpc-output-json-report_en.json';

// Cache module-level (warm Lambda instances)
let _cache = { referrals: null, dhpcs: null, ts: 0 };
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6h

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
    // --- 1. Charger / rafraÃ®chir le cache EMA ---
    const now = Date.now();
    if (!_cache.referrals || (now - _cache.ts) > CACHE_TTL) {
      const [refData, dhpcData] = await Promise.all([
        fetchJson(EMA_REFERRALS_URL, 25000),
        fetchJson(EMA_DHPC_URL, 25000).catch(() => ({ data: [] }))
      ]);
      _cache.referrals = (refData && refData.data) ? refData.data : [];
      _cache.dhpcs     = (dhpcData && dhpcData.data) ? dhpcData.data : [];
      _cache.ts = now;
    }

    // --- 2. Construire les mots-clÃ©s de recherche ---
    // DÃ©compose la substance en mots (ex: "finasteride" â ["finasteride"])
    // TolÃ¨re les substances composÃ©es (ex: "finasteride dutasteride")
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

    // Trier : safety referrals en premier, puis par date de dÃ©cision (plus rÃ©cent)
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

    // --- 5. Construire la rÃ©ponse ---
    
    // --- Produits EMA via EPAR JSON officiel (best-effort, 5s timeout) ---
    var emaProducts = [];
    try {
      var eparResult = await Promise.race([
        fetchJson('https://www.ema.europa.eu/en/documents/report/medicines-output-epar-report_en.json', 20000),
        new Promise(function(res) { setTimeout(function() { res(null); }, 5000); })
      ]);
      if (eparResult) {
        var eparArr = Array.isArray(eparResult) ? eparResult :
          Array.isArray(eparResult.data) ? eparResult.data :
          (function() { var k = Object.keys(eparResult||{}); for(var i=0;i<k.length;i++) { if(Array.isArray(eparResult[k[i]])) return eparResult[k[i]]; } return []; })();
        emaProducts = eparArr.filter(function(r) {
          var fields = [r.ActiveSubstance, r['Active substance'], r.active_substance, r.INN];
          return fields.some(function(f) { return f && String(f).toLowerCase().indexOf(substance) !== -1; });
        }).slice(0, 30).map(function(r) {
          return {
            name:   r.MedicinalProductName   || r['Medicinal product'] || r.name || '—',
            holder: r.MarketingAuthorisationHolder || r['Marketing authorisation holder'] || r.mah || '—',
            status: r.AuthorisationStatus    || r['Authorisation status'] || '—'
          };
        });
      }
    } catch(eparErr) { /* EPAR timeout or error - keep empty, PRAC still works */ }

return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        substance,

        // Produits centralement autorisÃ©s par l'EMA (molÃ©cules nationales = 0, c'est correct)
        totalEUProducts: emaProducts.length,
        products: emaProducts,

        // Signal de sÃ©curitÃ© PRAC
        pracActive,
        pracDetails:        mainRef ? mainRef.referral_name                        : null,
        pracUrl:            mainRef ? mainRef.referral_url                         : null,
        pracStatus:         mainRef ? mainRef.current_status                       : null,
        pracRecommendation: mainRef ? mainRef.prac_recommendation                  : null,
        pracDecisionDate:   mainRef ? mainRef.european_commission_decision_date    : null,
        pracType:           mainRef ? mainRef.referral_type                        : null,
        isSafetyReferral:   mainRef ? (mainRef.safety_referral === 'Yes')          : false,

        // Tous les referrals correspondants
        allReferrals: matchingReferrals.map(r => ({
          name:            r.referral_name,
          url:             r.referral_url,
          inn:             r.international_non_proprietary_name_inn_common_name,
          status:          r.current_status,
          type:            r.referral_type,
          isSafety:        r.safety_referral === 'Yes',
          recommendation:  r.prac_recommendation,
          startDate:       r.procedure_start_date,
          decisionDate:    r.european_commission_decision_date
        })),

        // DHPCs (communications sÃ©curitÃ©)
        dhpcs: matchingDhpcs,
        hasDhpc: matchingDhpcs.length > 0,

        referralMentions: matchingReferrals.length,
        safetyReferralCount: safetyRefs.length,

        // Lien de recherche EMA
        searchUrl: `https://www.ema.europa.eu/en/search?search_api_fulltext=${encodeURIComponent(substance)}`,
        cacheAge: Math.round((now - _cache.ts) / 1000 / 60) // minutes
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
 * TÃ©lÃ©charge et parse un fichier JSON depuis une URL HTTPS.
 * Suit les redirections HTTP 3xx.
 */
function fetchJson(url, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PharmaScout/1.0)',
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
