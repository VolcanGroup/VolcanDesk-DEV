# Runbook de despliegue — Volcán Desk / Ticket Management (ambiente DEV)

Servidor destino: **VLC-OPSQL-PRD** (10.23.105.36), Windows Server 2019.

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

## 4. Compilar el frontend

```powershell
cd F:\VolcanDesk\frontend
npm run build
```

Esto genera `F:\VolcanDesk\frontend\dist\`, que es lo que sirve
`serve-static.cjs` (incluido en este paquete, sin dependencias extra).

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
  en `db.js` (o sea, no es un secreto nuevo) — cuando pasen a producción
  real, conviene generar una contraseña de BD distinta y ya no depender del
  default en el código.
