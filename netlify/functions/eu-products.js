'use strict';
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

// UTF-8 fetch
function fetchApiText(url, timeoutMs, extraHeaders) {
  return new Promise(function(resolve, reject) {
    var done = false;
    var lib = url.startsWith('https') ? https : http;
    var opts = {
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
        'Accept': 'application/json, application/xml, text/html, */*',
        'Accept-Language': 'fr-BE,fr;q=0.9'
      }, extraHeaders || {})
    };
    var req = lib.get(url, opts, function(res) {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303) {
        var loc = res.headers.location;
        if (loc && !done) { done = true; fetchApiText(loc, timeoutMs, extraHeaders).then(resolve).catch(reject); }
        return;
      }
      if (res.statusCode !== 200) {
        if (!done) { done = true; reject(new Error('HTTP ' + res.statusCode + ' ' + url.substring(0, 80))); }
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
      if (!done) { done = true; reject(new Error('timeout ' + (timeoutMs || 10000) + 'ms')); }
    });
  });
}

// latin1 fetch (PT)
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

function buildTerms(s) {
  var t = [s];
  if (s.endsWith('ide') && s.length > 6) { t.push(s.slice(0, -1)); t.push(s.slice(0, -1) + 'a'); }
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
  if (parts.length >= 2) return parts[1];
  return '';
}

function ptDCI(terms) {
  var cand = terms.find(function(t) { return t.endsWith('a'); });
  if (!cand) cand = terms[0] + 'a';
  return cand.charAt(0).toUpperCase() + cand.slice(1);
}

