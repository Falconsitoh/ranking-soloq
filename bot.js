/**
 * ════════════════════════════════════════════════════════════════════
 *  NTI Tracker — Bot de SoloQ multiequipo para Discord
 *  League of Legends · SoloQ, Flex y normales
 *
 *  Cómo funciona:
 *   1. Un admin crea cada equipo con /equipo-crear y lo enlaza a un
 *      canal y a un rol de coach.
 *   2. Cada coach usa /agregar DENTRO del canal de su equipo. El jugador
 *      queda amarrado a ese equipo (y solo a ese).
 *   3. Cada ESCANEO_MINUTOS el bot revisa las partidas nuevas de cada jugador
 *      (SoloQ, Flex y normales) y manda la tarjeta ÚNICAMENTE al canal de su
 *      equipo. Si varios del mismo equipo jugaron juntos, sale UNA sola tarjeta
 *      en dorado con todos ellos.
 *   4. La tarjeta trae botones: página de la partida, OP.GG y Scoreboard.
 *      El Scoreboard se abre en privado solo para quien lo pulsa.
 *   5. Los coaches asignan tareas con /tarea (ej. "ganar 3 partidas con Ahri")
 *      y el bot las va marcando solo con cada partida.
 *
 *  Velocidad: las consultas a Riot usan los límites reales de tu key
 *  (se leen de las respuestas de Riot), los rangos del Scoreboard se
 *  precargan apenas termina la partida, y todas las imágenes y partidas
 *  quedan guardadas para no volver a pedirlas.
 * ════════════════════════════════════════════════════════════════════
 */

require('dotenv').config({ quiet: true });

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');
const { MongoClient } = require('mongodb');
const { Jimp } = require('jimp');
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  Events,
  InteractionContextType,
  EmbedBuilder,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
} = require('discord.js');

// ═════════════════════════ 1. CONFIGURACIÓN ═════════════════════════

// Las variables con prefijo LD_ tienen prioridad: así el bot puede vivir dentro de otro proyecto
// (por ejemplo, el mismo servicio del dashboard en Render) sin chocar con sus variables.
const env = (nombre) => process.env[`LD_${nombre}`] || process.env[nombre];
const DISCORD_TOKEN = env('DISCORD_TOKEN');
const GUILD_ID = env('GUILD_ID');
const RIOT_API_KEY = env('RIOT_API_KEY');
const MONGO_URI = env('MONGO_URI');
const MONGO_DB = env('MONGO_DB') || 'nti_tracker';
// true si se ejecuta con "node bot.js"; false si otro archivo lo carga con require('./bot.js')
const ES_PRINCIPAL = require.main === module;
const ESCANEO_MINUTOS = Number(process.env.ESCANEO_MINUTOS) || 5;
// Si Riot aún no actualizó los LP tras una partida, esperamos hasta N escaneos antes de avisar.
const MAX_ESPERAS_LP = 3;
// Si Discord no deja enviar una tarjeta (por ejemplo, el bot perdió acceso al canal), se reintenta
// en los siguientes escaneos en vez de perderla. Pasado este número de intentos (~1 hora), se descarta.
const MAX_REINTENTOS_AVISO = 12;
// Modos que se siguen. Se puede limitar en el .env, ej. MODOS=soloq,flex (por defecto: los tres).
const MODOS = {
  420: { clave: 'soloq', nombre: 'SoloQ', emoji: '🏆', ranked: true },
  440: { clave: 'flex', nombre: 'Flex', emoji: '👥', ranked: true },
  400: { clave: 'normal', nombre: 'Normal · Reclutamiento', emoji: '🎮', ranked: false },
  430: { clave: 'normal', nombre: 'Normal · A ciegas', emoji: '🎮', ranked: false },
  480: { clave: 'normal', nombre: 'Swiftplay', emoji: '⚡', ranked: false },
  490: { clave: 'normal', nombre: 'Partida rápida', emoji: '⚡', ranked: false },
};
const MODOS_ACTIVOS = new Set((process.env.MODOS || 'soloq,flex,normal').toLowerCase().split(',').map((m) => m.trim()));
/** Datos del modo de una cola, o null si ese modo no se sigue (ARAM, Arena...). */
const modoDeCola = (cola) => (MODOS[cola] && MODOS_ACTIVOS.has(MODOS[cola].clave) ? MODOS[cola] : null);
const NOMBRE_MODO_TAREA = { cualquiera: 'cualquier modo', soloq: 'SoloQ', flex: 'Flex', ranked: 'ranked (SoloQ o Flex)', normal: 'normales' };
// Qué partidas muestra cada equipo en su canal (se elige al crear el equipo o con /equipo-modos)
const OPCIONES_MODOS = {
  todas: { nombre: 'Todas (SoloQ, Flex y normales)', claves: ['soloq', 'flex', 'normal'] },
  ranked: { nombre: 'SoloQ y Flex', claves: ['soloq', 'flex'] },
  soloq: { nombre: 'Solo SoloQ', claves: ['soloq'] },
  flex: { nombre: 'Solo Flex', claves: ['flex'] },
  normal: { nombre: 'Solo normales', claves: ['normal'] },
};
const ELECCIONES_MODOS = Object.entries(OPCIONES_MODOS).map(([value, o]) => ({ name: o.nombre, value }));
const opcionModos = (equipo) => OPCIONES_MODOS[equipo.modos] ?? OPCIONES_MODOS.todas;
// Niveles del champion pool de cada jugador (/pool)
const NIVELES_POOL = {
  S: { emoji: '🟥', nombre: 'Main' },
  A: { emoji: '🟧', nombre: 'Muy cómodo' },
  B: { emoji: '🟨', nombre: 'Lo juega bien' },
  C: { emoji: '🟩', nombre: 'En práctica' },
};
const MAX_CAMPEONES_POOL = 40;
const OPCIONES_ROL = [
  { name: 'Top', value: 'TOP' }, { name: 'Jungla', value: 'JUNGLE' }, { name: 'Mid', value: 'MIDDLE' },
  { name: 'ADC', value: 'BOTTOM' }, { name: 'Support', value: 'UTILITY' },
];
const NOMBRE_ROL = Object.fromEntries(OPCIONES_ROL.map((o) => [o.value, o.name])); // 'MIDDLE' → 'Mid'
// Cuántas partidas procesadas recuerda cada jugador (para no anunciar dos veces la misma).
const MAX_PROCESADAS = 20;
// Partidas recientes en memoria, y días que se guardan en MongoDB para el botón de Scoreboard.
const MAX_PARTIDAS_EN_MEMORIA = 200;
const DIAS_GUARDAR_PARTIDAS = 7;
// Carpeta donde se guardan íconos, emblemas y fuentes descargados (se crea sola).
const CARPETA_CACHE = path.join(__dirname, 'cache');

// GUILD_ID ya no es obligatorio: el bot funciona en todos los servidores donde lo inviten
const VARIABLES_FALTANTES = Object.entries({ DISCORD_TOKEN, RIOT_API_KEY, MONGO_URI })
  .filter(([, valor]) => !valor)
  .map(([nombre]) => nombre);

const DDRAGON = 'https://ddragon.leagueoflegends.com';
const CDRAGON = 'https://raw.communitydragon.org/latest/plugins';

// plataforma → servidor (league-v4) · regional → clúster (account-v1 y match-v5)
// opgg y log → cómo escriben la región OP.GG y League of Graphs en sus enlaces
const REGIONES = {
  LAN: { plataforma: 'la1', regional: 'americas', opgg: 'lan', log: 'lan' },
  LAS: { plataforma: 'la2', regional: 'americas', opgg: 'las', log: 'las' },
  NA: { plataforma: 'na1', regional: 'americas', opgg: 'na', log: 'na' },
  BR: { plataforma: 'br1', regional: 'americas', opgg: 'br', log: 'br' },
};
// Inverso: 'la1' → 'LAN'. Sirve para detectar el servidor real desde el ID de una partida.
const REGION_POR_PLATAFORMA = Object.fromEntries(
  Object.entries(REGIONES).map(([clave, r]) => [r.plataforma, clave]),
);

const TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
const TIERS_APEX = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);
const DIVISIONES = { IV: 0, III: 1, II: 2, I: 3 };
const NOMBRE_TIER = {
  IRON: 'Hierro', BRONZE: 'Bronce', SILVER: 'Plata', GOLD: 'Oro', PLATINUM: 'Platino',
  EMERALD: 'Esmeralda', DIAMOND: 'Diamante', MASTER: 'Maestro', GRANDMASTER: 'Gran Maestro', CHALLENGER: 'Retador',
};
const TIER_CORTO = {
  IRON: 'Hierro', BRONZE: 'Bronce', SILVER: 'Plata', GOLD: 'Oro', PLATINUM: 'Plat',
  EMERALD: 'Esme', DIAMOND: 'Diam', MASTER: 'Master', GRANDMASTER: 'GM', CHALLENGER: 'Retador',
};
const DIVISION_NUMERO = { IV: 4, III: 3, II: 2, I: 1 };
const ORDEN_POSICIONES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];

const COLORES = {
  victoria: 0x2ecc71,
  rachaVictorias: 0x00d26a, // 3+ victorias seguidas
  equipo: 0xf1c40f, // dorado: jugó con compañeros de su propio equipo
  derrota: 0xe74c3c,
  rachaDerrotas: 0x7b1f1f, // 3+ derrotas seguidas
  info: 0x5865f2,
};

// Frase corta al pie de cada tarjeta, según el resultado y la racha.
const FRASES = {
  mvp: ['MVP de la partida ⭐', 'El mejor de los 10 ⭐', 'Carreó la partida ⭐'],
  rachaVictorias: ['¡Imparable! {n} victorias seguidas 🔥', 'Nadie lo para: {n} al hilo 🚀', 'Racha de {n}, que siga el tren 🚂'],
  victoria: ['Victoria limpia, LP al bolsillo 💰', 'Así se juega 💪', 'Un paso más hacia arriba 📈', 'GG WP, a seguir sumando ✅'],
  rachaDerrotas: ['{n} seguidas... un descanso y a volver con todo 🧘', 'Respira, revisa el replay y a remontar 💪'],
  derrota: ['Se viene la remontada 💪', 'Una mala no define la temporada', 'A revisar el replay y volver más fuerte 📼', 'La próxima es nuestra 🔄'],
};

// ═════════════════════════ 2. UTILIDADES ═════════════════════════

const dormir = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

/**
 * Convierte tier + división + LP en un número continuo para poder restar elos.
 * Hierro IV 0 LP = 0 · cada tier = 400 · cada división = 100.
 * Maestro, Gran Maestro y Retador comparten una sola escala de LP desde 2800.
 */
function obtenerEloAbsoluto(tier, division, lp) {
  if (TIERS_APEX.has(tier)) return 2800 + lp;
  return TIERS.indexOf(tier) * 400 + DIVISIONES[division] * 100 + lp;
}

/** Inverso aproximado de obtenerEloAbsoluto (para el promedio del lobby). */
function tierDesdeAbsoluto(abs) {
  if (abs >= 2800) return { tier: 'MASTER', texto: 'Maestro+' };
  const tier = TIERS[Math.max(0, Math.floor(abs / 400))];
  const division = ['IV', 'III', 'II', 'I'][Math.floor((abs % 400) / 100)];
  return { tier, texto: `${NOMBRE_TIER[tier]} ${division}` };
}

/** "Diamante IV" · "Maestro" (los tiers altos no tienen división). */
function nombreRango(perfil) {
  if (!perfil) return 'Sin clasificar';
  const tier = NOMBRE_TIER[perfil.tier] ?? perfil.tier;
  return TIERS_APEX.has(perfil.tier) ? tier : `${tier} ${perfil.division}`;
}

function formatearElo(perfil) {
  return perfil ? `${nombreRango(perfil)} · ${perfil.lp} LP` : 'Sin clasificar';
}

function calcularWinrate(perfil) {
  const total = perfil.wins + perfil.losses;
  return total ? Math.round((perfil.wins / total) * 100) : 0;
}

function textoRecord(perfil) {
  return perfil ? `${perfil.wins}V - ${perfil.losses}D (${calcularWinrate(perfil)}% WR)` : '—';
}

const formatearMiles = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n));
const formatearDuracion = (segundos) => `${Math.floor(segundos / 60)}m ${String(segundos % 60).padStart(2, '0')}s`;
const marcaDeTiempo = (ms) => `<t:${Math.floor(ms / 1000)}:R>`; // Discord lo muestra como "hace 2 horas"
const conSigno = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '±0');

/** "Faker#KR1" → { nombre: 'Faker', tag: 'KR1' } · null si el formato no sirve. */
function separarRiotId(texto) {
  const limpio = (texto ?? '').trim();
  const i = limpio.lastIndexOf('#');
  if (i <= 0 || i === limpio.length - 1) return null;
  return { nombre: limpio.slice(0, i).trim(), tag: limpio.slice(i + 1).trim() };
}

const riotIdEnMinusculas = (nombre, tag) => `${nombre}#${tag}`.toLowerCase();

function elegirFrase(yo, racha, semilla) {
  let lista = yo.gano ? FRASES.victoria : FRASES.derrota;
  if (racha >= 3) lista = FRASES.rachaVictorias;
  if (racha <= -3) lista = FRASES.rachaDerrotas;
  if (yo.etiqueta === 'MVP') lista = FRASES.mvp;
  let h = 0;
  for (const c of semilla) h = (h * 31 + c.charCodeAt(0)) >>> 0; // misma partida → misma frase
  return lista[h % lista.length].replace('{n}', Math.abs(racha));
}

const urlEmblema = (tier) =>
  `${CDRAGON}/rcp-fe-lol-static-assets/global/default/images/ranked-emblem/emblem-${tier.toLowerCase()}.png`;
const urlIconoCampeon = (championId) =>
  `${CDRAGON}/rcp-be-lol-game-data/global/default/v1/champion-icons/${championId}.png`;
const urlOpgg = (region, nombre, tag) =>
  `https://op.gg/lol/summoners/${REGIONES[region]?.opgg ?? 'lan'}/${encodeURIComponent(`${nombre}-${tag}`)}`;
const urlPartida = (region, gameId) =>
  `https://www.leagueofgraphs.com/match/${REGIONES[region]?.log ?? 'lan'}/${gameId}`;

// ═════════════════════════ 3. CLIENTE DE RIOT ═════════════════════════

class RiotError extends Error {
  constructor(status, mensaje) {
    super(mensaje);
    this.status = status;
  }
}

/*
 * Control de velocidad con los límites REALES de tu key.
 * Riot manda en cada respuesta la cabecera "X-App-Rate-Limit" (ej. "20:1,100:120" =
 * 20 por segundo y 100 cada 2 minutos). El bot la lee y se ajusta solo: con la key de
 * desarrollo o personal va a ese ritmo, y si algún día tienes una key de producción,
 * acelera sin tocar nada.
 *
 * Hay dos filas: "alta" (lo que pide una persona en Discord) y "normal" (el escaneo).
 * El escaneo solo usa hasta el 80 % del límite; el 20 % restante queda libre para que
 * los comandos y el Scoreboard respondan al instante aunque el escaneo esté corriendo.
 */
let limitesRiot = [{ max: 20, ventanaMs: 1_000 }, { max: 100, ventanaMs: 120_000 }];
const historialRiot = []; // momentos (ms) de las peticiones recientes, en orden
const filasRiot = { alta: [], normal: [] };
let atendiendoFila = false;
let pausaRiotHasta = 0; // si Riot responde 429, TODA la fila espera (no solo esa consulta)

/**
 * Si otra app usa la misma key (por ejemplo, el dashboard), Riot nos dice en cada respuesta
 * cuántas consultas lleva en total ("X-App-Rate-Limit-Count"). Las que no hicimos nosotros se
 * suman a nuestro conteo, así el bot se frena solo antes de chocar con el límite.
 */
function sincronizarConteo(cabecera) {
  if (!cabecera) return;
  const ahora = Date.now();
  for (const par of cabecera.split(',')) {
    const [usadas, segundos] = par.split(':').map(Number);
    const limite = limitesRiot.find((l) => l.ventanaMs === segundos * 1000);
    if (!limite || !(usadas > 0)) continue;
    const ajenas = Math.min(usadas - peticionesDesde(ahora - limite.ventanaMs), limite.max);
    for (let i = 0; i < ajenas; i++) historialRiot.push(ahora);
  }
}

function actualizarLimites(cabecera) {
  if (!cabecera) return;
  const nuevos = cabecera.split(',').map((par) => {
    const [max, segundos] = par.split(':').map(Number);
    return { max, ventanaMs: segundos * 1000 };
  }).filter((l) => l.max > 0 && l.ventanaMs > 0);
  if (!nuevos.length) return;
  const clave = (lista) => lista.map((l) => `${l.max}:${l.ventanaMs}`).join(',');
  if (clave(nuevos) !== clave(limitesRiot)) {
    limitesRiot = nuevos;
    console.log(`⚙️ Límites de tu key de Riot: ${nuevos.map((l) => `${l.max} cada ${l.ventanaMs / 1000}s`).join(' · ')}`);
  }
}

function peticionesDesde(momento) {
  // búsqueda binaria: cuántas peticiones hubo después de "momento"
  let bajo = 0;
  let alto = historialRiot.length;
  while (bajo < alto) {
    const medio = (bajo + alto) >> 1;
    if (historialRiot[medio] > momento) alto = medio;
    else bajo = medio + 1;
  }
  return historialRiot.length - bajo;
}

