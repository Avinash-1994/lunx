const ports=[5510,5511,5512,5513,5514,5515,5516,5517,5518,5519,5520];
const names={5510:'solid',5511:'angular',5512:'nuxt',5513:'sveltekit',5514:'remix',5515:'next',5516:'rrv7',5517:'solidstart',5518:'tanstack',5519:'waku',5520:'analog'};
const out=[];
for (const p of ports) {
  try {
    const ctrl=new AbortController();
    const t=setTimeout(()=>ctrl.abort(),5000);
    const r=await fetch('http://127.0.0.1:'+p+'/',{signal:ctrl.signal});
    clearTimeout(t);
    const text=await r.text();
    out.push({port:p,fw:names[p],status:r.status,len:text.length,title:(text.match(/<title[^>]*>([^<]*)/i)||[])[1]||'',snippet:text.replace(/\s+/g,' ').slice(0,240)});
  } catch(e) {
    out.push({port:p,fw:names[p],error:String(e.cause?.code||e.message||e)});
  }
}
import fs from 'fs';
fs.writeFileSync('/home/avinash/Desktop/framework_practis/tool/build/.tmp-ssr-probe.json', JSON.stringify(out,null,2));
console.log(JSON.stringify(out,null,2));
