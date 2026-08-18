// =====================================
// 🔐 THÔNG TIN CẤU HÌNH — KHÔNG THAY ĐỔI
// =====================================
const TELEGRAM_TOKEN   = '8545515587:AAF6uC6kvliAgGrP3gSuTDtc3XxPJMjZXDg';
const TELEGRAM_URL     = "https://api.telegram.org/bot" + TELEGRAM_TOKEN;
const ADMIN_CHAT_ID    = '1538608902';

// =====================================
// 🌐 API BASE — V4
// =====================================
const API_BASE = "https://vnstockapi.containers.snapdeploy.app";

// =====================================
// 🤖 GỌI AI — DeepSeek qua ds2api (OpenAI-compatible)
// ds2api TỰ ĐỘNG xoay vòng/fallback giữa các tài khoản DeepSeek đã cấu hình
// sẵn trong config.json của ds2api — bot KHÔNG cần tự viết logic fallback.
// =====================================
const DS2API_BASE_URL = 'PASTE_DS2API_BASE_URL';
const DS2API_KEY      = 'PASTE_DS2API_KEY';
// Model non-thinking để tránh trễ phản hồi webhook GAS. Đổi sang
// "deepseek-v4-flash-nothinking" nếu muốn tắt search.
const DS2API_MODEL_SEARCH = 'deepseek-v4-flash-search-nothinking';
const DS2API_MODEL_NOTHINKING = 'deepseek-v4-flash-nothinking';

function callAI(promptText, useSearch = false) {
  if (!DS2API_KEY || DS2API_KEY.startsWith('PASTE_')) return null;
  if (!DS2API_BASE_URL || DS2API_BASE_URL.startsWith('PASTE_')) return null;
  try {
    const model = useSearch ? DS2API_MODEL_SEARCH : DS2API_MODEL_NOTHINKING;
    const res = UrlFetchApp.fetch(DS2API_BASE_URL + "/v1/chat/completions", {
      method:"post",
      contentType:"application/json",
      headers:{"Authorization":"Bearer "+DS2API_KEY},
      payload: JSON.stringify({
        model: model,
        messages:[
          {role:"system",content:"Bạn là chuyên gia phân tích chứng khoán Việt Nam. Trả lời bằng tiếng Việt CÓ DẤU. KHÔNG chèn link. Ngắn gọn."},
          {role:"user",content:promptText}
        ],
        temperature:0.1, max_tokens:1500, stream:false
      }),
      muteHttpExceptions:true, timeout:55
    });
    if (res.getResponseCode()===200) {
      const text = JSON.parse(res.getContentText())?.choices?.[0]?.message?.content;
      if (text && text.trim().length>10) return text.trim();
    } else {
      Logger.log("callAI HTTP "+res.getResponseCode()+": "+res.getContentText().substring(0,200));
    }
  } catch(e) { Logger.log("callAI: "+e); }
  return null;
}

// =====================================
// 🧹 CLEAN TEXT
// =====================================
function cleanAIText(text) {
  if(!text||text.trim().length<5) return null;
  text=text.replace(/<think>[\s\S]*?<\/think>/gi,'');
  text=text.replace(/\[([^\]]+)\]\([^)]+\)/g,'$1');
  text=text.replace(/https?:\/\/[^\s)>\]]+/g,'');
  text=text.replace(/<[^>]+>/g,'');
  text=text.replace(/\*\*(.+?)\*\*/gs,'$1');
  text=text.replace(/\*(.+?)\*/gs,'$1');
  text=text.replace(/^#{1,3}\s+(.+)/gm,'▸ $1');
  text=text.replace(/^[\-\*]\s/gm,'• ');
  text=text.replace(/\n{3,}/g,'\n\n');
  return text.trim();
}

// =====================================
// 🌐 GỌI API V4 — HÀM DÙNG CHUNG
// =====================================

// Gọi 1 endpoint, trả null nếu lỗi
function apiGet(path, timeoutSec) {
  timeoutSec = timeoutSec || 20;
  try {
    const res = UrlFetchApp.fetch(API_BASE + path, {
      method:"get", muteHttpExceptions:true, timeout:timeoutSec
    });
    if (res.getResponseCode()===200) {
      const json = JSON.parse(res.getContentText());
      // Bỏ qua nếu API trả lỗi dạng {success:false, error:...}
      if (json && json.success === false) return null;
      return json;
    }
  } catch(e) { Logger.log("apiGet "+path+": "+e); }
  return null;
}

// Gọi nhiều endpoint song song
function apiBatch(paths, timeoutSec) {
  timeoutSec = timeoutSec || 20;
  const reqs = paths.map(p => ({
    url: API_BASE + p, method:"get", muteHttpExceptions:true, timeout:timeoutSec
  }));
  try {
    return UrlFetchApp.fetchAll(reqs).map(res => {
      try {
        if(res.getResponseCode()===200) {
          const json = JSON.parse(res.getContentText());
          if(json && json.success === false) return null;
          return json;
        }
      } catch(e){}
      return null;
    });
  } catch(e) { return paths.map(()=>null); }
}

// =====================================
// 📡 GIÁ REALTIME BATCH (dùng /stock/{sym})
// =====================================
function fetchRealtimePrices(symbols) {
  const prices = {};
  if (!symbols || !symbols.length) return prices;
  const results = apiBatch(symbols.map(s=>"/stock/"+s.toLowerCase()), 10);
  results.forEach((json, i) => {
    if (json && json.close) prices[symbols[i]] = parseFloat(json.close);
  });
  return prices;
}

// Validate mã tồn tại
function isValidSymbol(sym) {
  try {
    const to=Math.floor(Date.now()/1000),from=to-5*24*60*60;
    const res=UrlFetchApp.fetch("https://services.entrade.com.vn/chart-api/v2/ohlcs/stock?from="+from+"&to="+to+"&symbol="+sym+"&resolution=1D",{muteHttpExceptions:true,timeout:5});
    if(res.getResponseCode()===200){const d=JSON.parse(res.getContentText());if(d&&d.c&&d.c.length>0)return true;}
  } catch(e) {}
  return false;
}

// Quy đổi ngân sách kiểu viết tắt VN: "1tr"/"1 triệu" → ×1,000,000, "500k"/"500 nghìn" → ×1,000, số thuần → giữ nguyên (VND)
function parseVNAmount(str) {
  if(!str) return NaN;
  const s=str.trim().toLowerCase().replace(",",".");
  let m=s.match(/^([\d.]+)\s*(tr|triệu|trieu)$/);
  if(m) return parseFloat(m[1])*1000000;
  m=s.match(/^([\d.]+)\s*(k|nghìn|nghin)$/);
  if(m) return parseFloat(m[1])*1000;
  const num=parseFloat(s);
  return (/^[\d.]+$/.test(s) && !isNaN(num)) ? num : NaN;
}

// =====================================
// 💾 CACHE (scan data)
// =====================================
function getCachedTAData(today){const d=PropertiesService.getScriptProperties().getProperty("SCAN_DATA_"+today);return d?JSON.parse(d):null;}
function saveTACacheData(today,data){PropertiesService.getScriptProperties().setProperty("SCAN_DATA_"+today,JSON.stringify(data));}

// =====================================
// 🎨 FORMAT DỮ LIỆU API V4 → HIỂN THỊ
// Chuẩn hóa format từ /hold, /quality, /score, /news, /analyze
// =====================================

// Format kết quả /hold/{symbol} — API quan trọng nhất
function formatHoldResult(sym, holdData, price) {
  if (!holdData) return "⚪ "+sym+" — Không lấy được dữ liệu từ API";
  const lines = [];
  const q = holdData.quality || holdData;
  const score = q.score || 0;
  const rating = q.rating || "N/A";
  const rec = q.recommendation || "";

  // Emoji theo điểm
  const emoji = score>=85?"🟢":score>=65?"🟡":score>=40?"🟠":"🔴";

  lines.push(emoji+" "+sym+" | "+rating+(rec?" — "+rec:""));

  // Giá
  const pr = holdData.price || {};
  const curPrice = price || pr.close;
  if (curPrice) lines.push("   Giá: "+parseFloat(curPrice).toFixed(2));

  // Điểm chi tiết
  if (q.quality_score!=null||q.fund_score!=null||q.dividend_score!=null) {
    const parts = [];
    if(q.fund_score) parts.push("Quỹ:"+q.fund_score);
    if(q.dividend_score) parts.push("CổTức:"+q.dividend_score);
    if(q.quality_score) parts.push("CL:"+q.quality_score);
    if(parts.length) lines.push("   Điểm: "+score+"/100 ("+parts.join(" | ")+")");
  } else if (score) {
    lines.push("   Điểm: "+score+"/100");
  }

  // Quỹ nắm giữ
  const funds = holdData.funds || q.funds;
  if (funds && funds.held_by && funds.held_by.length>0) {
    lines.push("   🏆 Quỹ: "+funds.held_by.map(f=>f.fund+" "+f.weight.toFixed(2)+"%").join(" | "));
  }

  // Lý do điểm
  const reasons = q.reasons || [];
  if (reasons.length>0) {
    lines.push("   ✓ "+reasons.slice(0,3).join(" | "));
  }

  return lines.join("\n");
}

// Format kết quả /news/{symbol}
function formatNews(sym, newsData) {
  if (!newsData || !Array.isArray(newsData) || newsData.length===0) return null;
  const lines = ["📰 TIN TỨC "+sym];
  newsData.slice(0,5).forEach((item,i) => {
    const title = item.title || item.name || item.event || "(không có tiêu đề)";
    const dt = item.date ? item.date.substring(0,10) : "";
    lines.push((i+1)+". "+title+(dt?" ("+dt+")":""));
  });
  return lines.join("\n");
}

// Format kết quả /financial-summary/{symbol}
function formatFinancial(sym, finData) {
  if (!finData || !finData.latest) return null;
  const l = finData.latest;
  const parts = [];
  if(l.roe!=null) parts.push("ROE "+l.roe.toFixed(1)+"%");
  if(l.roa!=null) parts.push("ROA "+l.roa.toFixed(1)+"%");
  if(l.eps!=null) parts.push("EPS "+l.eps.toFixed(0));
  if(l.pe!=null)  parts.push("P/E "+l.pe.toFixed(1));
  if(l.pb!=null)  parts.push("P/B "+l.pb.toFixed(1));
  if(l.debt_to_equity!=null) parts.push("D/E "+l.debt_to_equity.toFixed(2));
  return parts.length ? "📈 "+parts.join(" | ") : null;
}

// =====================================
// 📐 ĐIỂM VÀO KỸ THUẬT (giữ nguyên)
// =====================================
function calcEntryPoints(cur,sma20,hi20,lo20,rsi,atr) {
  const entry=rsi<=60?Math.floor(cur*10)/10:Math.floor(sma20*10)/10;
  const atrSl=atr?Math.floor((entry-2*atr)*100)/100:null;
  // SL tối thiểu cách entry 3% và tối thiểu cách 2% so với lo20
  const rawSl=Math.max(atrSl||0, lo20, entry*0.93);
  const minSl=entry*0.97; // tối thiểu 3% dưới entry
  const sl=Math.floor(Math.min(rawSl,minSl)*100)/100;
  // TP1 tối thiểu 2% trên entry
  const rawTp1=Math.max(hi20,entry*1.02);
  const tp1=Math.ceil(rawTp1*100)/100;
  const tp2=Math.ceil((tp1+(tp1-entry)*0.5)*100)/100;
  const risk=entry-sl;
  const reward=tp1-entry;
  // Đảm bảo risk luôn > 0
  const rr=(risk>0.01&&reward>0)?(reward/risk).toFixed(1):"1.0";
  const rrNum=parseFloat(rr);
  const action=rsi>75?"ĐỨNG NGOÀI":rrNum>=1.5&&entry<=cur*1.02?"MUA":rrNum>=1.0?"CHỜ":"QUAN SÁT";
  return {entry:entry.toFixed(2),tp1:tp1.toFixed(2),tp2:tp2.toFixed(2),sl:sl.toFixed(2),rr,action};
}

// =====================================
// 📊 KỸ THUẬT
// =====================================
function fetchOHLC(symbols, days) {
  const to=Math.floor(Date.now()/1000),from=to-days*24*60*60;
  return UrlFetchApp.fetchAll(symbols.map(s=>({
    url:"https://services.entrade.com.vn/chart-api/v2/ohlcs/stock?from="+from+"&to="+to+"&symbol="+s+"&resolution=1D",
    method:"get",muteHttpExceptions:true
  })));
}
function calcIndicators(d, rtPrice) {
  const c=d.c,v=d.v,h=d.h,l=d.l,n=c.length;
  if(rtPrice&&rtPrice>0){c[n-1]=rtPrice;if(rtPrice>h[n-1])h[n-1]=rtPrice;if(rtPrice<l[n-1])l[n-1]=rtPrice;}
  const cur=c[n-1],lv=v[n-1];
  const sma=(len)=>{let s=0;const m=Math.min(len,n);for(let k=1;k<=m;k++)s+=c[n-k];return s/m;};
  const sma5=sma(5),sma20=sma(20),sma50=sma(50),sma100=sma(100),sma200=sma(200);
  const smaP=(len,off)=>{let s=0;const m=Math.min(len,n-off);for(let k=1+off;k<=m+off;k++)s+=c[n-k];return m>0?s/m:0;};
  const sma5p=smaP(5,1),sma20p=smaP(20,1);
  let sv20=0;for(let k=1;k<=Math.min(20,n);k++)sv20+=v[n-k];
  const avgV=sv20/Math.min(20,n);
  let g=0,ls=0;const rsiP=Math.min(14,n-1);
  for(let k=1;k<=rsiP;k++){const df=c[n-k]-c[n-k-1];df>0?g+=df:ls-=df;}
  const rsi=rsiP===0?50:ls===0?100:100-(100/(1+(g/rsiP)/(ls/rsiP)));
  const hi20=Math.max(...h.slice(-20)),lo20=Math.min(...l.slice(-20));
  const hi10=Math.max(...h.slice(-10)),lo10=Math.min(...l.slice(-10));
  const hi52=Math.max(...h.slice(-Math.min(252,n)));
  const lo52=Math.min(...l.slice(-Math.min(252,n)));
  const trend=cur>sma20&&sma20>sma50?"↑ TĂNG":cur<sma20?"↓ GIẢM":"→ NGANG";
  const volTag=lv>avgV*1.5?"Mạnh":lv<avgV*0.7?"Yếu":"Bình thường";
  const growth1y=n>=240?((cur-c[n-240])/c[n-240]):0;
  const growth6m=n>=120?((cur-c[n-120])/c[n-120]):0;
  const mom20=n>=20?((cur-c[n-20])/c[n-20]*100):0;
  const fromLo52=lo52>0?(cur-lo52)/lo52:0;
  const fromHi52=hi52>0?(cur-hi52)/hi52:0;
  const macd=calcMACD(c),bb=calcBollinger(c),atr=calcATR(h,l,c);
  const val=cur*lv*1000;
  return {cur,lv,n,c,v,h,l,val,sma5,sma20,sma50,sma100,sma200,sma5p,sma20p,
    avgV,rsi,hi20,lo20,hi10,lo10,hi52,lo52,trend,volTag,
    growth1y,growth6m,mom20,fromLo52,fromHi52,macd,bb,atr};
}
function calcMACD(closes) {
  const n=closes.length;if(n<35)return null;
  const ema=(data,p)=>{const k=2/(p+1);let r=[data[0]];for(let i=1;i<data.length;i++)r.push(data[i]*k+r[i-1]*(1-k));return r;};
  const e12=ema(closes,12),e26=ema(closes,26);
  const ml=e12.map((v,i)=>v-e26[i]);
  const sig=ema(ml.slice(25),9);
  const mi=ml.length-1,si=sig.length-1;if(si<1)return null;
  const hist=ml[mi]-sig[si],prevH=ml[mi-1]-sig[si-1];
  return {macd:ml[mi].toFixed(3),signal:sig[si].toFixed(3),histogram:hist.toFixed(3),
    bullish:hist>0&&prevH<=0,bearish:hist<0&&prevH>=0,positive:hist>0};
}
function calcBollinger(closes,period,mult) {
  period=period||20;mult=mult||2;if(closes.length<period)return null;
  const slice=closes.slice(-period);
  const mean=slice.reduce((a,b)=>a+b,0)/period;
  const variance=slice.reduce((s,v)=>s+Math.pow(v-mean,2),0)/period;
  const sd=Math.sqrt(variance),upper=mean+mult*sd,lower=mean-mult*sd;
  const cur=closes[closes.length-1];
  const width=mean>0?((upper-lower)/mean*100):0;
  const pctB=(upper-lower)>0?((cur-lower)/(upper-lower)):0.5;
  return {upper:upper.toFixed(2),lower:lower.toFixed(2),middle:mean.toFixed(2),
    width:width.toFixed(2),pctB:pctB.toFixed(2),squeeze:width<5};
}
function calcATR(highs,lows,closes,period) {
  period=period||14;const n=Math.min(highs.length,lows.length,closes.length);
  if(n<period+1)return null;let s=0;
  for(let i=n-period;i<n;i++){s+=Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1]));}
  return s/period;
}
function getWeeklyTrend(dailyCloses) {
  const w=[];for(let i=dailyCloses.length-1;i>=4;i-=5)w.unshift(dailyCloses[i]);
  if(w.length<10)return "N/A";
  const w10=w.slice(-10).reduce((a,b)=>a+b,0)/10;
  const w20s=w.slice(-Math.min(20,w.length));
  const w20=w20s.reduce((a,b)=>a+b,0)/w20s.length;
  return w[w.length-1]>w10&&w10>w20?"WEEKLY_UP":w[w.length-1]<w10?"WEEKLY_DOWN":"WEEKLY_NEUTRAL";
}
function scoreSignal(ind,ep) {
  let score=0,signals=[];
  if(ind.cur>ind.sma20&&ind.sma20>ind.sma50){score+=30;signals.push("uptrend");}
  else if(ind.cur>ind.sma20){score+=15;signals.push("trên SMA20");}
  if(ind.rsi>=40&&ind.rsi<=60){score+=20;signals.push("RSI cân bằng");}
  else if(ind.rsi>=30&&ind.rsi<40){score+=15;signals.push("RSI quá bán");}
  else if(ind.rsi>70){score-=10;signals.push("RSI quá mua ⚠️");}
  if(ind.lv>ind.avgV*1.5){score+=20;signals.push("vol mạnh");}
  else if(ind.lv>ind.avgV){score+=10;signals.push("vol OK");}
  if(ind.macd&&ind.macd.bullish){score+=15;signals.push("MACD cắt lên");}
  else if(ind.macd&&ind.macd.positive){score+=8;signals.push("MACD dương");}
  if(ind.bb&&parseFloat(ind.bb.pctB)<0.3){score+=15;signals.push("gần BB dưới");}
  if(ind.bb&&ind.bb.squeeze){score+=10;signals.push("BB squeeze");}
  if(ep&&parseFloat(ep.rr)>=2.0){score+=10;signals.push("R:R≥2");}
  else if(ep&&parseFloat(ep.rr)>=1.5){score+=5;signals.push("R:R≥1.5");}
  return {score,signals:signals.join(", ")};
}

// =====================================
// 💼 /buy — DANH MỤC NGẮN HẠN
// =====================================
function getPortfolio(chatId){try{const r=PropertiesService.getScriptProperties().getProperty("PORTFOLIO_"+chatId);return r?JSON.parse(r):{};}catch(e){return {};}}
function savePortfolio(chatId,port){PropertiesService.getScriptProperties().setProperty("PORTFOLIO_"+chatId,JSON.stringify(port));}

