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
app.use(express.static(path.join(__dirname, 'public')));

const RIOT_API_KEY = process.env.RIOT_API_KEY;
const MONGO_URI = process.env.MONGO_URI;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const DISCORD_PUBLIC_CHANNEL_ID = process.env.DISCORD_PUBLIC_CHANNEL_ID;

// ── 1. CONFIGURACIÓN DISCORD ────────────────────────
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent 
    ] 
});

client.once('ready', () => { console.log(`🤖 BOT DISCORD EN LÍNEA: Conectado como ${client.user.tag}`); });
if (DISCORD_TOKEN) { client.login(DISCORD_TOKEN); }

async function enviarAlertaDiscord(embed) {
    try {
        const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
        if (channel) await channel.send({ embeds: [embed] });
    } catch (e) { console.error("❌ Error enviando mensaje a Discord:", e); }
}

// ── 2. BASE DE DATOS Y MIGRACIÓN ──────────────────────────────
let db, jugadoresCollection, equipoCollection;

async function checkMigracionSegura() {
    const count = await equipoCollection.countDocuments();
    if (count === 0) {
        console.log('⚙️ [MIGRACIÓN] Respaldando lista oficial en MongoDB...');
        const listaInicial = [
            {nombre: 'Falconnetty NTI', tag: 'TAM', division: 'senior'},
            {nombre: 'Leøz', tag: 'JGG', division: 'senior'},
            {nombre: 'SaidCxr', tag: 'DFTNS', division: 'senior'},
            {nombre: 'Jlbril', tag: 'nge', division: 'senior'},
            {nombre: 'Giannisita', tag: '2897', division: 'senior'},
            {nombre: 'Daemon I', tag: 'Kyn', division: 'senior'},
            {nombre: 'PegasusMaximiNTI', tag: 'JINX', division: 'junior'},
            {nombre: 'ska64', tag: 'LAN', division: 'junior'},
            {nombre: 'Rengar159 NTI', tag: '5995', division: 'junior'},
            {nombre: 'Aelíta', tag: 'AC622', division: 'junior'},
            {nombre: 'Issues NTI', tag: 'LANEC', division: 'junior'},
            {nombre: 'AkilesCaigo NTI', tag: 'ECNTI', division: 'junior'},
            {nombre: 'Skoda97', tag: '593', division: 'junior'},
            {nombre: 'Fabro7373 NTI', tag: '7373', division: 'junior'},
            {nombre: 'PSQ LxoFylnns', tag: 'Why', division: 'junior'},
            {nombre: 'Azraelh NTI', tag: '8037', division: 'junior'}
        ];
        await equipoCollection.insertMany(listaInicial);
        console.log('✅ [MIGRACIÓN] 16 jugadores asegurados en MongoDB.');
    }
}

function programarResetHoy() {
    const LAN_OFFSET_MS = 5 * 60 * 60 * 1000;
    const nowUTC = Date.now();
    const nowLAN = new Date(nowUTC - LAN_OFFSET_MS);
    const nextMidnightLAN = new Date(nowLAN.getUTCFullYear(), nowLAN.getUTCMonth(), nowLAN.getUTCDate() + 1, 0, 0, 0, 0);
    const msHastaMedianoche = (nextMidnightLAN.getTime() + LAN_OFFSET_MS) - nowUTC;
    
    setTimeout(async function() {
        if (jugadoresCollection) {
            await jugadoresCollection.updateMany({}, { $set: { partidasHoy: 0 } });
            console.log('[NTI] ✅ Partidas reseteadas a medianoche LAN');
        }
        programarResetHoy(); 
    }, msHastaMedianoche);
}

async function connectDB() {
    try {
        const mongoClient = new MongoClient(MONGO_URI);
        await mongoClient.connect();
        db = mongoClient.db('NTI_Esports');
        jugadoresCollection = db.collection('tabla_clasificacion');
        equipoCollection = db.collection('equipo_nti');
        
        await checkMigracionSegura();
        console.log('✅ BASE DE DATOS CONECTADA');
        programarResetHoy(); 
        
        actualizarDatosRiot(); 
        setInterval(actualizarDatosRiot, 5 * 60 * 1000); 
    } catch (error) { console.error('❌ Error DB:', error); }
}
connectDB();

