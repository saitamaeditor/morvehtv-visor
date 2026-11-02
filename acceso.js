// Quién puede entrar.
//  · En casa (tu PC): el propio ordenador entra directo; móvil, tablet y tele tienen que estar
//    en la red local y poner el PIN una vez. Desde internet no se puede entrar.
//  · En la nube (Render): todo el mundo necesita el PIN guardado en la variable VISOR_CLAVE
//    (nunca en el código: el repositorio es público).
// Al acertar se guarda una cookie firmada con el PIN: cambiarlo cierra todas las sesiones.
// Como un PIN corto se puede adivinar, además del límite por dispositivo hay uno global.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const COOKIE = 'morvehtv';
export const NUBE = Boolean(process.env.RENDER || process.env.VISOR_NUBE === '1');
let secreto;
const fallos = new Map(); // ip → { n, hasta }
// Fallos de todo el mundo en los últimos 10 minutos: con más de 30 se cierra la entrada un
// rato (frena a quien pruebe PINs desde muchas conexiones distintas)
let fallosGlobales = [];
const LIMITE_GLOBAL = 30;

export async function iniciar(dir) {
  await mkdir(path.join(dir, 'data'), { recursive: true });
  if (NUBE) {
    secreto = process.env.VISOR_CLAVE?.trim();
    if (!secreto || secreto.length < 4) {
      console.error('En la nube hace falta la variable VISOR_CLAVE (PIN de al menos 4 caracteres).');
      process.exit(1);
    }
    return;
  }
  const archivoPin = path.join(dir, 'data', 'pin.txt');
  secreto = process.env.VISOR_PIN?.trim();
  if (!secreto) {
    try {
      secreto = (await readFile(archivoPin, 'utf8')).trim();
    } catch {
      secreto = String(randomInt(0, 1e6)).padStart(6, '0');
      await writeFile(archivoPin, secreto);
    }
  }
}

export const elPin = () => (NUBE ? null : secreto);

// Detrás del proxy de Render la IP real llega en x-forwarded-for
const ipDe = (req) =>
  (NUBE ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '') ||
  (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
export const esLocal = (req) => !NUBE && ['127.0.0.1', '::1'].includes(ipDe(req));

// Solo direcciones de red doméstica: 10.x, 172.16-31.x, 192.168.x, enlace local e IPv6 privadas
function esPrivada(ip) {
  if (/^(10|127)\./.test(ip) || /^192\.168\./.test(ip) || /^169\.254\./.test(ip)) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m) return Number(m[1]) >= 16 && Number(m[1]) <= 31;
  return /^(::1$|f[cd]|fe80)/i.test(ip);
}

function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2),
  );
}

const firma = (id) => createHmac('sha256', secreto).update(id).digest('hex');
const igual = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

function cookieValida(req) {
  const [id, f] = String(cookies(req)[COOKIE] ?? '').split('.');
  return Boolean(id && f && igual(f, firma(id)));
}

// 'ok' | 'pin' (falta entrar con el PIN o la contraseña) | 'fuera' (no es de la red de casa)
export function permiso(req) {
  if (esLocal(req)) return 'ok';
  if (!NUBE && !esPrivada(ipDe(req))) return 'fuera';
  return cookieValida(req) ? 'ok' : 'pin';
}

export async function entrar(req, res) {
  const ip = ipDe(req);
  const f = fallos.get(ip);
  fallosGlobales = fallosGlobales.filter((t) => t > Date.now() - 10 * 60000);
  if (fallosGlobales.length >= LIMITE_GLOBAL) {
    res.writeHead(429, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: 'Demasiados intentos fallidos. Prueba dentro de 10 minutos.' }));
  }
  if (f && f.n >= 5 && f.hasta > Date.now()) {
    res.writeHead(429, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: 'Demasiados intentos. Espera 10 minutos.' }));
  }
  let cuerpo = '';
  for await (const trozo of req) {
    cuerpo += trozo;
    if (cuerpo.length > 1000) break;
  }
  const dado = String(new URLSearchParams(cuerpo).get('pin') ?? '').trim();
  if (!igual(dado, secreto)) {
    fallos.set(ip, { n: (f?.hasta > Date.now() ? f.n : 0) + 1, hasta: Date.now() + 10 * 60000 });
    fallosGlobales.push(Date.now());
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: 'PIN incorrecto' }));
  }
  fallos.delete(ip);
  const id = randomBytes(16).toString('hex');
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'set-cookie': `${COOKIE}=${id}.${firma(id)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${NUBE ? '; Secure' : ''}`,
  });
  res.end(JSON.stringify({ ok: true }));
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
