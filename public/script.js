// ================================================================
//  NTI ESPORTS — SoloQ Ranking  |  script.js (VERSIÓN OPTIMIZADA)
// ================================================================

localStorage.removeItem('nti_cache_datos');

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(function(regs) {
        regs.forEach(function(reg) { reg.unregister(); });
    });
}

// ── 0. FÍSICAS MAGNÉTICAS ──────────────────────────
function initMagneticButtons() {
    document.querySelectorAll('.magnetic-btn').forEach(function(btn) {
        btn.addEventListener('mousemove', function(e) {
            var rect = btn.getBoundingClientRect();
            var x = e.clientX - rect.left - rect.width / 2;
            var y = e.clientY - rect.top - rect.height / 2;
            btn.style.transform = `translate(${x * 0.3}px, ${y * 0.3}px) scale(1.05)`;
        });
        btn.addEventListener('mouseleave', function() {
            btn.style.transform = 'translate(0px, 0px) scale(1)';
        });
    });
}
setTimeout(initMagneticButtons, 1000);

// ── 1. TEMA ───────────────────────────────────────────────────
var savedTheme = localStorage.getItem('nti_theme') || 'dark';
document.documentElement.setAttribute('data-theme', savedTheme);

function toggleTheme() {
    var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('nti_theme', next);
    document.getElementById('theme-icon').textContent = next === 'dark' ? '☀️' : '🌙';
}

function applyDynamicTheme(champName) {
    var r = document.documentElement;
    r.style.setProperty('--panel-dyn', 'var(--gold-main)');
    r.style.setProperty('--panel-dyn-glow', 'rgba(200, 155, 60, .35)');
}

function resetDynamicTheme() {
    var r = document.documentElement;
    r.style.setProperty('--panel-dyn', 'var(--gold-main)');
    r.style.setProperty('--panel-dyn-glow', 'rgba(200, 155, 60, .35)');
}

function changePanelSplash(champId) {
    var bg = document.querySelector('.panel-bg-blur');
    if (bg && champId) bg.style.backgroundImage = `url('https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${champId}_0.jpg')`;
}

function resetPanelSplash(defaultChampId) {
    var bg = document.querySelector('.panel-bg-blur');
    if (bg && defaultChampId) bg.style.backgroundImage = `url('https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${defaultChampId}_0.jpg')`;
}

// ── 3. NODE.JS Y ESTADO GLOBAL ────────────────────────────────
var BACKEND_URL = '/api/riot'; 
var region = 'la1';
var r_americas = 'americas';

async function fetchRiot(regionCode, endpoint) {
    var res = await fetch(`${BACKEND_URL}/${regionCode}/${endpoint}`);
    if (!res.ok) throw new Error('API Error');
    return await res.json();
}

var versionDD = '14.24.1';
var champByKey = {};
var perkById = {};
var itemById = {};

var ROLES = { TOP: 'TOP', JUNGLE: 'JGL', MIDDLE: 'MID', BOTTOM: 'ADC', UTILITY: 'SUP', '': '?' };
var STAT_SHARD_NAMES = { 5001: 'HP x Nivel', 5002: 'Armadura', 5003: 'Res. Mágica', 5005: 'Vel. Ataque', 5007: 'Reducción CD', 5008: 'Poder Adaptativo', 5010: 'Vel. Movimiento', 5011: 'HP', 5013: 'Tenacidad', 5014: 'Vel. Ataque', 5021: 'HP Escudo', 5022: 'Tenacidad' };

// --- ⚡ AQUI QUITE LOS JUGADORES MANUALES. LA LISTA AHORA SE LLENA DESDE EL SERVIDOR ⚡ ---
var valoresTier = { 'CHALLENGER': 9, 'GRANDMASTER': 8, 'MASTER': 7, 'DIAMOND': 6, 'EMERALD': 5, 'PLATINUM': 4, 'GOLD': 3, 'SILVER': 2, 'BRONZE': 1, 'IRON': 0, 'UNRANKED': -1 };

var datosGlobal = [];
var cacheHistorial = {};
var radarChartInst = null;
var lineChartInst = null;
var compRadarInst = null;

var tabActiva = 'all';
var sortEstado = {campo: 'rango', dir: 'desc'};
var ultimaActualizacion = localStorage.getItem('nti_cache_time');
var cargando = false;
var panelActivo = null;
var pinnedPlayer = localStorage.getItem('nti_pinned') || null;
var liveTimers = {};

var sleep = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };

// ── 4. TOASTS Y PARTÍCULAS ────────────────────────────────────
function showToast(htmlMsg, type) {
    var c = document.getElementById('toast-container');
    var t = document.createElement('div');
    t.className = 'toast' + (type === 'win' ? ' toast-win' : type === 'loss' ? ' toast-loss' : '');
    t.innerHTML = htmlMsg;
    c.appendChild(t);
    setTimeout(function() { if (t.parentNode) t.remove(); }, 5000);
}

function initParticles() {
    var canvas = document.getElementById('hextech-particles');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var W, H2, particles = [];
    var resize = function() { W = canvas.width = window.innerWidth; H2 = canvas.height = window.innerHeight; };
    window.addEventListener('resize', resize);
    resize();
    class P {
        constructor() { this.reset(); }
        reset() { this.x = Math.random() * W; this.y = Math.random() * H2; this.size = Math.random() * 2 + .4; this.sy = Math.random() * -.45 - .08; this.sx = Math.random() * .35 - .175; this.col = Math.random() > .5 ? 'rgba(252, 211, 77, ' : 'rgba(59, 130, 246, '; this.op = Math.random() * .4 + .1; }
        update() { this.y += this.sy; this.x += this.sx; if (this.y < 0) { this.y = H2; this.x = Math.random() * W; } }
        draw() { ctx.fillStyle = this.col + this.op + ')'; ctx.beginPath(); ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2); ctx.fill(); }
    }
    for (var i = 0; i < 85; i++) particles.push(new P());
    (function animate() { ctx.clearRect(0, 0, W, H2); particles.forEach(function(p) { p.update(); p.draw(); }); requestAnimationFrame(animate); })();
}

