// Keep the machine busy while a campaign runs: N busy loops until the file <stopFile> appears
// (or for at most <maxSeconds>). The lock bug this harness hunts only showed under load.
//   node load.mjs <N> <stopFile> [maxSeconds]
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
const n = Number(process.argv[2] || 8);
const stopFile = process.argv[3];
const maxMs = Number(process.argv[4] || 7200) * 1000;
const kids = Array.from({ length: n }, () =>
  spawn(process.execPath, ['-e', 'for(;;){let x=0;for(let i=0;i<1e8;i++)x+=i;}'], { stdio: 'ignore' }),
);
const t0 = Date.now();
const timer = setInterval(() => {
  if ((stopFile && fs.existsSync(stopFile)) || Date.now() - t0 > maxMs) {
    for (const k of kids) k.kill('SIGKILL');
    clearInterval(timer);
  }
}, 1000);