function handleBuy(chatId,argStr) {
  if(!argStr){sendMsg(chatId,"Cú pháp: /buy HAG 15.2 500\nVí dụ nhiều mã: /buy HAG 15.2 500, VNM 65.5 1000");return;}
  const port=getPortfolio(chatId);const added=[];const validSyms=[];
  argStr.split(",").forEach(part=>{
    const m=part.trim().match(/^([A-Za-z]{2,4})\s+([\d.]+)(?:\s+(\d+))?/);
    if(!m) return;
    const sym=m[1].toUpperCase();
    if(!isValidSymbol(sym)){added.push("❌ "+sym+": không hợp lệ.");return;}
    const buyPrice=parseFloat(m[2]),qty=m[3]?parseInt(m[3]):0;
    port[sym]={buyPrice,qty:qty||0,addedAt:new Date().toLocaleDateString("vi-VN")};
    added.push(sym+" — Giá mua: "+buyPrice+(qty?" | KL: "+qty:""));
    validSyms.push(sym);
  });
  if(!added.length){sendMsg(chatId,"Không nhận ra mã nào. Ví dụ: /buy HAG 15.2 500");return;}
  savePortfolio(chatId,port);
  // ── Auto-xóa khỏi watchlist khi đã mua thành tài sản ──
  const wl=getWatchlist(chatId);const removedWl=[];
  validSyms.forEach(sym=>{if(wl[sym]){delete wl[sym];removedWl.push(sym);}});
  if(removedWl.length) saveWatchlist(chatId,wl);
  const wlNote=removedWl.length?"\n🗑 Tự xóa khỏi watchlist: "+removedWl.join(", "):"";
  sendMsg(chatId,"✅ Đã thêm danh mục ngắn hạn:\n"+added.join("\n")+wlNote+"\n\n📊 /scan để xem phân tích.");
}

// Phân tích danh mục ngắn hạn — dùng /hold + kỹ thuật
function analyzePortfolioAsync() {
  deleteAllTriggers("analyzePortfolioAsync");
  const props=PropertiesService.getScriptProperties();
  const chatId=props.getProperty("PORTFOLIO_CHAT_ID");
  if(!chatId) return;
  props.deleteProperty("PORTFOLIO_CHAT_ID");
  const port=getPortfolio(chatId);const syms=Object.keys(port);
  if(!syms.length){triggerNextInChain(chatId,"PORTFOLIO");return;}

  // Gọi tuần tự: OHLC kỹ thuật + /hold cho từng mã để bảo vệ RAM server
  let ohlcResponses;
  try{ohlcResponses=fetchOHLC(syms,15);}catch(e){sendMsg(chatId,"Lỗi fetch dữ liệu.");return;}
  const holdResults = [];
  syms.forEach(s => { holdResults.push(apiGet("/hold/"+s, 20)); Utilities.sleep(500); });
  const rtPrices=fetchRealtimePrices(syms);

  const lines=["📊 DANH MỤC ĐANG NẮM GIỮ",new Date().toLocaleDateString("vi-VN"),"─────────────────────────"];
  const aiInputs=[];let totalPnl=0,cnt=0;const results=[];

  ohlcResponses.forEach((res,idx)=>{
    const sym=syms[idx],entry=port[sym];
    const holdData=holdResults[idx];
    try{
      if(res.getResponseCode()!==200) throw new Error("no data");
      const d=JSON.parse(res.getContentText());
      if(!d?.c||!d.c.length) throw new Error("empty");
      const ind=calcIndicators(d,rtPrices[sym]);
      const ep=calcEntryPoints(ind.cur,ind.sma20,ind.hi20,ind.lo20,ind.rsi,ind.atr);
      const ss=scoreSignal(ind,ep);
      const pnl=((ind.cur-entry.buyPrice)/entry.buyPrice*100);
      results.push({sym,entry,ind,ep,ss,pnl,holdData,success:true});
    }catch(e){results.push({sym,success:false});}
  });
  results.sort((a,b)=>(b.ss?.score||0)-(a.ss?.score||0));
  results.forEach(r=>{
    lines.push("");
    if(!r.success){lines.push("⚪ "+r.sym+" — Không lấy được giá");return;}
    const {sym,entry,ind,ep,ss,pnl,holdData}=r;
    const pnlStr=(pnl>=0?"+":"")+pnl.toFixed(2)+"%";
    const qtyStr=entry.qty?" ("+entry.qty+" cổ)":"";
    const pnlVal=entry.qty?((ind.cur-entry.buyPrice)*entry.qty*1000).toLocaleString("vi-VN")+" đ":"";
    const pnlDisplay=pnlVal?pnlStr+" / "+pnlVal:pnlStr;
    const emoji=pnl>=5?"🟢":pnl>=0?"🟡":pnl>=-5?"🟠":"🔴";
    totalPnl+=pnl;cnt++;
    const macdTag=ind.macd?(ind.macd.bullish?" MACD↑":ind.macd.bearish?" MACD↓":""):"";

    // Lấy rating từ API /hold nếu có
    const apiRating = holdData&&holdData.quality?holdData.quality.rating:"";
    const apiScore  = holdData&&holdData.quality?holdData.quality.score:null;

    lines.push(emoji+" "+sym+macdTag+qtyStr+" | KT:"+ss.score+"/130"+(apiScore?" | CL:"+apiScore+"/100":"")+(apiRating?" ("+apiRating+")":""));
    lines.push("   Giá mua : "+entry.buyPrice.toFixed(2)+"  →  Hiện tại: "+ind.cur.toFixed(2)+"  ("+pnlDisplay+")");
    lines.push("   Hành động: "+ep.action+" | TP1:"+ep.tp1+" | SL:"+ep.sl+" | R:R="+ep.rr);
    if(ss.signals) lines.push("   Tín hiệu: "+ss.signals);
    if(ind.bb) lines.push("   BB: "+ind.bb.lower+"—"+ind.bb.upper+" | %B="+ind.bb.pctB+(ind.bb.squeeze?" ⚡SQUEEZE":""));

    // Quỹ từ API
    if(holdData&&holdData.funds&&holdData.funds.held_by&&holdData.funds.held_by.length>0)
      lines.push("   🏆 "+holdData.funds.held_by.map(f=>f.fund+" "+f.weight.toFixed(2)+"%").join(" | "));

    aiInputs.push(sym+": mua="+entry.buyPrice+(entry.qty?" SLG="+entry.qty:"")+" hien="+ind.cur.toFixed(2)+" PnL="+pnlStr+" action="+ep.action+" TP1="+ep.tp1+" SL="+ep.sl+" KT="+ss.score+(apiScore?" CL="+apiScore:"")+" RSI="+ind.rsi.toFixed(0));
  });
  // ── TÓM TẮT P&L + KHUYẾN NGHỊ MUA RÕ RÀNG ─────────────────────────
  if(cnt>0){
    lines.push("");
    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━");
    lines.push("📊 TỔNG KẾT DANH MỤC");
    lines.push("P&L TB: "+(totalPnl/cnt>=0?"🟢 +":"🔴 ")+(totalPnl/cnt).toFixed(2)+"%");
    // Liệt kê mã cần hành động ngay
    const muaNgay=results.filter(r=>r.success&&r.ep&&r.ep.action==="MUA");
    const doiCho=results.filter(r=>r.success&&r.ep&&r.ep.action==="CHỜ");
    const dungNgoai=results.filter(r=>r.success&&r.ep&&(r.ep.action==="ĐỨNG NGOÀI"||r.ep.action==="QUAN SÁT"));
    if(muaNgay.length){
      lines.push("");
      lines.push("◆◆◆ HÀNH ĐỘNG NGAY ◆◆◆");
      muaNgay.forEach(r=>{
        const pnlStr=(r.pnl>=0?"+":"")+r.pnl.toFixed(2)+"%";
        lines.push("▶ MUA THÊM: "+r.sym+" | Vào: "+r.ep.entry+" | TP1: "+r.ep.tp1+" | SL: "+r.ep.sl+" | R:R="+r.ep.rr);
        lines.push("  P&L hiện tại: "+pnlStr+" | RSI: "+r.ind.rsi.toFixed(0));
      });
    }
    if(doiCho.length){
      lines.push("");
      lines.push("◇ CHỜ TÍN HIỆU:");
      doiCho.forEach(r=>lines.push("  "+r.sym+" | Vào: "+r.ep.entry+" | TP1: "+r.ep.tp1+" | SL: "+r.ep.sl));
    }
    if(dungNgoai.length){
      lines.push("");
      lines.push("⚠ THẬN TRỌNG:");
      dungNgoai.forEach(r=>lines.push("  "+r.sym+" — "+r.ep.action));
    }
    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━");
  }
  sendLongMsg(chatId,lines.join("\n"));
  if(aiInputs.length){
    const aiText=callAI("Danh mục NGẮN HẠN (điểm vào/TP/SL kỹ thuật đã tính sẵn, CL=điểm chất lượng/100):\n"+aiInputs.join("\n")+"\n\nVới từng mã, tìm TIN TỨC mới nhất, đưa ra:\n1. HÀNH ĐỘNG cụ thể: MUA THÊM / NẮM GIỮ / BÁN BỚT / BÁN HẾT\n2. Lý do 1-2 câu (kỹ thuật + chất lượng DN + tin tức)\n3. Nếu MUA THÊM: gom tại giá nào?\n4. Nếu CHỐT: chốt tại giá nào?\nTiếng Việt có dấu, ngắn gọn.");
    sendLongMsg(chatId,"🤖 KHUYẾN NGHỊ AI CHO TỪNG MÃ\n─────────────────────────\n"+(cleanAIText(aiText)||"AI đang bận."));
  }
  triggerNextInChain(chatId,"PORTFOLIO");
}

// =====================================
// 👁 /stock — WATCHLIST
// =====================================
function getWatchlist(chatId){try{const r=PropertiesService.getScriptProperties().getProperty("WATCHLIST_"+chatId);if(!r)return{};const p=JSON.parse(r);if(Array.isArray(p)){const o={};p.forEach(s=>{if(typeof s==="string")o[s]={refPrice:null,addedAt:""};});saveWatchlist(chatId,o);return o;}return p;}catch(e){return {};}}
function saveWatchlist(chatId,wl){PropertiesService.getScriptProperties().setProperty("WATCHLIST_"+chatId,JSON.stringify(wl));}

function handleStock(chatId,argStr) {
  if(!argStr){sendMsg(chatId,"Cú pháp: /stock HAG\nVí dụ nhiều mã: /stock HAG, VNM, VIC");return;}
  const wl=getWatchlist(chatId);const added=[];
  argStr.split(",").forEach(part=>{
    const m=part.trim().match(/^([A-Za-z]{2,4})\s*([\d.]+)?/);
    if(!m) return;
    const sym=m[1].toUpperCase();
    if(!isValidSymbol(sym)){added.push("❌ "+sym+": không hợp lệ.");return;}
    const ref=m[2]?parseFloat(m[2]):null;
    wl[sym]={refPrice:ref||null,addedAt:new Date().toLocaleDateString("vi-VN")};
    added.push(sym+(ref?" (tham chiếu: "+ref+")":""));
  });
  if(!added.length){sendMsg(chatId,"Không nhận ra mã nào.");return;}
  saveWatchlist(chatId,wl);
  sendMsg(chatId,"✅ Đã thêm theo dõi:\n"+added.join("\n")+"\n\n📊 /scan để xem phân tích.");
}

function analyzeStockAsync() {
  deleteAllTriggers("analyzeStockAsync");
  const props=PropertiesService.getScriptProperties();
  const chatId=props.getProperty("STOCK_CHAT_ID");
  const symsRaw=props.getProperty("STOCK_SYMBOLS");
  props.deleteProperty("STOCK_CHAT_ID");props.deleteProperty("STOCK_SYMBOLS");
  if(!chatId||!symsRaw) return;
  let syms=JSON.parse(symsRaw);
  if(!Array.isArray(syms)) syms=Object.keys(syms);
  syms=syms.filter(s=>typeof s==="string"&&/^[A-Z]{2,4}$/.test(s));
  if(!syms.length) return;
  const wl=getWatchlist(chatId);

  // Tuần tự: OHLC + /hold để tránh lỗi 503
  let ohlcResponses;
  try{ohlcResponses=fetchOHLC(syms,15);}catch(e){sendMsg(chatId,"Lỗi fetch dữ liệu.");return;}
  const holdResults = [];
  syms.forEach(s => { holdResults.push(apiGet("/hold/"+s, 20)); Utilities.sleep(500); });
  const rtPrices=fetchRealtimePrices(syms);

  const lines=["👁 PHÂN TÍCH WATCHLIST",new Date().toLocaleDateString("vi-VN"),"─────────────────────────"];
  const aiInputs=[];const results=[];
  ohlcResponses.forEach((res,idx)=>{
    const sym=syms[idx],entry=wl[sym]||{};
    const holdData=holdResults[idx];
    try{
      if(res.getResponseCode()!==200) throw new Error("no data");
      const d=JSON.parse(res.getContentText());
      if(!d?.c||!d.c.length) throw new Error("empty");
      const ind=calcIndicators(d,rtPrices[sym]);
      const ep=calcEntryPoints(ind.cur,ind.sma20,ind.hi20,ind.lo20,ind.rsi,ind.atr);
      const ss=scoreSignal(ind,ep);
      results.push({sym,entry,ind,ep,ss,holdData,success:true});
    }catch(e){results.push({sym,success:false});}
  });
  results.sort((a,b)=>(b.ss?.score||0)-(a.ss?.score||0));
  results.forEach(r=>{
    lines.push("");
    if(!r.success){lines.push("⚪ "+r.sym+" — Không lấy được dữ liệu");return;}
    const {sym,entry,ind,ep,ss,holdData}=r;
    const apiScore = holdData&&holdData.quality?holdData.quality.score:null;
    const apiRating= holdData&&holdData.quality?holdData.quality.rating:"";
    lines.push("📌 "+sym+" | Giá: "+ind.cur.toFixed(2)+" | "+ind.trend+" | KT:"+ss.score+"/130"+(apiScore?" | CL:"+apiScore+"/100":""));
    if(entry.refPrice){const pnl=((ind.cur-entry.refPrice)/entry.refPrice*100);lines.push("   Tham chiếu: "+entry.refPrice+"  "+(pnl>=0?"🟢":"🔴")+" "+(pnl>=0?"+":"")+pnl.toFixed(2)+"%");}
    lines.push("   RSI: "+ind.rsi.toFixed(0)+" | KL: "+ind.volTag+(ind.macd?" | MACD: "+(ind.macd.positive?"+":"−")+ind.macd.histogram:""));
    lines.push("   Hỗ trợ: "+ind.lo20.toFixed(2)+" | Kháng cự: "+ind.hi20.toFixed(2));
    if(ind.bb) lines.push("   BB: "+ind.bb.lower+"—"+ind.bb.upper+" | %B="+ind.bb.pctB+(ind.bb.squeeze?" ⚡SQUEEZE":""));
    lines.push("   ── "+ep.action+" ──");
    lines.push("   Vào: "+ep.entry+" | TP1: "+ep.tp1+" | TP2: "+ep.tp2+" | SL: "+ep.sl+" | R:R="+ep.rr);
    if(ss.signals) lines.push("   Tín hiệu: "+ss.signals);
    if(apiRating) lines.push("   Chất lượng DN: "+apiRating+(holdData.quality&&holdData.quality.recommendation?" — "+holdData.quality.recommendation:""));
    if(holdData&&holdData.funds&&holdData.funds.held_by&&holdData.funds.held_by.length>0)
      lines.push("   🏆 "+holdData.funds.held_by.map(f=>f.fund+" "+f.weight.toFixed(2)+"%").join(" | "));
    aiInputs.push(sym+": giá="+ind.cur.toFixed(2)+" KT="+ss.score+" CL="+(apiScore||"N/A")+" action="+ep.action+" TP1="+ep.tp1+" SL="+ep.sl);
  });
  // ── TÓM TẮT WATCHLIST ─────────────────────────────────────────────
  const wlMua=results.filter(r=>r.success&&r.ep&&r.ep.action==="MUA");
  const wlCho=results.filter(r=>r.success&&r.ep&&r.ep.action==="CHỜ");
  if(wlMua.length||wlCho.length){
    lines.push("");
    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━");
    lines.push("📋 TÓM TẮT TÍN HIỆU WATCHLIST");
    if(wlMua.length){
      lines.push("");
      lines.push("◆◆◆ CÓ TÍN HIỆU MUA ◆◆◆");
      wlMua.forEach(r=>{
        lines.push("▶ "+r.sym+" | Vào: "+r.ep.entry+" | TP1: "+r.ep.tp1+" | SL: "+r.ep.sl+" | R:R="+r.ep.rr);
        lines.push("  Điểm KT: "+r.ss.score+"/130 | RSI: "+r.ind.rsi.toFixed(0)+" | "+r.ss.signals);
      });
    }
    if(wlCho.length){
      lines.push("");
      lines.push("◇ ĐANG CHỜ:");
      wlCho.forEach(r=>lines.push("  "+r.sym+" | Vào: "+r.ep.entry+" | TP1: "+r.ep.tp1+" | SL: "+r.ep.sl));
    }
    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━");
  }
  sendLongMsg(chatId,lines.join("\n"));
  if(!aiInputs.length) return;
  const aiText=callAI("Watchlist:\n"+aiInputs.join("\n")+"\n\nTìm tin tức mới nhất từng mã và viết:\n1. HÀNH ĐỘNG: MUA / CHỜ / QUAN SÁT\n2. Lý do 1-2 câu: kỹ thuật + tin tức\n3. Rủi ro chính cần chú ý\nTiếng Việt có dấu, ngắn gọn.");
  sendLongMsg(chatId,"🤖 PHÂN TÍCH AI — WATCHLIST\n─────────────────────────\n"+(cleanAIText(aiText)||"AI đang bận."));
}

// =====================================
// 🌱 /hold — TÍCH SẢN DÀI HẠN
// =====================================
function getHoldList(chatId){try{const r=PropertiesService.getScriptProperties().getProperty("HOLD_"+chatId);return r?JSON.parse(r):{};}catch(e){return {};}}
function saveHoldList(chatId,hold){PropertiesService.getScriptProperties().setProperty("HOLD_"+chatId,JSON.stringify(hold));}

// =====================================
// 🔔 /noti — Cảnh báo giá
// =====================================
function getAlerts(chatId){try{const r=PropertiesService.getScriptProperties().getProperty("ALERT_"+chatId);return r?JSON.parse(r):{};}catch(e){return {};}}
function saveAlerts(chatId,alerts){PropertiesService.getScriptProperties().setProperty("ALERT_"+chatId,JSON.stringify(alerts));}

function handleNoti(chatId,argStr) {
  if(!argStr){
    const alerts=getAlerts(chatId);
    const syms=Object.keys(alerts);
    if(!syms.length){sendMsg(chatId,"📭 Bạn chưa có cảnh báo giá nào.\nCú pháp: /noti HAG 15");return;}
    const lines=["🔔 CẢNH BÁO GIÁ ĐANG BẬT","─────────────────────────"];
    syms.forEach(s=>{
      const a=alerts[s];
      lines.push(s+": mục tiêu "+a.target+(a.lastPrice!=null?" (giá gần nhất: "+a.lastPrice+")":" (đang chờ giá đầu tiên)"));
    });
    sendMsg(chatId,lines.join("\n"));
    return;
  }
  const parts=argStr.trim().split(/\s+/);
  if(parts[0].toUpperCase()==="DEL"){
    if(parts.length<2){sendMsg(chatId,"Cú pháp: /noti del HAG");return;}
    const sym=parts[1].toUpperCase();
    const alerts=getAlerts(chatId);
    if(!alerts[sym]){sendMsg(chatId,"❌ Không có cảnh báo cho "+sym+".");return;}
    delete alerts[sym];
    saveAlerts(chatId,alerts);
    sendMsg(chatId,"🗑 Đã xóa cảnh báo "+sym+".");
    return;
  }
  const sym=parts[0].toUpperCase();
  const target=parseFloat(parts[1]);
  if(!/^[A-Z]{2,4}$/.test(sym)||parts.length<2||isNaN(target)||target<=0){
    sendMsg(chatId,"Cú pháp:\n/noti HAG 15       — đặt cảnh báo khi giá HAG chạm/vượt 15\n/noti              — xem cảnh báo đang bật\n/noti del HAG      — xóa cảnh báo HAG");
    return;
  }
  if(!isValidSymbol(sym)){sendMsg(chatId,"❌ Không tìm thấy mã '"+sym+"'.");return;}
  const alerts=getAlerts(chatId);
  alerts[sym]={target,lastPrice:null,setAt:new Date().toLocaleDateString("vi-VN")};
  saveAlerts(chatId,alerts);
  sendMsg(chatId,"🔔 Đã đặt cảnh báo "+sym+" khi giá chạm/vượt mốc "+target+".\nSẽ tự động thông báo 1 lần rồi tắt (kiểm tra mỗi ~5 phút).");
}

