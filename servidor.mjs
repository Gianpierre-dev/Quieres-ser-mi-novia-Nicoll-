import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const PUERTO = Number(process.env.PORT ?? 8080);
const CLAVE_PANEL = process.env.PANEL_CLAVE ?? '';
const LIMITE_CUERPO_BYTES = 1024;
const ZONA_HORARIA = 'America/Lima';
const PATRON_VISITA = /^[a-f0-9-]{36}$/;
const NOMBRE_COOKIE = 'sesion_panel';
const DURACION_SESION_MS = 7 * 24 * 60 * 60 * 1000;
const TRAZO_CORAZON = 'M12 21s-7.5-4.6-9.6-9.2C.9 8.3 2.9 4.5 6.6 4.5c2.2 0 3.9 1.2 5.4 3.2 1.5-2 3.2-3.2 5.4-3.2 3.7 0 5.7 3.8 4.2 7.3C19.5 16.4 12 21 12 21z';

const ETIQUETAS_EVENTO = {
  abrir_pagina: 'Abrió el enlace',
  abrir_carta: 'Abrió la carta',
  ver_pregunta: 'Llegó a la pregunta',
  clic_no: 'Tocó «No»',
  clic_si: 'Tocó «Sí»',
};

const ARCHIVOS_PUBLICOS = {
  '/': { nombre: 'index.html', tipo: 'text/html; charset=utf-8' },
  '/index.html': { nombre: 'index.html', tipo: 'text/html; charset=utf-8' },
  '/confeti.min.js': { nombre: 'confeti.min.js', tipo: 'text/javascript; charset=utf-8' },
  '/vista-previa.png': { nombre: 'vista-previa.png', tipo: 'image/png' },
};

const CABECERAS_PANEL = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
};

const baseDeDatos = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// Sesiones activas del panel: token aleatorio -> momento de vencimiento.
const sesiones = new Map();

