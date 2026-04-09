const express = require('express');
const axios   = require('axios');
const path    = require('path');
const cors    = require('cors');
const { MongoClient } = require('mongodb');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// --- ¡ESTA ES LA LÍNEA CLAVE! Ahora busca en la carpeta public ---
app.use(express.static(path.join(__dirname, 'public')));

const RIOT_API_KEY = process.env.RIOT_API_KEY;
const MONGO_URI = process.env.MONGO_URI;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

// ── CONFIGURACIÓN DEL BOT DE DISCORD ────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

client.once('ready', () => {
    console.log(`🤖 BOT DISCORD EN LÍNEA: Conectado como ${client.user.tag}`);
});

if (DISCORD_TOKEN) { client.login(DISCORD_TOKEN); } else { console.log('[NTI] Discord no configurado — bot desactivado'); }

async function enviarAlertaDiscord(embed) {
    try {
        const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
        if (channel) {
            await channel.send({ embeds: [embed] });
        }
    } catch (e) {
        console.error("❌ Error enviando mensaje a Discord:", e);
    }
}

// ── JUGADORES Y BASE DE DATOS ──────────────────────────────
let db, jugadoresCollection;
const jugadoresSenior = [
    {name: 'Falconnetty NTI', tag: 'TAM', division: 'senior'},
    {name: 'Leøz', tag: 'JGG', division: 'senior'},
    {name: 'SaidCxr', tag: 'DFTNS', division: 'senior'},
    {name: 'Jlbril', tag: 'nge', division: 'senior'},
    {name: 'Giannisita', tag: '2897', division: 'senior'},
    {name: 'Daemon I', tag: 'Kyn', division: 'senior'}
];
const jugadoresJunior = [
    {name: 'PegasusMaximiNTI', tag: 'JINX', division: 'junior'},
    {name: 'ska64', tag: 'LAN', division: 'junior'},
    {name: 'Rengar159 NTI', tag: '5995', division: 'junior'},
    {name: 'Aelíta', tag: 'AC622', division: 'junior'},
    {name: 'Issues NTI', tag: 'LANEC', division: 'junior'},
    {name: 'AkilesCaigo NTI', tag: 'ECNTI', division: 'junior'},
    {name: 'Skoda97', tag: '593', division: 'junior'},
    {name: 'Fabro7373 NTI', tag: '7373', division: 'junior'},
    {name: 'PSQ LxoFylnns', tag: 'Why', division: 'junior'}
];
const todosLosJugadores = [...jugadoresSenior, ...jugadoresJunior];


// ── RESET PARTIDAS HOY a medianoche LAN (00:00 UTC-5 = 05:00 UTC) ──────────
function programarResetHoy() {
    const LAN_OFFSET_MS = 5 * 60 * 60 * 1000;
    const nowUTC = Date.now();
    const nowLAN = new Date(nowUTC - LAN_OFFSET_MS);
    // Siguiente medianoche LAN
    const nextMidnightLAN = new Date(nowLAN.getUTCFullYear(), nowLAN.getUTCMonth(), nowLAN.getUTCDate() + 1, 0, 0, 0, 0);
    const msHastaMedianoche = (nextMidnightLAN.getTime() + LAN_OFFSET_MS) - nowUTC;
    
    setTimeout(async function() {
        // Resetear contadores de hoy en MongoDB
        if (jugadoresCollection) {
            await jugadoresCollection.updateMany({}, { $set: { partidasHoy: 0 } });
            console.log('[NTI] ✅ Partidas de hoy reseteadas a medianoche LAN');
        }
        programarResetHoy(); // Reprogramar para el día siguiente
    }, msHastaMedianoche);
    
    const horas = Math.floor(msHastaMedianoche / 3600000);
    const mins  = Math.floor((msHastaMedianoche % 3600000) / 60000);
    console.log(`[NTI] Reset de hoy programado en ${horas}h ${mins}m`);
}

