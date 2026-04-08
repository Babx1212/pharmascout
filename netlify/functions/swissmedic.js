const https = require('https');

function fetchRaw(urlStr, opts) {
  opts = opts || {};
  return new Promise(function(resolve, reject) {
    var u;
    try { u = new URL(urlStr); } catch(e) { return reject(e); }
    var reqOpts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: Object.assign({ 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' }, opts.headers || {})
    };
    var req = https.request(reqOpts, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() { resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }); });
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

  // Test 1: swissmedicinfo autocomplete
  try {
    var body = JSON.stringify({ lang: 'FR', term: substance });
    var r1 = await fetchRaw('https://www.swissmedicinfo.ch/Default.aspx/GetAutoComplete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://www.swissmedicinfo.ch/',
        'Origin': 'https://www.swissmedicinfo.ch'
      },
      body: body,
      timeout: 6000
    });
    debug.aips = { status: r1.status, body200: r1.body.substring(0, 200) };
    if (r1.status === 200) {
      try { debug.aipsParsed = JSON.parse(r1.body); } catch(e) { debug.aipsParseErr = e.message; }
    }
  } catch(e) { debug.aipsErr = e.message; }

  // Test 2: Swissmedic PV page (just status)
  try {
    var r2 = await fetchRaw('https://www.swissmedic.ch/swissmedic/fr/home/humanarzneimittel/market-surveillance/pharmacovigilance/pharmakovigilanz-publikationen.html', { timeout: 5000 });
    debug.pvPage = { status: r2.status, has_substance: r2.body.toLowerCase().indexOf(substance.toLowerCase()) !== -1, body50: r2.body.substring(0, 50) };
  } catch(e) { debug.pvErr = e.message; }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ substance, debug })
  };
};