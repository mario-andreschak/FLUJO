import fs from 'node:fs';
const stop = process.argv[2];
const maximumSeconds = Number(process.argv[3] ?? 210);
if (!stop || !Number.isInteger(maximumSeconds) || maximumSeconds < 1 || maximumSeconds > 600) {
  throw new Error('invalid_sampler_arguments');
}
const deadline = Date.now() + maximumSeconds * 1000;
while (Date.now() < deadline && !fs.existsSync(stop)) {
  let count=0, rss=0, anonymous=0, maxAnonymous=0;
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const command=fs.readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0')[0];
      if (!command.endsWith('/bin/codex')) continue;
      const environment=fs.readFileSync(`/proc/${pid}/environ`,'utf8').split('\0');
      if (!environment.some(value=>value.startsWith('CODEX_HOME=/data/flujo/workspaces/default-workspace/db/codex-private-'))) continue;
      const status=fs.readFileSync(`/proc/${pid}/status`,'utf8');
      const bytes=name=>Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(status)?.[1]??0)*1024;
      count++;rss+=bytes('VmRSS');const value=bytes('RssAnon');anonymous+=value;maxAnonymous=Math.max(maxAnonymous,value);
    } catch {}
  }
  console.log(JSON.stringify({at:new Date().toISOString(),private_native_processes:count,
    private_native_rss_bytes:rss,private_native_anonymous_bytes:anonymous,max_private_native_anonymous_bytes:maxAnonymous,
    worker_cgroup_memory_bytes:Number(fs.readFileSync('/sys/fs/cgroup/memory.current','utf8'))}));
  await new Promise(resolve=>setTimeout(resolve,500));
}
