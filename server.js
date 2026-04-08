const express = require('express');
const axios   = require('axios');
const path    = require('path');
const cors    = require('cors');
const { MongoClient } = require('mongodb');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
require('dotenv').config();

const app  = express();
// Solo declaramos el puerto una vez aquí arriba
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const RIOT_API_KEY = process.env.RIOT_API_KEY;
const MONGO_URI = process.env.MONGO_URI;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

// ── CONFIGURACIÓN DEL BOT DE DISCORD ────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

client.once('ready', () => {
    console.log(`🤖 BOT DISCORD EN LÍNEA: Conectado como ${client.user.tag}`);
});

client.login(DISCORD_TOKEN);

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

async function connectDB() {
    try {
        const mongoClient = new MongoClient(MONGO_URI);
        await mongoClient.connect();
        db = mongoClient.db('NTI_Esports');
        jugadoresCollection = db.collection('tabla_clasificacion');
        console.log('✅ BASE DE DATOS CONECTADA');
        
        actualizarDatosRiot(); 
        setInterval(actualizarDatosRiot, 5 * 60 * 1000); 
    } catch (error) { console.error('❌ Error DB:', error); }
}
connectDB();

// ── MOTOR DE ACTUALIZACIÓN CON ALERTAS PREMIUM ────────────────
async function actualizarDatosRiot() {
    let startOfToday = Math.floor(new Date().setHours(0,0,0,0) / 1000);

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
                let isWin = false;
                let isLoss = false;
                let lpDiff = 0;

                if (stats.wins > dataVieja.victorias) {
                    isWin = true;
                    lpDiff = stats.leaguePoints - dataVieja.puntos;
                } else if (stats.losses > dataVieja.derrotas) {
                    isLoss = true;
                    lpDiff = dataVieja.puntos - stats.leaguePoints;
                }

                if (isWin || isLoss) {
                    const tierLow = stats.tier !== 'UNRANKED' ? stats.tier.toLowerCase() : 'unranked';
                    const tierIcon = `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-emblem/emblem-${tierLow}.png`;
                    const totalGames = stats.wins + stats.losses;
                    const winrate = totalGames > 0 ? Math.round((stats.wins / totalGames) * 100) : 0;
                    
                    let rankChanged = (dataVieja.tier !== stats.tier || dataVieja.rango !== stats.rank) && dataVieja.tier && dataVieja.tier !== 'UNRANKED';

                    const embed = new EmbedBuilder()
                        .setThumbnail(tierIcon)
                        .setTimestamp();

                    let lpFieldVal = '';

                    if (isWin) {
                        if (rankChanged) {
                            embed.setTitle(`🚀 ¡ASCENSO ÉPICO DE ${jug.name}!`);
                            embed.setDescription(`¡Felicidades! Ha subido a una nueva liga y está imparable.`);
                            embed.setColor(0xfcd34d); 
                            lpFieldVal = '📈 **¡LIGA NUEVA!**';
                        } else {
                            embed.setTitle(`🏆 ¡Victoria de ${jug.name}!`);
                            embed.setColor(0x10b981); 
                            lpFieldVal = `**+${Math.abs(lpDiff)} LP**`;
                        }
                    } else {
                        if (rankChanged) {
                            embed.setTitle(`🚑 ¡DESCENSO DE ${jug.name}!`);
                            embed.setDescription(`F en el chat... Ha bajado de liga. ¡Toca recuperar!`);
                            embed.setColor(0x1a1a1a); 
                            lpFieldVal = '📉 **¡BAJÓ DE LIGA!**';
                        } else {
                            embed.setTitle(`💀 Derrota de ${jug.name}...`);
                            embed.setColor(0xef4444); 
                            lpFieldVal = `**-${Math.abs(lpDiff)} LP**`;
                        }
                    }

                    embed.addFields(
                        { name: 'Cambio', value: lpFieldVal, inline: true },
                        { name: 'Elo Actual', value: `**${stats.tier} ${stats.rank}** (${stats.leaguePoints} LP)`, inline: true },
                        { name: 'Récord Global', value: `${stats.wins}V - ${stats.losses}D (${winrate}% WR)`, inline: false }
                    );

                    await enviarAlertaDiscord(embed);
                }
            }

            await jugadoresCollection.updateOne(
                { nombre: jug.name }, 
                { $set: { 
                    nombre: jug.name, division: jug.division, puuid: puuid,
                    tier: stats.tier, rango: stats.rank, puntos: stats.leaguePoints,
                    victorias: stats.wins, derrotas: stats.losses, partidasHoy: nPartidasHoy,
                    ultimaActualizacion: new Date()
                }}, 
                { upsert: true }
            );
            await new Promise(r => setTimeout(r, 500));
        } catch (e) { console.error(`Error en ${jug.name}`); }
    }
}

// ── CACHÉ EN SERVIDOR (30 min) ──────────────────────────────
const serverCache = new Map();
const CACHE_TTL = 30 * 60 * 1000;
function getCached(key) {
    const e = serverCache.get(key);
    if (!e) return null;
    if (Date.now() - e.ts > CACHE_TTL) { serverCache.delete(key); return null; }
    return e.data;
}
function setCache(key, data) { serverCache.set(key, { ts: Date.now(), data }); }
setInterval(() => { const now = Date.now(); serverCache.forEach((v,k) => { if(now-v.ts>CACHE_TTL) serverCache.delete(k); }); }, 60*60*1000);

// ── PROXY HACIA RIOT API con caché ────────────────────────────
app.use('/api/riot', async (req, res) => {
    const parts = req.path.split('/').filter(Boolean);
    const region = parts[0];
    const endpoint = parts.slice(1).join('/');
    if (!region || !endpoint) return res.status(400).json({ error: 'Ruta invalida' });

    const queryString = new URLSearchParams(req.query).toString();
    const url = `https://${region}.api.riotgames.com/${endpoint}${queryString ? '?' + queryString : ''}`;
    
    const noCache = endpoint.includes('spectator') || endpoint.includes('active-games');
    if (!noCache) {
        const cached = getCached(url);
        if (cached) return res.json(cached);
    }

    try {
        const response = await axios.get(url, { headers: { 'X-Riot-Token': RIOT_API_KEY }, timeout: 8000 });
        if (!noCache) setCache(url, response.data);
        res.json(response.data);
    } catch (error) {
        const status = error.response ? error.response.status : 500;
        if (status !== 403 && status !== 404) console.error(`[NTI] Riot ${status}: ${endpoint.split('?')[0]}`);
        res.status(status).json({ error: 'Error Riot API' });
    }
});

// ── RUTAS FRONTEND ──────────────────────────────────────────
app.get('/api/ranking-actual', async (req, res) => {
    const datos = await jugadoresCollection.find({}).toArray();
    res.json(datos);
});

// --- RUTA DE SUPERVIVENCIA PARA RENDER ---
app.get('/', (req, res) => {
    res.send('<h1>¡Servidor de NTI Esports encendido y funcionando al 100%! 🚀</h1><p>El backend y el bot están operativos.</p>');
});

// ── INICIO DEL SERVIDOR ─────────────────────────────────────
// Aquí usamos la constante PORT declarada al inicio y abrimos para todo internet con '0.0.0.0'
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor NTI activo en puerto: ${PORT}`);
    console.log(`----------------------------------------`);
});