function handleHold(chatId,argStr) {
  const hold=getHoldList(chatId);
  if(!argStr){handleViewHold(chatId);return;}
  const parts=argStr.trim().split(/\s+/);
  const sym=parts[0].toUpperCase();
  if(sym==="SCAN"){runHoldScan(chatId);return;}
  if(parts.length===1&&/^[A-Z]{2,4}$/.test(sym)){
    if(!isValidSymbol(sym)){sendMsg(chatId,"❌ Không tìm thấy mã '"+sym+"'.");return;}
    const entry=hold[sym];
    if(entry&&entry.purchases&&entry.purchases.length){
      const totalQty=entry.purchases.reduce((s,p)=>s+p.qty,0);
      const totalCost=entry.purchases.reduce((s,p)=>s+p.price*p.qty,0);
      const lines=["🌱 "+sym+" — Tích sản của bạn","─────────────────────────"];
      entry.purchases.forEach((p,i)=>lines.push("Lần "+(i+1)+": "+p.qty+" cổ @ "+p.price+" ("+p.date+")"));
      lines.push("─────────────────────────");
      lines.push("Tổng: "+totalQty+" cổ | Giá TB: "+(totalCost/totalQty).toFixed(2)+" | Đầu tư: "+(totalCost/1000).toFixed(0)+"K");
      sendMsg(chatId,lines.join("\n"));
    }
    analyzeValueSingle(chatId,sym);
    return;
  }
  // Ghi nhận mua: đúng 3 phần "mã giá khối_lượng", cả 2 phần sau đều là số (giữ nguyên hành vi cũ)
  if(parts.length===3&&/^[A-Z]{2,4}$/.test(sym)){
    const price=parseFloat(parts[1]),qty=parseInt(parts[2]);
    if(!isNaN(price)&&!isNaN(qty)&&price>0&&qty>0){
      if(!isValidSymbol(sym)){sendMsg(chatId,"❌ Không tìm thấy mã '"+sym+"'.");return;}
      if(!hold[sym]) hold[sym]={purchases:[]};
      hold[sym].purchases.push({price,qty,date:new Date().toLocaleDateString("vi-VN")});
      saveHoldList(chatId,hold);
      const totalQty=hold[sym].purchases.reduce((s,p)=>s+p.qty,0);
      const totalCost=hold[sym].purchases.reduce((s,p)=>s+p.price*p.qty,0);
      // ── Auto-xóa khỏi watchlist khi đã vào tích sản ──
      const wl=getWatchlist(chatId);let removedWlMsg="";
      if(wl[sym]){delete wl[sym];saveWatchlist(chatId,wl);removedWlMsg="\n🗑 Tự xóa "+sym+" khỏi watchlist."}
      sendMsg(chatId,"✅ Ghi nhận mua "+sym+" (lần "+hold[sym].purchases.length+"):\nLần này: "+qty+" cổ @ "+price+"\n─────────────────────────\nTổng: "+totalQty+" cổ | Giá TB: "+(totalCost/totalQty).toFixed(2)+"\nĐầu tư: "+(totalCost/1000).toFixed(0)+"K"+removedWlMsg+"\n\n📊 /scan để xem phân tích toàn bộ.");
      return;
    }
  }

  // So sánh nhiều mã (2-5 mã, không có ngân sách cuối)
  const upParts=parts.map(p=>p.toUpperCase());
  if(upParts.length>=2&&upParts.length<=5&&upParts.every(p=>/^[A-Z]{2,4}$/.test(p))){
    runHoldCompare(chatId,upParts,null);
    return;
  }

  // Phân bổ vốn (2-5 mã + 1 token ngân sách dạng "1tr"/"500k"/số thuần)
  if(upParts.length>=3&&upParts.length<=6){
    const syms=upParts.slice(0,-1);
    const budget=parseVNAmount(parts[parts.length-1]);
    if(syms.length>=2&&syms.length<=5&&syms.every(s=>/^[A-Z]{2,4}$/.test(s))&&!isNaN(budget)&&budget>0){
      runHoldCompare(chatId,syms,budget);
      return;
    }
  }

  sendMsg(chatId,"Cú pháp:\n/hold                  — xem tích sản (tự quét nếu chưa có)\n/hold VNM              — phân tích VNM ngay\n/hold VNM 65.70 1000   — ghi nhận mua\n/hold VNM HAG VCB      — so sánh 2-5 mã, chọn mã tốt nhất\n/hold VNM HAG VCB 1tr  — so sánh + phân bổ vốn 1 triệu VND theo điểm chất lượng");
}

// =====================================
// ⚖️ /hold — SO SÁNH & PHÂN BỔ VỐN nhiều mã (code thuần, KHÔNG dùng AI để tính điểm/phân bổ)
// =====================================
function runHoldCompare(chatId,syms,budget) {
  sendMsg(chatId,"⏳ Đang "+(budget?"phân bổ vốn":"so sánh")+" "+syms.length+" mã: "+syms.join(", ")+"...");
  const props=PropertiesService.getScriptProperties();
  props.setProperty("HOLD_CMP_CHAT_ID",chatId);
  props.setProperty("HOLD_CMP_SYMS",JSON.stringify(syms));
  props.setProperty("HOLD_CMP_BUDGET",budget?String(budget):"");
  deleteAllTriggers("holdCompareAsync");
  ScriptApp.newTrigger("holdCompareAsync").timeBased().after(100).create();
}

function holdCompareAsync() {
  deleteAllTriggers("holdCompareAsync");
  const props=PropertiesService.getScriptProperties();
  const chatId=props.getProperty("HOLD_CMP_CHAT_ID");
  const symsRaw=props.getProperty("HOLD_CMP_SYMS");
  const budgetRaw=props.getProperty("HOLD_CMP_BUDGET");
  props.deleteProperty("HOLD_CMP_CHAT_ID");props.deleteProperty("HOLD_CMP_SYMS");props.deleteProperty("HOLD_CMP_BUDGET");
  if(!chatId||!symsRaw) return;
  let syms;
  try{ syms=JSON.parse(symsRaw); }catch(e){ sendMsg(chatId,"❌ Lỗi đọc danh sách mã."); return; }
  const budget=budgetRaw?parseFloat(budgetRaw):null;

  // Validate mã tồn tại
  const validSyms=syms.filter(s=>isValidSymbol(s));
  const invalidSyms=syms.filter(s=>!validSyms.includes(s));
  if(validSyms.length<2){sendMsg(chatId,"❌ Cần ít nhất 2 mã hợp lệ để "+(budget?"phân bổ vốn":"so sánh")+".\n"+(invalidSyms.length?"Không hợp lệ: "+invalidSyms.join(", "):""));return;}

  // Lấy điểm chất lượng — code thuần, không dùng AI để tính điểm
  const qualityResults=apiBatch(validSyms.map(s=>"/quality/"+s),20);
  const rows=[];
  validSyms.forEach((s,i)=>{
    const q=qualityResults[i];
    if(q&&typeof q.score==="number"){
      rows.push({sym:s,score:q.score,rating:q.rating||"",recommendation:q.recommendation||"",reasons:q.reasons||[]});
    }
  });
  const noScoreSyms=validSyms.filter(s=>!rows.find(r=>r.sym===s));
  if(!rows.length){sendMsg(chatId,"❌ Không lấy được điểm chất lượng cho mã nào trong nhóm.");return;}
  rows.sort((a,b)=>b.score-a.score);

  // ── Chế độ SO SÁNH (không ngân sách) ──
  if(!budget){
    const lines=["📊 SO SÁNH TÍCH SẢN "+rows.length+" MÃ","─────────────────────────"];
    rows.forEach((r,i)=>{
      const medal=i===0?"🥇 ":i===1?"🥈 ":i===2?"🥉 ":"   #"+(i+1)+" ";
      lines.push(medal+r.sym+" | "+r.score+"/100 — "+r.rating+(r.recommendation?" — "+r.recommendation:""));
    });
    if(invalidSyms.length) lines.push("\n⚠ Mã không hợp lệ: "+invalidSyms.join(", "));
    if(noScoreSyms.length) lines.push("⚠ Không lấy được điểm: "+noScoreSyms.join(", "));
    lines.push("\n◆◆◆ MÃ TỐT NHẤT: "+rows[0].sym+" ("+rows[0].score+"/100) ◆◆◆");
    sendLongMsg(chatId,lines.join("\n"));

    const aiCtx=rows.map(r=>r.sym+"="+r.score+"đ("+r.rating+")").join(", ");
    const aiText=callAI("So sánh tích sản dài hạn các mã: "+aiCtx+". Mã điểm cao nhất là "+rows[0].sym+". Giải thích ngắn gọn (2-3 câu) vì sao "+rows[0].sym+" là lựa chọn tốt nhất để tích sản dài hạn trong nhóm này, dựa trên các điểm số đã cho. Tiếng Việt có dấu, không chèn link, không tự tính lại điểm.");
    if(aiText) sendMsg(chatId,"🤖 "+(cleanAIText(aiText)||""));
    return;
  }

  // ── Chế độ PHÂN BỔ VỐN (code thuần) ──
  const totalScore=rows.reduce((s,r)=>s+r.score,0);
  if(totalScore<=0){sendMsg(chatId,"❌ Không thể phân bổ vốn vì tổng điểm chất lượng bằng 0.");return;}

  const priceResults=apiBatch(rows.map(r=>"/stock/"+r.sym),20);
  const alloc=[];
  let totalAllocated=0;
  rows.forEach((r,i)=>{
    const priceData=priceResults[i];
    const priceK=(priceData&&priceData.close)?parseFloat(priceData.close):null; // đơn vị nghìn đồng, giữ nguyên quy ước hiện có
    const weight=r.score/totalScore;
    const moneyForSym=budget*weight;
    if(!priceK||priceK<=0){
      alloc.push({sym:r.sym,score:r.score,weight,priceK:null,qty:0,spent:0});
      return;
    }
    const realPrice=priceK*1000; // giá thực VND
    let qty=Math.floor(moneyForSym/realPrice);
    if(qty>=100) qty=Math.floor(qty/100)*100; // làm tròn xuống bội số lô 100, giữ nguyên nếu <100
    const spent=qty*realPrice;
    totalAllocated+=spent;
    alloc.push({sym:r.sym,score:r.score,weight,priceK,qty,spent});
  });
  const remainder=budget-totalAllocated;

  const lines=["💰 PHÂN BỔ VỐN TÍCH SẢN — Ngân sách: "+budget.toLocaleString("vi-VN")+" đ","─────────────────────────"];
  alloc.forEach(a=>{
    if(!a.priceK){ lines.push(a.sym+": ⚪ Không lấy được giá — bỏ qua"); return; }
    lines.push(a.sym+": "+a.qty+" cổ @ "+a.priceK.toFixed(2)+" (điểm "+a.score+"/100, tỷ trọng "+(a.weight*100).toFixed(1)+"%) = "+a.spent.toLocaleString("vi-VN")+" đ");
  });
  lines.push("─────────────────────────");
  lines.push("Tổng đã phân bổ: "+totalAllocated.toLocaleString("vi-VN")+" đ");
  lines.push("Dư do làm tròn lô: "+remainder.toLocaleString("vi-VN")+" đ");
  if(invalidSyms.length) lines.push("\n⚠ Mã không hợp lệ: "+invalidSyms.join(", "));
  if(noScoreSyms.length) lines.push("⚠ Không lấy được điểm (đã loại khỏi rổ): "+noScoreSyms.join(", "));
  sendLongMsg(chatId,lines.join("\n"));

  const aiCtx=alloc.filter(a=>a.priceK).map(a=>a.sym+"="+a.qty+"cổ("+a.score+"đ)").join(", ");
  if(aiCtx){
    const aiText=callAI("Phân bổ vốn tích sản dài hạn theo điểm chất lượng (đã tính sẵn bằng code, KHÔNG thay đổi số liệu): "+aiCtx+". Giải thích ngắn gọn (2-3 câu) cơ sở của cách phân bổ này và lưu ý rủi ro. Tiếng Việt có dấu, không chèn link.");
    if(aiText) sendMsg(chatId,"🤖 "+(cleanAIText(aiText)||""));
  }
}

// runHoldScan — quét TT tìm mã tích sản (tự động khi /hold và danh sách trống)
function runHoldScan(chatId) {
  sendMsg(chatId,"⏳ Đang quét toàn thị trường tìm mã tích sản tốt nhất...\nTiêu chí:\n• Cổ tức tiền mặt tăng đều\n• Doanh thu/lợi nhuận tăng đều hàng năm\n• Quỹ lớn đang nắm giữ\n• Không dùng margin");
  // Xoá cache cũ để đảm bảo chấm điểm lại với dữ liệu mới nhất
  const today=new Date().toLocaleDateString("vi-VN");
  try{PropertiesService.getScriptProperties().deleteProperty("HOLD_SCAN_"+today);}catch(e){}
  PropertiesService.getScriptProperties().setProperty("HOLD_SCAN_CHAT_ID",chatId);
  deleteAllTriggers("holdScanAsync");
  ScriptApp.newTrigger("holdScanAsync").timeBased().after(100).create();
}

function holdScanAsync() {
  deleteAllTriggers("holdScanAsync");
  const props=PropertiesService.getScriptProperties();
  const chatId=props.getProperty("HOLD_SCAN_CHAT_ID")||ADMIN_CHAT_ID;
  props.deleteProperty("HOLD_SCAN_CHAT_ID");

  const today=new Date().toLocaleDateString("vi-VN");
  const CACHE_KEY="HOLD_SCAN_"+today;
  let candidates=null;
  try{const c=props.getProperty(CACHE_KEY);if(c)candidates=JSON.parse(c);}catch(e){}

  if(!candidates){
    // Gọi song song 3 nguồn: /fund-favorites + /growth-stocks + /dividend-kings
    // Không dùng /recommend vì hay timeout — tự build từ /fund-favorites
    sendMsg(chatId,"⏳ Đang lấy dữ liệu từ quỹ và API...");
    const batchRes = apiBatch(["/fund-favorites","/growth-stocks","/dividend-kings"], 25);
    const favData    = (batchRes[0]&&typeof batchRes[0]==="object") ? batchRes[0] : {};
    const growthData = batchRes[1]&&batchRes[1].stocks ? batchRes[1].stocks : [];
    const divData    = batchRes[2]&&batchRes[2].stocks ? batchRes[2].stocks : [];

    // Gộp và deduplicate
    const seen={};
    const merged=[];

    // Lấy mã từ fund-favorites (DCDS + DCDE top holdings)
    Object.entries(favData).forEach(([fund, holdings])=>{
      if(!Array.isArray(holdings)) return;
      holdings.forEach(h=>{
        const sym=(h.stock_code||h.symbol||h.ticker||"").toUpperCase();
        if(sym&&/^[A-Z]{2,4}$/.test(sym)&&!seen[sym]){
          seen[sym]=true;
          merged.push({sym,score:0,source:"fund:"+fund}); // score sẽ được chấm riêng
        }
      });
    });

    growthData.forEach(r=>{
      if(!seen[r.symbol]){seen[r.symbol]=true;merged.push({sym:r.symbol,score:0,roe:r.roe,source:"growth"});}
    });
    divData.forEach(r=>{
      if(!seen[r.symbol]){seen[r.symbol]=true;merged.push({sym:r.symbol,score:0,divCount:r.dividend_count,source:"dividend"});}
    });

    // Bổ sung AI nếu chưa đủ 10
    if(merged.length<10){
      sendMsg(chatId,"⏳ Đang nhờ AI bổ sung mã tích sản...");
      const aiText=callAI("Bạn là chuyên gia đầu tư giá trị (tích sản). Tìm kiếm trên internet các cổ phiếu Việt Nam (HOSE, HNX, UPCOM) có lợi nhuận tăng trưởng mạnh nhất, chia cổ tức đều đặn và có tin tức tốt nhất hiện tại.\nCHỈ TRẢ VỀ DUY NHẤT một mảng JSON chứa 10 mã. Ví dụ: [FPT,HPG,SSI]. Tuyệt đối KHÔNG kèm văn bản giải thích.");
      if(aiText){
        let aiSyms=[];
        try{const m=aiText.match(/\[.*?\]/s);if(m)aiSyms=JSON.parse(m[0].replace(/([A-Z]{2,4})/g,'"$1"'));}catch(e){}
        if(!aiSyms.length){const m=aiText.match(/[A-Z]{3,4}/g);if(m)aiSyms=[...new Set(m)];}
        aiSyms.filter(s=>/^[A-Z]{3,4}$/.test(s)).forEach(s=>{
          if(!seen[s]){seen[s]=true;merged.push({sym:s,score:0,source:"ai"});}
        });
      }
    }

    // ── Chấm điểm thực từ /score (tối đa 15 mã) ──────────────────
    // Tăng timeout lên 30s để Render không bị cold start timeout
    // Sửa bug: !res.success===false → dùng res.success !== false
    const symsToScore = merged.slice(0,15).map(m=>m.sym);
    sendMsg(chatId,"⏳ Đang chấm điểm "+symsToScore.length+" mã... (chấm điểm tuần tự để tránh nghẽn RAM server)");
    const scoreResults = [];
    symsToScore.forEach(s => { scoreResults.push(apiGet("/score/"+s, 20)); Utilities.sleep(500); });
    let scoredCount = 0;
    scoreResults.forEach((res,i)=>{
      // Điều kiện đúng: res có data VÀ không phải lỗi {success:false}
      if(res && typeof res==="object" && res.score != null && res.success !== false){
        const sym = symsToScore[i];
        const target = merged.find(m=>m.sym===sym);
        if(target){
          target.score  = typeof res.score  === "number" ? res.score  : 0;
          target.rating = typeof res.rating === "string" ? res.rating : "";
          scoredCount++;
        }
      }
    });
    Logger.log("holdScanAsync: chấm điểm "+scoredCount+"/"+symsToScore.length+" mã thành công");

    // Lấy OHLC để tính kỹ thuật
    const symbols=merged.slice(0,15).map(c=>c.sym);
    if(!symbols.length){sendMsg(chatId,"❌ Không lấy được danh sách mã.");return;}
    const to=Math.floor(Date.now()/1000),from=to-365*24*60*60;
    const reqs=symbols.map(s=>({url:"https://services.entrade.com.vn/chart-api/v2/ohlcs/stock?from="+from+"&to="+to+"&symbol="+s+"&resolution=1D",method:"get",muteHttpExceptions:true}));
    let ohlcRes;
    try{ohlcRes=UrlFetchApp.fetchAll(reqs);}catch(e){sendMsg(chatId,"Lỗi lấy dữ liệu kỹ thuật.");return;}
    const rtPrices=fetchRealtimePrices(symbols);
    candidates=[];
    ohlcRes.forEach((res,j)=>{
      try{
        if(res.getResponseCode()!==200) return;
        const d=JSON.parse(res.getContentText());
        if(!d?.c||d.c.length<60) return;
        const sym=symbols[j];
        const info=merged.find(m=>m.sym===sym)||{};
        const ind=calcIndicators(d,rtPrices[sym]);
        let techScore=info.score||50;
        if(ind.sma50>ind.sma100&&ind.sma100>ind.sma200) techScore+=20;
        if(ind.val>10e9) techScore+=10;
        candidates.push({
          sym,cur:ind.cur,techScore,apiScore:info.score||0,
          rating:info.rating||"",source:info.source||"",
          val:(ind.val/1e9).toFixed(1),
          fromLo52:(ind.fromLo52*100).toFixed(1),
          growth1y:(ind.growth1y*100).toFixed(1),
          growth6m:(ind.growth6m*100).toFixed(1),
          sma50:ind.sma50.toFixed(2),sma200:ind.sma200.toFixed(2)
        });
      }catch(e){}
    });
    candidates.sort((a,b)=>(b.apiScore+b.techScore)-(a.apiScore+a.techScore));
    // Chỉ lưu cache nếu có ít nhất 1 mã có điểm thực (> 0)
    // Tránh cache kết quả tệ (toàn 0 điểm) rồi đọc lại hôm sau
    const hasRealScore = candidates.some(c=>c.apiScore>0);
    if(hasRealScore){
      try{props.setProperty(CACHE_KEY,JSON.stringify(candidates));}catch(e){}
      Logger.log("holdScanAsync: đã cache "+candidates.length+" mã (có điểm thực)");
    } else {
      Logger.log("holdScanAsync: KHÔNG cache vì toàn bộ apiScore=0");
    }
  }

  if(!candidates.length){sendMsg(chatId,"Không lọc được mã nào.");return;}

  const now=new Date();
  const sourceEmoji={recommend:"🏆",growth:"📈",dividend:"💰",ai:"🤖"};
  const lines=["🌱 SCAN TÍCH SẢN DÀI HẠN","📅 "+today+" | "+now.getHours()+":"+now.getMinutes().toString().padStart(2,"0"),"─────────────────────────────"];
  candidates.slice(0,10).forEach((c,i)=>{
    const src=sourceEmoji[c.source.split(":")[0]]||"📌";
    const scoreEmoji=c.apiScore>=85?"🟢":c.apiScore>=65?"🟡":c.apiScore>=40?"🟠":c.apiScore>0?"🔴":"⚪";
    const ratingStr=c.rating?" — "+c.rating:"";
    lines.push("");
    lines.push((i+1)+". "+c.sym+" "+src+" | Giá: "+c.cur.toFixed(2));
    lines.push("   "+scoreEmoji+" Điểm CL: "+c.apiScore+"/100"+ratingStr);
    lines.push("   Từ đáy 52T: +"+c.fromLo52+"% | Tăng 1Y: "+(parseFloat(c.growth1y)>=0?"+":"")+c.growth1y+"% | 6T: "+(parseFloat(c.growth6m)>=0?"+":"")+c.growth6m+"%");
    lines.push("   GT GD: "+c.val+" tỷ | SMA50: "+c.sma50+" | SMA200: "+c.sma200);
  });
  lines.push("\n⏳ AI đang phân tích chi tiết...");
  sendLongMsg(chatId,lines.join("\n"));

  const top5=candidates.slice(0,5).map(c=>c.sym+"(điểm="+c.apiScore+" giá="+c.cur.toFixed(2)+" tang1Y="+c.growth1y+"% GT="+c.val+"tỷ nguon="+c.source+")").join(", ");
  const aiFinalText=callAI("Bối cảnh: Nhà đầu tư muốn tích sản dài hạn 5-10 năm:\n• Cổ tức tiền mặt, năm sau cao hơn năm trước\n• Doanh thu/lợi nhuận tăng đều hàng năm\n• KHÔNG dùng margin\n• DCA khi giá chỉnh\n\nCác cổ phiếu: "+top5+"\n\nTìm tin tức và báo cáo tài chính mới nhất:\n1. Chọn DUY NHẤT 1 mã tốt nhất\n2. Lịch sử cổ tức 3-5 năm (có tăng đều không?)\n3. P/E, P/B, ROE — đang rẻ hay đắt?\n4. Giá kỳ vọng: 3 năm / 5 năm / 10 năm\n5. Chiến lược DCA: mua lần đầu khi nào, khi nào mua thêm\n6. Rủi ro dài hạn\nGợi ý: /hold [MÃ] [GIÁ] [SỐ_CỔ]\nTiếng Việt có dấu, ngắn gọn.");
  sendLongMsg(chatId,"🌱 AI CHỌN MÃ TÍCH SẢN\n─────────────────────────────\n"+(cleanAIText(aiFinalText)||"AI đang bận. Dùng /hold [MÃ] để phân tích chi tiết."));
}

