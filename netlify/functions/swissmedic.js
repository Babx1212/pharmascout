const https = require('https');

function fetchUrl(urlStr, options) {
  options = options || {};
  return new Promise(function(resolve, reject) {
    var u;
    try { u = new URL(urlStr); } catch(e) { return reject(e); }
    var reqOpts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (compatible; PharmaScout/1.0)',
        'Accept': 'text/html,application/json,*/*'
      }, options.headers || {})
    };
    var req = https.request(reqOpts, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.setTimeout(15000, function() { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

exports.handler = async function(event) {
  var substance = ((event.queryStringParameters || {}).substance || '').trim();
  if (!substance) {
    return { statusCode: 400, body: JSON.stringify({ error: 'substance required' }) };
  }

  var result = {
    substance: substance,
    totalCHProducts: 0,
    products: [],
    pvAlert: false,
    pvDetails: null,
    aipsCount: 0,
    searchUrl: 'https://www.swissmedic.ch/swissmedic/fr/home/services-et-laboratoires/archive_catalogue-suisse-des-medicaments/abfrage.html?query=' + encodeURIComponent(substance)
  };

  // 1. Swiss product list via swissmedicinfo.ch autocomplete (POST JSON)
  try {
    var body = JSON.stringify({ lang: 'FR', term: substance });
    var autoRes = await fetchUrl('https://www.swissmedicinfo.ch/Default.aspx/GetAutoComplete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Length': Buffer.byteLength(body)
      },
      body: body
    });
    if (autoRes.statusCode === 200) {
      var parsed = JSON.parse(autoRes.body);
      var items = Array.isArray(parsed.d) ? parsed.d : [];
      result.totalCHProducts = items.length;
      result.aipsCount = items.length;
      result.products = items.slice(0, 30).map(function(name) {
        return { name: name.trim(), holder: '—' };
      });
    }
  } catch(e) {
    console.error('swissmedicinfo autocomplete error:', e.message);
  }

  // 2. Fallback: Swissmedic EN search page if autocomplete returned nothing
  if (result.totalCHProducts === 0) {
    try {
      var swRes = await fetchUrl(
        'https://www.swissmedic.ch/swissmedic/en/home/humanarzneimittel/authorisations/authorised-human-medicinal-products/search.html?query=' + encodeURIComponent(substance)
      );
      if (swRes.statusCode === 200) {
        var html = swRes.body;
        var countMatch = html.match(/(\d+)\s+result/i) || html.match(/(\d+)\s+r\u00e9sultat/i);
        if (countMatch) {
          result.totalCHProducts = parseInt(countMatch[1]);
          result.products = [{ name: countMatch[1] + ' produit(s) trouv\u00e9(s)', holder: 'Catalogue Swissmedic' }];
        }
      }
    } catch(e) {
      console.error('Swissmedic search fallback error:', e.message);
    }
  }

  // 3. PV alerts via Swissmedic pharmacovigilance page
  try {
    var pvRes = await fetchUrl(
      'https://www.swissmedic.ch/swissmedic/fr/home/humanarzneimittel/market-surveillance/pharmacovigilance/pharmakovigilanz-publikationen.html'
    );
    if (pvRes.statusCode === 200) {
      var pvHtml = pvRes.body;
      var substLow = substance.toLowerCase();
      if (pvHtml.toLowerCase().indexOf(substLow) !== -1) {
        result.pvAlert = true;
        var idx = pvHtml.toLowerCase().indexOf(substLow);
        var before = pvHtml.substring(Math.max(0, idx - 400), idx);
        var titleMatch = before.match(/<(?:h[1-6]|strong)[^>]*>([^<]{5,80})<\/(?:h[1-6]|strong)>/i);
        result.pvDetails = titleMatch
          ? titleMatch[1].trim()
          : 'Signal pharmacovigilance d\u00e9tect\u00e9 pour ' + substance;
      }
    }
  } catch(e) {
    console.error('PV check error:', e.message);
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600'
    },
    body: JSON.stringify(result)
  };
};