function triggerCounters() {
    document.querySelectorAll('.counter-anim').forEach(function(el) {
        var val = parseInt(el.getAttribute('data-val')) || 0;
        var suffix = el.getAttribute('data-suffix') || '';
        var ts = null;
        var step = function(t) {
            if (!ts) ts = t;
            var p = Math.min((t - ts) / 1200, 1);
            el.innerHTML = Math.floor(p * val) + suffix;
            if (p < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
        el.classList.remove('counter-anim');
    });
}

// ── 5. LÓGICA DE DATOS, RACHAS Y TÍTULOS ──────────────────────
function getLPHistory(n) { return JSON.parse(localStorage.getItem('nti_lp_' + n) || '[]'); }

function saveLPSnapshot(nombre, lp, tier) {
    var hist = getLPHistory(nombre);
    var today = new Date().toDateString();
    if (hist.length && hist[hist.length - 1].date === today) {
        hist[hist.length - 1].lp = lp;
        hist[hist.length - 1].tier = tier;
    } else {
        hist.push({date: today, lp, tier});
    }
    if (hist.length > 7) hist.shift();
    localStorage.setItem('nti_lp_' + nombre, JSON.stringify(hist));
}

function getLPDelta(nombre) {
    var hist = getLPHistory(nombre);
    if (hist.length < 2) return null;
    var today = new Date().toDateString();
    var te = hist.find(function(h) { return h.date === today; });
    var pe = hist.filter(function(h) { return h.date !== today; }).pop();
    if (!te || !pe || te.tier !== pe.tier) return null;
    return te.lp - pe.lp;
}

function renderSparkline(nombre) {
    var hist = getLPHistory(nombre);
    if (hist.length < 2) return '';
    var vals = hist.map(function(h) { return h.lp; });
    var mn = Math.min(...vals), mx = Math.max(...vals), rng = mx - mn || 1;
    var W = 56, H = 16;
    var pts = vals.map(function(v, i) { return ((i / (vals.length - 1)) * W).toFixed(1) + ',' + (H - ((v - mn) / rng) * H).toFixed(1); }).join(' ');
    var color = vals[vals.length - 1] >= vals[vals.length - 2] ? 'var(--win-color)' : 'var(--loss-color)';
    return `<svg class="lp-sparkline" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function calcNTIScore(jug) {
    var lpNorm = Math.min((Math.max(jug.valorT, 0) / 9) * 85 + (jug.puntos / 100) * 15, 100);
    var total = jug.victorias + jug.derrotas;
    var wr = total > 0 ? (jug.victorias / total) * 100 : 50;
    var perf = wr;
    var matches = cacheHistorial[jug.nombre];
    if (matches && matches.length) {
        var kdaS = 0, visS = 0, n = 0;
        matches.forEach(function(m) {
            var me = m.info?.participants?.find(function(p) { return p.puuid === jug.puuid; });
            if (!me) return;
            kdaS += (me.deaths || 0) === 0 ? Math.min((me.kills || 0) + (me.assists || 0), 15) : ((me.kills || 0) + (me.assists || 0)) / (me.deaths || 1);
            visS += (me.visionScore || 0);
            n++;
        });
        if (n > 0) perf = Math.min((kdaS / n) / 5 * 100, 100) * 0.6 + Math.min((visS / n) / 35 * 100, 100) * 0.4;
    }
    return Math.min(Math.round(lpNorm * 0.4 + wr * 0.3 + perf * 0.3), 100);
}

function ntiScoreColor(s) {
    if (s >= 80) return '#f59e0b';
    if (s >= 60) return '#10b981';
    if (s >= 40) return '#3b82f6';
    return '#94a3b8';
}

function calcStreak(puuid, matches) {
    if (!matches || !matches.length) return null;
    var type = null, count = 0;
    for (var i = 0; i < matches.length; i++) {
        var m = matches[i];
        var me = m.info?.participants?.find(function(p) { return p.puuid === puuid; });
        if (!me) break;
        if (type === null) { type = me.win ? 'win' : 'loss'; count = 1; } 
        else if ((me.win && type === 'win') || (!me.win && type === 'loss')) { count++; } 
        else break;
    }
    return count >= 2 ? {type, count} : null;
}

function getDynamicTitle(matches, puuid) {
    if (!matches || matches.length < 3) return '';
    var dmg = 0, vision = 0, deaths = 0, kills = 0, assists = 0;
    matches.forEach(function(m) {
        var me = m.info?.participants?.find(function(p) { return p.puuid === puuid; });
        if (me) { dmg += me.totalDamageDealtToChampions || 0; vision += me.visionScore || 0; deaths += me.deaths || 0; kills += me.kills || 0; assists += me.assists || 0; }
    });
    var avgDmg = dmg / matches.length, avgVis = vision / matches.length, kda = deaths === 0 ? 10 : (kills + assists) / deaths;
    if (avgDmg > 26000) return '<span class="player-title-badge title-canon">Cañón de Cristal</span>';
    if (kda > 4.5) return '<span class="player-title-badge title-inmortal">Inmortal</span>';
    if (avgVis > 25) return '<span class="player-title-badge title-vision">Ojo de Halcón</span>';
    return '';
}

// ── 6. PODIO 3D SEMANAL ───────────────────────
function updateTrophyPodium() {
    var podium = document.getElementById('trophy-podium');
    if (!podium) return;
    var statsList = [];
    Object.keys(cacheHistorial).forEach(function(nombre) {
        var jug = datosGlobal.find(function(j) { return j.nombre === nombre; });
        var matches = cacheHistorial[nombre];
        if (!jug || !matches || matches.length === 0) return;
        var k = 0, d = 0, v = 0, n = 0;
        matches.forEach(function(m) {
            var me = m.info?.participants?.find(function(p) { return p.puuid === jug.puuid; });
            if (me) { k += me.kills || 0; d += me.deaths || 0; v += me.visionScore || 0; n++; }
        });
        if (n > 0) { statsList.push({ nombre, icono: jug.icono, killsAvg: k / n, deathsAvg: d / n, visionAvg: v / n }); }
    });

    if (statsList.length < 3) {
        podium.innerHTML = `<div style="width: 100%; text-align: center; color: var(--text-muted); font-size: 0.8rem;">⏳ Haz clic en el perfil de los jugadores para analizar sus datos y armar el podio...</div>`;
        return;
    }

    var carnicero = [...statsList].sort(function(a, b) { return b.killsAvg - a.killsAvg; })[0];
    var inmortal = [...statsList].sort(function(a, b) { return a.deathsAvg - b.deathsAvg; })[0];
    var vision = [...statsList].sort(function(a, b) { return b.visionAvg - a.visionAvg; })[0];

    podium.innerHTML = `
        <div class="podium-slot podium-2" title="Menos muertes promedio">
            <span class="podium-title">El Inmortal</span>
            <img class="podium-avatar" src="https://ddragon.leagueoflegends.com/cdn/${versionDD}/img/profileicon/${inmortal.icono}.png">
            <span class="podium-name">${inmortal.nombre}</span>
            <div class="podium-base">
                <span class="podium-stat">${inmortal.deathsAvg.toFixed(1)}</span>
                <span class="podium-desc">Muertes/Partida</span>
            </div>
        </div>
        <div class="podium-slot podium-1" title="Más asesinatos promedio">
            <span class="podium-title">El Carnicero</span>
            <img class="podium-avatar" src="https://ddragon.leagueoflegends.com/cdn/${versionDD}/img/profileicon/${carnicero.icono}.png">
            <span class="podium-name">${carnicero.nombre}</span>
            <div class="podium-base">
                <span class="podium-stat">${carnicero.killsAvg.toFixed(1)}</span>
                <span class="podium-desc">Kills/Partida</span>
            </div>
        </div>
        <div class="podium-slot podium-3" title="Mejor score de visión">
            <span class="podium-title">El Visionario</span>
            <img class="podium-avatar" src="https://ddragon.leagueoflegends.com/cdn/${versionDD}/img/profileicon/${vision.icono}.png">
            <span class="podium-name">${vision.nombre}</span>
            <div class="podium-base">
                <span class="podium-stat">${vision.visionAvg.toFixed(1)}</span>
                <span class="podium-desc">Score Visión</span>
            </div>
        </div>`;
}

// ── 7. CORTES DE LIGA ────────────────────
async function cargarCutoffsLigas() {
    try {
        var gmRes = await fetchRiot(region, 'lol/league/v4/grandmasterleagues/by-queue/RANKED_SOLO_5x5');
        var chRes = await fetchRiot(region, 'lol/league/v4/challengerleagues/by-queue/RANKED_SOLO_5x5');
        
        if (gmRes && gmRes.entries) {
            var gmArr = gmRes.entries.map(function(x) { return x.leaguePoints; }).sort(function(a,b){return b-a;});
            var gmLp = gmArr[gmArr.length - 1] || 0;
            var el = document.getElementById('cutoff-gm');
            if (el) { el.setAttribute('data-val', gmLp); el.classList.add('counter-anim'); }
        }
        if (chRes && chRes.entries) {
            var chArr = chRes.entries.map(function(x) { return x.leaguePoints; }).sort(function(a,b){return b-a;});
            var chLp = chArr[chArr.length - 1] || 0;
            var el = document.getElementById('cutoff-cha');
            if (el) { el.setAttribute('data-val', chLp); el.classList.add('counter-anim'); }
        }
        triggerCounters(); // Animar los números
    } catch (e) { console.error("Error cargando cortes:", e); }
}

// ── 8. OBTENER DATOS (Carga Rápida Optimizada) ────────
function renderSkeleton() {
    var t = document.getElementById('tabla-body');
    var h = '';
    for (var i = 0; i < 8; i++) {
        h += `
        <tr class="skeleton-row">
            <td><div class="sk sk-sm" style="margin:auto;width:20px;"></div></td>
            <td style="padding-left:28px;"><div style="display:flex;align-items:center;gap:12px;"><div class="sk sk-circle"></div><div><div class="sk sk-md" style="margin-bottom:6px;"></div><div class="sk sk-sm sk-short"></div></div></div></td>
            <td><div class="sk sk-lg" style="margin:auto;"></div></td>
            <td><div class="sk sk-sm" style="margin:auto;width:48px;"></div></td>
            <td><div class="sk sk-md" style="margin:auto;width:80px;"></div></td>
            <td><div class="sk sk-sm" style="margin:auto;width:40px;"></div></td>
        </tr>`;
    }
    t.innerHTML = h;
}

async function obtenerDatos() {
    if (cargando) return;
    cargando = true;
    var btn = document.querySelector('.refresh-btn');
    if (btn) btn.classList.add('girando');

    if (datosGlobal.length === 0) renderSkeleton();
    cargarCutoffsLigas();

    try {
        var res = await fetch('/api/ranking-actual');
        var resultados = await res.json();

        if (resultados.error) throw new Error(resultados.error);

        // Solo notificar si ya teníamos datos previos (no en la primera carga)
        if (datosGlobal.length > 0) {
            resultados.forEach(function(nd) {
                if (nd.error) return;
                var od = datosGlobal.find(function(o){ return o.nombre === nd.nombre && !o.error; });
                if (!od) return;
                if (nd.victorias > od.victorias) {
                    var lpGain = nd.puntos - od.puntos;
                    showToast('🏆 <strong>' + nd.nombre + '</strong> ganó<br><span style="color:var(--win-color);font-weight:900;font-size:1.1em;">' + (lpGain>=0?'+':'') + lpGain + ' LP</span> · ' + nd.tier + ' ' + nd.rango, 'win');
                } else if (nd.derrotas > od.derrotas) {
                    var lpLoss = nd.puntos - od.puntos;
                    showToast('💀 <strong>' + nd.nombre + '</strong> perdió<br><span style="color:var(--loss-color);font-weight:900;font-size:1.1em;">' + (lpLoss>=0?'+':'') + lpLoss + ' LP</span> · ' + nd.tier + ' ' + nd.rango, 'loss');
                }
            });
        }

        datosGlobal = resultados;
        // GUARDAR LP SNAPSHOT para sparkline y delta (+/- LP)
        datosGlobal.forEach(function(j) {
            if (!j.error && j.tier && j.puntos !== undefined) {
                // Solo guardar si los LP cambiaron respecto al último snapshot
                var hist = getLPHistory(j.nombre);
                var ultimo = hist.length ? hist[hist.length - 1] : null;
                var today  = new Date().toDateString();
                if (!ultimo || ultimo.date !== today || ultimo.lp !== j.puntos) {
                    saveLPSnapshot(j.nombre, j.puntos, j.tier);
                }
            }
        });
        localStorage.setItem('nti_cache_datos', JSON.stringify(datosGlobal));
        localStorage.setItem('nti_cache_time', Date.now());

        var todayStr = new Date().toDateString();
        if (localStorage.getItem('nti_last_rank_save') !== todayStr) {
            var sorted = [...datosGlobal].sort(function(a, b) { return (b.valorT - a.valorT) || (b.puntos - a.puntos); });
            sorted.forEach(function(j, idx) { localStorage.setItem('nti_rank_' + j.nombre, idx); });
            localStorage.setItem('nti_last_rank_save', todayStr);
        }

    } catch (e) {
        console.error("Error obteniendo datos:", e);
        if (datosGlobal.length === 0) {
            document.getElementById('tabla-body').innerHTML = `<tr><td colspan="6" style="color:var(--loss-color); padding:30px; font-weight: bold;">Cargando base de datos...</td></tr>`;
        }
    }

    if (btn) btn.classList.remove('girando');
    actualizarTimer();
    cargando = false;
    
    if (datosGlobal.length > 0) {
        filtrarTabla();
        renderHeroSection();
        updateTrophyPodium();
        updateChallenge();
        cargarHallOfFame();
    }
}

function refrescarDatos() {
    if (!cargando) obtenerDatos();
}

function updateChallenge() {
    var total = datosGlobal.reduce(function(s, j) { return s + (j.partidasHoy || 0); }, 0);
    var pct = Math.min((total / 50) * 100, 100);
    var bar = document.getElementById('team-challenge-bar');
    var txt = document.getElementById('team-challenge-text');
    var pctEl = document.getElementById('challenge-pct');

    if (bar) bar.style.width = pct + '%';
    if (txt) txt.textContent = total + ' / 50';
    if (pctEl) pctEl.textContent = Math.round(pct) + '%';

    var validos = datosGlobal.filter(function(j) { return !j.error; });
    var wins = validos.reduce(function(s, j) { return s + (j.victorias && j.partidasHoy > 0 ? j.partidasHoy : 0); }, 0);
    var totalG = validos.reduce(function(s, j) { return s + (j.partidasHoy || 0); }, 0);

    var wEl = document.getElementById('team-wins-today');
    var lEl = document.getElementById('team-losses-today');
    var wREl = document.getElementById('team-wr-today');

    if (wEl) wEl.textContent = '' + totalG;
    if (lEl) lEl.textContent = '⚔️';
    if (wREl) wREl.textContent = totalG > 0 ? Math.round((wins / totalG) * 100) + '%' : '—';
}

// ── 9. RENDER TABLA ──────────────────────
function filtrarTabla() { renderTabla(); }

function renderTabla() {
    var tabla = document.getElementById('tabla-body');
    var searchVal = (document.getElementById('search-input')?.value || '').toLowerCase();

    var filtrados = datosGlobal;
    if (tabActiva !== 'all') filtrados = filtrados.filter(function(j) { return j.division === tabActiva; });
    if (searchVal) filtrados = filtrados.filter(function(j) { return j.nombre.toLowerCase().includes(searchVal); });

    var validos = filtrados.filter(function(j) { return !j.error; });
    validos.sort(function(a, b) {
        var d = (b.valorT - a.valorT) || (b.puntos - a.puntos);
        if (sortEstado.campo === 'pl') { d = b.puntos - a.puntos; } 
        else if (sortEstado.campo === 'nti') { d = calcNTIScore(b) - calcNTIScore(a); }
        return sortEstado.dir === 'desc' ? d : -d;
    });

    if (pinnedPlayer) {
        var pi = validos.findIndex(function(j) { return j.nombre === pinnedPlayer; });
        if (pi > 0) { var p = validos.splice(pi, 1)[0]; validos.unshift(p); }
    }

    // Limpiar todos los timers activos antes de re-renderizar
    Object.keys(liveTimers).forEach(function(k) { clearInterval(liveTimers[k]); });
    liveTimers = {};
    tabla.innerHTML = '';

    validos.forEach(function(j, i) {
        var total = j.victorias + j.derrotas;
        var wr = total > 0 ? Math.round((j.victorias / total) * 100) : 0;
        var tierLow = j.tier.toLowerCase();
        var tierIcon = `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-emblem/emblem-${tierLow}.png`;
        var wrClass = wr > 50 ? 'wr-verde' : 'wr-rojo';
        var delta = getLPDelta(j.nombre);
        var deltaH = delta !== null ? `<span class="lp-delta ${delta >= 0 ? 'lp-delta-up' : 'lp-delta-down'}">${delta >= 0 ? '+' : ''}${delta}</span>` : '';
        var sparkH = renderSparkline(j.nombre);
        
        var isPinned = pinnedPlayer === j.nombre;

        var liveH = '';
        if (j.isInGame) {
            var cid = champByKey[j.activeChampId]?.id;
            liveH = `<span class="live-badge"><span class="live-dot"></span> EN PARTIDA <span id="timer-${j.puuid}">...</span> ${cid ? `<img src="https://ddragon.leagueoflegends.com/cdn/${versionDD}/img/champion/${cid}.png" style="width:16px;height:16px;border-radius:50%;margin-left:4px;">` : ''}</span>`;
            if (j.gameStartTime > 0) {
                liveTimers[j.puuid] = setInterval(function() {
                    var el = document.getElementById(`timer-${j.puuid}`);
                    if (el) {
                        var secs = Math.floor((Date.now() - j.gameStartTime) / 1000);
                        el.textContent = `${Math.floor(secs / 60)}:${(secs % 60).toString().padStart(2, '0')}`;
                    }
                }, 1000);
            }
        }

        var oldRank = localStorage.getItem('nti_rank_' + j.nombre);
        var posH = `<div class="pos-same">—</div>`;
        if (oldRank !== null) {
            var diff = parseInt(oldRank) - i;
            if (diff > 0) posH = `<div class="pos-up">▲${diff}</div>`;
            else if (diff < 0) posH = `<div class="pos-down">▼${Math.abs(diff)}</div>`;
        }

        var badges = '';
        var isOnFire = false;
        var isGodFire = false;
        var isPenta = false;

        if (j.partidasHoy >= 10) badges += `<span class="ach-badge" title="Tryhard: +10 rankeds hoy">🔋</span>`;

        var dynamicTitle = getDynamicTitle(cacheHistorial[j.nombre], j.puuid);

        if (cacheHistorial[j.nombre]) {
            var streak = calcStreak(j.puuid, cacheHistorial[j.nombre]);
            if (streak?.type === 'loss' && streak.count >= 3) { badges += `<span class="ach-badge" title="Racha de ${streak.count} derrotas">🩹</span>`; }
            if (streak?.type === 'win' && streak.count >= 3) {
                badges += `<span class="ach-badge" title="On Fire: ${streak.count} victorias">🔥</span>`;
                isOnFire = true;
                if (streak.count >= 5) isGodFire = true;
            }
            var tk = 0, td = 0, ta = 0;
            cacheHistorial[j.nombre].forEach(function(m) {
                var me = m.info?.participants?.find(function(p) { return p.puuid === j.puuid; });
                if (me) {
                    tk += me.kills || 0; td += me.deaths || 0; ta += me.assists || 0;
                    if (me.pentaKills > 0) isPenta = true;
                }
            });
            if (td > 0 && (tk + ta) / td >= 4.0) badges += `<span class="ach-badge" title="KDA Excepcional">🎯</span>`;
        }

        var rowClass = '', rankNum = `${i + 1}`;
        if (i === 0) { rowClass = 'row-top-1'; rankNum = '<span class="top1-crown">👑</span>'; } 
        else if (i === 1) { rowClass = 'row-top-2'; rankNum = '<span class="top2-medal">🥈</span>'; } 
        else if (i === 2) { rowClass = 'row-top-3'; rankNum = '<span class="top2-medal">🥉</span>'; }

        if (isPenta) rowClass = 'row-pentakill';

        // Preferir ntiScore del servidor (pre-calculado) para no saturar el cliente
        var ntiScore = (j.ntiScore !== undefined) ? j.ntiScore : calcNTIScore(j);
        var ntiColor = ntiScoreColor(ntiScore);
        var isOpen = panelActivo === j.nombre;
        var nameSafe = j.nombre.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

        tabla.innerHTML += `
            <tr class="rank-row jugador-row ${isOpen ? 'row-activa' : ''} ${rowClass} ${isOnFire && !isGodFire && !isPenta ? 'row-on-fire' : ''} ${isGodFire && !isPenta ? 'row-god-fire' : ''} ${isPinned ? 'row-pinned' : ''}" style="animation-delay:${i * 0.05}s" data-name="${nameSafe}" onclick="togglePanel(this.getAttribute('data-name'))">
                <td style="font-weight:900;font-size:1.2rem;"><div class="pos-container">${rankNum}${posH}</div></td>
                <td style="text-align:left;padding-left:26px;">
                    <div class="invocador-cell">
                        <img src="https://ddragon.leagueoflegends.com/cdn/${versionDD}/img/profileicon/${j.icono}.png" class="mini-icon">
                        <div class="invocador-info">
                            <div>
                                <strong>${j.nombre}</strong><span class="badge-${j.division}">${j.division}</span>${liveH}
                                <button class="pin-star ${isPinned ? 'pinned' : ''}" data-name="${nameSafe}" onclick="togglePin(this.getAttribute('data-name'), event)" title="${isPinned ? 'Desfijar' : 'Fijar arriba'}">${isPinned ? '⭐' : '☆'}</button>
                            </div>
                            ${dynamicTitle}
                            <div class="achievements">${badges}${getBadgesAdicionales(j)}<span class="partidas-hoy-badge">🎮 Hoy: ${j.partidasHoy}</span></div>
                        </div>
                    </div>
                </td>
                <td class="${tierLow}"><div class="rank-cell-container"><img src="${tierIcon}" class="rank-icon"><span class="rank-text">${j.tier} ${j.rango}</span></div></td>
                <td class="lp-text"><div class="lp-cell-inner"><div><span class="counter-anim" data-val="${j.puntos}">0</span><span class="lp-small"> LP</span>${deltaH}</div>${sparkH}</div></td>
                
                <td class="stats-col-cell">
                    <div class="stats-col-container">
                        <div class="permanent-vd-nums"><span class="victorias-text">${j.victorias}V</span> / <span class="derrotas-text">${j.derrotas}D</span></div>
                        <div class="permanent-wr ${wrClass}">${wr}% Winrate</div>
                        <div class="total-games">${total} Partidas</div>
                    </div>
                </td>
                
                <td><div class="nti-score-cell"><div class="nti-score-ring" style="--nti-color:${ntiColor};" title="NTI Score: ${ntiScore}"><span class="nti-score-val">${ntiScore}</span></div></div></td>
            </tr>`;

        if (isOpen) {
            tabla.innerHTML += `
            <tr class="panel-row-tr">
                <td colspan="6">
                    <div class="panel-wrapper open">
                        <div class="panel-jugador" id="panel-inner">
                            <div class="panel-loading-fancy">
                                <div class="scan-bar"></div>
                                <div class="pl-grid">
                                    <div class="sk sk-circle-lg"></div>
                                    <div style="display:flex;flex-direction:column;gap:10px;flex:1;">
                                        <div class="sk sk-title"></div>
                                        <div class="sk sk-subtitle"></div>
                                    </div>
                                </div>
                                <div class="pl-steps">
                                    <div class="pl-step done">✓ Conectado con Servidor NTI</div>
                                    <div class="pl-step active" id="pl-step-1">⟳ Descargando historial de <strong>${j.nombre}</strong>...</div>
                                    <div class="pl-step" id="pl-step-2">⏳ Analizando estadísticas...</div>
                                </div>
                            </div>
                        </div>
                    </div>
                </td>
            </tr>`;
        }
    });
    triggerCounters();
    initMagneticButtons();
}

// ── 10. PANEL HISTORIAL FULL ────────
function togglePanel(nombre) {
    if (panelActivo === nombre) {
        panelActivo = null;
        resetDynamicTheme();
        renderTabla();
        return;
    }
    panelActivo = nombre;
    renderTabla();

    var jug = datosGlobal.find(function(j) { return j.nombre === nombre; });
    if (!jug) return;

    if (cacheHistorial[nombre]) {
        setTimeout(function() { renderPanel(jug, cacheHistorial[nombre]); }, 50);
    } else {
        cargarPanel(jug);
    }
}

function cerrarPanel() {
    panelActivo = null;
    resetDynamicTheme();
    renderTabla();
}

async function cargarPanel(jugData) {
    try {
        var s1 = document.getElementById('pl-step-1');
        var s2 = document.getElementById('pl-step-2');
        
        if (cacheHistorial[jugData.nombre]) {
            renderPanel(jugData, cacheHistorial[jugData.nombre]);
            return;
        }

        var ids = await fetchRiot(r_americas, `lol/match/v5/matches/by-puuid/${jugData.puuid}/ids?queue=420&count=10`);
        if (s1) { s1.className = 'pl-step done'; s1.innerHTML = '✓ Historial descargado'; }
        if (s2) { s2.className = 'pl-step active'; }

        var matches = [];
        for (var i = 0; i < ids.length; i++) {
            var id = ids[i];
            matches.push(await fetchRiot(r_americas, `lol/match/v5/matches/${id}`));
        }

        cacheHistorial[jugData.nombre] = matches;
        renderTabla();
        updateTrophyPodium(); // Actualiza el podio si se desbloqueó un jugador que merece estar ahí

        if (panelActivo === jugData.nombre) renderPanel(jugData, matches);
    } catch (e) {
        var p = document.getElementById('panel-inner');
        if (p) p.innerHTML = `<div style="color:var(--loss-color);padding:30px;text-align:center;font-weight:700;">⚠️ Error conectando a Riot API. Por favor, intenta de nuevo.</div>`;
    }
}

function renderPanel(jugData, matches) {
    var p = document.getElementById('panel-inner');
    if (!p) return;

    var champStats = {};
    var rKda = 0, rVis = 0, rCs = 0, rDmg = 0, rGold = 0, recWins = 0;

    var lpTimeline = [];
    var earlyWins = 0, midWins = 0, lateWins = 0;
    var isPenta = false;

    matches.slice().reverse().forEach(function(m) {
        var me = m.info?.participants?.find(function(x) { return x.puuid === jugData.puuid; });
        if (!me) return;

        if (me.pentaKills > 0) isPenta = true;

        var key = me.championId;
        var ci = champByKey[key] || {name: '?',id: 'Aatrox'};

        if (!champStats[key]) { champStats[key] = {id: key,cid: ci.id,name: ci.name,w: 0,l: 0,k: 0,d: 0,a: 0,roles: {}}; }

        if (me.win) {
            champStats[key].w++;
            recWins++;
            lpTimeline.push(15);
            var min = (m.info?.gameDuration || 1) / 60;
            if (min < 25) earlyWins++; else if (min < 35) midWins++; else lateWins++;
        } else {
            champStats[key].l++;
            lpTimeline.push(-15);
        }

        champStats[key].k += me.kills || 0;
        champStats[key].d += me.deaths || 0;
        champStats[key].a += me.assists || 0;
        var rPos = me.teamPosition || '';
        champStats[key].roles[rPos] = (champStats[key].roles[rPos] || 0) + 1;

        rKda += me.deaths === 0 ? Math.min((me.kills || 0) + (me.assists || 0), 15) : ((me.kills || 0) + (me.assists || 0)) / (me.deaths || 1);
        rVis += me.visionScore || 0;
        rCs += ((me.totalMinionsKilled || 0) + (me.neutralMinionsKilled || 0)) / ((m.info?.gameDuration || 1) / 60);
        rDmg += me.totalDamageDealtToChampions || 0;
        rGold += me.goldEarned || 0;
    });

    if (isPenta) {
        var overlay = document.getElementById('penta-overlay');
        if (overlay) {
            overlay.style.display = 'flex';
            setTimeout(function() { overlay.style.display = 'none'; }, 3000);
        }
    }

    var spikeMsg = "Equilibrado";
    if (earlyWins > midWins && earlyWins > lateWins) spikeMsg = "Pico en Early Game (< 25m)";
    else if (midWins > earlyWins && midWins > lateWins) spikeMsg = "Rey del Mid Game (25-35m)";
    else if (lateWins > earlyWins && lateWins > midWins) spikeMsg = "Monstruo de Late Game (> 35m)";

    var streak = calcStreak(jugData.puuid, matches);
    var tiltMsg = '';
    if (streak && streak.type === 'loss' && streak.count >= 4) {
        tiltMsg = `<div style="background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.4); padding: 10px; border-radius: 8px; margin: 10px 28px; color: #93c5fd; font-size: 0.8rem;">
            ⛈️ <strong>TILT DETECTADO:</strong> Llevas ${streak.count} derrotas. Levántate, toma un vasito de agua, respira... ¡El LoL no es para sufrir!
        </div>`;
    }

    var mLen = matches.length || 1;
    var dKda = Math.min((rKda / mLen) / 5 * 100, 100);
    var dVis = Math.min((rVis / mLen) / 35 * 100, 100);
    var dCs = Math.min((rCs / mLen) / 8.5 * 100, 100);
    var dDmg = Math.min((rDmg / mLen) / 25000 * 100, 100);
    var dGold = Math.min((rGold / mLen) / 13000 * 100, 100);

    var topList = Object.values(champStats).sort(function(a, b) { return (b.w + b.l) - (a.w + a.l); });
    var topId = topList[0]?.id;
    var defaultSplash = `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${champByKey[topId]?.id || 'Aatrox'}_0.jpg`;
    applyDynamicTheme(champByKey[topId]?.name || '');

    var total = jugData.victorias + jugData.derrotas;
    var wr = total > 0 ? Math.round((jugData.victorias / total) * 100) : 0;
    var tierLow = jugData.tier.toLowerCase();
    var tierIcon = `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-emblem/emblem-${tierLow}.png`;
    var streakH = streak && streak.count >= 2 ? `<span class="streak-badge ${streak.type === 'win' ? 'streak-win' : 'streak-loss'}">${streak.type === 'win' ? '🔥' : '❄️'} Racha de ${streak.count} ${streak.type === 'win' ? 'victorias' : 'derrotas'}</span>` : '';
    var ntiScore = calcNTIScore(jugData);
    var ntiColor = ntiScoreColor(ntiScore);
    var nameSafe = jugData.nombre.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    var html = `
    <div class="panel-bg-blur" style="background-image:url('${defaultSplash}');"></div>
    <div class="panel-content">
        <div class="panel-header">
            <img class="panel-avatar" src="https://ddragon.leagueoflegends.com/cdn/${versionDD}/img/profileicon/${jugData.icono}.png">
            <div class="panel-header-info">
                <span class="panel-nombre" style="color:var(--panel-dyn)">${jugData.nombre}</span>
                <div class="panel-rango-info ${tierLow}">
                    <img class="panel-tier-icon" src="${tierIcon}">
                    <span>${jugData.tier} ${jugData.rango}</span>
                </div>
                <div class="panel-badges-row">${streakH}</div>
            </div>
            <div class="panel-stats-header">
                <div class="panel-stat"><span class="panel-stat-val">${total}</span><span class="panel-stat-lbl">Partidas</span></div>
                <div class="panel-stat"><span class="panel-stat-val" style="color:${wr >= 50 ? 'var(--win-color)' : 'var(--loss-color)'}">${wr}%</span><span class="panel-stat-lbl">Winrate</span></div>
                <div class="panel-stat"><span class="panel-stat-val">${jugData.puntos}<small style="font-size:.7rem;color:var(--text-muted)"> LP</small></span><span class="panel-stat-lbl">Liga</span></div>
                <div class="panel-stat"><span class="panel-stat-val" style="color:${ntiColor}">${ntiScore}</span><span class="panel-stat-lbl">NTI Score</span></div>
            </div>
            <button class="share-card-btn magnetic-btn" data-nombre="${nameSafe}" onclick="generateShareCard(this.getAttribute('data-nombre'))" title="Generar Player Card">📸</button>
            <button class="panel-cerrar-btn magnetic-btn" onclick="cerrarPanel()">✕</button>
        </div>`;

    html += tiltMsg;

    var champsH = '';
    topList.slice(0, 5).forEach(function(c) {
        var g = c.w + c.l;
        var cwr = Math.round((c.w / g) * 100);
        var cwrC = cwr >= 50 ? 'wr-verde' : 'wr-rojo';
        var kda = c.d === 0 ? '∞' : ((c.k + c.a) / c.d).toFixed(1);
        var rolPri = Object.entries(c.roles || {}).sort(function(a, b) { return b[1] - a[1]; })[0]?.[0] || '';

        champsH += `
        <div class="champ-card holo-card" data-tilt data-tilt-max="20" data-tilt-speed="400" data-tilt-glare data-tilt-max-glare="0.5">
            <img class="champ-icon-card" src="https://ddragon.leagueoflegends.com/cdn/${versionDD}/img/champion/${c.cid}.png" onerror="this.src='https://ddragon.leagueoflegends.com/cdn/${versionDD}/img/champion/Aatrox.png'">
            <div class="champ-card-nombre">${c.name}</div>
            <div class="champ-card-role">${ROLES[rolPri] || '?'}</div>
            <div class="champ-card-wr ${cwrC}">${cwr}%</div>
            <div class="champ-card-record">${c.w}V ${c.l}D</div>
            <div class="champ-card-kda">${kda} KDA</div>
        </div>`;
    });

    html += `
    <div class="panel-top-grid">
        <div>
            <div class="panel-seccion-titulo" style="font-size:.75rem;margin-bottom:14px;">📊 Campeones (Pico de Poder: ${spikeMsg})</div>
            <div class="panel-campeones">${champsH}</div>
        </div>
        <div class="radar-container"><div class="radar-labels-title">Evolución de LP</div><canvas id="lpChart"></canvas></div>
        <div class="radar-container"><div class="radar-labels-title">Performance</div><canvas id="radarChart"></canvas></div>
    </div>`;

    html += `<div class="panel-partidas-wrapper"><div class="panel-seccion-titulo">🕐 Últimas ${matches.length} Partidas Rankeadas</div><div class="panel-partidas">`;

    matches.forEach(function(m) {
        var me = m.info?.participants?.find(function(p) { return p.puuid === jugData.puuid; });
        if (!me) return;

        var win = me.win;
        var ci = champByKey[me.championId] || {name: '?',id: 'Aatrox'};
        var role = ROLES[me.teamPosition] || '?';
        var kda = me.deaths === 0 ? '∞' : (((me.kills || 0) + (me.assists || 0)) / (me.deaths || 1)).toFixed(2);
        var gameDurMatch = m.info?.gameDuration || 1;
        var dur = formatDuration(gameDurMatch);
        var ago = timeAgo(m.info?.gameStartTimestamp || Date.now());
        var cs = (me.totalMinionsKilled || 0) + (me.neutralMinionsKilled || 0);
        var csm = (cs / (gameDurMatch / 60)).toFixed(1);
        var teamKills = m.info?.participants?.filter(function(p) { return p.teamId === me.teamId; }).reduce(function(s, p) { return s + (p.kills || 0); }, 0) || 0;
        var kp = teamKills > 0 ? Math.round((((me.kills || 0) + (me.assists || 0)) / teamKills) * 100) : 0;

        var slots = [me.item0, me.item1, me.item2, me.item3, me.item4, me.item5, me.item6];
        var itemsH = slots.map(function(id) {
            if (!id || id === 0) return '<div class="item-vacio"></div>';
            var itm = itemById[id];
            if (!itm) return `<div class="item-wrapper"><img class="item-icon" src="https://ddragon.leagueoflegends.com/cdn/${versionDD}/img/item/${id}.png" onerror="this.style.visibility='hidden'"></div>`;

            var desc = itm.description ? itm.description.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 170) : '';
            var statsT = Object.entries(itm.stats || {}).map(function([k, v]) { return `${statKeyToES(k)}: ${v}`; }).join(', ');

            return `
            <div class="item-wrapper">
                <img class="item-icon" src="https://ddragon.leagueoflegends.com/cdn/${versionDD}/img/item/${id}.png">
                <div class="item-tooltip">
                    <div class="item-tooltip-name">${itm.name}</div>
                    ${itm.gold?.total ? `<div class="item-tooltip-gold">💰 ${itm.gold.total} oro</div>` : ''}
                    ${statsT ? `<div class="item-tooltip-stats">${statsT}</div>` : ''}
                    ${desc ? `<div class="item-tooltip-desc">${desc}${itm.description?.length > 170 ? '…' : ''}</div>` : ''}
                </div>
            </div>`;
        }).join('');

        var runeH = '<div class="keystone-placeholder"></div>';
        try {
            var prim = me.perks?.styles?.[0], sec = me.perks?.styles?.[1], sh = me.perks?.statPerks;
            if (prim && sec && sh) {
                var ks = perkById[prim.selections[0].perk];
                var pR = prim.selections.map(function(s) { var rk = perkById[s.perk]; return rk ? `<img src="${rk.url}" title="${rk.name}" class="rune-tooltip-icon${s === prim.selections[0] ? ' ks-icon-main' : ''}">` : ''; }).join('');
                var sR = sec.selections.map(function(s) { var rk = perkById[s.perk]; return rk ? `<img src="${rk.url}" title="${rk.name}" class="rune-tooltip-icon">` : ''; }).join('');
                var shN = [sh.offense, sh.flex, sh.defense].map(function(id) { return `<span class="shard-pill">${STAT_SHARD_NAMES[id] || '?'}</span>`; }).join('');
                runeH = `
                <div class="runas-container">
                    ${ks ? `<img class="keystone-icon" src="${ks.url}">` : `<div class="keystone-placeholder"></div>`}
                    <div class="runes-full-tooltip">
                        <div class="rft-section"><div class="rft-label">Principal</div><div class="rft-row">${pR}</div></div>
                        <div class="rft-divider"></div>
                        <div class="rft-section"><div class="rft-label">Secundario</div><div class="rft-row">${sR}</div></div>
                        <div class="rft-divider"></div>
                        <div class="rft-section"><div class="rft-label">Fragmentos</div><div class="rft-shards">${shN}</div></div>
                    </div>
                </div>`;
            }
        } catch (e) {}

        var allies = m.info?.participants?.filter(function(p) { return p.teamId === me.teamId; }) || [];
        var enemies = m.info?.participants?.filter(function(p) { return p.teamId !== me.teamId; }) || [];

        var teamH = function(list) {
            return list.map(function(p) {
                var pc = champByKey[p.championId] || {id: 'Aatrox'};
                var isMe = p.puuid === jugData.puuid;
                var pName = p.riotIdGameName || p.summonerName || '';
                var ntiPeer = datosGlobal.find(function(nj) { return nj.puuid === p.puuid; });
                return `
            <div class="team-player${isMe ? ' is-me' : ''}${ntiPeer && !isMe ? ' is-nti-peer' : ''}" title="${pName}">
                <img src="https://ddragon.leagueoflegends.com/cdn/${versionDD}/img/champion/${pc.id}.png">
                <span>${pName}</span>
            </div>`;
            }).join('');
        };

        html += `
        <div class="partida-row ${win ? 'partida-win' : 'partida-loss'}">
            <div class="partida-resultado-badge ${win ? 'badge-win' : 'badge-loss'}">${win ? 'V' : 'D'}</div>
            <div class="partida-champ-info">
                <img class="partida-champ-icon" src="https://ddragon.leagueoflegends.com/cdn/${versionDD}/img/champion/${ci.id}.png" onmouseenter="changePanelSplash('${ci.id}')" onmouseleave="resetPanelSplash('${champByKey[topId]?.id || 'Aatrox'}')">
                <div class="partida-champ-detalles">
                    <span class="partida-champ-nombre">${ci.name}</span>
                    <span class="partida-role-badge">${role}</span>
                </div>
                <div class="rich-tooltip">
                    <span class="rt-stat rt-dmg">⚔️ Daño: ${(me.totalDamageDealtToChampions || 0).toLocaleString()}</span>
                    <span class="rt-stat rt-gold">💰 Oro: ${(me.goldEarned || 0).toLocaleString()}</span>
                    <span class="rt-stat rt-cs">🌾 CS: ${cs}</span>
                </div>
            </div>
            <div class="partida-kda-info">
                <div class="partida-kda-nums"><span class="kda-k">${me.kills || 0}</span>/<span class="kda-d">${me.deaths || 0}</span>/<span class="kda-a">${me.assists || 0}</span></div>
                <div class="partida-kda-ratio">${kda} KDA</div>
                <div class="partida-cs-info">${cs} CS · ${csm}/m</div>
                <div class="partida-kp-vision">KP ${kp}%</div>
            </div>
            ${runeH}
            <div class="partida-items-grid">${itemsH}</div>
            <div class="partida-teams-container">
                <div class="partida-team">${teamH(allies)}</div>
                <div class="partida-vs">vs</div>
                <div class="partida-team">${teamH(enemies)}</div>
            </div>
            <div class="partida-meta">
                <div class="partida-duracion">${dur}</div>
                <div class="partida-ago">${ago}</div>
            </div>
        </div>`;
    });

    html += `</div></div></div>`;
    p.innerHTML = html;

    try { VanillaTilt.init(document.querySelectorAll('.champ-card[data-tilt]'), {max: 22,speed: 400,glare: true,'max-glare': .4}); } catch (e) {}
    initMagneticButtons();

    setTimeout(function() {
        Chart.defaults.color = '#8b97a7';
        var cvRadar = document.getElementById('radarChart');
        if (cvRadar) {
            if (radarChartInst) radarChartInst.destroy();
            radarChartInst = new Chart(cvRadar.getContext('2d'), {
                type: 'radar',
                data: { labels: ['KDA', 'Visión', 'Daño', 'Oro', 'Farmeo'], datasets: [{ data: [dKda, dVis, dDmg, dGold, dCs],backgroundColor: 'rgba(200, 155, 60, .3)',borderColor: 'var(--panel-dyn, #c89b3c)',pointBackgroundColor: '#fff',borderWidth: 2 }] },
                options: {responsive: true, maintainAspectRatio: false, scales: {r: {angleLines: {color: 'rgba(255, 255, 255, .08)'},grid: {color: 'rgba(255, 255, 255, .08)'},pointLabels: {font: {size: 9}},ticks: {display: false,max: 100,min: 0}}}, plugins: {legend: {display: false}}}
            });
        }

        var cvLine = document.getElementById('lpChart');
        if (cvLine) {
            if (lineChartInst) lineChartInst.destroy();
            var accumulated = 0;
            var lineData = [0, ...lpTimeline.map(function(v) { return accumulated += v; })];
            lineChartInst = new Chart(cvLine.getContext('2d'), {
                type: 'line',
                data: {labels: Array(lineData.length).fill(''), datasets: [{data: lineData, borderColor: '#10b981', backgroundColor: 'rgba(16, 185, 129, 0.1)', tension: 0.4, fill: true, pointRadius: 3, pointBackgroundColor: '#fff'}]},
                options: {responsive: true, maintainAspectRatio: false, scales: {y: {grid: {color: 'rgba(255, 255, 255, .05)'}},x: {display: false}}, plugins: {legend: {display: false}}}
            });
        }
    }, 300);
}

// ── 11. COMPARADOR FRENTE A FRENTE ────────────
function abrirModalComparar() {
    var p1 = document.getElementById('p1-select');
    var p2 = document.getElementById('p2-select');
    var opts = '<option value="">— Seleccionar —</option>';

    datosGlobal.filter(function(j) { return !j.error && j.tier !== 'UNRANKED'; }).sort(function(a, b) { return a.nombre.localeCompare(b.nombre); }).forEach(function(j) {
        opts += `<option value="${j.nombre}">${j.nombre}</option>`;
    });

    p1.innerHTML = opts; p2.innerHTML = opts;
    document.getElementById('modal-comparar').style.display = 'flex';
    document.getElementById('compare-box-main').classList.remove('active');
    document.getElementById('lightning-effect').style.display = 'none';
}

function cerrarModalComparar() {
    document.getElementById('modal-comparar').style.display = 'none';
    document.getElementById('compare-results').innerHTML = '';
    document.getElementById('compare-radar-container').style.display = 'none';
    document.getElementById('split-bg-p1').style.backgroundImage = 'none';
    document.getElementById('split-bg-p2').style.backgroundImage = 'none';
}

function closeModalOutside(e, id) {
    if (e.target.id === id) { document.getElementById(id).style.display = 'none'; if (id === 'modal-comparar') { cerrarModalComparar(); } }
}

function obtenerMainChamp(nombre) {
    var matches = cacheHistorial[nombre];
    if (!matches) return 'Aatrox';
    var cs = {};
    matches.forEach(function(m) {
        var jug = datosGlobal.find(function(j) { return j.nombre === nombre; });
        if (!jug) return;
        var me = m.info?.participants?.find(function(p) { return p.puuid === jug.puuid; });
        if (me) cs[me.championId] = (cs[me.championId] || 0) + 1;
    });
    var sortedCs = Object.entries(cs).sort(function(a, b) { return b[1] - a[1]; });
    var topId = sortedCs[0]?.[0];
    return champByKey[parseInt(topId)]?.id || 'Aatrox';
}

function ejecutarComparacion() {
    var n1 = document.getElementById('p1-select').value;
    var n2 = document.getElementById('p2-select').value;
    var res = document.getElementById('compare-results');

    if (!n1 || !n2 || n1 === n2) {
        res.innerHTML = `<div style="color:var(--loss-color);width:100%;text-align:center;padding:20px;">Selecciona dos jugadores distintos.</div>`;
        return;
    }

    var j1 = datosGlobal.find(function(j) { return j.nombre === n1; });
    var j2 = datosGlobal.find(function(j) { return j.nombre === n2; });

    document.getElementById('compare-box-main').classList.add('active');
    document.getElementById('split-bg-p1').style.backgroundImage = `url('https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${obtenerMainChamp(n1)}_0.jpg')`;
    document.getElementById('split-bg-p2').style.backgroundImage = `url('https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${obtenerMainChamp(n2)}_0.jpg')`;
    document.getElementById('lightning-effect').style.display = 'block';

    var wr1 = Math.round((j1.victorias / (j1.victorias + j1.derrotas)) * 100);
    var wr2 = Math.round((j2.victorias / (j2.victorias + j2.derrotas)) * 100);
    var nti1 = calcNTIScore(j1);
    var nti2 = calcNTIScore(j2);

    var mkBar = function(v1, v2, label) {
        var max = Math.max(v1, v2, 1);
        var pct1 = Math.round((v1 / max) * 100);
        var pct2 = Math.round((v2 / max) * 100);
        return `
        <div class="comp-stat-bar-row">
            <div class="comp-stat-label">${label}</div>
            <div style="display:flex;gap:8px;align-items:center;">
                <span style="min-width:35px;text-align:right;font-weight:900;color:var(--text-main);font-size:.88rem;">${v1}</span>
                <div class="comp-bar-track" style="flex:1;">
                    <div class="comp-bar-fill" style="width:${pct1}%;background:${v1 >= v2 ? 'var(--gold-accent)' : 'rgba(100, 116, 139, .5)'}"></div>
                </div>
                <div class="comp-bar-track" style="flex:1;">
                    <div class="comp-bar-fill" style="width:${pct2}%;background:${v2 >= v1 ? 'var(--gold-accent)' : 'rgba(100, 116, 139, .5)'}"></div>
                </div>
                <span style="min-width:35px;font-weight:900;color:var(--text-main);font-size:.88rem;">${v2}</span>
            </div>
        </div>`;
    };

    res.innerHTML = `
    <div class="comp-col">
        <div class="comp-header">
            <img class="comp-avatar" src="https://ddragon.leagueoflegends.com/cdn/${versionDD}/img/profileicon/${j1.icono}.png">
            <div><span class="comp-name">${j1.nombre}</span>${nti1 > nti2 ? '<span class="comp-winner-badge">🏆 GANA</span>' : ''}</div>
        </div>
        ${mkBar(j1.puntos, j2.puntos, 'LP')}
        ${mkBar(wr1, wr2, 'Winrate %')}
        ${mkBar(nti1, nti2, 'NTI Score')}
        ${mkBar(j1.victorias, j2.victorias, 'Victorias')}
        ${mkBar(j1.derrotas, j2.derrotas, 'Derrotas')}
    </div>
    <div class="comp-col">
        <div class="comp-header">
            <img class="comp-avatar" src="https://ddragon.leagueoflegends.com/cdn/${versionDD}/img/profileicon/${j2.icono}.png">
            <div><span class="comp-name">${j2.nombre}</span>${nti2 > nti1 ? '<span class="comp-winner-badge">🏆 GANA</span>' : ''}</div>
        </div>
        <div class="comp-stat-row">Rango: <span class="comp-stat-val" style="color:var(--gold-main)">${j2.tier} ${j2.rango}</span></div>
        <div class="comp-stat-row">LP: <span class="comp-stat-val">${j2.puntos}</span></div>
        <div class="comp-stat-row">Winrate: <span class="comp-stat-val">${wr2}%</span></div>
        <div class="comp-stat-row">NTI Score: <span class="comp-stat-val" style="color:${ntiScoreColor(nti2)}">${nti2}</span></div>
        <div class="comp-stat-row">V/D: <span class="comp-stat-val"><span style="color:var(--win-color)">${j2.victorias}V</span> / <span style="color:var(--loss-color)">${j2.derrotas}D</span></span></div>
    </div>`;

    document.getElementById('compare-radar-container').style.display = 'block';
    setTimeout(function() {
        var cvComp = document.getElementById('compRadar');
        if (compRadarInst) compRadarInst.destroy();
        compRadarInst = new Chart(cvComp.getContext('2d'), {
            type: 'radar',
            data: { labels: ['Winrate', 'Partidas', 'NTI Score', 'Victorias'], datasets: [ {label: j1.nombre, data: [wr1, j1.victorias + j1.derrotas, nti1, j1.victorias], borderColor: '#3b82f6', backgroundColor: 'rgba(59, 130, 246, 0.3)', borderWidth: 2}, {label: j2.nombre, data: [wr2, j2.victorias + j2.derrotas, nti2, j2.victorias], borderColor: '#ef4444', backgroundColor: 'rgba(239, 68, 68, 0.3)', borderWidth: 2} ] },
            options: {responsive: true, maintainAspectRatio: false, scales: {r: {angleLines: {color: 'rgba(255, 255, 255, .08)'},grid: {color: 'rgba(255, 255, 255, .08)'},pointLabels: {font: {size: 11}}}}, plugins: {legend: {position: 'bottom', labels: {color: '#fff'}}}}
        });
    }, 100);
}

// ── 12. UTILIDADES GLOBALES ───────────────────────────────────
function statKeyToES(key) {
    var m = {FlatMagicDamageMod: 'PA',FlatPhysicalDamageMod: 'AD',FlatArmorMod: 'Armadura',FlatSpellBlockMod: 'Res. Mágica',FlatCritChanceMod: 'Crítico',PercentAttackSpeedMod: 'Vel. Ataque',FlatHPPoolMod: 'HP',FlatMPPoolMod: 'Maná',FlatMovementSpeedMod: 'Vel. Mov.'};
    return m[key] || key.replace(/([A-Z])/g, ' $1').trim();
}

function formatDuration(s) {
    return Math.floor(s / 60) + ':' + (s % 60).toString().padStart(2, '0');
}

function timeAgo(ts) {
    var m = Math.floor((Date.now() - ts) / 60000);
    if (m < 60) return `Hace ${m}m`;
    var h = Math.floor(m / 60);
    if (h < 24) return `Hace ${h}h`;
    return `Hace ${Math.floor(h / 24)}d`;
}

function actualizarTimer() {
    if (!ultimaActualizacion) return;
    var d = Math.floor((Date.now() - ultimaActualizacion) / 60000);
    var el = document.getElementById('ultima-actualizacion');
    if (el) el.textContent = d === 0 ? 'Actualizado ahora' : `Hace ${d} min`;
}

function iniciarTimer() {
    setInterval(actualizarTimer, 30000);
    setInterval(function() { if (!cargando) obtenerDatos(); }, 15 * 60 * 1000);
}


function cambiarTab(t) {
    tabActiva = t;
    document.querySelectorAll('.tab').forEach(function(x) { x.classList.remove('activo-tab'); });
    document.getElementById('tab-' + t).classList.add('activo-tab');
    cerrarPanel();
    renderHeroSection();
    renderTabla();
}

function sortBy(campo) {
    sortEstado.dir = (sortEstado.campo === campo && sortEstado.dir === 'desc') ? 'asc' : 'desc';
    sortEstado.campo = campo;
    renderTabla();
}

// ── 13. INICIO (ARRANQUE DEL PROGRAMA) ────────────────────────

// ── FETCH JUGADOR ─────────────────────────────────────────────
async function fetchJugador(jug) {
    var dataAcc = await fetchRiot(r_americas, 'riot/account/v1/accounts/by-riot-id/' + encodeURIComponent(jug.name) + '/' + jug.tag);
    // Medianoche LAN (UTC-5) para contar partidas del día correctamente
    var LAN_OFFSET_MS = 5 * 60 * 60 * 1000;
    var nowLAN = new Date(Date.now() - LAN_OFFSET_MS);
    var midnightLAN = new Date(Date.UTC(nowLAN.getUTCFullYear(), nowLAN.getUTCMonth(), nowLAN.getUTCDate(), 0, 0, 0, 0));
    var startOfToday = Math.floor((midnightLAN.getTime() + LAN_OFFSET_MS) / 1000);
    var [resSum, resLea, resMatchHoy, resSpec] = await Promise.all([
        fetchRiot(region,     'lol/summoner/v4/summoners/by-puuid/'  + dataAcc.puuid),
        fetchRiot(region,     'lol/league/v4/entries/by-puuid/'      + dataAcc.puuid),
        fetchRiot(r_americas, 'lol/match/v5/matches/by-puuid/' + dataAcc.puuid + '/ids?startTime=' + startOfToday + '&queue=420&count=100').catch(function(){ return []; }),
        fetchRiot(region,     'lol/spectator/v5/active-games/by-puuid/' + dataAcc.puuid).catch(function(){ return null; })
    ]);
    var stats = resLea.find(function(e){ return e.queueType === 'RANKED_SOLO_5x5'; }) || { tier:'UNRANKED', rank:'', leaguePoints:0, wins:0, losses:0 };
    saveLPSnapshot(jug.name, stats.leaguePoints, stats.tier);
    var liveChampId = null;
    if (resSpec && resSpec.gameQueueConfigId === 420) {
        var meSpec = resSpec.participants ? resSpec.participants.find(function(p){ return p.puuid === dataAcc.puuid; }) : null;
        if (meSpec) liveChampId = meSpec.championId;
    }
    return {
        nombre: jug.name, division: jug.division, puuid: dataAcc.puuid, icono: resSum.profileIconId,
        tier: stats.tier, rango: stats.rank, puntos: stats.leaguePoints, victorias: stats.wins, derrotas: stats.losses,
        valorT: valoresTier[stats.tier] !== undefined ? valoresTier[stats.tier] : -1,
        partidasHoy: Array.isArray(resMatchHoy) ? resMatchHoy.length : 0,
        isInGame: !!(resSpec && resSpec.gameQueueConfigId === 420),
        liveChampId: liveChampId,
        gameStartTime: (resSpec && resSpec.gameStartTime) ? resSpec.gameStartTime : 0
    };
}


// ── HALL OF FAME ──────────────────────────────────────────────
async function cargarHallOfFame() {
    var hof = document.getElementById('hof-section');
    if (!hof) return;
    try {
        var res = await fetch('/api/hall-of-fame');
        var data = await res.json();
        if (!data || !data.length) { hof.innerHTML = ''; return; }
        var html = '<div class="hof-title">🏅 CUADRO DE HONOR MENSUAL</div><div class="hof-cards">';
        data.forEach(function(entry, idx) {
            var medal = ['🥇','🥈','🥉'][idx] || '🏅';
            html += '<div class="hof-card" data-tilt data-tilt-max="12" data-tilt-glare data-tilt-max-glare="0.2">' +
                '<div class="hof-medal">' + medal + '</div>' +
                '<div class="hof-mes">' + (entry.mes || '') + '</div>' +
                '<img class="hof-avatar" src="https://ddragon.leagueoflegends.com/cdn/14.24.1/img/profileicon/' + (entry.icono||0) + '.png" onerror="this.src=&quot;https://ddragon.leagueoflegends.com/cdn/14.24.1/img/profileicon/29.png&quot;">' +
                '<div class="hof-nombre">' + (entry.nombre||'?') + '</div>' +
                '<div class="hof-stats">' + (entry.tier||'') + ' ' + (entry.rango||'') + ' · ' + (entry.puntos||0) + ' LP</div>' +
                '</div>';
        });
        html += '</div>';
        hof.innerHTML = html;
        try { VanillaTilt.init(hof.querySelectorAll('[data-tilt]'), {max:12,speed:300,glare:true,'max-glare':.2}); } catch(e) {}
    } catch(e) { document.getElementById('hof-section').innerHTML = ''; }
}

// ── BADGES DE LOGROS VISUALES (calculados en renderTabla) ─────
function getBadgesAdicionales(jug) {
    var extra = '';
    var matches = cacheHistorial[jug.nombre];
    if (!matches || !matches.length) return extra;
    
    // Farmer King: CS promedio > 8/min
    var csTotal = 0, csPartidas = 0;
    // Vision Eagle: visionScore más alto del equipo en la sesión
    var visTotal = 0, visPartidas = 0;
    // Iron Heart: racha de derrotas (ya manejado, pero aquí lo hacemos visual distinto)
    
    matches.forEach(function(m) {
        var me = m.info?.participants?.find(function(p){ return p.puuid === jug.puuid; });
        if (!me) return;
        var dur = (m.info.gameDuration || 1) / 60;
        csTotal  += ((me.totalMinionsKilled||0) + (me.neutralMinionsKilled||0)) / dur;
        visTotal += (me.visionScore||0);
        csPartidas++; visPartidas++;
    });
    
    if (csPartidas > 0) {
        if (csTotal / csPartidas >= 8.0)  extra += '<span class="ach-badge ach-gold"   title="Farmer King: CS/min promedio ≥ 8.0">🌾</span>';
        if (visTotal / visPartidas >= 30) extra += '<span class="ach-badge ach-blue"   title="Visión de Águila: Vision Score promedio ≥ 30">👁️</span>';
    }
    return extra;
}

async function initStaticData() {
    try {
        var r = await fetch('https://ddragon.leagueoflegends.com/api/versions.json');
        versionDD = (await r.json())[0];

        var [champs, items] = await Promise.all([
            fetch(`https://ddragon.leagueoflegends.com/cdn/${versionDD}/data/en_US/champion.json`).then(function(r) { return r.json(); }),
            fetch(`https://ddragon.leagueoflegends.com/cdn/${versionDD}/data/es_MX/item.json`).then(function(r) { return r.json(); })
        ]);

        for (const [id, c] of Object.entries(champs.data)) { champByKey[parseInt(c.key)] = {name: c.name,id}; }
        itemById = items.data;

        var perks = await fetch('https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/perks.json').then(function(r) { return r.json(); });
        for (var i = 0; i < perks.length; i++) {
            var p = perks[i];
            if (p.iconPath) { perkById[p.id] = { name: p.name,url: `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default${p.iconPath.toLowerCase().replace('/lol-game-data/assets', '')}` }; }
        }
    } catch (e) {}
}