function handleViewHold(chatId) {
  const hold=getHoldList(chatId);const syms=Object.keys(hold);
  if(!syms.length){
    // Danh sách trống → tự động quét luôn
    sendMsg(chatId,"Danh sách tích sản trống. Đang tự động quét thị trường tìm mã tốt nhất...");
    runHoldScan(chatId);
    return;
  }
  sendMsg(chatId,"⏳ Đang phân tích "+syms.length+" mã tích sản...");
  PropertiesService.getScriptProperties().setProperty("HOLD_ANALYZE_CHAT_ID",chatId);
  deleteAllTriggers("analyzeHoldAsync");
  ScriptApp.newTrigger("analyzeHoldAsync").timeBased().after(100).create();
}

function analyzeHoldAsync() {
  deleteAllTriggers("analyzeHoldAsync");
  const props=PropertiesService.getScriptProperties();
  const chatId=props.getProperty("HOLD_ANALYZE_CHAT_ID");
  if(!chatId) return;
  props.deleteProperty("HOLD_ANALYZE_CHAT_ID");
  const hold=getHoldList(chatId);const syms=Object.keys(hold);
  if(!syms.length){triggerNextInChain(chatId,"HOLD");return;}

  // Lấy dữ liệu API tuần tự
  let ohlcResponses;
  try{ohlcResponses=fetchOHLC(syms,365);}catch(e){sendMsg(chatId,"Lỗi fetch dữ liệu.");return;}
  const holdResults = [];
  syms.forEach(s => { holdResults.push(apiGet("/hold/"+s, 20)); Utilities.sleep(500); });
  const rtPrices=fetchRealtimePrices(syms);

  const lines=["🌱 DANH SÁCH TÍCH SẢN DÀI HẠN",new Date().toLocaleDateString("vi-VN"),"─────────────────────────"];
  const aiInputs=[];
  ohlcResponses.forEach((res,idx)=>{
    const sym=syms[idx],entry=hold[sym];
    const holdData=holdResults[idx];
    const totalQty=entry.purchases.reduce((s,p)=>s+p.qty,0);
    const totalCost=entry.purchases.reduce((s,p)=>s+p.price*p.qty,0);
    const avgPrice=totalCost/totalQty;
    lines.push("");
    try{
      if(res.getResponseCode()!==200) throw new Error("no data");
      const d=JSON.parse(res.getContentText());
      if(!d?.c||!d.c.length) throw new Error("empty");
      const ind=calcIndicators(d,rtPrices[sym]);
      const pnlPct=((ind.cur-avgPrice)/avgPrice*100);
      const pnlStr=(pnlPct>=0?"+":"")+pnlPct.toFixed(2)+"%";
      const pnlVal=((ind.cur-avgPrice)*totalQty).toFixed(0);
      const emoji=pnlPct>=10?"🟢":pnlPct>=0?"🟡":pnlPct>=-10?"🟠":"🔴";
      const growth1y=(ind.growth1y*100).toFixed(1);
      const fromLo52=(ind.fromLo52*100).toFixed(1);
      const wTrend=getWeeklyTrend(ind.c);
      const trend=ind.cur>ind.sma50&&ind.sma50>ind.sma100?"↑ Tích lũy tốt":ind.cur>ind.sma50?"→ Trung lập":"↓ Thận trọng";

      // Dữ liệu API /hold
      const apiQ = holdData&&holdData.quality?holdData.quality:null;
      const apiScore = apiQ?apiQ.score:null;
      const apiRating = apiQ?apiQ.rating:"";
      const apiRec = apiQ?apiQ.recommendation:"";

      lines.push(emoji+" "+sym+(wTrend!=="N/A"?" ["+wTrend+"]":"")+(apiScore?" | "+apiScore+"/100 "+apiRating:""));
      lines.push("   Giá TB    : "+avgPrice.toFixed(2)+"  →  Hiện tại: "+ind.cur.toFixed(2));
      lines.push("   Lãi/Lỗ   : "+pnlStr+"  ("+pnlVal+" đ × "+totalQty+" cổ)");
      lines.push("   Tăng 1Y   : "+(parseFloat(growth1y)>=0?"+":"")+growth1y+"% | Từ đáy 52T: +"+fromLo52+"%");
      lines.push("   Xu hướng  : "+trend+" | "+entry.purchases.length+" lần mua");
      if(apiRec) lines.push("   Khuyến nghị: "+apiRec);
      // Quỹ nắm giữ từ API
      if(holdData&&holdData.funds&&holdData.funds.held_by&&holdData.funds.held_by.length>0)
        lines.push("   🏆 "+holdData.funds.held_by.map(f=>f.fund+" "+f.weight.toFixed(2)+"%").join(" | "));
      if(ind.macd) lines.push("   MACD: "+(ind.macd.positive?"+":"−")+ind.macd.histogram+(ind.macd.bullish?" ↑CROSS":""));

      // Lý do điểm chất lượng
      if(apiQ&&apiQ.reasons&&apiQ.reasons.length>0)
        lines.push("   ✓ "+apiQ.reasons.slice(0,3).join(" | "));

      aiInputs.push(sym+": giaTB="+avgPrice.toFixed(2)+" hienTai="+ind.cur.toFixed(2)+" PnL="+pnlStr+" tang1Y="+growth1y+"% trend="+trend+" weekly="+wTrend+(apiScore?" clScore="+apiScore+" rating="+apiRating:" clScore=N/A")+" soLanMua="+entry.purchases.length);
    }catch(e){lines.push("⚪ "+sym+" — Không lấy được dữ liệu");}
  });
  sendLongMsg(chatId,lines.join("\n"));
  if(aiInputs.length){
    const aiText=callAI("Danh sách TÍCH SẢN DÀI HẠN (chiến lược 10 năm, không dùng margin):\n"+aiInputs.join("\n")+"\n\nVới từng mã, tìm TIN TỨC + BÁO CÁO TÀI CHÍNH mới nhất:\n1. HÀNH ĐỘNG: Mua thêm / Giữ / Chờ giá tốt / Cân nhắc thoát\n2. GIÁ MUA THÊM cụ thể\n3. Cổ tức gần nhất — xu hướng tăng hay giảm?\n4. Rủi ro dài hạn\nTiếng Việt có dấu, ngắn gọn.");
    sendLongMsg(chatId,"🤖 PHÂN TÍCH TÍCH SẢN\n─────────────────────────\n"+(cleanAIText(aiText)||"AI đang bận."));
  }
  triggerNextInChain(chatId,"HOLD");
}

// =====================================
// 🔍 PHÂN TÍCH GIÁ TRỊ 1 MÃ (tích sản)
// Dùng /analyze/{symbol} — tổng hợp toàn bộ từ API
// =====================================
function analyzeValueSingle(chatId, symbol) {
  sendMsg(chatId,"🔍 Đang phân tích "+symbol+" theo tiêu chí đầu tư giá trị...");
  try{
    const now=Math.floor(Date.now()/1000);
    // Song song: OHLC + /analyze (tổng hợp toàn bộ)
    const allReqs=[
      {url:"https://services.entrade.com.vn/chart-api/v2/ohlcs/stock?from="+(now-365*24*60*60)+"&to="+now+"&symbol="+symbol+"&resolution=1D",method:"get",muteHttpExceptions:true},
      {url:API_BASE+"/analyze/"+symbol, method:"get",muteHttpExceptions:true,timeout:35}
    ];
    const allRes=UrlFetchApp.fetchAll(allReqs);
    const parse=(r)=>{try{if(r.getResponseCode()===200)return JSON.parse(r.getContentText());}catch(e){}return null;};
    const ohlcData=parse(allRes[0]);
    const analyzeData=parse(allRes[1]);  // {price, company, score, quality, dividend, funds, news}

    if(!ohlcData?.c||ohlcData.c.length<20){sendMsg(chatId,"❌ Không đủ dữ liệu OHLC cho "+symbol);return;}

    const rtPrices=fetchRealtimePrices([symbol]);
    const ind=calcIndicators(ohlcData,rtPrices[symbol]);
    const growth1y=(ind.growth1y*100).toFixed(1);
    const growth6m=(ind.growth6m*100).toFixed(1);
    const fromLo52=(ind.fromLo52*100).toFixed(1);
    const trend=ind.cur>ind.sma50&&ind.sma50>ind.sma100?"↑ Tích lũy tốt":ind.cur>ind.sma50?"→ Trung lập":"↓ Thận trọng";

    // Lấy dữ liệu từ /analyze
    const co = analyzeData&&analyzeData.company;
    const apiScore = analyzeData&&analyzeData.score;
    const apiQuality = analyzeData&&analyzeData.quality;
    const apiFunds = analyzeData&&analyzeData.funds;
    const apiNews = analyzeData&&analyzeData.news;
    const apiFinancial = analyzeData&&analyzeData.price;

    const indName=(Array.isArray(co)&&co[0]&&co[0].industry)?co[0].industry:"Chưa rõ ngành";

    const displayLines=["📊 "+symbol+" — Phân tích đầu tư giá trị ("+indName+")","─────────────────────────",
      "Giá hiện tại : "+ind.cur.toFixed(2),
      "SMA50        : "+ind.sma50.toFixed(2)+" | SMA200: "+ind.sma200.toFixed(2),
      "Từ đáy 52T  : +"+fromLo52+"% | Tăng 1Y: "+(parseFloat(growth1y)>=0?"+":"")+growth1y+"% | 6T: "+(parseFloat(growth6m)>=0?"+":"")+growth6m+"%",
      "Xu hướng dài : "+trend];

    // Điểm chất lượng từ API
    if(apiQuality){
      displayLines.push("─────────────────────────");
      displayLines.push("⭐ Điểm: "+(apiQuality.score||0)+"/100 — "+(apiQuality.rating||"")+" — "+(apiQuality.recommendation||""));
      if(apiQuality.fund_score||apiQuality.dividend_score||apiQuality.quality_score)
        displayLines.push("   Quỹ:"+apiQuality.fund_score+" | CổTức:"+apiQuality.dividend_score+" | CL:"+apiQuality.quality_score);
    }
    if(apiScore&&apiScore.reasons&&apiScore.reasons.length>0)
      displayLines.push("✓ "+apiScore.reasons.slice(0,4).join(" | "));

    // Quỹ nắm giữ
    if(apiFunds&&apiFunds.held_by&&apiFunds.held_by.length>0)
      displayLines.push("🏆 Quỹ: "+apiFunds.held_by.map(f=>f.fund+" "+f.weight.toFixed(2)+"%").join(" | "));

    // Tin tức — chỉ hiển thị nếu API có data, không hiện lỗi
    const newsBlock=(apiNews&&Array.isArray(apiNews)&&apiNews.length>0)?formatNews(symbol,apiNews):null;
    if(newsBlock) displayLines.push("─────────────────────────",newsBlock);

    sendMsg(chatId,displayLines.join("\n"));

    // Prompt AI với đầy đủ dữ liệu từ API
    const scoreCtx=apiScore?`Điểm: ${apiScore.score}/100 (${apiScore.rating}). Lý do: ${(apiScore.reasons||[]).slice(0,5).join("; ")}.`:"";
    const fundCtx=apiFunds&&apiFunds.held_by&&apiFunds.held_by.length>0?"Quỹ nắm giữ: "+apiFunds.held_by.map(f=>f.fund+" "+f.weight.toFixed(2)+"%").join(", ")+".":"Quỹ: không nắm giữ.";
    const newsCtx=apiNews&&apiNews.length>0?"Tin tức gần đây: "+apiNews.slice(0,3).map(n=>n.title||"").join("; ")+".":"";

    const prompt="Phân tích đầu tư tích sản dài hạn 10 năm cho cổ phiếu "+symbol+" (Ngành: "+indName+"):\n"+
      "Giá="+ind.cur.toFixed(2)+" SMA50="+ind.sma50.toFixed(2)+" tang1Y="+growth1y+"% tang6T="+growth6m+"%\n"+
      scoreCtx+"\n"+fundCtx+"\n"+newsCtx+"\n\n"+
      "Tìm kiếm tin tức mới nhất và trả lời:\n"+
      "1. Doanh nghiệp làm gì? Lợi thế cạnh tranh?\n"+
      "2. Cổ tức: Có đều đặn và tăng trưởng không?\n"+
      "3. Lợi nhuận/Doanh thu có tăng đều không?\n"+
      "4. P/E, P/B, ROE — đang rẻ hay đắt?\n"+
      "5. CÓ đáng tích sản 10 năm không?\n"+
      "6. Giá kỳ vọng: 3 năm / 5 năm / 10 năm\n"+
      "7. Chiến lược: Giá nào thì bắt đầu gom?\n\n"+
      "Nếu đáng: gợi ý /hold "+symbol+" [GIA] [SO_CO]\nTiếng Việt có dấu, ngắn gọn.";
    const aiText=callAI(prompt);
    sendLongMsg(chatId,"🤖 PHÂN TÍCH AI — TÍCH SẢN\n─────────────────────────\n"+(cleanAIText(aiText)||"AI đang bận."));
  }catch(e){sendMsg(chatId,"❌ Lỗi: "+e.message);}
}