// ── 3. ASISTENTE INTERACTIVO DE COMANDOS EN DISCORD ──────────
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.channelId !== DISCORD_PUBLIC_CHANNEL_ID) return;

    if (message.content === '!ping') {
        return message.reply(`¡Pong! 🏓 Te escucho fuerte y claro, jefe <@${message.author.id}>.`);
    }

    if (message.content === '!comandos' || message.content === '!ayuda') {
        const embedAyuda = new EmbedBuilder()
            .setTitle('🛠️ Panel de Control NTI Esports')
            .setDescription('Bienvenido a la consola de administración. Escribe cualquiera de estos comandos:')
            .setColor(0xc89b3c)
            .addFields(
                { name: '➕ Agregar un Jugador', value: 'Solo escribe `!agregar` y el bot te guiará paso a paso.' },
                { name: '➖ Eliminar un Jugador', value: 'Solo escribe `!eliminar` y el bot te preguntará a quién borrar.' }
            )
            .setFooter({ text: 'NTI Tracker — Sistema Interactivo' });
        return message.channel.send({ embeds: [embedAyuda] });
    }

    const args = message.content.trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // COMANDO !AGREGAR
    if (command === '!agregar') {
        if (!db) return message.reply("⏳ Conectando a la base de datos...");
        
        // MODO RÁPIDO (En una sola línea)
        if (args.length >= 3) {
            const division = args.pop().toLowerCase();
            const tag = args.pop();
            const nombre = args.join(' ');

            if (division !== 'senior' && division !== 'junior') return message.reply("❌ La división debe ser `senior` o `junior`.");
            const existe = await equipoCollection.findOne({ nombre: new RegExp(`^${nombre}$`, 'i') });
            if (existe) return message.reply(`⚠️ El jugador **${nombre}** ya está registrado.`);

            await equipoCollection.insertOne({ nombre, tag, division });
            message.reply(`✅ **${nombre}#${tag}** ha sido registrado en **${division.toUpperCase()}**.`);
            actualizarDatosRiot(); 
        } 
        // MODO ASISTENTE PASO A PASO
        else {
            const filter = m => m.author.id === message.author.id;
            try {
                await message.reply("📝 **Asistente de Registro NTI**\n¡Vamos a agregar a un jugador!\n👉 **Paso 1:** ¿Cuál es el **Nombre de Invocador**? *(Escríbelo exactamente como es, ej: Azraelh NTI)*");
                const nombreCol = await message.channel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] });
                const nombre = nombreCol.first().content.trim();

                await message.channel.send(`✅ Nombre detectado: **${nombre}**\n👉 **Paso 2:** Ahora, dime su **TAG** *(Sin el #, por ejemplo: 8037 o LAN)*`);
                const tagCol = await message.channel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] });
                const tag = tagCol.first().content.trim();

                await message.channel.send(`✅ Tag guardado: **#${tag}**\n👉 **Paso 3:** Por último, ¿A qué división pertenece? *(Escribe estrictamente **senior** o **junior**)*`);
                const divCol = await message.channel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] });
                const division = divCol.first().content.trim().toLowerCase();

                if (division !== 'senior' && division !== 'junior') {
                    return message.channel.send("❌ Error: Escribiste mal la división. El registro se ha cancelado. Empieza de nuevo escribiendo `!agregar`.");
                }

                const existe = await equipoCollection.findOne({ nombre: new RegExp(`^${nombre}$`, 'i') });
                if (existe) return message.channel.send(`⚠️ ¡Alto ahí! El jugador **${nombre}** ya existe en la base de datos.`);

                await equipoCollection.insertOne({ nombre, tag, division });
                message.channel.send(`🎉 **¡REGISTRO COMPLETADO!**\n**${nombre}#${tag}** ha sido agregado oficialmente a la división **${division.toUpperCase()}** por <@${message.author.id}>.\n⏳ *Ya estoy descargando sus datos de Riot, aparecerá en la web pronto.*`);
                
                actualizarDatosRiot(); 
            } catch (error) {
                message.channel.send("⏳ Tiempo de espera agotado o hubo un error. Se ha cancelado el asistente.");
            }
        }
    }

    // COMANDO !ELIMINAR
    if (command === '!eliminar') {
        if (!db) return message.reply("⏳ Conectando a la base de datos...");

        // MODO RÁPIDO
        if (args.length >= 1) {
            const nombre = args.join(' ');
            const resEquipo = await equipoCollection.deleteOne({ nombre: new RegExp(`^${nombre}$`, 'i') });
            if (resEquipo.deletedCount === 0) return message.reply(`⚠️ No encontré a **${nombre}** en el equipo.`);
            await jugadoresCollection.deleteOne({ nombre: new RegExp(`^${nombre}$`, 'i') });
            message.reply(`🗑️ **${nombre}** ha sido eliminado oficialmente.`);
        } 
        // MODO ASISTENTE PASO A PASO
        else {
            const filter = m => m.author.id === message.author.id;
            try {
                await message.reply("🗑️ **Asistente de Eliminación NTI**\n👉 ¿Cuál es el **Nombre de Invocador exacto** de la persona que quieres eliminar?");
                const nombreCol = await message.channel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] });
                const nombre = nombreCol.first().content.trim();

                const resEquipo = await equipoCollection.deleteOne({ nombre: new RegExp(`^${nombre}$`, 'i') });
                if (resEquipo.deletedCount === 0) return message.channel.send(`⚠️ No existe nadie llamado **${nombre}** en la base de datos. ¡Operación cancelada!`);

                await jugadoresCollection.deleteOne({ nombre: new RegExp(`^${nombre}$`, 'i') });
                message.channel.send(`✅ **${nombre}** ha sido borrado para siempre de la página web y del equipo por <@${message.author.id}>.`);
            } catch (error) {
                message.channel.send("⏳ Tiempo de espera agotado. Eliminación cancelada.");
            }
        }
    }
});

