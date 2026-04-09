/**
 * PharmaScout - Swissmedic (CH) v3
 * Produits CH via Excel officiel Swissmedic (MAJ mensuelle)
 * PV alert via vigilance-news
 */
'use strict';
const https = require('https');
const XLSX  = require('xlsx');

const HEADERS = { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*' };
const PV_URL  = 'https://www.swissmedic.ch/swissmedic/en/home/humanarzneimittel/market-surveillance/pharmacovigilance/vigilance-news.html';
const SW_URL  = 'https://www.swissmedic.ch/dam/swissmedic/en/dokumente/internetlisten/zugelassene_arzneimittel_ham_ind.xlsx.download.xlsx/Zugelassene_Arzneimittel_HAM.xlsx';
const SW_TTL  = 6 * 3600 * 1000;

let _rows = null, _rowsTs = 0;

function fetchBuffer(url, ms) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), ms || 8000);
    const req = https.get(url, { headers:{'User-Agent':'Mozilla/5.0'} }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        clearTimeout(t);
        fetchBuffer(r.headers.location, ms).then(res).catch(rej);
        return;
      }
      const c = [];
      r.on('data', d => c.push(d));
      r.on('end',  () => { clearTimeout(t); res(Buffer.concat(c)); });
      r.on('error',e => { clearTimeout(t); rej(e); });
    });
    req.on('error', e => { clearTimeout(t); rej(e); });
  });
}

function fetchText(url, ms) { return fetchBuffer(url, ms).then(b => b.toString('utf8')); }

function colIdx(headers, names) {
  const lo = headers.map(h => String(h||'').toLowerCase().trim());
  for (const n of names) { const i = lo.findIndex(h => h.includes(n)); if (i>=0) return i; }
  return -1;
}

async function getRows() {
  if (_rows && Date.now()-_rowsTs < SW_TTL) return _rows;
  const buf = await fetchBuffer(SW_URL, 8000);
  const wb  = XLSX.read(buf, {type:'buffer'});
  const ws  = wb.Sheets[wb.SheetNames[0]];
  _rows   = XLSX.utils.sheet_to_json(ws, {header:1, defval:''});
  _rowsTs = Date.now();
  return _rows;
}

exports.handler = async function(event) {
  const substance = ((event.queryStringParameters||{}).substance||'').toLowerCase().trim();
  if (!substance) return { statusCode:400, headers:HEADERS, body:JSON.stringify({error:'substance required'}) };

  let swissProducts = [], debugCols = null;
  try {
    const rows = await Promise.race([getRows(), new Promise((_,r)=>setTimeout(()=>r(new Error('to')),8500))]);
    const hdr  = rows[0]||[];
    debugCols  = hdr.slice(0,15);
    const ni = colIdx(hdr,['name','präparat','médicament']);
    const si = colIdx(hdr,['active substance','wirkstoff','substance active','principes actifs','inn']);
    const hi = colIdx(hdr,['authorization holder','holder','zulassungsinhaber','titulaire','inhaber']);
    const ci = colIdx(hdr,['dispensing category','abgabekategorie','catégorie de remise']);
    swissProducts = rows.slice(1)
      .filter(r => si>=0 && String(r[si]||'').toLowerCase().includes(substance))
      .slice(0,30)
      .map(r => ({ name:String(r[ni]||'—'), holder:String(r[hi]||'—'), status:ci>=0?String(r[ci]||'Autorisé CH'):'Autorisé CH' }));
  } catch(e) { debugCols = {err:e.message}; }

  let pvAlert = false;
  try { const html = await fetchText(PV_URL,5000); pvAlert = html.toLowerCase().includes(substance); } catch(_){}

  return {
    statusCode:200, headers:HEADERS,
    body: JSON.stringify({ substance, totalCHProducts:swissProducts.length, products:swissProducts, pvAlert, debugCols })
  };
};