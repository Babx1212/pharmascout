const https = require('https');

function fetchRaw(urlStr, opts) {
  opts = opts || {};
  return new Promise(function(resolve, reject) {
    var u;
    try { u = new URL(urlStr); } catch(e) { return reject(e); }
    var req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: opts.method || 'GET',
      headers: Object.assign({ 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' }, opts.headers || {})
    }, function(res) {
      var c = [];
      res.on('data', function(x) { c.push(x); });
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
  var debug = {};

  // Test swissmedic EN authorized products search page
  try {
    var r = await fetchRaw(
      'https://www.swissmedic.ch/swissmedic/en/home/humanarzneimittel/authorisations/authorised-human-medicinal-products/search.html?query=' + encodeURIComponent(substance),
      { timeout: 7000 }
    );
    var rows = (r.body.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []).slice(0, 5);
    debug.swissSearch = {
      status: r.status,
      bodyLen: r.body.length,
      body200: r.body.substring(0, 200),
      rowCount: (r.body.match(/<tr/gi) || []).length,
      first3Rows: rows.map(function(row) { return row.replace(/<[^>]+>/g, '').trim().substring(0,100); })
    };
  } catch(e) { debug.swissSearchErr = e.message; }

  // Test PV page EN
  try {
    var r2 = await fetchRaw(
      'https://www.swissmedic.ch/swissmedic/en/home/humanarzneimittel/market-surveillance/pharmacovigilance/pharmakovigilanz-publikationen.html',
      { timeout: 5000 }
    );
    debug.pvEN = { status: r2.status, hasSubst: r2.body.toLowerCase().indexOf(substance.toLowerCase()) !== -1, body100: r2.body.substring(0, 100) };
  } catch(e) { debug.pvENErr = e.message; }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ substance, debug })
  };
};