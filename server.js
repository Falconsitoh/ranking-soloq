require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path'); // <-- NUEVO: Para manejar rutas de archivos

const app = express();
app.use(cors());

// 🌟 NUEVO: Esto le dice a Node.js que sirva tu HTML, CSS y JS al mundo
app.use(express.static(path.join(__dirname))); 

// 🛡️ SEGURIDAD EXTREMA: Borramos tu llave de aquí. 
// Ahora el servidor la leerá EXCLUSIVAMENTE de las "Variables de Entorno" secretas de Render.
const API_KEY = process.env.RIOT_API_KEY;

app.use('/api/riot', async (req, res) => {
    const pathParts = req.path.split('/');
    const region = pathParts[1]; 
    const endpoint = pathParts.slice(2).join('/'); 
    const queryParams = new URLSearchParams(req.query).toString();
    const url = `https://${region}.api.riotgames.com/${endpoint}${queryParams ? `?${queryParams}` : ''}`;

    try {
        const response = await axios.get(url, {
            headers: { 'X-Riot-Token': API_KEY },
            timeout: 5000 
        });
        res.json(response.data);
    } catch (error) {
        const status = error.response ? error.response.status : 500;
        if (status !== 403 && status !== 404) {
            console.error(`❌ Error API Riot (${status}): ${url}`);
        }
        res.status(status).json({ error: 'Error conectando con Riot' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`==========================================`);
    console.log(`🚀 SERVIDOR NTI CLOUD ACTIVO EN PUERTO: ${PORT}`);
    console.log(`==========================================`);
});