const formatoFecha = new Intl.DateTimeFormat('es-PE', {
  timeZone: ZONA_HORARIA,
  day: '2-digit',
  month: '2-digit',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
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

/* ---------- Autenticación del panel ---------- */

function claveValida(claveRecibida) {
  if (!CLAVE_PANEL || !claveRecibida) return false;
  const esperada = Buffer.from(CLAVE_PANEL);
  const recibida = Buffer.from(claveRecibida);
  return esperada.length === recibida.length && timingSafeEqual(esperada, recibida);
}

function tokenDeLaPeticion(peticion) {
  const cookies = (peticion.headers.cookie ?? '').split(';');
  for (const cookie of cookies) {
    const [nombre, valor] = cookie.trim().split('=');
    if (nombre === NOMBRE_COOKIE) return valor ?? '';
  }
  return '';
}

function sesionActiva(peticion) {
  const token = tokenDeLaPeticion(peticion);
  const vencimiento = sesiones.get(token);
  if (!vencimiento) return false;
  if (vencimiento < Date.now()) {
    sesiones.delete(token);
    return false;
  }
  return true;
}

function cookieDeSesion(token, duracionSegundos) {
  return `${NOMBRE_COOKIE}=${token}; Path=/panel; Max-Age=${duracionSegundos}; HttpOnly; Secure; SameSite=Strict`;
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

/* ---------- Tarjeta pública ---------- */

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

/* ---------- Vistas del panel ---------- */

const ICONO_CORAZON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${TRAZO_CORAZON}"/></svg>`;

const ESTILOS_PANEL = `
  :root {
    --rosa-pastel: #ffd3e4;
    --rosa-papel: #fff0f6;
    --lila: #dcc7ff;
    --lila-fuerte: #b993f5;
    --morado: #5b1fa6;
    --morado-oscuro: #35105f;
    --rojo: #e0173f;
    --rojo-oscuro: #b50d30;
    --rojo-texto: #d60f3b;
    --vino: #6a0824;
    --salida-suave: cubic-bezier(0.16, 1, 0.3, 1);
  }
  *, *::before, *::after { box-sizing: border-box; }
  ::selection { background: var(--rojo); color: var(--rosa-papel); }
  body {
    margin: 0;
    min-height: 100dvh;
    padding: 40px 16px 56px;
    font-family: "Figtree", system-ui, sans-serif;
    color: var(--morado-oscuro);
    background: linear-gradient(135deg, var(--rosa-pastel), var(--lila), var(--rosa-pastel), var(--lila-fuerte));
    background-size: 300% 300%;
    background-attachment: fixed;
    animation: fondo-vivo 16s ease-in-out infinite;
  }
  body.centrado { display: grid; place-items: center; padding-block: 24px; }
  h1, h2 { font-family: "Fraunces", Georgia, serif; font-weight: 700; text-wrap: balance; }
  .hoja {
    position: relative;
    width: min(100%, 720px);
    margin: 0 auto;
    padding: 48px 20px 28px;
    background: var(--rosa-papel);
    border: 2px solid var(--lila);
    border-radius: 28px;
    box-shadow: 0 2px 0 #fff inset, 0 18px 40px -12px rgba(91, 31, 166, 0.45), 0 40px 80px -30px rgba(224, 23, 63, 0.35);
    animation: entrar 800ms var(--salida-suave) both;
  }
  .hoja.ingreso { width: min(100%, 400px); text-align: center; }
  .emblema {
    position: absolute;
    top: -30px;
    left: 50%;
    width: 60px;
    height: 60px;
    margin-left: -30px;
    display: grid;
    place-items: center;
    background: var(--rosa-papel);
    border: 2px solid var(--lila);
    border-radius: 50%;
    box-shadow: 0 8px 18px -8px rgba(91, 31, 166, 0.6);
  }
  .emblema svg { width: 30px; height: 30px; fill: var(--rojo); animation: latido 1.2s ease-in-out infinite; }
  h1 { margin: 0; font-size: clamp(1.75rem, 7vw, 2.25rem); line-height: 1.15; color: var(--rojo-texto); text-align: center; }
  h2 { margin: 36px 0 12px; font-size: 1.3rem; color: var(--vino); }
  .bajada { margin: 8px 0 0; text-align: center; font-weight: 600; }
  .boton {
    min-height: 48px;
    padding: 12px 22px;
    font: inherit;
    font-weight: 700;
    border-radius: 999px;
    border: 2px solid transparent;
    cursor: pointer;
    text-decoration: none;
    display: inline-grid;
    place-items: center;
    transition: background-color 200ms ease, transform 200ms var(--salida-suave);
  }
  .boton:focus-visible, input:focus-visible { outline: 3px solid var(--morado); outline-offset: 3px; }
  .boton:active { transform: scale(0.97); }
  .boton-principal { background: var(--rojo); color: #fff; box-shadow: 0 10px 22px -8px rgba(224, 23, 63, 0.75); }
  .boton-principal:hover { background: var(--rojo-oscuro); }
  .boton-secundario { background: #fff; color: var(--morado); border-color: var(--lila-fuerte); }
  .boton-secundario:hover { background: var(--lila); }
  .boton-discreto { background: transparent; color: var(--vino); border-color: transparent; }
  .boton-discreto:hover { background: rgba(185, 147, 245, 0.25); }
  form { margin: 0; }

  .campo { display: grid; gap: 8px; margin-top: 28px; text-align: left; }
  .campo label { font-weight: 700; }
  .campo input {
    width: 100%;
    min-height: 52px;
    padding: 12px 18px;
    font: inherit;
    font-size: 1.125rem;
    color: var(--morado-oscuro);
    background: #fff;
    border: 2px solid var(--lila-fuerte);
    border-radius: 16px;
    caret-color: var(--rojo);
  }
  .error { margin: 12px 0 0; font-weight: 700; color: var(--rojo-oscuro); text-align: left; }
  .ingreso .boton { width: 100%; margin-top: 20px; }

  .acciones { display: flex; flex-wrap: wrap; justify-content: center; gap: 12px; margin-top: 24px; }
  .contadores { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin: 28px 0 0; padding: 0; list-style: none; }
  .contadores li {
    padding: 16px;
    background: #fff;
    border: 2px solid var(--lila);
    border-radius: 18px;
    animation: entrar 700ms var(--salida-suave) both;
    animation-delay: calc(200ms + var(--orden) * 90ms);
  }
  .contadores strong { display: block; font-family: "Fraunces", Georgia, serif; font-size: 2.6rem; line-height: 1; color: var(--rojo-texto); font-variant-numeric: tabular-nums; }
  .contadores span { display: block; margin-top: 6px; font-weight: 700; }
  .contadores .destacado { background: var(--rojo); border-color: var(--rojo); }
  .contadores .destacado strong, .contadores .destacado span { color: #fff; }
  .tabla { overflow-x: auto; border: 2px solid var(--lila); border-radius: 18px; background: #fff; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { padding: 12px 10px; text-align: left; white-space: nowrap; font-size: 0.9375rem; }
  th { font-size: 0.875rem; color: var(--vino); background: var(--rosa-papel); }
  tbody tr + tr td { border-top: 1px solid var(--lila); }
  .vacio { margin: 0; padding: 24px 16px; text-align: center; font-weight: 600; }
  .pie { display: flex; justify-content: center; margin-top: 24px; }

  dialog {
    width: min(calc(100% - 32px), 380px);
    padding: 44px 22px 24px;
    text-align: center;
    color: var(--morado-oscuro);
    background: var(--rosa-papel);
    border: 2px solid var(--lila);
    border-radius: 28px;
    box-shadow: 0 30px 70px -20px rgba(53, 16, 95, 0.8);
    overflow: visible;
  }
  dialog[open] { animation: brotar 500ms var(--salida-suave) both; }
  dialog::backdrop { background: rgba(53, 16, 95, 0.55); backdrop-filter: blur(6px); }
  dialog h2 { margin: 0; font-size: 1.5rem; color: var(--rojo-texto); }
  dialog p { margin: 10px 0 0; font-weight: 600; }
  dialog .acciones { margin-top: 22px; }

  @media (min-width: 640px) {
    .hoja { padding: 60px 40px 36px; }
    .contadores { grid-template-columns: repeat(4, 1fr); }
  }

  @keyframes fondo-vivo { 0%, 100% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } }
  @keyframes entrar { from { opacity: 0; transform: translateY(18px) scale(0.96); } to { opacity: 1; transform: translateY(0) scale(1); } }
  @keyframes brotar { 0% { opacity: 0; transform: scale(0.7); } 60% { opacity: 1; transform: scale(1.04); } 100% { opacity: 1; transform: scale(1); } }
  @keyframes latido { 0%, 100% { transform: scale(1); } 15% { transform: scale(1.28); } 30% { transform: scale(1); } 45% { transform: scale(1.18); } 60% { transform: scale(1); } }
`;

function plantilla({ titulo, claseCuerpo = '', contenido }) {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <meta name="theme-color" content="#ffd3e4">
  <title>${escaparHtml(titulo)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,700&family=Figtree:wght@400;600;700&display=swap" rel="stylesheet">
  <style>${ESTILOS_PANEL}</style>
</head>
<body class="${claseCuerpo}">
${contenido}
</body>
</html>`;
}

function construirIngreso({ conError = false } = {}) {
  const error = conError
    ? '<p class="error" id="error-clave" role="alert">La contraseña no es correcta. Inténtalo de nuevo.</p>'
    : '';

  return plantilla({
    titulo: 'Ingresar al panel',
    claseCuerpo: 'centrado',
    contenido: `
  <main class="hoja ingreso">
    <div class="emblema">${ICONO_CORAZON}</div>
    <h1>Panel de la tarjeta</h1>
    <p class="bajada">Ingresa tu contraseña para ver la actividad.</p>
    <form method="post" action="/panel/entrar">
      <div class="campo">
        <label for="clave">Contraseña</label>
        <input type="password" id="clave" name="clave" autocomplete="current-password" required autofocus${conError ? ' aria-invalid="true" aria-describedby="error-clave"' : ''}>
      </div>
      ${error}
      <button type="submit" class="boton boton-principal">Entrar</button>
    </form>
  </main>`,
  });
}

function numerarVisitas(eventos) {
  const numeros = new Map();
  for (const evento of eventos) {
    if (evento.visita && !numeros.has(evento.visita)) numeros.set(evento.visita, numeros.size + 1);
  }
  return numeros;
}

function resumenDeActividad(totalAcciones, totalVisitas) {
  const acciones = totalAcciones === 1 ? '1 acción registrada' : `${totalAcciones} acciones registradas`;
  const visitas = totalVisitas === 1 ? '1 visita' : `${totalVisitas} visitas`;
  return `${acciones} en ${visitas}.`;
}

function construirPanel(eventos) {
  const conteos = Object.fromEntries(Object.keys(ETIQUETAS_EVENTO).map((tipo) => [tipo, 0]));
  for (const evento of eventos) conteos[evento.tipo] += 1;

  const visitas = numerarVisitas(eventos);
  const contadores = Object.entries(ETIQUETAS_EVENTO)
    .map(([tipo, etiqueta], orden) => {
      const clase = tipo === 'clic_si' && conteos[tipo] > 0 ? ' class="destacado"' : '';
      return `<li${clase} style="--orden: ${orden}"><strong>${conteos[tipo]}</strong><span>${escaparHtml(etiqueta)}</span></li>`;
    })
    .join('');

  const filas = eventos
    .toReversed()
    .map((evento) => {
      const visita = evento.visita ? `Visita ${visitas.get(evento.visita)}` : 'Sin identificar';
      return `<tr><td>${escaparHtml(formatoFecha.format(evento.creado_en))}</td><td>${escaparHtml(visita)}</td><td>${escaparHtml(ETIQUETAS_EVENTO[evento.tipo])}</td></tr>`;
    })
    .join('');

  const historial = eventos.length
    ? `<table><thead><tr><th scope="col">Hora (Lima)</th><th scope="col">Visita</th><th scope="col">Acción</th></tr></thead><tbody>${filas}</tbody></table>`
    : '<p class="vacio">Todavía no hay actividad. Cuando abra la tarjeta, aparecerá aquí.</p>';

  return plantilla({
    titulo: 'Actividad de la tarjeta',
    contenido: `
  <main class="hoja">
    <div class="emblema">${ICONO_CORAZON}</div>
    <h1>Actividad de la tarjeta</h1>
    <p class="bajada">${resumenDeActividad(eventos.length, visitas.size)}</p>
    <div class="acciones">
      <a class="boton boton-principal" href="/panel">Actualizar</a>
      <button type="button" class="boton boton-secundario" id="abrir-reinicio">Reiniciar todo</button>
    </div>
    <ul class="contadores">${contadores}</ul>
    <h2>Historial</h2>
    <div class="tabla">${historial}</div>
    <div class="pie">
      <form method="post" action="/panel/salir">
        <button type="submit" class="boton boton-discreto">Cerrar sesión</button>
      </form>
    </div>
  </main>

  <dialog id="dialogo-reinicio" aria-labelledby="titulo-reinicio">
    <div class="emblema">${ICONO_CORAZON}</div>
    <h2 id="titulo-reinicio">¿Reiniciar todo?</h2>
    <p>Se borrarán los contadores y el historial. Esta acción no se puede deshacer.</p>
    <div class="acciones">
      <button type="button" class="boton boton-secundario" id="cancelar-reinicio">Cancelar</button>
      <form method="post" action="/panel/reiniciar">
        <button type="submit" class="boton boton-principal">Sí, reiniciar</button>
      </form>
    </div>
  </dialog>

  <script>
    const dialogoReinicio = document.getElementById('dialogo-reinicio');
    document.getElementById('abrir-reinicio').addEventListener('click', () => dialogoReinicio.showModal());
    document.getElementById('cancelar-reinicio').addEventListener('click', () => dialogoReinicio.close());
  </script>`,
  });
}

/* ---------- Acciones del panel ---------- */

async function mostrarPanel(respuesta) {
  const { rows: eventos } = await baseDeDatos.query('SELECT tipo, visita, creado_en FROM eventos ORDER BY creado_en ASC, id ASC');
  responder(respuesta, 200, construirPanel(eventos), CABECERAS_PANEL);
}

async function iniciarSesion(peticion, respuesta) {
  const cuerpo = await leerCuerpo(peticion);
  const clave = cuerpo === null ? '' : new URLSearchParams(cuerpo).get('clave') ?? '';
  if (!claveValida(clave)) return responder(respuesta, 401, construirIngreso({ conError: true }), CABECERAS_PANEL);

  const token = randomBytes(32).toString('hex');
  sesiones.set(token, Date.now() + DURACION_SESION_MS);
  return responder(respuesta, 303, '', {
    Location: '/panel',
    'Set-Cookie': cookieDeSesion(token, DURACION_SESION_MS / 1000),
    'Cache-Control': 'no-store',
  });
}

function cerrarSesion(peticion, respuesta) {
  sesiones.delete(tokenDeLaPeticion(peticion));
  responder(respuesta, 303, '', { Location: '/panel', 'Set-Cookie': cookieDeSesion('', 0), 'Cache-Control': 'no-store' });
}

async function reiniciarConteo(respuesta) {
  await baseDeDatos.query('TRUNCATE eventos RESTART IDENTITY');
  responder(respuesta, 303, '', { Location: '/panel', 'Cache-Control': 'no-store' });
}

async function atenderPanel(peticion, respuesta, ruta) {
  const metodo = peticion.method;

  if (metodo === 'GET' && ruta === '/panel') {
    if (!sesionActiva(peticion)) return responder(respuesta, 200, construirIngreso(), CABECERAS_PANEL);
    return mostrarPanel(respuesta);
  }

  if (metodo !== 'POST') return responder(respuesta, 404, 'No encontrado');
  if (!esDelMismoOrigen(peticion)) return responder(respuesta, 403, 'Origen no permitido');

  if (ruta === '/panel/entrar') return iniciarSesion(peticion, respuesta);
  if (!sesionActiva(peticion)) return responder(respuesta, 303, '', { Location: '/panel' });
  if (ruta === '/panel/reiniciar') return reiniciarConteo(respuesta);
  if (ruta === '/panel/salir') return cerrarSesion(peticion, respuesta);

  return responder(respuesta, 404, 'No encontrado');
}

async function atender(peticion, respuesta) {
  const { pathname: ruta } = new URL(peticion.url, 'http://localhost');

  if (peticion.method === 'GET' && Object.hasOwn(ARCHIVOS_PUBLICOS, ruta)) {
    return servirArchivo(respuesta, ARCHIVOS_PUBLICOS[ruta]);
  }
  if (peticion.method === 'POST' && ruta === '/api/eventos') return registrarEvento(peticion, respuesta);
  if (ruta === '/panel' || ruta.startsWith('/panel/')) return atenderPanel(peticion, respuesta, ruta);

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
