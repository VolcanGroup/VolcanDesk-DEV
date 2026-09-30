# Runbook de despliegue — Volcán Desk / Ticket Management (ambiente DEV)

Servidor destino: **VLC-OPSQL-PRD** (10.23.105.36), Windows Server 2019.

**Nota (2026-09-14)**: este runbook documenta cómo se desplegó originalmente
este ambiente DEV (`Z:\VolcanDesk`, puertos 4000/5173) — ya está en línea,
así que los pasos de abajo son de referencia, no algo pendiente por hacer.
Desde hoy existe además una instancia de **producción** real e independiente
en el mismo servidor (`Z:\VolcanDesk-Prod`, puertos 4001/5174, base de datos
propia) — ver `Z:\VolcanDesk-Prod\RUNBOOK.md` para su propio runbook. El
flujo de trabajo es: construir y probar aquí en DEV, y luego portar los
mismos cambios de código a la instancia de producción.

No pude conectarme yo mismo al servidor ni usar la contraseña que compartiste —
no autentico ni entro a sistemas con credenciales, por política. Estos pasos
los tiene que ejecutar quien tenga acceso por RDP/VPN (tú o alguien de
sistemas). Están pensados para copiar/pegar en PowerShell donde se indique.

## 0. Antes de empezar

- Verifica si el servidor ya tiene **Node.js** instalado (`node -v` en una
  consola). Se recomienda Node 18 o 20 LTS. Si no está, descárgalo de
  https://nodejs.org/ (instalador `.msi`) — necesita salida a internet o
  copiar el instalador por VPN.
- Verifica que exista la unidad **F:\\** y que tengas permisos de escritura ahí.
- Este paquete NO incluye `node_modules` ni `dist` — se generan en el
  servidor con `npm install` / `npm run build` (así el ejecutable queda
  compilado para esa máquina, no copiado desde otra).

## 1. Copiar el proyecto a F:\\

Copia toda la carpeta `deploy_pkg` (la que contiene este archivo,
`frontend/`, `backend/` y `ecosystem.config.js`) a:

```
F:\VolcanDesk\
```

Quedando:

```
F:\VolcanDesk\
├── ecosystem.config.js
├── frontend\
│   ├── src\, public\, index.html, package.json, vite.config.js...
└── backend\
    ├── server.js, db.js, package.json, .env.example, attachments\
```

## 2. Instalar dependencias

En PowerShell:

```powershell
cd F:\VolcanDesk\frontend
npm install

cd F:\VolcanDesk\backend
npm install
```

## 3. Configurar la base de datos (backend)

```powershell
cd F:\VolcanDesk\backend
copy .env.example .env
notepad .env
```

El `.env.example` ya trae los mismos valores por default que usa el código
(`DB_HOST=localhost`, `DB_NAME=tickets_db`, etc.) — la base de datos MariaDB
de este proyecto ya corre en este mismo servidor, así que en teoría no hay
que tocar nada. Si `localhost` no conecta, cambia `DB_HOST` a `10.23.105.36`
(misma máquina, otra forma de referenciarla) o a la que te confirme el
equipo de base de datos.

**Notificaciones por correo (agregado 2026-08-27)** — el `.env.example`
también trae ahora `SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE`/`SMTP_USER`/
`SMTP_PASS`/`FRONTEND_URL`. Son opcionales: si `SMTP_USER`/`SMTP_PASS`
quedan vacíos, el backend simplemente omite el envío de correos (con un
warning en el log) y el resto de la app sigue funcionando normal. Si sí
quieres correos de "ticket asignado"/"nuevo ticket sin asignar"/"nuevo
comentario", necesitas una cuenta SMTP real (Gmail con contraseña de
aplicación, o el proveedor que uses) y `FRONTEND_URL` apuntando a la IP/host
por la que entran los usuarios (no `localhost`) — de ahí arma los links "Ver
Ticket" que van dentro del correo.

**Recuperar contraseña (agregado 2026-09-18) — reutiliza este mismo SMTP, sin
variables nuevas**: el correo de "recuperar contraseña" (`POST
/api/auth/forgot-password`) usa exactamente esta misma configuración SMTP y
`FRONTEND_URL` (para armar el link `${FRONTEND_URL}/reset-password?token=...`)
— si el SMTP de arriba ya está configurado y funcionando, esto ya funciona
solo, no hay nada que instalar/configurar aparte.

**Descarga de adjuntos (agregado 2026-08-27)** — el `.env.example` también
trae `DOWNLOAD_TOKEN_SECRET` (vacío por default). No hace falta llenarlo: si
se deja vacío, el código usa un secreto por default para que la descarga de
archivos adjuntos funcione sin configurar nada. En un despliegue que sí
importa la seguridad, conviene poner ahí un valor propio — si se cambia más
adelante, los links de descarga ya generados (válidos solo 15 minutos) dejan
de servir, sin ningún otro efecto.

