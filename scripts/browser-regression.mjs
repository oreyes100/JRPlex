import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp, loadConfig } from '../server.mjs';
import { createTorrentClient } from '../lib/torrents.mjs';
const { chromium } = await import(pathToFileURL(process.env.JRP_PLAYWRIGHT_MODULE).href);
const root = await mkdtemp(path.join(os.tmpdir(), 'jrplex-browser-'));
const generated = spawnSync('ffmpeg', ['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=24','-t','8','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart','-y',path.join(root,'template.mp4')]);
assert.equal(generated.status,0,generated.stderr?.toString());
const videoBytes = await readFile(path.join(root,'template.mp4'));
const libraries = []; const hash='a'.repeat(40); let added=false; let pieces=0; let qbState='downloading'; let globalCatalogueQueries=0;
const driveTree = {
  '': [{ id: 'mediafolder123456789', name: 'Media' }],
  mediafolder123456789: [{ id: 'moviesfolder123456789', name: 'Peliculas' }, { id: 'photosfolder123456789', name: 'Fotos' }, { id: 'musicfolder123456789', name: 'Musica' }],
  moviesfolder123456789: [], photosfolder123456789: [], musicfolder123456789: [],
};
const drivePaths = { moviesfolder123456789: '/media/cloud/Media/Peliculas', photosfolder123456789: '/media/cloud/Media/Fotos', musicfolder123456789: '/media/cloud/Media/Musica' };
const qbFetch = async (url) => {
  const u = new URL(url); const route=u.pathname.replace('/api/v2/','');
  if(route==='auth/login') return new Response('Ok.',{headers:{'set-cookie':'SID=fixture'}});
  if(route==='torrents/info') return Response.json(u.searchParams.has('tag')||!added?[]:[{hash,tags:'jrplex-stream',name:'Synthetic film',save_path:root,content_path:path.join(root,'movie.mp4'),state:qbState,num_seeds:2,num_leechs:1,dlspeed:16384,progress:0.1}]);
  if(route==='torrents/add'){ added=true; return new Response('Ok.'); }
  if(route==='torrents/files') return Response.json([{index:0,name:'movie.mp4',size:videoBytes.length,progress:0}]);
  if(route==='torrents/properties') return Response.json({piece_size:16384});
  if(route==='torrents/pieceStates'){ pieces++; if(pieces>1) await writeFile(path.join(root,'movie.mp4'),videoBytes); return Response.json(Array(Math.ceil(videoBytes.length/16384)).fill(pieces>1?2:0)); }
  if(route==='torrents/delete'){added=false; return new Response('');}
  return new Response('');
};
const user={Id:'fixture',Name:'Test admin',Policy:{IsAdministrator:true}};
const media=http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://localhost'); let raw=''; for await(const c of req) raw+=c;
  const json=(value)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  if(u.pathname==='/Users/AuthenticateByName') return json({AccessToken:'FIXTURE_TOKEN',User:user});
  if(u.pathname==='/Users/Me') return json(user);
  if(u.pathname==='/Users/fixture/Views') return json({Items:libraries.map(l=>({Id:l.ItemId,Name:l.Name,CollectionType:l.CollectionType,IsFolder:true}))});
  if(u.pathname==='/UserItems/Resume') return json({Items:[]});
  if(u.pathname==='/Users/fixture/Items') {
    const library=libraries.find(l=>l.ItemId===u.searchParams.get('ParentId'));
    return json({Items:library?.CollectionType==='homevideos'?[{Id:'photo-fixture',Name:'Test photograph',Type:'Photo',MediaType:'Photo'}]:[],TotalRecordCount:library?.CollectionType==='homevideos'?1:0});
  }
  if(u.pathname==='/Items/photo-fixture/Images/Primary'){res.writeHead(200,{'content-type':'image/svg+xml'});return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="blue"/></svg>');}
  if(u.pathname==='/Items'&&u.searchParams.get('Recursive')==='true'&&u.searchParams.get('IncludeItemTypes')==='Movie,Series,MusicAlbum,Audio,Video,Episode'){globalCatalogueQueries++;return json({Items:[],TotalRecordCount:0});}
  if(u.pathname==='/Items'&&u.searchParams.get('IncludeItemTypes')==='MusicAlbum,Audio'){
    assert.equal(u.searchParams.has('MediaTypes'),false,'albums must not be filtered out by MediaTypes');
    return json({Items:[{Id:'album-fixture',Name:'Test album',Type:'MusicAlbum',IsFolder:true}],TotalRecordCount:1});
  }

  if(u.pathname==='/Library/VirtualFolders'&&req.method==='POST') {const options=JSON.parse(raw).LibraryOptions;libraries.push({ItemId:'library-'+(libraries.length+1),Name:u.searchParams.get('name'),CollectionType:u.searchParams.get('collectionType'),Locations:options.PathInfos.map(p=>p.Path),LibraryOptions:options});res.writeHead(204);return res.end();}
  if(u.pathname==='/Library/VirtualFolders') return json(libraries);
  if(u.pathname==='/Environment/DirectoryContents') {const p=u.searchParams.get('path');return json(p==='/media/cloud'?[{Name:'Media'}]:p==='/media/cloud/Media'?[{Name:'Peliculas'},{Name:'Fotos'},{Name:'Musica'}]:[]);}
  if(u.pathname==='/Users') return json([user]);
  return json({Items:[],TotalRecordCount:0});
});
const start=async(server)=>{server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;};
const upstream=await start(media);
const config={...loadConfig({JELLYFIN_URL:upstream,PUBLIC_URL:'http://127.0.0.1:8787'}),qbUrl:'http://127.0.0.1:8080',qbUsername:'fixture',qbPassword:'fixture',torrentFilesDir:root};
const torrentClient=createTorrentClient(config,{fetch:qbFetch});
const app=createApp(config,{torrentClient,cloudMountStatus:async()=>true,googleOAuth:{callbackPath:'/api/google-drive/callback',status:async()=>({linked:true,configured:true}),listFolders:async(parentId,pageToken)=>({parentId:parentId||null,folders:!parentId&&pageToken?[{id:'archivefolder123456789',name:'Archive'}]:driveTree[parentId]||[],nextPageToken:!parentId&&!pageToken?'drive-page-2':null}),resolveFolderUrl:async value=>drivePaths[new URL(value).pathname.split('/').at(-1)]}});
const base=await start(app.server);config.publicUrl=base;
let browser;
try {
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1100}}); const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/app');await page.getByLabel('Usuario',{exact:true}).fill('fixture');await page.getByLabel('Contraseña',{exact:true}).fill('fixture');await page.locator('#login-form button[type=submit]').click();
  await page.getByRole('heading',{name:'Tu biblioteca',exact:true}).waitFor();
  assert.equal(globalCatalogueQueries,0,'home shows libraries without waiting for one recursive catalogue request');
  await page.locator('#admin-nav').click();await page.getByRole('tab',{name:'Bibliotecas y nube'}).click();
  for(const [label,folder,type] of [['películas','Peliculas','movies'],['fotos','Fotos','homevideos'],['música','Musica','music']]) {
    await page.getByRole('button',{name:`Elegir carpeta de ${label} de Drive`,exact:true}).click();
    const folderId = { Peliculas:'moviesfolder123456789', Fotos:'photosfolder123456789', Musica:'musicfolder123456789' }[folder];
    const pathField = page.getByLabel('Ruta del servidor o enlace de Google Drive',{exact:true});
    if(type==='movies') {
      await pathField.fill(`https://drive.google.com/drive/folders/${folderId}?hl=es-419`);
    } else {
      if(label==='fotos') {
        await page.getByRole('button',{name:'Cargar más carpetas',exact:true}).click();
        await page.getByRole('button',{name:'▰ Archive',exact:true}).waitFor();
      }
      await page.getByRole('button',{name:'▰ Media',exact:true}).click();
      await page.getByRole('button',{name:`▰ ${folder}`,exact:true}).click();
      await page.getByText(`Carpeta actual: Media / ${folder} · https://drive.google.com/drive/folders/${folderId}`,{exact:true}).waitFor();
      await page.getByRole('button',{name:'Usar esta carpeta',exact:true}).click();
    }
    assert.match(await pathField.inputValue(),new RegExp(`^https://drive\\.google\\.com/drive/folders/${folderId}`));
    await page.getByRole('button',{name:'Conectar biblioteca',exact:true}).click();
    await page.getByText(`/media/cloud/Media/${folder}`,{exact:true}).waitFor();
    assert.equal(libraries.at(-1).CollectionType,type);assert.deepEqual(libraries.at(-1).Locations,[`/media/cloud/Media/${folder}`]);
  }
  assert.equal(libraries.find(l=>l.CollectionType==='homevideos').LibraryOptions.EnablePhotos,true);
  assert.equal(libraries.length,3,'shortcuts do not create root libraries');
  console.log('PASS Drive: pasted folder links and browsed photos/music folders save to their nested paths');
  await page.locator('[data-view=home]').click();
  await page.getByRole('button',{name:'▰ Películas de Google Drive · Películas',exact:true}).waitFor();
  assert.equal(globalCatalogueQueries,0,'home shows mapped library roots without waiting for a recursive item scan');
  await page.getByRole('button',{name:'▰ Películas de Google Drive · Películas',exact:true}).click();
  await page.getByRole('heading',{name:'Carpetas',exact:true}).waitFor();
  assert.equal(globalCatalogueQueries,0,'opening a home library browses its root instead of scanning the entire server');
  await mkdir(path.join(process.cwd(),'.gauntlet/production-fix'),{recursive:true});
  await page.screenshot({path:path.join(process.cwd(),'.gauntlet/production-fix/fixture-drive.png'),fullPage:true});
  await page.locator('[data-view=folders]').click();
  await page.getByRole('heading',{name:'Carpetas',exact:true}).waitFor();
  await page.getByRole('button',{name:'▰ Películas de Google Drive',exact:true}).waitFor();
  await page.locator('[data-view=photos]').click();
  await page.locator('.photo-card').waitFor();
  await page.locator('[data-view=music]').click();
  await page.getByRole('button',{name:'Ver Test album',exact:true}).waitFor();
  await page.getByRole('button',{name:'Seleccionar carpeta de música de Google Drive',exact:true}).click();
  assert.equal(await page.getByLabel('Contenido',{exact:true}).inputValue(),'music');
  await page.setViewportSize({width:390,height:844});
  const photoBox=await page.locator('[data-view=photos]').boundingBox();
  assert.ok(photoBox.x>=0&&photoBox.x+photoBox.width<=390,'Photos stays within the mobile viewport');
  await page.setViewportSize({width:1440,height:1100});
  console.log('PASS navigation: real gateway paths, photos, music albums, contextual mapping and mobile menu');
  await page.getByRole('tab',{name:'Descargas',exact:true}).click();
  await page.getByLabel('Enlace magnet',{exact:true}).fill(`magnet:?xt=urn:btih:${hash}`);
  await page.getByRole('button',{name:'Buscar vídeo en el torrent',exact:true}).click();
  await page.getByRole('button',{name:'▷ Reproducir',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.torrent-video')?.currentTime>0.25,{},{timeout:15000});
  console.log('PASS magnet: actual Chrome video playback advances after deferred file creation; peers are simulated');
  const activeTorrent=(await torrentClient.list())[0];
  const castMedia=await page.evaluate(async id=>{
    const session=await (await fetch('/api/session')).json();
    const response=await fetch('/api/cast/media',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':session.csrfToken},body:JSON.stringify({kind:'torrent',sessionId:id,fileIndex:0})});
    if(!response.ok)throw new Error('Torrent Cast grant failed');return response.json();
  },activeTorrent.id);
  const remoteBytes=await fetch(castMedia.url,{headers:{Range:'bytes=0-127'}});
  assert.equal(remoteBytes.status,206);assert.deepEqual(Buffer.from(await remoteBytes.arrayBuffer()),videoBytes.subarray(0,128));
  await page.evaluate(async id=>{const session=await(await fetch('/api/session')).json();await fetch(`/api/cast/media/${id}`,{method:'DELETE',headers:{'content-type':'application/json','x-csrf-token':session.csrfToken},body:'{}'});},castMedia.id);
  assert.equal((await fetch(castMedia.url)).status,401);assert.equal((await torrentClient.list())[0].id,activeTorrent.id);
  console.log('PASS torrent Cast: real verified MP4 bytes reach a cookie-free receiver; revoking Cast preserves the original torrent session');
  // Keep the video paused to test a service failure and retry within the same session.
  await page.locator('.torrent-video').evaluate(video=>video.pause());qbState='error';
  await page.getByRole('alert').filter({hasText:'qBittorrent no puede leer o guardar'}).first().waitFor({timeout:10000});
  console.log('PASS torrent errors: persistent server disk error is visible in the player');
  qbState='downloading';await page.getByRole('button',{name:'▷ Reproducir',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.torrent-video')?.currentTime>0.25,{},{timeout:15000});
  console.log('PASS retry: existing torrent session is reused without deletion');
  await page.getByRole('button',{name:'Detener y borrar búfer',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.torrent-video'));
  assert.equal(added,false);assert.deepEqual(errors,[]);
  console.log('PASS cleanup and browser JavaScript: no page errors');
} finally {
  await browser?.close();await torrentClient.close();
  app.server.closeAllConnections();media.closeAllConnections();
  await Promise.all([new Promise(resolve=>app.server.close(resolve)),new Promise(resolve=>media.close(resolve))]);
  await rm(root,{recursive:true,force:true});
}
