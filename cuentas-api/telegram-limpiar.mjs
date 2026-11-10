// Borra del grupo de Telegram todos los anuncios del bot y deja la cola vacía. Lo lanza
// telegram-limpiar.sh con el panel PARADO (este script escribe datos.json).
//  · Borra los temas de las bibliotecas (deleteForumTopic se lleva todos sus mensajes);
//    «Chat», «Avisos» y «General» se quedan.
//  · Todo lo que hay ahora en Emby pasa a «conocido» y la cola se vacía: al volver a arrancar,
//    el bot crea los temas otra vez, vacíos, y solo avisa de lo que llegue a partir de ahora.
import fs from 'node:fs/promises';
import * as emby from './emby.js';

const DATOS = process.env.DATOS ?? '/datos/datos.json';
const TOKEN = process.env.TELEGRAM_TOKEN ?? '';
const API = process.env.TELEGRAM_API ?? 'https://api.telegram.org';
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const datos = JSON.parse(await fs.readFile(DATOS, 'utf8'));
const t = datos.telegram;
if (!t?.chat) { console.log('Telegram no tiene grupo todavía: no hay nada que borrar'); process.exit(0); }
if (!TOKEN) { console.error('Falta TELEGRAM_TOKEN'); process.exit(1); }

// Antes de tocar nada, lo que hay en Emby (si Emby no responde, no se borra nada)
const libs = ((await emby.consultar('/Library/VirtualFolders')) ?? []).filter((b) => b.ItemId);
const conocidos = {};
let total = 0;
for (const b of libs) {
  const r = await emby.consultar(`/Items?ParentId=${encodeURIComponent(b.ItemId)}&Recursive=true&IncludeItemTypes=Movie,Series,Episode&Fields=SeriesId&EnableImages=false&EnableUserData=false`);
  conocidos[String(b.ItemId)] = (r?.Items ?? []).map((x) => String(x.Id));
  total += conocidos[String(b.ItemId)].length;
}
console.log(`== Emby: ${libs.length} bibliotecas, ${total} elementos (quedan como ya avisados)`);

console.log('== Borrando los temas de las bibliotecas');
const quedan = {};
for (const [clave, tema] of Object.entries(t.temas ?? {})) {
  let r;
  for (let i = 0; i < 5; i++) {
    r = await (await fetch(`${API}/bot${TOKEN}/deleteForumTopic`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: t.chat, message_thread_id: tema.id }),
    })).json().catch(() => ({ ok: false, description: 'sin respuesta' }));
    if (r.ok || !r.parameters?.retry_after) break;
    await espera((r.parameters.retry_after + 1) * 1000);
  }
  if (r.ok || /not found|TOPIC_ID_INVALID/i.test(r.description ?? '')) console.log(`   ✓ «${tema.nombre}»`);
  else { console.log(`   ✗ «${tema.nombre}»: ${r.description}`); quedan[clave] = tema; }
  await espera(1000);
}

t.temas = quedan;
t.conocidos = conocidos;
t.esperando = {}; t.todo = {}; t.altas = {};
delete t.pedirTodo;
await fs.writeFile(`${DATOS}.limpiar`, JSON.stringify(datos, null, 2));
await fs.rename(`${DATOS}.limpiar`, DATOS);
console.log(Object.keys(quedan).length ? `Hecho, pero ${Object.keys(quedan).length} temas no se pudieron borrar (¿el bot es administrador con permiso de borrar?)` : 'Hecho: anuncios borrados y cola vacía');
