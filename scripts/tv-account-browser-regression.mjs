import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createApp,loadConfig} from '../server.mjs';
const {chromium}=await import(pathToFileURL(process.env.JRP_PLAYWRIGHT_MODULE).href);
const root=await mkdtemp(path.join(tmpdir(),'jrplex-tv-account-'));let browser,app;
const compact='0123456789abcdef0123456789abcdef',dashed='01234567-89ab-cdef-0123-456789abcdef';
const encode=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=24','-t','24','-c:v','libx264','-preset','ultrafast','-g','48','-pix_fmt','yuv420p','-f','hls','-hls_time','2','-hls_playlist_type','vod','-hls_segment_type','fmp4','-hls_fmp4_init_filename','init.mp4','-hls_segment_filename',path.join(root,'seg%d.m4s'),path.join(root,'master.m3u8')]);assert.equal(encode.status,0);
const user={Id:'fixture',Name:'Fixture account',Policy:{IsAdministrator:false,EnableMediaPlayback:true}};
const item={Id:compact,Name:'Standalone fixture',Type:'Movie',MediaType:'Video',ImageTags:{},UserData:{PlaybackPositionTicks:80000000}};
const media=http.createServer(async(req,res)=>{
 let body='';for await(const part of req)body+=part;const url=new URL(req.url,'http://localhost');
 const json=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
 if(url.pathname==='/Users/AuthenticateByName')return JSON.parse(body).Pw==='fixture-pass'?json({AccessToken:'PRIVATE_FIXTURE_TOKEN',User:user}):json({},401);
 if(url.pathname==='/Users/Me')return json(user);
 if(url.pathname==='/Users/fixture/Views')return json({Items:[{Id:'library',Name:'Library fixture',IsFolder:true,Type:'CollectionFolder'}]});
 if(url.pathname==='/Users/fixture/Items'||url.pathname==='/UserItems/Resume')return json({Items:[item],TotalRecordCount:1});
 if(url.pathname.startsWith('/Users/fixture/Items/'))return json(item);
 if(url.pathname===`/Items/${compact}/PlaybackInfo`)return json({PlaySessionId:'play-fixture',MediaSources:[{Id:compact,Container:'mkv',SupportsDirectPlay:false,TranscodingUrl:`/videos/${dashed}/master.m3u8?api_key=PRIVATE_FIXTURE_TOKEN`,TranscodingContainer:'mp4'}]});
 if(url.pathname.startsWith('/Sessions/')){res.writeHead(204);return res.end();}
 const asset=url.pathname.match(new RegExp(`^/Videos/${dashed}/(master\\.m3u8|init\\.mp4|seg\\d+\\.m4s)$`))?.[1];
 if(asset){const bytes=await readFile(path.join(root,asset));res.writeHead(200,{'content-type':asset.endsWith('m3u8')?'application/vnd.apple.mpegurl':'video/mp4','content-length':bytes.length});return res.end(bytes);}
 return json({},404);
});
const start=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');return`http://127.0.0.1:${server.address().port}`;};
const upstream=await start(media);const config=loadConfig({JELLYFIN_URL:upstream});app=createApp(config);const base=await start(app.server);config.publicUrl=base;
const post=async(path,input,token)=>{const r=await fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(input)});assert.equal(r.status<300,true,`API status ${r.status}`);return r.json();};
try{
 const link=await post('/api/tv/link/start',{name:'Living room fixture'});
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
 const phone=await browser.newContext({viewport:{width:390,height:844}});const page=await phone.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+new URL(link.verificationUrl).pathname+new URL(link.verificationUrl).hash);
 await page.locator('#device-approve-form').waitFor({state:'visible'});assert.equal(new URL(page.url()).hash,'');assert.equal(await page.locator('#device-name').textContent(),'Living room fixture');
 await page.getByLabel('Usuario JRPlex').fill('fixture');await page.getByLabel('Contraseña JRPlex').fill('fixture-pass');await page.getByRole('button',{name:'Vincular mi cuenta con esta TV',exact:true}).click();
 await page.locator('#device-success').waitFor({state:'visible'});assert.equal(await page.locator('#device-password').inputValue(),'');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await mkdir('.gauntlet/tv-standalone',{recursive:true});await page.screenshot({path:'.gauntlet/tv-standalone/phone-linked.png',fullPage:true});
 assert.deepEqual(errors,[]);const approved=await post('/api/tv/link/poll',{secret:link.secret});assert.equal(approved.status,'approved');assert.doesNotMatch(approved.token,/PRIVATE/);await phone.close();
 const catalog=await fetch(base+'/api/tv/catalog?kind=movies',{headers:{Authorization:'Bearer '+approved.token}});assert.equal(catalog.status,200);assert.equal((await catalog.json()).items[0].Id,compact);
 const play=await post('/api/tv/play',{itemId:compact,position:8},approved.token);assert.doesNotMatch(play.media.url,/PRIVATE|api_key/);
 const context=await browser.newContext();const screen=await context.newPage();screen.on('pageerror',e=>errors.push(e.message));await screen.goto(base+'/tv');
 await screen.evaluate(({url,position})=>{const video=document.getElementById('tv-video');document.getElementById('tv-player').hidden=false;window.standaloneHls=new Hls({startPosition:position});window.standaloneHls.loadSource(url);window.standaloneHls.attachMedia(video);void video.play();},{url:play.media.url,position:8});
 await screen.waitForFunction(()=>document.getElementById('tv-video').currentTime>8.4);assert.equal((await context.cookies()).length,0);
 await post('/api/tv/progress',{itemId:compact,mediaId:play.media.id,position:9,event:'progress'},approved.token);
 await post('/api/tv/stop',{mediaId:play.media.id},approved.token);assert.equal((await fetch(play.media.url)).status,401);
 await post('/api/tv/logout',{},approved.token);assert.equal((await fetch(base+'/api/tv/session',{headers:{Authorization:'Bearer '+approved.token}})).status,401);assert.deepEqual(errors,[]);
 console.log('PASS phone QR-fragment/manual-code approval: named TV, consent/login form, password cleared, responsive, no JS errors.');
 console.log('PASS standalone account: phone context closed, catalog and resume request still work; real HLS/fMP4 frames with compact catalogue GUID/dashed stream GUID, no cookies or raw upstream token.');
 console.log('PASS progress, stop and device logout revoke access. Hardware decoder/remote not exercised.');
}finally{await browser?.close();app.close();app.server.closeAllConnections();media.closeAllConnections();await Promise.all([new Promise(r=>app.server.close(r)),new Promise(r=>media.close(r))]);await rm(root,{recursive:true,force:true});}