/** 0 si ya se puede pedir; si no, cuántos ms hay que esperar. */
function esperaNecesaria(prioridad, ahora) {
  const reserva = prioridad === 'alta' ? 0.95 : 0.8;
  let espera = 0;
  for (const { max, ventanaMs } of limitesRiot) {
    const permitido = Math.max(1, Math.floor(max * reserva));
    const usadas = peticionesDesde(ahora - ventanaMs);
    if (usadas >= permitido) {
      // hay que esperar a que salga de la ventana la petición que sobra
      const liberadora = historialRiot[historialRiot.length - permitido];
      espera = Math.max(espera, liberadora + ventanaMs - ahora + 5);
    }
  }
  return espera;
}

function esperarTurnoRiot(prioridad = 'normal') {
  return new Promise((resolver) => {
    filasRiot[prioridad === 'alta' ? 'alta' : 'normal'].push(resolver);
    atenderFila();
  });
}

async function atenderFila() {
  if (atendiendoFila) return;
  atendiendoFila = true;
  while (filasRiot.alta.length || filasRiot.normal.length) {
    const pausa = pausaRiotHasta - Date.now();
    if (pausa > 0) {
      await dormir(Math.min(pausa, 1_000));
      continue;
    }
    const prioridad = filasRiot.alta.length ? 'alta' : 'normal';
    const ahora = Date.now();
    const espera = esperaNecesaria(prioridad, ahora);
    if (espera > 0) {
      await dormir(Math.min(espera, 1_000)); // revisa seguido por si llega algo de prioridad alta
      continue;
    }
    historialRiot.push(ahora);
    const ventanaMayor = Math.max(...limitesRiot.map((l) => l.ventanaMs));
    while (historialRiot.length && historialRiot[0] < ahora - ventanaMayor) historialRiot.shift();
    filasRiot[prioridad].shift()();
  }
  atendiendoFila = false;
}

async function riotGet(url, prioridad = 'normal', intento = 1) {
  await esperarTurnoRiot(prioridad);
  try {
    const respuesta = await axios.get(url, {
      headers: { 'X-Riot-Token': RIOT_API_KEY },
      timeout: 10_000,
    });
    actualizarLimites(respuesta.headers?.['x-app-rate-limit']);
    sincronizarConteo(respuesta.headers?.['x-app-rate-limit-count']);
    return respuesta.data;
  } catch (err) {
    const status = err.response?.status;
    actualizarLimites(err.response?.headers?.['x-app-rate-limit']);
    sincronizarConteo(err.response?.headers?.['x-app-rate-limit-count']);

    // 429 = nos pasamos del límite (por ejemplo, otra app usa la misma key): Riot dice cuánto esperar
    if (status === 429 && intento <= 3) {
      const segundos = Number(err.response.headers?.['retry-after']) || 10;
      pausaRiotHasta = Math.max(pausaRiotHasta, Date.now() + segundos * 1000);
      console.warn(`⏳ Límite de Riot alcanzado, toda la fila espera ${segundos}s...`);
      return riotGet(url, prioridad, intento + 1);
    }
    // 5xx o sin respuesta = problema temporal de Riot o de red
    if ((!status || status >= 500) && intento <= 2) {
      await dormir(2000);
      return riotGet(url, prioridad, intento + 1);
    }
    throw new RiotError(status, err.response?.data?.status?.message || err.message);
  }
}

const riot = {
  cuentaPorRiotId: (nombre, tag, prioridad) =>
    riotGet(`https://americas.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(nombre)}/${encodeURIComponent(tag)}`, prioridad),
  // Las 5 partidas más recientes de cualquier modo (una sola consulta por jugador en cada escaneo)
  ultimasPartidas: (regional, puuid, prioridad) =>
    riotGet(`https://${regional}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=5`, prioridad),
  partida: (regional, partidaId, prioridad) =>
    riotGet(`https://${regional}.api.riotgames.com/lol/match/v5/matches/${partidaId}`, prioridad),
  ligas: (plataforma, puuid, prioridad) =>
    riotGet(`https://${plataforma}.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`, prioridad),
};

function perfilDesdeEntrada(entrada) {
  if (!entrada) return null;
  return {
    tier: entrada.tier,
    division: entrada.rank,
    lp: entrada.leaguePoints,
    wins: entrada.wins,
    losses: entrada.losses,
    abs: obtenerEloAbsoluto(entrada.tier, entrada.rank, entrada.leaguePoints),
  };
}

/** SoloQ y Flex del jugador con UNA sola consulta (null en la que no esté clasificado). */
async function obtenerPerfiles(plataforma, puuid, prioridad) {
  const entradas = await riot.ligas(plataforma, puuid, prioridad);
  return {
    soloq: perfilDesdeEntrada(entradas.find((e) => e.queueType === 'RANKED_SOLO_5x5')),
    flex: perfilDesdeEntrada(entradas.find((e) => e.queueType === 'RANKED_FLEX_SR')),
  };
}

const obtenerPerfilSoloQ = async (plataforma, puuid, prioridad) => (await obtenerPerfiles(plataforma, puuid, prioridad)).soloq;

// ═════════════════════════ 4. DATOS DEL JUEGO, IMÁGENES Y EMOJIS ═════════════════════════
// Nada de esto gasta la key de Riot: sale de Data Dragon y CommunityDragon (CDN públicos).

// Nombres en español de campeones, runas y hechizos, y el parche actual (para los íconos).
const estatico = { version: null, runas: new Map(), campeones: new Map(), hechizos: new Map() };
let proximaCargaEstatico = 0;

async function cargarDatosEstaticos() {
  if (Date.now() < proximaCargaEstatico) return;
  proximaCargaEstatico = Date.now() + 10 * 60_000; // si falla, no reintenta en cada tarjeta
  try {
    const { data: versiones } = await axios.get(`${DDRAGON}/api/versions.json`, { timeout: 10_000 });
    const version = versiones[0];
    const base = `${DDRAGON}/cdn/${version}/data/es_MX`;
    const [runas, campeones, hechizos] = await Promise.all([
      axios.get(`${base}/runesReforged.json`, { timeout: 10_000 }),
      axios.get(`${base}/champion.json`, { timeout: 10_000 }),
      axios.get(`${base}/summoner.json`, { timeout: 10_000 }),
    ]);

    const mapaRunas = new Map();
    for (const arbol of runas.data) {
      mapaRunas.set(arbol.id, { nombre: arbol.name, icono: arbol.icon });
      for (const fila of arbol.slots) {
        for (const runa of fila.runes) mapaRunas.set(runa.id, { nombre: runa.name, icono: runa.icon });
      }
    }
    const mapaCampeones = new Map(Object.values(campeones.data.data).map((c) => [Number(c.key), c.name]));
    const mapaHechizos = new Map(Object.values(hechizos.data.data).map((h) => [Number(h.key), h.image.full]));

    Object.assign(estatico, { version, runas: mapaRunas, campeones: mapaCampeones, hechizos: mapaHechizos });
    proximaCargaEstatico = Date.now() + 12 * 3_600_000; // se refresca cada 12 h (parches nuevos)
    console.log(`📚 Datos del juego cargados (parche ${version})`);
  } catch (err) {
    console.warn('⚠️ No pude cargar nombres de campeones, runas e ítems. Las tarjetas salen igual:', err.message);
  }
}

const nombreCampeon = (p) => estatico.campeones.get(p.campeonId) ?? p.campeonIngles;
const nombreRuna = (id) => estatico.runas.get(id)?.nombre ?? null;
const urlRuna = (id) => {
  const runa = estatico.runas.get(id);
  return runa ? `${DDRAGON}/cdn/img/${runa.icono}` : null;
};
const urlItem = (id) => (estatico.version && id ? `${DDRAGON}/cdn/${estatico.version}/img/item/${id}.png` : null);
const urlHechizo = (id) => {
  const archivo = estatico.hechizos.get(id);
  return estatico.version && archivo ? `${DDRAGON}/cdn/${estatico.version}/img/spell/${archivo}` : null;
};

// ─── Caché de imágenes: memoria + disco ───
// Cada ícono se descarga UNA vez en la vida del bot: queda en memoria y en la carpeta "cache",
// así que después de reiniciar tampoco se vuelve a descargar.
const cacheImagenes = new Map();

async function leerDeDisco(nombre) {
  try {
    return await fs.readFile(path.join(CARPETA_CACHE, nombre));
  } catch {
    return null;
  }
}

async function guardarEnDisco(nombre, buffer) {
  try {
    await fs.mkdir(CARPETA_CACHE, { recursive: true });
    await fs.writeFile(path.join(CARPETA_CACHE, nombre), buffer);
  } catch {
    // si no se puede escribir, seguimos solo con la memoria
  }
}

function descargarImagen(url) {
  if (!cacheImagenes.has(url)) {
    const archivo = `${crypto.createHash('md5').update(url).digest('hex')}.png`;
    const promesa = (async () => {
      const guardada = await leerDeDisco(archivo);
      if (guardada) return guardada;
      const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 10_000 });
      const buffer = Buffer.from(data);
      guardarEnDisco(archivo, buffer);
      return buffer;
    })().catch(() => {
      cacheImagenes.delete(url); // se reintenta la próxima vez
      return null;
    });
    cacheImagenes.set(url, promesa);
  }
  return cacheImagenes.get(url);
}

async function cargarIcono(url, tamano, { circulo = false, oscurecer = false } = {}) {
  if (!url) return null;
  const buffer = await descargarImagen(url);
  if (!buffer) return null;
  try {
    const icono = await Jimp.read(buffer);
    icono.resize({ w: tamano, h: tamano });
    if (oscurecer) icono.brightness(0.55);
    if (circulo) icono.circle();
    return icono;
  } catch {
    return null;
  }
}

/**
 * Imagen horizontal de la partida:
 * [campeón con aro verde/rojo] [rival] [hechizos] [runa principal + árbol secundario] [6 ítems + trinket]
 */
async function generarTiraDetalle(yo, rival) {
  const [campeon, iconoRival, hechizo1, hechizo2, runaClave, runaSecundaria, ...items] = await Promise.all([
    cargarIcono(urlIconoCampeon(yo.campeonId), 58, { circulo: true }),
    rival ? cargarIcono(urlIconoCampeon(rival.campeonId), 44, { circulo: true, oscurecer: true }) : null,
    cargarIcono(urlHechizo(yo.hechizos[0]), 28),
    cargarIcono(urlHechizo(yo.hechizos[1]), 28),
    cargarIcono(urlRuna(yo.runaClave), 48),
    cargarIcono(urlRuna(yo.runaSecundaria), 26),
    ...yo.items.map((id) => cargarIcono(urlItem(id), 42)),
  ]);
  if (!campeon) return null;

  const lienzo = new Jimp({ width: 572, height: 64, color: 0x00000000 });
  const aro = new Jimp({ width: 64, height: 64, color: yo.gano ? 0x2ecc71ff : 0xe74c3cff });
  aro.circle();
  lienzo.composite(aro, 0, 0);
  lienzo.composite(campeon, 3, 3);
  if (iconoRival) lienzo.composite(iconoRival, 72, 10);
  if (hechizo1) lienzo.composite(hechizo1, 126, 3);
  if (hechizo2) lienzo.composite(hechizo2, 126, 33);
  if (runaClave) lienzo.composite(runaClave, 162, 8);
  if (runaSecundaria) lienzo.composite(runaSecundaria, 212, 19);
  items.forEach((icono, i) => {
    const casilla = icono ?? new Jimp({ width: 42, height: 42, color: 0x1e1f22ff }); // casilla vacía
    lienzo.composite(casilla, 248 + i * 46, 11);
  });
  return lienzo.getBuffer('image/png');
}

// ─── Emblemas de liga ───
// Las imágenes oficiales son lienzos 16:9 con el emblema pequeño al centro y el resto transparente.
// Se descargan una vez por liga, se recorta lo transparente y se guardan en memoria y en disco.
// Si algo falla, la tarjeta usa la imagen original (se ve más pequeña, pero sale igual).
const cacheEmblemas = new Map();

function obtenerEmblema(tier) {
  if (!cacheEmblemas.has(tier)) {
    const promesa = prepararEmblema(tier).catch((err) => {
      console.warn(`⚠️ No pude preparar el emblema de ${tier}, uso la imagen original:`, err.message);
      cacheEmblemas.delete(tier); // se reintenta la próxima vez
      return null;
    });
    cacheEmblemas.set(tier, promesa);
  }
  return cacheEmblemas.get(tier);
}

async function prepararEmblema(tier) {
  const archivo = `emblema-${tier.toLowerCase()}.png`;
  const guardado = await leerDeDisco(archivo);
  if (guardado) return guardado;

  const { data } = await axios.get(urlEmblema(tier), { responseType: 'arraybuffer', timeout: 15_000 });
  const imagen = await Jimp.read(Buffer.from(data));
  const { width, height, data: pixeles } = imagen.bitmap;

  // Caja que encierra todos los píxeles visibles (alfa > 16)
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixeles[(y * width + x) * 4 + 3] > 16) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX >= 0) {
    const margen = 8;
    const x = Math.max(0, minX - margen);
    const y = Math.max(0, minY - margen);
    imagen.crop({ x, y, w: Math.min(width, maxX + margen + 1) - x, h: Math.min(height, maxY + margen + 1) - y });
  }
  imagen.scaleToFit({ w: 256, h: 256 });
  const buffer = await imagen.getBuffer('image/png');
  guardarEnDisco(archivo, buffer);
  return buffer;
}

/** Pone el emblema recortado como miniatura de la tarjeta y devuelve el archivo a adjuntar. */
async function adjuntarEmblema(embed, perfil) {
  if (!perfil) return [];
  const imagen = await obtenerEmblema(perfil.tier);
  if (!imagen) return []; // se queda con la URL original como respaldo
  embed.setThumbnail('attachment://emblema.png');
  return [new AttachmentBuilder(imagen, { name: 'emblema.png' })];
}

// ─── Emojis propios del bot ───
// Para que el Scoreboard y el roster muestren el ícono de cada campeón y el emblema de cada
// liga DENTRO del texto, el bot sube esos íconos como emojis de su aplicación (se ven en el
// portal de desarrolladores → Emojis). Se hace UNA sola vez, en segundo plano, y nuevos
// campeones se suben solos cuando salgan. Mientras tanto, todo se muestra con texto.
const emojis = new Map(); // nombre → "<:nombre:id>"
let subiendoEmojis = false;

const emojiCampeon = (campeonId) => emojis.get(`c_${campeonId}`) ?? '';
const emojiRango = (tier) => (tier ? emojis.get(`r_${tier.toLowerCase()}`) ?? '' : '');

async function cargarEmojis() {
  try {
    const lista = await client.application.emojis.fetch();
    for (const emoji of lista.values()) emojis.set(emoji.name, `<:${emoji.name}:${emoji.id}>`);
  } catch (err) {
    console.warn('⚠️ No pude leer los emojis del bot:', err.message);
  }
}

async function imagenParaEmoji(buffer) {
  if (!buffer) return null;
  const imagen = await Jimp.read(buffer);
  imagen.scaleToFit({ w: 96, h: 96 });
  return imagen.getBuffer('image/png');
}

async function subirEmojisFaltantes() {
  if (subiendoEmojis) return;
  subiendoEmojis = true;
  try {
    const pendientes = [];
    for (const tier of TIERS) {
      const nombre = `r_${tier.toLowerCase()}`;
      if (!emojis.has(nombre)) pendientes.push({ nombre, obtener: () => obtenerEmblema(tier) });
    }
    for (const id of estatico.campeones.keys()) {
      const nombre = `c_${id}`;
      if (!emojis.has(nombre)) pendientes.push({ nombre, obtener: () => descargarImagen(urlIconoCampeon(id)) });
    }
    if (!pendientes.length) return;

    console.log(`🎨 Subiendo ${pendientes.length} íconos como emojis del bot (solo pasa una vez, tarda unos minutos)...`);
    let subidos = 0;
    let fallosSeguidos = 0;
    for (const { nombre, obtener } of pendientes) {
      try {
        const imagen = await imagenParaEmoji(await obtener());
        if (!imagen) continue;
        const emoji = await client.application.emojis.create({ attachment: imagen, name: nombre });
        emojis.set(emoji.name, `<:${emoji.name}:${emoji.id}>`);
        subidos++;
        fallosSeguidos = 0;
        if (subidos % 25 === 0) console.log(`🎨 ${subidos}/${pendientes.length} íconos subidos`);
      } catch (err) {
        fallosSeguidos++;
        if (err.code === 30008) {
          console.warn('⚠️ El bot llegó al máximo de emojis permitido.');
          break;
        }
        if (fallosSeguidos >= 5) {
          console.warn('⚠️ No pude subir los íconos como emojis, sigo mostrando texto:', err.message);
          break;
        }
      }
      await dormir(400);
    }
    if (subidos) console.log(`🎨 Íconos listos: ${subidos} nuevos`);
  } finally {
    subiendoEmojis = false;
  }
}

// ═════════════════════════ 5. BASE DE DATOS ═════════════════════════

let mongo = null; // se crea al arrancar, cuando ya sabemos que MONGO_URI existe
let equiposCol;
let jugadoresCol;
let partidasCol;
let tareasCol;
let mensajesCol; // qué mensajes mandó el bot y de quién eran (para poder limpiarlos después)
const DIAS_GUARDAR_MENSAJES = 180;

