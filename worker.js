/**
 * ============================================================================
 *  RADAR CATALUNYA · Worker de archivado a GitHub
 * ============================================================================
 * Se ejecuta cada vez que recibe una petición HTTP (GET). Debe dispararse
 * cada 4 minutos mediante un servicio externo gratuito como cron-job.org
 * apuntando a la URL pública de este Worker.
 *
 * Qué hace en cada ejecución:
 *   1. Busca el fotograma de lluvia más reciente que Meteocat tenga publicado.
 *   2. Si ya está archivado en GitHub, no hace nada (evita duplicados).
 *   3. Si no, descarga las teselas (256x256) que cubren Catalunya a ese
 *      instante y las sube tal cual (sin recomprimir) al repositorio,
 *      junto con una entrada nueva en archive/index.json.
 *   4. Purga del repositorio (y del índice) los fotogramas de más de 7 días.
 *
 * Usa la Git Data API (blobs + tree + commit) para que TODO el trabajo de
 * cada ejecución quede en UN SOLO commit, en vez de un commit por archivo.
 *
 * ---------------------------------------------------------------------------
 *  CONFIGURACIÓN NECESARIA (Worker → Settings → Variables and Secrets)
 * ---------------------------------------------------------------------------
 *  GITHUB_TOKEN   (secret) → Personal Access Token (fine-grained) con permiso
 *                             "Contents: Read and write" SOLO sobre el repo
 *                             del radar. Nunca lo pongas en el HTML/JS.
 *  GITHUB_OWNER   (var)    → tu usuario u organización de GitHub
 *  GITHUB_REPO    (var)    → nombre del repositorio (el de GitHub Pages)
 *  GITHUB_BRANCH  (var)    → normalmente "main"
 *  ARCHIVE_SECRET (secret, opcional) → si la defines, el Worker exige
 *                             ?key=ESE_VALOR en la URL para ejecutarse, así
 *                             nadie más puede disparar tus commits a lo tonto.
 * ---------------------------------------------------------------------------
 */

const CONFIG = {
    INTERVAL_MINUTES: 6, // cadencia real de publicación del radar de Meteocat
    RAIN_URL_TEMPLATE:
        'https://static-m.meteo.cat/tiles/radar/{any}/{mes}/{dia}/{hora}/{minut}/{z}/000/000/{x}/000/000/{y}.png',
    Z: 7, // mismo zoom que usa el front-end para los cálculos de acumulación (PRECIP_ZOOM)
    // Bounding box de Catalunya (el mismo fallback que usa el front-end: getAccumBbox())
    BBOX: { north: 42.95, south: 40.45, west: 0.05, east: 3.45 },
    MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000, // 1 semana
    INDEX_PATH: 'archive/index.json',
    FRAMES_PATH: 'archive/frames'
};

function pad(v, len) {
    return String(v).padStart(len, '0');
}

function formatUrl(template, date) {
    return template
        .replace('{any}', date.getUTCFullYear())
        .replace('{mes}', pad(date.getUTCMonth() + 1, 2))
        .replace('{dia}', pad(date.getUTCDate(), 2))
        .replace('{hora}', pad(date.getUTCHours(), 2))
        .replace('{minut}', pad(date.getUTCMinutes(), 2));
}
// NOTA: Meteocat publica las horas en UTC igual que el resto de servicios
// de teselas tipo XYZ; si detectas un desfase horario respecto al front-end,
// revisa cómo construye las fechas `roundToInterval()` en el HTML (usa hora
// local del navegador) y ajusta aquí en consecuencia.

function roundDownToInterval(date, minutes) {
    const ms = minutes * 60000;
    return new Date(Math.floor(date.getTime() / ms) * ms);
}

function lonLatToTileFrac(lat, lon, z) {
    const n = Math.pow(2, z);
    const x = ((lon + 180) / 360) * n;
    const latRad = (lat * Math.PI) / 180;
    const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
    return { x, y, n };
}

function buildTileUrl(date, tx, ytileTms, z) {
    let url = formatUrl(CONFIG.RAIN_URL_TEMPLATE, date);
    url = url.replace('{z}', pad(z, 2)).replace('{x}', pad(tx, 3)).replace('{y}', pad(ytileTms, 3));
    return url;
}

async function tileExists(url) {
    try {
        const res = await fetch(url, { method: 'GET', cf: { cacheTtl: 0 } });
        if (!res.ok) return null;
        const buf = await res.arrayBuffer();
        if (!buf || buf.byteLength < 50) return null; // descarta respuestas vacías/placeholder
        return buf;
    } catch (err) {
        return null;
    }
}