async function connectDB() {
    try {
        const mongoClient = new MongoClient(MONGO_URI);
        await mongoClient.connect();
        db = mongoClient.db('NTI_Esports');
        jugadoresCollection = db.collection('tabla_clasificacion');
        console.log('✅ BASE DE DATOS CONECTADA');
        programarResetHoy(); // Iniciar reset automático de partidas del día
        
        actualizarDatosRiot(); 
        setInterval(actualizarDatosRiot, 5 * 60 * 1000); 
    } catch (error) { console.error('❌ Error DB:', error); }
}
connectDB();

// ── MOTOR DE ACTUALIZACIÓN ────────────────
async function actualizarDatosRiot() {
    // LAN = UTC-5 (Colombia, Ecuador, Perú)
    // Calculamos medianoche en UTC-5, no en UTC del servidor
    const LAN_OFFSET_MS = 5 * 60 * 60 * 1000; // 5 horas en ms
    const nowLAN = new Date(Date.now() - LAN_OFFSET_MS);
    const midnightLAN = new Date(nowLAN.getUTCFullYear(), nowLAN.getUTCMonth(), nowLAN.getUTCDate(), 0, 0, 0, 0);
    let startOfToday = Math.floor((midnightLAN.getTime() + LAN_OFFSET_MS) / 1000);
    for (let jug of todosLosJugadores) {
        try {
            const accRes = await axios.get(`https://americas.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(jug.name)}/${jug.tag}`, { headers: { 'X-Riot-Token': RIOT_API_KEY }});
            const puuid = accRes.data.puuid;
            const [leaRes, matchHoyRes] = await Promise.all([
                axios.get(`https://la1.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`, { headers: { 'X-Riot-Token': RIOT_API_KEY }}),
                axios.get(`https://americas.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?startTime=${startOfToday}&queue=420&count=100`, { headers: { 'X-Riot-Token': RIOT_API_KEY }})
            ]);
            const stats = leaRes.data.find(e => e.queueType === 'RANKED_SOLO_5x5') || { tier:'UNRANKED', rank:'', leaguePoints:0, wins:0, losses:0 };
            const nPartidasHoy = matchHoyRes.data.length;
            const dataVieja = await jugadoresCollection.findOne({ nombre: jug.name });
            if (dataVieja) {
                let isWin = false, isLoss = false, lpDiff = 0;
                if (stats.wins > dataVieja.victorias) { isWin = true; lpDiff = stats.leaguePoints - dataVieja.puntos; }
                else if (stats.losses > dataVieja.derrotas) { isLoss = true; lpDiff = dataVieja.puntos - stats.leaguePoints; }
                if (isWin || isLoss) {
                    const tierLow = stats.tier !== 'UNRANKED' ? stats.tier.toLowerCase() : 'unranked';
                    const tierIcon = `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-emblem/emblem-${tierLow}.png`;
                    const totalGames = stats.wins + stats.losses;
                    const winrate = totalGames > 0 ? Math.round((stats.wins / totalGames) * 100) : 0;
                    let rankChanged = (dataVieja.tier !== stats.tier || dataVieja.rango !== stats.rank) && dataVieja.tier && dataVieja.tier !== 'UNRANKED';
                    const embed = new EmbedBuilder().setThumbnail(tierIcon).setTimestamp();
                    let lpFieldVal = '';
                    if (isWin) {
                        if (rankChanged) { embed.setTitle(`🚀 ¡ASCENSO ÉPICO DE ${jug.name}!`); embed.setColor(0xfcd34d); lpFieldVal = '📈 **¡LIGA NUEVA!**'; }
                        else { embed.setTitle(`🏆 ¡Victoria de ${jug.name}!`); embed.setColor(0x10b981); lpFieldVal = `**+${Math.abs(lpDiff)} LP**`; }
                    } else {
                        if (rankChanged) { embed.setTitle(`🚑 ¡DESCENSO DE ${jug.name}!`); embed.setColor(0x1a1a1a); lpFieldVal = '📉 **¡BAJÓ DE LIGA!**'; }
                        else { embed.setTitle(`💀 Derrota de ${jug.name}...`); embed.setColor(0xef4444); lpFieldVal = `**-${Math.abs(lpDiff)} LP**`; }
                    }
                    embed.addFields({ name: 'Cambio', value: lpFieldVal, inline: true }, { name: 'Elo Actual', value: `**${stats.tier} ${stats.rank}** (${stats.leaguePoints} LP)`, inline: true }, { name: 'Récord Global', value: `${stats.wins}V - ${stats.losses}D (${winrate}% WR)`, inline: false });
                    await enviarAlertaDiscord(embed);
                }
            }
            await jugadoresCollection.updateOne({ nombre: jug.name }, { $set: { nombre: jug.name, division: jug.division, puuid: puuid, tier: stats.tier, rango: stats.rank, puntos: stats.leaguePoints, victorias: stats.wins, derrotas: stats.losses, partidasHoy: nPartidasHoy, ultimaActualizacion: new Date() }}, { upsert: true });
            await new Promise(r => setTimeout(r, 500));
        } catch (e) { console.error(`Error en ${jug.name}`); }
    }
}

