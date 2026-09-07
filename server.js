// server.js — رادار چندمنبعی: سرور همیشه‌روشن + بک‌تست ۲۴/۷
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 10000;
const DATA_FILE = path.join(__dirname, 'data.json');
const POLL_MS = 20000;
const WIN_PCT = 0.02;

let state = { seen: {}, lastPrice: {}, bt: { total:0, wins:0, perTab:{} }, updatedAt: null };

try {
  if (fs.existsSync(DATA_FILE)) {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (raw && raw.bt) state = Object.assign(state, raw);
  }
} catch (e) {}

function persist(){
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(state)); } catch(e){}
}

async function j(url){
  const r = await fetch(url, { headers: { 'user-agent': 'radar/1.0' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function analyze(it){
  let score=0; const cats=new Set();
  const vol5=it.vol5||0, vol1=it.vol1||0, avg5=vol1/12;
  const buys5=it.buys5||0, sells5=it.sells5||0, total5=buys5+sells5;
  const buyRatio= total5>0? buys5/total5:0.5;
  const chg5=it.chg5||0, chg1=it.chg1||0;
  const liq=it.liq||0;
  const volLiq= liq>0? vol5/liq:0;
  if(avg5>0){ const r=vol5/avg5; if(r>3)score+=30; else if(r>2)score+=20; else if(r>1.4)score+=10; }
  if(volLiq>1)score+=15; else if(volLiq>0.5)score+=8;
  if(chg5>5)score+=20; else if(chg5>2)score+=12;
  if(total5>=20&&buyRatio>0.65)score+=20; else if(total5>=10&&buyRatio>0.55)score+=10;
  if(volLiq>0.3&&Math.abs(chg5)<2&&buyRatio>=0.5&&total5>=20){score+=20;cats.add('accumulation');}
  if(chg1>5&&chg1<15)score+=10;
  if(chg5<-5)score-=15;
  if(score>=70)cats.add('top');
  if(score>=50)cats.add('signals');
  if(volLiq>0.5)cats.add('volume');
  return { score: Math.max(0,Math.min(100,score)), cats: Array.from(cats) };
}

async function fetchSources(){
  const items=[];
  const tasks=[
    (async()=>{ try{
        const boosts=await j('https://api.dexscreener.com/token-boosts/latest/v1');
        const addrs=(Array.isArray(boosts)?boosts:[]).slice(0,60).map(t=>t.tokenAddress).filter(Boolean);
        for(let i=0;i<addrs.length;i+=30){
          const chunk=addrs.slice(i,i+30);
          const res=await j('https://api.dexscreener.com/latest/dex/tokens/'+chunk.join(','));
          const pairs=Array.isArray(res)?res:(res.pairs||[]);
          pairs.forEach(pr=>{
            if(!pr.pairCreatedAt)return;
            items.push({key:'ds_'+pr.pairAddress,symbol:(pr.baseToken&&pr.baseToken.symbol)||'?',price:+pr.priceUsd||0,liq:(pr.liquidity&&pr.liquidity.usd)||0,vol5:(pr.volume&&pr.volume.m5)||0,vol1:(pr.volume&&pr.volume.h1)||0,buys5:(pr.txns&&pr.txns.m5&&pr.txns.m5.buys)||0,sells5:(pr.txns&&pr.txns.m5&&pr.txns.m5.sells)||0,chg5:(pr.priceChange&&pr.priceChange.m5)||0,chg1:(pr.priceChange&&pr.priceChange.h1)||0});
          });
        }
      }catch(e){} })(),
    (async()=>{ try{
        const r=await j('https://api.bybit.com/v5/market/tickers?category=spot');
        ((r.result&&r.result.list)||[]).filter(t=>t.symbol.indexOf('USDT')===t.symbol.length-4&&+t.turnover24h>1e6).slice(0,60).forEach(t=>{
          items.push({key:'bybit_'+t.symbol,symbol:t.symbol.replace('USDT',''),price:+t.lastPrice||0,liq:0,vol5:(+t.turnover24h)/288,vol1:(+t.turnover24h)/12,buys5:0,sells5:0,chg5:0,chg1:(+t.price24hPcnt||0)*100});
        });
      }catch(e){} })(),
    (async()=>{ try{
        const r=await j('https://www.okx.com/api/v5/market/tickers?instType=SPOT');
        (r.data||[]).filter(t=>t.instId.indexOf('-USDT')>-1&&+t.volCcy24h>1e6).slice(0,60).forEach(t=>{
          const last=+t.last||0,open=+t.open24h||0;
          items.push({key:'okx_'+t.instId,symbol:t.instId.replace('-USDT',''),price:last,liq:0,vol5:(+t.volCcy24h)/288,vol1:(+t.volCcy24h)/12,buys5:0,sells5:0,chg5:0,chg1:open?((last-open)/open)*100:0});
        });
      }catch(e){} })(),
    (async()=>{ try{
        const r=await j('https://api.gateio.ws/api/v4/spot/tickers');
        (Array.isArray(r)?r:[]).filter(t=>t.currency_pair.indexOf('_USDT')>-1&&+t.quote_volume>1e6).slice(0,60).forEach(t=>{
          items.push({key:'gate_'+t.currency_pair,symbol:t.currency_pair.replace('_USDT',''),price:+t.last||0,liq:0,vol5:(+t.quote_volume)/288,vol1:(+t.quote_volume)/12,buys5:0,sells5:0,chg5:0,chg1:+t.change_percentage||0});
        });
      }catch(e){} })(),
  ];
  await Promise.allSettled(tasks);
  return items;
}

async function poll(){
  try{
    const items=await fetchSources();
    const now=Date.now();
    const priceByKey={};
    items.forEach(it=>{ priceByKey[it.key]=it.price; state.lastPrice[it.key]=it.price; });
    items.forEach(it=>{
      const a=analyze(it);
      if(a.score>=50 && !state.seen[it.key]){
        state.seen[it.key]={symbol:it.symbol,entry:it.price,t0:now,cats:a.cats,done:false,results:{}};
      }
    });
    Object.keys(state.seen).forEach(k=>{
      const b=state.seen[k];
      if(b.done)return;
      const price= priceByKey[k]!==undefined?priceByKey[k]:(state.lastPrice[k]!==undefined?state.lastPrice[k]:b.entry);
      [5,15,60].forEach(h=>{
        const el=(now-b.t0)/60000;
        if(el>=h && b.results[h]===undefined){ b.results[h]= price> b.entry*(1+WIN_PCT); }
      });
      if((now-b.t0)/60000>=60 && !b.done){
        b.done=true;
        const win=b.results[60]===true;
        state.bt.total++;
        if(win)state.bt.wins++;
        (b.cats||[]).forEach(c=>{
          if(!state.bt.perTab[c])state.bt.perTab[c]={total:0,wins:0};
          state.bt.perTab[c].total++;
          if(win)state.bt.perTab[c].wins++;
        });
      }
    });
    const ks=Object.keys(state.seen);
    if(ks.length>500){ ks.slice(0,ks.length-500).forEach(k=>delete state.seen[k]); }
    state.updatedAt=new Date().toISOString();
    persist();
  }catch(e){}
}

setInterval(poll, POLL_MS);
poll();

const server=http.createServer((req,res)=>{
  const url=req.url||'/';
  res.setHeader('Access-Control-Allow-Origin','*');
  if(url.indexOf('/health')===0){ res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true})); return; }
  if(url.indexOf('/api/backtest')===0){
    const winRate= state.bt.total>0? Math.round(state.bt.wins/state.bt.total*100):0;
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({total:state.bt.total,wins:state.bt.wins,winRate:winRate,perTab:state.bt.perTab,updatedAt:state.updatedAt}));
    return;
  }
  if(url.indexOf('/api/signals')===0){
    const list=Object.keys(state.seen).filter(k=>!state.seen[k].done).slice(0,20).map(k=>Object.assign({key:k},state.seen[k]));
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(list));
    return;
  }
  fs.readFile(path.join(__dirname,'index.html'),(err,data)=>{
    if(err){ res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    res.end(data);
  });
});
server.listen(PORT,()=>{ console.log('radar server on',PORT); });