// =====================================
// 🗑 /delete
// =====================================
function handleDelete(chatId,argStr) {
  if(!argStr){sendMsg(chatId,"Cú pháp: /delete VNM EIB\nBán vàng: /delete gold 0.5 103500");return;}
  const parts=argStr.trim().split(/[\s,]+/).map(s=>s.toUpperCase());
  // ── Xử lý bán vàng ──
  if((parts[0]==="GOLD"||parts[0]==="VÀNG")&&parts.length>=2){
    const qtyToSell=parseFloat(parts[1]),sellPriceInput=parts.length>=3?parseFloat(parts[2]):null;
    if(!isNaN(qtyToSell)&&qtyToSell>0){
      const g=getGoldPortfolio(chatId);
      if(g&&g.purchases&&g.purchases.length){
        let remaining=qtyToSell,costBasis=0;
        for(let i=0;i<g.purchases.length;i++){
          if(g.purchases[i].qty<=remaining){costBasis+=g.purchases[i].qty*(g.purchases[i].price*100);remaining-=g.purchases[i].qty;g.purchases[i].qty=0;}
          else{costBasis+=remaining*(g.purchases[i].price*100);g.purchases[i].qty-=remaining;remaining=0;break;}
        }
        g.purchases=g.purchases.filter(p=>p.qty>0.001);saveGoldPortfolio(chatId,g);
        let totalQty=0;g.purchases.forEach(p=>totalQty+=p.qty);
        const soldQty=qtyToSell-remaining;
        let msg="🗑 Đã bán "+soldQty+" chỉ vàng.\n";
        if(sellPriceInput&&!isNaN(sellPriceInput)){
          const revenue=soldQty*(sellPriceInput*100),pnl=revenue-costBasis;
          const pnlPct=costBasis>0?(pnl/costBasis*100):0;
          msg+="Lãi/Lỗ: "+(pnl>=0?"🟢":"🔴")+" "+(pnl>=0?"+":"")+pnl.toLocaleString("vi-VN")+" đ ("+(pnlPct>=0?"+":"")+pnlPct.toFixed(2)+"%)\n";
        }
        msg+="Còn lại: "+totalQty.toFixed(2)+" chỉ.";
        sendMsg(chatId,msg);
      }else{sendMsg(chatId,"❌ Bạn không có tài sản vàng để trừ.");}
      return;
    }
  }
  // ── Xử lý xóa mã cổ phiếu — thông minh chọn nơi xóa ──
  if(parts.length===1&&/^[A-Z]{2,4}$/.test(parts[0])){
    // Chỉ 1 mã → kiểm tra nằm ở đâu, nếu >1 nơi thì hỏi
    const sym=parts[0];
    const port=getPortfolio(chatId);const wl=getWatchlist(chatId);const hold=getHoldList(chatId);
    const locs=[];
    if(wl[sym])   locs.push({label:"👁 Watchlist (/stock)",  key:"wl"});
    if(port[sym]) locs.push({label:"📊 Danh mục ngắn hạn (/buy)",key:"port"});
    if(hold[sym]) locs.push({label:"🌱 Tích sản dài hạn (/hold)",key:"hold"});
    if(!locs.length){sendMsg(chatId,"❌ Không tìm thấy mã "+sym+" ở bất kỳ danh sách nào.");return;}
    if(locs.length===1){
      // Chỉ 1 nơi → xóa luôn
      _deleteSymFromLoc(chatId,sym,locs[0].key);
      sendMsg(chatId,"🗑 Đã xóa "+sym+" khỏi "+locs[0].label+".");
      return;
    }
    // Nhiều nơi → hiện keyboard chọn
    const buttons=locs.map(l=>[{text:l.label, callback_data:"deldst_"+sym+"_"+l.key}]);
    buttons.push([{text:"🗑 Xóa tất cả", callback_data:"deldst_"+sym+"_all"}]);
    buttons.push([{text:"❌ Huỷ",       callback_data:"deldst_"+sym+"_cancel"}]);
    sendMsgKeyboard(chatId,"🗑 <b>Xóa mã "+sym+"</b>\nMã này đang có ở "+locs.length+" nơi. Bạn muốn xóa ở đâu?",buttons);
    return;
  }
  // ── Nhiều mã → xóa hết ở mọi nơi (hành vi cũ) ──
  const results=[];
  parts.forEach(sym=>{
    if(!/^[A-Z]{2,4}$/.test(sym)){results.push(sym+": không hợp lệ");return;}
    const removed=[];
    const port=getPortfolio(chatId);if(port[sym]){delete port[sym];savePortfolio(chatId,port);removed.push("danh mục (/buy)");}
    const wl=getWatchlist(chatId);if(wl[sym]){delete wl[sym];saveWatchlist(chatId,wl);removed.push("watchlist (/stock)");}
    const hold=getHoldList(chatId);if(hold[sym]){delete hold[sym];saveHoldList(chatId,hold);removed.push("tích sản (/hold)");}
    results.push(sym+": "+(removed.length?removed.join(", "):"không tìm thấy ở đâu"));
  });
  sendMsg(chatId,"🗑 Kết quả xóa:\n"+results.join("\n"));
}

// Helper: gửi message có inline keyboard
function sendMsgKeyboard(chatId,text,buttons) {
  const payload={
    chat_id:chatId, text, parse_mode:"HTML",
    reply_markup: JSON.stringify({inline_keyboard:buttons})
  };
  try{
    UrlFetchApp.fetch(TELEGRAM_URL+"/sendMessage",{
      method:"post",contentType:"application/json",
      payload:JSON.stringify(payload),muteHttpExceptions:true
    });
  }catch(e){Logger.log("sendMsgKeyboard: "+e);}
}

// Helper: thực hiện xóa mã khỏi 1 location cụ thể
function _deleteSymFromLoc(chatId,sym,loc){
  if(loc==="wl"||loc==="all"){const wl=getWatchlist(chatId);if(wl[sym]){delete wl[sym];saveWatchlist(chatId,wl);}}
  if(loc==="port"||loc==="all"){const port=getPortfolio(chatId);if(port[sym]){delete port[sym];savePortfolio(chatId,port);}}
  if(loc==="hold"||loc==="all"){const hold=getHoldList(chatId);if(hold[sym]){delete hold[sym];saveHoldList(chatId,hold);}}
}

