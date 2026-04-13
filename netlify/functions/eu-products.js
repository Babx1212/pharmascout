'use strict';
const zlib = require('zlib');
const https = require('https');
const http = require('http');
const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

// France BDPM cache
var _frRows = null, _frTs = 0;
const FR_TTL = 6 * 3600 * 1000;
const FR_URL = 'https://base-donnees-publique.medicaments.gouv.fr/index.php/download/file/CIS_bdpm.txt';

// helpers
function fetchTextNode(url, timeoutMs) {
  return new Promise(function(resolve, reject) {
    var done = false;
    var lib = url.startsWith('https') ? https : http;
    var req = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 PharmaScout/1.0' } }, function(res) {
      if (res.statusCode === 301 || res.statusCode === 302) {
        if (!done) { done = true; fetchTextNode(res.headers.location, timeoutMs).then(resolve).catch(reject); }
        return;
      }
      if (res.statusCode !== 200) {
        if (!done) { done = true; reject(new Error('HTTP ' + res.statusCode)); }
        return;
      }
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        if (!done) { done = true; resolve(Buffer.concat(chunks).toString('latin1')); }
      });
      res.on('error', function(e) { if (!done) { done = true; reject(e); } });
    });
    req.on('error', function(e) { if (!done) { done = true; reject(e); } });
    req.setTimeout(timeoutMs || 20000, function() {
      req.destroy();
      if (!done) { done = true; reject(new Error('timeout')); }
    });
  });
}

// UTF-8 fetch for JSON/XML APIs (Belgium SAM, Spain CIMA)
function fetchApiText(url, timeoutMs) {
  return new Promise(function(resolve, reject) {
    var done = false;
    var lib = url.startsWith('https') ? https : http;
    var opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 PharmaScout/1.0',
        'Accept': 'application/json, application/xml, text/xml, */*'
      }
    };
    var req = lib.get(url, opts, function(res) {
      if (res.statusCode === 301 || res.statusCode === 302) {
        if (!done) { done = true; fetchApiText(res.headers.location, timeoutMs).then(resolve).catch(reject); }
        return;
      }
      if (res.statusCode !== 200) {
        if (!done) { done = true; reject(new Error('HTTP ' + res.statusCode + ' ' + url)); }
        return;
      }
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); }
      });
      res.on('error', function(e) { if (!done) { done = true; reject(e); } });
    });
    req.on('error', function(e) { if (!done) { done = true; reject(e); } });
    req.setTimeout(timeoutMs || 15000, function() {
      req.destroy();
      if (!done) { done = true; reject(new Error('timeout')); }
    });
  });
}

// buildTerms: covers DE/FR/ES/PT INN variants
function buildTerms(s) {
  var t = [s];
  if (s.endsWith('ide') && s.length > 6) {
    t.push(s.slice(0, -1));
    t.push(s.slice(0, -1) + 'a');
  }
  if (s.endsWith('ole') && s.length > 5) t.push(s.slice(0, -1));
  if (s.endsWith('ine') && s.length > 5) t.push(s.slice(0, -1) + 'a');
  if (!s.endsWith('a') && !s.endsWith('e') && !s.endsWith('l') && s.length > 5) t.push(s + 'a');
  return t.filter(function(v, i, a) { return a.indexOf(v) === i; });
}

function matchesTerms(name, terms) {
  var n = name.toLowerCase();
  for (var i = 0; i < terms.length; i++) {
    if (n.indexOf(terms[i].toLowerCase()) !== -1) return true;
  }
  return false;
}

function holderFromName(name) {
  var m = name.match(/\b([A-Z][A-Z\s\-]{2,}(?:PHARMA|LABS?|MED|GENERICS?|TEVA|MYLAN|SANDOZ|RATIOPHARM|EG|BIOGARAN|ARROW)?)\b/i);
  return m ? m[1].trim() : '';
}

function ptDCI(terms) {
  var cand = terms.find(function(t) { return t.endsWith('a'); });
  if (!cand) cand = terms[0] + 'a';
  return cand.charAt(0).toUpperCase() + cand.slice(1);
}

// country fetchers

async function fetchFrance(substance, terms) {
  var frDebug = {};
  var now = Date.now();
  if (!_frRows || now - _frTs > FR_TTL) {
    var txt = await fetchTextNode(FR_URL, 25000);
    _frRows = txt.split(/\r?\n/);
    _frTs = now;
    frDebug.rowsFetched = _frRows.length;
    if (_frRows.length > 1) frDebug.sampleCols = _frRows[1].split('\t').slice(0, 9);
  } else {
    frDebug.rowsCached = _frRows.length;
    if (_frRows.length > 1) frDebug.sampleCols = _frRows[1].split('\t').slice(0, 9);
  }

  var products = [];
  for (var i = 0; i < _frRows.length; i++) {
    var line = _frRows[i].trim();
    if (!line) continue;
    var cols = line.split('\t');
    if (cols.length < 8) continue;
    if (cols[4] !== 'Autorisation active') continue;
    if (cols[6].indexOf('Commercialis') !== 0) continue;
    var name = cols[1] || '';
    if (!matchesTerms(name, terms)) continue;
    products.push({ name: name, holder: holderFromName(name), status: 'Autoris\u00e9' });
    if (products.length >= 50) break;
  }
  frDebug.found = products.length;
  return { products: products, debug: frDebug };
}

async function fetchSpain(substance, terms) {
  var spanishTerm = terms.find(function(t) { return t.endsWith('a'); }) || (substance + 'a');
  var url = 'https://cima.aemps.es/cima/rest/medicamentos?nombre=' +
    encodeURIComponent(spanishTerm) + '&pagina=1&tamanioPagina=100';
  var txt = await fetchApiText(url, 15000);
  var data = JSON.parse(txt);
  var items = data.resultados || [];
  var products = [];
  for (var i = 0; i < items.length; i++) {
    var m = items[i];
    if (!m.comerc) continue;
    var name = m.nombre || '';
    if (!matchesTerms(name, terms)) continue;
    products.push({ name: name, holder: m.labtitular || '', status: 'Autoris\u00e9' });
    if (products.length >= 50) break;
  }
  return products;
}