async function conectarMongo() {
  mongo = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10_000 });
  await mongo.connect();
  const db = mongo.db(MONGO_DB);
  equiposCol = db.collection('equipos');
  jugadoresCol = db.collection('jugadores');
  partidasCol = db.collection('partidas');
  tareasCol = db.collection('tareas');
  mensajesCol = db.collection('mensajes');

  // Un canal = un equipo, nombres de equipo únicos y cada cuenta en UN solo equipo.
  await equiposCol.createIndex({ guildId: 1, canalId: 1 }, { unique: true });
  await equiposCol.createIndex({ guildId: 1, nombreLower: 1 }, { unique: true });
  await jugadoresCol.createIndex({ guildId: 1, puuid: 1 }, { unique: true });
  await jugadoresCol.createIndex({ equipoId: 1 });
  // Las partidas guardadas para el Scoreboard se borran solas pasados unos días.
  await partidasCol.createIndex({ creadoEn: 1 }, { expireAfterSeconds: DIAS_GUARDAR_PARTIDAS * 86_400 });
  await tareasCol.createIndex({ puuid: 1, estado: 1 });
  await tareasCol.createIndex({ equipoId: 1, estado: 1 });
  await mensajesCol.createIndex({ equipoId: 1 });
  await mensajesCol.createIndex({ creadoEn: 1 }, { expireAfterSeconds: DIAS_GUARDAR_MENSAJES * 86_400 });
  console.log('✅ Conectado a MongoDB');
}

// ═════════════════════════ 6. RESUMEN DE PARTIDA ═════════════════════════
// De la respuesta gigante de Riot (~100 KB) nos quedamos solo con lo que usan las tarjetas (~5 KB).

const cacheResumenes = new Map();

function resumirPartida(partida) {
  const info = partida.info;
  const minutos = Math.max(1, info.gameDuration / 60);
  const killsEquipo = {};
  const danoEquipo = {};
  for (const p of info.participants) {
    killsEquipo[p.teamId] = (killsEquipo[p.teamId] ?? 0) + p.kills;
    danoEquipo[p.teamId] = (danoEquipo[p.teamId] ?? 0) + (p.totalDamageDealtToChampions ?? 0);
  }

  const participantes = info.participants.map((p, indice) => {
    const cs = (p.totalMinionsKilled ?? 0) + (p.neutralMinionsKilled ?? 0);
    const dano = p.totalDamageDealtToChampions ?? 0;
    const estilos = p.perks?.styles ?? [];
    return {
      indice,
      puuid: p.puuid,
      nombre: p.riotIdGameName || '',
      tag: p.riotIdTagline || '',
      campeonId: p.championId,
      campeonIngles: p.championName,
      equipo: p.teamId,
      pos: p.teamPosition || '',
      gano: Boolean(p.win),
      remake: Boolean(p.gameEndedInEarlySurrender),
      k: p.kills,
      d: p.deaths,
      a: p.assists,
      cs,
      csMin: cs / minutos,
      dano,
      parteDano: danoEquipo[p.teamId] ? dano / danoEquipo[p.teamId] : 0,
      kp: killsEquipo[p.teamId] ? (p.kills + p.assists) / killsEquipo[p.teamId] : 0,
      vision: p.visionScore ?? 0,
      hechizos: [p.summoner1Id, p.summoner2Id],
      runaClave: estilos[0]?.selections?.[0]?.perk ?? null,
      runaSecundaria: estilos[1]?.style ?? null,
      items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6].map((id) => id || 0),
    };
  });
  calcularPuntajes(participantes, minutos);

  return {
    id: partida.metadata?.matchId ?? `${info.platformId}_${info.gameId}`,
    gameId: info.gameId,
    cola: info.queueId ?? 420,
    plataforma: info.platformId.toLowerCase(),
    duracion: info.gameDuration,
    fin: info.gameEndTimestamp ?? info.gameCreation + info.gameDuration * 1000,
    danoMax: Math.max(1, ...participantes.map((p) => p.dano)),
    killsEquipo,
    participantes,
    rangos: null, // Map puuid → perfil; se llena al precargar o al abrir el Scoreboard
  };
}

/**
 * Puntaje NTI (0-100), fórmula propia y ajustable:
 * KDA, participación en kills, % de daño del equipo, farm y visión.
 * Los supports se miden más por visión y participación que por farm y daño.
 * MVP = mejor puntaje del equipo ganador · ACE = mejor puntaje del equipo perdedor.
 */
function calcularPuntajes(participantes, minutos) {
  const n = (valor, tope) => Math.min(valor / tope, 1);
  for (const p of participantes) {
    const kda = (p.k + p.a) / Math.max(1, p.d);
    const visionMin = p.vision / minutos;
    const base = p.pos === 'UTILITY'
      ? 25 * n(kda, 5) + 30 * n(p.kp, 0.7) + 10 * n(p.parteDano, 0.2) + 35 * n(visionMin, 2.5)
      : 25 * n(kda, 5) + 25 * n(p.kp, 0.7) + 25 * n(p.parteDano, 0.3) + 15 * n(p.csMin, 8.5) + 10 * n(visionMin, 1.2);
    p.puntaje = Math.round(Math.min(100, base + (p.gano ? 5 : 0)));
    p.etiqueta = null;
  }
  const orden = [...participantes].sort((a, b) => b.puntaje - a.puntaje);
  orden.forEach((p, i) => { p.puesto = i + 1; });
  const mvp = orden.find((p) => p.gano);
  const ace = orden.find((p) => !p.gano);
  if (mvp) mvp.etiqueta = 'MVP';
  if (ace) ace.etiqueta = 'ACE';
}

function guardarEnMemoria(resumen) {
  cacheResumenes.set(resumen.id, resumen);
  if (cacheResumenes.size > MAX_PARTIDAS_EN_MEMORIA) {
    cacheResumenes.delete(cacheResumenes.keys().next().value); // sale la más antigua
  }
}

/** Busca la partida en memoria → MongoDB → Riot, en ese orden. */
async function obtenerResumen(partidaId, prioridad) {
  if (cacheResumenes.has(partidaId)) return cacheResumenes.get(partidaId);

  const guardada = await partidasCol.findOne({ _id: partidaId }).catch(() => null);
  if (guardada?.resumen) {
    const resumen = { ...guardada.resumen, rangos: guardada.rangos ? new Map(guardada.rangos) : null };
    guardarEnMemoria(resumen);
    return resumen;
  }

  const plataforma = partidaId.split('_')[0].toLowerCase();
  const regional = REGIONES[REGION_POR_PLATAFORMA[plataforma]]?.regional ?? 'americas';
  const resumen = resumirPartida(await riot.partida(regional, partidaId, prioridad));
  guardarEnMemoria(resumen);
  guardarPartida(resumen);
  return resumen;
}

async function guardarPartida(resumen) {
  const { rangos, rangosPromesa, ...datos } = resumen;
  const cambios = { resumen: datos, creadoEn: new Date() };
  if (rangos) cambios.rangos = [...rangos.entries()];
  await partidasCol.updateOne({ _id: resumen.id }, { $set: cambios }, { upsert: true }).catch(() => {});
}

/**
 * Rangos de los 10 jugadores para el Scoreboard. Los que ya seguimos salen de la base de datos;
 * el resto se pide a Riot UNA sola vez por partida y queda guardado con ella.
 */
async function obtenerRangos(resumen, prioridad = 'normal') {
  if (resumen.rangos) return resumen.rangos;
  if (!resumen.rangosPromesa) {
    resumen.rangosPromesa = (async () => {
      const rangos = new Map();
      const conocidos = await jugadoresCol.find({ puuid: { $in: resumen.participantes.map((p) => p.puuid) } }).toArray();
      for (const j of conocidos) rangos.set(j.puuid, j.perfilSoloQ ?? null);

      let fallos = 0;
      await Promise.all(
        resumen.participantes
          .filter((p) => !rangos.has(p.puuid))
          .map(async (p) => {
            try {
              rangos.set(p.puuid, await obtenerPerfilSoloQ(resumen.plataforma, p.puuid, prioridad));
            } catch {
              fallos++;
            }
          }),
      );
      if (!fallos) {
        resumen.rangos = rangos; // completo: se reutiliza para siempre
        guardarPartida(resumen);
      }
      return rangos;
    })().finally(() => {
      resumen.rangosPromesa = null;
    });
  }
  return resumen.rangosPromesa;
}

// ═════════════════════════ 7. MOTOR DE ESCANEO ═════════════════════════

let escaneando = false;

async function escanear() {
  if (escaneando) return; // si el escaneo anterior sigue corriendo, no lo duplicamos
  escaneando = true;
  const inicio = Date.now();

  try {
    // Se leen en cada escaneo: si un admin crea un equipo, entra en el siguiente ciclo sin reiniciar.
    // Todos los servidores: cada equipo y cada jugador ya están separados por servidor
    const equipos = await equiposCol.find({}).toArray();
    const equiposPorId = new Map(equipos.map((e) => [String(e._id), e]));
    const lista = await jugadoresCol.find({}).toArray();

    for (const { _id } of lista) {
      // Se relee fresco: si jugó en equipo con otro, ese otro ya pudo dejarle la partida procesada.
      const jugador = await jugadoresCol.findOne({ _id });
      const equipo = jugador && equiposPorId.get(String(jugador.equipoId));
      if (!equipo) continue;

      try {
        await revisarJugador(jugador, equipo);
      } catch (err) {
        if (err instanceof RiotError && (err.status === 401 || err.status === 403)) {
          console.error('❌ La RIOT_API_KEY es inválida o venció. Renuévala en el .env y reinicia el bot.');
          break;
        }
        console.error(`⚠️ Error revisando a ${jugador.nombre}#${jugador.tag}:`, err.message);
      }
    }

    await revisarVencimientos(equiposPorId);
    const segundos = Math.round((Date.now() - inicio) / 1000);
    console.log(`🔎 Escaneo listo: ${lista.length} jugadores en ${segundos}s`);
  } catch (err) {
    console.error('⚠️ Falló el escaneo:', err.message);
  } finally {
    escaneando = false;
  }
}

/** Mete una partida al inicio de la lista de procesadas (sin repetir y con tope). */
const agregarProcesada = (lista, partidaId) =>
  [partidaId, ...(lista ?? []).filter((id) => id !== partidaId)].slice(0, MAX_PROCESADAS);

/**
 * Punto de partida de un jugador: sus partidas actuales quedan como "ya vistas" (no se anuncian
 * partidas viejas) y se guardan su SoloQ y Flex actuales. También migra jugadores de la versión anterior.
 */
async function fijarPuntoDePartida(jugador, ids, prioridad) {
  const plataforma = REGIONES[jugador.region]?.plataforma ?? 'la1';
  const perfiles = await obtenerPerfiles(plataforma, jugador.puuid, prioridad);
  const cambios = {
    procesadas: ids.slice(0, MAX_PROCESADAS),
    perfilSoloQ: perfiles.soloq,
    perfilFlex: perfiles.flex,
    rachas: jugador.rachas ?? { soloq: jugador.racha ?? 0, flex: 0, normal: 0 },
    esperasLP: 0,
  };
  await jugadoresCol.updateOne({ _id: jugador._id }, { $set: cambios });
  return cambios;
}

async function revisarJugador(jugador, equipo) {
  const regional = REGIONES[jugador.region]?.regional ?? 'americas';

  // 1) Sus 5 partidas más recientes, de cualquier modo (una sola consulta)
  let ids;
  try {
    ids = await riot.ultimasPartidas(regional, jugador.puuid);
  } catch (err) {
    // Los PUUID vienen cifrados POR API KEY. Si cambias de key (dev → personal),
    // Riot responde 400 y hay que volver a pedir el PUUID con el Riot ID guardado.
    if (err.status !== 400) throw err;
    jugador.puuid = await refrescarPuuid(jugador);
    ids = await riot.ultimasPartidas(regional, jugador.puuid);
  }

  // 2) Jugador recién migrado desde la versión anterior: solo se fija el punto de partida
  if (!Array.isArray(jugador.procesadas)) {
    await fijarPuntoDePartida(jugador, ids);
    return;
  }

  // 3) Partidas nuevas, de la más vieja a la más nueva
  const vistas = new Set(jugador.procesadas);
  const nuevas = ids.filter((id) => !vistas.has(id)).reverse();
  for (const partidaId of nuevas) {
    const resultado = await procesarPartida(partidaId, jugador, equipo);
    if (resultado === 'esperar') break; // Riot aún no suma los LP: se reintenta en el próximo escaneo
    jugador = await jugadoresCol.findOne({ _id: jugador._id }); // estado fresco para la siguiente
  }
}

async function procesarPartida(partidaId, jugador, equipo) {
  const resumen = await obtenerResumen(partidaId);
  const modo = modoDeCola(resumen.cola);
  const yo = resumen.participantes.find((p) => p.puuid === jugador.puuid);

  // Modos que no seguimos (ARAM, Arena...), remakes o datos raros: solo se marcan como vistas.
  if (!modo || !yo || yo.remake) {
    await jugadoresCol.updateOne(
      { _id: jugador._id },
      { $set: { procesadas: agregarProcesada(jugador.procesadas, partidaId), esperasLP: 0 } },
    );
    return 'ok';
  }

  // Compañeros de SU MISMO equipo que jugaron del mismo lado (premade) y aún no tienen la partida procesada
  const aliados = resumen.participantes.filter((p) => p.equipo === yo.equipo).map((p) => p.puuid);
  const delEquipo = await jugadoresCol.find({ equipoId: jugador.equipoId, puuid: { $in: aliados } }).toArray();
  const companeros = delEquipo.filter(
    (j) => j.puuid !== jugador.puuid && Array.isArray(j.procesadas) && !j.procesadas.includes(partidaId),
  );

  // Resultado del jugador principal. Si Riot aún no actualiza sus LP, esperamos al próximo escaneo.
  const principal = await calcularResultado(jugador, resumen, yo, modo);
  if (principal.esperar) {
    await jugadoresCol.updateOne({ _id: jugador._id }, { $inc: { esperasLP: 1 } });
    return 'esperar';
  }
  const resultados = [principal];
  for (const j of companeros) {
    const p = resumen.participantes.find((x) => x.puuid === j.puuid);
    resultados.push(await calcularResultado(j, resumen, p, modo, { sinEspera: true }));
  }

  // Tareas de los coaches
  for (const r of resultados) r.tareas = await evaluarTareas(r.jugador, resumen, r.p, modo);

  // ¿El equipo eligió mostrar este modo? Aunque no lo muestre, LP, rachas y tareas se actualizan igual.
  const mostrar = opcionModos(equipo).claves.includes(modo.clave);

  if (mostrar) {
    // UNA sola tarjeta para todo el equipo, SOLO en su canal
    const mensaje = await construirMensajePartida({ equipo, resumen, modo, resultados });
    const enviado = await enviarAviso(equipo, mensaje);
    if (enviado) await registrarMensaje(equipo, enviado, resultados.map((r) => r.jugador.puuid), 'partida');
    if (!enviado) {
      const intentos = (jugador.reintentosAviso ?? 0) + 1;
      if (intentos < MAX_REINTENTOS_AVISO) {
        // No se guarda nada: en el próximo escaneo se vuelve a intentar con la misma partida
        await jugadoresCol.updateOne({ _id: jugador._id }, { $set: { reintentosAviso: intentos } });
        console.warn(`↻ La tarjeta de ${jugador.nombre}#${jugador.tag} se reintentará en el próximo escaneo (${intentos}/${MAX_REINTENTOS_AVISO}).`);
        return 'esperar';
      }
      console.error(`❌ Se descartó la tarjeta de ${jugador.nombre}#${jugador.tag} tras ${intentos} intentos. Revisa los permisos del bot en el canal de ${equipo.nombre}.`);
    }
  }
  for (const r of resultados) await guardarAvancesTareas(r.tareas);

  // El avance de tareas va aparte si hay canal de tareas, o si esta partida no se muestra
  if (equipo.canalTareasId || !mostrar) {
    const avance = construirEmbedAvanceTareas({ resumen, modo, resultados });
    const enviadoAvance = avance && (await enviarAviso(equipo, { embeds: [avance] }, { conPing: false, destino: 'tareas' }));
    if (enviadoAvance) {
      await registrarMensaje(equipo, enviadoAvance, resultados.filter((r) => r.tareas?.length).map((r) => r.jugador.puuid), 'tareas');
    }
  }

  for (const r of resultados) await guardarResultado(r, partidaId, resumen);

  // Precarga los rangos del Scoreboard para que el botón abra al instante (solo si hubo tarjeta)
  if (mostrar) await obtenerRangos(resumen).catch(() => {});
  return 'ok';
}

