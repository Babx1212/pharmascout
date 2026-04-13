'use strict';
const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

// France BDPM cache
var _frRows = null, _frTs = 0;
const FR_TTL = 6 * 3600 * 1000;
const FR_URL = 'https://base-donnees-publique.medicaments.gouv.fr/index.php/download/file/CIS_bdpm.txt';

// Belgium SAM cache
var _beVersion = null, _beVersionTs = 0;
const BE_TTL = 6 * 3600 * 1000;
const BE_BASE = 'https://www.vas.ehealth.fgov.be/websamcivics/samcivics/download/';
const MAX_SAM_BYTES = 7 * 1024 * 1024;

// helpers
function fetchText(url, timeoutMs) {
  return new Promise(function(resolve, reject) {
    var done = false;
    var t = setTimeout(function() {
      if (!done) { done = true; reject(new Error('timeout:' + url.substring(0, 60))); }
    }, timeoutMs || 12000);
    fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 PharmaScout/1.0' } })
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function(txt) {
        clearTimeout(t);
        if (!done) { done = true; resolve(txt); }
      })
      .catch(function(e) {
        clearTimeout(t);
        if (!done) { done = true; reject(e); }
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

// Portugal DCI
function ptDCI(terms) {
  var cand = terms.find(function(t) { return t.endsWith('a'); });
  if (!cand) cand = terms[0] + 'a';
  return cand.charAt(0).toUpperCase() + cand.slice(1);
}

// Belgium SAM streaming XML search
// Searches for OfficialName elements (handles any namespace prefix)
function streamSearchSAM(url, terms) {
  return new Promise(function(resolve) {
    var products = [], buf = '', bytesRead = 0, done = false, xmlStart = '';

    function finish() {
      if (!done) { done = true; resolve({ products: products, xmlStart: xmlStart }); }
    }

    fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 PharmaScout/1.0' } })
      .then(function(r) {
        if (!r.ok) { finish(); return; }
        var reader = r.body.getReader();
        var dec = new TextDecoder('utf-8');

        function pump() {
          if (done) return;
          reader.read().then(function(chunk) {
            if (chunk.done || done) { finish(); return; }
            bytesRead += chunk.value.length;
            buf += dec.decode(chunk.value, { stream: true });

            // Capture first 2000 chars for debug
            if (!xmlStart && buf.length >= 2000) xmlStart = buf.substring(0, 2000);

            // Search for OfficialName elements (case-insensitive)
            var bufL = buf.toLowerCase();
            var pos = 0;
            while (true) {
              var idx = bufL.indexOf('officialname', pos);
              if (idx === -1) break;

              // Walk back to find the '<' of the opening tag
              var lt = buf.lastIndexOf('<', idx);
              if (lt === -1 || lt < idx - 60) { pos = idx + 1; continue; }

              // Skip if this is a closing tag </...OfficialName>
              if (buf[lt + 1] === '/') { pos = idx + 1; continue; }

              // Find end '>' of the opening tag
              var gt = buf.indexOf('>', idx);
              if (gt === -1) break; // tag not yet complete — wait for more data

              // Extract content between '>' and next '<'
              var contentStart = gt + 1;
              var nextLt = buf.indexOf('<', contentStart);
              if (nextLt === -1) break; // content not yet complete

              var name = buf.substring(contentStart, nextLt).trim();
              pos = nextLt;

              if (!name || !matchesTerms(name, terms)) continue;

              // Extract MAH: look for a <Name> element in next 5000 chars
              var ctx = buf.substring(lt, Math.min(buf.length, lt + 5000));
              var mahM = ctx.match(/<[^>]{0,40}[Nn]ame[^>]{0,40}>([A-Za-z][^<]{2,70})<\/[^>]{0,40}[Nn]ame>/);
              var holder = mahM ? mahM[1].trim() : '';

              products.push({ name: name, holder: holder, status: 'Autoris\u00e9' });
              if (products.length >= 30) { finish(); return; }
            }

            // Keep 5000 chars of tail to not miss split elements
            if (buf.length > 15000) {
              buf = buf.substring(buf.length - 5000);
            }

            if (bytesRead > MAX_SAM_BYTES) { finish(); return; }
            pump();
          }).catch(finish);
        }
        pump();
      })
      .catch(finish);
  });
}

// country fetchers

async function fetchFrance(substance, terms) {
  var now = Date.now();
  if (!_frRows || now - _frTs > FR_TTL) {
    var txt = await fetchText(FR_URL, 25000);
    _frRows = txt.split(/\r?\n/);
    _frTs = now;
  }

  var products = [];
  for (var i = 0; i < _frRows.length; i++) {
    var line = _frRows[i].trim();
    if (!line) continue;
    var cols = line.split('\t');
    if (cols.length < 8) continue;
    if (cols[4] !== 'Autorisation active') continue;
    if (cols[7].indexOf('Commercialis') !== 0) continue;
    var name = cols[1] || '';
    if (!matchesTerms(name, terms)) continue;
    products.push({ name: name, holder: holderFromName(name), status: 'Autoris\u00e9' });
    if (products.length >= 50) break;
  }
  return products;
}

async function fetchSpain(substance, terms) {
  // CIMA needs the Spanish INN name (ends in 'a' for most substances)
  var spanishTerm = terms.find(function(t) { return t.endsWith('a'); }) || (substance + 'a');
  var url = 'https://cima.aemps.es/cima/rest/medicamentos?nombre=' +
    encodeURIComponent(spanishTerm) + '&pagina=1&tamanioPagina=100';
  var txt = await fetchText(url, 15000);
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

async function fetchBelgium(substance, terms) {
  var beDebug = {};
  var now = Date.now();

  try {
    // Step 1: get latest version number for XSD 5
    if (!_beVersion || now - _beVersionTs > BE_TTL) {
      var verTxt = await fetchText(BE_BASE + 'samv2-full-getLastVersion?xsd=5', 8000);
      _beVersion = verTxt.trim().replace(/"/g, '').replace(/[^0-9]/g, '');
      _beVersionTs = now;
      beDebug.versionFetched = true;
    }
    beDebug.version = _beVersion;

    if (!_beVersion) throw new Error('empty version');

    // Step 2: stream the SAM XML and search for OfficialName elements
    var ampUrl = BE_BASE + 'samv2-download?type=FULL&xsd=5&version=' + _beVersion;
    beDebug.ampUrl = ampUrl;

    var result = await streamSearchSAM(ampUrl, terms);
    beDebug.xmlStart = result.xmlStart ? result.xmlStart.substring(0, 800) : 'none';
    return { products: result.products, debug: beDebug };

  } catch(e) {
    beDebug.error = e.message;
    _beVersion = null;
    return { products: [], debug: beDebug };
  }
}

async function fetchPortugal(substance, terms) {
  var dci = ptDCI(terms);
  var b64 = btoa(dci);
  var url = 'http://app10.infarmed.pt/genericos/genericos_II/lista_genericos.php' +
    '?tabela=dispt&fonte=dci&escolha_dci=' + encodeURIComponent(b64);
  var txt = await fetchText(url, 15000);
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