// =====================================
// 🥇 TÀI SẢN VÀNG
// =====================================
function getGoldPrice() {
  try{
    const response=UrlFetchApp.fetch('https://ngoctham.com/bang-gia-vang/',{headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'},muteHttpExceptions:true});
    const html=response.getContentText();
    const position=html.indexOf("Nhẫn 999.9");
    if(position===-1)return null;
    const snippet=html.substring(Math.max(0,position-100),Math.min(html.length,position+300));
    const match=snippet.match(/Nhẫn 999\.9[\s\S]*?<td[^>]*>([\d,.]+)<\/td>\s*<td[^>]*>([\d,.]+)<\/td>/);
    if(match)return{buy:parseInt(match[1].replace(/[\.,]/g,'')),sell:parseInt(match[2].replace(/[\.,]/g,''))};
  }catch(error){Logger.log("Lỗi getGoldPrice: "+error.message);}
  return null;
}
function getGoldPortfolio(chatId){try{const r=PropertiesService.getScriptProperties().getProperty("GOLD_"+chatId);return r?JSON.parse(r):{purchases:[]};}catch(e){return{purchases:[]};}}
function saveGoldPortfolio(chatId,gold){PropertiesService.getScriptProperties().setProperty("GOLD_"+chatId,JSON.stringify(gold));}
function handleGold(chatId,argStr) {
  if(!argStr){
    const goldList=getGoldPortfolio(chatId);
    if(!goldList.purchases||!goldList.purchases.length){sendMsg(chatId,"Chưa có tài sản vàng.\n\n👉 /gold 0.5 103500 — mua 0.5 chỉ với giá 103,500,000 đ/lượng");return;}
    PropertiesService.getScriptProperties().setProperty("GOLD_ANALYZE_CHAT_ID",chatId);
    deleteAllTriggers("analyzeGoldAsync");ScriptApp.newTrigger("analyzeGoldAsync").timeBased().after(100).create();
    return;
  }
  const parts=argStr.trim().split(/\s+/);
  if(parts.length>=2){
    const qty=parseFloat(parts[0]),price=parseFloat(parts[1]);
    if(isNaN(qty)||isNaN(price)||qty<=0||price<=0){sendMsg(chatId,"Sai định dạng. Ví dụ: /gold 0.5 103500");return;}
    const gold=getGoldPortfolio(chatId);if(!gold.purchases)gold.purchases=[];
    gold.purchases.push({qty,price,date:new Date().toLocaleDateString("vi-VN")});
    saveGoldPortfolio(chatId,gold);
    let totalQty=0,totalCost=0;gold.purchases.forEach(p=>{totalQty+=p.qty;totalCost+=p.qty*(p.price*100);});
    sendMsg(chatId,"✅ Ghi nhận mua VÀNG (lần "+gold.purchases.length+"):\nLần này: "+qty+" chỉ @ "+price+"\n─────────────────────────\nTổng: "+totalQty+" chỉ | Giá TB: "+(totalCost/totalQty).toLocaleString("vi-VN")+" đ/chỉ\nĐầu tư: "+totalCost.toLocaleString("vi-VN")+" đ");
  }else{sendMsg(chatId,"Cú pháp:\n/gold              — xem tài sản vàng\n/gold 0.5 103500   — mua 0.5 chỉ với giá 103,500,000 đ/lượng");}
}
function doGoldAnalysis(chatId){
  const goldList=getGoldPortfolio(chatId);if(!goldList.purchases||!goldList.purchases.length)return;
  const goldPrice=getGoldPrice();
  if(!goldPrice){sendMsg(chatId,"🏆 TÀI SẢN VÀNG: Lỗi không lấy được giá Ngọc Thẩm.");return;}
  let totalQty=0,totalCost=0;goldList.purchases.forEach(p=>{totalQty+=p.qty;totalCost+=p.qty*(p.price*100);});
  const avgPrice=totalCost/totalQty,currentPrice=goldPrice.buy;
  const pnlPct=(currentPrice-avgPrice)/avgPrice*100;
  const pnlStr=(pnlPct>=0?"+":"")+pnlPct.toFixed(2)+"%";
  const pnlVal=(currentPrice-avgPrice)*totalQty;
  const emoji=pnlPct>=10?"🟢":pnlPct>=0?"🟡":pnlPct>=-10?"🟠":"🔴";
  sendMsg(chatId,["🏆 TÀI SẢN VÀNG (Nhẫn 999.9 Ngọc Thẩm)","─────────────────────────",emoji+" Tổng: "+totalQty+" chỉ","   Giá mua     : "+totalCost.toLocaleString("vi-VN")+" đ","   Giá bán     : "+(currentPrice*totalQty).toLocaleString("vi-VN")+" đ","   Lãi/Lỗ      : "+pnlStr+" ("+(pnlPct>=0?"+":"")+pnlVal.toLocaleString("vi-VN")+" đ)"].join("\n"));
}
function analyzeGoldAsync(){
  deleteAllTriggers("analyzeGoldAsync");
  const props=PropertiesService.getScriptProperties();
  const chatId=props.getProperty("GOLD_ANALYZE_CHAT_ID");if(!chatId)return;
  props.deleteProperty("GOLD_ANALYZE_CHAT_ID");
  doGoldAnalysis(chatId);triggerNextInChain(chatId,"GOLD");
}

// =====================================
// 📊 QUÉT TOÀN THỊ TRƯỜNG (/scan)
// =====================================

// =====================================
// 🌍 LẤY DỮ LIỆU VĨ MÔ THẾ GIỚI
// USD Index, S&P500, Vàng TG, Dầu WTI
// =====================================
function fetchWorldMarket() {
  const result = {};
  // Yahoo Finance API (public, không cần key)
  const tickers = [
    {key:"sp500",   sym:"^GSPC"},
    {key:"dxy",     sym:"DX-Y.NYB"},
    {key:"gold_usd",sym:"GC=F"},
    {key:"oil_wti", sym:"CL=F"},
    {key:"nas100",  sym:"^NDX"}
  ];
  try {
    const reqs = tickers.map(t=>({
      url:"https://query1.finance.yahoo.com/v8/finance/chart/"+encodeURIComponent(t.sym)+"?interval=1d&range=2d",
      method:"get", muteHttpExceptions:true,
      headers:{"User-Agent":"Mozilla/5.0"}
    }));
    const responses = UrlFetchApp.fetchAll(reqs);
    responses.forEach((res,i)=>{
      try{
        if(res.getResponseCode()!==200)return;
        const json=JSON.parse(res.getContentText());
        const meta=json?.chart?.result?.[0]?.meta;
        if(!meta) return;
        const price=meta.regularMarketPrice;
        const prev=meta.chartPreviousClose||meta.previousClose;
        const chg=prev?(((price-prev)/prev)*100):0;
        result[tickers[i].key]={price, change:parseFloat(chg.toFixed(2))};
      }catch(e){}
    });
  }catch(e){ Logger.log("fetchWorldMarket: "+e); }
  return result;
}

// =====================================
// 📰 LẤY TIN TỨC RSS — CafeF + VnEconomy
// =====================================
function fetchNewsRSS() {
  const feeds = [
    {name:"CafeF",     url:"https://cafef.vn/thi-truong-chung-khoan.rss"},
    {name:"VnEconomy", url:"https://vneconomy.vn/chung-khoan.rss"},
    {name:"CafeF TT",  url:"https://cafef.vn/thi-truong.rss"}
  ];
  const allNews = [];
  const reqs = feeds.map(f=>({
    url:f.url, method:"get", muteHttpExceptions:true, timeout:10,
    headers:{"User-Agent":"Mozilla/5.0"}
  }));
  try {
    const responses = UrlFetchApp.fetchAll(reqs);
    responses.forEach((res,i)=>{
      try{
        if(res.getResponseCode()!==200)return;
        const xml=res.getContentText();
        // Parse title từ <item><title>...</title>
        const items=xml.match(/<item>[\s\S]*?<\/item>/g)||[];
        items.slice(0,5).forEach(item=>{
          const titleMatch=item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)||item.match(/<title>(.*?)<\/title>/);
          const dateMatch=item.match(/<pubDate>(.*?)<\/pubDate>/);
          if(titleMatch&&titleMatch[1]){
            allNews.push({
              title:titleMatch[1].trim(),
              source:feeds[i].name,
              date:dateMatch?dateMatch[1].substring(0,16):""
            });
          }
        });
      }catch(e){ Logger.log("RSS "+feeds[i].name+": "+e); }
    });
  }catch(e){ Logger.log("fetchNewsRSS: "+e); }
  return allNews;
}

// =====================================
// 📊 LẤY CHỈ SỐ VN TỪ API
// =====================================
function fetchVNMarketData() {
  const data = apiGet("/market", 15);
  if(!data) return null;
  const result = {};
  ["vnindex","vn30","hnx","upcom"].forEach(key=>{
    if(data[key]&&data[key].close!=null){
      result[key]={
        close:parseFloat(data[key].close).toFixed(2),
        change:data[key].change_pct!=null?parseFloat(data[key].change_pct).toFixed(2):null
      };
    }
  });
  return result;
}

// =====================================
// 🧠 PHÂN TÍCH VĨ MÔ TỔNG HỢP
// Gọi song song tất cả nguồn, trả về context string
// =====================================
function buildMarketContext() {
  // Gọi song song: world market + RSS + VN market
  const worldData = fetchWorldMarket();
  const rssNews   = fetchNewsRSS();
  const vnData    = fetchVNMarketData();

  const lines = [];

  // 1. Thị trường thế giới
  lines.push("=== THỊ TRƯỜNG THẾ GIỚI ===");
  if(worldData.sp500)  lines.push("S&P500  : "+worldData.sp500.price.toFixed(0)+" ("+(worldData.sp500.change>=0?"+":"")+worldData.sp500.change+"%)");
  if(worldData.nas100) lines.push("NASDAQ  : "+worldData.nas100.price.toFixed(0)+" ("+(worldData.nas100.change>=0?"+":"")+worldData.nas100.change+"%)");
  if(worldData.dxy)    lines.push("USD Idx : "+worldData.dxy.price.toFixed(2)+" ("+(worldData.dxy.change>=0?"+":"")+worldData.dxy.change+"%)");
  if(worldData.gold_usd)lines.push("Vàng TG : "+worldData.gold_usd.price.toFixed(0)+" USD/oz ("+(worldData.gold_usd.change>=0?"+":"")+worldData.gold_usd.change+"%)");
  if(worldData.oil_wti) lines.push("Dầu WTI : "+worldData.oil_wti.price.toFixed(2)+" USD/thùng ("+(worldData.oil_wti.change>=0?"+":"")+worldData.oil_wti.change+"%)");

  // 2. Thị trường VN
  lines.push("=== THỊ TRƯỜNG VIỆT NAM ===");
  if(vnData){
    if(vnData.vnindex) lines.push("VNINDEX : "+vnData.vnindex.close+(vnData.vnindex.change?" ("+(parseFloat(vnData.vnindex.change)>=0?"+":"")+vnData.vnindex.change+"%):":""));
    if(vnData.vn30)    lines.push("VN30    : "+vnData.vn30.close+(vnData.vn30.change?" ("+(parseFloat(vnData.vn30.change)>=0?"+":"")+vnData.vn30.change+"%)":""));
    if(vnData.hnx)     lines.push("HNX     : "+vnData.hnx.close);
    if(vnData.upcom)   lines.push("UPCOM   : "+vnData.upcom.close);
  } else {
    lines.push("(Không lấy được chỉ số VN)");
  }

  // 3. Tin tức trong nước
  if(rssNews.length>0){
    lines.push("=== TIN TỨC CHỨNG KHOÁN TRONG NƯỚC ===");
    rssNews.slice(0,8).forEach((n,i)=>{
      lines.push((i+1)+". ["+n.source+"] "+n.title);
    });
  }

  return lines.join("\n");
}

// Cache market context 30 phút để tránh gọi lại quá nhiều
function getMarketContext() {
  const props = PropertiesService.getScriptProperties();
  const CACHE_KEY = "MARKET_CTX";
  const CACHE_TS  = "MARKET_CTX_TS";
  const ts = props.getProperty(CACHE_TS);
  if(ts && (Date.now()-parseInt(ts)) < 30*60*1000) {
    const cached = props.getProperty(CACHE_KEY);
    if(cached) return cached;
  }
  const ctx = buildMarketContext();
  try{
    props.setProperty(CACHE_KEY, ctx);
    props.setProperty(CACHE_TS,  Date.now().toString());
  }catch(e){}
  return ctx;
}

function runDailyReport(targetChatId) {
  if(!targetChatId)return;
  const today=new Date().toLocaleDateString("vi-VN");
  const vnNow=new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Ho_Chi_Minh"}));
  const timeStr=vnNow.getHours().toString().padStart(2,"0")+":"+vnNow.getMinutes().toString().padStart(2,"0");

  let cached=getCachedTAData(today);
  if(!cached){
    // ── BƯỚC 1: Thu thập dữ liệu vĩ mô + tin tức song song ──────────
    sendMsg(targetChatId,"⏳ Đang thu thập dữ liệu thị trường trong nước & thế giới...");
    const marketCtx = getMarketContext();

    // Gửi bản tin vĩ mô ngay
    const macroLines=["📊 BỐI CẢNH THỊ TRƯỜNG — "+today+" "+timeStr,"━━━━━━━━━━━━━━━━━━━━━━━━━"];
    marketCtx.split("\n").forEach(line=>{
      if(line.startsWith("===")) macroLines.push("");
      macroLines.push(line.replace(/===/g,"").trim());
    });
    sendLongMsg(targetChatId,macroLines.join("\n"));

    // ── BƯỚC 2: AI nhận định vĩ mô + chọn mã DỰA TRÊN context ──────
    sendMsg(targetChatId,"🧠 AI đang phân tích macro và tìm mã tiềm năng...");
    const aiPickText=callAI(
      "Bạn là chuyên gia phân tích chứng khoán Việt Nam.\n\n"+
      "DỮ LIỆU THỊ TRƯỜNG HIỆN TẠI:\n"+marketCtx+"\n\n"+
      "Dựa trên bối cảnh macro trên, hãy:\n"+
      "1. Nhận định ngắn gọn xu hướng thị trường hôm nay (2-3 câu)\n"+
      "2. Xác định ngành/nhóm cổ phiếu được hưởng lợi nhất từ bối cảnh này\n"+
      "3. Chọn 20 mã cổ phiếu Việt Nam (HOSE/HNX/UPCOM) có tiềm năng nhất hôm nay,"+
      " kết hợp: tin tức hỗ trợ + ngành hưởng lợi + dòng tiền\n\n"+
      "QUAN TRỌNG: Cuối cùng CHỈ trả về JSON array 20 mã, ví dụ: [HPG,SSI,FPT]\n"+
      "Format:\nNHẬN ĐỊNH: [2-3 câu macro]\nNGÀNH HƯỞNG LỢI: [tên ngành]\nMÃ TIỀM NĂNG: [A,B,C,...]"
    );
    if(!aiPickText){sendMsg(targetChatId,"❌ AI đang bận.");markSent(targetChatId);return;}

    // Tách nhận định và danh sách mã
    let macroComment="";
    let industryNote="";
    const macroMatch=aiPickText.match(/NHẬN ĐỊNH[:\s]+([\s\S]+?)(?=NGÀNH|MÃ TIỀM NĂNG|\[)/i);
    if(macroMatch) macroComment=macroMatch[1].trim().substring(0,300);
    const industryMatch=aiPickText.match(/NGÀNH HƯỞNG LỢI[:\s]+([^\n]+)/i);
    if(industryMatch) industryNote=industryMatch[1].trim();

    // Lưu nhận định vĩ mô vào cache để dùng trong BẢN TIN VIP
    try{PropertiesService.getScriptProperties().setProperty("MACRO_COMMENT_"+today,macroComment);
       PropertiesService.getScriptProperties().setProperty("INDUSTRY_NOTE_"+today,industryNote);}catch(e){}

    let symbols=[];
    try{const match=aiPickText.match(/\[.*?\]/s);if(match)symbols=JSON.parse(match[0]);}catch(e){}
    if(!symbols.length){const m=aiPickText.match(/[A-Z]{3,4}/g);if(m)symbols=[...new Set(m)];}
    symbols=symbols.filter(s=>/^[A-Z]{3,4}$/.test(s)).slice(0,25);
    if(!symbols.length){sendMsg(targetChatId,"❌ Không thể trích xuất mã từ AI.");markSent(targetChatId);return;}
    const to=Math.floor(Date.now()/1000),from=to-60*24*60*60;
    const reqs=symbols.map(s=>({url:"https://services.entrade.com.vn/chart-api/v2/ohlcs/stock?from="+from+"&to="+to+"&symbol="+s+"&resolution=1D",method:"get",muteHttpExceptions:true}));
    let responses;try{responses=UrlFetchApp.fetchAll(reqs);}catch(e){sendMsg(targetChatId,"Lỗi lấy dữ liệu.");markSent(targetChatId);return;}
    const rtPrices=fetchRealtimePrices(symbols);
    const r={nentang:[],ma_cat:[],breakout:[],pullback:[],momentum:[],macd_cross:[],bb_squeeze:[],ai_picks:[]};
    const items=[];
    responses.forEach((res,j)=>{
      try{
        if(res.getResponseCode()!==200)return;
        const d=JSON.parse(res.getContentText());if(!d?.c||d.c.length<25)return;
        const sym=symbols[j];const ind=calcIndicators(d,rtPrices[sym]);
        const pc=ind.c[ind.n-2];
        const ep=calcEntryPoints(ind.cur,ind.sma20,ind.hi20,ind.lo20,ind.rsi,ind.atr);
        const ss=scoreSignal(ind,ep);
        items.push({sym,ind,pc,ep,ss});
      }catch(e){}
    });
    items.sort((a,b)=>b.ss.score-a.ss.score);
    items.forEach(item=>{
      const{sym,ind,pc,ep,ss}=item;
      const info=sym+": giá="+ind.cur.toFixed(2)+" KT="+ss.score+"/130 RSI="+ind.rsi.toFixed(0)+" "+ep.action+" Vào="+ep.entry+" TP1="+ep.tp1+" TP2="+ep.tp2+" SL="+ep.sl+" RR="+ep.rr+" | "+ss.signals;
      r.ai_picks.push("• "+info+" | "+ss.signals);
      if(ind.lo10>0&&(ind.hi10-ind.lo10)/ind.lo10<0.05&&ind.cur>=ind.sma20)r.nentang.push("• "+info);
      if(ind.sma5>ind.sma20&&ind.sma5p<=ind.sma20p&&ind.cur>ind.sma20)r.ma_cat.push("• "+info);
      if(ind.cur>=ind.hi20*0.99&&ind.lv>ind.avgV*1.5&&ind.cur>ind.sma20)r.breakout.push("• "+info);
      if(ind.sma20>ind.sma50&&ind.cur>ind.sma20&&pc<=ind.sma20p*1.01&&ind.cur>pc*1.01)r.pullback.push("• "+info);
      if(ind.rsi>=55&&ind.rsi<=75&&ind.cur>ind.sma20&&ind.sma20>ind.sma50)r.momentum.push("• "+info);
      if(ind.macd&&ind.macd.bullish&&ind.cur>ind.sma20)r.macd_cross.push("• "+info);
      if(ind.bb&&ind.bb.squeeze&&ind.cur>ind.sma20)r.bb_squeeze.push("• "+info);
    });
    cached=[];
    if(r.ai_picks.length)  cached.push("🤖 CÁC MÃ AI CHỌN TỪ TIN TỨC:",...r.ai_picks.slice(0,10));
    if(r.nentang.length)   cached.push("📦 NỀN TẢNG/VCP:",...r.nentang.slice(0,3));
    if(r.ma_cat.length)    cached.push("📈 MA CROSSOVER:",...r.ma_cat.slice(0,3));
    if(r.breakout.length)  cached.push("💥 BREAKOUT VOL:",...r.breakout.slice(0,3));
    if(r.pullback.length)  cached.push("🔄 PULLBACK SMA20:",...r.pullback.slice(0,3));
    if(r.momentum.length)  cached.push("🚀 MOMENTUM:",...r.momentum.slice(0,3));
    if(r.macd_cross.length)cached.push("📉 MACD CROSS:",...r.macd_cross.slice(0,3));
    saveTACacheData(today,cached);
  }
  const total=cached.filter(x=>x.startsWith("•")).length;
  if(!total){sendMsg(targetChatId,"⚠️ KHUYẾN NGHỊ: ĐỨNG NGOÀI\nKhông có tín hiệu mua hôm nay.");markSent(targetChatId);return;}
  sendMsg(targetChatId,"✅ Quét xong! "+total+" tín hiệu. Đang tổng hợp AI...");
  const today2=new Date().toLocaleDateString("vi-VN");
  const topItems=cached.filter(x=>x.startsWith("• ")).slice(0,8);
  const promptData=topItems.join("\n");

  // Lấy nhận định macro đã lưu từ bước trước
  const props2=PropertiesService.getScriptProperties();
  const macroCtx=props2.getProperty("MACRO_COMMENT_"+today2)||"";
  const industryCtx=props2.getProperty("INDUSTRY_NOTE_"+today2)||"";

  const aiFinalText=callAI(
    "Bạn là chuyên gia phân tích chứng khoán Việt Nam.\n\n"+
    (macroCtx?"BỐI CẢNH VĨ MÔ HÔM NAY: "+macroCtx+"\n":"") +
    (industryCtx?"NGÀNH HƯỞNG LỢI: "+industryCtx+"\n\n":"") +
    "CÁC MÃ ĐÃ LỌC KỸ THUẬT (KT=điểm/130, TP/SL đã tính sẵn — KHÔNG thay đổi):\n"+
    promptData+"\n\n"+
    "Nhiệm vụ:\n"+
    "1. Kết hợp bối cảnh vĩ mô + tín hiệu KT để chọn TOP 3 mã tốt nhất\n"+
    "2. Tìm tin tức mới nhất hỗ trợ từng mã được chọn\n"+
    "3. Chấm điểm tổng hợp (KT + Macro + Tin tức) cho từng mã\n"+
    "4. Trả lời theo FORMAT BẮT BUỘC:\n\n"+
    "╔══ BẢN TIN VIP — "+today2+" ══╗\n"+
    "📊 NHẬN ĐỊNH: [1 câu tóm tắt xu hướng dựa trên macro]\n"+
    (industryCtx?"🏭 NGÀNH DẪN DẮT: "+industryCtx+"\n":"")+
    "━━━━━━━━━━━━━━━━━━━━━━━━━\n"+
    "KHUYẾN NGHỊ: MUA / ĐỨNG NGOÀI\n\n"+
    "▶ MÃ 1: [TÊN]\n"+
    "  ⭐ KT: [X]/130 | 📰 Tin: Tích cực/Trung lập | 🎯 Tổng: [A]/10\n"+
    "  Điểm vào : [giá Vào từ dữ liệu]\n"+
    "  Chốt lời : TP1=[giá] | TP2=[giá]\n"+
    "  Cắt lỗ  : SL=[giá] | R:R=[X]\n"+
    "  Lý do   : [KT + macro + 1 câu tin tức cụ thể]\n\n"+
    "(lặp lại cho Mã 2, Mã 3)\n\n"+
    "⚠ RỦI RO HÔM NAY: [1 câu rủi ro chính cần chú ý]\n"+
    "╚══════════════════════════════╝\n\n"+
    "Tiếng Việt có dấu. Dùng đúng giá từ dữ liệu."
  );
  const topSignals=cached.filter(x=>x.startsWith("• ")).slice(0,3);
  const fallback="╔══ BẢN TIN VIP — "+today2+" ══╗\n"+(macroCtx?"📊 NHẬN ĐỊNH: "+macroCtx.substring(0,150)+"\n\n":"")+"KHUYẾN NGHỊ: XEM CHI TIẾT\n\n"+topSignals.join("\n")+"\n\n⚠ AI đang bận. Gõ tên mã để soi chi tiết.\n╚══════════════════════════════╝";
  sendLongMsg(targetChatId,cleanAIText(aiFinalText)||fallback);
  markSent(targetChatId);
}

// =====================================
// 🔍 SOI 1 MÃ ĐƠN — dùng /hold (API quan trọng nhất)
// + kỹ thuật + /news
// =====================================
function analyzeAndSend(chatId, symbol) {
  try{
    const now=Math.floor(Date.now()/1000);
    // Song song: OHLC + /hold + /news
    const allReqs=[
      {url:"https://services.entrade.com.vn/chart-api/v2/ohlcs/stock?from="+(now-150*24*60*60)+"&to="+now+"&symbol="+symbol+"&resolution=1D",method:"get",muteHttpExceptions:true},
      {url:API_BASE+"/hold/"+symbol,  method:"get",muteHttpExceptions:true,timeout:25},
      {url:API_BASE+"/news/"+symbol,  method:"get",muteHttpExceptions:true,timeout:15}
    ];
    const allRes=UrlFetchApp.fetchAll(allReqs);
    const parse=(r)=>{try{if(r.getResponseCode()===200)return JSON.parse(r.getContentText());}catch(e){}return null;};
    const ohlcData  = parse(allRes[0]);
    const holdData  = parse(allRes[1]);  // {price, quality, funds, company, recent_events}
    const newsData  = parse(allRes[2]);

    if(!ohlcData?.c||ohlcData.c.length<20){sendMsg(chatId,"❌ Không đủ dữ liệu "+symbol+".");return;}

    const rtPrices=fetchRealtimePrices([symbol]);
    const ind=calcIndicators(ohlcData,rtPrices[symbol]);
    const ep=calcEntryPoints(ind.cur,ind.sma20,ind.hi20,ind.lo20,ind.rsi,ind.atr);
    const ss=scoreSignal(ind,ep);
    const volTag=ind.lv>ind.avgV*1.5?"Mạnh ✅":ind.lv<ind.avgV*0.7?"Yếu ❌":"Bình thường";

    // Dữ liệu từ /hold
    const apiQ = holdData&&holdData.quality?holdData.quality:null;
    const apiFunds = holdData&&holdData.funds?holdData.funds:null;
    const apiScore = apiQ?apiQ.score:null;
    const apiRating = apiQ?apiQ.rating:"";
    const apiRec = apiQ?apiQ.recommendation:"";

    // Build header
    const fundLine = apiFunds&&apiFunds.held_by&&apiFunds.held_by.length>0
      ? "🏆 Quỹ: "+apiFunds.held_by.map(f=>f.fund+" "+f.weight.toFixed(2)+"%").join(" | ")+"\n"
      : "";
    const scoreLine = apiScore!=null
      ? "⭐ Chất lượng: "+apiScore+"/100 — "+apiRating+(apiRec?" — "+apiRec:"")+"\n"
      : "";
    const qualityBlock = (fundLine||scoreLine) ? "─────────────────────────\n"+fundLine+scoreLine : "";

    // ── Xác định icon hành động ──
    const actionIcon=ep.action==="MUA"?"🟢 ▶▶ MUA":ep.action==="CHỜ"?"🟡 ◷ CHỜ":ep.action==="ĐỨNG NGOÀI"?"🔴 ✖ ĐỨNG NGOÀI":"🟠 ◎ QUAN SÁT";
    const header =
      "╔══ "+symbol+" ══════════════════════════╗\n"+
      "  Giá: "+ind.cur.toFixed(2)+" | "+ind.trend+" | RSI: "+ind.rsi.toFixed(0)+" | KL: "+volTag+"\n"+
      "  KT: "+ss.score+"/130"+(apiScore?" | Chất lượng: "+apiScore+"/100 ("+apiRating+")":"")+
      "\n╚═══════════════════════════════════════╝\n"+
      qualityBlock+
      "┌─ KHUYẾN NGHỊ ─────────────────────────\n"+
      "│ "+actionIcon+"\n"+
      "│ Điểm vào  : "+ep.entry+"\n"+
      "│ TP1       : "+ep.tp1+"    TP2: "+ep.tp2+"\n"+
      "│ Cắt lỗ SL: "+ep.sl+"    R:R="+ep.rr+"\n"+
      (ind.bb?"│ BB        : "+ind.bb.lower+"—"+ind.bb.upper+" %B="+ind.bb.pctB+(ind.bb.squeeze?" ⚡":"")+"\n":"")+
      (ind.macd?"│ MACD      : "+(ind.macd.positive?"+":"−")+ind.macd.histogram+(ind.macd.bullish?" ↑CROSS":ind.macd.bearish?" ↓CROSS":"")+"\n":"")+
      (ss.signals?"│ Tín hiệu  : "+ss.signals+"\n":"")+
      "└───────────────────────────────────────";

    // Tin tức — nếu API rỗng thì AI sẽ tìm trong prompt, không hiện lỗi
    const newsBlock = (newsData&&Array.isArray(newsData)&&newsData.length>0) ? formatNews(symbol, newsData) : null;

    // Reasons từ API
    const reasonsLine = apiQ&&apiQ.reasons&&apiQ.reasons.length>0
      ? "\n✓ "+apiQ.reasons.slice(0,4).join(" | ")
      : "";

    sendLongMsg(chatId, header + reasonsLine + (newsBlock?"\n\n"+newsBlock:""));

    // Prompt AI
    const scoreCtx = apiScore!=null ? ` Điểm chất lượng: ${apiScore}/100 (${apiRating}).` : "";
    const fundCtx  = apiFunds&&apiFunds.held_by&&apiFunds.held_by.length>0?" Quỹ "+apiFunds.held_by.map(f=>f.fund).join(", ")+" nắm giữ.":"";
    const newsCtx  = newsData&&newsData.length>0?" Tin gần đây: "+newsData.slice(0,2).map(n=>n.title||"").filter(Boolean).join("; ")+".":"";

    const prompt="Cổ phiếu "+symbol+" — giá: "+ind.cur.toFixed(2)+"\nSMA20="+ind.sma20.toFixed(2)+" SMA50="+ind.sma50.toFixed(2)+" RSI="+ind.rsi.toFixed(1)+" KL="+volTag+" xu hướng="+ind.trend+"\nVào="+ep.entry+" TP1="+ep.tp1+" TP2="+ep.tp2+" SL="+ep.sl+scoreCtx+fundCtx+newsCtx+"\n\nTìm tin tức mới nhất về "+symbol+" và viết 2-3 câu:\n1. Lý do kỹ thuật + chất lượng DN + tin tức ủng hộ "+ep.action+"\n2. Rủi ro cần chú ý\nKHÔNG đưa ra TP/SL khác. Tiếng Việt có dấu, ngắn gọn.";
    const aiText=callAI(prompt);
    sendLongMsg(chatId,"\n🤖 "+( cleanAIText(aiText)||"Hỗ trợ: "+ind.lo20.toFixed(2)+" | Kháng cự: "+ind.hi20.toFixed(2)));
  }catch(e){sendMsg(chatId,"❌ Lỗi: "+e.message);}
}

// =====================================
// 🔥 SO SÁNH NHIỀU MÃ — dùng /hold + kỹ thuật
// =====================================
function compareSymbolsAsync() {
  deleteAllTriggers("compareSymbolsAsync");
  const props=PropertiesService.getScriptProperties();
  const chatId=props.getProperty("COMPARE_CHAT_ID");
  const symsRaw=props.getProperty("COMPARE_SYMBOLS");
  props.deleteProperty("COMPARE_CHAT_ID");props.deleteProperty("COMPARE_SYMBOLS");
  if(!chatId||!symsRaw)return;

  let syms;
  try{ syms=JSON.parse(symsRaw); }
  catch(e){ sendMsg(chatId,"❌ Lỗi đọc danh sách mã so sánh."); Logger.log("compareSymbolsAsync parse syms: "+e); return; }
  if(!Array.isArray(syms)||syms.length<2){ sendMsg(chatId,"❌ Cần ít nhất 2 mã để so sánh."); return; }

  let ohlcResponses;
  try{ ohlcResponses=fetchOHLC(syms,90); }
  catch(e){ sendMsg(chatId,"❌ Lỗi fetch dữ liệu kỹ thuật: "+e.message); Logger.log("compareSymbolsAsync fetchOHLC: "+e); return; }

  let holdResults;
  try {
    holdResults = [];
    syms.forEach(s => { holdResults.push(apiGet("/hold/"+s, 20)); Utilities.sleep(500); });
  } catch(e) { Logger.log("compareSymbolsAsync /hold: "+e); holdResults = syms.map(()=>null); }

  let rtPrices;
  try{ rtPrices=fetchRealtimePrices(syms); }
  catch(e){ Logger.log("compareSymbolsAsync fetchRealtimePrices: "+e); rtPrices={}; }

  const lines=["📊 SO SÁNH "+syms.length+" MÃ",new Date().toLocaleDateString("vi-VN"),"─────────────────────────"];
  const aiInputs=[];
  const results=[]; // ── lưu đầy đủ kết quả từng mã để dùng ở phần xếp hạng cuối ──

  ohlcResponses.forEach((res,idx)=>{
    const sym=syms[idx];
    const holdData=holdResults[idx];
    lines.push("");
    try{
      if(res.getResponseCode()!==200) throw new Error("HTTP "+res.getResponseCode());
      const d=JSON.parse(res.getContentText());
      if(!d||!d.c||d.c.length<20) throw new Error("Không đủ dữ liệu lịch sử giá");

      const ind=calcIndicators(d,rtPrices[sym]);
      const ep=calcEntryPoints(ind.cur,ind.sma20,ind.hi20,ind.lo20,ind.rsi,ind.atr);
      const ss=scoreSignal(ind,ep);
      const mom20=ind.mom20.toFixed(2);
      const trend=ind.cur>ind.sma20&&ind.sma20>ind.sma50?"TĂNG mạnh":ind.cur>ind.sma20?"TĂNG":ind.cur<ind.sma20&&ind.sma20<ind.sma50?"GIẢM mạnh":"GIẢM";
      const apiQ = (holdData&&holdData.quality) ? holdData.quality : null;
      const apiScore = apiQ ? (apiQ.score||0) : 0;
      const apiRating = apiQ ? (apiQ.rating||"") : "";

      results.push({sym, ind, ep, ss, trend, apiScore, apiRating, apiQ, holdData, success:true});

      lines.push(">> "+sym+" | Giá: "+ind.cur.toFixed(2)+" | "+trend);
      lines.push("   KT: "+ss.score+"/130"+(apiScore?" | Chất lượng: "+apiScore+"/100"+(apiRating?" ("+apiRating+")":""):""));
      lines.push("   RSI: "+ind.rsi.toFixed(0)+" | KL: "+ind.volTag+(ind.macd?" | MACD: "+(ind.macd.positive?"+":"−")+ind.macd.histogram:""));
      lines.push("   SMA20: "+ind.sma20.toFixed(2)+" | SMA50: "+ind.sma50.toFixed(2));
      lines.push("   Momentum 20p: "+(parseFloat(mom20)>=0?"+":"")+mom20+"%");
      if(ind.bb) lines.push("   BB: "+ind.bb.lower+"—"+ind.bb.upper+" | %B="+ind.bb.pctB+(ind.bb.squeeze?" ⚡SQUEEZE":""));
      lines.push("   ── "+ep.action+" ──");
      lines.push("   Vào: "+ep.entry+" | TP1: "+ep.tp1+" | TP2: "+ep.tp2+" | SL: "+ep.sl+" | R:R="+ep.rr);
      if(ss.signals) lines.push("   Tín hiệu: "+ss.signals);
      if(apiQ&&apiQ.recommendation) lines.push("   Khuyến nghị DN: "+apiQ.recommendation);
      if(holdData&&holdData.funds&&holdData.funds.held_by&&holdData.funds.held_by.length>0)
        lines.push("   🏆 "+holdData.funds.held_by.map(f=>f.fund+" "+f.weight.toFixed(2)+"%").join(" | "));

      aiInputs.push(sym+": giá="+ind.cur.toFixed(2)+" trend="+trend+" KT="+ss.score+" CL="+(apiScore||"N/A")+" action="+ep.action+" TP1="+ep.tp1+" SL="+ep.sl);
    }catch(err){
      Logger.log("compareSymbolsAsync "+sym+": "+err);
      lines.push("⚪ "+sym+" — Không lấy được dữ liệu ("+err.message+")");
      results.push({sym, success:false});
    }
  });

  // ── Xếp hạng tổng hợp KT + Chất lượng DN ──────────────────────
  const ranked=results
    .filter(r=>r.success)
    .map(r=>({sym:r.sym, ktScore:r.ss.score, apiScore:r.apiScore, trend:r.trend}))
    .sort((a,b)=>(b.apiScore+b.ktScore)-(a.apiScore+a.ktScore));

  if(ranked.length){
    lines.push("");
    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━");
    lines.push("🏆 XẾP HẠNG TỔNG HỢP");
    lines.push("(Kỹ thuật + Chất lượng DN)");
    ranked.forEach((s,i)=>{
      const medal=i===0?"🥇 ":i===1?"🥈 ":i===2?"🥉 ":"   #"+(i+1)+" ";
      const total=s.ktScore+s.apiScore;
      lines.push(medal+s.sym+" | Tổng: "+total+" (KT:"+s.ktScore+" + CL:"+s.apiScore+") | "+s.trend);
    });

    const best=ranked[0];
    const bestResult=results.find(r=>r.sym===best.sym&&r.success);
    if(bestResult&&bestResult.ep){
      lines.push("");
      lines.push("◆◆◆ ƯU TIÊN: "+best.sym+" ◆◆◆");
      lines.push("▶ "+bestResult.ep.action+" | Vào: "+bestResult.ep.entry+" | TP1: "+bestResult.ep.tp1+" | SL: "+bestResult.ep.sl+" | R:R="+bestResult.ep.rr);
    }
    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━");
  } else {
    lines.push("");
    lines.push("⚠ Không lấy được dữ liệu kỹ thuật cho mã nào. Kiểm tra lại mã đã nhập đúng chưa.");
  }

  sendLongMsg(chatId,lines.join("\n"));

  if(!aiInputs.length) return;
  const aiText=callAI("So sánh:\n"+aiInputs.join("\n")+"\n\nTP/SL đã tính sẵn, KHÔNG thay đổi.\nTìm tin tức mới nhất từng mã:\n1. Xếp hạng từ tốt đến kém (tổng hợp KT + chất lượng DN)\n2. Mã #1: giải thích tại sao, rủi ro\n3. Mã còn lại: 1 câu\nTiếng Việt có dấu, ngắn gọn.");
  sendLongMsg(chatId,"🤖 PHÂN TÍCH AI — SO SÁNH "+syms.join(" vs ")+"\n─────────────────────────\n"+(cleanAIText(aiText)||"AI đang bận."));
}

// =====================================
// 📰 [MỚI] /news — Tin tức cổ phiếu
// =====================================
function handleNews(chatId, symbol) {
  if(!symbol){sendMsg(chatId,"Cú pháp: /news FPT\nLấy tin tức mới nhất của 1 mã cổ phiếu.");return;}
  symbol=symbol.toUpperCase();
  sendMsg(chatId,"⏳ Đang lấy tin tức "+symbol+"...");

  // Thử lấy từ API trước
  const data = apiGet("/news/"+symbol, 15);
  const hasApiNews = data && Array.isArray(data) && data.length > 0;

  if(hasApiNews){
    // Hiển thị tin từ API
    const lines=["📰 TIN TỨC "+symbol+" (từ vnstock)","─────────────────────────"];
    data.slice(0,8).forEach((item,i)=>{
      const title=item.title||item.name||item.event||"";
      if(!title) return;
      const dt=item.date?item.date.substring(0,10):"";
      const src=item.source?" ["+item.source+"]":"";
      lines.push((i+1)+". "+title+(dt?" ("+dt+")":"")+src);
    });
    sendMsg(chatId,lines.join("\n"));
    // Luôn hỏi thêm AI để có nhận định
    const aiText=callAI("Dựa trên tin tức cổ phiếu "+symbol+", hãy tìm thêm tin tức mới nhất và đưa ra nhận định ngắn gọn: Tích cực / Tiêu cực / Trung lập và lý do 1-2 câu. Tiếng Việt có dấu.");
    if(aiText) sendMsg(chatId,"🤖 Nhận định AI: "+( cleanAIText(aiText)||""));
  } else {
    // API không có tin → dùng AI trực tiếp, không hiện thông báo lỗi API
    sendMsg(chatId,"📰 TIN TỨC "+symbol+"\n─────────────────────────");
    const aiText=callAI(
      "Tìm kiếm tin tức mới nhất về cổ phiếu "+symbol+" trên sàn chứng khoán Việt Nam.\n"+
      "Trả lời theo format:\n"+
      "1. [Tiêu đề tin] — [1 câu tóm tắt]\n"+
      "2. [Tiêu đề tin] — [1 câu tóm tắt]\n"+
      "(liệt kê 5 tin quan trọng nhất)\n\n"+
      "Cuối cùng: Nhận định tổng: Tích cực / Tiêu cực / Trung lập và lý do.\n"+
      "Tiếng Việt có dấu, ngắn gọn."
    );
    sendMsg(chatId,cleanAIText(aiText)||"Không tìm được tin tức cho "+symbol+" lúc này.");
  }
}

// =====================================
// 🏆 [MỚI] /recommend — Gợi ý từ quỹ
// =====================================
function handleRecommend(chatId) {
  sendMsg(chatId,"⏳ Đang lấy gợi ý từ API (DCDS + DCDE + DCBF)...");
  PropertiesService.getScriptProperties().setProperty("RECOMMEND_CHAT_ID",chatId);
  deleteAllTriggers("recommendAsync");
  ScriptApp.newTrigger("recommendAsync").timeBased().after(100).create();
}

function recommendAsync() {
  deleteAllTriggers("recommendAsync");
  const props=PropertiesService.getScriptProperties();
  const chatId=props.getProperty("RECOMMEND_CHAT_ID")||ADMIN_CHAT_ID;
  props.deleteProperty("RECOMMEND_CHAT_ID");

  Logger.log("recommendAsync: gọi /fund-favorites");
  const favData = apiGet("/fund-favorites", 60);
  let symbols = [];
  const seen = {};
  let anyStale = false;

  if(favData && typeof favData === "object") {
    Object.values(favData).forEach(holdings=>{
      if(!Array.isArray(holdings)) return;
      holdings.forEach(h=>{
        if(h && h.stale) anyStale = true;
        const sym = (h.stock_code||h.symbol||h.ticker||"").toUpperCase();
        if(sym && /^[A-Z]{2,4}$/.test(sym) && !seen[sym]) {
          seen[sym] = true;
          symbols.push(sym);
        }
      });
    });
  }

  if(!symbols.length) {
    if(favData && typeof favData === "object") {
      // Backend đã phản hồi hợp lệ nhưng không có mã nào — nghĩa là cả 4 lớp fallback
      // fund-holdings ở backend (vnstock → fmarket trực tiếp → cache cũ → snapshot tĩnh)
      // đều không có dữ liệu. Khác hẳn với lỗi kết nối/server bên dưới.
      sendMsg(chatId, "❌ Quỹ DCDS/DCDE hiện không có dữ liệu holdings nào (đã thử tất cả nguồn dự phòng ở backend). Có thể fmarket.vn gián đoạn kéo dài hoặc snapshot dự phòng chưa được cập nhật. Vui lòng thử lại sau hoặc kiểm tra log backend.");
    } else {
      // apiGet không trả được kết quả gì — lỗi mạng/server thật sự (timeout, 500, đang khởi động...)
      sendMsg(chatId, "❌ Không kết nối được tới server để lấy dữ liệu quỹ. Server có thể đang bận hoặc khởi động. Vui lòng thử lại sau 1-2 phút.");
    }
    return;
  }

  if(anyStale) {
    sendMsg(chatId, "⚠️ Lưu ý: một phần dữ liệu quỹ đang dùng bản lưu tạm (fmarket.vn có thể đang gián đoạn), kết quả bên dưới có thể không phải mới nhất.");
  }

  // Chọn tối đa 12 mã để quét tuần tự (tránh OOM server)
  symbols = symbols.slice(0, 12);
  sendMsg(chatId, "⏳ Đang chấm điểm " + symbols.length + " mã từ quỹ (xử lý tuần tự để bảo vệ server)...");

  let finalList = [];
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    try {
      // Dùng tuần tự với timeout 20s cho từng mã.
      // Pandas xử lý song song trên RAM 512MB sẽ gây sập server (503 Service Unavailable).
      const res = apiGet("/score/" + sym, 20);
      if(!res || typeof res !== "object" || res.score == null || res.success === false) continue;
      finalList.push({
        symbol: sym,
        score:  res.score  || 0,
        rating: res.rating || "N/A",
        recommendation: res.score>=85?"Tích sản dài hạn":res.score>=65?"Theo dõi thêm":"Quan sát"
      });
    } catch(e) { Logger.log("recommendAsync score "+sym+": "+e); }
    Utilities.sleep(500); // Ngừng 0.5s giữa các request để server giải phóng RAM
  }

  finalList.sort((a,b) => b.score - a.score);

  if(!finalList.length) {
    sendMsg(chatId, "❌ Không lấy được dữ liệu điểm chi tiết. Vui lòng thử lại.");
    return;
  }

  // ── Hiển thị kết quả ──────────────────────────────────────────
  const today = new Date().toLocaleDateString("vi-VN");
  const lines = ["🏆 GỢI Ý ĐẦU TƯ TỪ QUỸ (DCDS/DCDE)", "📅 " + today, "─────────────────────────"];
  finalList.slice(0,10).forEach((item, i) => {
    const s = item.score || 0;
    const emoji = s>=85?"🟢":s>=65?"🟡":s>=40?"🟠":"🔴";
    lines.push((i+1) + ". " + emoji + " " + (item.symbol||item.sym) + " | " + s + "/100 — " + (item.rating||""));
    if(item.recommendation) lines.push("   → " + item.recommendation);
  });
  lines.push("");
  lines.push("💡 Gõ tên mã (VD: FPT) để xem phân tích chi tiết.");
  sendMsg(chatId, lines.join("\n"));

  // AI nhận xét top 5
  const top5 = finalList.slice(0,5).map(r => (r.symbol||r.sym) + "(" + (r.score||0) + "/100)").join(", ");
  const aiText = callAI(
    "Top cổ phiếu được quỹ DCDS/DCDE nắm giữ và điểm chất lượng cao: " + top5 + "\n\n" +
    "Tìm tin tức mới nhất về từng mã, với mỗi mã viết:\n" +
    "• 1 câu lý do nên theo dõi (catalyst, tin tức tốt)\n" +
    "• 1 câu rủi ro cần chú ý\n" +
    "Tiếng Việt có dấu, ngắn gọn."
  );
  if(aiText) sendLongMsg(chatId, "🤖 NHẬN XÉT AI\n─────────────────────────\n" + cleanAIText(aiText));
}

// =====================================
// 📨 NHẬN LỆNH TELEGRAM
// =====================================
// =====================================
// 🔔 XỬ LÝ CALLBACK INLINE KEYBOARD
// =====================================
function handleCb(chatId, callbackQueryId, data) {
  // Trả lời callback ngay để Telegram không hiện loading
  try {
    UrlFetchApp.fetch(TELEGRAM_URL + "/answerCallbackQuery", {
      method: "post", contentType: "application/json",
      payload: JSON.stringify({ callback_query_id: callbackQueryId }),
      muteHttpExceptions: true
    });
  } catch(e) { Logger.log("answerCallbackQuery: " + e); }

  // Pattern: deldst_SYM_loc  (loc = wl | port | hold | all | cancel)
  const m = data.match(/^deldst_([A-Z]{2,4})_(.+)$/);
  if (!m) return;
  const sym = m[1], loc = m[2];

  if (loc === "cancel") {
    sendMsg(chatId, "❌ Đã huỷ xóa " + sym + ".");
    return;
  }

  // Thực hiện xóa
  _deleteSymFromLoc(chatId, sym, loc);

  const locLabel = {
    wl:   "👁 Watchlist (/stock)",
    port: "📊 Danh mục ngắn hạn (/buy)",
    hold: "🌱 Tích sản dài hạn (/hold)",
    all:  "tất cả danh sách"
  };
  sendMsg(chatId, "🗑 Đã xóa " + sym + " khỏi " + (locLabel[loc] || loc) + ".");
}

function doPost(e) {
  try{
    const update=JSON.parse(e.postData.contents);

    // ── Xử lý callback_query (bấm nút inline keyboard) ──
    if (update.callback_query) {
      const cb = update.callback_query;
      const cbChatId = cb.message.chat.id.toString();
      handleCb(cbChatId, cb.id, cb.data || "");
      return HtmlService.createHtmlOutput("OK");
    }

    if(!update.message?.text)return HtmlService.createHtmlOutput("OK");
    const chatId=update.message.chat.id.toString();
    const text=update.message.text.trim();
    const up=text.toUpperCase();
    const arg=text.includes(" ")?text.substring(text.indexOf(" ")+1).trim():"";
    const upArg=arg.toUpperCase().trim();

    if(up==="/START"){
      sendMsg(chatId,
        "🤖 BOT CỔ PHIẾU V4\n\n"+
        "━━━ PHÂN TÍCH & QUÉT ━━━\n"+
        "/scan              — Bản tin VIP buổi sáng + phân tích danh mục/tích sản/watchlist\n"+
        "VNM                — Soi 1 mã: kỹ thuật + chất lượng DN + tin tức\n"+
        "VIX SHS VND        — So sánh 2-5 mã (KT + chất lượng)\n"+
        "/recommend         — Top 10 cổ phiếu quỹ đang nắm giữ\n"+
        "/market            — Chỉ số VNINDEX, VN30, HNX, UPCOM\n"+
        "/news FPT          — Tin tức mới nhất của 1 mã\n\n"+
        "━━━ QUẢN LÝ DANH SÁCH ━━━\n"+
        "/buy HAG 15.2 500  — Thêm mã ngắn hạn (giá mua, khối lượng)\n"+
        "/stock HAG         — Thêm mã vào watchlist\n"+
        "/hold VNM 65.70 1000 — Ghi nhận mua tích sản (tự tính giá TB)\n"+
        "/hold              — Xem tích sản + AI phân tích (tự quét nếu danh sách trống)\n"+
        "/hold VNM HAG VCB  — So sánh 2-5 mã tích sản, chọn mã tốt nhất\n"+
        "/hold VNM HAG VCB 1tr — Phân bổ vốn (1 triệu) theo điểm chất lượng\n"+
        "/gold 0.5 103500   — Mua 0.5 chỉ vàng giá 103tr5/lượng\n"+
        "/delete VNM EIB    — Xóa mã khỏi danh sách\n"+
        "/delete gold 0.5 103500 — Bán vàng, tính lãi/lỗ\n"+
        "/noti HAG 15       — Cảnh báo khi giá HAG chạm/vượt 15\n"+
        "/noti              — Xem cảnh báo đang bật\n"+
        "/noti del HAG      — Xóa cảnh báo HAG\n\n"+
        "━━━ TIỆN ÍCH ━━━\n"+
        "/set1 8h30         — Sáng: BẢN TIN VIP + quét TT + danh mục (T2-T6)\n"+
        "/set2 15h30        — Chiều: chỉ phân tích danh mục/tích sản/watchlist (T2-T6)\n"+
        "/setgold 10h00     — Lịch báo giá vàng hàng ngày\n"+
        "/myschedule        — Xem lịch báo cáo tự động\n"+
        "/aistatus          — Trạng thái AI (DeepSeek qua ds2api)\n"+
        "/resetcache        — (Không còn cần thiết — ds2api tự xoay vòng)\n"+
        "/forcescan         — Reset lock khi /scan bị treo\n"+
        "/inittrigger       — Tạo lại trigger lịch khi bị mất"
      );
    }

    else if(up==="/MARKET")                   {handleMarket(chatId);}
    else if(up.startsWith("/NEWS "))           {handleNews(chatId,upArg);}
    else if(up==="/NEWS")                      {handleNews(chatId,"");}
    else if(up==="/RECOMMEND")                 {handleRecommend(chatId);}
    else if(up.startsWith("/BUY "))            {handleBuy(chatId,arg);}
    else if(up==="/BUY")                       {sendMsg(chatId,"Cú pháp: /buy HAG 15.2 500");}
    else if(up.startsWith("/STOCK "))          {handleStock(chatId,arg);}
    else if(up==="/STOCK")                     {sendMsg(chatId,"Cú pháp: /stock HAG");}
    else if(up==="/HOLD"||up.startsWith("/HOLD ")) {handleHold(chatId,arg||"");}
    else if(up==="/GOLD"||up.startsWith("/GOLD ")) {handleGold(chatId,arg||"");}
    else if(up==="/NOTI"||up.startsWith("/NOTI ")) {handleNoti(chatId,arg||"");}
    else if(up==="/DELETE"||up.startsWith("/DELETE ")) {handleDelete(chatId,arg);}

    else if(up==="/MYSCHEDULE"){
      const props=PropertiesService.getScriptProperties();
      const s1=props.getProperty("SCHEDULE1_"+chatId),s2=props.getProperty("SCHEDULE2_"+chatId),sg=props.getProperty("SCHEDULE_GOLD_"+chatId);
      sendMsg(chatId,"📅 Lịch báo cáo tự động (T2-T6):\n"+
      "  Sáng (/set1): "+(s1||"Chưa đặt — gõ /set1 8h30")+"\n"+
      "  → BẢN TIN VIP + Quét TT + Danh mục\n"+
      "  Chiều (/set2): "+(s2||"Chưa đặt — gõ /set2 15h30")+"\n"+
      "  → Chỉ phân tích Danh mục/Tích sản/Watchlist\n\n"+
      "🥇 Lịch báo giá vàng:\n  "+(sg||"Chưa đặt — /setgold 10h00"));
    }
    else if(up.startsWith("/SET1 "))    {handleSetSchedule(chatId,"1",arg);}
    else if(up.startsWith("/SET2 "))    {handleSetSchedule(chatId,"2",arg);}
    else if(up==="/SET1"||up==="/SET2") {sendMsg(chatId,"Cú pháp:\n/set1 8h30   — Lịch buổi sáng\n/set2 15h30  — Lịch buổi chiều");}
    else if(up.startsWith("/SETGOLD ")) {handleSetGoldSchedule(chatId,arg);}
    else if(up==="/SETGOLD")            {sendMsg(chatId,"Cú pháp: /setgold 10h00");}
    else if(up==="/AISTATUS")           {handleAIStatus(chatId);}
    else if(up==="/INITTRIGGER")        {handleInitTriggerCmd(chatId);}
    else if(up==="/RESETCACHE"){
      sendMsg(chatId,"ℹ️ Không cần reset thủ công nữa — AI hiện dùng DeepSeek qua ds2api, ds2api tự động xoay vòng tài khoản khi có lỗi/hết quota.\n👉 /aistatus để xem trạng thái hiện tại.");
    }
    else if(up==="/SCAN"||up==="/FORCESCAN"){
      const props=PropertiesService.getScriptProperties();
      if(up==="/FORCESCAN"){props.deleteProperty("LOCK_SCAN");props.deleteProperty("LOCK_SCAN_TS");props.deleteProperty("LAST_SENT_"+chatId);sendMsg(chatId,"🔄 Đã reset lock.");}
      else{
        const lockTs=props.getProperty("LOCK_SCAN_TS");
        if(lockTs&&(Date.now()-parseInt(lockTs))>7*60*1000){props.deleteProperty("LOCK_SCAN");props.deleteProperty("LOCK_SCAN_TS");}
        if(props.getProperty("LOCK_SCAN")==="true"){sendMsg(chatId,"⏳ Đang quét dở...\n/forcescan để reset nếu treo quá 7 phút.");return HtmlService.createHtmlOutput("OK");}
        sendMsg(chatId,"⏳ Đang kích hoạt quét...");
      }
      props.setProperty("SCAN_CHAT_ID",chatId);props.deleteProperty("LAST_SENT_"+chatId);
      deleteAllTriggers("runScanAsync");ScriptApp.newTrigger("runScanAsync").timeBased().after(100).create();
    }

    // Gõ nhiều mã: "VIX SHS VND"
    else if(/^[A-Z]{2,4}(\s+[A-Z]{2,4}){1,4}$/.test(up)){
      const syms=up.trim().split(/\s+/).filter(s=>/^[A-Z]{2,4}$/.test(s));
      sendMsg(chatId,"⏳ Đang so sánh "+syms.length+" mã: "+syms.join(", ")+"...");
      PropertiesService.getScriptProperties().setProperty("COMPARE_CHAT_ID",chatId);
      PropertiesService.getScriptProperties().setProperty("COMPARE_SYMBOLS",JSON.stringify(syms));
      deleteAllTriggers("compareSymbolsAsync");
      ScriptApp.newTrigger("compareSymbolsAsync").timeBased().after(100).create();
    }

    // Gõ 1 mã đơn
    else if(/^[A-Z]{2,4}$/.test(up)){
      sendMsg(chatId,"⏳ Đang soi mã "+up+"...");
      PropertiesService.getScriptProperties().setProperty("SINGLE_CHAT_ID",chatId);
      PropertiesService.getScriptProperties().setProperty("SINGLE_SYMBOL",up);
      deleteAllTriggers("analyzeSingleSymbolAsync");
      ScriptApp.newTrigger("analyzeSingleSymbolAsync").timeBased().after(100).create();
    }

    else{
      sendMsg(chatId,"❌ Lệnh không hợp lệ.\n\n💡 Gợi ý:\n• /scan — Quét toàn thị trường\n• VNM — Soi 1 mã\n• VIX SHS — So sánh 2-5 mã\n• /recommend — Gợi ý từ quỹ\n• /market — Chỉ số thị trường\n\n👉 /start để xem toàn bộ lệnh.");
    }
  }catch(err){Logger.log("doPost: "+err);}
  return HtmlService.createHtmlOutput("OK");
}

// =====================================
// 📊 AI STATUS
// =====================================
function handleAIStatus(chatId) {
  const keyOk  = DS2API_KEY && !DS2API_KEY.startsWith('PASTE_');
  const urlOk  = DS2API_BASE_URL && !DS2API_BASE_URL.startsWith('PASTE_');
  const ok = keyOk && urlOk;
  let msg="🤖 Trạng thái AI\nProvider: DeepSeek (qua ds2api)\n─────────────────────────\n";
  msg+=(ok?"🟢":"🔴")+" Model: "+DS2API_MODEL+"\n";
  msg+="Endpoint: "+(urlOk?DS2API_BASE_URL:"⚠️ chưa cấu hình DS2API_BASE_URL")+"\n";
  msg+="Key: "+(keyOk?"✅ đã cấu hình":"⚠️ chưa cấu hình DS2API_KEY")+"\n";
  msg+="\nds2api tự động xoay vòng nhiều tài khoản DeepSeek — bot không cần fallback thủ công.";
  sendMsg(chatId,msg);
}

// =====================================
// ⏰ LỊCH TỰ ĐỘNG
// =====================================
function handleSetSchedule(chatId,slot,timeStr) {
  timeStr=timeStr.replace(/\s/g,"").replace(":","h");
  const m=timeStr.match(/^(\d{1,2})[hH](\d{0,2})$/);
  if(!m){sendMsg(chatId,"Sai định dạng. Ví dụ: /set"+slot+" 8h30");return;}
  const h=parseInt(m[1]),min=m[2]?parseInt(m[2].padEnd(2,"0")):0;
  if(h>23||min>59){sendMsg(chatId,"Giờ không hợp lệ.");return;}
  const t=h.toString().padStart(2,"0")+":"+min.toString().padStart(2,"0");
  const props=PropertiesService.getScriptProperties();
  props.setProperty("SCHEDULE"+slot+"_"+chatId,t);
  const s1=props.getProperty("SCHEDULE1_"+chatId),s2=props.getProperty("SCHEDULE2_"+chatId);
  const desc1=slot==="1"?"\n→ Sáng: BẢN TIN VIP + Quét thị trường + Phân tích danh mục":"\n→ Chiều: Chỉ phân tích Danh mục/Tích sản/Watchlist (không BẢN TIN VIP)";
  sendMsg(chatId,"✅ Đã đặt lịch "+slot+" lúc "+t+" (T2-T6)"+desc1+"\n─────────────────────────\nLần 1 (sáng): "+(s1||"Chưa đặt")+"\nLần 2 (chiều): "+(s2||"Chưa đặt"));
  ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()==="checkSchedules").forEach(t=>ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("checkSchedules").timeBased().everyMinutes(5).create();
}
function handleSetGoldSchedule(chatId,timeStr) {
  timeStr=timeStr.replace(/\s/g,"").replace(":","h");
  const m=timeStr.match(/^(\d{1,2})[hH](\d{0,2})$/);
  if(!m){sendMsg(chatId,"Sai định dạng. Ví dụ: /setgold 10h00");return;}
  const h=parseInt(m[1]),min=m[2]?parseInt(m[2].padEnd(2,"0")):0;
  if(h>23||min>59){sendMsg(chatId,"Giờ không hợp lệ.");return;}
  const t=h.toString().padStart(2,"0")+":"+min.toString().padStart(2,"0");
  PropertiesService.getScriptProperties().setProperty("SCHEDULE_GOLD_"+chatId,t);
  sendMsg(chatId,"✅ Đã đặt lịch báo giá vàng lúc "+t+" (Hàng ngày)");
  ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()==="checkSchedules").forEach(t=>ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("checkSchedules").timeBased().everyMinutes(5).create();
}
function checkSchedules() {
  const now=new Date();
  const vnTime=new Date(now.toLocaleString("en-US",{timeZone:"Asia/Ho_Chi_Minh"}));
  const curMin=vnTime.getHours()*60+vnTime.getMinutes();
  Logger.log("checkSchedules VN: "+vnTime.getHours().toString().padStart(2,"0")+":"+vnTime.getMinutes().toString().padStart(2,"0"));
  const propsAll=PropertiesService.getScriptProperties().getProperties();
  // Báo giá vàng hàng ngày
  for(const key of Object.keys(propsAll)){
    if(!key.startsWith("SCHEDULE_GOLD_"))continue;
    const chatId=key.replace("SCHEDULE_GOLD_","");
    const parts=propsAll[key].split(":");if(parts.length<2)continue;
    const schedMin=parseInt(parts[0])*60+parseInt(parts[1]);
    if(Math.abs(curMin-schedMin)>2)continue;
    const sentKey="GOLD_DAILY_PRICE_"+chatId;
    const lastSent=propsAll["LAST_SENT_"+sentKey];
    if(lastSent&&(Date.now()-parseInt(lastSent))<12*60*60*1000)continue;
    markSent(sentKey);
    try{const gp=getGoldPrice();if(gp)sendMsg(chatId,"🏆 GIÁ VÀNG HÔM NAY (Nhẫn 999.9 Ngọc Thẩm)\n─────────────────────────\nMua vào: "+gp.buy.toLocaleString("vi-VN")+" đ/chỉ\nBán ra : "+gp.sell.toLocaleString("vi-VN")+" đ/chỉ");}
    catch(e){Logger.log("gold price daily: "+e);}
  }
  if(vnTime.getDay()===0||vnTime.getDay()===6)return;

  // ── Cảnh báo giá /noti — chạy trong trigger checkSchedules có sẵn (mỗi 5 phút) ──
  const alertChatIds=new Set();
  for(const key of Object.keys(propsAll)){
    if(key.startsWith("ALERT_")) alertChatIds.add(key.replace("ALERT_",""));
  }
  alertChatIds.forEach(cid=>{
    const alerts=getAlerts(cid);
    const syms=Object.keys(alerts);
    if(!syms.length)return;
    let prices;
    try{ prices=fetchRealtimePrices(syms); }catch(e){ Logger.log("checkSchedules alert prices "+cid+": "+e); return; }
    let changed=false;
    syms.forEach(sym=>{
      const cur=prices[sym];
      if(cur==null)return;
      const a=alerts[sym];
      if(a.lastPrice==null){
        a.lastPrice=cur; changed=true; return;
      }
      const crossedUp=a.lastPrice<a.target&&cur>=a.target;
      const crossedDown=a.lastPrice>a.target&&cur<=a.target;
      if(crossedUp||crossedDown){
        sendMsg(cid,"🔔 CẢNH BÁO GIÁ\n"+sym+" đã chạm mốc "+a.target+" (giá hiện tại: "+cur+")");
        delete alerts[sym]; changed=true;
      } else if(cur!==a.lastPrice){
        a.lastPrice=cur; changed=true;
      }
    });
    if(changed) saveAlerts(cid,alerts);
  });

  const props=PropertiesService.getScriptProperties().getProperties();
  for(const key of Object.keys(props)){
    const match=key.match(/^SCHEDULE([12])_(.+)$/);if(!match)continue;
    const slot=match[1],chatId=match[2];
    const parts=props[key].split(":");if(parts.length<2)continue;
    const schedMin=parseInt(parts[0])*60+parseInt(parts[1]);
    if(Math.abs(curMin-schedMin)>2)continue;
    const sentKey="SCH"+slot+"_"+chatId;
    if(recentlySent(sentKey))continue;
    markSent(sentKey);
    if(slot==="1"){
      // ── BUỔI SÁNG: BẢN TIN VIP + quét TT đầy đủ + danh mục
      Logger.log("Schedule SÁNG cho "+chatId);
      try{runDailyReport(chatId);}catch(e){Logger.log("schedule sáng scan: "+e);}
      Utilities.sleep(3000);
      triggerNextInChain(chatId,"START");
    } else {
      // ── BUỔI CHIỀU: chỉ phân tích danh mục/tích sản/watchlist, KHÔNG BẢN TIN VIP
      Logger.log("Schedule CHIỀU cho "+chatId);
      sendMsg(chatId,"📊 BÁO CÁO CHIỀU — "+new Date().toLocaleDateString("vi-VN")+"\nĐang phân tích danh mục, tích sản và watchlist của bạn...");
      Utilities.sleep(1000);
      triggerNextInChain(chatId,"START");
    }
  }
}

// =====================================
// 🔧 TRIGGER & LOCK
// =====================================
function deleteAllTriggers(fn){ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()===fn).forEach(t=>ScriptApp.deleteTrigger(t));}
function recentlySent(id){const v=PropertiesService.getScriptProperties().getProperty("LAST_SENT_"+id);return v&&(Date.now()-parseInt(v))<12*60*60*1000;}
function markSent(id){PropertiesService.getScriptProperties().setProperty("LAST_SENT_"+id,Date.now().toString());}

