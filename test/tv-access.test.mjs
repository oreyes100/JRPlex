import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, loadConfig } from '../server.mjs';
import { createTvStore } from '../lib/tv-store.mjs';
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function fixture(t) {
 const state={now:Date.now(),disabled:false,denied:false,tokens:new Map(),requests:[],logouts:[],count:0};
 const media=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const url=new URL(req.url,'http://localhost');const payload=raw?JSON.parse(raw):{};
  const json=(data,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
  const token=req.headers.authorization?.match(/Token="([^"]+)"/)?.[1]; const name=state.tokens.get(token)||'alice';state.requests.push({path:url.pathname,query:url.searchParams,payload,token});
  const user={Id:name,Name:name,Policy:{IsAdministrator:name==='alice',IsDisabled:state.disabled,EnableMediaPlayback:true}};
  if(url.pathname==='/Users/AuthenticateByName'){
   if(payload.Pw!=='fixture-pass')return json({},401);const fresh=`PRIVATE_${payload.Username}_${++state.count}`;state.tokens.set(fresh,payload.Username);return json({AccessToken:fresh,User:{...user,Id:payload.Username,Name:payload.Username}});
  }
  if(!state.tokens.has(token))return json({},401);
  if(url.pathname==='/Users/Me')return json(user);
  if(url.pathname==='/Sessions/Logout'){state.logouts.push(token);state.tokens.delete(token);return json({});}
  if(url.pathname.endsWith('/Views'))return json({Items:[{Id:'library',Name:'Movies',Type:'CollectionFolder',IsFolder:true}]});
  if(url.pathname.endsWith('/Items')||url.pathname==='/UserItems/Resume'){
   const photos=url.searchParams.get('IncludeItemTypes')?.includes('Photo');
   return json({Items:photos?[{Id:'photo',Name:'Fixture photo.jpg',Type:'Photo',MediaType:'Photo',DateCreated:'2024-06-15T12:00:00Z',Path:'/private/photo.jpg'}]:[{Id:'movie',Name:'Fixture movie.mp4',Type:'Movie',MediaType:'Video',ImageTags:{Primary:'tag'},UserData:{PlaybackPositionTicks:120000000},Path:'/private/movie.mp4'},{Id:'subtitle',Name:'Fixture movie.srt',Type:'Movie',MediaType:'Video',MediaStreams:[{Type:'Video'}],Path:'/private/movie.srt'}],TotalRecordCount:85});
  }
  if(/^\/Users\/[^/]+\/Items\/[^/]+$/.test(url.pathname))return json({Id:url.pathname.split('/').at(-1),Name:'Fixture movie.mp4',Type:'Movie',MediaType:'Video',Path:'/private/movie.mp4'},state.denied?403:200);
  if(url.pathname==='/Items/movie/PlaybackInfo')return json({MediaSources:[{Id:'source',SupportsDirectPlay:true,Container:'mp4',MediaStreams:[{Type:'Video',Codec:'h264'},{Type:'Audio',Codec:'aac'}]}]});
  if(url.pathname==='/Videos/movie/stream.mp4'){res.writeHead(200,{'content-type':'video/mp4'});return res.end('verified-fixture-bytes');}
  if(url.pathname.startsWith('/Sessions/Playing'))return json({});
  if(url.pathname==='/Items/movie/Images/Primary'){res.writeHead(200,{'content-type':'image/jpeg'});return res.end('JPEG-fixture');}
  return json({},404);
 });
 const upstream=await listen(media);const directory=await mkdtemp(join(tmpdir(),'jrplex-tv-test-'));await chmod(directory,0o700);
 let app,base;const config=loadConfig({JELLYFIN_URL:upstream,TV_STATE_DIR:directory});
 async function boot(){app=createApp(config,{tvNow:()=>state.now});base=await listen(app.server);config.publicUrl=base;}
 async function close(){app.close();app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));}
 await boot();t.after(async()=>{await close();media.closeAllConnections();await new Promise(resolve=>media.close(resolve));await rm(directory,{recursive:true,force:true});});
 const call=(path,input,token)=>fetch(base+path,{method:input?'POST':'GET',headers:{Origin:base,...(input?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},...(input?{body:JSON.stringify(input)}:{})});
 async function enroll(username='alice'){
  const started=await(await call('/api/tv/link/start',{name:'My Fire TV'})).json();
  const approved=await call('/api/tv/link/approve',{code:started.code,username,password:'fixture-pass'});assert.equal(approved.status,200);
  const result=await(await call('/api/tv/link/poll',{secret:started.secret})).json();return {token:result.token,started};
 }
 return{state,call,enroll,directory,config,get base(){return base;},get app(){return app;},restart:async()=>{await close();await boot();}};
}
test('TV enrollment is short lived, one use, credential-specific and independent of browser sessions',async t=>{
 const f=await fixture(t);const {token,started}=await f.enroll();assert.match(token,/^[A-Za-z0-9_-]{43}$/);assert.match(started.code,/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);assert.match(started.verificationUrl,/#code=/);
 const session=await(await f.call('/api/tv/session',null,token)).json();assert.equal(session.user.Name,'alice');assert.doesNotMatch(JSON.stringify(session),/PRIVATE_|csrfToken|IsAdministrator/);
 assert.equal((await f.call('/api/tv/link/approve',{code:started.code,username:'alice',password:'fixture-pass'})).status,404);
 assert.equal((await fetch(f.base+'/api/session',{headers:{Authorization:'Bearer '+token}})).status,401);
 const web=await f.call('/api/login',{username:'alice',password:'fixture-pass'});const cookie=web.headers.get('set-cookie').split(';')[0];const data=await web.json();
 await fetch(f.base+'/api/logout',{method:'POST',headers:{Cookie:cookie,Origin:f.base,'X-CSRF-Token':data.csrfToken,'Content-Type':'application/json'},body:'{}'});
 assert.equal((await f.call('/api/tv/session',null,token)).status,200);
 const encrypted=await readFile(join(f.directory,'devices.enc'));assert.ok(!encrypted.includes(Buffer.from('PRIVATE_')));assert.ok(!encrypted.includes(Buffer.from(token)));
 await f.restart();assert.equal((await f.call('/api/tv/session',null,token)).status,200);
});
test('TV catalog scopes user, paginates folders/search and cannot invoke admin or access another user',async t=>{
 const f=await fixture(t);const {token}=await f.enroll('bob');
 const home=await(await f.call('/api/tv/catalog',null,token)).json();assert.equal(home.items[0].IsFolder,true);
 const catalogue=await(await f.call('/api/tv/catalog?kind=movies&offset=40&search=test&userId=alice',null,token)).json();assert.equal(catalogue.total,85);assert.equal(catalogue.items[0].Position,12);assert.equal(catalogue.items[0].Path,undefined);assert.deepEqual(catalogue.items.map(item=>item.Id),['movie']);assert.equal(catalogue.items[0].Playable,true);
 const last=f.state.requests.at(-1);assert.equal(last.path,'/Users/bob/Items');assert.equal(last.query.get('UserId'),'bob');assert.equal(last.query.get('StartIndex'),'40');assert.match(last.query.get('IncludeItemTypes'),/Movie/);assert.match(last.query.get('Fields'),/Path/);
 assert.equal((await f.call('/api/tv/admin',{},token)).status,404);
 assert.equal((await f.call('/api/tv/catalog?offset=-1',null,token)).status,400);
 f.state.denied=true;assert.equal((await f.call('/api/tv/catalog?parent=private',null,token)).status,403);assert.equal((await f.call('/api/tv/play',{itemId:'movie'},token)).status,403);
});
test('TV catalog accepts documented sort keys and returns photo dates while refusing subtitle sidecars',async t=>{
 const f=await fixture(t);const {token}=await f.enroll();
 const result=await(await f.call('/api/tv/catalog?kind=photos&sort=date&order=desc',null,token)).json();assert.deepEqual(result.items.map(item=>item.Id),['photo']);assert.equal(result.items[0].DateCreated,'2024-06-15T12:00:00Z');
 const query=f.state.requests.at(-1).query;assert.equal(query.get('SortBy'),'DateCreated,SortName');assert.match(query.get('IncludeItemTypes'),/Photo/);assert.match(query.get('Fields'),/DateCreated/);
 const sorted=await f.call('/api/tv/catalog?kind=movies&sort=origin',null,token);assert.equal(sorted.status,200);assert.equal(f.state.requests.at(-1).query.get('SortBy'),'IsFolder,SortName');
});
test('native standalone play/seek progress/stop and logout revoke only that device',async t=>{
 const f=await fixture(t);const a=await f.enroll();const b=await f.enroll();
 const result=await f.call('/api/tv/play',{itemId:'movie',position:12},a.token);assert.equal(result.status,201);const {media,position}=await result.json();assert.equal(position,12);assert.doesNotMatch(media.url,/PRIVATE_/);
 assert.equal(await(await fetch(media.url)).text(),'verified-fixture-bytes');
 assert.equal((await f.call('/api/tv/stop',{mediaId:media.id},b.token)).status,403);
 assert.equal((await f.call('/api/tv/progress',{itemId:'movie',mediaId:media.id,position:25,event:'progress'},b.token)).status,403);
 assert.equal((await f.call('/api/tv/progress',{itemId:'movie',mediaId:media.id,position:25,event:'progress',playSessionId:'untrusted'},a.token)).status,200);
 assert.equal(f.state.requests.at(-1).payload.PositionTicks,250000000);
 assert.equal((await f.call('/api/tv/logout',{},a.token)).status,200);assert.equal((await fetch(media.url)).status,401);assert.equal((await f.call('/api/tv/session',null,a.token)).status,401);assert.equal((await f.call('/api/tv/session',null,b.token)).status,200);
 f.state.disabled=true;assert.equal((await f.call('/api/tv/session',null,b.token)).status,401);
});
test('linking rejects wrong origin/secret/password, expires codes and bounds guessing',async t=>{
 const f=await fixture(t);const started=await(await f.call('/api/tv/link/start',{})).json();
 assert.equal((await fetch(f.base+'/api/tv/link/approve',{method:'POST',headers:{Origin:'https://evil.invalid','Content-Type':'application/json'},body:JSON.stringify({code:started.code,username:'alice',password:'fixture-pass'})})).status,403);
 assert.equal((await f.call('/api/tv/link/poll',{secret:'wrong'})).status,401);
 assert.equal((await f.call('/api/tv/link/approve',{code:started.code,username:'alice',password:'wrong'})).status,401);
 f.state.now+=300001;assert.equal((await f.call('/api/tv/link/info',{code:started.code})).status,404);
 assert.equal((await f.call('/api/tv/link/poll',{secret:started.secret})).status,401);
});
test('TV store authenticates encryption and refuses insecure file permissions',async t=>{
 const p=await mkdtemp(join(tmpdir(),'jrplex-store-'));await chmod(p,0o700);t.after(()=>rm(p,{recursive:true,force:true}));
 const store=createTvStore(p);store.set({id:'a'.repeat(43),hash:'b'.repeat(64),token:'PRIVATE',user:{Id:'alice'},expires:Date.now()+10000});
 assert.equal(createTvStore(p).values().length,1);await chmod(join(p,'devices.enc'),0o644);assert.throws(()=>createTvStore(p),/private/);
 await chmod(join(p,'devices.enc'),0o600);const encrypted=await readFile(join(p,'devices.enc'));encrypted[29]^=1;await writeFile(join(p,'devices.enc'),encrypted);assert.throws(()=>createTvStore(p));
});