// ── CACHÉ Y PROXY ────────────────────────────
const serverCache = new Map();
const CACHE_TTL = 30 * 60 * 1000;
function getCached(key) { const e = serverCache.get(key); if (!e || Date.now() - e.ts > CACHE_TTL) return null; return e.data; }
function setCache(key, data) { serverCache.set(key, { ts: Date.now(), data }); }

app.use('/api/riot', async (req, res) => {
    const parts = req.path.split('/').filter(Boolean);
    const region = parts[0], endpoint = parts.slice(1).join('/');
    const url = `https://${region}.api.riotgames.com/${endpoint}${req.url.includes('?') ? '?' + req.url.split('?')[1] : ''}`;
    const cached = getCached(url);
    if (cached && !endpoint.includes('spectator')) return res.json(cached);
    try {
        const response = await axios.get(url, { headers: { 'X-Riot-Token': RIOT_API_KEY }, timeout: 8000 });
        setCache(url, response.data);
        res.json(response.data);
    } catch (error) { res.status(error.response?.status || 500).json({ error: 'Error Riot API' }); }
});


// ── NTI SCORE (pre-calculado en servidor) ────────────────────
function calcNTIScoreServer(jug) {
    var valoresTier = {'CHALLENGER':9,'GRANDMASTER':8,'MASTER':7,'DIAMOND':6,'EMERALD':5,'PLATINUM':4,'GOLD':3,'SILVER':2,'BRONZE':1,'IRON':0,'UNRANKED':-1};
    var tv = valoresTier[jug.tier] !== undefined ? valoresTier[jug.tier] : -1;
    var lpNorm = Math.min((Math.max(tv,0)/9)*85 + (jug.puntos/100)*15, 100);
    var total = (jug.victorias||0) + (jug.derrotas||0);
    var wr    = total > 0 ? (jug.victorias/total)*100 : 50;
    return Math.min(Math.round(lpNorm*0.4 + wr*0.3 + wr*0.3), 100);
}

// ── ENDPOINT: /api/ranking-actual (con NTI Score pre-calculado) ──
// Guarda snapshot de LP diario para cada jugador (sparkline)
async function guardarLPSnapshot(nombre, lp, tier) {
    try {
        const today = new Date().toDateString();
        await db.collection('lp_history').updateOne(
            { nombre, fecha: today },
            { $set: { nombre, fecha: today, lp, tier, ts: new Date() } },
            { upsert: true }
        );
    } catch(e) {}
}

