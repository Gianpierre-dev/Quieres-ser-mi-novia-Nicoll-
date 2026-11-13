import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const PUERTO = Number(process.env.PORT ?? 8080);
const CLAVE_PANEL = process.env.PANEL_CLAVE ?? '';
const LIMITE_CUERPO_BYTES = 1024;
const ZONA_HORARIA = 'America/Lima';
const PATRON_VISITA = /^[a-f0-9-]{36}$/;

const ETIQUETAS_EVENTO = {
  abrir_pagina: 'Abrió el enlace',
  abrir_carta: 'Abrió la carta',
  clic_no: 'Tocó «No»',
  clic_si: 'Tocó «Sí»',
};

const ARCHIVOS_PUBLICOS = {
  '/': { nombre: 'index.html', tipo: 'text/html; charset=utf-8' },
  '/index.html': { nombre: 'index.html', tipo: 'text/html; charset=utf-8' },
  '/confeti.min.js': { nombre: 'confeti.min.js', tipo: 'text/javascript; charset=utf-8' },
};

const baseDeDatos = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const formatoFecha = new Intl.DateTimeFormat('es-PE', {
  timeZone: ZONA_HORARIA,
  dateStyle: 'short',
  timeStyle: 'medium',
});

async function prepararBaseDeDatos() {
  await baseDeDatos.query(`
    CREATE TABLE IF NOT EXISTS eventos (
      id BIGSERIAL PRIMARY KEY,
      tipo TEXT NOT NULL,
      visita TEXT,
      creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

function responder(respuesta, estado, cuerpo = '', cabeceras = {}) {
  respuesta.writeHead(estado, cabeceras);
  respuesta.end(cuerpo);
}

function escaparHtml(texto) {
  return String(texto)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function claveValida(claveRecibida) {
  if (!CLAVE_PANEL || !claveRecibida) return false;
  const esperada = Buffer.from(CLAVE_PANEL);
  const recibida = Buffer.from(claveRecibida);
  return esperada.length === recibida.length && timingSafeEqual(esperada, recibida);
}

// La clave viaja en la cabecera Authorization (HTTP Basic), nunca en la URL.
function claveDeLaPeticion(peticion) {
  const [esquema, credenciales] = (peticion.headers.authorization ?? '').split(' ');
  if (esquema !== 'Basic' || !credenciales) return '';
  const decodificado = Buffer.from(credenciales, 'base64').toString('utf8');
  const separador = decodificado.indexOf(':');
  return separador === -1 ? '' : decodificado.slice(separador + 1);
}

// Evita que otro sitio dispare acciones del panel aprovechando la sesión del navegador.
function esDelMismoOrigen(peticion) {
  const sitio = peticion.headers['sec-fetch-site'];
  if (sitio) return sitio === 'same-origin';
  const origen = peticion.headers.origin;
  if (!origen) return false;
  try {
    return new URL(origen).host === peticion.headers.host;
  } catch {
    return false;
  }
}

async function leerCuerpo(peticion) {
  const fragmentos = [];
  let total = 0;
  for await (const fragmento of peticion) {
    total += fragmento.length;
    if (total > LIMITE_CUERPO_BYTES) return null;
    fragmentos.push(fragmento);
  }
  return Buffer.concat(fragmentos).toString('utf8');
}

async function servirArchivo(respuesta, archivo) {
  const ruta = fileURLToPath(new URL(archivo.nombre, import.meta.url));
  const contenido = await readFile(ruta);
  responder(respuesta, 200, contenido, { 'Content-Type': archivo.tipo, 'Cache-Control': 'no-cache' });
}

async function registrarEvento(peticion, respuesta) {
  const cuerpo = await leerCuerpo(peticion);
  if (cuerpo === null) return responder(respuesta, 413);

  let datos;
  try {
    datos = JSON.parse(cuerpo);
  } catch {
    return responder(respuesta, 400);
  }

  if (!Object.hasOwn(ETIQUETAS_EVENTO, datos?.tipo)) return responder(respuesta, 400);
  const visita = typeof datos.visita === 'string' && PATRON_VISITA.test(datos.visita) ? datos.visita : null;

  await baseDeDatos.query('INSERT INTO eventos (tipo, visita) VALUES ($1, $2)', [datos.tipo, visita]);
  return responder(respuesta, 204);
}

function numerarVisitas(eventos) {
  const numeros = new Map();
  for (const evento of eventos) {
    if (evento.visita && !numeros.has(evento.visita)) numeros.set(evento.visita, numeros.size + 1);
  }
  return numeros;
}

function construirPanel(eventos) {
  const conteos = Object.fromEntries(Object.keys(ETIQUETAS_EVENTO).map((tipo) => [tipo, 0]));
  for (const evento of eventos) conteos[evento.tipo] += 1;

  const visitas = numerarVisitas(eventos);
  const tarjetas = Object.entries(ETIQUETAS_EVENTO)
    .map(([tipo, etiqueta]) => `<li><strong>${conteos[tipo]}</strong><span>${escaparHtml(etiqueta)}</span></li>`)
    .join('');

  const filas = eventos
    .toReversed()
    .map((evento) => {
      const visita = evento.visita ? `Visita ${visitas.get(evento.visita)}` : 'Sin identificar';
      return `<tr><td>${escaparHtml(formatoFecha.format(evento.creado_en))}</td><td>${escaparHtml(visita)}</td><td>${escaparHtml(ETIQUETAS_EVENTO[evento.tipo])}</td></tr>`;
    })
    .join('');

  const historial = eventos.length
    ? `<table><thead><tr><th scope="col">Fecha y hora (Lima)</th><th scope="col">Visita</th><th scope="col">Acción</th></tr></thead><tbody>${filas}</tbody></table>`
    : '<p>Todavía no hay actividad registrada.</p>';

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Actividad de la tarjeta</title>
  <style>
    body { margin: 0; padding: 24px 16px 48px; font-family: system-ui, sans-serif; color: #35105f; background: #fff0f6; }
    main { max-width: 720px; margin: 0 auto; }
    h1 { margin: 0 0 4px; font-size: 1.6rem; color: #b50d30; }
    h2 { margin: 32px 0 12px; font-size: 1.15rem; }
    p { margin: 0 0 16px; }
    ul { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin: 20px 0 0; padding: 0; list-style: none; }
    li { padding: 16px; background: #fff; border: 2px solid #dcc7ff; border-radius: 16px; }
    li strong { display: block; font-size: 2.2rem; line-height: 1; color: #b50d30; font-variant-numeric: tabular-nums; }
    li span { display: block; margin-top: 6px; font-weight: 600; }
    .tabla { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; background: #fff; font-variant-numeric: tabular-nums; }
    th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #dcc7ff; white-space: nowrap; }
    th { font-size: 0.875rem; }
    .acciones { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 16px; }
    .acciones form { margin: 0; }
    a.boton, button { padding: 12px 20px; font: inherit; font-weight: 700; border-radius: 999px; cursor: pointer; text-decoration: none; }
    a.boton { background: #5b1fa6; color: #fff; border: 2px solid #5b1fa6; }
    button { background: #fff; color: #b50d30; border: 2px solid #b50d30; }
    a.boton:focus-visible, button:focus-visible { outline: 3px solid #35105f; outline-offset: 3px; }
    @media (min-width: 640px) { ul { grid-template-columns: repeat(4, 1fr); } }
  </style>
</head>
<body>
  <main>
    <h1>Actividad de la tarjeta</h1>
    <p>Total de acciones registradas: ${eventos.length}. Visitas distintas: ${visitas.size}.</p>
    <div class="acciones">
      <a class="boton" href="/panel">Actualizar</a>
      <form method="post" action="/panel/reiniciar" onsubmit="return confirm('Se borrará todo el historial. ¿Deseas continuar?')">
        <button type="submit">Reiniciar todo</button>
      </form>
    </div>
    <ul>${tarjetas}</ul>
    <h2>Historial</h2>
    <div class="tabla">${historial}</div>
  </main>
</body>
</html>`;
}

async function mostrarPanel(respuesta) {
  const { rows: eventos } = await baseDeDatos.query('SELECT tipo, visita, creado_en FROM eventos ORDER BY creado_en ASC, id ASC');
  responder(respuesta, 200, construirPanel(eventos), {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
}

async function reiniciarConteo(respuesta) {
  await baseDeDatos.query('TRUNCATE eventos RESTART IDENTITY');
  responder(respuesta, 303, '', { Location: '/panel' });
}

function pedirCredenciales(respuesta) {
  responder(respuesta, 401, 'Se requiere la clave del panel', {
    'WWW-Authenticate': 'Basic realm="Panel de la tarjeta", charset="UTF-8"',
    'Cache-Control': 'no-store',
  });
}

async function atender(peticion, respuesta) {
  const { pathname: ruta } = new URL(peticion.url, 'http://localhost');

  if (peticion.method === 'GET' && Object.hasOwn(ARCHIVOS_PUBLICOS, ruta)) {
    return servirArchivo(respuesta, ARCHIVOS_PUBLICOS[ruta]);
  }
  if (peticion.method === 'POST' && ruta === '/api/eventos') return registrarEvento(peticion, respuesta);

  if (ruta === '/panel' || ruta === '/panel/reiniciar') {
    if (!claveValida(claveDeLaPeticion(peticion))) return pedirCredenciales(respuesta);
    if (peticion.method === 'GET' && ruta === '/panel') return mostrarPanel(respuesta);
    if (peticion.method === 'POST' && ruta === '/panel/reiniciar') {
      if (!esDelMismoOrigen(peticion)) return responder(respuesta, 403, 'Origen no permitido');
      return reiniciarConteo(respuesta);
    }
  }

  return responder(respuesta, 404, 'No encontrado');
}

const servidor = createServer((peticion, respuesta) => {
  atender(peticion, respuesta).catch((error) => {
    console.error('Error al atender la petición:', error);
    if (!respuesta.headersSent) responder(respuesta, 500, 'Error interno');
    else respuesta.end();
  });
});

await prepararBaseDeDatos();
servidor.listen(PUERTO, () => console.log(`Servidor escuchando en el puerto ${PUERTO}`));