// ── 4. MOTOR DE ACTUALIZACIÓN DINÁMICO ────────────────────────
async function actualizarDatosRiot() {
    if (!equipoCollection) return;
    const listaJugadores = await equipoCollection.find({}).toArray();

    const LAN_OFFSET_MS = 5 * 60 * 60 * 1000; 
    const nowLAN = new Date(Date.now() - LAN_OFFSET_MS);
    const midnightLAN = new Date(nowLAN.getUTCFullYear(), nowLAN.getUTCMonth(), nowLAN.getUTCDate(), 0, 0, 0, 0);
    let startOfToday = Math.floor((midnightLAN.getTime() + LAN_OFFSET_MS) / 1000);
    
    for (let jug of listaJugadores) {
        try {
            const accRes = await axios.get(`https://americas.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(jug.nombre)}/${jug.tag}`, { headers: { 'X-Riot-Token': RIOT_API_KEY }});
            const puuid = accRes.data.puuid;
            
            const [leaRes, matchHoyRes, sumRes] = await Promise.all([
                axios.get(`https://la1.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`, { headers: { 'X-Riot-Token': RIOT_API_KEY }}),
                axios.get(`https://americas.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?startTime=${startOfToday}&queue=420&count=100`, { headers: { 'X-Riot-Token': RIOT_API_KEY }}),
                axios.get(`https://la1.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}`, { headers: { 'X-Riot-Token': RIOT_API_KEY }})
            ]);
            
            const stats = leaRes.data.find(e => e.queueType === 'RANKED_SOLO_5x5') || { tier:'UNRANKED', rank:'', leaguePoints:0, wins:0, losses:0 };
            const nPartidasHoy = matchHoyRes.data.length;
            const iconoId = sumRes.data.profileIconId; 

            const dataVieja = await jugadoresCollection.findOne({ nombre: jug.nombre });
            if (dataVieja) {
                let isWin = false, isLoss = false, lpDiff = 0;
                if (stats.wins > dataVieja.victorias) { isWin = true; lpDiff = stats.leaguePoints - dataVieja.puntos; }
                else if (stats.losses > dataVieja.derrotas) { isLoss = true; lpDiff = dataVieja.puntos - stats.leaguePoints; }
                if (isWin || isLoss) {
                    const tierLow = stats.tier !== 'UNRANKED' ? stats.tier.toLowerCase() : 'unranked';
                    const tierIcon = `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-emblem/emblem-${tierLow}.png`;
                    const winrate = (stats.wins + stats.losses) > 0 ? Math.round((stats.wins / (stats.wins + stats.losses)) * 100) : 0;
                    let rankChanged = (dataVieja.tier !== stats.tier || dataVieja.rango !== stats.rank) && dataVieja.tier && dataVieja.tier !== 'UNRANKED';
                    const embed = new EmbedBuilder().setThumbnail(tierIcon).setTimestamp();
                    let lpFieldVal = '';
                    if (isWin) {
                        if (rankChanged) { embed.setTitle(`🚀 ¡ASCENSO ÉPICO DE ${jug.nombre}!`); embed.setColor(0xfcd34d); lpFieldVal = '📈 **¡LIGA NUEVA!**'; }
                        else { embed.setTitle(`🏆 ¡Victoria de ${jug.nombre}!`); embed.setColor(0x10b981); lpFieldVal = `**+${Math.abs(lpDiff)} LP**`; }
                    } else {
                        if (rankChanged) { embed.setTitle(`🚑 ¡DESCENSO DE ${jug.nombre}!`); embed.setColor(0x1a1a1a); lpFieldVal = '📉 **¡BAJÓ DE LIGA!**'; }
                        else { embed.setTitle(`💀 Derrota de ${jug.nombre}...`); embed.setColor(0xef4444); lpFieldVal = `**-${Math.abs(lpDiff)} LP**`; }
                    }
                    embed.addFields({ name: 'Cambio', value: lpFieldVal, inline: true }, { name: 'Elo Actual', value: `**${stats.tier} ${stats.rank}** (${stats.leaguePoints} LP)`, inline: true }, { name: 'Récord Global', value: `${stats.wins}V - ${stats.losses}D (${winrate}% WR)`, inline: false });
                    await enviarAlertaDiscord(embed);
                }
            }
            await jugadoresCollection.updateOne({ nombre: jug.nombre }, { $set: { nombre: jug.nombre, division: jug.division, puuid: puuid, icono: iconoId, tier: stats.tier, rango: stats.rank, puntos: stats.leaguePoints, victorias: stats.wins, derrotas: stats.losses, partidasHoy: nPartidasHoy, ultimaActualizacion: new Date() }}, { upsert: true });
            await new Promise(r => setTimeout(r, 500));
        } catch (e) { console.error(`Error en ${jug.nombre}`); }
    }
}