// France: BDPM autocomplete
async function fetchFrance(substance, terms) {
  var frDebug = {};
  try {
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

// Spain: CIMA REST
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

// ───────── BELGIUM ─────────
// Strategy 1: SAM REST API (several URL variants)
// Strategy 2: CBIP/BCFI HTML scraping
// Strategy 3: Stream SAM ZIP and decompress AMP data in Node.js

function parseSamXml(xml, terms) {
  var products = [];
  // extract <OfficialName> elements
  var re = /<OfficialName[^>]*>([\s\S]*?)<\/OfficialName>/gi;
  var m;
  while ((m = re.exec(xml)) !== null) {
    var nm = m[1].replace(/<[^>]+>/g, '').trim();
    if (nm && matchesTerms(nm, terms)) {
      products.push({ name: nm, holder: '', status: 'Autoris\u00e9' });
    }
    if (products.length >= 50) break;
  }
  return products;
}

function parseSamJson(txt, terms, dbg, pfx) {
  var products = [];
  try {
    var data = JSON.parse(txt);
    var items = Array.isArray(data) ? data :
      (data.ampElements || data.result || data.results ||
       data.items || data.content || data.data || []);
    if (typeof items === 'object' && !Array.isArray(items)) items = Object.values(items);
    dbg[pfx + 'jsonKeys'] = Array.isArray(data) ? 'array:' + data.length : Object.keys(data).slice(0,8).join(',');
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
  } catch(e) {
    dbg[pfx + 'jsonErr'] = e.message;
  }
  return products;
}

// Stream SAM ZIP and extract product names via inflateRaw
function streamSamZip(substance, terms, dbg, timeoutMs) {
  return new Promise(function(resolve) {
    // Try AMP-type download first, fallback to FULL is too large
    // Version 11839 was last known; try without version too (will redirect/fail gracefully)
    var zipUrls = [
      'https://www.vas.ehealth.fgov.be/websamcivics/samcivics/download/samv2-download?type=AMP&xsd=6',
      'https://www.vas.ehealth.fgov.be/websamcivics/samcivics/download/samv2-download?type=VMP&xsd=6',
    ];
    var urlIdx = 0;

    function tryUrl(url) {
      dbg['zipUrl' + urlIdx] = url;
      var products = [];
      var done = false;
      var bytesSeen = 0;
      var buf = Buffer.alloc(0);
      var state = 'header'; // 'header' | 'inflating'
      var inflater = null;
      var fileCount = 0;
      var xmlBuf = '';
      var foundNames = {};

      function finish(reason) {
        if (done) return;
        done = true;
        dbg['zipBytes' + urlIdx] = bytesSeen;
        dbg['zipFiles' + urlIdx] = fileCount;
        dbg['zipEnd' + urlIdx] = reason;
        try { req.destroy(); } catch(e) {}
        resolve(products);
      }

      var timer = setTimeout(function() { finish('timeout'); }, timeoutMs);

      function tryNextFile() {
        while (true) {
          if (buf.length < 4) return;
          var sig = buf.readUInt32LE(0);

          if (sig === 0x02014b50 || sig === 0x06054b50) {
            clearTimeout(timer); finish('central-dir'); return;
          }
          if (sig === 0x08074b50) {
            // data descriptor: 4(sig)+4(crc)+4(comp)+4(uncomp) = 16 bytes
            if (buf.length < 16) return;
            buf = buf.slice(16);
            continue;
          }
          if (sig !== 0x04034b50) {
            // scan for next local file header
            var found = -1;
            for (var i = 1; i <= buf.length - 4; i++) {
              if (buf[i] === 0x50 && buf[i+1] === 0x4b && buf[i+2] === 0x03 && buf[i+3] === 0x04) {
                found = i; break;
              }
            }
            if (found === -1) { buf = buf.slice(Math.max(0, buf.length - 3)); return; }
            buf = buf.slice(found);
            continue;
          }
          if (buf.length < 30) return;
          var method = buf.readUInt16LE(8);
          var fnLen = buf.readUInt16LE(26);
          var extraLen = buf.readUInt16LE(28);
          var hdrSize = 30 + fnLen + extraLen;
          if (buf.length < hdrSize) return;
          var fname = buf.slice(30, 30 + fnLen).toString('utf8');
          fileCount++;
          dbg['zipF' + fileCount] = fname;
          buf = buf.slice(hdrSize);

          if (method === 8) {
            state = 'inflating';
            xmlBuf = '';
            inflater = zlib.createInflateRaw();
            inflater.on('data', function(chunk) {
              xmlBuf += chunk.toString('utf8');
              // Search for OfficialName
              var re = /<OfficialName[^>]*>([\s\S]*?)<\/OfficialName>/gi;
              var mm;
              while ((mm = re.exec(xmlBuf)) !== null) {
                var nm = mm[1].replace(/<[^>]+>/g, '').trim();
                if (nm && matchesTerms(nm, terms) && !foundNames[nm]) {
                  foundNames[nm] = true;
                  products.push({ name: nm, holder: '', status: 'Autoris\u00e9' });
                }
              }
              // Trim to avoid OOM
              if (xmlBuf.length > 200000) xmlBuf = xmlBuf.slice(-10000);
            });
            inflater.on('end', function() {
              state = 'header';
              inflater = null;
              tryNextFile();
            });
            inflater.on('error', function(e) {
              dbg['zipF' + fileCount + 'Err'] = e.message;
              state = 'header';
              inflater = null;
              // Scan buf for next local file header
              tryNextFile();
            });
            // Feed current buf to inflater
            if (buf.length > 0) {
              var toFeed = buf;
              buf = Buffer.alloc(0);
              inflater.write(toFeed);
            }
            return; // wait for more data via res.on('data')
          } else {
            // stored or unknown — skip (can't determine size without central dir)
            // Just move on and hope to find next signature
            state = 'header';
          }
        }
      }

      var req = https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 PharmaScout/1.0',
          'Accept': '*/*'
        }
      }, function(res) {
        dbg['zipStatus' + urlIdx] = res.statusCode;
        if (res.statusCode !== 200) {
          clearTimeout(timer);
          urlIdx++;
          if (urlIdx < zipUrls.length) {
            tryUrl(zipUrls[urlIdx]);
          } else {
            resolve(products);
          }
          return;
        }
        res.on('data', function(chunk) {
          if (done) return;
          bytesSeen += chunk.length;
          if (state === 'header') {
            buf = Buffer.concat([buf, chunk]);
            tryNextFile();
          } else if (state === 'inflating' && inflater) {
            inflater.write(chunk);
          }
        });
        res.on('end', function() { clearTimeout(timer); finish('stream-end'); });
        res.on('error', function(e) { clearTimeout(timer); dbg['zipResErr' + urlIdx] = e.message; finish('res-error'); });
      });
      req.on('error', function(e) {
        clearTimeout(timer);
        dbg['zipReqErr' + urlIdx] = e.message;
        urlIdx++;
        if (urlIdx < zipUrls.length) tryUrl(zipUrls[urlIdx]);
        else resolve(products);
      });
      req.setTimeout(timeoutMs + 2000, function() { req.destroy(); finish('req-timeout'); });
    }

    tryUrl(zipUrls[urlIdx]);
  });
}

