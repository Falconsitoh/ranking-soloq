const express = require('express');
const axios   = require('axios');
const path    = require('path');
const cors    = require('cors');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 10000;

// ── CORS y archivos estáticos ────────────────────────────────
app.use(cors());
app.use(express.static(__dirname));

// ── Llave Riot (viene de las env vars de Render) ─────────────
const RIOT_API_KEY = process.env.RIOT_API_KEY;

if (!RIOT_API_KEY) {
    console.error('❌ RIOT_API_KEY no está definida. Revisa las variables de entorno en Render.');
}

// ── PROXY HACIA RIOT API ─────────────────────────────────────
// El script.js llama:  /api/riot/<region>/<endpoint>
// Este server redirige: https://<region>.api.riotgames.com/<endpoint>
//
// Ejemplos:
//   /api/riot/americas/riot/account/v1/accounts/by-riot-id/Faker/T1
//   /api/riot/la1/lol/summoner/v4/summoners/by-puuid/<puuid>
//   /api/riot/la1/lol/league/v4/entries/by-puuid/<puuid>
//   /api/riot/americas/lol/match/v5/matches/by-puuid/<puuid>/ids
//   /api/riot/la1/lol/champion-mastery/v4/champion-masteries/by-puuid/<puuid>/top
app.use('/api/riot', async (req, res) => {
    const parts    = req.path.split('/').filter(Boolean);
    const region   = parts[0];
    const endpoint = parts.slice(1).join('/');

    if (!region || !endpoint) {
        return res.status(400).json({ error: 'Formato de ruta invalido' });
    }

    const queryString = new URLSearchParams(req.query).toString();
    const url = `https://${region}.api.riotgames.com/${endpoint}${queryString ? '?' + queryString : ''}`;

    try {
        const response = await axios.get(url, {
            headers: { 'X-Riot-Token': RIOT_API_KEY },
            timeout: 8000
        });
        res.json(response.data);
    } catch (error) {
        const status = error.response ? error.response.status : 500;
        if (status !== 403 && status !== 404) {
            console.error(`Error Riot API ${status}: ${url}`);
        }
        res.status(status).json({ error: `Error ${status} desde Riot API` });
    }
});

// ── Pagina principal ─────────────────────────────────────────
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Iniciar servidor ─────────────────────────────────────────
app.listen(PORT, () => {
    console.log('==========================================');
    console.log(`Servidor NTI activo en puerto: ${PORT}`);
    console.log(`Llave: ${RIOT_API_KEY ? RIOT_API_KEY.substring(0, 15) + '...' : 'NO DEFINIDA'}`);
    console.log('==========================================');
});