/** LP, racha y perfiles de un jugador después de una partida. */
async function calcularResultado(jugador, resumen, p, modo, { sinEspera = false } = {}) {
  const rachasPrevias = jugador.rachas ?? { soloq: jugador.racha ?? 0, flex: 0, normal: 0 };
  const previa = rachasPrevias[modo.clave] ?? 0;
  const racha = p.gano ? (previa > 0 ? previa + 1 : 1) : (previa < 0 ? previa - 1 : -1);
  const resultado = {
    jugador,
    p,
    modo,
    racha,
    rachas: { ...rachasPrevias, [modo.clave]: racha },
    perfiles: null,
    perfilModo: null,
    cambio: { lp: null, nota: null },
  };
  if (!modo.ranked) return resultado; // las normales no dan LP

  const campo = modo.clave === 'soloq' ? 'perfilSoloQ' : 'perfilFlex';
  const perfilPrevio = jugador[campo] ?? null;
  const perfiles = await obtenerPerfiles(resumen.plataforma, jugador.puuid);
  const perfilNuevo = perfiles[modo.clave];
  resultado.perfiles = perfiles;
  resultado.perfilModo = perfilNuevo;

  const totalPrevio = perfilPrevio ? perfilPrevio.wins + perfilPrevio.losses : null;
  const totalNuevo = perfilNuevo ? perfilNuevo.wins + perfilNuevo.losses : null;
  const sinActualizar = totalPrevio !== null && totalPrevio === totalNuevo;

  if (sinActualizar && !sinEspera && (jugador.esperasLP ?? 0) < MAX_ESPERAS_LP) {
    resultado.esperar = true;
    return resultado;
  }

  if (!perfilNuevo) {
    resultado.cambio = { lp: null, nota: 'En clasificación' };
  } else if (!perfilPrevio) {
    resultado.cambio = { lp: null, nota: '🎉 ¡Clasificado!' };
  } else if (sinActualizar) {
    resultado.cambio = { lp: null, nota: 'LP pendientes de Riot' };
  } else {
    const partidas = totalNuevo - totalPrevio;
    const tierNuevo = TIERS.indexOf(perfilNuevo.tier);
    const tierPrevio = TIERS.indexOf(perfilPrevio.tier);
    let nota = partidas > 1 ? `en ${partidas} partidas` : null;
    if (tierNuevo > tierPrevio) nota = `🎉 ¡Subió a ${NOMBRE_TIER[perfilNuevo.tier]}!`;
    if (tierNuevo < tierPrevio) nota = `Bajó a ${NOMBRE_TIER[perfilNuevo.tier]}`;
    resultado.cambio = { lp: perfilNuevo.abs - perfilPrevio.abs, nota };
  }
  return resultado;
}

async function guardarResultado(resultado, partidaId, resumen) {
  const { jugador, p } = resultado;
  const nombre = p.nombre || jugador.nombre;
  const tag = p.tag || jugador.tag;
  const cambios = {
    procesadas: agregarProcesada(jugador.procesadas, partidaId),
    rachas: resultado.rachas,
    racha: resultado.rachas.soloq ?? 0,
    esperasLP: 0,
    reintentosAviso: 0,
    nombre,
    tag,
    riotIdLower: riotIdEnMinusculas(nombre, tag),
    region: REGION_POR_PLATAFORMA[resumen.plataforma] ?? jugador.region,
  };
  if (resultado.perfiles) {
    cambios.perfilSoloQ = resultado.perfiles.soloq;
    cambios.perfilFlex = resultado.perfiles.flex;
  }
  // Estadísticas por campeón en ranked: sirven para comparar su champion pool con lo que juega de verdad
  if (resultado.modo?.ranked) {
    const stats = { ...(jugador.stats ?? {}) };
    const clave = String(p.campeonId);
    const s = stats[clave] ?? { j: 0, g: 0, k: 0, d: 0, a: 0 };
    stats[clave] = { j: s.j + 1, g: s.g + (p.gano ? 1 : 0), k: s.k + p.k, d: s.d + p.d, a: s.a + p.a };
    cambios.stats = stats;
  }
  await jugadoresCol.updateOne({ _id: jugador._id }, { $set: cambios });

  // Si se cambió el Riot ID, sus tareas activas muestran el nombre nuevo
  if (nombre !== jugador.nombre || tag !== jugador.tag) {
    const tareas = await tareasCol.find({ puuid: jugador.puuid, estado: 'activa' }).toArray();
    for (const t of tareas) await tareasCol.updateOne({ _id: t._id }, { $set: { jugadorNombre: `${nombre}#${tag}` } });
  }
}

async function refrescarPuuid(jugador) {
  const cuenta = await riot.cuentaPorRiotId(jugador.nombre, jugador.tag);
  await jugadoresCol.updateOne({ _id: jugador._id }, { $set: { puuid: cuenta.puuid } });
  // Las tareas activas de ese jugador pasan al PUUID nuevo
  const tareas = await tareasCol.find({ puuid: jugador.puuid, estado: 'activa' }).toArray();
  for (const t of tareas) await tareasCol.updateOne({ _id: t._id }, { $set: { puuid: cuenta.puuid } });
  console.log(`🔑 PUUID actualizado para ${jugador.nombre}#${jugador.tag} (cambio de API key)`);
  return cuenta.puuid;
}

/** Envía un mensaje al canal del equipo. Devuelve true si se pudo enviar. */
async function enviarAviso(equipo, mensaje, { conPing = true, destino = 'partidas' } = {}) {
  // Las tareas van a su canal propio si el equipo lo tiene; si no, al de partidas
  const canalId = destino === 'tareas' ? (equipo.canalTareasId || equipo.canalId) : equipo.canalId;
  try {
    const canal = await client.channels.fetch(canalId);
    const final = { ...mensaje };
    if (conPing && equipo.rolPingId) {
      final.content = `<@&${equipo.rolPingId}>`;
      final.allowedMentions = { roles: [equipo.rolPingId] }; // solo se pinguea el rol de ESTE equipo
    }
    return (await canal.send(final)) ?? true; // devuelve el mensaje enviado (o false si falló)
  } catch (err) {
    const servidor = client.guilds.cache.get(equipo.guildId)?.name ?? 'servidor desconocido';
    const motivo = {
      50001: 'el bot NO puede ver ese canal (falta "Ver canal")',
      50013: 'al bot le faltan permisos ahí ("Enviar mensajes", "Insertar enlaces" o "Adjuntar archivos")',
      10003: 'ese canal ya no existe (lo borraron)',
    }[err.code] ?? err.message;
    console.error(`⚠️ No pude enviar al canal de ${equipo.nombre} (${servidor}): ${motivo}.`);
    return false;
  }
}

// ═════════════════════════ 8. TAREAS DE LOS COACHES ═════════════════════════

const normalizar = (texto) =>
  (texto ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();

/** Acepta el ID que manda el autocompletado o el nombre escrito a mano ("Ahri", "kaisa", "Kai'Sa"). */
function buscarCampeon(texto) {
  if (!texto) return null;
  const id = Number(texto);
  if (estatico.campeones.has(id)) return { id, nombre: estatico.campeones.get(id) };
  const buscado = normalizar(texto);
  for (const [campeonId, nombre] of estatico.campeones) {
    if (normalizar(nombre) === buscado) return { id: campeonId, nombre };
  }
  return null;
}

function describirTarea(t) {
  const n = t.cantidad;
  const partidas = `${n} partida${n === 1 ? '' : 's'}`;
  const verbo = t.victoria ? 'Ganar' : 'Jugar';
  let texto;
  switch (t.tipo) {
    case 'campeon': texto = `${verbo} ${partidas} con ${t.campeonNombre}`; break;
    case 'rol': texto = `${verbo} ${partidas} de ${NOMBRE_ROL[t.rol] ?? t.rol}`; break;
    case 'kda': texto = `${partidas} con KDA de ${t.valor} o más`; break;
    case 'cs': texto = `${partidas} con ${t.valor}+ CS/min`; break;
    case 'vision': texto = `${partidas} con ${t.valor}+ de visión`; break;
    default: texto = `${verbo} ${partidas}`;
  }
  if (t.victoria && ['kda', 'cs', 'vision'].includes(t.tipo)) texto += ' (ganadas)';
  texto += ` en ${NOMBRE_MODO_TAREA[t.modo] ?? NOMBRE_MODO_TAREA.cualquiera}`; // siempre visible en qué partidas cuenta
  return texto;
}

function cumpleTarea(t, p, modo) {
  if (t.modo === 'ranked' && !modo.ranked) return false;
  if (!['cualquiera', 'ranked'].includes(t.modo) && t.modo !== modo.clave) return false;
  if (t.victoria && !p.gano) return false;
  switch (t.tipo) {
    case 'campeon': return p.campeonId === t.campeonId;
    case 'rol': return p.pos === t.rol;
    case 'kda': return (p.k + p.a) / Math.max(1, p.d) >= t.valor;
    case 'cs': return p.csMin >= t.valor;
    case 'vision': return p.vision >= t.valor;
    default: return true;
  }
}

const barraProgreso = (actual, total) => {
  const llenos = Math.round((Math.min(actual, total) / total) * 5);
  return '▰'.repeat(llenos) + '▱'.repeat(5 - llenos);
};

/** Suma la partida a las tareas activas del jugador que cumpla. Devuelve los avances para la tarjeta. */
async function evaluarTareas(jugador, resumen, p, modo) {
  // Solo las tareas de SU equipo (el mismo jugador puede estar en equipos de distintos servidores)
  const activas = await tareasCol.find({ puuid: jugador.puuid, estado: 'activa', equipoId: jugador.equipoId }).toArray();
  const avances = [];
  for (const t of activas) {
    // Solo cuentan partidas terminadas después de crear la tarea y antes de que venza
    if (resumen.fin < new Date(t.creadaEn).getTime() || resumen.fin > new Date(t.venceEn).getTime()) continue;
    if ((t.partidas ?? []).includes(resumen.id) || !cumpleTarea(t, p, modo)) continue;

    const progreso = Math.min(t.cantidad, (t.progreso ?? 0) + 1);
    const completada = progreso >= t.cantidad;
    const cambios = { progreso, partidas: [...(t.partidas ?? []), resumen.id] };
    if (completada) Object.assign(cambios, { estado: 'completada', cerradaEn: new Date() });
    avances.push({ ...t, ...cambios, completada, cambios });
  }
  return avances;
}

/** Guarda en MongoDB el avance de tareas calculado (se hace cuando la tarjeta ya salió). */
async function guardarAvancesTareas(avances = []) {
  for (const t of avances) await tareasCol.updateOne({ _id: t._id, estado: 'activa' }, { $set: t.cambios });
}

/** Cierra las tareas vencidas y avisa UNA vez por equipo con todas las que no se cumplieron. */
async function revisarVencimientos(equiposPorId) {
  const ahora = Date.now();
  const activas = await tareasCol.find({ estado: 'activa' }).toArray();
  const vencidas = activas.filter((t) => new Date(t.venceEn).getTime() < ahora);
  if (!vencidas.length) return;

  const porEquipo = new Map();
  for (const t of vencidas) {
    await tareasCol.updateOne({ _id: t._id, estado: 'activa' }, { $set: { estado: 'fallida', cerradaEn: new Date() } });
    const clave = String(t.equipoId);
    porEquipo.set(clave, [...(porEquipo.get(clave) ?? []), t]);
  }
  for (const [equipoId, tareas] of porEquipo) {
    const equipo = equiposPorId.get(equipoId);
    if (!equipo) continue;
    const embed = new EmbedBuilder()
      .setColor(COLORES.derrota)
      .setTitle('⌛ Tareas no cumplidas')
      .setDescription(
        tareas.map((t) => `❌ **${t.jugadorNombre}** · ${describirTarea(t)} — ${t.progreso ?? 0}/${t.cantidad}`).join('\n').slice(0, 4000),
      );
    const enviado = await enviarAviso(equipo, { embeds: [embed] }, { conPing: false, destino: 'tareas' });
    if (enviado) await registrarMensaje(equipo, enviado, tareas.map((t) => t.puuid), 'tareas');
  }
}

/** Anota un mensaje del bot: en qué canal quedó, de qué equipo es y de qué jugadores habla. */
async function registrarMensaje(equipo, mensaje, puuids, tipo) {
  if (!mensaje?.id || !mensaje.channelId) return;
  await mensajesCol
    .insertOne({
      mensajeId: mensaje.id,
      canalId: mensaje.channelId,
      guildId: equipo.guildId,
      equipoId: equipo._id,
      puuids: [...new Set(puuids)],
      tipo,
      creadoEn: new Date(),
    })
    .catch(() => {});
}

/**
 * Borra de Discord los mensajes del bot indicados (el bot siempre puede borrar los suyos, sin permisos extra)
 * y quita sus registros. Devuelve cuántos se borraron.
 */
async function borrarMensajesDelBot(registros) {
  let borrados = 0;
  for (const r of registros) {
    try {
      const canal = await client.channels.fetch(r.canalId);
      await canal.messages.delete(r.mensajeId);
      borrados++;
    } catch (err) {
      if (err.code !== 10008 && err.code !== 10003) console.warn('⚠️ No pude borrar un mensaje:', err.message); // 10008/10003: ya no existía
    }
    await mensajesCol.deleteOne({ _id: r._id }).catch(() => {});
  }
  return borrados;
}

/** Mensaje para el canal de tareas: qué avanzó (o se completó) con esta partida. */
function construirEmbedAvanceTareas({ resumen, modo, resultados }) {
  const avances = resultados.flatMap((r) => (r.tareas ?? []).map((t) => ({ t, r })));
  if (!avances.length) return null;

  const completadas = avances.filter(({ t }) => t.completada).length;
  const region = REGION_POR_PLATAFORMA[resumen.plataforma] ?? 'LAN';
  const lineas = avances.map(({ t, r }) => {
    const quien = `**${r.p.nombre || r.jugador.nombre}**${r.jugador.discordId ? ` <@${r.jugador.discordId}>` : ''}`;
    return t.completada
      ? `✅ ${quien} · ${describirTarea(t)} — **¡completada!**`
      : `${barraProgreso(t.progreso, t.cantidad)} ${quien} · ${describirTarea(t)} (${t.progreso}/${t.cantidad})`;
  });
  let titulo = '📋 Avance de tareas';
  if (completadas === 1) titulo = '✅ ¡Tarea completada!';
  if (completadas > 1) titulo = `✅ ¡${completadas} tareas completadas!`;

  return new EmbedBuilder()
    .setColor(completadas ? COLORES.victoria : COLORES.info)
    .setTitle(titulo)
    .setURL(urlPartida(region, resumen.gameId))
    .setDescription(lineas.join('\n').slice(0, 4000))
    .setFooter({ text: `Por su partida de ${modo.nombre} · toca el título para verla` })
    .setTimestamp(new Date(resumen.fin));
}

// ═════════════════════════ 9. TARJETAS ═════════════════════════

const conEmblema = (tier, texto) => {
  const emblema = emojiRango(tier);
  return emblema ? `${emblema} ${texto}` : texto;
};

/** Arma la tarjeta completa de una partida: embed + emblema + tira de detalle + botones. */
async function construirMensajePartida({ equipo, resumen, modo, resultados, prueba = false }) {
  await cargarDatosEstaticos();
  const principal = resultados[0];
  const { jugador, p: yo } = principal;
  const region = REGION_POR_PLATAFORMA[resumen.plataforma] ?? jugador.region;
  // Rival de línea: el del otro equipo en la misma posición
  const rival = resumen.participantes.find((p) => p.equipo !== yo.equipo && p.pos && p.pos === yo.pos) ?? null;

  const embed = construirEmbedPartida({ equipo, region, resumen, modo, resultados, rival, prueba });
  const [archivos, tira] = await Promise.all([
    adjuntarEmblema(embed, principal.perfilModo),
    generarTiraDetalle(yo, rival).catch((err) => {
      console.warn('⚠️ No pude generar la imagen de runas e ítems:', err.message);
      return null;
    }),
  ]);
  if (tira) {
    embed.setImage('attachment://detalle.png');
    archivos.push(new AttachmentBuilder(tira, { name: 'detalle.png' }));
  }

  return { embeds: [embed], files: archivos, components: [construirBotones({ jugador, region, resumen, yo })] };
}

function construirEmbedPartida({ equipo, region, resumen, modo, resultados, rival, prueba }) {
  const principal = resultados[0];
  const { jugador, p: yo, cambio, racha } = principal;
  const companeros = resultados.slice(1);
  const nombre = yo.nombre || jugador.nombre;
  const tag = yo.tag || jugador.tag;

  let color = yo.gano ? COLORES.victoria : COLORES.derrota;
  if (racha >= 3) color = COLORES.rachaVictorias;
  if (racha <= -3) color = COLORES.rachaDerrotas;
  if (companeros.length) color = COLORES.equipo; // dorado: jugó con su equipo

  const kda = yo.d === 0 ? 'KDA perfecto' : `${((yo.k + yo.a) / yo.d).toFixed(2)} KDA`;
  const bloques = Math.round((yo.dano / resumen.danoMax) * 6); // barra relativa al que más daño hizo
  const barra = '▰'.repeat(bloques) + '▱'.repeat(6 - bloques);
  const runas = [nombreRuna(yo.runaClave), nombreRuna(yo.runaSecundaria)].filter(Boolean).join(' + ');
  const insignia = yo.etiqueta === 'MVP' ? '⭐ MVP' : yo.etiqueta === 'ACE' ? '🎖️ ACE' : `#${yo.puesto}`;
  const n = Math.abs(racha);
  const textoRacha = racha > 0 ? `${n}V${n >= 3 ? ' 🔥' : ''}` : `${n}D${n >= 3 ? ' 🥶' : ''}`;

  const lineas = [`${modo.emoji} **${modo.nombre.toUpperCase()}** · ⏱️ ${formatearDuracion(resumen.duracion)} · ${marcaDeTiempo(resumen.fin)}`];
  if (companeros.length) lineas.push(`🌟 **Jugó con su equipo:** ${companeros.length + 1} de ${equipo.nombre}`);
  if (runas) lineas.push(`🔮 ${runas}`);
  if (jugador.discordId) lineas.push(`👤 <@${jugador.discordId}>`); // se ve el usuario, pero sin notificarle
  if (prueba) lineas.push('🧪 **Tarjeta de prueba** con su última partida. No afecta el seguimiento.');

  // Elo: en ranked, el de ESE modo con sus LP; en normales, su SoloQ como referencia
  let campoElo;
  if (modo.ranked) {
    const perfil = principal.perfilModo;
    const lineasElo = [];
    if (perfil) lineasElo.push(`${perfil.lp} LP${cambio.lp !== null ? ` (${conSigno(cambio.lp)})` : ''}`);
    else if (cambio.lp !== null) lineasElo.push(`${conSigno(cambio.lp)} LP`);
    if (cambio.nota) lineasElo.push(cambio.nota);
    const nombreElo = `${nombreRango(perfil)}${modo.clave === 'flex' ? ' (Flex)' : ''}`;
    campoElo = { name: conEmblema(perfil?.tier, nombreElo), value: lineasElo.join('\n') || '—', inline: true };
  } else {
    const solo = jugador.perfilSoloQ;
    const lineasElo = [solo ? `SoloQ: ${conEmblema(solo.tier, nombreRango(solo))}` : 'SoloQ: sin clasificar'];
    if (cambio.nota) lineasElo.push(cambio.nota);
    campoElo = { name: '🎮 Sin LP en juego', value: lineasElo.join('\n'), inline: true };
  }

  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: `${nombre}#${tag} · ${equipo.nombre}`, iconURL: urlIconoCampeon(yo.campeonId), url: urlOpgg(region, nombre, tag) })
    .setTitle(`${yo.gano ? '🟩 VICTORIA' : '🟥 DERROTA'} como ${nombreCampeon(yo)}${rival ? ` vs ${nombreCampeon(rival)}` : ''}`)
    .setURL(urlPartida(region, resumen.gameId))
    .setDescription(lineas.join('\n'))
    .setThumbnail(principal.perfilModo ? urlEmblema(principal.perfilModo.tier) : urlIconoCampeon(yo.campeonId))
    .addFields(
      { name: `${yo.k} / ${yo.d} / ${yo.a}`, value: kda, inline: true },
      { name: `${yo.cs} CS`, value: `${yo.csMin.toFixed(1)}/min`, inline: true },
      { name: `${formatearMiles(yo.dano)} DMG`, value: `${barra} ${Math.round(yo.parteDano * 100)}%`, inline: true },
      campoElo,
      { name: `${Math.round(yo.kp * 100)}% KP`, value: `👁️ ${yo.vision} visión`, inline: true },
      { name: `${insignia} · ${yo.puntaje}/100`, value: `puesto ${yo.puesto} de 10`, inline: true },
    )
    .setFooter({ text: `${elegirFrase(yo, racha, resumen.id + yo.puuid)} · Racha ${modo.clave === 'normal' ? 'normales' : modo.nombre} ${textoRacha}` })
    .setTimestamp(new Date(resumen.fin));

  if (companeros.length) {
    const lineasEquipo = companeros.map((c) => {
      const icono = emojiCampeon(c.p.campeonId);
      const lp = c.cambio.lp !== null ? ` · ${conSigno(c.cambio.lp)} LP` : '';
      return `${icono ? `${icono} ` : ''}**${c.p.nombre || c.jugador.nombre}** · ${nombreCampeon(c.p)} · ${c.p.k}/${c.p.d}/${c.p.a}${lp}`;
    });
    embed.addFields({ name: '🌟 Con su equipo', value: lineasEquipo.join('\n').slice(0, 1024) });
  }

  // Las tareas salen en la tarjeta solo si el equipo NO tiene canal de tareas aparte
  const avances = equipo.canalTareasId ? [] : resultados.flatMap((r) => (r.tareas ?? []).map((t) => ({ t, r })));
  if (avances.length) {
    const lineasTareas = avances.map(({ t, r }) => {
      const quien = resultados.length > 1 ? `**${r.p.nombre || r.jugador.nombre}** · ` : '';
      return t.completada
        ? `✅ ${quien}${describirTarea(t)} — **¡completada!**`
        : `${barraProgreso(t.progreso, t.cantidad)} ${quien}${describirTarea(t)} (${t.progreso}/${t.cantidad})`;
    });
    embed.addFields({ name: '📋 Tareas', value: lineasTareas.join('\n').slice(0, 1024) });
  }
  return embed;
}

