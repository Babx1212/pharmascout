'use strict';
const https = require('https');
const http = require('http');
const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

// UTF-8 fetch for all JSON APIs
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
    req.setTimeout(timeoutMs || 10000, function() {
      req.destroy();
      if (!done) { done = true; reject(new Error('timeout')); }
    });
  });
}

// PT: latin1 for INFARMED HTML
function fetchLatin1(url, timeoutMs) {
  return new Promise(function(resolve, reject) {
    var done = false;
    var lib = url.startsWith('https') ? https : http;
    var req = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 PharmaScout/1.0' } }, function(res) {
      if (res.statusCode === 301 || res.statusCode === 302) {
        if (!done) { done = true; fetchLatin1(res.headers.location, timeoutMs).then(resolve).catch(reject); }
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
    req.setTimeout(timeoutMs || 10000, function() {
      req.destroy();
      if (!done) { done = true; reject(new Error('timeout')); }
    });
  });
}

// buildTerms: covers FR/ES/PT INN variants
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
  var parts = name.split(/\s+/);
  // Holder is typically the word(s) after the INN in the product name
  // e.g. "FINASTERIDE ACCORD 5mg" -> "ACCORD"
  if (parts.length >= 2) return parts[1];
  return '';
}

function ptDCI(terms) {
  var cand = terms.find(function(t) { return t.endsWith('a'); });
  if (!cand) cand = terms[0] + 'a';
  return cand.charAt(0).toUpperCase() + cand.slice(1);
}

// France: BDPM autocomplete API — fast, returns authorized+commercialized products
async function fetchFrance(substance, terms) {
  var frDebug = {};
  try {
    // The BDPM autocomplete API searches medicine names containing the term
    // Returns [{value: "FINASTERIDE ACCORD 5mg ...", url: "/medicament/.../extrait"}, ...]
    var url = 'https://base-donnees-publique.medicaments.gouv.fr/api/options_autocompilation' +
      '?searchType=medicine&term=' + encodeURIComponent(substance) +
      '&contains=' + encodeURIComponent(substance);
    frDebug.url = url;
    var txt = await fetchApiText(url, 8000);
    var data = JSON.parse(txt);
    frDebug.rawCount = data.length;
    var products = [];
    for (var i = 0; i < data.length; i++) {
      var name = (data[i].value || '').trim();
      if (!name || !matchesTerms(name, terms)) continue;
      products.push({ name: name, holder: holderFromName(name), status: 'Autoris\u00e9' });
      if (products.length >= 50) break;
    }
    frDebug.found = products.length;
    return { products: products, debug: frDebug };
  } catch(e) {
    frDebug.error = e.message;
    return { products: [], debug: frDebug };
  }
}

// Spain: CIMA REST API
async function fetchSpain(substance, terms) {
  var spanishTerm = terms.find(function(t) { return t.endsWith('a'); }) || (substance + 'a');
  var url = 'https://cima.aemps.es/cima/rest/medicamentos?nombre=' +
    encodeURIComponent(spanishTerm) + '&pagina=1&tamanioPagina=100';
  var txt = await fetchApiText(url, 10000);
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

// Belgium: SAM v2 REST API — direct JSON/XML search, no ZIP
async function fetchBelgium(substance, terms) {
  var beDebug = {};
  try {
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
        txt = await fetchApiText(url, 10000);
      } catch(fe) {
        fetchErrors.push(queries[qi] + ':' + fe.message);
        continue;
      }
      beDebug['len' + qi] = txt.length;
      beDebug['preview' + qi] = txt.substring(0, 400);

      // Try JSON
      var jsonOk = false;
      try {
        var data = JSON.parse(txt);
        var items = Array.isArray(data) ? data :
          (data.ampElements || data.result || data.results || data.items || data.content || []);
        if (typeof items === 'object' && !Array.isArray(items)) items = Object.values(items);
        beDebug['jsonKeys' + qi] = Array.isArray(data) ? 'array:' + data.length : Object.keys(data).join(',');
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

      // Try XML if JSON failed or no results
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

// Portugal: INFARMED HTML table
async function fetchPortugal(substance, terms) {
  var dci = ptDCI(terms);
  var b64 = Buffer.from(dci).toString('base64');
  var url = 'http://app10.infarmed.pt/genericos/genericos_II/lista_genericos.php' +
    '?tabela=dispt&fonte=dci&escolha_dci=' + encodeURIComponent(b64);
  var txt = await fetchLatin1(url, 10000);
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