// Busca, entre los últimos candidatos posibles (cada 6 min), el más reciente
// que Meteocat ya tenga publicado. Usa una tesela de prueba central.
async function findLatestAvailable(now) {
    const start = roundDownToInterval(now, CONFIG.INTERVAL_MINUTES);
    for (let i = 0; i < 6; i++) {
        const candidate = new Date(start.getTime() - i * CONFIG.INTERVAL_MINUTES * 60000);
        const testUrl = buildTileUrl(candidate, 64, 80, 7); // misma tesela de prueba que usa el front-end (z=07 x=064 y=080)
        const buf = await tileExists(testUrl);
        if (buf) return candidate;
    }
    return null;
}

function tileGridForBbox() {
    const z = CONFIG.Z;
    const nw = lonLatToTileFrac(CONFIG.BBOX.north, CONFIG.BBOX.west, z);
    const se = lonLatToTileFrac(CONFIG.BBOX.south, CONFIG.BBOX.east, z);
    const n = nw.n;
    const xtileMin = Math.floor(nw.x);
    const xtileMax = Math.floor(se.x);
    const ytileMin = Math.floor(nw.y);
    const ytileMax = Math.floor(se.y);
    return {
        z, n, xtileMin, xtileMax, ytileMin, ytileMax,
        tilesX: xtileMax - xtileMin + 1,
        tilesY: ytileMax - ytileMin + 1
    };
}

// ---------------------------------------------------------------------------
// GitHub Git Data API — helpers
// ---------------------------------------------------------------------------

function ghHeaders(token) {
    return {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'radar-catalunya-worker',
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
    };
}

function arrayBufferToBase64(buf) {
    let binary = '';
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

async function ghJson(url, token, options) {
    const res = await fetch(url, { ...options, headers: { ...ghHeaders(token), ...(options && options.headers) } });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`GitHub API ${res.status} ${url}: ${text.slice(0, 300)}`);
    }
    return res.json();
}

async function getFileJson(owner, repo, branch, path, token) {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
    try {
        const res = await fetch(url, { headers: ghHeaders(token) });
        if (res.status === 404) return { content: null, sha: null };
        if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
        const data = await res.json();
        const decoded = decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))));
        return { content: JSON.parse(decoded), sha: data.sha };
    } catch (err) {
        console.error('getFileJson', path, err);
        return { content: null, sha: null };
    }
}

async function getRef(owner, repo, branch, token) {
    return ghJson(`https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${branch}`, token);
}

async function createBlob(owner, repo, token, base64Content) {
    const data = await ghJson(`https://api.github.com/repos/${owner}/${repo}/git/blobs`, token, {
        method: 'POST',
        body: JSON.stringify({ content: base64Content, encoding: 'base64' })
    });
    return data.sha;
}

async function createTree(owner, repo, token, baseTreeSha, treeItems) {
    const data = await ghJson(`https://api.github.com/repos/${owner}/${repo}/git/trees`, token, {
        method: 'POST',
        body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems })
    });
    return data.sha;
}

async function createCommit(owner, repo, token, message, treeSha, parentSha) {
    const data = await ghJson(`https://api.github.com/repos/${owner}/${repo}/git/commits`, token, {
        method: 'POST',
        body: JSON.stringify({ message, tree: treeSha, parents: [parentSha] })
    });
    return data.sha;
}

async function updateRef(owner, repo, branch, token, commitSha) {
    return ghJson(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ sha: commitSha, force: false })
    });
}

// ---------------------------------------------------------------------------
// Lógica principal
// ---------------------------------------------------------------------------