async function fetchBelgium(substance, terms) {
  var beDebug = {};
  var products = [];

  // ── Strategy 1: SAM REST API variants ──
  var samUrls = [
    // without /websamcivics/ prefix (502 in browser but might work from Lambda)
    'https://www.vas.ehealth.fgov.be/samcivics/rest/samv2/amp?officialName=' + encodeURIComponent(substance) + '&language=fr&status=AUTHORIZED&pageSize=100',
    // with prefix (was 404 before but retry)
    'https://www.vas.ehealth.fgov.be/websamcivics/samcivics/rest/samv2/amp?officialName=' + encodeURIComponent(substance) + '&language=fr&status=AUTHORIZED&pageSize=100',
    // alternative: search by ingredient
    'https://www.vas.ehealth.fgov.be/websamcivics/samcivics/rest/samv2/amp?ingredientName=' + encodeURIComponent(substance) + '&language=fr&pageSize=100',
    // samv2 without domain prefix
    'https://www.ehealth.fgov.be/samcivics/rest/samv2/amp?officialName=' + encodeURIComponent(substance) + '&language=fr&status=AUTHORIZED&pageSize=100',
  ];

  for (var si = 0; si < samUrls.length && products.length === 0; si++) {
    beDebug['s1url' + si] = samUrls[si].substring(0, 100);
    try {
      var txt = await fetchApiText(samUrls[si], 6000);
      beDebug['s1len' + si] = txt.length;
      beDebug['s1pre' + si] = txt.substring(0, 200);
      // Try JSON first
      var jp = parseSamJson(txt, terms, beDebug, 's1j' + si);
      if (jp.length > 0) { products = jp; break; }
      // Try XML
      var xp = parseSamXml(txt, terms);
      beDebug['s1xmlHits' + si] = xp.length;
      if (xp.length > 0) { products = xp; break; }
    } catch(e) {
      beDebug['s1err' + si] = e.message;
    }
  }

  // ── Strategy 2: CBIP.be HTML scraping ──
  if (products.length === 0) {
    var cbipUrls = [
      'https://www.cbip.be/fr/search?query=' + encodeURIComponent(substance),
      'https://www.cbip.be/nl/search?query=' + encodeURIComponent(substance),
      'https://www.cbip.be/fr/chapters?searchParams=' + encodeURIComponent(substance),
    ];
    for (var ci = 0; ci < cbipUrls.length && products.length === 0; ci++) {
      beDebug['s2url' + ci] = cbipUrls[ci];
      try {
        var html = await fetchApiText(cbipUrls[ci], 8000);
        beDebug['s2len' + ci] = html.length;
        beDebug['s2pre' + ci] = html.substring(0, 300);

        // Look for product names in various HTML patterns
        var seen = {};
        // Pattern: data-title or title attributes containing substance
        var reAttr = /(?:data-title|title|data-name|data-label)="([^"]{3,80})"/gi;
        var mm;
        while ((mm = reAttr.exec(html)) !== null) {
          var cand = mm[1].trim();
          if (matchesTerms(cand, terms) && !seen[cand]) {
            seen[cand] = true;
            products.push({ name: cand, holder: '', status: 'Autoris\u00e9' });
          }
          if (products.length >= 50) break;
        }
        // Pattern: link text or heading content
        if (products.length === 0) {
          var reH = /<(?:h[1-6]|a|span|li|td)[^>]*>([^<]{3,80})<\/(?:h[1-6]|a|span|li|td)>/gi;
          while ((mm = reH.exec(html)) !== null) {
            var cand2 = mm[1].trim().replace(/\s+/g, ' ');
            if (matchesTerms(cand2, terms) && !seen[cand2]) {
              seen[cand2] = true;
              products.push({ name: cand2, holder: '', status: 'Autoris\u00e9' });
            }
            if (products.length >= 50) break;
          }
        }
        beDebug['s2hits' + ci] = products.length;
      } catch(e) {
        beDebug['s2err' + ci] = e.message;
      }
    }
  }

  // ── Strategy 3: BCFI (bcfi.be) HTML ──
  if (products.length === 0) {
    try {
      var bcfiUrl = 'https://www.bcfi.be/fr/search?q=' + encodeURIComponent(substance);
      beDebug.s3url = bcfiUrl;
      var bcfiHtml = await fetchApiText(bcfiUrl, 8000);
      beDebug.s3len = bcfiHtml.length;
      beDebug.s3pre = bcfiHtml.substring(0, 400);
      var seen3 = {};
      var re3 = /<(?:h[1-6]|a|span|li|td|div)[^>]*>([^<]{5,100})<\/(?:h[1-6]|a|span|li|td|div)>/gi;
      var mm3;
      while ((mm3 = re3.exec(bcfiHtml)) !== null) {
        var c3 = mm3[1].trim().replace(/\s+/g, ' ');
        if (matchesTerms(c3, terms) && !seen3[c3]) {
          seen3[c3] = true;
          products.push({ name: c3, holder: '', status: 'Autoris\u00e9' });
        }
        if (products.length >= 50) break;
      }
      beDebug.s3hits = products.length;
    } catch(e) {
      beDebug.s3err = e.message;
    }
  }

  // ── Strategy 4: Stream SAM ZIP (Node.js inflateRaw, up to 15s) ──
  if (products.length === 0) {
    try {
      beDebug.s4 = 'starting zip stream';
      var zipProducts = await streamSamZip(substance, terms, beDebug, 15000);
      beDebug.s4hits = zipProducts.length;
      if (zipProducts.length > 0) products = zipProducts;
    } catch(e) {
      beDebug.s4err = e.message;
    }
  }

  beDebug.found = products.length;
  return { products: products, debug: beDebug };
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

// ── Main handler ──
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
