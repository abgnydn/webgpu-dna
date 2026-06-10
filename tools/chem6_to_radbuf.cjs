const fs = require('fs');
const lines = fs.readFileSync('/tmp/chem6_initial.txt','utf8').split('\n');
// map chem6 molecule names -> our dump codes
const map = {'°OH^0':0, 'H3O^1':3, 'e_aq^-1':1, 'H^0':2, 'H_2^0':7, '°O^0':4, 'OH^-1':6};
const rads = [];
const seen = {};
for (const ln of lines) {
  if (!ln || ln[0]==='#') continue;
  const p = ln.trim().split(/\s+/);
  const name = p[0];
  seen[name] = (seen[name]||0)+1;
  if (!(name in map)) continue;
  rads.push([parseFloat(p[1]),parseFloat(p[2]),parseFloat(p[3]),map[name]]);
}
const buf = new Float32Array(rads.length*4);
for (let i=0;i<rads.length;i++) for(let j=0;j<4;j++) buf[i*4+j]=rads[i][j];
fs.writeFileSync('/tmp/chem6_radicals.bin', Buffer.from(buf.buffer));
console.error('mapped '+rads.length+' radicals; unmapped: '+Object.keys(seen).filter(n=>!(n in map)).map(n=>n+'='+seen[n]).join(' '));