initStaticData().then(function() {
    initParticles();
    // Cutoffs se cargan INMEDIATAMENTE en paralelo, sin esperar jugadores
    cargarCutoffsLigas();
    obtenerDatos();
    iniciarTimer();
});

// ── HERO SECTION ──────────────────────────────────────────────
async function renderHeroSection() {
    var hero = document.getElementById('hero-section'); if (!hero) return;
    hero.innerHTML = '';
    var validos = datosGlobal.filter(function(j){ return !j.error && j.tier !== 'UNRANKED'; });
    if (tabActiva !== 'all') validos = validos.filter(function(j){ return j.division === tabActiva; });
    if (validos.length < 2) return;

    var mvp = validos.reduce(function(mx,j){ return (getLPDelta(j.nombre)||0) > (getLPDelta(mx.nombre)||0) ? j : mx; }, validos[0]);
    var mvpChamp = 'Aatrox';
    try {
        var mvpM = await fetchRiot(region, 'lol/champion-mastery/v4/champion-masteries/by-puuid/' + mvp.puuid + '/top?count=1');
        if (mvpM[0]) mvpChamp = champByKey[mvpM[0].championId] ? champByKey[mvpM[0].championId].id : 'Aatrox';
    } catch(e) {}

    var r1=null, r2=null, minDiff=9999;
    for (var i=0;i<validos.length;i++) for (var j=i+1;j<validos.length;j++) {
        var diff=Math.abs(validos[i].puntos-validos[j].puntos);
        if(validos[i].tier===validos[j].tier&&diff>0&&diff<=50&&diff<minDiff){minDiff=diff;r1=validos[i];r2=validos[j];}
    }

    var h = '<div class="hero-card">' +
        '<div class="hero-bg-layer" style="background-image:url(\'https://ddragon.leagueoflegends.com/cdn/img/champion/splash/'+mvpChamp+'_0.jpg\');"></div>' +
        '<div class="hero-content">' +
        '<span class="mvp-badge">👑 MVP de la Semana</span>' +
        '<div class="mvp-player"><img class="mvp-avatar" src="https://ddragon.leagueoflegends.com/cdn/'+versionDD+'/img/profileicon/'+mvp.icono+'.png">' +
        '<div class="mvp-info"><h3>'+mvp.nombre+'</h3><div class="mvp-stats">+'+(getLPDelta(mvp.nombre)||0)+' LP HOY · '+mvp.tier+' '+mvp.rango+'</div></div></div>' +
        '</div></div>';

    if (r1 && r2) {
        var c1='Yasuo', c2='Yone';
        try {
            var m1 = await fetchRiot(region, 'lol/champion-mastery/v4/champion-masteries/by-puuid/'+r1.puuid+'/top?count=1');
            var m2 = await fetchRiot(region, 'lol/champion-mastery/v4/champion-masteries/by-puuid/'+r2.puuid+'/top?count=1');
            if(m1[0] && champByKey[m1[0].championId]) c1=champByKey[m1[0].championId].id;
            if(m2[0] && champByKey[m2[0].championId]) c2=champByKey[m2[0].championId].id;
        } catch(e){}
        h += '<div class="hero-card" style="padding:0;justify-content:center;">' +
            '<div class="split-left" style="background-image:url(\'https://ddragon.leagueoflegends.com/cdn/img/champion/splash/'+c1+'_0.jpg\');"></div>' +
            '<div class="split-divider"></div>' +
            '<div class="split-right" style="background-image:url(\'https://ddragon.leagueoflegends.com/cdn/img/champion/splash/'+c2+'_0.jpg\');"></div>' +
            '<div class="hero-content" style="text-align:center;padding:20px;">' +
            '<span class="bounty-badge">⚔️ Match of the Week</span>' +
            '<div class="bounty-players">' +
            '<div style="display:flex;flex-direction:column;align-items:center;gap:5px;"><img class="bounty-avatar" src="https://ddragon.leagueoflegends.com/cdn/'+versionDD+'/img/profileicon/'+r1.icono+'.png"><span class="bounty-name">'+r1.nombre+'</span></div>' +
            '<div class="bounty-vs">VS</div>' +
            '<div style="display:flex;flex-direction:column;align-items:center;gap:5px;"><img class="bounty-avatar" src="https://ddragon.leagueoflegends.com/cdn/'+versionDD+'/img/profileicon/'+r2.icono+'.png"><span class="bounty-name">'+r2.nombre+'</span></div>' +
            '</div><div class="bounty-diff">¡Separados por solo '+minDiff+' LP!</div></div></div>';
    }
    hero.innerHTML = h;
}