**Exportación para sistema externo (agregado 2026-08-27)** — `EXPORT_API_KEY`
en `.env.example`, vacío por default. A diferencia de las anteriores, **esta
sí hay que llenarla** antes de que `GET /api/export/tickets` funcione — si
queda vacía, la ruta responde 401 siempre, no hay ningún valor por default en
el código. Genera un string aleatorio largo (ej. `openssl rand -hex 32` o
equivalente) y compártelo con quien vaya a configurar el sistema externo que
consume esta API — lo debe mandar en el header `x-api-key` de cada llamada.

## 4. Compilar el frontend

```powershell
cd F:\VolcanDesk\frontend
npm run build
```

Esto genera `F:\VolcanDesk\frontend\dist\`, que es lo que sirve
`serve-static.cjs` (incluido en este paquete, sin dependencias extra).

**Cache-Control (agregado 2026-09-16)**: `serve-static.cjs` manda
`Cache-Control: no-cache` en `index.html` (y en el fallback de SPA) para que
el navegador siempre la revalide, y `public, max-age=31536000, immutable` en
todo lo de `/assets/*` (los archivos con hash de contenido de Vite) — así un
deploy nuevo se refleja solo, sin que el usuario tenga que hacer un hard
refresh manual (`Ctrl+Shift+R`) para dejar de ver el JS del build anterior.
Un `npm run build` normal sigue sin necesitar reinicio (`serve-static.cjs`
lee `dist/` en cada request), pero si alguna vez se vuelve a tocar el propio
`serve-static.cjs`, sí hace falta `pm2 restart volcandesk-frontend` — es el
proceso Node en sí, no un archivo que lea en caliente.

## 5. Instalar PM2 y dejarlo persistente en Windows

```powershell
npm install -g pm2
npm install -g pm2-windows-startup
pm2-startup install
```

`pm2 startup` (el comando normal de Linux) no sirve en Windows — por eso el
paso extra con `pm2-windows-startup`, que registra PM2 como tarea/servicio
para que sobreviva reinicios del servidor.

## 6. Arrancar la app con PM2

```powershell
cd F:\VolcanDesk
pm2 start ecosystem.config.js
pm2 save
```

`pm2 save` guarda la lista de procesos para que `pm2-windows-startup` los
vuelva a levantar automáticamente si el servidor se reinicia.

Comandos útiles después:

```powershell
pm2 status              # ver que ambos procesos estén "online"
pm2 logs volcandesk-backend
pm2 logs volcandesk-frontend
pm2 restart all
```

## 7. Firewall

Abrir los puertos **4000** (backend/API) y **5173** (frontend) en el
Firewall de Windows para que sean alcanzables desde la VPN:

```powershell
New-NetFirewallRule -DisplayName "VolcanDesk Backend"  -Direction Inbound -LocalPort 4000 -Protocol TCP -Action Allow
New-NetFirewallRule -DisplayName "VolcanDesk Frontend" -Direction Inbound -LocalPort 5173 -Protocol TCP -Action Allow
```

## 8. IP interna

Asignar una IP interna fija a este servidor (o confirmar la que ya tiene)
es tarea del equipo de red, no de la app — no es algo que se configure
desde aquí. Lo único que necesitas saber es: **qué IP/hostname usarán los
testers para llegar por VPN**, y que los puertos 4000 y 5173 estén abiertos
hacia esa IP.

El frontend detecta automáticamente esa IP/hostname (arreglé esto en el
código — antes tenía `localhost:4000` fijo, lo cual no habría funcionado
para nadie que no fuera tú). Así que en cuanto la IP esté asignada y el
firewall abierto, cualquiera debería poder entrar a:

```
http://<ip-interna-del-servidor>:5173
```

sin tocar nada más.

## 9. Verificación

Desde OTRA máquina conectada a la VPN (no desde el propio servidor):

1. Abrir `http://<ip-o-hostname>:5173` — debe cargar la pantalla de login.
2. Iniciar sesión con un usuario existente y confirmar que carga tickets
   (esto confirma que el frontend sí está llegando al backend en el puerto
   4000).

## Notas de seguridad

- La contraseña de dominio que compartiste quedó en texto plano en este
  chat — vale la pena rotarla cuando termines, sobre todo si este chat
  queda guardado en algún lado.
- `DB_PASSWORD` en `.env` es la misma que ya está hardcodeada como default
  en `db.js` (o sea, no es un secreto nuevo) — la instancia de producción
  real (`Z:\VolcanDesk-Prod`, ver nota arriba) ya usa una contraseña de BD
  distinta y propia, sin depender de este default.
- **(2026-09-21)** La creación de tickets internos (`POST /api/tickets`)
  ahora toma un lock real (`FOR UPDATE` sobre la fila de `Config`) mientras
  calcula el siguiente consecutivo del folio — antes dos creaciones casi
  simultáneas en grupos distintos podían terminar con el mismo número. Si
  alguna vez ves dos tickets con el mismo consecutivo numérico bajo
  prefijos distintos (`VD-<GRUPO>-NNNNNN`), es de antes de esta fecha, ya
  no debería poder repetirse. Detalle completo en `CLAUDE.md`, sesión
  2026-09-21.
