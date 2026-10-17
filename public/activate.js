const $ = id => document.getElementById(id);
let code = ''; let expiry = 0;
async function request(path, input) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(20000) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'No se pudo vincular la TV.'); return result;
}
async function checkCode() {
  $('device-message').textContent = 'Comprobando el código…';
  try {
    const info = await request('/api/tv/link/info', { code: $('device-code').value });
    code = info.code; expiry = info.expiresAt; $('device-name').textContent = info.name; $('device-confirm-code').textContent = `Código en tu TV: ${code.slice(0, 4)}-${code.slice(4)}`; $('device-code-form').hidden = true; $('device-approve-form').hidden = false;
    $('device-message').textContent = 'Comprueba que esta sea tu TV y vincula tu cuenta.'; $('device-user').focus();
    try { const response = await fetch('/api/session'); if (response.ok) { const session = await response.json(); $('device-user').value = session.user.Name; $('device-password').focus(); } } catch {}
  } catch (error) { $('device-message').textContent = error.message; }
}
$('device-code-form').addEventListener('submit', event => { event.preventDefault(); void checkCode(); });
$('device-cancel').addEventListener('click', () => { $('device-password').value = ''; $('device-approve-form').hidden = true; $('device-code-form').hidden = false; $('device-message').textContent = 'Vinculación cancelada. No se dio acceso a la TV.'; });
$('device-approve-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; if (Date.now() >= expiry) { $('device-message').textContent = 'El código caducó. Genera otro en la TV.'; return; }
  button.disabled = true; $('device-message').textContent = 'Vinculando tu cuenta…';
  try {
    await request('/api/tv/link/approve', { code, username: $('device-user').value.trim(), password: $('device-password').value });
    $('device-approve-form').hidden = true; $('device-success').hidden = false; $('device-message').textContent = 'Cuenta vinculada correctamente.';
  } catch (error) { $('device-message').textContent = error.message; }
  finally { $('device-password').value = ''; button.disabled = false; }
});
const linked = new URLSearchParams(location.hash.slice(1)).get('code');
if (linked) { $('device-code').value = linked; history.replaceState(null, '', '/activate'); void checkCode(); }