function runScanAsync() {
  deleteAllTriggers("runScanAsync");
  const props=PropertiesService.getScriptProperties();
  const chatId=props.getProperty("SCAN_CHAT_ID")||ADMIN_CHAT_ID;
  props.deleteProperty("SCAN_CHAT_ID");
  const lockTs=props.getProperty("LOCK_SCAN_TS");
  const isLocked=props.getProperty("LOCK_SCAN")==="true"&&lockTs&&(Date.now()-parseInt(lockTs))<7*60*1000;
  if(isLocked){sendMsg(chatId,"⏳ Đang quét, vui lòng chờ...");return;}
  props.setProperty("LOCK_SCAN","true");props.setProperty("LOCK_SCAN_TS",Date.now().toString());
  try{runDailyReport(chatId);}
  catch(e){Logger.log("runScanAsync: "+e);sendMsg(chatId,"❌ Lỗi scan: "+e.message);}
  finally{props.deleteProperty("LOCK_SCAN");props.deleteProperty("LOCK_SCAN_TS");}
  triggerNextInChain(chatId,"START");
}
function triggerNextInChain(chatId,currentStep) {
  const props=PropertiesService.getScriptProperties();
  const port=getPortfolio(chatId),hold=getHoldList(chatId),gold=getGoldPortfolio(chatId),wl=getWatchlist(chatId);
  if(currentStep==="START"){if(Object.keys(port).length>0){props.setProperty("PORTFOLIO_CHAT_ID",chatId);deleteAllTriggers("analyzePortfolioAsync");ScriptApp.newTrigger("analyzePortfolioAsync").timeBased().after(300).create();return;}currentStep="PORTFOLIO";}
  if(currentStep==="PORTFOLIO"){if(Object.keys(hold).length>0){props.setProperty("HOLD_ANALYZE_CHAT_ID",chatId);deleteAllTriggers("analyzeHoldAsync");ScriptApp.newTrigger("analyzeHoldAsync").timeBased().after(300).create();return;}currentStep="HOLD";}
  if(currentStep==="HOLD"){if(gold&&gold.purchases&&gold.purchases.length>0){props.setProperty("GOLD_ANALYZE_CHAT_ID",chatId);deleteAllTriggers("analyzeGoldAsync");ScriptApp.newTrigger("analyzeGoldAsync").timeBased().after(300).create();return;}currentStep="GOLD";}
  if(currentStep==="GOLD"){if(Object.keys(wl).length>0){props.setProperty("STOCK_CHAT_ID",chatId);props.setProperty("STOCK_SYMBOLS",JSON.stringify(Object.keys(wl)));deleteAllTriggers("analyzeStockAsync");ScriptApp.newTrigger("analyzeStockAsync").timeBased().after(300).create();}}
}
function analyzeSingleSymbolAsync() {
  deleteAllTriggers("analyzeSingleSymbolAsync");
  const props=PropertiesService.getScriptProperties();
  const chatId=props.getProperty("SINGLE_CHAT_ID"),symbol=props.getProperty("SINGLE_SYMBOL");
  props.deleteProperty("SINGLE_CHAT_ID");props.deleteProperty("SINGLE_SYMBOL");
  if(chatId&&symbol)analyzeAndSend(chatId,symbol);
}

