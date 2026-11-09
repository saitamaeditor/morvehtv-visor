// Administradores del panel, desde la VPS (habla con el servidor en marcha por su enchufe local).
//   docker exec -it morvehtv-cuentas node admin.mjs crear  <usuario>   → pide la contraseña
//   docker exec -it morvehtv-cuentas node admin.mjs clave  <usuario>   → igual (cambia la contraseña)
//   docker exec -it morvehtv-cuentas node admin.mjs quitar <usuario>
//   docker exec    morvehtv-cuentas node admin.mjs lista
//   docker exec    morvehtv-cuentas node admin.mjs avisar-todo [biblioteca]   → Telegram avisa de todo lo que hay en Emby (o en esa biblioteca)
// La contraseña también puede llegar por la entrada estándar (una línea), sin que se vea.
import http from 'node:http';
import path from 'node:path';

const DATOS = process.env.DATOS ?? '/datos/datos.json';
const ENCHUFE = process.env.CONTROL ?? path.join(path.dirname(DATOS), 'control.sock');
const [orden, usuario] = process.argv.slice(2);

function pedir(datos) {
  return new Promise((ok, mal) => {
    const req = http.request({ socketPath: ENCHUFE, path: '/', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; });
      res.on('end', () => { const d = JSON.parse(t || '{}'); res.statusCode === 200 ? ok(d) : mal(new Error(d.error || `Error ${res.statusCode}`)); });
    });
    req.on('error', (e) => mal(new Error(`No se pudo hablar con el servidor (¿está arrancado?): ${e.message}`)));
    req.end(JSON.stringify(datos));
  });
}

// Lee una línea sin mostrarla (si es una terminal) o de la entrada estándar
function leerClave(pregunta) {
  return new Promise((ok) => {
    const ent = process.stdin;
    if (!ent.isTTY) {
      let t = ''; ent.setEncoding('utf8');
      ent.on('data', (c) => { t += c; });
      ent.on('end', () => ok(t.replace(/^﻿/, '').split(/\r?\n/)[0]));
      return;
    }
    process.stdout.write(pregunta);
    ent.setRawMode(true); ent.resume(); ent.setEncoding('utf8');
    let t = '';
    const tecla = (c) => {
      for (const ch of c) {
        if (ch === '\r' || ch === '\n') { ent.setRawMode(false); ent.pause(); ent.off('data', tecla); process.stdout.write('\n'); return ok(t); }
        if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') t = t.slice(0, -1); else t += ch;
      }
    };
    ent.on('data', tecla);
  });
}

try {
  if (orden === 'lista') {
    const { admins } = await pedir({ accion: 'lista' });
    console.log(admins.length ? admins.join('\n') : '(ningún administrador todavía)');
  } else if ((orden === 'crear' || orden === 'clave') && usuario) {
    const clave = await leerClave('Contraseña (mín. 10 caracteres, no se ve al escribir): ');
    if (process.stdin.isTTY && clave !== await leerClave('Repítela: ')) throw new Error('Las contraseñas no coinciden');
    const r = await pedir({ accion: 'poner', usuario, clave });
    console.log(r.nuevo ? `Cuenta de administrador «${r.usuario}» creada.` : `Contraseña de «${r.usuario}» cambiada (sus sesiones se han cerrado).`);
  } else if (orden === 'avisar-todo') {
    const r = await pedir({ accion: 'telegram-todo', biblioteca: process.argv.slice(3).join(' ') });
    console.log(r.bibliotecas ? `Hecho: el bot de Telegram va a avisar de todo lo que hay en ${r.bibliotecas.map((x) => `«${x}»`).join(', ')},`
      : 'Hecho: el bot de Telegram va a avisar de TODO lo que hay en las bibliotecas de Emby,');
    console.log('una película o serie cada 3 segundos (Telegram no deja ir más rápido). Para ver cómo va:');
    console.log('  docker logs -f --since 1m morvehtv-cuentas 2>&1 | grep Telegram');
  } else if (orden === 'quitar' && usuario) {
    await pedir({ accion: 'quitar', usuario });
    console.log(`Administrador «${usuario.toLowerCase()}» quitado.`);
  } else {
    console.log('Uso: node admin.mjs crear|clave|quitar <usuario>  ·  node admin.mjs lista  ·  node admin.mjs avisar-todo [biblioteca]');
    process.exit(2);
  }
} catch (e) {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
}