app.get('/api/ranking-actual', async (req, res) => {
    try {
        const datos = await jugadoresCollection.find({}).toArray();
        // Pre-calcular NTI Score y guardar LP snapshot en cada consulta
        const LAN_OFFSET_MS = 5 * 60 * 60 * 1000;
        const nowLAN = new Date(Date.now() - LAN_OFFSET_MS);
        const todayLAN = nowLAN.toUTCString().slice(0, 16); // "Tue, 01 Apr 2025"
        
        const enriched = datos.map(j => {
            // Si la última actualización fue ayer (en LAN), resetear partidasHoy a 0
            let partidasHoyLimpio = j.partidasHoy || 0;
            if (j.ultimaActualizacion) {
                const updLAN = new Date(new Date(j.ultimaActualizacion).getTime() - LAN_OFFSET_MS);
                const updDay = updLAN.toUTCString().slice(0, 16);
                if (updDay !== todayLAN) partidasHoyLimpio = 0;
            }
            return {
                ...j,
                partidasHoy: partidasHoyLimpio,
                ntiScore:  calcNTIScoreServer(j),
                valorT:    {'CHALLENGER':9,'GRANDMASTER':8,'MASTER':7,'DIAMOND':6,'EMERALD':5,'PLATINUM':4,'GOLD':3,'SILVER':2,'BRONZE':1,'IRON':0,'UNRANKED':-1}[j.tier] ?? -1
            };
        });
        // Guardar snapshots en background (no bloquea la respuesta)
        enriched.forEach(j => { if (j.tier && j.puntos !== undefined) guardarLPSnapshot(j.nombre, j.puntos, j.tier); });
        res.json(enriched);
    } catch(e) {
        res.status(500).json({ error: 'Error leyendo base de datos' });
    }
});

// ── ENDPOINT: Hall of Fame (top 3 históricos) ─────────────────
app.get('/api/hall-of-fame', async (req, res) => {
    try {
        const hof = db.collection('hall_of_fame');
        const entries = await hof.find({}).sort({ ts: -1 }).limit(9).toArray();
        res.json(entries);
    } catch(e) { res.json([]); }
});

// ── ENDPOINT: Guardar campeón del mes (llamado desde server interno) ──
async function archivarCampeonDelMes() {
    if (!db) return;
    try {
        const datos = await jugadoresCollection.find({}).toArray();
        if (!datos.length) return;
        const valoresTier = {'CHALLENGER':9,'GRANDMASTER':8,'MASTER':7,'DIAMOND':6,'EMERALD':5,'PLATINUM':4,'GOLD':3,'SILVER':2,'BRONZE':1,'IRON':0,'UNRANKED':-1};
        const top3 = datos
            .filter(j => j.tier && j.tier !== 'UNRANKED')
            .sort((a,b) => ((valoresTier[b.tier]||0)-(valoresTier[a.tier]||0)) || (b.puntos-a.puntos))
            .slice(0, 3);
        const now = new Date();
        const mes = now.toLocaleDateString('es-MX', { month:'long', year:'numeric' });
        const hof = db.collection('hall_of_fame');
        for (const j of top3) {
            await hof.insertOne({
                nombre: j.nombre, tier: j.tier, rango: j.rango,
                puntos: j.puntos, icono: j.icono, mes, ts: now
            });
        }
        console.log('[NTI] Hall of Fame archivado para:', mes);
    } catch(e) { console.error('[NTI] Error archivando HOF:', e.message); }
}
// Archivar automáticamente el día 1 de cada mes a medianoche
(function() {
    const now = new Date();
    const next1st = new Date(now.getFullYear(), now.getMonth()+1, 1, 0, 5, 0);
    setTimeout(function tick() {
        archivarCampeonDelMes();
        setTimeout(tick, 30*24*60*60*1000);
    }, next1st - now);
})();


// --- RUTA DE SUPERVIVENCIA ---
app.get('/manifest.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});

app.get('/', (req, res) => {
    res.send('<h1>¡Servidor de NTI Esports operativo! 🚀</h1><p>Si ves esto, el backend está vivo.</p>');
});

// ── INICIO DEL SERVIDOR ──
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor NTI activo en puerto: ${PORT}`);
});