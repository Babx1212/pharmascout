const https = require('https');

function fetchRaw(urlStr, options) {
  options = options || {};
  return new Promise(function(resolve, reject) {
    var u;
    try { u = new URL(urlStr); } catch(e) { return reject(e); }
    var reqOpts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8'
      }, options.headers || {})
    };
    var req = https.request(reqOpts, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.setTimeout(options.timeout || 10000, function() { req.destroy(); reject(new Error('timeout')); });
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

  // 1. Try swissmedicinfo.ch autocomplete API (POST JSON)
  try {
    var body = JSON.stringify({ lang: 'FR', term: substance });
    var autoRes = await fetchRaw('https://www.swissmedicinfo.ch/Default.aspx/GetAutoComplete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://www.swissmedicinfo.ch/',
        'Origin': 'https://www.swissmedicinfo.ch',
        'Accept-Language': 'fr-FR,fr;q=0.9'
      },
      body: body,
      timeout: 8000
    });
    if (autoRes.statusCode === 200) {
      var parsed = JSON.parse(autoRes.body);
      var items = Array.isArray(parsed.d) ? parsed.d : [];
      if (items.length > 0) {
        result.totalCHProducts = items.length;
        result.aipsCount = items.length;
        result.products = items.slice(0, 30).map(function(name) {
          return { name: name.trim(), holder: '—' };
        });
      }
    }
  } catch(e) {
    console.error('swissmedicinfo autocomplete error:', e.message);
  }

  // 2. Fallback: scrape Swissmedic EN authorized products search
  if (result.totalCHProducts === 0) {
    try {
      var swRes = await fetchRaw(
        'https://www.swissmedic.ch/swissmedic/en/home/humanarzneimittel/authorisations/authorised-human-medicinal-products/search.html?query=' + encodeURIComponent(substance),
        { timeout: 8000 }
      );
      if (swRes.statusCode === 200) {
        var html = swRes.body;
        // Extract product names from table rows: look for <td> content in result tables
        var rows = html.match(/<tr[^>]*>[sS]*?</tr>/gi) || [];
        var prods = [];
        rows.forEach(function(row) {
          var cells = row.match(/<td[^>]*>([sS]*?)</td>/gi) || [];
          if (cells.length >= 2) {
            var name = cells[0].replace(/<[^>]+>/g,'').trim();
            var holder = cells[1].replace(/<[^>]+>/g,'').trim();
            if (name && name.length > 1 && !/^\d+$/.test(name)) {
              prods.push({ name: name, holder: holder || '—' });
            }
          }
        });
        if (prods.length > 0) {
          result.products = prods.slice(0, 30);
          result.totalCHProducts = prods.length;
          result.aipsCount = prods.length;
        } else {
          // Try simple count from text
          var countM = html.match(/(\d+)\s+result/i);
          if (countM) {
            result.totalCHProducts = parseInt(countM[1]);
          }
        }
      }
    } catch(e) {
      console.error('Swissmedic search error:', e.message);
    }
  }

  // 3. PV alert via Swissmedic pharmacovigilance publications page
  try {
    var pvRes = await fetchRaw(
      'https://www.swissmedic.ch/swissmedic/fr/home/humanarzneimittel/market-surveillance/pharmacovigilance/pharmakovigilanz-publikationen.html',
      { timeout: 8000 }
    );
    if (pvRes.statusCode === 200) {
      var pvHtml = pvRes.body;
      var substLow = substance.toLowerCase();
      if (pvHtml.toLowerCase().indexOf(substLow) !== -1) {
        result.pvAlert = true;
        var idx2 = pvHtml.toLowerCase().indexOf(substLow);
        var before = pvHtml.substring(Math.max(0, idx2 - 500), idx2);
        var titleM = before.match(/<(?:h[1-6]|strong)[^>]*>([^<]{5,100})<\/(?:h[1-6]|strong)>/i);
        result.pvDetails = titleM ? titleM[1].trim() : 'Signal pharmacovigilance pour ' + substance;
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