// ── CACHÉ Y ENDPOINTS ────────────────────────────
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

function calcNTIScoreServer(jug) {
    var valoresTier = {'CHALLENGER':9,'GRANDMASTER':8,'MASTER':7,'DIAMOND':6,'EMERALD':5,'PLATINUM':4,'GOLD':3,'SILVER':2,'BRONZE':1,'IRON':0,'UNRANKED':-1};
    var tv = valoresTier[jug.tier] !== undefined ? valoresTier[jug.tier] : -1;
    var lpNorm = Math.min((Math.max(tv,0)/9)*85 + (jug.puntos/100)*15, 100);
    var total = (jug.victorias||0) + (jug.derrotas||0);
    var wr    = total > 0 ? (jug.victorias/total)*100 : 50;
    return Math.min(Math.round(lpNorm*0.4 + wr*0.3 + wr*0.3), 100);
}

async function guardarLPSnapshot(nombre, lp, tier) {
    try {
        const today = new Date().toDateString();
        await db.collection('lp_history').updateOne({ nombre, fecha: today }, { $set: { nombre, fecha: today, lp, tier, ts: new Date() } }, { upsert: true });
    } catch(e) {}
}

app.get('/api/ranking-actual', async (req, res) => {
    try {
        const datos = await jugadoresCollection.find({}).toArray();
        const LAN_OFFSET_MS = 5 * 60 * 60 * 1000;
        const nowLAN = new Date(Date.now() - LAN_OFFSET_MS);
        const todayLAN = nowLAN.toUTCString().slice(0, 16); 
        const enriched = datos.map(j => {
            let partidasHoyLimpio = j.partidasHoy || 0;
            if (j.ultimaActualizacion) {
                const updLAN = new Date(new Date(j.ultimaActualizacion).getTime() - LAN_OFFSET_MS);
                const updDay = updLAN.toUTCString().slice(0, 16);
                if (updDay !== todayLAN) partidasHoyLimpio = 0;
            }
            return { ...j, partidasHoy: partidasHoyLimpio, ntiScore: calcNTIScoreServer(j), valorT: {'CHALLENGER':9,'GRANDMASTER':8,'MASTER':7,'DIAMOND':6,'EMERALD':5,'PLATINUM':4,'GOLD':3,'SILVER':2,'BRONZE':1,'IRON':0,'UNRANKED':-1}[j.tier] ?? -1 };
        });
        enriched.forEach(j => { if (j.tier && j.puntos !== undefined) guardarLPSnapshot(j.nombre, j.puntos, j.tier); });
        res.json(enriched);
    } catch(e) { res.status(500).json({ error: 'Error leyendo base de datos' }); }
});

app.get('/api/hall-of-fame', async (req, res) => {
    try {
        const hof = db.collection('hall_of_fame');
        const entries = await hof.find({}).sort({ ts: -1 }).limit(9).toArray();
        res.json(entries);
    } catch(e) { res.json([]); }
});

app.get('/manifest.json', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'manifest.json')); });
app.get('/', (req, res) => { res.send('<h1>¡Servidor de NTI Esports operativo! 🚀</h1><p>Si ves esto, el backend está vivo.</p>'); });

app.listen(PORT, '0.0.0.0', () => { console.log(`🚀 Servidor NTI activo en puerto: ${PORT}`); });