function construirBotones({ jugador, region, resumen, yo }) {
  const nombre = yo.nombre || jugador.nombre;
  const tag = yo.tag || jugador.tag;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Ver partida').setURL(urlPartida(region, resumen.gameId)),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('OP.GG').setURL(urlOpgg(region, nombre, tag)),
    new ButtonBuilder()
      .setStyle(ButtonStyle.Primary)
      .setLabel('Scoreboard')
      .setEmoji('📊')
      .setCustomId(`sb|${resumen.id}|${yo.indice}`), // partida + quién es el jugador del aviso
  );
}

/** Rango compacto con emblema: "<emblema> III" · "<emblema> 245 LP" · o texto si aún no hay emojis. */
function rangoConEmblema(perfil) {
  if (perfil === undefined) return '¿?';
  if (!perfil) return 'Sin rango';
  const emblema = emojiRango(perfil.tier);
  if (TIERS_APEX.has(perfil.tier)) return emblema ? `${emblema} ${perfil.lp} LP` : `${TIER_CORTO[perfil.tier]} ${perfil.lp} LP`;
  return emblema ? `${emblema} ${perfil.division}` : `${TIER_CORTO[perfil.tier]} ${DIVISION_NUMERO[perfil.division]}`;
}

function construirEmbedScoreboard(resumen, rangos, indiceJugador, delEquipo = new Set()) {
  const yo = resumen.participantes[indiceJugador];
  const modo = MODOS[resumen.cola];
  const clasificados = resumen.participantes.map((p) => rangos.get(p.puuid)).filter(Boolean);
  const promedio = clasificados.length
    ? tierDesdeAbsoluto(clasificados.reduce((suma, p) => suma + p.abs, 0) / clasificados.length)
    : null;

  const linea = (p, conEmojis) => {
    const insignia = p.etiqueta === 'MVP' ? '⭐ `MVP`' : p.etiqueta === 'ACE' ? '🎖️ `ACE`' : `\`#${p.puesto}\``;
    const perfil = rangos.get(p.puuid);
    const iconos = conEmojis && emojiCampeon(p.campeonId)
      ? `${perfil === null ? '—' : rangoConEmblema(perfil)} ${emojiCampeon(p.campeonId)} `
      : '';
    const detalle = conEmojis && emojiCampeon(p.campeonId)
      ? ''
      : `\n${nombreCampeon(p)} · ${perfil === undefined ? '¿?' : rangoConEmblema(perfil)}`;
    const marca = p.indice === indiceJugador ? ' 👈' : delEquipo.has(p.puuid) ? ' 🌟' : '';
    const vision = p.pos === 'UTILITY' ? ` · ${p.vision} VS` : '';
    return `${iconos}${insignia} **${p.nombre || 'Jugador'}**${marca}${detalle}\n`
      + `↳ ${p.k}/${p.d}/${p.a} · ${Math.round(p.kp * 100)}% KP · ${p.csMin.toFixed(1)} CS/min${vision}`;
  };
  const equipo = (id) =>
    resumen.participantes
      .filter((p) => p.equipo === id)
      .sort((a, b) => ORDEN_POSICIONES.indexOf(a.pos) - ORDEN_POSICIONES.indexOf(b.pos));
  const columna = (id) => {
    const conEmojis = equipo(id).map((p) => linea(p, true)).join('\n\n');
    // Si con los emojis no cabe en el límite de Discord (1024), se muestra en texto
    return conEmojis.length <= 1024 ? conEmojis : equipo(id).map((p) => linea(p, false)).join('\n\n');
  };
  const titulo = (id, nombre) => {
    const miembros = equipo(id);
    const kills = resumen.killsEquipo?.[id] ?? miembros.reduce((s, p) => s + p.k, 0);
    return `${nombre} · ${miembros[0]?.gano ? 'Victoria' : 'Derrota'} · ${kills} kills`;
  };

  const descripcion = [`${modo?.emoji ?? '🎮'} **${modo?.nombre ?? 'Partida'}** · ⏱️ ${formatearDuracion(resumen.duracion)} · ${marcaDeTiempo(resumen.fin)}`];
  if (promedio) descripcion.push(`Promedio del lobby (SoloQ): ${conEmblema(promedio.tier, `**${promedio.texto}**`)}`);
  if (delEquipo.size > 1) descripcion.push('🌟 = de su mismo equipo');

  return new EmbedBuilder()
    .setColor(yo?.gano ? COLORES.victoria : COLORES.derrota)
    .setTitle('📊 Scoreboard')
    .setDescription(descripcion.join('\n'))
    .addFields(
      { name: titulo(100, '🔵 Azul'), value: columna(100) || '—', inline: true },
      { name: titulo(200, '🔴 Rojo'), value: columna(200) || '—', inline: true },
    )
    .setFooter({ text: 'Puntaje NTI: KDA, participación, daño, farm y visión · Rangos de SoloQ actuales' });
}

async function manejarBotonScoreboard(interaction) {
  const [, partidaId, indice] = interaction.customId.split('|');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral }); // solo lo ve quien pulsa
  await cargarDatosEstaticos();
  const resumen = await obtenerResumen(partidaId, 'alta');
  const rangos = await obtenerRangos(resumen, 'alta');

  // Quiénes de la partida son del mismo equipo que el jugador del aviso (para marcarlos 🌟)
  const puuids = resumen.participantes.map((p) => p.puuid);
  const conocidos = await jugadoresCol.find({ guildId: interaction.guildId, puuid: { $in: puuids } }).toArray();
  const delAviso = conocidos.find((j) => j.puuid === resumen.participantes[Number(indice)]?.puuid);
  const delEquipo = new Set(
    delAviso ? conocidos.filter((j) => String(j.equipoId) === String(delAviso.equipoId)).map((j) => j.puuid) : [],
  );

  return interaction.editReply({ embeds: [construirEmbedScoreboard(resumen, rangos, Number(indice), delEquipo)] });
}

function construirEmbedJugadorAgregado(jugador, equipo) {
  const perfil = jugador.perfilSoloQ;
  const flex = jugador.perfilFlex;
  const embed = new EmbedBuilder()
    .setColor(COLORES.info)
    .setTitle(`✅ ${jugador.nombre}#${jugador.tag} agregado a ${equipo.nombre}`)
    .setURL(urlOpgg(jugador.region, jugador.nombre, jugador.tag))
    .addFields(
      { name: 'Región', value: jugador.region, inline: true },
      { name: 'SoloQ', value: formatearElo(perfil), inline: true },
      { name: 'Récord SoloQ', value: textoRecord(perfil), inline: true },
    )
    .setFooter({ text: 'Los avisos empiezan desde su próxima partida (SoloQ, Flex o normal)' });
  if (flex) embed.addFields({ name: 'Flex', value: `${formatearElo(flex)} · ${calcularWinrate(flex)}% WR`, inline: true });
  if (jugador.discordId) embed.setDescription(`👤 <@${jugador.discordId}>`);
  if (perfil) embed.setThumbnail(urlEmblema(perfil.tier));
  return embed;
}

// ═════════════════════════ 10. SLASH COMMANDS ═════════════════════════

const opcionesRegion = Object.keys(REGIONES).map((r) => ({ name: r, value: r }));