// Belgium: SAM v2 REST API (no ZIP streaming needed - direct JSON/XML query)
async function fetchBelgium(substance, terms) {
  var beDebug = {};
  try {
    // SAM v2 REST API - officialName does substring search
    // Try base substance first, then the 'a'-suffix variant
    var queries = [substance];
    var aVar = terms.find(function(t) { return t !== substance && t.endsWith('a'); });
    if (aVar) queries.push(aVar);

    var products = [];
    var fetchErrors = [];

    for (var qi = 0; qi < queries.length && products.length === 0; qi++) {
      var url = 'https://www.vas.ehealth.fgov.be/websamcivics/samcivics/rest/samv2/amp' +
        '?officialName=' + encodeURIComponent(queries[qi]) +
        '&language=fr&status=AUTHORIZED&pageSize=100';
      beDebug['url' + qi] = url;

      var txt;
      try {
        txt = await fetchApiText(url, 15000);
      } catch(fe) {
        fetchErrors.push(queries[qi] + ':' + fe.message);
        continue;
      }
      beDebug['len' + qi] = txt.length;
      // Always capture preview for debugging
      beDebug['preview' + qi] = txt.substring(0, 600);

      // Try JSON
      var jsonOk = false;
      try {
        var data = JSON.parse(txt);
        var items = Array.isArray(data) ? data :
          (data.ampElements || data.result || data.results || data.items || data.content || []);
        if (typeof items === 'object' && !Array.isArray(items)) {
          items = Object.values(items);
        }
        beDebug['jsonKeys' + qi] = Array.isArray(data) ? 'array:' + data.length :
          Object.keys(data).join(',');
        jsonOk = true;
        for (var i = 0; i < (items || []).length; i++) {
          var item = items[i];
          var name = item.officialName || item.OfficialName || item.name || item.naam || item.nom || '';
          if (!name || !matchesTerms(name, terms)) continue;
          var holder = '';
          if (item.company) holder = item.company.name || item.company.naam || item.company.nom || '';
          if (!holder && item.mah) holder = item.mah;
          if (!holder && item.holder) holder = item.holder;
          products.push({ name: name, holder: holder, status: 'Autoris\u00e9' });
          if (products.length >= 50) break;
        }
      } catch(jsonErr) {
        beDebug['jsonErr' + qi] = jsonErr.message;
      }

      // Try XML if JSON failed or found nothing
      if (!jsonOk || products.length === 0) {
        var xmlNames = txt.match(/<OfficialName[^>]*>([^<]+)<\/OfficialName>/gi) || [];
        beDebug['xmlNames' + qi] = xmlNames.length;
        for (var j = 0; j < xmlNames.length; j++) {
          var nm = xmlNames[j].replace(/<[^>]+>/g, '').trim();
          if (!nm || !matchesTerms(nm, terms)) continue;
          products.push({ name: nm, holder: '', status: 'Autoris\u00e9' });
          if (products.length >= 50) break;
        }
      }
    }

    if (fetchErrors.length) beDebug.fetchErrors = fetchErrors.join('; ');
    beDebug.found = products.length;
    return { products: products, debug: beDebug };
  } catch(e) {
    beDebug.error = e.message;
    return { products: [], debug: beDebug };
  }
}

async function fetchPortugal(substance, terms) {
  var dci = ptDCI(terms);
  var b64 = Buffer.from(dci).toString('base64');
  var url = 'http://app10.infarmed.pt/genericos/genericos_II/lista_genericos.php' +
    '?tabela=dispt&fonte=dci&escolha_dci=' + encodeURIComponent(b64);
  var txt = await fetchTextNode(url, 15000);
  var products = [];
  var rows = txt.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  for (var i = 0; i < rows.length; i++) {
    var cells = rows[i].match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
    if (cells.length < 3) continue;
    function stripTags(s) { return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim(); }
    var name = stripTags(cells[0]);
    var holder = stripTags(cells[2]);
    if (!name || !matchesTerms(name, terms)) continue;
    products.push({ name: name, holder: holder, status: 'Autoris\u00e9' });
    if (products.length >= 50) break;
  }
  return products;
}

// main handler
exports.handler = async function(event) {
  var substance = ((event.queryStringParameters || {}).substance || '').toLowerCase().trim();
  if (!substance) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'substance required' }) };
  }

  var terms = buildTerms(substance);

  var fetchers = [
    { code: 'FR', name: 'France',   fn: function() { return fetchFrance(substance, terms); } },
    { code: 'ES', name: 'Espagne',  fn: function() { return fetchSpain(substance, terms); } },
    { code: 'BE', name: 'Belgique', fn: function() { return fetchBelgium(substance, terms); } },
    { code: 'PT', name: 'Portugal', fn: function() { return fetchPortugal(substance, terms); } }
  ];

  var settled = await Promise.allSettled(fetchers.map(function(f) { return f.fn(); }));

  var countries = fetchers.map(function(f, i) {
    var r = settled[i];
    var val = r.status === 'fulfilled' ? r.value : null;
    var products = Array.isArray(val) ? val : (val && val.products ? val.products : []);
    var debug = (val && val.debug) ? val.debug : undefined;
    var error = r.status === 'rejected' ? r.reason.message : null;
    return { code: f.code, name: f.name, total: products.length, products: products, error: error, debug: debug };
  });

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({ substance: substance, terms: terms, countries: countries })
  };
};
