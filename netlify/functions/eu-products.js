'use strict';
const zlib = require('zlib');
const https = require('https');
const http = require('http');
const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

// France BDPM cache
var _frRows = null, _frTs = 0;
const FR_TTL = 6 * 3600 * 1000;
const FR_URL = 'https://base-donnees-publique.medicaments.gouv.fr/index.php/download/file/CIS_bdpm.txt';

// Belgium SAM cache
var _beVersion = null, _beVersionTs = 0;
const BE_TTL = 6 * 3600 * 1000;
const BE_BASE = 'https://www.vas.ehealth.fgov.be/websamcivics/samcivics/download/';
const MAX_SAM_BYTES = 20 * 1024 * 1024; // 20 MB compressed limit

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

// Belgium: stream ZIP-compressed SAM XML, search OfficialName elements
function streamSearchSAM(url, terms) {
  return new Promise(function(resolve) {
    var products = [], textBuf = '', done = false, xmlStart = '';
    var rawBuf = Buffer.alloc(0), headerParsed = false;
    var inflate = null, bytesIn = 0;

    function finish() {
      if (!done) {
        done = true;
        if (inflate) { try { inflate.destroy(); } catch(e) {} }
        resolve({ products: products, xmlStart: xmlStart });
      }
    }

    function processText(text) {
      if (done) return;
      textBuf += text;
      if (!xmlStart && textBuf.length >= 2000) xmlStart = textBuf.substring(0, 2000);

      var bufL = textBuf.toLowerCase();
      var pos = 0;
      while (true) {
        var idx = bufL.indexOf('officialname', pos);
        if (idx === -1) break;
        var lt = textBuf.lastIndexOf('<', idx);
        if (lt === -1 || lt < idx - 60) { pos = idx + 1; continue; }
        if (textBuf[lt + 1] === '/') { pos = idx + 1; continue; }
        var gt = textBuf.indexOf('>', idx);
        if (gt === -1) break;
        var cStart = gt + 1;
        var nLt = textBuf.indexOf('<', cStart);
        if (nLt === -1) break;
        var name = textBuf.substring(cStart, nLt).trim();
        pos = nLt;
        if (!name || !matchesTerms(name, terms)) continue;
        var ctx = textBuf.substring(lt, Math.min(textBuf.length, lt + 5000));
        var mahM = ctx.match(/<[^>]{0,40}[Nn]ame[^>]{0,40}>([A-Za-z][^<]{2,70})<\/[^>]{0,40}[Nn]ame>/);
        products.push({ name: name, holder: mahM ? mahM[1].trim() : '', status: 'Autoris\u00e9' });
        if (products.length >= 30) { finish(); return; }
      }
      if (textBuf.length > 15000) textBuf = textBuf.substring(textBuf.length - 5000);
    }

    function handleChunk(chunk) {
      if (done) return;
      if (!headerParsed) {
        rawBuf = Buffer.concat([rawBuf, chunk]);
        if (rawBuf.length < 30) return;
        // Check ZIP signature: PK\x03\x04
        if (rawBuf[0] === 0x50 && rawBuf[1] === 0x4B && rawBuf[2] === 0x03 && rawBuf[3] === 0x04) {
          var fileNameLen = rawBuf.readUInt16LE(26);
          var extraLen = rawBuf.readUInt16LE(28);
          var dataStart = 30 + fileNameLen + extraLen;
          if (rawBuf.length < dataStart) return; // need more bytes
          inflate = zlib.createInflateRaw();
          inflate.on('data', function(c) { processText(c.toString('utf8')); });
          inflate.on('end', finish);
          inflate.on('error', finish);
          headerParsed = true;
          inflate.write(rawBuf.slice(dataStart));
        } else {
          // Plain XML (not ZIP)
          headerParsed = true;
          processText(rawBuf.toString('utf8'));
        }
        rawBuf = Buffer.alloc(0);
        return;
      }
      if (inflate) inflate.write(chunk);
    }

    var lib = url.startsWith('https') ? https : http;
    var req = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 PharmaScout/1.0' } }, function(res) {
      if (res.statusCode === 301 || res.statusCode === 302) {
        streamSearchSAM(res.headers.location, terms).then(resolve);
        return;
      }
      if (res.statusCode !== 200) { finish(); return; }
      res.on('data', function(chunk) {
        bytesIn += chunk.length;
        if (done) return;
        handleChunk(chunk);
        if (bytesIn > MAX_SAM_BYTES) { finish(); }
      });
      res.on('end', function() { if (inflate && !done) inflate.end(); else finish(); });
      res.on('error', finish);
    });
    req.on('error', finish);
    req.setTimeout(22000, function() { req.destroy(); finish(); });
  });
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
    // Sample first data row for column verification
    if (_frRows.length > 1) frDebug.sampleCols = _frRows[1].split('\t').slice(0, 9);
  } else {
    frDebug.rowsCached = _frRows.length;
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
  frDebug.found = products.length;
  return { products: products, debug: frDebug };
}

async function fetchSpain(substance, terms) {
  var spanishTerm = terms.find(function(t) { return t.endsWith('a'); }) || (substance + 'a');
  var url = 'https://cima.aemps.es/cima/rest/medicamentos?nombre=' +
    encodeURIComponent(spanishTerm) + '&pagina=1&tamanioPagina=100';
  var txt = await fetchTextNode(url, 15000);
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
    if (!_beVersion || now - _beVersionTs > BE_TTL) {
      var verTxt = await fetchTextNode(BE_BASE + 'samv2-full-getLastVersion?xsd=5', 8000);
      _beVersion = verTxt.trim().replace(/"/g, '').replace(/[^0-9]/g, '');
      _beVersionTs = now;
      beDebug.versionFetched = true;
    }
    beDebug.version = _beVersion;
    if (!_beVersion) throw new Error('empty version');
    var ampUrl = BE_BASE + 'samv2-download?type=FULL&xsd=5&version=' + _beVersion;
    beDebug.ampUrl = ampUrl;
    var result = await streamSearchSAM(ampUrl, terms);
    beDebug.xmlStart = result.xmlStart ? result.xmlStart.substring(0, 500) : 'none';
    return { products: result.products, debug: beDebug };
  } catch(e) {
    beDebug.error = e.message;
    _beVersion = null;
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
