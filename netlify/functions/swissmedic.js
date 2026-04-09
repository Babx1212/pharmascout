'use strict';
const XLSX = require('xlsx');

const HEADERS = { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*' };
const PV_URL  = 'https://www.swissmedic.ch/swissmedic/en/home/humanarzneimittel/market-surveillance/pharmacovigilance/vigilance-news.html';
const SW_URL  = 'https://www.swissmedic.ch/dam/swissmedic/en/dokumente/internetlisten/zugelassene_arzneimittel_ham_ind.xlsx.download.xlsx/Zugelassene_Arzneimittel_HAM.xlsx';
const SW_TTL  = 6 * 3600 * 1000;

let _rows = null, _rowsTs = 0;

function fetchBuffer(url, ms, _hops) {
  _hops = _hops || 0;
  return new Promise(function(resolve, reject) {
    if (_hops > 5) return reject(new Error('Too many redirects'));
    var mod = url.startsWith('https') ? require('https') : require('http');
    var req = mod.get(url, { headers: { 'User-Agent': 'PharmaSpy/1.0' } }, function(res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchBuffer(res.headers.location, ms, _hops + 1));
      }
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end',  function()  { resolve(Buffer.concat(chunks)); });
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
    var h = String(hdr[i] || '').toLowerCase().replace(/[\r\n]+/g, ' ').trim();
    for (var j = 0; j < names.length; j++) {
      if (h.indexOf(names[j]) !== -1) return i;
    }
  }
  return -1;
}

function findHeaderRow(rows) {
  for (var i = 0; i < Math.min(12, rows.length); i++) {
    var row = rows[i];
    var matches = 0, nonEmpty = 0;
    for (var j = 0; j < row.length; j++) {
      var cell = String(row[j] || '').trim();
      if (!cell) continue;
      if (cell.length > 200) { matches = -99; break; }
      nonEmpty++;
      var lo = cell.toLowerCase();
      if (lo.indexOf('bezeichnung') !== -1 || lo.indexOf('denomination') !== -1 ||
          lo.indexOf('inhaber')     !== -1 || lo.indexOf('titulaire')    !== -1 ||
          lo.indexOf('dosisst')     !== -1 || lo.indexOf('abgabekategorie') !== -1 ||
          lo.indexOf('autorisation') !== -1) { matches++; }
    }
    if (matches >= 2 && nonEmpty >= 3) return i;
  }
  return 0;
}

async function getRows() {
  var now = Date.now();
  if (_rows && (now - _rowsTs) < SW_TTL) return _rows;
  var buf = await fetchBuffer(SW_URL, 25000);
  var wb  = XLSX.read(buf, { type: 'buffer' });
  var ws  = wb.Sheets[wb.SheetNames[0]];
  _rows   = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  _rowsTs = now;
  return _rows;
}

exports.handler = async function(event) {
  var substance = ((event.queryStringParameters || {}).substance || '').toLowerCase().trim();
  if (!substance) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'substance required' }) };
  }

  // Build fuzzy search terms to handle German INN spelling (finasteride -> finasterid)
  var terms = [substance];
  if (substance.length > 6) terms.push(substance.slice(0, -1));
  if (substance.length > 7) terms.push(substance.slice(0, -2));

  var chProducts = [];
  try {
    var rows   = await Promise.race([
      getRows(),
      new Promise(function(_, rj) { setTimeout(function() { rj(new Error('timeout')); }, 22000); })
    ]);
    var hdrIdx = findHeaderRow(rows);
    var hdr    = rows[hdrIdx] || [];
    var nameIdx   = colIdx(hdr, ['bezeichnung', 'denomination', 'name']);
    var holderIdx = colIdx(hdr, ['zulassungsinhaberin', 'titulaire', 'holder', 'inhaber']);

    if (nameIdx >= 0) {
      var seen = {};
      rows.slice(hdrIdx + 1).forEach(function(r) {
        var nm = String(r[nameIdx] || '').toLowerCase();
        if (!terms.some(function(t) { return nm.indexOf(t) !== -1; })) return;
        if (seen[nm]) return;
        seen[nm] = true;
        chProducts.push({
          name:   String(r[nameIdx]   || '-'),
          holder: holderIdx >= 0 ? String(r[holderIdx] || '-') : '-',
          status: 'Autorise CH'
        });
      });
      chProducts = chProducts.slice(0, 30);
    }
  } catch(e) { /* silent */ }

  var pvAlert = false, pvDetails = '';
  try {
    var html = await Promise.race([
      fetchText(PV_URL, 7000),
      new Promise(function(r) { setTimeout(function() { r(''); }, 6000); })
    ]);
    if (html) {
      pvAlert = html.toLowerCase().indexOf(substance) !== -1;
      if (pvAlert) pvDetails = 'Vigilance News: signal detecte pour ' + substance;
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
      pvDetails:       pvDetails
    })
  };
};