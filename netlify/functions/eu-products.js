'use strict';
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

// UTF-8 fetch for all JSON/HTML APIs
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

// latin1 fetch (PT - INFARMED)
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

// ─────────────────────────── BELGIUM ───────────────────────────

function parseSamXml(xml, terms) {
  var products = [];
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
    dbg[pfx + 'keys'] = Array.isArray(data) ? 'array:' + data.length : Object.keys(data).slice(0, 8).join(',');
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
    dbg[pfx + 'err'] = e.message;
  }
  return products;
}

// Fetch current SAM version (try both known URL variants)
async function getSamVersion(dbg) {
  var versionUrls = [
    'https://www.vas.ehealth.fgov.be/websamcivics/samcivics/download/samv2-fullgetLastVersion?xsd=6',
    'https://www.vas.ehealth.fgov.be/websamcivics/samcivics/download/samv2-full-getLastVersion?xsd=6'
  ];
  for (var i = 0; i < versionUrls.length; i++) {
    try {
      var txt = await fetchApiText(versionUrls[i], 6000);
      dbg['samVersionRaw' + i] = txt.substring(0, 60);
      var m = txt.match(/\d+/);
      if (m) return m[0];
    } catch(e) {
      dbg['samVersionErr' + i] = e.message;
    }
  }
  return '11839'; // last known fallback
}