// ── PIN ─────────────────────────────────────────────────
function togglePin(nombre, e) {
    e.stopPropagation();
    pinnedPlayer = pinnedPlayer===nombre ? null : nombre;
    pinnedPlayer ? localStorage.setItem('nti_pinned',nombre) : localStorage.removeItem('nti_pinned');
    renderTabla();
}

// ── GAMING HOUSE ──────────────────────────────────────────────
var autoScrollInterval;
function toggleGamingHouse() {
    document.body.classList.toggle('gaming-house-mode');
    var exitBtn=document.getElementById('exit-tv-btn');
    if(document.body.classList.contains('gaming-house-mode')){
        if(exitBtn) exitBtn.style.display='block';
        var el=document.documentElement;
        if(el.requestFullscreen) el.requestFullscreen();
        else if(el.webkitRequestFullscreen) el.webkitRequestFullscreen();
        autoScrollInterval=setInterval(function(){
            var tw=document.querySelector('.table-wrapper');
            if(!tw) return;
            tw.scrollBy(0,1);
            if(tw.scrollTop+window.innerHeight>=tw.scrollHeight) tw.scrollTo(0,0);
        },50);
    } else {
        if(exitBtn) exitBtn.style.display='none';
        if(document.exitFullscreen) document.exitFullscreen();
        clearInterval(autoScrollInterval);
    }
}

