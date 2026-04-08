const https = require('https');

// Correct current Swissmedic URLs (verified 2025)
const PV_URL = 'https://www.swissmedic.ch/swissmedic/en/home/humanarzneimittel/market-surveillance/pharmacovigilance/vigilance-news.html';

function fetchRaw(urlStr, opts) {
  opts = opts || {};
  return new Promise(function(resolve, reject) {
    var u; try { u = new URL(urlStr); } catch(e) { return reject(e); }
    var req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: opts.method || 'GET',
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,*/*', 'Accept-Language': 'en-GB,en;q=0.9'
      }, opts.headers || {})
    }, function(res) {
      var c = []; res.on('data', function(x) { c.push(x); });
      res.on('end', function() { resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8') }); });
    });
    req.setTimeout(opts.timeout || 8000, function() { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

exports.handler = async function(event) {
  var substance = ((event.queryStringParameters || {}).substance || '').trim();
  if (!substance) return { statusCode: 400, body: JSON.stringify({ error: 'substance required' }) };

  var result = {
    substance: substance, totalCHProducts: 0, products: [],
    pvAlert: false, pvDetails: null, aipsCount: 0,
    searchUrl: 'https://www.swissmedic.ch/swissmedic/en/home/services/medicinal-product-information.html'
  };

  // 1. Swissmedic authorized products search
  try {
    var searchUrl = 'https://www.swissmedic.ch/swissmedic/en/home/humanarzneimittel/authorisations/authorised-human-medicinal-products.html?query=' + encodeURIComponent(substance);
    var res = await fetchRaw(searchUrl, { timeout: 7000 });
    if (res.status === 200 && res.body.length > 500) {
      // Try to extract product names from table cells
      var allTds = res.body.match(/<td[^>]*>((?:[^<]|<(?!\/td))*)<\/td>/gi) || [];
      var prods = [];
      for (var i = 0; i < allTds.length - 1; i += 2) {
        var name = allTds[i].replace(/<[^>]+>/g, '').trim();
        var holder = allTds[i+1] ? allTds[i+1].replace(/<[^>]+>/g, '').trim() : '—';
        if (name && name.length > 2 && name.length < 100 && !/^(Name|Titulaire|Holder|Zulassung|Status)$/i.test(name)) {
          prods.push({ name: name, holder: holder });
        }
      }
      if (prods.length > 0) {
        result.products = prods.slice(0, 30);
        result.totalCHProducts = prods.length;
        result.aipsCount = prods.length;
      }
    }
  } catch(e) { /* silent */ }

  // 2. Swissmedic Vigilance News - PV alert check (correct URL)
  try {
    var pvRes = await fetchRaw(PV_URL, { timeout: 7000 });
    if (pvRes.status === 200) {
      var pvHtml = pvRes.body;
      var substLow = substance.toLowerCase();
      if (pvHtml.toLowerCase().indexOf(substLow) !== -1) {
        result.pvAlert = true;
        // Try to find the relevant article title
        var idx = pvHtml.toLowerCase().indexOf(substLow);
        var before = pvHtml.substring(Math.max(0, idx - 600), idx);
        var titleM = before.match(/<(?:h[1-6]|strong|b)[^>]*>([^<]{5,120})<\/(?:h[1-6]|strong|b)>/i);
        result.pvDetails = titleM ? titleM[1].replace(/&amp;/g,'&').trim() : 'Vigilance News: signal détecté pour ' + substance;
      }
    }
  } catch(e) { /* silent */ }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600' },
    body: JSON.stringify(result)
  };
};