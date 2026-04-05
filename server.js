const express = require('express');
const axios = require('axios');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
// ESTO arregla que se vea "sin ropa" (carga el CSS e imágenes)
app.use(express.static(__dirname)); 

const RIOT_API_KEY = process.env.RIOT_API_KEY;

// ESTO arregla el "Not Found" (le dice al servidor que entregue el index.html)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/summoner/:region/:name/:tag', async (req, res) => {
    try {
        const { region, name, tag } = req.params;
        const routingValue = region.toLowerCase() === 'lan' ? 'americas' : 'americas';
        
        const accountRes = await axios.get(`https://${routingValue}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${name}/${tag}?api_key=${RIOT_API_KEY}`);
        const { puuid } = accountRes.data;

        const platformValue = region.toLowerCase() === 'lan' ? 'la1' : 'la1';
        const summonerRes = await axios.get(`https://${platformValue}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}?api_key=${RIOT_API_KEY}`);
        const { id, profileIconId, summonerLevel } = summonerRes.data;

        const leagueRes = await axios.get(`https://${platformValue}.api.riotgames.com/lol/league/v4/entries/by-summoner/${id}?api_key=${RIOT_API_KEY}`);
        
        res.json({
            name,
            tag,
            profileIconId,
            summonerLevel,
            league: leagueRes.data
        });
    } catch (error) {
        res.status(error.response?.status || 500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`🚀 SERVIDOR NTI CLOUD ACTIVO EN PUERTO: ${PORT}`);
    console.log(`=========================================`);
});