async function run(env) {
    const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH } = env;
    if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
        throw new Error('Faltan variables de configuración (GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO)');
    }
    const branch = GITHUB_BRANCH || 'main';

    const now = new Date();
    const latest = await findLatestAvailable(now);
    if (!latest) {
        return { ok: true, skipped: 'no-radar-frame-available' };
    }
    const ts = latest.getTime();

    // 1) índice actual
    const { content: indexList0, sha: indexSha } = await getFileJson(
        GITHUB_OWNER, GITHUB_REPO, branch, CONFIG.INDEX_PATH, GITHUB_TOKEN
    );
    const indexList = Array.isArray(indexList0) ? indexList0 : [];

    const alreadyArchived = indexList.some((e) => e.ts === ts);

    // 2) purgar entradas caducadas (> 7 días)
    const cutoff = now.getTime() - CONFIG.MAX_AGE_MS;
    const keep = [];
    const expired = [];
    indexList.forEach((e) => (e.ts < cutoff ? expired.push(e) : keep.push(e)));

    if (alreadyArchived && expired.length === 0) {
        return { ok: true, skipped: 'already-archived', ts };
    }

    // 3) si toca archivar un fotograma nuevo, descargamos sus teselas
    let grid = null;
    const tileBlobs = []; // { path, buf }
    if (!alreadyArchived) {
        grid = tileGridForBbox();
        const jobs = [];
        for (let tx = grid.xtileMin; tx <= grid.xtileMax; tx++) {
            for (let ty = grid.ytileMin; ty <= grid.ytileMax; ty++) {
                const ytileTms = grid.n - 1 - ty;
                jobs.push(
                    tileExists(buildTileUrl(latest, tx, ytileTms, grid.z)).then((buf) => {
                        if (buf) tileBlobs.push({ tx, ty, buf });
                    })
                );
            }
        }
        await Promise.all(jobs);
        if (tileBlobs.length === 0) {
            return { ok: true, skipped: 'no-tiles-loaded', ts };
        }
    }

    // 4) construir un único commit: blobs de teselas nuevas + index.json actualizado
    //    + eliminación de las carpetas de fotogramas caducados.
    const ref = await getRef(GITHUB_OWNER, GITHUB_REPO, branch, GITHUB_TOKEN);
    const baseCommitSha = ref.object.sha;
    const baseCommit = await ghJson(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/commits/${baseCommitSha}`,
        GITHUB_TOKEN
    );
    const baseTreeSha = baseCommit.tree.sha;

    const treeItems = [];

    if (!alreadyArchived) {
        for (const t of tileBlobs) {
            const base64 = arrayBufferToBase64(t.buf);
            const blobSha = await createBlob(GITHUB_OWNER, GITHUB_REPO, GITHUB_TOKEN, base64);
            treeItems.push({
                path: `${CONFIG.FRAMES_PATH}/${ts}/t${t.tx}_${t.ty}.png`,
                mode: '100644',
                type: 'blob',
                sha: blobSha
            });
        }
        keep.push({
            ts,
            z: grid.z,
            n: grid.n,
            xtileMin: grid.xtileMin,
            ytileMin: grid.ytileMin,
            tilesX: grid.tilesX,
            tilesY: grid.tilesY
        });
        keep.sort((a, b) => a.ts - b.ts);
    }

    // borrar del árbol las carpetas de fotogramas caducados (sha: null = eliminar)
    for (const e of expired) {
        // Necesitamos listar los archivos existentes en esa carpeta para poder borrarlos
        // uno a uno (la Git Trees API no soporta borrar una carpeta entera de golpe).
        const folder = `${CONFIG.FRAMES_PATH}/${e.ts}`;
        const listing = await fetch(
            `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${folder}?ref=${branch}`,
            { headers: ghHeaders(GITHUB_TOKEN) }
        );
        if (listing.ok) {
            const files = await listing.json();
            if (Array.isArray(files)) {
                files.forEach((f) => treeItems.push({ path: f.path, mode: '100644', type: 'blob', sha: null }));
            }
        }
    }

    // index.json actualizado
    const indexContent = JSON.stringify(keep);
    const indexBlobSha = await createBlob(
        GITHUB_OWNER, GITHUB_REPO, GITHUB_TOKEN,
        btoa(unescape(encodeURIComponent(indexContent)))
    );
    treeItems.push({ path: CONFIG.INDEX_PATH, mode: '100644', type: 'blob', sha: indexBlobSha });

    const newTreeSha = await createTree(GITHUB_OWNER, GITHUB_REPO, GITHUB_TOKEN, baseTreeSha, treeItems);
    const message = alreadyArchived
        ? `radar-archive: purga fotogramas caducados (${expired.length})`
        : `radar-archive: fotograma ${new Date(ts).toISOString()} (${tileBlobs.length} teselas)` +
          (expired.length ? ` + purga ${expired.length} caducados` : '');
    const newCommitSha = await createCommit(GITHUB_OWNER, GITHUB_REPO, GITHUB_TOKEN, message, newTreeSha, baseCommitSha);
    await updateRef(GITHUB_OWNER, GITHUB_REPO, branch, GITHUB_TOKEN, newCommitSha);

    return {
        ok: true,
        archived: !alreadyArchived,
        ts,
        tiles: tileBlobs.length,
        purged: expired.length,
        totalFrames: keep.length
    };
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (env.ARCHIVE_SECRET) {
            if (url.searchParams.get('key') !== env.ARCHIVE_SECRET) {
                return new Response('Unauthorized', { status: 401 });
            }
        }
        try {
            const result = await run(env);
            return new Response(JSON.stringify(result), {
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (err) {
            console.error(err);
            return new Response(JSON.stringify({ ok: false, error: String(err && err.message || err) }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }
};
