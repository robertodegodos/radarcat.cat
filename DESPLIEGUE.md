# Archivado del radar en GitHub — guía de despliegue

Resumen de la arquitectura:

```
cron-job.org (cada 4 min)
        │  GET https://tu-worker.workers.dev/?key=...
        ▼
Cloudflare Worker (worker.js)
        │  1. mira si Meteocat tiene un fotograma nuevo
        │  2. descarga sus teselas
        │  3. las sube a GitHub en UN commit (Git Data API)
        ▼
Repositorio GitHub (archive/frames/<timestamp>/tXX_YY.png + archive/index.json)
        │  servido vía CDN (jsDelivr) — cache pública, gratis, rápido
        ▼
Radar.html (cualquier ordenador) → GitHubArchive lee index.json y las teselas
```

## 1. Repositorio de GitHub

Ya tienes uno con GitHub Pages activado. Solo necesitas:

1. Crea la carpeta `archive/` en la raíz del repo y sube el `index.json` vacío
   que te adjunto (`seed_archive/index.json`, contenido `[]`) en
   `archive/index.json`. Es el punto de partida que el Worker irá actualizando.
2. Sube el `Radar.html` adjunto (sustituye al que tenías).

## 2. Token de GitHub (para que el Worker pueda escribir)

1. GitHub → Settings → Developer settings → **Fine-grained personal access
   tokens** → Generate new token.
2. Repository access: **Only select repositories** → elige tu repo del radar.
3. Permissions → Repository permissions → **Contents: Read and write**. Nada más.
4. Genera el token y guárdalo — no lo pegues en ningún archivo del repo ni
   del HTML. Solo va como *secret* del Worker (paso 4).

## 3. Cloudflare Worker

1. Cuenta gratuita en https://dash.cloudflare.com si no la tienes.
2. Workers & Pages → Create → Create Worker. Ponle un nombre, p. ej.
   `radar-catalunya-archiver`.
3. Pega el contenido de `worker.js` en el editor (o usa `wrangler deploy`
   con el `wrangler.toml` adjunto, si prefieres la CLI).
4. Settings → Variables and Secrets:
   - Variables (texto normal): `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BRANCH`.
   - Secrets (cifrados): `GITHUB_TOKEN` (el del paso 2) y, opcionalmente,
     `ARCHIVE_SECRET` (una contraseña inventada por ti) para que nadie más
     pueda disparar el Worker llamando a su URL.
5. Deploy. Copia la URL pública que te da Cloudflare
   (`https://radar-catalunya-archiver.TU-SUBDOMINIO.workers.dev`).
6. Pruébala a mano en el navegador (añadiendo `?key=...` si pusiste
   `ARCHIVE_SECRET`). Debería responder un JSON como
   `{"ok":true,"archived":true,"ts":...,"tiles":4,...}` y, a los pocos
   segundos, ver un commit nuevo en tu repositorio.

## 4. El "pinger" externo (cron-job.org)

GitHub Actions no permite cron por debajo de 5 min, así que la llamada
periódica la hace un servicio externo gratuito:

1. Crea una cuenta en https://cron-job.org (gratis).
2. Create cronjob → URL: la de tu Worker (con `?key=...` si aplica).
3. Schedule: cada 4 minutos.
4. Guarda y actívalo.

## 5. Front-end (Radar.html)

Solo hay que rellenar dos valores al principio del archivo, en el bloque
`GITHUB_ARCHIVE_CONFIG` (búscalo con Ctrl+F):

```js
const GITHUB_ARCHIVE_CONFIG = {
    REPO_USER: 'TU_USUARIO_GITHUB',   // ← cámbialo
    REPO_NAME: 'TU_REPOSITORIO',      // ← cámbialo
    BRANCH: 'main',
    ...
```

Con eso, la página leerá `archive/index.json` y las teselas archivadas vía
`cdn.jsdelivr.net/gh/...`, que es una CDN gratuita delante de GitHub (más
rápida y sin los límites de `raw.githubusercontent.com`).

## Cosas a tener en cuenta

- **Retención**: fija a 7 días, sin adelgazado. Con el radar publicando cada
  6 min y el pinger comprobando cada 4 min, tendrás ~1.680 fotogramas/semana
  archivados (cada uno con unas pocas teselas de 256×256 — normalmente entre
  4 y 9 según cómo caiga la cuadrícula sobre Catalunya). El propio Worker
  purga automáticamente lo que supere los 7 días en cada ejecución.
- **jsDelivr cachea unos minutos**: es normal que un fotograma recién subido
  tarde 1-2 min en verse reflejado vía CDN. El índice del front-end se
  refresca cada 3 min (`INDEX_REFRESH_MS`), lo cual ya lo tiene en cuenta.
- **Un solo commit por ejecución**: el Worker usa la Git Data API (blobs +
  tree + commit) para no generar un commit por tesela, así que el
  historial del repo crece de forma razonable (~360 commits/día).
- **Nada de tokens en el navegador**: el HTML nunca ve `GITHUB_TOKEN`; solo
  lee archivos públicos ya subidos. El único sitio con el token es el
  Worker (secret cifrado).