// Stream SAM ZIP: v14 improvements:
//  - Increased timeout to 23s (was 18s)
//  - Per-file XML sample (first 5000 chars) for schema diagnosis
//  - Raw text search: when substance found in XML, capture 600-char context
//  - Larger xmlBuf tail (100KB instead of 20KB) to reduce missed matches at trim boundary
function streamSamZip(substance, terms, dbg, version, timeoutMs) {
  return new Promise(function(resolve) {
    var products = [];
    var foundNames = {};
    var zipUrl = 'https://www.vas.ehealth.fgov.be/websamcivics/samcivics/download/samv2-download?type=AMP&xsd=6&version=' + version;
    dbg.zipUrl = zipUrl;

    var done = false;
    var bytesSeen = 0;
    var buf = Buffer.alloc(0);
    var fileCount = 0;
    var xmlBuf = '';
    var xmlSampleCaptured = {};

    // State machine
    var mode = 'header'; // 'header' | 'data'
    var compressedLeft = 0;
    var inflater = null;
    var currentFIdx = 0;

    function finish(reason) {
      if (done) return;
      done = true;
      dbg.zipBytes = bytesSeen;
      dbg.zipFiles = fileCount;
      dbg.zipEnd = reason;
      dbg.zipHits = products.length;
      try { req.destroy(); } catch(e2) {}
      if (inflater) { try { inflater.destroy(); } catch(e2) {} inflater = null; }
      resolve(products);
    }

    var timer = setTimeout(function() { finish('timeout'); }, timeoutMs);

    // Feed buffered bytes to inflater, respecting compressedLeft
    function processDataBuf() {
      if (mode !== 'data' || !inflater || done) return;
      if (buf.length === 0) return;

      var avail = buf.length;
      if (avail <= compressedLeft) {
        var toFeed = buf;
        buf = Buffer.alloc(0);
        compressedLeft -= avail;
        if (compressedLeft === 0) {
          inflater.end(toFeed);
        } else {
          inflater.write(toFeed);
        }
      } else {
        var toFeed2 = buf.slice(0, compressedLeft);
        buf = buf.slice(compressedLeft);
        compressedLeft = 0;
        inflater.end(toFeed2);
        // inflater 'end' event will call tryNextFile() with remaining buf
      }
    }

    function tryNextFile() {
      while (!done && mode === 'header') {
        if (buf.length < 4) return;
        var sig = buf.readUInt32LE(0);

        // Central directory or EOCD: done
        if (sig === 0x02014b50 || sig === 0x06054b50) {
          clearTimeout(timer); finish('central-dir'); return;
        }
        // Data descriptor (skip 16 bytes)
        if (sig === 0x08074b50) {
          if (buf.length < 16) return;
          buf = buf.slice(16); continue;
        }
        // Not a local file header: scan for PK\x03\x04
        if (sig !== 0x04034b50) {
          var found = -1;
          for (var i = 1; i <= buf.length - 4; i++) {
            if (buf[i] === 0x50 && buf[i+1] === 0x4b && buf[i+2] === 0x03 && buf[i+3] === 0x04) {
              found = i; break;
            }
          }
          if (found === -1) { buf = buf.slice(Math.max(0, buf.length - 3)); return; }
          buf = buf.slice(found); continue;
        }

        // Local file header: 30 bytes minimum
        if (buf.length < 30) return;
        var flags      = buf.readUInt16LE(6);
        var method     = buf.readUInt16LE(8);
        var compSize   = buf.readUInt32LE(18);
        var fnLen      = buf.readUInt16LE(26);
        var extraLen   = buf.readUInt16LE(28);
        var hdrSize    = 30 + fnLen + extraLen;
        if (buf.length < hdrSize) return;

        var fname = buf.slice(30, 30 + fnLen).toString('utf8');
        fileCount++;
        var fIdx = fileCount;
        currentFIdx = fIdx;
        dbg['f' + fIdx] = fname + ' m=' + method + ' sz=' + compSize;
        buf = buf.slice(hdrSize);

        // Method 0 = stored: skip compSize bytes
        if (method === 0) {
          if (compSize > 0) {
            if (buf.length < compSize) { buf = Buffer.alloc(0); return; }
            buf = buf.slice(compSize);
          }
          continue;
        }

        // Method 8 = deflate
        if (method === 8) {
          var useStreamingMode = false;
          if (compSize === 0 && (flags & 8)) {
            useStreamingMode = true;
            compressedLeft = 0x7FFFFFFF;
            dbg['f' + fIdx + '_stream'] = true;
          } else {
            compressedLeft = compSize;
          }

          mode = 'data';
          xmlBuf = '';

          // Capture first 8 bytes of compressed data for format diagnosis
          if (buf.length > 0) {
            dbg['f' + fIdx + '_first8'] = buf.slice(0, Math.min(8, buf.length)).toString('hex');
          }
          // Auto-detect zlib vs raw deflate
          var isZlibWrapped = buf.length >= 2 && buf[0] === 0x78 &&
            (buf[1] === 0x01 || buf[1] === 0x9c || buf[1] === 0xda || buf[1] === 0x5e ||
             buf[1] === 0x9d || buf[1] === 0xbb || buf[1] === 0xf9);
          dbg['f' + fIdx + '_zlibWrapped'] = isZlibWrapped;
          inflater = isZlibWrapped ? zlib.createInflate() : zlib.createInflateRaw();

          // Closure-capture fIdx for callbacks
          (function(fi) {
            inflater.on('data', function(chunk) {
              if (done) return;
              xmlBuf += chunk.toString('utf8');

              // Capture per-file XML sample (first 5000 chars) for schema diagnosis
              if (!xmlSampleCaptured[fi] && xmlBuf.length >= 300) {
                dbg['f' + fi + '_xml'] = xmlBuf.substring(0, 5000);
                xmlSampleCaptured[fi] = true;
              }

              // Method 1: OfficialName element search (namespace-aware)
              // Matches <OfficialName>, <ns2:OfficialName>, <ns3:OfficialName> etc.
              var re1 = /<[^>]*OfficialName[^>]*>([^<]+)/gi;
              var mm;
              while ((mm = re1.exec(xmlBuf)) !== null) {
                var nm1 = mm[1].trim();
                if (nm1 && matchesTerms(nm1, terms) && !foundNames[nm1]) {
                  foundNames[nm1] = true;
                  products.push({ name: nm1, holder: '', status: 'Autoris\u00e9' });
                }
                if (products.length >= 50) break;
              }

              // Method 2: Raw text search — find substance string anywhere in XML
              // This catches names regardless of element structure
              if (xmlBuf.length > 0) {
                var xmlLow = xmlBuf.toLowerCase();
                for (var ti = 0; ti < terms.length; ti++) {
                  var tl = terms[ti].toLowerCase();
                  var pos = 0;
                  while ((pos = xmlLow.indexOf(tl, pos)) !== -1) {
                    // Capture context around match for debug
                    if (!dbg['f' + fi + '_substCtx']) {
                      dbg['f' + fi + '_substCtx'] = xmlBuf.substring(Math.max(0, pos - 300), pos + 400);
                    }

                    // Look for a tag-contained name near the match
                    var ctxStart = Math.max(0, pos - 800);
                    var ctxEnd = Math.min(xmlBuf.length, pos + 500);
                    var ctxStr = xmlBuf.substring(ctxStart, ctxEnd);

                    // Try extracting from any *Name* element in context
                    var reCtx = /<[^>]*[Nn]ame[^>]*>([^<]{4,120})<\/[^>]+>/g;
                    var mCtx;
                    while ((mCtx = reCtx.exec(ctxStr)) !== null) {
                      var nmCtx = mCtx[1].trim();
                      if (nmCtx && matchesTerms(nmCtx, terms) && !foundNames[nmCtx]) {
                        foundNames[nmCtx] = true;
                        products.push({ name: nmCtx, holder: '', status: 'Autoris\u00e9' });
                      }
                      if (products.length >= 50) break;
                    }

                    // Fallback: extract any text node containing the term
                    if (products.length === 0) {
                      var reTxt = />([^<]{3,120})<\//g;
                      var mTxt;
                      while ((mTxt = reTxt.exec(ctxStr)) !== null) {
                        var nmTxt = mTxt[1].trim();
                        if (nmTxt && matchesTerms(nmTxt, terms) && !foundNames[nmTxt] && nmTxt.length < 120) {
                          foundNames[nmTxt] = true;
                          products.push({ name: nmTxt, holder: '', status: 'Autoris\u00e9' });
                        }
                        if (products.length >= 50) break;
                      }
                    }

                    pos += tl.length;
                    if (products.length >= 50) break;
                  }
                  if (products.length >= 50) break;
                }
              }

              // Prevent OOM: keep last 100KB (was 20KB in v13 — larger tail
              // reduces chance of missing a name split across trim boundaries)
              if (xmlBuf.length > 600000) xmlBuf = xmlBuf.slice(-100000);
            });

            inflater.on('end', function() {
              dbg['f' + fi + '_inflEnd'] = true;
              mode = 'header';
              inflater = null;
              tryNextFile();
            });

            inflater.on('error', function(e2) {
              dbg['f' + fi + '_inflErr'] = e2.message;
              mode = 'header';
              inflater = null;
              tryNextFile();
            });
          })(fIdx);

          if (!useStreamingMode) {
            processDataBuf();
          } else {
            // Streaming mode: write everything, rely on deflate end-of-stream
            if (buf.length > 0) {
              var chunk = buf;
              buf = Buffer.alloc(0);
              inflater.write(chunk);
            }
          }
          return; // wait for more data from res.on('data')
        }

        // Unknown compression method: skip by scanning for next signature
        dbg['f' + fIdx + '_skip'] = 'method=' + method;
        buf = Buffer.alloc(0); return;
      }
    }

    var req = https.get(zipUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 PharmaScout/1.0', 'Accept': '*/*' }
    }, function(res) {
      dbg.zipStatus = res.statusCode;
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        finish('http-' + res.statusCode);
        return;
      }
      res.on('data', function(chunk) {
        if (done) return;
        bytesSeen += chunk.length;
        buf = Buffer.concat([buf, chunk]);
        if (mode === 'header') {
          tryNextFile();
        } else if (mode === 'data') {
          processDataBuf();
        }
      });
      res.on('end', function() { clearTimeout(timer); finish('stream-end'); });
      res.on('error', function(e2) { clearTimeout(timer); dbg.zipResErr = e2.message; finish('res-error'); });
    });
    req.on('error', function(e2) { clearTimeout(timer); dbg.zipReqErr = e2.message; finish('req-error'); });
    req.setTimeout(timeoutMs + 3000, function() { req.destroy(); finish('req-timeout'); });
  });
}

async function fetchBelgium(substance, terms) {
  var beDebug = {};
  var products = [];

  // ── Step 0: Fetch SAM version ──
  var samVersion = await getSamVersion(beDebug);

  // ── Strategy 1: SAM REST API variants ──
  var samUrls = [
    'https://www.vas.ehealth.fgov.be/samcivics/rest/samv2/amp?officialName=' + encodeURIComponent(substance) + '&language=fr&status=AUTHORIZED&pageSize=100',
    'https://www.vas.ehealth.fgov.be/websamcivics/samcivics/rest/samv2/amp?officialName=' + encodeURIComponent(substance) + '&language=fr&status=AUTHORIZED&pageSize=100',
    'https://www.vas.ehealth.fgov.be/websamcivics/samcivics/rest/samv2/amp?ingredientName=' + encodeURIComponent(substance) + '&language=fr&pageSize=100',
  ];

  for (var si = 0; si < samUrls.length && products.length === 0; si++) {
    beDebug['s1url' + si] = samUrls[si].substring(0, 100);
    try {
      var txt = await fetchApiText(samUrls[si], 5000);
      beDebug['s1len' + si] = txt.length;
      beDebug['s1pre' + si] = txt.substring(0, 200);
      var jp = parseSamJson(txt, terms, beDebug, 's1j' + si);
      if (jp.length > 0) { products = jp; break; }
      var xp = parseSamXml(txt, terms);
      beDebug['s1xml' + si] = xp.length;
      if (xp.length > 0) { products = xp; break; }
    } catch(e) {
      beDebug['s1err' + si] = e.message;
    }
  }

  // ── Strategy 2: mymedicine.be search (public Belgian patient portal) ──
  if (products.length === 0) {
    try {
      var mmUrl = 'https://www.mymedicine.be/nl/search?q=' + encodeURIComponent(substance);
      beDebug.s2url = mmUrl;
      var mmHtml = await fetchApiText(mmUrl, 8000, {
        'Referer': 'https://www.mymedicine.be/',
        'Accept': 'text/html,application/xhtml+xml,*/*'
      });
      beDebug.s2len = mmHtml.length;
      beDebug.s2pre = mmHtml.substring(0, 600);
      var seen2 = {};
      // Extract product names from anchor/title tags
      var re2a = /(?:data-title|title)="([^"]{5,100})"/gi;
      var mm2a;
      while ((mm2a = re2a.exec(mmHtml)) !== null) {
        var c2a = mm2a[1].trim();
        if (matchesTerms(c2a, terms) && !seen2[c2a]) { seen2[c2a] = true; products.push({ name: c2a, holder: '', status: 'Autoris\u00e9' }); }
        if (products.length >= 50) break;
      }
      // Fallback: text in headings/links
      if (products.length === 0) {
        var re2b = /<(?:h[1-4]|a)[^>]*>([^<]{5,100})<\/(?:h[1-4]|a)>/gi;
        var mm2b;
        while ((mm2b = re2b.exec(mmHtml)) !== null) {
          var c2b = mm2b[1].trim().replace(/\s+/g, ' ');
          if (matchesTerms(c2b, terms) && !seen2[c2b]) { seen2[c2b] = true; products.push({ name: c2b, holder: '', status: 'Autoris\u00e9' }); }
          if (products.length >= 50) break;
        }
      }
      beDebug.s2hits = products.length;
    } catch(e) {
      beDebug.s2err = e.message;
    }
  }

  // ── Strategy 3: CBIP search ──
  if (products.length === 0) {
    var cbipHeaders = {
      'Referer': 'https://www.cbip.be/',
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'text/html, */*'
    };
    var cbipUrls = [
      'https://www.cbip.be/fr/search?query=' + encodeURIComponent(substance),
      'https://www.cbip.be/nl/search?query=' + encodeURIComponent(substance),
    ];
    for (var ci = 0; ci < cbipUrls.length && products.length === 0; ci++) {
      beDebug['s3url' + ci] = cbipUrls[ci];
      try {
        var cHtml = await fetchApiText(cbipUrls[ci], 8000, cbipHeaders);
        beDebug['s3len' + ci] = cHtml.length;
        beDebug['s3pre' + ci] = cHtml.substring(0, 400);
        var seen3 = {};
        var re3a = /(?:data-title|data-name|alt)="([^"]{5,80})"/gi;
        var mm3;
        while ((mm3 = re3a.exec(cHtml)) !== null) {
          var c3 = mm3[1].trim();
          if (matchesTerms(c3, terms) && !seen3[c3]) { seen3[c3] = true; products.push({ name: c3, holder: '', status: 'Autoris\u00e9' }); }
          if (products.length >= 50) break;
        }
        if (products.length === 0) {
          var re3b = /<(?:h[1-6]|a|span|li|td)[^>]*>([^<]{5,80})<\/(?:h[1-6]|a|span|li|td)>/gi;
          while ((mm3 = re3b.exec(cHtml)) !== null) {
            var c3b = mm3[1].trim().replace(/\s+/g, ' ');
            if (matchesTerms(c3b, terms) && !seen3[c3b]) { seen3[c3b] = true; products.push({ name: c3b, holder: '', status: 'Autoris\u00e9' }); }
            if (products.length >= 50) break;
          }
        }
        beDebug['s3hits' + ci] = products.length;
      } catch(e) {
        beDebug['s3err' + ci] = e.message;
      }
    }
  }

  // ── Strategy 4: FAGG/FAMHP medicines list ──
  if (products.length === 0) {
    try {
      var faggUrl = 'https://www.fagg.be/nl/menselijk_gebruik/geneesmiddelen/geneesmiddelen/lijst?title=' +
        encodeURIComponent(substance) + '&combine=' + encodeURIComponent(substance);
      beDebug.s4url = faggUrl;
      var faggHtml = await fetchApiText(faggUrl, 10000, {
        'Referer': 'https://www.fagg.be/',
        'Accept': 'text/html,application/xhtml+xml,*/*'
      });
      beDebug.s4len = faggHtml.length;
      beDebug.s4pre = faggHtml.substring(0, 600);
      var seen4 = {};
      // Extract product names from table cells and links
      var re4a = /<(?:td|a)[^>]*>\s*([^<]{5,100})\s*<\/(?:td|a)>/gi;
      var mm4;
      while ((mm4 = re4a.exec(faggHtml)) !== null) {
        var c4 = mm4[1].trim().replace(/\s+/g, ' ');
        if (matchesTerms(c4, terms) && !seen4[c4]) { seen4[c4] = true; products.push({ name: c4, holder: '', status: 'Autoris\u00e9' }); }
        if (products.length >= 50) break;
      }
      beDebug.s4hits = products.length;
    } catch(e) {
      beDebug.s4err = e.message;
    }
  }

  // ── Strategy 5: SAM ZIP streaming (v14: 23s timeout, better diagnostics) ──
  if (products.length === 0) {
    beDebug.s5start = 'v' + samVersion;
    try {
      var zipProducts = await streamSamZip(substance, terms, beDebug, samVersion, 23000);
      beDebug.s5hits = zipProducts.length;
      if (zipProducts.length > 0) products = zipProducts;
    } catch(e) {
      beDebug.s5err = e.message;
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
