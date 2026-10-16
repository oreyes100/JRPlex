import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

function publicIPv4(address) {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}

// UDP has no HTTP redirect chain. Resolve once and pass a public numeric
// address to qBittorrent so a later DNS rebind cannot target private services.
export async function publicTrackers(values = [], { lookup = dnsLookup, timeout = 3000 } = {}) {
  const resolved = await Promise.all([...new Set(values)].slice(0, 24).map(async value => {
    let timer;
    try {
      if (typeof value !== 'string' || value.length > 1024) return null;
      const url = new URL(value);
      if (url.protocol !== 'udp:' || url.username || url.password || url.hash || !url.port || /[\r\n]/.test(value)) return null;
      const host = url.hostname.toLowerCase();
      const addresses = isIP(host) ? [{ address: host }] : await Promise.race([
        lookup(host, { all: true, family: 4 }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS timeout')), timeout); }),
      ]);
      if (!addresses.length || addresses.some(row => !publicIPv4(row.address))) return null;
      url.hostname = addresses[0].address;
      return url.href;
    } catch { return null; }
    finally { clearTimeout(timer); }
  }));
  return [...new Set(resolved.filter(Boolean))];
}