// =====================================
// 📤 GỬI TELEGRAM
// =====================================
function sendMsg(chatId,text) {
  try{
    const res=UrlFetchApp.fetch(TELEGRAM_URL+"/sendMessage",{method:"post",contentType:"application/json",payload:JSON.stringify({chat_id:chatId,text:String(text)}),muteHttpExceptions:true});
    if(res.getResponseCode()!==200)Logger.log("sendMsg err "+res.getResponseCode()+": "+res.getContentText().substring(0,200));
  }catch(e){Logger.log("sendMsg ex: "+e);}
}
function sendLongMsg(chatId,text) {
  if(!text||!text.trim())return;
  const MAX=4000;const chunks=[];let rem=String(text).trim();
  while(rem.length>0){
    if(rem.length<=MAX){chunks.push(rem);break;}
    let cut=rem.lastIndexOf('\n',MAX);if(cut<500)cut=MAX;
    chunks.push(rem.substring(0,cut));rem=rem.substring(cut).trimStart();
  }
  chunks.forEach((chunk,i,arr)=>{
    try{UrlFetchApp.fetch(TELEGRAM_URL+"/sendMessage",{method:"post",contentType:"application/json",payload:JSON.stringify({chat_id:chatId,text:String(chunk)}),muteHttpExceptions:true});}
    catch(e){Logger.log("sendLongMsg ex: "+e);}
    if(i<arr.length-1)Utilities.sleep(400);
  });
}

// =====================================
// 🚀 SETUP & TEST
// =====================================
function handleInitTriggerCmd(chatId) {
  ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()==="checkSchedules").forEach(t=>ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("checkSchedules").timeBased().everyMinutes(5).create();
  const vnTime=new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Ho_Chi_Minh"}));
  const timeStr=vnTime.getHours().toString().padStart(2,"0")+":"+vnTime.getMinutes().toString().padStart(2,"0");
  const props=PropertiesService.getScriptProperties();
  const s1=props.getProperty("SCHEDULE1_"+chatId),s2=props.getProperty("SCHEDULE2_"+chatId);
  sendMsg(chatId,"✅ Đã tạo lại trigger (mỗi 5 phút)\nGiờ VN: "+timeStr+"\nLịch 1: "+(s1||"Chưa đặt")+"\nLịch 2: "+(s2||"Chưa đặt"));
}
function initTriggers() {
  ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()==="checkSchedules").forEach(t=>ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("checkSchedules").timeBased().everyMinutes(5).create();
  const vnTime=new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Ho_Chi_Minh"}));
  const msg="✅ Trigger đã khởi tạo! Giờ VN: "+vnTime.getHours().toString().padStart(2,"0")+":"+vnTime.getMinutes().toString().padStart(2,"0");
  Logger.log(msg);sendMsg(ADMIN_CHAT_ID,msg);
}
function setupBotCommands() {
  UrlFetchApp.fetch(TELEGRAM_URL+"/setMyCommands",{
    method:"post",contentType:"application/json",
    payload:JSON.stringify({commands:[
      {command:"scan",        description:"Quét kỹ thuật toàn TT + tự động phân tích danh mục/tích sản/watchlist"},
      {command:"recommend",   description:"Top 10 cổ phiếu quỹ DCDS/DCDE/DCBF đang nắm giữ"},
      {command:"market",      description:"Chỉ số thị trường: VNINDEX, VN30, HNX, UPCOM"},
      {command:"news",        description:"Tin tức cổ phiếu: /news FPT"},
      {command:"buy",         description:"Danh mục ngắn hạn: /buy HAG 15.2 500"},
      {command:"stock",       description:"Thêm mã theo dõi: /stock HAG 14.5"},
      {command:"hold",        description:"Tích sản: /hold | /hold VNM | /hold VNM 65.70 1000 | /hold VNM HAG VCB [ngân sách]"},
      {command:"gold",        description:"Tài sản vàng: /gold 0.5 103500"},
      {command:"noti",        description:"Cảnh báo giá: /noti HAG 15 | /noti | /noti del HAG"},
      {command:"delete",      description:"Xóa mã: /delete VNM EIB | Bán vàng: /delete gold 0.5 103500"},
      {command:"set1",        description:"Sáng: BẢN TIN VIP + quét TT + danh mục: /set1 8h30"},
      {command:"set2",        description:"Chiều: chỉ phân tích danh mục/tích sản: /set2 15h30"},
      {command:"setgold",     description:"Lịch báo giá vàng hàng ngày: /setgold 10h00"},
      {command:"myschedule",  description:"Xem lịch báo cáo tự động"},
      {command:"aistatus",    description:"Trạng thái AI đang dùng (DeepSeek qua ds2api)"},
      {command:"resetcache",  description:"(Không còn cần thiết — ds2api tự xoay vòng tài khoản)"},
      {command:"forcescan",   description:"Reset lock khi /scan bị treo"},
      {command:"inittrigger", description:"Tạo lại trigger lịch khi bị mất sau deploy"}
    ]}),muteHttpExceptions:true
  });
}
function testAI() {
  const r=callAI("Nói đúng 3 chữ: TEST THÀNH CÔNG");
  sendMsg(ADMIN_CHAT_ID,"Test AI: "+(r?cleanAIText(r):"THẤT BẠI"));
}
function testAPI() {
  const reqs=["/health","/market","/recommend","/hold/FPT","/news/FPT","/score/FPT","/growth-stocks","/dividend-kings"];
  const results=apiBatch(reqs,30);
  const lines=["🔧 TEST API V4","─────────────────────────"];
  reqs.forEach((path,i)=>{
    const ok=results[i]!==null;
    lines.push((ok?"✅":"❌")+" "+path);
  });
  sendMsg(ADMIN_CHAT_ID,lines.join("\n"));
}
