import { chromium } from 'playwright';
import { startDevServer } from '../lib/dev-server.mjs';
const N=4096,E=10000,SEED=0x54524B04;
const ARGS=['--headless=new','--enable-unsafe-webgpu','--enable-features=Vulkan','--no-sandbox'];
const BIN=(()=>{const lo=1,hi=5000,M=14,e=[];for(let i=0;i<=M;i++)e.push(lo*(hi/lo)**(i/M));return e;})();
function hist(v,ed){const c=new Array(ed.length-1).fill(0);for(const x of v){if(x<ed[0]||x>=ed[ed.length-1])continue;let lo=0,hi=c.length-1;while(lo<hi){const m=(lo+hi+1)>>1;if(ed[m]<=x)lo=m;else hi=m-1;}c[lo]++;}return c;}
const G4=[0,0,0,145917,195499,112800,67081,35668,17906,8560,7272,1888,728,177];
const server=await startDevServer();const b=await chromium.launch({headless:false,args:ARGS});let out;
try{const pg=await(await b.newContext()).newPage();pg.on('pageerror',e=>console.error('[pageerror]',e.message));
await pg.goto(`${server.url}/bench.html`);await pg.waitForFunction(()=>window.__benchReady===true||typeof window.__benchError==='string',null,{timeout:60000});
const err=await pg.evaluate(()=>window.__benchError);if(err)throw new Error(err);
out=await pg.evaluate(async a=>window.runPhaseABench({Ns:[a.N],warmups:1,trials:1,energyEv:a.E,seed:a.SEED,ms:65536,dumpSecBuf:true}),{N,E,SEED});
}finally{await b.close();await server.stop();}
const ke=out.secKEs??[];const c=hist(ke,BIN);
console.log(`secondaries: ${ke.length} (${(ke.length/N).toFixed(2)}/primary)\nbin(eV)         WGSL    G4     rel_diff`);
for(let i=0;i<c.length;i++){const rd=Math.max(c[i],G4[i])>0?Math.abs(c[i]-G4[i])/Math.max(c[i],G4[i]):0;const mk=i===10?' <== target':(G4[i]/593496>0.01&&rd>0.30?' FAIL':'');console.log(`${BIN[i].toFixed(0).padStart(5)}-${BIN[i+1].toFixed(0).padStart(5)} ${String(c[i]).padStart(7)} ${String(G4[i]).padStart(6)}  ${rd.toFixed(3)}${mk}`);}
