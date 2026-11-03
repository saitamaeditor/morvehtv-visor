// Quién puede entrar. Sin PIN:
//  · En casa (tu PC): entran este ordenador y los aparatos de la red local (móvil, tablet,
//    tele). Desde internet no se puede entrar.
//  · En la nube (Render): entra todo el mundo que tenga la dirección.
import os from 'node:os';

export const NUBE = Boolean(process.env.RENDER || process.env.VISOR_NUBE === '1');

// Detrás del proxy de Render la IP real llega en x-forwarded-for
const ipDe = (req) =>
  (NUBE ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '') ||
  (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');

// Solo direcciones de red doméstica: 10.x, 172.16-31.x, 192.168.x, enlace local e IPv6 privadas
function esPrivada(ip) {
  if (/^(10|127)\./.test(ip) || /^192\.168\./.test(ip) || /^169\.254\./.test(ip)) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m) return Number(m[1]) >= 16 && Number(m[1]) <= 31;
  return /^(::1$|f[cd]|fe80)/i.test(ip);
}

// 'ok' | 'fuera' (en casa, alguien que no es de la red local)
export function permiso(req) {
  return NUBE || esPrivada(ipDe(req)) ? 'ok' : 'fuera';
}

// Direcciones con las que los demás dispositivos de casa llegan a este ordenador
// (sin los adaptadores virtuales de WSL, Hyper-V, VirtualBox, VMware o Docker; las 192.168.x primero)
export function direcciones(puerto) {
  if (NUBE) return [];
  return Object.entries(os.networkInterfaces())
    .filter(([nombre]) => !/vEthernet|WSL|Hyper-V|VirtualBox|VMware|docker|Loopback|Tailscale|ZeroTier/i.test(nombre))
    .flatMap(([, lista]) => lista)
    .filter((i) => i.family === 'IPv4' && !i.internal && esPrivada(i.address) && !i.address.startsWith('169.254.'))
    .sort((a, b) => b.address.startsWith('192.168.') - a.address.startsWith('192.168.'))
    .map((i) => `http://${i.address}:${puerto}`);
}
