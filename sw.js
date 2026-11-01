const C='lyriccast-v3',SHELL=['/','/o/LOCAL','/app.js','/icon.svg','/manifest.webmanifest'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(SHELL)));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))));self.clients.claim()});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==location.origin||u.pathname.startsWith('/api')||u.pathname==='/ws')return;
  if(u.pathname.startsWith('/o/')&&u.pathname!=='/o/LOCAL')return;
  const local=u.pathname==='/o/LOCAL';
  e.respondWith(fetch(e.request).then(r=>{const cp=r.clone();caches.open(C).then(c=>c.put(local?new Request('/o/LOCAL'):e.request,cp));return r})
    .catch(()=>caches.match(local?'/o/LOCAL':e.request,{ignoreSearch:true})));
});