const comandos = [
  new SlashCommandBuilder()
    .setName('equipo-crear')
    .setDescription('Crea un equipo y lo enlaza a un canal y a un rol de coach (solo admins)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) => o.setName('nombre').setDescription('Nombre del equipo, ej: Team A').setRequired(true).setMaxLength(40))
    .addChannelOption((o) => o.setName('canal').setDescription('Canal donde llegarán los avisos de este equipo').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addRoleOption((o) => o.setName('rol_coach').setDescription('Rol que podrá agregar y quitar jugadores de este equipo').setRequired(true))
    .addRoleOption((o) => o.setName('rol_ping').setDescription('(Opcional) Rol que se menciona en cada aviso de este equipo'))
    .addChannelOption((o) => o.setName('canal_tareas').setDescription('(Opcional) Canal aparte solo para las tareas de este equipo').addChannelTypes(ChannelType.GuildText))
    .addStringOption((o) => o.setName('modos').setDescription('(Opcional) Qué partidas mostrar (por defecto: todas)').addChoices(...ELECCIONES_MODOS)),

  new SlashCommandBuilder()
    .setName('equipo-modos')
    .setDescription('Elige qué partidas muestra un equipo: SoloQ, Flex, normales o todas (solo admins)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) => o.setName('equipo').setDescription('Nombre del equipo').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('modos').setDescription('Qué partidas mostrar').setRequired(true).addChoices(...ELECCIONES_MODOS)),

  new SlashCommandBuilder()
    .setName('equipo-tareas')
    .setDescription('Asigna o quita el canal de tareas de un equipo (solo admins)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) => o.setName('equipo').setDescription('Nombre del equipo').setRequired(true).setAutocomplete(true))
    .addChannelOption((o) => o.setName('canal').setDescription('Canal de tareas (déjalo vacío para que vuelvan al canal de partidas)').addChannelTypes(ChannelType.GuildText)),

  new SlashCommandBuilder()
    .setName('equipo-eliminar')
    .setDescription('Elimina un equipo y todos sus jugadores, pidiendo confirmación (solo admins)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) => o.setName('nombre').setDescription('Nombre del equipo').setRequired(true).setAutocomplete(true)),

  new SlashCommandBuilder()
    .setName('equipos')
    .setDescription('Lista los equipos configurados y su canal'),

  new SlashCommandBuilder()
    .setName('agregar')
    .setDescription('Agrega un jugador al equipo de ESTE canal (solo coaches)')
    .addStringOption((o) => o.setName('riot_id').setDescription('Riot ID completo, ej: Faker#KR1').setRequired(true))
    .addStringOption((o) => o.setName('region').setDescription('Servidor del jugador').setRequired(true).addChoices(...opcionesRegion))
    .addUserOption((o) => o.setName('discord').setDescription('(Opcional) Su usuario de Discord: se muestra en la tarjeta, sin pinguearlo')),

  new SlashCommandBuilder()
    .setName('vincular')
    .setDescription('Enlaza o quita el usuario de Discord de un jugador de ESTE canal (solo coaches)')
    .addStringOption((o) => o.setName('riot_id').setDescription('Jugador del equipo (elígelo de la lista)').setRequired(true).setAutocomplete(true))
    .addUserOption((o) => o.setName('discord').setDescription('Su usuario de Discord (déjalo vacío para quitar el enlace)')),

  new SlashCommandBuilder()
    .setName('quitar')
    .setDescription('Quita un jugador del equipo de ESTE canal (solo coaches)')
    .addStringOption((o) => o.setName('riot_id').setDescription('Jugador del equipo (elígelo de la lista)').setRequired(true).setAutocomplete(true))
    .addBooleanOption((o) => o.setName('borrar_mensajes').setDescription('¿Borrar también sus tarjetas y avisos? (las partidas en equipo se conservan)')),

  new SlashCommandBuilder()
    .setName('roster')
    .setDescription('Muestra los jugadores y el elo de un equipo (funciona en cualquier canal)')
    .addStringOption((o) => o.setName('equipo').setDescription('Qué equipo (en el canal de un equipo, se usa ese)').setAutocomplete(true)),

  new SlashCommandBuilder()
    .setName('probar')
    .setDescription('Envía la tarjeta de la última SoloQ de un jugador de este equipo (prueba, solo admins)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) => o.setName('riot_id').setDescription('Jugador del equipo (elígelo de la lista)').setRequired(true).setAutocomplete(true)),

  new SlashCommandBuilder()
    .setName('tarea')
    .setDescription('Tareas de los coaches para sus jugadores')
    .addSubcommand((s) => s
      .setName('crear')
      .setDescription('Asigna una tarea a un jugador o a todo el equipo de ESTE canal (solo coaches)')
      .addStringOption((o) => o.setName('tipo').setDescription('Qué tiene que hacer').setRequired(true).addChoices(
        { name: 'Jugar partidas', value: 'jugar' },
        { name: 'Jugar con un campeón', value: 'campeon' },
        { name: 'Jugar en un rol', value: 'rol' },
        { name: 'Partidas con KDA mínimo', value: 'kda' },
        { name: 'Partidas con CS/min mínimo', value: 'cs' },
        { name: 'Partidas con visión mínima', value: 'vision' },
      ))
      .addIntegerOption((o) => o.setName('cantidad').setDescription('Cuántas partidas').setRequired(true).setMinValue(1).setMaxValue(50))
      .addStringOption((o) => o.setName('modo').setDescription('En qué partidas cuenta la tarea').setRequired(true).addChoices(
        { name: 'Solo SoloQ', value: 'soloq' }, { name: 'Solo Flex', value: 'flex' },
        { name: 'Ranked (SoloQ o Flex)', value: 'ranked' }, { name: 'Solo normales', value: 'normal' },
        { name: 'Cualquier modo', value: 'cualquiera' },
      ))
      .addStringOption((o) => o.setName('jugador').setDescription('Jugador del equipo (vacío = TODO el equipo)').setAutocomplete(true))
      .addStringOption((o) => o.setName('campeon').setDescription('Para "Jugar con un campeón"').setAutocomplete(true))
      .addStringOption((o) => o.setName('rol').setDescription('Para "Jugar en un rol"').addChoices(
        { name: 'Top', value: 'TOP' }, { name: 'Jungla', value: 'JUNGLE' }, { name: 'Mid', value: 'MIDDLE' },
        { name: 'ADC', value: 'BOTTOM' }, { name: 'Support', value: 'UTILITY' },
      ))
      .addNumberOption((o) => o.setName('valor').setDescription('Para KDA, CS/min o visión: el mínimo (ej. 3, 7.5, 40)').setMinValue(0))
      .addBooleanOption((o) => o.setName('ganar').setDescription('¿Solo cuentan las victorias? (por defecto: no)'))
      .addIntegerOption((o) => o.setName('dias').setDescription('Días para cumplirla (por defecto: 7)').setMinValue(1).setMaxValue(60)))
    .addSubcommand((s) => s
      .setName('lista')
      .setDescription('Tareas activas y recientes de un equipo (funciona en cualquier canal)')
      .addStringOption((o) => o.setName('equipo').setDescription('Qué equipo (en el canal de un equipo, se usa ese)').setAutocomplete(true)))
    .addSubcommand((s) => s
      .setName('cancelar')
      .setDescription('Cancela una tarea activa (solo coaches)')
      .addStringOption((o) => o.setName('tarea').setDescription('Elige la tarea de la lista').setRequired(true).setAutocomplete(true))),

  new SlashCommandBuilder()
    .setName('pool')
    .setDescription('Champion pool de los jugadores: su tier list de campeones')
    .addSubcommand((s) => s
      .setName('agregar')
      .setDescription('Agrega o mueve un campeón en el pool (el propio jugador o su coach)')
      .addStringOption((o) => o.setName('campeon').setDescription('Campeón').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('tier').setDescription('Nivel').setRequired(true).addChoices(
        ...Object.entries(NIVELES_POOL).map(([valor, n]) => ({ name: `${valor} · ${n.nombre}`, value: valor })),
      ))
      .addStringOption((o) => o.setName('rol').setDescription('(Opcional) En qué rol lo juega').addChoices(...OPCIONES_ROL))
      .addStringOption((o) => o.setName('jugador').setDescription('(Coaches) De qué jugador; vacío = tú mismo').setAutocomplete(true)))
    .addSubcommand((s) => s
      .setName('quitar')
      .setDescription('Quita un campeón del pool')
      .addStringOption((o) => o.setName('campeon').setDescription('Campeón').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('jugador').setDescription('(Coaches) De qué jugador; vacío = tú mismo').setAutocomplete(true)))
    .addSubcommand((s) => s
      .setName('ver')
      .setDescription('Muestra el champion pool de un jugador (cualquier canal)')
      .addStringOption((o) => o.setName('jugador').setDescription('Jugador; vacío = tú mismo').setAutocomplete(true)))
    .addSubcommand((s) => s
      .setName('equipo')
      .setDescription('Pools de todo un equipo de un vistazo (cualquier canal)')
      .addStringOption((o) => o.setName('equipo').setDescription('Qué equipo (en el canal de un equipo, se usa ese)').setAutocomplete(true))),

  new SlashCommandBuilder()
    .setName('ayuda')
    .setDescription('Qué hace cada comando del bot'),
];
// Los comandos solo existen dentro de servidores (no en mensajes directos al bot)
for (const comando of comandos) comando.setContexts(InteractionContextType.Guild);

// --- Helpers de permisos y respuestas ---

const esAdmin = (miembro) => miembro.permissions.has(PermissionFlagsBits.ManageGuild);
const puedeGestionar = (miembro, equipo) => esAdmin(miembro) || miembro.roles.cache.has(equipo.rolCoachId);
const equipoDelCanal = async (interaction) =>
  (await equiposCol.findOne({ guildId: interaction.guildId, canalId: interaction.channelId }))
  ?? (await equiposCol.findOne({ guildId: interaction.guildId, canalTareasId: interaction.channelId }));

async function botPuedeEscribir(interaction, canal) {
  const yo = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe());
  // Las tarjetas llevan imágenes adjuntas (emblema y detalle) y emojis del bot
  const necesarios = [
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles, PermissionFlagsBits.UseExternalEmojis,
  ];
  return Boolean(canal.permissionsFor(yo)?.has(necesarios));
}

/** Devuelve el motivo por el que ese canal no sirve como canal de tareas, o null si sirve. */
async function problemaCanalTareas(interaction, canal, equipo) {
  if (canal.id === equipo.canalId) return '⚠️ Ese es el canal de partidas del equipo. Para las tareas elige otro canal.';
  const otro = (await equiposCol.find({ guildId: interaction.guildId }).toArray())
    .find((e) => String(e._id) !== String(equipo._id) && (e.canalId === canal.id || e.canalTareasId === canal.id));
  if (otro) return `⚠️ ${canal} ya lo usa el equipo **${otro.nombre}**. Elige otro canal.`;
  if (!(await botPuedeEscribir(interaction, canal))) {
    return `⚠️ Me faltan permisos en ${canal}: necesito Ver canal, Enviar mensajes, Insertar enlaces, Adjuntar archivos y Usar emojis externos. Dámelos y vuelve a intentar.`;
  }
  return null;
}

function responderPrivado(interaction, content) {
  if (interaction.deferred || interaction.replied) return interaction.editReply({ content, embeds: [] });
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

/**
 * Para comandos de consulta (/roster, /tarea lista) que funcionan en cualquier canal:
 * 1) el equipo elegido en la opción "equipo"; 2) el equipo de este canal; 3) si el servidor tiene uno solo, ese.
 * Devuelve { equipo } o { error } con el mensaje para el usuario.
 */
async function equipoParaConsulta(interaction) {
  const nombre = interaction.options.getString('equipo')?.trim();
  if (nombre) {
    const elegido = await equiposCol.findOne({ guildId: interaction.guildId, nombreLower: nombre.toLowerCase() });
    return elegido ? { equipo: elegido } : { error: `No encontré el equipo **${nombre}**. Elígelo de la lista al escribir.` };
  }
  const delCanal = await equipoDelCanal(interaction);
  if (delCanal) return { equipo: delCanal };
  const todos = await equiposCol.find({ guildId: interaction.guildId }).toArray();
  if (todos.length === 1) return { equipo: todos[0] };
  if (!todos.length) return { error: 'Este servidor aún no tiene equipos. Un admin puede crearlos con /equipo-crear.' };
  return { error: `¿De qué equipo? Elige uno en la opción \`equipo\`: ${todos.map((e) => `**${e.nombre}**`).join(', ')}.` };
}

const SIN_EQUIPO = '⚠️ Este canal no pertenece a ningún equipo. Usa el comando dentro del canal de tu equipo.';

// --- Lógica de cada comando ---

const manejadores = {
  async 'equipo-crear'(interaction) {
    // Quién puede usarlo lo controla Discord: por defecto quien tenga "Gestionar servidor", y un admin
    // puede habilitar a otras personas o roles en Ajustes del servidor → Integraciones → LD Tracker.

    const nombre = interaction.options.getString('nombre').trim();
    const canal = interaction.options.getChannel('canal');
    const rolCoach = interaction.options.getRole('rol_coach');
    const rolPing = interaction.options.getRole('rol_ping');
    const canalTareas = interaction.options.getChannel('canal_tareas');

    // Verificamos que el bot pueda escribir en los canales ANTES de guardarlos
    if (!(await botPuedeEscribir(interaction, canal))) {
      return responderPrivado(interaction, `⚠️ Me faltan permisos en ${canal}: necesito Ver canal, Enviar mensajes, Insertar enlaces, Adjuntar archivos y Usar emojis externos. Dámelos y vuelve a intentar.`);
    }
    if (await equiposCol.findOne({ guildId: interaction.guildId, canalTareasId: canal.id })) {
      return responderPrivado(interaction, `⚠️ ${canal} ya es el canal de tareas de otro equipo. Elige otro canal para las partidas.`);
    }
    if (canalTareas) {
      const problema = await problemaCanalTareas(interaction, canalTareas, { canalId: canal.id });
      if (problema) return responderPrivado(interaction, problema);
    }

    try {
      await equiposCol.insertOne({
        guildId: interaction.guildId,
        nombre,
        nombreLower: nombre.toLowerCase(),
        canalId: canal.id,
        rolCoachId: rolCoach.id,
        rolPingId: rolPing?.id ?? null,
        canalTareasId: canalTareas?.id ?? null,
        modos: interaction.options.getString('modos') ?? 'todas',
        creadoEn: new Date(),
      });
    } catch (err) {
      if (err.code === 11000) {
        return responderPrivado(interaction, '⚠️ Ya existe un equipo con ese nombre, o ese canal ya pertenece a otro equipo.');
      }
      throw err;
    }

    return interaction.reply(
      `✅ Equipo **${nombre}** creado.\nPartidas en ${canal}${canalTareas ? ` · Tareas en ${canalTareas}` : ''} · Coaches: ${rolCoach}${rolPing ? ` · Ping: ${rolPing}` : ''}\n🎮 Muestra: **${OPCIONES_MODOS[interaction.options.getString('modos') ?? 'todas'].nombre}**`,
    );
  },

  async 'equipo-eliminar'(interaction) {
    // Quién puede usarlo lo controla Discord: por defecto quien tenga "Gestionar servidor", y un admin
    // puede habilitar a otras personas o roles en Ajustes del servidor → Integraciones → LD Tracker.

    const nombre = interaction.options.getString('nombre').trim();
    const equipo = await equiposCol.findOne({ guildId: interaction.guildId, nombreLower: nombre.toLowerCase() });
    if (!equipo) return responderPrivado(interaction, `No encontré el equipo **${nombre}**. Revisa con /equipos.`);

    // No se borra nada todavía: primero se pide confirmación con botones (solo para quien lo pidió)
    const jugadores = (await jugadoresCol.find({ equipoId: equipo._id }).toArray()).length;
    const mensajes = (await mensajesCol.find({ equipoId: equipo._id }).toArray()).length;
    const datos = `${interaction.user.id}|${Date.now()}|${equipo.nombreLower}`;
    const botones = [
      new ButtonBuilder().setCustomId(`eqdel|si|${datos}`).setStyle(ButtonStyle.Danger).setLabel('Eliminar equipo').setEmoji('🗑️'),
    ];
    if (mensajes) {
      botones.push(new ButtonBuilder().setCustomId(`eqdel|msg|${datos}`).setStyle(ButtonStyle.Danger)
        .setLabel(`Eliminar y borrar ${mensajes} mensajes del bot`).setEmoji('🧹'));
    }
    botones.push(new ButtonBuilder().setCustomId(`eqdel|no|${datos}`).setStyle(ButtonStyle.Secondary).setLabel('Cancelar'));

    return interaction.reply({
      content: `⚠️ **¿Seguro que quieres eliminar ${equipo.nombre}?**\n`
        + `Se borran sus ${jugadores} jugador(es), sus tareas y su configuración. **No se puede deshacer.**\n`
        + 'Los canales de Discord NO se borran. Esta confirmación vence en 2 minutos.',
      components: [new ActionRowBuilder().addComponents(botones)],
      flags: MessageFlags.Ephemeral,
    });
  },

  async 'equipo-modos'(interaction) {
    // Quién puede usarlo lo controla Discord (por defecto, quien tenga "Gestionar servidor")
    const nombre = interaction.options.getString('equipo').trim();
    const equipo = await equiposCol.findOne({ guildId: interaction.guildId, nombreLower: nombre.toLowerCase() });
    if (!equipo) return responderPrivado(interaction, `No encontré el equipo **${nombre}**. Elígelo de la lista.`);

    const modos = interaction.options.getString('modos');
    await equiposCol.updateOne({ _id: equipo._id }, { $set: { modos } });
    return interaction.reply(
      `🎮 Listo: **${equipo.nombre}** ahora muestra **${OPCIONES_MODOS[modos].nombre}** en <#${equipo.canalId}>.\n`
      + 'Las demás partidas no salen en el canal, pero sus LP, rachas y tareas se siguen contando igual.',
    );
  },

  async 'equipo-tareas'(interaction) {
    // Quién puede usarlo lo controla Discord: por defecto quien tenga "Gestionar servidor", y un admin
    // puede habilitar a otras personas o roles en Ajustes del servidor → Integraciones → LD Tracker.

    const nombre = interaction.options.getString('equipo').trim();
    const equipo = await equiposCol.findOne({ guildId: interaction.guildId, nombreLower: nombre.toLowerCase() });
    if (!equipo) return responderPrivado(interaction, `No encontré el equipo **${nombre}**. Elígelo de la lista.`);

    const canal = interaction.options.getChannel('canal');
    if (!canal) {
      await equiposCol.updateOne({ _id: equipo._id }, { $set: { canalTareasId: null } });
      return interaction.reply(`📋 Listo: las tareas de **${equipo.nombre}** vuelven a salir en su canal de partidas <#${equipo.canalId}>.`);
    }
    const problema = await problemaCanalTareas(interaction, canal, equipo);
    if (problema) return responderPrivado(interaction, problema);

    await equiposCol.updateOne({ _id: equipo._id }, { $set: { canalTareasId: canal.id } });
    return interaction.reply(
      `📋 Listo: las tareas de **${equipo.nombre}** ahora van en ${canal}.\nLas partidas siguen en <#${equipo.canalId}>, y los comandos del equipo funcionan en los dos canales.`,
    );
  },

  async equipos(interaction) {
    const lista = await equiposCol.find({ guildId: interaction.guildId }).sort({ nombreLower: 1 }).toArray();
    if (!lista.length) return responderPrivado(interaction, 'Aún no hay equipos. Un admin puede crearlos con /equipo-crear.');

    const conteos = await jugadoresCol
      .aggregate([{ $match: { guildId: interaction.guildId } }, { $group: { _id: '$equipoId', total: { $sum: 1 } } }])
      .toArray();
    const totalPorEquipo = new Map(conteos.map((c) => [String(c._id), c.total]));

    const lineas = lista.map((e) =>
      `**${e.nombre}** → <#${e.canalId}>${e.canalTareasId ? ` · 📋 <#${e.canalTareasId}>` : ''} · Coach: <@&${e.rolCoachId}> · ${totalPorEquipo.get(String(e._id)) ?? 0} jugadores · 🎮 ${opcionModos(e).nombre}`,
    );
    const embed = new EmbedBuilder().setColor(COLORES.info).setTitle('🏟️ Equipos de la organización').setDescription(lineas.join('\n'));
    return interaction.reply({ embeds: [embed] });
  },

  async agregar(interaction) {
    const equipo = await equipoDelCanal(interaction);
    if (!equipo) return responderPrivado(interaction, SIN_EQUIPO);
    if (!puedeGestionar(interaction.member, equipo)) {
      return responderPrivado(interaction, `⛔ Solo los coaches de **${equipo.nombre}** pueden agregar jugadores aquí.`);
    }

    const riotId = separarRiotId(interaction.options.getString('riot_id'));
    if (!riotId) return responderPrivado(interaction, '⚠️ Formato inválido. Escribe el Riot ID completo, ej: `Faker#KR1`');

    await interaction.deferReply(); // las consultas a Riot pueden tardar unos segundos

    let cuenta;
    try {
      cuenta = await riot.cuentaPorRiotId(riotId.nombre, riotId.tag, 'alta');
    } catch (err) {
      if (err.status === 404) {
        return interaction.editReply(`❌ No existe el Riot ID **${riotId.nombre}#${riotId.tag}**. Revisa espacios, tildes y el tag.`);
      }
      throw err;
    }

    const existente = await jugadoresCol.findOne({ guildId: interaction.guildId, puuid: cuenta.puuid });
    if (existente) {
      const otroEquipo = await equiposCol.findOne({ _id: existente.equipoId });
      return interaction.editReply(
        `⚠️ **${cuenta.gameName}#${cuenta.tagLine}** ya está en **${otroEquipo?.nombre ?? 'otro equipo'}**. Un jugador solo puede estar en un equipo.`,
      );
    }

    // Si su última partida fue en otro servidor, corregimos la región automáticamente
    let region = interaction.options.getString('region');
    const ultimas = await riot.ultimasPartidas(REGIONES[region].regional, cuenta.puuid, 'alta');
    const regionDetectada = ultimas[0] ? REGION_POR_PLATAFORMA[ultimas[0].split('_')[0].toLowerCase()] : null;
    const regionCorregida = Boolean(regionDetectada && regionDetectada !== region);
    if (regionCorregida) region = regionDetectada;

    const perfiles = await obtenerPerfiles(REGIONES[region].plataforma, cuenta.puuid, 'alta');
    const perfil = perfiles.soloq;

    const jugador = {
      guildId: interaction.guildId,
      equipoId: equipo._id,
      nombre: cuenta.gameName,
      tag: cuenta.tagLine,
      riotIdLower: riotIdEnMinusculas(cuenta.gameName, cuenta.tagLine),
      region,
      puuid: cuenta.puuid,
      procesadas: ultimas.slice(0, MAX_PROCESADAS), // punto de partida: no anunciamos partidas viejas
      perfilSoloQ: perfil,
      perfilFlex: perfiles.flex,
      rachas: { soloq: 0, flex: 0, normal: 0 },
      racha: 0,
      esperasLP: 0,
      discordId: interaction.options.getUser('discord')?.id ?? null,
      agregadoPor: interaction.user.id,
      creadoEn: new Date(),
    };

    try {
      await jugadoresCol.insertOne(jugador);
    } catch (err) {
      if (err.code === 11000) return interaction.editReply('⚠️ Ese jugador acaba de ser registrado en otro equipo.');
      throw err;
    }

    const embed = construirEmbedJugadorAgregado(jugador, equipo);
    const archivos = await adjuntarEmblema(embed, perfil);
    return interaction.editReply({
      content: regionCorregida ? `ℹ️ Su última partida fue en **${region}**, así que lo registré en esa región.` : '',
      embeds: [embed],
      files: archivos,
    });
  },

  async quitar(interaction) {
    const equipo = await equipoDelCanal(interaction);
    if (!equipo) return responderPrivado(interaction, SIN_EQUIPO);
    if (!puedeGestionar(interaction.member, equipo)) {
      return responderPrivado(interaction, `⛔ Solo los coaches de **${equipo.nombre}** pueden quitar jugadores aquí.`);
    }

    const riotId = separarRiotId(interaction.options.getString('riot_id'));
    if (!riotId) return responderPrivado(interaction, '⚠️ Formato inválido. Escribe el Riot ID completo, ej: `Faker#KR1`');

    const jugador = await jugadoresCol.findOne({
      equipoId: equipo._id,
      riotIdLower: riotIdEnMinusculas(riotId.nombre, riotId.tag),
    });
    if (!jugador) {
      return responderPrivado(interaction, `No encontré a **${riotId.nombre}#${riotId.tag}** en **${equipo.nombre}**. Revisa con /roster.`);
    }
    await jugadoresCol.deleteOne({ _id: jugador._id });
    await tareasCol.deleteMany({ puuid: jugador.puuid, estado: 'activa' });

    if (!interaction.options.getBoolean('borrar_mensajes')) {
      return interaction.reply(`🗑️ **${riotId.nombre}#${riotId.tag}** ya no está en **${equipo.nombre}**.`);
    }
    // Solo los mensajes que hablan ÚNICAMENTE de él: las tarjetas de partidas en equipo se conservan
    const suyos = (await mensajesCol.find({ equipoId: equipo._id }).toArray())
      .filter((m) => m.puuids?.length === 1 && m.puuids[0] === jugador.puuid);
    await interaction.reply(`🗑️ **${riotId.nombre}#${riotId.tag}** ya no está en **${equipo.nombre}**. 🧹 Borrando sus mensajes…`);
    const borrados = await borrarMensajesDelBot(suyos);
    await interaction.followUp({ content: `🧹 Listo: borré ${borrados} mensaje(s) de **${riotId.nombre}#${riotId.tag}**.`, flags: MessageFlags.Ephemeral }).catch(() => {});
  },

  async vincular(interaction) {
    const equipo = await equipoDelCanal(interaction);
    if (!equipo) return responderPrivado(interaction, SIN_EQUIPO);
    if (!puedeGestionar(interaction.member, equipo)) {
      return responderPrivado(interaction, `⛔ Solo los coaches de **${equipo.nombre}** pueden hacer esto aquí.`);
    }

    const riotId = separarRiotId(interaction.options.getString('riot_id'));
    if (!riotId) return responderPrivado(interaction, '⚠️ Formato inválido. Escribe el Riot ID completo, ej: `Faker#KR1`');

    const usuario = interaction.options.getUser('discord');
    const filtro = { equipoId: equipo._id, riotIdLower: riotIdEnMinusculas(riotId.nombre, riotId.tag) };
    const jugador = await jugadoresCol.findOne(filtro);
    if (!jugador) return responderPrivado(interaction, `No encontré a **${riotId.nombre}#${riotId.tag}** en **${equipo.nombre}**. Revisa con /roster.`);

    await jugadoresCol.updateOne({ _id: jugador._id }, { $set: { discordId: usuario?.id ?? null } });
    return responderPrivado(
      interaction,
      usuario
        ? `🔗 **${jugador.nombre}#${jugador.tag}** quedó enlazado a ${usuario}. Se verá en sus tarjetas, sin pinguearlo.`
        : `🔗 Quité el usuario de Discord de **${jugador.nombre}#${jugador.tag}**.`,
    );
  },

  async roster(interaction) {
    const { equipo, error } = await equipoParaConsulta(interaction);
    if (error) return responderPrivado(interaction, error);

    const jugadores = await jugadoresCol.find({ equipoId: equipo._id }).toArray();
    if (!jugadores.length) {
      return responderPrivado(interaction, `**${equipo.nombre}** aún no tiene jugadores. Un coach puede usar /agregar aquí.`);
    }

    jugadores.sort((a, b) => (b.perfilSoloQ?.abs ?? -1) - (a.perfilSoloQ?.abs ?? -1));
    const medallas = ['🥇', '🥈', '🥉'];
    const lineas = jugadores.map((j, i) => {
      const p = j.perfilSoloQ;
      const emblema = emojiRango(p?.tier);
      const rachaSolo = j.rachas?.soloq ?? j.racha ?? 0;
      const racha = rachaSolo >= 3 ? ` · 🔥${rachaSolo}` : rachaSolo <= -3 ? ` · 🥶${-rachaSolo}` : '';
      const flex = j.perfilFlex ? ` · Flex ${rangoConEmblema(j.perfilFlex)}` : '';
      const usuario = j.discordId ? ` · <@${j.discordId}>` : '';
      const detalle = p ? `${emblema ? `${emblema} ` : ''}${formatearElo(p)} · ${calcularWinrate(p)}% WR (${p.wins}V ${p.losses}D)` : 'Sin clasificar';
      return `${medallas[i] ?? `\`${i + 1}.\``} **${j.nombre}#${j.tag}**${usuario}\n${detalle}${flex}${racha}`;
    });

    const embed = new EmbedBuilder()
      .setColor(COLORES.info)
      .setTitle(`📋 Roster de ${equipo.nombre}`)
      .setDescription(lineas.join('\n'))
      .setFooter({ text: `${jugadores.length} jugador(es) · Ordenado por SoloQ · El elo se actualiza después de cada partida` });
    return interaction.reply({ embeds: [embed] });
  },

  // Manda la tarjeta de la última SoloQ ya jugada, por el MISMO camino que los avisos reales.
  // No guarda nada: el seguimiento automático sigue exactamente igual.
  async probar(interaction) {
    // Quién puede usarlo lo controla Discord: por defecto quien tenga "Gestionar servidor", y un admin
    // puede habilitar a otras personas o roles en Ajustes del servidor → Integraciones → LD Tracker.

    const equipo = await equipoDelCanal(interaction);
    if (!equipo) return responderPrivado(interaction, SIN_EQUIPO);

    const riotId = separarRiotId(interaction.options.getString('riot_id'));
    if (!riotId) return responderPrivado(interaction, '⚠️ Formato inválido. Escribe el Riot ID completo, ej: `Faker#KR1`');

    const jugador = await jugadoresCol.findOne({
      equipoId: equipo._id,
      riotIdLower: riotIdEnMinusculas(riotId.nombre, riotId.tag),
    });
    if (!jugador) {
      return responderPrivado(interaction, `No encontré a **${riotId.nombre}#${riotId.tag}** en **${equipo.nombre}**. Agrégalo primero con /agregar.`);
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const regional = REGIONES[jugador.region]?.regional ?? 'americas';
    const ids = await riot.ultimasPartidas(regional, jugador.puuid, 'alta');

    // La más reciente de un modo que seguimos (SoloQ, Flex o normal), sin contar remakes
    let resumen = null;
    for (const id of ids) {
      const candidato = await obtenerResumen(id, 'alta');
      const participante = candidato.participantes.find((p) => p.puuid === jugador.puuid);
      if (modoDeCola(candidato.cola) && participante && !participante.remake) {
        resumen = candidato;
        break;
      }
    }
    if (!resumen) return interaction.editReply('Ese jugador no tiene partidas recientes de SoloQ, Flex o normales.');

    const modo = modoDeCola(resumen.cola);
    const yo = resumen.participantes.find((p) => p.puuid === jugador.puuid);
    const perfiles = await obtenerPerfiles(resumen.plataforma, jugador.puuid, 'alta');
    const racha = jugador.rachas?.[modo.clave] || (yo.gano ? 1 : -1);
    const resultado = {
      jugador,
      p: yo,
      modo,
      racha,
      rachas: jugador.rachas ?? {},
      perfiles,
      perfilModo: modo.ranked ? perfiles[modo.clave] : null,
      cambio: { lp: null, nota: '🧪 Prueba' },
      tareas: [],
    };
    const mensaje = await construirMensajePartida({ equipo, resumen, modo, resultados: [resultado], prueba: true });

    const enviado = await enviarAviso(equipo, mensaje, { conPing: false });
    if (enviado) await registrarMensaje(equipo, enviado, [jugador.puuid], 'prueba');
    obtenerRangos(resumen, 'alta').catch(() => {}); // deja listo el Scoreboard mientras lees la tarjeta
    return interaction.editReply(
      enviado
        ? `✅ Tarjeta de prueba enviada a <#${equipo.canalId}>.`
        : '⚠️ No pude enviar la tarjeta. Revisa que el bot pueda ver, escribir e insertar enlaces en ese canal.',
    );
  },

  async tarea(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'lista') {
      // Consultar tareas se puede desde cualquier canal
      const { equipo, error } = await equipoParaConsulta(interaction);
      if (error) return responderPrivado(interaction, error);
      return listarTareas(interaction, equipo);
    }
    // Crear o cancelar sí se hace desde el canal del equipo (así queda claro de qué equipo es)
    const equipo = await equipoDelCanal(interaction);
    if (!equipo) return responderPrivado(interaction, SIN_EQUIPO);
    if (!puedeGestionar(interaction.member, equipo)) {
      return responderPrivado(interaction, `⛔ Solo los coaches de **${equipo.nombre}** pueden manejar tareas aquí.`);
    }
    if (sub === 'cancelar') return cancelarTarea(interaction, equipo);
    return crearTarea(interaction, equipo);
  },

  async pool(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'equipo') {
      const { equipo, error } = await equipoParaConsulta(interaction);
      if (error) return responderPrivado(interaction, error);
      return mostrarPoolEquipo(interaction, equipo);
    }

    const { jugador, error } = await jugadorParaPool(interaction);
    if (error) return responderPrivado(interaction, error);
    if (sub === 'ver') return interaction.reply({ embeds: [await construirEmbedPool(jugador)] });

    // Agregar o quitar: el propio jugador (con su Discord enlazado) o un coach de su equipo
    const equipo = await equiposCol.findOne({ _id: jugador.equipoId });
    const esElMismo = Boolean(jugador.discordId) && jugador.discordId === interaction.user.id;
    if (!esElMismo && !(equipo && puedeGestionar(interaction.member, equipo))) {
      return responderPrivado(interaction, '⛔ Solo el propio jugador (con su Discord enlazado) o un coach de su equipo puede cambiar su pool.');
    }

    await cargarDatosEstaticos();
    const campeon = buscarCampeon(interaction.options.getString('campeon'));
    if (!campeon) return responderPrivado(interaction, '⚠️ Elige el campeón de la lista al escribir.');
    const anterior = jugador.pool ?? [];
    const pool = anterior.filter((c) => c.campeonId !== campeon.id);
    const quien = `**${jugador.nombre}#${jugador.tag}**`;

    if (sub === 'quitar') {
      if (pool.length === anterior.length) return responderPrivado(interaction, `**${campeon.nombre}** no está en el pool de ${quien}.`);
      await jugadoresCol.updateOne({ _id: jugador._id }, { $set: { pool } });
      return responderPrivado(interaction, `🗑️ Quité a **${campeon.nombre}** del pool de ${quien}.`);
    }

    if (pool.length >= MAX_CAMPEONES_POOL) {
      return responderPrivado(interaction, `⚠️ El pool ya tiene ${MAX_CAMPEONES_POOL} campeones. Quita alguno con /pool quitar.`);
    }
    const tier = interaction.options.getString('tier');
    pool.push({ campeonId: campeon.id, tier, rol: interaction.options.getString('rol') ?? null });
    await jugadoresCol.updateOne({ _id: jugador._id }, { $set: { pool } });
    // En privado, para que agregar varios campeones seguidos no llene el canal
    return interaction.reply({
      content: `${NIVELES_POOL[tier].emoji} **${campeon.nombre}** quedó en **${tier}** en el pool de ${quien}. Muéstralo a todos con \`/pool ver\`.`,
      embeds: [await construirEmbedPool({ ...jugador, pool })],
      flags: MessageFlags.Ephemeral,
    });
  },

  async ayuda(interaction) {
    const embed = new EmbedBuilder()
      .setColor(COLORES.info)
      .setTitle('🤖 Comandos del bot')
      .addFields(
        { name: '👑 Admins', value: '`/equipo-crear` · `/equipo-modos` (qué partidas mostrar) · `/equipo-tareas` (canal aparte para tareas) · `/equipo-eliminar` (con confirmación) · `/probar`' },
        { name: '🎯 Coaches (en el canal de su equipo)', value: '`/agregar` · `/quitar` · `/vincular` (enlaza su Discord)\n`/tarea crear` · `/tarea cancelar`' },
        { name: '👥 Todos (en cualquier canal)', value: '`/roster equipo:…` · `/tarea lista equipo:…` · `/pool ver` · `/pool equipo` · `/equipos` · `/ayuda`\n`/pool agregar` · `/pool quitar` (tu propio champion pool)' },
        { name: '📬 Avisos automáticos', value: 'SoloQ, Flex y normales. Si varios del mismo equipo juegan juntos, sale una sola tarjeta en **dorado** 🌟.' },
      )
      .setFooter({ text: 'En el canal de un equipo no hace falta elegir el equipo: se usa ese' });
    return interaction.reply({ embeds: [embed] }); // pública: así todos ven cómo usar el bot
  },
};

// --- Champion pool ---

/** El jugador de la opción "jugador" (cualquier equipo del servidor), o el propio usuario si tiene su Discord enlazado. */
async function jugadorParaPool(interaction) {
  const texto = interaction.options.getString('jugador')?.trim();
  if (texto) {
    const riotId = separarRiotId(texto);
    let jugador = riotId
      ? await jugadoresCol.findOne({ guildId: interaction.guildId, riotIdLower: riotIdEnMinusculas(riotId.nombre, riotId.tag) })
      : null;
    if (!jugador && !riotId) {
      const candidatos = (await jugadoresCol.find({ guildId: interaction.guildId }).toArray())
        .filter((j) => normalizar(j.nombre) === normalizar(texto));
      if (candidatos.length === 1) jugador = candidatos[0];
    }
    return jugador ? { jugador } : { error: `No encontré a **${texto}** en este servidor. Elígelo de la lista al escribir.` };
  }
  const propio = await jugadoresCol.findOne({ guildId: interaction.guildId, discordId: interaction.user.id });
  return propio
    ? { jugador: propio }
    : { error: 'No encontré tu cuenta: elige un jugador en la opción `jugador`, o pídele a tu coach que enlace tu Discord con /vincular.' };
}

async function construirEmbedPool(jugador) {
  await cargarDatosEstaticos();
  const stats = jugador.stats ?? {};
  const pool = jugador.pool ?? [];
  const nombreDe = (id) => estatico.campeones.get(Number(id)) ?? `#${id}`;
  const conIcono = (id, texto) => (emojiCampeon(id) ? `${emojiCampeon(id)} ${texto}` : texto);
  const winrate = (s) => Math.round((s.g / s.j) * 100);

  const embed = new EmbedBuilder()
    .setColor(COLORES.info)
    .setTitle(`🏆 Champion pool de ${jugador.nombre}#${jugador.tag}`)
    .setFooter({ text: 'S Main · A Muy cómodo · B Lo juega bien · C En práctica · P = partidas en ranked' });
  if (jugador.perfilSoloQ) embed.setThumbnail(urlEmblema(jugador.perfilSoloQ.tier));

  // 1) Lo que el jugador DICE que juega (su tier list)
  for (const [tier, nivel] of Object.entries(NIVELES_POOL)) {
    const campeones = pool.filter((c) => c.tier === tier);
    if (!campeones.length) continue;
    const lineas = campeones.map((c) => {
      const s = stats[String(c.campeonId)];
      const rol = c.rol ? ` · ${NOMBRE_ROL[c.rol]}` : '';
      const datos = s ? ` · ${s.j}P ${winrate(s)}%` : '';
      return conIcono(c.campeonId, `**${nombreDe(c.campeonId)}**${rol}${datos}`);
    });
    embed.addFields({ name: `${nivel.emoji} ${tier} · ${nivel.nombre}`, value: lineas.join('\n').slice(0, 1024) });
  }

  // 2) Lo que REALMENTE juega en ranked, según el bot
  const masJugados = Object.entries(stats).sort((a, b) => b[1].j - a[1].j).slice(0, 5);
  if (masJugados.length) {
    const enPool = new Set(pool.map((c) => String(c.campeonId)));
    const lineas = masJugados.map(([id, s]) => {
      const kda = ((s.k + s.a) / Math.max(1, s.d)).toFixed(1);
      const aviso = enPool.has(id) ? '' : ' · ⚠️ no está en su pool';
      return conIcono(id, `**${nombreDe(id)}** · ${s.j}P · ${winrate(s)}% WR · KDA ${kda}${aviso}`);
    });
    embed.addFields({ name: '📊 Más jugados en ranked (desde que el bot lo sigue)', value: lineas.join('\n').slice(0, 1024) });
  }

  if (!embed.data.fields?.length) embed.setDescription('Todavía no tiene campeones en su pool. Se agregan con `/pool agregar`.');
  return embed;
}

async function mostrarPoolEquipo(interaction, equipo) {
  await cargarDatosEstaticos();
  const jugadores = (await jugadoresCol.find({ equipoId: equipo._id }).toArray())
    .sort((a, b) => (b.perfilSoloQ?.abs ?? -1) - (a.perfilSoloQ?.abs ?? -1));
  if (!jugadores.length) return responderPrivado(interaction, `**${equipo.nombre}** aún no tiene jugadores.`);

  const corto = (c) => emojiCampeon(c.campeonId) || estatico.campeones.get(c.campeonId) || `#${c.campeonId}`;
  const lineas = jugadores.map((j) => {
    const pool = j.pool ?? [];
    const niveles = ['S', 'A']
      .map((tier) => {
        const campeones = pool.filter((c) => c.tier === tier);
        return campeones.length ? `${NIVELES_POOL[tier].emoji} ${campeones.map(corto).join(' · ')}` : null;
      })
      .filter(Boolean);
    return `**${j.nombre}#${j.tag}**\n${niveles.length ? niveles.join('   ') : '_sin pool todavía_'}`;
  });
  const embed = new EmbedBuilder()
    .setColor(COLORES.info)
    .setTitle(`🏆 Champion pools de ${equipo.nombre}`)
    .setDescription(lineas.join('\n\n').slice(0, 4000))
    .setFooter({ text: 'Aquí salen solo S y A · el pool completo de cada uno con /pool ver' });
  return interaction.reply({ embeds: [embed] });
}

// --- Confirmación de /equipo-eliminar ---

async function manejarConfirmacionEliminar(interaction) {
  const [, modo, usuarioId, momento, ...resto] = interaction.customId.split('|');
  const nombreLower = resto.join('|');
  if (interaction.user.id !== usuarioId) {
    return interaction.reply({ content: '⛔ Solo quien usó /equipo-eliminar puede confirmarlo.', flags: MessageFlags.Ephemeral });
  }
  if (modo === 'no') return interaction.update({ content: '✅ Cancelado: no se eliminó nada.', components: [] });
  if (Date.now() - Number(momento) > 2 * 60_000) {
    return interaction.update({ content: '⌛ La confirmación venció. Vuelve a usar /equipo-eliminar.', components: [] });
  }

  const equipo = await equiposCol.findOne({ guildId: interaction.guildId, nombreLower });
  if (!equipo) return interaction.update({ content: 'Ese equipo ya no existe.', components: [] });

  const { deletedCount } = await jugadoresCol.deleteMany({ equipoId: equipo._id });
  await tareasCol.deleteMany({ equipoId: equipo._id });
  await equiposCol.deleteOne({ _id: equipo._id });
  console.log(`🗑️ Equipo "${equipo.nombre}" eliminado (${deletedCount} jugadores) por ${interaction.user.tag ?? interaction.user.id}`);

  await interaction.update({
    content: `🗑️ Equipo **${equipo.nombre}** eliminado junto con ${deletedCount} jugador(es).`
      + (modo === 'msg' ? '\n🧹 Borrando los mensajes del bot…' : '\nSi ya no usarán sus canales, puedes borrarlos desde Discord.'),
    components: [],
  });

  const registros = await mensajesCol.find({ equipoId: equipo._id }).toArray();
  if (modo === 'msg') {
    const borrados = await borrarMensajesDelBot(registros);
    await interaction.followUp({ content: `🧹 Listo: borré ${borrados} mensaje(s) del bot de **${equipo.nombre}**.`, flags: MessageFlags.Ephemeral }).catch(() => {});
  } else {
    await mensajesCol.deleteMany({ equipoId: equipo._id }); // los registros ya no sirven
  }
}

// --- Tareas ---

async function buscarJugadorDelEquipo(equipo, texto) {
  const riotId = separarRiotId(texto);
  if (riotId) {
    return jugadoresCol.findOne({ equipoId: equipo._id, riotIdLower: riotIdEnMinusculas(riotId.nombre, riotId.tag) });
  }
  // Escrito sin #TAG: solo sirve si el nombre es único dentro del equipo
  const candidatos = (await jugadoresCol.find({ equipoId: equipo._id }).toArray())
    .filter((j) => normalizar(j.nombre) === normalizar(texto));
  return candidatos.length === 1 ? candidatos[0] : null;
}

async function crearTarea(interaction, equipo) {
  const tipo = interaction.options.getString('tipo');
  const dias = interaction.options.getInteger('dias') ?? 7;
  const tarea = {
    guildId: interaction.guildId,
    equipoId: equipo._id,
    tipo,
    cantidad: interaction.options.getInteger('cantidad'),
    modo: interaction.options.getString('modo') ?? 'cualquiera',
    victoria: interaction.options.getBoolean('ganar') ?? false,
    progreso: 0,
    partidas: [],
    estado: 'activa',
    creadaPor: interaction.user.id,
    creadaEn: new Date(),
    venceEn: new Date(Date.now() + dias * 86_400_000),
  };

  if (tipo === 'campeon') {
    await cargarDatosEstaticos();
    const campeon = buscarCampeon(interaction.options.getString('campeon'));
    if (!campeon) return responderPrivado(interaction, '⚠️ Para esta tarea elige el campeón en la opción `campeon` (sale una lista al escribir).');
    Object.assign(tarea, { campeonId: campeon.id, campeonNombre: campeon.nombre });
  }
  if (tipo === 'rol') {
    tarea.rol = interaction.options.getString('rol');
    if (!tarea.rol) return responderPrivado(interaction, '⚠️ Para esta tarea elige el rol en la opción `rol`.');
  }
  if (['kda', 'cs', 'vision'].includes(tipo)) {
    tarea.valor = interaction.options.getNumber('valor');
    if (tarea.valor === null || tarea.valor === undefined) {
      return responderPrivado(interaction, '⚠️ Para esta tarea pon el mínimo en la opción `valor` (ej. KDA 3, CS 7.5, visión 40).');
    }
  }

  // ¿Para quién? Un jugador o todo el equipo
  const textoJugador = interaction.options.getString('jugador');
  let jugadores;
  if (textoJugador) {
    const jugador = await buscarJugadorDelEquipo(equipo, textoJugador);
    if (!jugador) return responderPrivado(interaction, `No encontré a **${textoJugador}** en **${equipo.nombre}**. Elígelo de la lista.`);
    jugadores = [jugador];
  } else {
    jugadores = await jugadoresCol.find({ equipoId: equipo._id }).toArray();
    if (!jugadores.length) return responderPrivado(interaction, `**${equipo.nombre}** aún no tiene jugadores.`);
  }

  for (const j of jugadores) {
    await tareasCol.insertOne({
      ...tarea,
      codigo: crypto.randomBytes(4).toString('hex'),
      jugadorId: j._id,
      puuid: j.puuid,
      jugadorNombre: `${j.nombre}#${j.tag}`,
      partidas: [],
    });
  }

  // Asignar una tarea SÍ avisa al jugador (una sola vez), si tiene su Discord enlazado
  const menciones = jugadores.map((j) => j.discordId).filter(Boolean);
  const embed = new EmbedBuilder()
    .setColor(COLORES.info)
    .setTitle('📋 Nueva tarea')
    .setDescription(`**${describirTarea(tarea)}**\nVence ${marcaDeTiempo(tarea.venceEn.getTime())}`)
    .addFields({
      name: jugadores.length > 1 ? `Para todo ${equipo.nombre} (${jugadores.length})` : 'Para',
      value: jugadores.map((j) => (j.discordId ? `<@${j.discordId}>` : `**${j.nombre}#${j.tag}**`)).join(', ').slice(0, 1024),
    })
    .setFooter({ text: 'Solo cuentan las partidas jugadas desde ahora · Mira el avance con /tarea lista' });
  const anuncio = {
    content: menciones.length ? menciones.map((id) => `<@${id}>`).join(' ') : undefined,
    embeds: [embed],
    allowedMentions: { users: menciones },
  };
  const puuids = jugadores.map((j) => j.puuid);
  if (equipo.canalTareasId && interaction.channelId !== equipo.canalTareasId) {
    const enviado = await enviarAviso(equipo, anuncio, { conPing: false, destino: 'tareas' });
    if (enviado) await registrarMensaje(equipo, enviado, puuids, 'tareas');
    return responderPrivado(
      interaction,
      enviado
        ? `✅ Tarea creada. La anuncié en <#${equipo.canalTareasId}>.`
        : `⚠️ La tarea se creó, pero no pude escribir en <#${equipo.canalTareasId}>. Revisa los permisos del bot ahí.`,
    );
  }
  await interaction.reply(anuncio);
  const respuesta = await interaction.fetchReply().catch(() => null);
  if (respuesta) await registrarMensaje(equipo, respuesta, puuids, 'tareas');
}

async function listarTareas(interaction, equipo) {
  const activas = (await tareasCol.find({ equipoId: equipo._id, estado: 'activa' }).toArray())
    .sort((a, b) => new Date(a.venceEn) - new Date(b.venceEn));
  const hace7Dias = Date.now() - 7 * 86_400_000;
  const recientes = (await tareasCol.find({ equipoId: equipo._id, estado: { $in: ['completada', 'fallida'] } }).toArray())
    .filter((t) => new Date(t.cerradaEn).getTime() > hace7Dias)
    .sort((a, b) => new Date(b.cerradaEn) - new Date(a.cerradaEn))
    .slice(0, 8);

  if (!activas.length && !recientes.length) {
    return responderPrivado(interaction, `**${equipo.nombre}** no tiene tareas. Un coach puede crear una con /tarea crear.`);
  }
  const embed = new EmbedBuilder().setColor(COLORES.info).setTitle(`📋 Tareas de ${equipo.nombre}`);
  if (activas.length) {
    embed.setDescription(activas.map((t) =>
      `${barraProgreso(t.progreso ?? 0, t.cantidad)} **${t.jugadorNombre}** · ${describirTarea(t)} — ${t.progreso ?? 0}/${t.cantidad} · vence ${marcaDeTiempo(new Date(t.venceEn).getTime())}`,
    ).join('\n').slice(0, 4000));
  } else {
    embed.setDescription('No hay tareas activas.');
  }
  if (recientes.length) {
    embed.addFields({
      name: 'Últimos 7 días',
      value: recientes.map((t) => `${t.estado === 'completada' ? '✅' : '❌'} **${t.jugadorNombre}** · ${describirTarea(t)}`).join('\n').slice(0, 1024),
    });
  }
  return interaction.reply({ embeds: [embed] });
}

async function cancelarTarea(interaction, equipo) {
  const codigo = interaction.options.getString('tarea');
  const tarea = await tareasCol.findOne({ equipoId: equipo._id, codigo, estado: 'activa' });
  if (!tarea) return responderPrivado(interaction, 'No encontré esa tarea activa. Elígela de la lista.');
  await tareasCol.updateOne({ _id: tarea._id }, { $set: { estado: 'cancelada', cerradaEn: new Date() } });
  return interaction.reply(`🗑️ Tarea cancelada: **${tarea.jugadorNombre}** · ${describirTarea(tarea)}`);
}

/** Sugerencias mientras se escribe: jugadores del equipo del canal, campeones y tareas activas. */
async function manejarAutocompletado(interaction) {
  const foco = interaction.options.getFocused(true);
  const buscado = normalizar(foco.value);
  let opciones = [];

  if (foco.name === 'equipo') {
    const equipos = await equiposCol.find({ guildId: interaction.guildId }).toArray();
    opciones = equipos
      .filter((e) => normalizar(e.nombre).includes(buscado))
      .map((e) => ({ name: e.nombre, value: e.nombre }));
  } else if (foco.name === 'campeon') {
    await cargarDatosEstaticos();
    opciones = [...estatico.campeones]
      .filter(([, nombre]) => normalizar(nombre).includes(buscado))
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([id, nombre]) => ({ name: nombre, value: String(id) }));
  } else if (foco.name === 'jugador' && interaction.commandName === 'pool') {
    // En /pool se puede ver a cualquier jugador del servidor, de cualquier equipo
    const jugadores = await jugadoresCol.find({ guildId: interaction.guildId }).toArray();
    opciones = jugadores
      .map((j) => `${j.nombre}#${j.tag}`.slice(0, 100))
      .filter((id) => normalizar(id).includes(buscado))
      .map((id) => ({ name: id, value: id }));
  } else {
    const equipo = await equipoDelCanal(interaction);
    if (equipo && (foco.name === 'jugador' || foco.name === 'riot_id')) {
      const jugadores = await jugadoresCol.find({ equipoId: equipo._id }).toArray();
      opciones = jugadores
        .map((j) => `${j.nombre}#${j.tag}`.slice(0, 100))
        .filter((id) => normalizar(id).includes(buscado))
        .map((id) => ({ name: id, value: id }));
    } else if (equipo && foco.name === 'tarea') {
      const activas = await tareasCol.find({ equipoId: equipo._id, estado: 'activa' }).toArray();
      opciones = activas
        .map((t) => ({ name: `${t.jugadorNombre} · ${describirTarea(t)}`.slice(0, 100), value: t.codigo }))
        .filter((o) => normalizar(o.name).includes(buscado));
    }
  }
  await interaction.respond(opciones.slice(0, 25)).catch(() => {});
}

// ═════════════════════════ 11. CLIENTE DE DISCORD Y ARRANQUE ═════════════════════════

const client = new Client({
  intents: [GatewayIntentBits.Guilds], // los slash commands no necesitan intents privilegiados
  allowedMentions: { parse: [] }, // nadie recibe ping salvo el rol_ping de cada equipo
});

client.once(Events.ClientReady, async (bot) => {
  console.log(`🤖 Conectado como ${bot.user.tag}`);

  try {
    // Comandos GLOBALES: aparecen en todos los servidores donde esté el bot
    await bot.application.commands.set(comandos.map((c) => c.toJSON()));
    const servidores = [...bot.guilds.cache.values()].map((g) => g.name);
    console.log(`✅ ${comandos.length} comandos registrados para ${servidores.length} servidor(es): ${servidores.join(', ')}`);

    // Las versiones anteriores los registraban solo en un servidor: se borran para que no salgan repetidos
    if (GUILD_ID) {
      const anterior = await bot.guilds.fetch(GUILD_ID).catch(() => null);
      if (anterior) await anterior.commands.set([]).catch(() => {});
    }
  } catch (err) {
    console.error('❌ No pude registrar los comandos en Discord:', err.message);
    if (ES_PRINCIPAL) process.exit(1);
    return; // dentro del dashboard: el bot se queda quieto, pero el dashboard sigue funcionando
  }

  await cargarDatosEstaticos();
  await cargarEmojis();
  // En segundo plano: deja listos los emblemas y sube los íconos que falten como emojis
  Promise.all(TIERS.map(obtenerEmblema)).then(() => subirEmojisFaltantes()).catch(() => {});
  // Cada 12 h revisa si salió un parche nuevo (campeones nuevos, ítems, runas)
  setInterval(() => cargarDatosEstaticos().then(() => subirEmojisFaltantes()).catch(() => {}), 12 * 3_600_000);

  console.log(`🔄 Escaneo cada ${ESCANEO_MINUTOS} min (el primero arranca ya)`);
  escanear();
  setInterval(escanear, ESCANEO_MINUTOS * 60_000);
});

client.on(Events.GuildCreate, (servidor) => console.log(`➕ Me agregaron al servidor "${servidor.name}"`));
client.on(Events.GuildDelete, (servidor) => console.log(`➖ Me sacaron del servidor "${servidor.name}"`));

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.inGuild()) return; // nada por mensaje directo
  // Sugerencias mientras se escribe (jugadores, campeones, tareas)
  if (interaction.isAutocomplete()) {
    await manejarAutocompletado(interaction).catch((err) => console.warn('⚠️ Autocompletado:', err.message));
    return;
  }

  let manejador = null;
  let nombre = '';
  if (interaction.isChatInputCommand()) {
    manejador = manejadores[interaction.commandName];
    nombre = `/${interaction.commandName}`;
  } else if (interaction.isButton() && interaction.customId.startsWith('sb|')) {
    manejador = manejarBotonScoreboard;
    nombre = 'botón Scoreboard';
  } else if (interaction.isButton() && interaction.customId.startsWith('eqdel|')) {
    manejador = manejarConfirmacionEliminar;
    nombre = 'confirmación de eliminar equipo';
  }
  if (!manejador) return;

  try {
    await manejador(interaction);
  } catch (err) {
    console.error(`❌ Error en ${nombre}:`, err);

    let mensaje = '❌ Ocurrió un error inesperado. Revisa la consola del bot.';
    if (err instanceof RiotError && (err.status === 401 || err.status === 403)) {
      mensaje = '🔑 La API key de Riot es inválida o venció. Hay que renovarla en el .env y reiniciar el bot.';
    } else if (err instanceof RiotError) {
      mensaje = `⚠️ Riot respondió con error ${err.status ?? 'de conexión'}. Intenta de nuevo en un momento.`;
    }

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: mensaje, embeds: [] }).catch(() => {});
    } else {
      await interaction.reply({ content: mensaje, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

async function apagar() {
  console.log('\n👋 Apagando bot...');
  await client.destroy();
  await mongo?.close().catch(() => {});
  process.exit(0);
}
// Si vive dentro de otro proyecto, el apagado lo maneja ese proyecto, no el bot
if (ES_PRINCIPAL) {
  process.on('SIGINT', apagar);
  process.on('SIGTERM', apagar);
}
process.on('unhandledRejection', (err) => console.error('⚠️ Promesa rechazada sin manejar:', err));

async function iniciarBot() {
  if (VARIABLES_FALTANTES.length) {
    console.error(`❌ Faltan variables para el bot: ${VARIABLES_FALTANTES.join(', ')}. El bot no arranca.`);
    if (ES_PRINCIPAL) process.exit(1);
    return;
  }
  await conectarMongo();
  await client.login(DISCORD_TOKEN);
}

iniciarBot().catch((err) => {
  console.error('❌ No se pudo iniciar el bot:', err.message);
  if (ES_PRINCIPAL) process.exit(1); // dentro del dashboard nunca lo apaga
});
