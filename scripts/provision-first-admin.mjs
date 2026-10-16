import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { args, project, privateBackend, jsonRequest, fail } from './lib.mjs';

try {
  const opt = args(['url', 'help'], ['help']);
  if (opt.help) {
    console.log('node scripts/provision-first-admin.mjs [--url http://127.0.0.1:8096]\nSolo primera instalación: crea administrador jradmin con contraseña aleatoria en runtime/secrets/admin-password (0600); úsala por SSH y cámbiala al entrar. No imprime secretos, no sobrescribe cuentas existentes.');
  } else {
    if (process.platform === 'win32') throw new Error('El aprovisionamiento automático con permisos POSIX se ejecuta solo en el VPS Linux. En Windows usa bootstrap interactivo.');
    const base = privateBackend(opt.url || 'http://127.0.0.1:8096');
    const info = await jsonRequest(base, '/System/Info/Public');
    if (info.StartupWizardCompleted === true) { console.log('Motor ya configurado. No se modificaron cuentas ni contraseñas.'); }
    else {
      if (info.StartupWizardCompleted !== false) throw new Error('No se confirmó un servidor nuevo.');
      const directory = path.join(project, 'runtime/secrets');
      const filename = path.join(directory, 'admin-password');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try { await writeFile(filename, randomBytes(36).toString('base64url'), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      let password = (await readFile(filename, 'utf8')).trim();
      if (password.length < 32) throw new Error('Archivo inicial inválido; no se sobrescribe.');
      const child = spawn(process.execPath, [path.join(project, 'scripts/bootstrap.mjs'), '--url', base.origin, '--username', 'jradmin', '--local-media', '/media/local', '--downloads', '/media/downloads'], { stdio: ['pipe', 'inherit', 'inherit'] });
      child.stdin.end(`${password}\n${password}\n`);
      password = '';
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      if (code !== 0) throw new Error('Bootstrap incompleto; conserva el secreto inicial para reintento y consulta el estado del motor.');
      console.log('Administrador: jradmin. Contraseña inicial solo en runtime/secrets/admin-password (0600), consultar por SSH. Cambia la contraseña al entrar y elimina el archivo inicial después de comprobar el cambio.');
    }
  }
} catch (error) { fail(error); }
