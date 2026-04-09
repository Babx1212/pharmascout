'use strict';
const https = require('https');
const XLSX  = require('xlsx');

const HEADERS = { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*' };
const PV_URL  = 'https://www.swissmedic.ch/swissmedic/en/home/humanarzneimittel/market-surveillance/pharmacovigilance/vigilance-news.html';
const SW_URL  = 'https://www.swissmedic.ch/dam/swissmedic/en/dokumente/internetlisten/zugelassene_arzneimittel_ham_ind.xlsx.download.xlsx/Zugelassene_Arzneimittel_HAM.xlsx';
const SW_TTL  = 6 * 3600 * 1000;

let _rows = null, _rowsTs = 0;

function fetchBuffer(url, ms, _redirects) {
  _redirects = _redirects || 0;
  return new Promise(function(resolve, reject) {
    if (_redirects > 5) return reject(new Error('Too many redirects'));
    var mod = url.startsWith('https') ? require('https') : require('http');
    var req = mod.get(url, { headers: { 'User-Agent': 'PharmaSpy/1.0' } }, function(res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchBuffer(res.headers.location, ms, _redirects + 1));
      }
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() { resolve(Buffer.concat(chunks)); });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (ms) req.setTimeout(ms, function() { req.destroy(new Error('timeout')); });
  });
}

function fetchText(url, ms) {
  return fetchBuffer(url, ms).then(function(b) { return b.toString('utf8'); });
}

function colIdx(hdr, names) {
  for (var i = 0; i < hdr.length; i++) {
    var h = String(hdr[i] || '').toLowerCase().replace(/[\r\n]+/g,' ').trim();
    for (var j = 0; j < names.length; j++) {
      if (h.indexOf(names[j]) !== -1) return i;
    }
  }
  return -1;
}

function findHeaderRow(rows) {
  for (var i = 0; i < Math.min(10, rows.length); i++) {
    var lo = rows[i].map(function(h) { return String(h||'').toLowerCase().trim(); });
    if (lo.some(function(h) {
      return h.includes('zulassungs') || h.includes('bezeichnung') ||
             h.includes('inhaber') || h.includes('wirkstoff') ||
             h.includes('active substance') || h.includes('autorisation');
    })) {
      return i;
    }
  }
  return 0;
}

async function getRows() {
  var now = Date.now();
  if (_rows && (now - _rowsTs) < SW_TTL) return _rows;
  var buf = await fetchBuffer(SW_URL, 25000);
  var wb  = XLSX.read(buf, { type: 'buffer' });
  var ws  = wb.Sheets[wb.SheetNames[0]];
  var all = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  _rows = all;
  _rowsTs = now;
  return all;
}

exports.handler = async function(event) {
  var substance = ((event.queryStringParameters || {}).substance || '').toLowerCase().trim();
  if (!substance) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'substance required' }) };
  }

  var chProducts = [];
  var debugInfo  = {};

  try {
    var rows   = await Promise.race([
      getRows(),
      new Promise(function(_, rj) { setTimeout(function() { rj(new Error('timeout')); }, 22000); })
    ]);

    var hdrIdx = findHeaderRow(rows);
    var hdr    = rows[hdrIdx] || [];

    var nameIdx   = colIdx(hdr, ['bezeichnung', 'dénomination', 'denomination', 'name']);
    var holderIdx = colIdx(hdr, ['zulassungsinhaberin', 'titulaire', 'holder', 'inhaber']);

    debugInfo = { hdrIdx: hdrIdx, hdr: hdr, nameIdx: nameIdx, holderIdx: holderIdx };

    if (nameIdx >= 0) {
      chProducts = rows.slice(hdrIdx + 1).filter(function(r) {
        var nm = String(r[nameIdx] || '').toLowerCase();
        return nm.indexOf(substance) !== -1;
      }).slice(0, 30).map(function(r) {
        return {
          name:   String(r[nameIdx]   || ''),
          holder: holderIdx >= 0 ? String(r[holderIdx] || '') : '',
          status: 'Autorisé CH'
        };
      });
    }
  } catch(e) {
    debugInfo.err = e.message;
  }

  var pvAlert   = false;
  var pvDetails = '';
  try {
    var html = await Promise.race([
      fetchText(PV_URL, 7000),
      new Promise(function(r) { setTimeout(function() { r(''); }, 6000); })
    ]);
    if (html) {
      var lo = html.toLowerCase();
      pvAlert = lo.indexOf(substance) !== -1;
      if (pvAlert) {
        var idx = lo.indexOf(substance);
        pvDetails = 'Vigilance News: signal détecté pour ' + substance;
      }
    }
  } catch(e) {}

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      substance:       substance,
      totalCHProducts: chProducts.length,
      products:        chProducts,
      pvAlert:         pvAlert,
      pvDetails:       pvDetails,
      debugInfo:       debugInfo
    })
  };
};