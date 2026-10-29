const { analyzeMU, createPlan, updatePlan } = require('./mu-engine');

async function kvGet(key) {
  const url=process.env.KV_REST_API_URL, token=process.env.KV_REST_API_TOKEN;
  if(!url||!token) return null;
  const response=await fetch(`${url}/get/${key}`,{headers:{Authorization:`Bearer ${token}`}});
  if(!response.ok) throw new Error(`History read failed (${response.status})`);
  const raw=(await response.json()).result;
  if(!raw) return null;
  try{return JSON.parse(raw);}catch{return null;}
}

async function kvSet(key,value) {
  const url=process.env.KV_REST_API_URL, token=process.env.KV_REST_API_TOKEN;
  if(!url||!token) return false;
  const response=await fetch(`${url}/pipeline`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify([['SET',key,JSON.stringify(value)]])});
  if(!response.ok) throw new Error(`History write failed (${response.status})`);
  return true;
}

async function fetchMU() {
  const url='https://query1.finance.yahoo.com/v8/finance/chart/MU?interval=1m&range=5d&includePrePost=true';
  const response=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json'}});
  if(!response.ok) throw new Error(`Market data failed (${response.status})`);
  const result=(await response.json())?.chart?.result?.[0];
  if(!result) throw new Error('MU data unavailable');
  const timestamps=result.timestamp||[], q=result.indicators?.quote?.[0]||{}, quotes=[];
  for(let i=0;i<timestamps.length;i++) if(q.close?.[i]!=null&&q.high?.[i]!=null&&q.low?.[i]!=null) quotes.push({
    date:new Date(timestamps[i]*1000),open:q.open?.[i]??q.close[i],high:q.high[i],low:q.low[i],close:q.close[i],volume:q.volume?.[i]||0,
  });
  return {quotes,meta:result.meta||{}};
}

module.exports=async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET') return res.status(405).json({error:'Method not allowed'});
  try{
    const now=Date.now(), [{quotes,meta},stored]=await Promise.all([fetchMU(),kvGet('wt_mu_live').catch(()=>null)]);
    const snapshot=analyzeMU(quotes,now,meta);
    let plans=Array.isArray(stored?.plans)?stored.plans:[];
    plans=plans.map(plan=>updatePlan(plan,quotes,now));
    const hasActive=plans.some(plan=>['TRACKING','T1_HIT','T2_HIT'].includes(plan.status));
    const coolingDown=plans[0]&&now-Number(plans[0].createdAt)<10*60000;
    const fresh=!hasActive&&!coolingDown?createPlan(snapshot,new Set(plans.map(plan=>plan.id))):null;
    if(fresh) plans.unshift(updatePlan(fresh,quotes,now));
    plans=plans.sort((a,b)=>b.createdAt-a.createdAt).slice(0,60);
    const activePlan=plans.find(plan=>['TRACKING','T1_HIT','T2_HIT'].includes(plan.status))||null;
    const saved=await kvSet('wt_mu_live',{plans,updatedAt:now}).catch(()=>false);
    res.status(200).json({...snapshot,activePlan,plans:plans.slice(0,12),historySaved:saved});
  }catch(error){res.status(503).json({error:error.message||'MU live data unavailable'});}
};
