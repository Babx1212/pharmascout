/**
 * PharmaScout - Netlify Function : EMA Proxy (v5)
 * Uses official EMA JSON data files (updated 2x/day):
 *  - Referrals JSON : all PRAC referrals
 *  - DHPCs JSON     : direct healthcare professional communications
 *  - EPAR JSON      : all centrally authorised medicines
 */

const https = require('https');

const EMA_REFERRALS_URL = 'https://www.ema.europa.eu/en/documents/report/referrals-output-json-report_en.json';
const EMA_DHPC_URL      = 'https://www.ema.europa.eu/en/documents/report/dhpc-output-json-report_en.json';
const EMA_EPAR_URL      = 'https://www.ema.europa.eu/en/documents/report/medicines-output-epar-report_en.json';

// Module-level cache (warm Lambda instance)
const CACHE_TTL = 30 * 60 * 1000; // 30 min
var _cache = { referrals: null, dhpcs: null, epar: null, ts: 0 };

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=600'
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: HEADERS, body: '' };
  }

  var substance = ((event.queryStringParameters || {}).substance || '').trim().toLowerCase();
  if (!substance) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'substance parameter required' }) };
  }

  // Fetch / reuse cached EMA data
  var now = Date.now();
  if (!_cache.referrals || (now - _cache.ts) > CACHE_TTL) {
    var results = await Promise.all([
      fetchJson(EMA_REFERRALS_URL, 25000).catch(function() { return []; }),
      fetchJson(EMA_DHPC_URL, 25000).catch(function() { return []; }),
      fetchJson(EMA_EPAR_URL, 30000).catch(function() { return []; })
    ]);
    _cache.referrals = normalizeArray(results[0]);
    _cache.dhpcs     = normalizeArray(results[1]);
    _cache.epar      = normalizeArray(results[2]);
    _cache.ts        = now;
  }

  function matchesSubstance(text, subst) {
    if (!text) return false;
    var tl = String(text).toLowerCase();
    return tl.indexOf(subst) !== -1 || (subst.length >= 6 && tl.indexOf(subst.slice(0, 6)) !== -1);
  }

  function substanceInRecord(r, subst) {
    var fields = [
      r.ActiveSubstance, r['Active substance'], r.active_substance,
      r.INN, r.MedicinalProductName, r.Substance, r.substance
    ];
    return fields.some(function(f) { return matchesSubstance(f, subst); });
  }

  // Referrals / PRAC matching
  var matchingReferrals = (_cache.referrals || []).filter(function(r) {
    return substanceInRecord(r, substance);
  });

  var pracActive = matchingReferrals.some(function(r) {
    var st = (r.ProcedureStatus || r.Status || r.status || '').toLowerCase();
    return st === 'ongoing' || st === 'open';
  });
  var mainRef = matchingReferrals.find(function(r) {
    var st = (r.ProcedureStatus || r.Status || r.status || '').toLowerCase();
    return st === 'ongoing' || st === 'open';
  }) || matchingReferrals[0];
  var safetyRefs = matchingReferrals.filter(function(r) {
    var reason = (r.ProcedureType || r.Reason || r.type || '').toLowerCase();
    return reason.indexOf('safety') !== -1 || reason.indexOf('benefit') !== -1 || reason.indexOf('risk') !== -1;
  });

  // DHPC matching
  var matchingDhpcs = (_cache.dhpcs || []).filter(function(r) {
    return substanceInRecord(r, substance);
  });

  // EPAR product matching
  var matchingEpar = (_cache.epar || []).filter(function(r) {
    return substanceInRecord(r, substance);
  });
  var totalEUProducts = matchingEpar.length;
  var products = matchingEpar.slice(0, 30).map(function(r) {
    return {
      name:   r.MedicinalProductName || r['Medicinal product'] || r.name || '—',
      holder: r.MarketingAuthorisationHolder || r['Marketing authorisation holder'] || r.mah || '—',
      status: r.AuthorisationStatus || r['Authorisation status'] || '—'
    };
  });

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      substance: substance,
      totalEUProducts: totalEUProducts,
      products: products,
      pracActive: pracActive,
      pracDetails: mainRef ? (mainRef.ReferralTitle || mainRef.Title || mainRef.title || mainRef.ProcedureTitle || '') : null,
      isSafetyReferral: safetyRefs.length > 0,
      allReferrals: matchingReferrals.slice(0, 10).map(function(r) {
        return {
          title:  r.ReferralTitle || r.Title || r.title || '',
          status: r.ProcedureStatus || r.Status || r.status || '',
          type:   r.ProcedureType  || r.Type  || r.type  || '',
          url:    r.URL || r.url || ''
        };
      }),
      hasDhpc: matchingDhpcs.length > 0,
      dhpcDetails: matchingDhpcs[0] ? (matchingDhpcs[0].Title || matchingDhpcs[0].title || '') : null,
      searchUrl: 'https://www.ema.europa.eu/en/medicines/field_ema_web_categories%253Aname_field/Human/ema_group_types/ema_medicine/search?search_api_fulltext=' + encodeURIComponent(substance)
    })
  };
};

function normalizeArray(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  if (data && typeof data === 'object') {
    var keys = Object.keys(data);
    for (var i = 0; i < keys.length; i++) {
      if (Array.isArray(data[keys[i]])) return data[keys[i]];
    }
  }
  return [];
}

function fetchJson(url, timeoutMs) {
  timeoutMs = timeoutMs || 20000;
  return new Promise(function(resolve, reject) {
    var u;
    try { u = new URL(url); } catch(e) { return reject(e); }
    var chunks = [];
    var req = https.request({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PharmaScout/1.0)',
        'Accept':     'application/json, */*'
      }
    }, function(res) {
      if (res.statusCode === 301 || res.statusCode === 302) {
        var loc = res.headers && res.headers.location;
        if (loc) return resolve(fetchJson(loc, timeoutMs));
      }
      res.on('data', function(chunk) { chunks.push(chunk); });
      res.on('end', function() {
        try {
          var body = Buffer.concat(chunks).toString('utf8');
          resolve(JSON.parse(body));
        } catch(e) {
          reject(new Error('JSON parse error: ' + e.message));
        }
      });
    });
    req.setTimeout(timeoutMs, function() { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}