// ── SHARE CARD ────────────────────────────────────────────────
function loadImg(src) {
    return new Promise(function(res,rej){ var i=new Image(); i.crossOrigin='anonymous'; i.onload=function(){ res(i); }; i.onerror=function(){ rej(); }; i.src=src; });
}
async function generateShareCard(nombre) {
    var jug=datosGlobal.find(function(j){ return j.nombre===nombre; }); if(!jug) return;
    showToast('📸 Generando Player Card...');
    var W=640,H=360,cnv=document.createElement('canvas'); cnv.width=W; cnv.height=H;
    var ctx=cnv.getContext('2d');
    ctx.fillStyle='#050b14'; ctx.fillRect(0,0,W,H);
    var matches=cacheHistorial[nombre];
    if(matches&&matches.length){
        var cs={}; matches.forEach(function(m){ var me=m.info.participants.find(function(p){ return p.puuid===jug.puuid; }); if(me) cs[me.championId]=(cs[me.championId]||0)+1; });
        var topId=Object.entries(cs).sort(function(a,b){ return b[1]-a[1]; })[0];
        if(topId){ var cid=champByKey[parseInt(topId[0])]; if(cid) try{ var img=await loadImg('https://ddragon.leagueoflegends.com/cdn/img/champion/splash/'+cid.id+'_0.jpg'); ctx.globalAlpha=.18; ctx.drawImage(img,0,0,W,H); ctx.globalAlpha=1; }catch(e){} }
    }
    var gr=ctx.createLinearGradient(0,0,W,0); gr.addColorStop(0,'rgba(5,11,20,.97)'); gr.addColorStop(.6,'rgba(5,11,20,.8)'); gr.addColorStop(1,'rgba(5,11,20,.5)'); ctx.fillStyle=gr; ctx.fillRect(0,0,W,H);
    ctx.strokeStyle='#c89b3c'; ctx.lineWidth=3; ctx.strokeRect(2,2,636,356); ctx.fillStyle='#c89b3c'; ctx.fillRect(2,2,4,356);
    ctx.textAlign='right'; ctx.font='bold 12px Segoe UI'; ctx.fillStyle='#c89b3c'; ctx.fillText('NTI ESPORTS',628,26);
    try{ var av=await loadImg('https://ddragon.leagueoflegends.com/cdn/'+versionDD+'/img/profileicon/'+jug.icono+'.png'); ctx.save(); ctx.beginPath(); ctx.arc(76,86,52,0,Math.PI*2); ctx.clip(); ctx.drawImage(av,24,34,104,104); ctx.restore(); ctx.strokeStyle='#c89b3c'; ctx.lineWidth=2.5; ctx.beginPath(); ctx.arc(76,86,52,0,Math.PI*2); ctx.stroke(); }catch(e){}
    var tc={'challenger':'#f4c874','grandmaster':'#cd4545','master':'#a855f7','diamond':'#3b82f6','emerald':'#10b981','platinum':'#06b6d4','gold':'#eab308','silver':'#94a3b8','bronze':'#b45309','iron':'#78716c','unranked':'#a09b8c'};
    ctx.textAlign='left'; ctx.font='bold 26px Segoe UI'; ctx.fillStyle='#ff8c00'; ctx.fillText(jug.nombre,190,60);
    ctx.font='bold 14px Segoe UI'; ctx.fillStyle=tc[jug.tier.toLowerCase()]||'#f0e6d2'; ctx.fillText(jug.tier+' '+jug.rango+' — '+jug.puntos+' LP',190,82);
    var tot=jug.victorias+jug.derrotas,wr=tot>0?Math.round((jug.victorias/tot)*100):0,ntiS=calcNTIScore(jug);
    [{l:'PARTIDAS',v:''+tot,c:'#f0e6d2'},{l:'WINRATE',v:wr+'%',c:wr>=50?'#10b981':'#ef4444'},{l:'NTI SCORE',v:''+ntiS,c:ntiScoreColor(ntiS)}].forEach(function(st,idx){ var x=148+idx*155; ctx.font='bold 24px Segoe UI'; ctx.fillStyle=st.c; ctx.fillText(st.v,x,132); ctx.font='9px Segoe UI'; ctx.fillStyle='#6b7280'; ctx.fillText(st.l,x,148); });
    var link=document.createElement('a'); link.download=nombre.replace(/\s/g,'_')+'_NTI_Card.png'; link.href=cnv.toDataURL('image/png'); link.click();
    showToast('✅ ¡Player Card descargada!','win');
}