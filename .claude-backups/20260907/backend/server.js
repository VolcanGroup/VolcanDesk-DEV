const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Op, Sequelize } = require('sequelize');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { sequelize, initDB, Ticket, User, Comment, Company, Config, Group, CampoCatalogo, ReglaFlujo, TicketCampoValor, AreaAccesoExtra, TicketBloqueoHistorial, Notification, isBcryptHash } = require('./db');
const emailService = require('./services/emailService');

const app = express();
const PORT = process.env.PORT || 4000;

// Firma los tokens de descarga de /api/uploads (ver más abajo) — igual que el resto
// de secretos de este proyecto, trae un default para que la app funcione sin .env,
// pero en un despliegue real conviene fijar DOWNLOAD_TOKEN_SECRET a algo propio.
const DOWNLOAD_TOKEN_SECRET = process.env.DOWNLOAD_TOKEN_SECRET || 'volcandesk-download-token-dev-secret-2026';
const DOWNLOAD_TOKEN_TTL = '15m';

app.use(cors());
// Configurar límite de tamaño mayor para recibir archivos adjuntos base64 sin error PayloadTooLarge
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Utilidad para obtener el directorio de adjuntos de forma dinámica
const getAttachmentDir = () => {
    const gPath = 'G:\\MariaDB\\attachments';
    // Si estamos corriendo en el servidor o tenemos acceso directo a la letra G
    if (fs.existsSync('G:\\MariaDB')) {
        if (!fs.existsSync(gPath)) {
            fs.mkdirSync(gPath, { recursive: true });
        }
        return gPath;
    }
    // Si estamos corriendo en local y tenemos acceso a la ruta UNC por SMB
    const uncPath = '\\\\10.23.105.36\\G$\\MariaDB\\attachments';
    try {
        if (fs.existsSync('\\\\10.23.105.36\\G$\\MariaDB')) {
            if (!fs.existsSync(uncPath)) {
                fs.mkdirSync(uncPath, { recursive: true });
            }
            return uncPath;
        }
    } catch (e) {
        // Ignorar error si no hay acceso de red temporal
    }
    // Fallback local en la carpeta del servidor
    const localPath = path.join(__dirname, 'attachments');
    if (!fs.existsSync(localPath)) {
        fs.mkdirSync(localPath, { recursive: true });
    }
    return localPath;
};

// Lista blanca de extensiones aceptadas para adjuntos y campos tipo "archivo"
// (auditoría 2026-08-27: antes se aceptaba cualquier extensión, incluidas .html/.svg,
// que un navegador ejecuta/renderiza si alguien abre el archivo directo en vez de
// descargarlo — riesgo de XSS/phishing servido bajo el dominio del backend). Se usa
// lista BLANCA (no negra) a propósito: es la única forma de no dejar pasar algo
// peligroso que no se nos ocurrió bloquear.
const ALLOWED_ATTACHMENT_EXTENSIONS = new Set([
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv', '.rtf',
    '.odt', '.ods', '.odp', '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff',
    '.zip', '.rar', '.7z', '.eml', '.msg'
]);
// 20MB por archivo — el límite global de 50MB en express.json() es del PAYLOAD JSON
// completo (que puede traer varios adjuntos a la vez en base64, ~33% más pesado que
// el binario), no un tope por archivo individual.
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

// Valida un nombre/tamaño de archivo entrante contra la lista blanca y el tope de
// tamaño; lanza un Error descriptivo si no pasa (los call-sites ya están dentro de
// un try/catch que responde 400).
const validateAttachmentFile = (fileName, buffer) => {
    const ext = (path.extname(fileName || '') || '').toLowerCase();
    if (!ALLOWED_ATTACHMENT_EXTENSIONS.has(ext)) {
        throw new Error(`Tipo de archivo no permitido: "${ext || 'sin extensión'}". Extensiones permitidas: ${[...ALLOWED_ATTACHMENT_EXTENSIONS].join(', ')}`);
    }
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
        throw new Error(`El archivo "${fileName}" supera el tope de ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB por archivo.`);
    }
};

// Borra el archivo físico de un adjunto SOLO si ya nadie lo referencia — un ticket
// (attachments), un comentario (attachments) o un campo dinámico tipo "archivo"
// (TicketCampoValor.valor) — antes quitar un adjunto de un ticket nunca borraba el
// archivo del disco, dejando huérfanos acumulándose indefinidamente (confirmado en
// vivo el 2026-08-27: un archivo de prueba quedó en disco tras quitarlo del ticket).
// El nombre en disco es siempre un UUID generado al subir, así que en la práctica
// nunca coincide entre dos subidas distintas — pero se re-verifica igual por
// correctitud, no por suposición.
const deleteAttachmentFileIfOrphaned = async (fileUrl) => {
    try {
        const filename = (fileUrl || '').split('/').pop();
        if (!filename) return;
        const stillReferenced = Sequelize.where(Sequelize.cast(Sequelize.col('attachments'), 'CHAR'), { [Op.like]: `%${fileUrl}%` });
        const [ticketMatch, commentMatch, campoMatch] = await Promise.all([
            Ticket.findOne({ where: stillReferenced }),
            Comment.findOne({ where: stillReferenced }),
            TicketCampoValor.findOne({ where: Sequelize.where(Sequelize.col('valor'), { [Op.like]: `%${fileUrl}%` }) }),
        ]);
        if (ticketMatch || commentMatch || campoMatch) return; // todavía referenciado en algún lado
        const filePath = path.join(getAttachmentDir(), filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
        // No tumbar la request principal por un archivo que no se pudo borrar — solo loguear.
        console.error('Error al limpiar archivo adjunto huérfano:', err);
    }
};

// Función para procesar y decodificar adjuntos en base64
const processAttachments = (attachments) => {
    if (!attachments || !Array.isArray(attachments)) return [];

    const dir = getAttachmentDir();
    return attachments.map(att => {
        if (att.fileData && att.fileData.startsWith('data:')) {
            const parts = att.fileData.split(';base64,');
            const mime = parts[0].split(':')[1];
            const base64Data = parts[1];
            const buffer = Buffer.from(base64Data, 'base64');

            validateAttachmentFile(att.fileName, buffer); // lanza si no pasa — no se atrapa aquí a propósito

            const fileExt = path.extname(att.fileName) || '.bin';
            const uniqueName = `${crypto.randomUUID()}${fileExt}`;
            const destPath = path.join(dir, uniqueName);

            fs.writeFileSync(destPath, buffer);

            // Devolver el objeto de adjunto con la URL del servidor
            return {
                id: att.id,
                fileName: att.fileName,
                fileSize: att.fileSize,
                fileType: att.fileType || mime,
                fileUrl: `/api/uploads/${uniqueName}`,
                uploadedBy: att.uploadedBy,
                uploadedAt: att.uploadedAt
            };
        }
        return att; // Si ya tiene URL y no base64, dejarlo igual
    });
};

// Procesa el valor de un campo dinámico de tipo "archivo": si viene un objeto
// con fileData en base64 (mismo mecanismo que los adjuntos del ticket), lo
// guarda a disco y devuelve un JSON string {fileName, fileSize, fileType, fileUrl}
// para almacenar en TicketCampoValor.valor (columna TEXT, no soporta base64 crudo).
const processCampoArchivoValue = (value) => {
    if (value && typeof value === 'object' && typeof value.fileData === 'string' && value.fileData.startsWith('data:')) {
        const dir = getAttachmentDir();
        const parts = value.fileData.split(';base64,');
        const mime = parts[0].split(':')[1];
        const base64Data = parts[1];
        const buffer = Buffer.from(base64Data, 'base64');

        validateAttachmentFile(value.fileName, buffer); // lanza si no pasa — no se atrapa aquí a propósito

        const fileExt = path.extname(value.fileName || '') || '.bin';
        const uniqueName = `${crypto.randomUUID()}${fileExt}`;
        const destPath = path.join(dir, uniqueName);

        fs.writeFileSync(destPath, buffer);

        return JSON.stringify({
            fileName: value.fileName || uniqueName,
            fileSize: value.fileSize || buffer.length,
            fileType: value.fileType || mime,
            fileUrl: `/api/uploads/${uniqueName}`
        });
    }
    return String(value === null || value === undefined ? '' : value);
};

// ─── MIDDLEWARES DE AUTENTICACIÓN Y ROLES ────────────────────────────────────
app.use((req, res, next) => {
    req.user = {
        id: req.headers['x-user-id'] || null,
        role: req.headers['x-user-role'] || null,
    };
    next();
});

const requireAdmin = (req, res, next) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Acceso denegado. Se requiere rol de administrador.' });
    }
    next();
};

// admin general O group_admin (admin de un solo grupo en Volcán Desk) — usado en las
// rutas de catálogo (campos, reglas de flujo, config) donde el handler valida además
// que un group_admin solo toque datos de su propio grupo.
const requireAdminOrGroupAdmin = (req, res, next) => {
    if (req.user.role !== 'admin' && req.user.role !== 'group_admin') {
        return res.status(403).json({ error: 'Acceso denegado. Se requiere rol de administrador.' });
    }
    next();
};

const requireInternal = (req, res, next) => {
    if (!['admin', 'group_admin', 'agent', 'supervisor'].includes(req.user.role)) {
        return res.status(403).json({ error: 'Acceso denegado. Se requiere rol de usuario interno.' });
    }
    next();
};

const VALID_ROLES = ['admin', 'group_admin', 'agent', 'supervisor', 'client'];
// Antes varias rutas de lectura (GET /api/tickets, GET /api/users) no exigían
// ningún header de identidad: una request sin x-user-id/x-user-role pasaba de
// largo y, en varios `if (req.user.role === ...)`, caía en la rama "por
// defecto" pensada para roles internos ya autenticados. Este gate exige, como
// mínimo, que la request declare un id y un rol válido — no verifica esa
// identidad contra una sesión real (todo el modelo de auth de esta app sigue
// siendo headers de confianza), pero cierra el acceso totalmente anónimo.
const requireAuthenticated = (req, res, next) => {
    if (!req.user.id || !VALID_ROLES.includes(req.user.role)) {
        return res.status(401).json({ error: 'No autenticado.' });
    }
    next();
};

// GET /api/export/tickets (agregado 2026-08-27) es para un sistema externo — el
// concentrador de APIs de Volcán — que no actúa como ningún usuario real de esta
// app, así que el modelo de headers x-user-id/x-user-role no aplica: usa una API
// key fija en su lugar, guardada en EXPORT_API_KEY (.env). Sin default en código a
// propósito (a diferencia de DOWNLOAD_TOKEN_SECRET) — si no se configura, la ruta
// se queda inaccesible en vez de aceptar cualquier llamada sin llave.
const requireExportApiKey = (req, res, next) => {
    if (!process.env.EXPORT_API_KEY || req.headers['x-api-key'] !== process.env.EXPORT_API_KEY) {
        return res.status(401).json({ error: 'API key inválida o no configurada.' });
    }
    next();
};

// Resuelve el grupo administrado por un group_admin (null para cualquier otro rol)
const getGroupAdminScope = async (user) => {
    if (user.role !== 'group_admin') return null;
    const u = await User.findByPk(user.id);
    return u?.admin_group_id || null;
};

// ─── HELPERS DE ACCESO Y SANEAMIENTO DE TICKETS ──────────────────────────────

// Campos que solo agent/admin/supervisor pueden modificar directamente (nunca el client)
const RESTRICTED_TICKET_FIELDS = [
    'status', 'product', 'priority', 'group', 'category', 'type',
    'resolver_agent_id', 'resolver_group_id', 'owner_agent_id', 'previous_owner_id',
    'assignedTo', 'bloqueado', 'motivo_bloqueo', 'etiquetas',
    'fecha_estimada_inicio', 'fecha_estimada_conclusion', 'estimacion_hus'
];

// Campos que generan una entrada de log 'campo_editado' cuando cambian fuera de un escalamiento
const TRACKED_TICKET_FIELDS = [
    { key: 'status', label: 'Estado' },
    { key: 'product', label: 'Producto' },
    { key: 'priority', label: 'Prioridad' },
    { key: 'group', label: 'Grupo' },
    { key: 'category', label: 'Categoría' },
    { key: 'type', label: 'Tipo' },
    { key: 'resolver_agent_id', label: 'Agente Asignado' },
    { key: 'bloqueado', label: 'Bloqueado' },
    { key: 'motivo_bloqueo', label: 'Motivo de Bloqueo' },
    { key: 'fecha_estimada_inicio', label: 'Fecha estimada de inicio' },
    { key: 'fecha_estimada_conclusion', label: 'Fecha estimada de conclusión' },
    { key: 'estimacion_hus', label: 'Estimación HUs' },
];

// Nunca exponer el log de actividad interno ni las notas privadas al rol client
// (Voltik) — y en Volcán Desk (ambito interno), nunca exponer una Nota Interna
// a alguien que no sea miembro del grupo RESOLUTOR actual del ticket. Antes esto
// solo miraba `role === 'client'`, pero en Volcán Desk el solicitante también es
// un usuario interno (rol agent/group_admin, nunca 'client'), así que una nota
// marcada "privada" por el grupo resolutor se le mostraba igual — bug reportado
// en vivo: Ximena (Admin de Grupo) dejó una Nota Interna y el solicitante (juan)
// la veía en su propia vista del ticket.
const getUserGroupContext = async (user) => {
    if (user.role === 'admin') return { isAdmin: true, allowedGroups: [] };
    const currentUser = await User.findByPk(user.id);
    const userGroups = currentUser?.groups || [];
    const accesosExtra = await AreaAccesoExtra.findAll({ where: { usuario_id: user.id } });
    const extraGroupIds = accesosExtra.map(a => a.area_id);
    const groupAdminScope = currentUser?.role === 'group_admin' && currentUser.admin_group_id ? [currentUser.admin_group_id] : [];
    return { isAdmin: false, allowedGroups: [...userGroups, ...extraGroupIds, ...groupAdminScope] };
};

// Todos los grupos cuyo catálogo (Prioridad/Categoría/Tipo) un group_admin puede
// necesitar RESOLVER para etiquetas — más amplio que getUserGroupContext().allowedGroups
// (que solo cubre membresía de grupo/acceso extra). Bug reportado en vivo 2026-08-27:
// un primer fix de GET /api/config solo filtraba contra allowedGroups, y dejó sin
// resolver Prioridad/Categoría en tickets que el group_admin ve por ser el CREADOR
// (solicitante), no por pertenecer al grupo resolutor — mostraba el value crudo
// (ej. "baja__<grupoId>") en vistas que mezclan varios grupos, como "Todos". Se
// suma el grupo resolutor/origen/apoyos de cada ticket interno que el usuario creó.
const getConfigVisibleGroupIds = async (user) => {
    const { allowedGroups } = await getUserGroupContext(user);
    const groupIds = new Set(allowedGroups);
    const ownTickets = await Ticket.findAll({
        where: { ambito: 'interno', createdBy: user.id },
        attributes: ['group', 'resolver_group_id', 'area_origen_id', 'apoyos'],
    });
    ownTickets.forEach(t => {
        if (t.resolver_group_id) groupIds.add(t.resolver_group_id);
        if (t.group) groupIds.add(t.group);
        if (t.area_origen_id) groupIds.add(t.area_origen_id);
        (t.apoyos || []).forEach(a => { if (a.grupo_solicitado) groupIds.add(a.grupo_solicitado); });
    });
    return groupIds;
};

// Los 4 escenarios reales que disparan correo (ver los 4 sendHtmlEmail en este
// archivo) — cada grupo de Volcán Desk los prende/apaga de forma independiente
// (a pedido del usuario 2026-08-27: no es un interruptor general, cada grupo
// decide qué le llega).
const EMAIL_EVENT_KEYS = ['nuevoTicketAsignado', 'nuevoTicketSinAsignar', 'respuestaSolicitante', 'respuestaResolutor'];

// Default ON si el grupo nunca lo configuró — preserva el comportamiento que ya
// existía antes de que existiera este ajuste.
const isGroupEmailEventEnabled = async (groupId, eventKey) => {
    if (!groupId) return true;
    const configRow = await Config.findByPk('tms_config');
    const groupSettings = configRow?.value?.emailNotificationsByGroup?.[groupId];
    if (!groupSettings || !(eventKey in groupSettings)) return true;
    return groupSettings[eventKey] !== false;
};

const sanitizeTicketForUser = (ticketJson, user, ctx) => {
    if (ticketJson.ambito === 'externo') {
        if (user.role === 'client') {
            return {
                ...ticketJson,
                activities: [],
                comments: (ticketJson.comments || []).filter(c => !c.isPrivate)
            };
        }
        return ticketJson;
    }
    // ambito === 'interno': una Nota Interna solo la puede ver alguien autorizado
    // del grupo resolutor actual (o un admin) — el creador/solicitante NO cuenta
    // por sí solo, aunque sea el dueño del ticket.
    const effectiveGroupId = ticketJson.resolver_group_id || ticketJson.group;
    // Un apoyo ya "Resuelto" ya no cuenta como membresía activa — si no, el
    // grupo al que se le pidió apoyo conservaría acceso a las notas privadas
    // del ticket para siempre, mucho después de haber terminado su consulta.
    const isApoyo = (ticketJson.apoyos || []).some(a => ctx.allowedGroups.includes(a.grupo_solicitado) && a.status !== 'Resuelto');
    const canSeePrivate = ctx.isAdmin || (!!effectiveGroupId && ctx.allowedGroups.includes(effectiveGroupId)) || isApoyo;
    if (canSeePrivate) return ticketJson;
    return {
        ...ticketJson,
        comments: (ticketJson.comments || []).filter(c => !c.isPrivate)
    };
};

// Misma regla de acceso usada para lectura (GET) y escritura (PUT) de un ticket
const checkTicketAccess = async (ticket, user) => {
    if (ticket.ambito === 'interno') {
        if (user.role === 'client') return false;
        if (user.role === 'admin') return true;
        const currentUser = await User.findByPk(user.id);
        const userGroups = currentUser?.groups || [];
        const accesosExtra = await AreaAccesoExtra.findAll({ where: { usuario_id: user.id } });
        const extraGroupIds = accesosExtra.map(a => a.area_id);
        // group_admin: acceso total (como un admin) pero acotado a su único grupo administrado.
        const groupAdminScope = currentUser?.role === 'group_admin' && currentUser.admin_group_id ? [currentUser.admin_group_id] : [];
        const allowedGroups = [...userGroups, ...extraGroupIds, ...groupAdminScope];
        // ticket.group puede venir como NOMBRE en vez de id (tickets viejos o tras un
        // "Escalar/Transferir") — resolver_group_id es la fuente de verdad cuando
        // existe. Comparar solo contra ticket.group dejaba tickets ya ruteados al
        // grupo del usuario (pero aún sin asignar a nadie) invisibles por completo,
        // incluso para GET /api/tickets. Mismo criterio que ya usa
        // isAuthorizedResolverGroupMember más abajo.
        const effectiveGroupId = ticket.resolver_group_id || ticket.group;
        // Igual que en sanitizeTicketForUser: un apoyo ya "Resuelto" no debe
        // seguir dando acceso al ticket indefinidamente.
        const isApoyo = (ticket.apoyos || []).some(a => allowedGroups.includes(a.grupo_solicitado) && a.status !== 'Resuelto');
        return allowedGroups.includes(effectiveGroupId) || allowedGroups.includes(ticket.area_origen_id) || ticket.createdBy === user.id || isApoyo;
    }
    // ambito externo
    if (user.role === 'client') {
        const currentUser = await User.findByPk(user.id);
        const sameCompany = !!(currentUser?.companyId && ticket.companyId && currentUser.companyId === ticket.companyId);
        return sameCompany || ticket.createdBy === user.id;
    }
    return true;
};

// Miembro autorizado del grupo RESOLUTOR actual de un ticket interno (Volcán Desk) —
// distinto de checkTicketAccess: ese decide quién puede VER el ticket (incluye
// area_origen_id/creador); esto decide quién puede actuar EN NOMBRE del grupo que
// lo está resolviendo (responder al solicitante, tomar/reasignar). Ver doc "lógica
// de visualización" §10/§11: ser el "responsable" (owner_agent_id) ya no debe ser
// requisito exclusivo — cualquier miembro autorizado del grupo resolutor puede.
const isAuthorizedResolverGroupMember = async (ticket, user) => {
    if (user.role === 'admin') return true;
    const effectiveGroupId = ticket.resolver_group_id || ticket.group;
    if (!effectiveGroupId) return false;
    const currentUser = await User.findByPk(user.id);
    if (user.role === 'group_admin') return currentUser?.admin_group_id === effectiveGroupId;
    const userGroups = currentUser?.groups || [];
    if (userGroups.includes(effectiveGroupId)) return true;
    const accesosExtra = await AreaAccesoExtra.findAll({ where: { usuario_id: user.id } });
    return accesosExtra.some(a => a.area_id === effectiveGroupId);
};

// ─── ARCHIVOS ADJUNTOS ────────────────────────────────────────────────────────
// Antes esta ruta era un express.static público (sin ningún chequeo) sobre TODO el
// directorio de adjuntos — quien tuviera la URL (que puede filtrarse por reenvío,
// historial del navegador, captura de pantalla) tenía acceso permanente e
// irrevocable al archivo, sin importar si después perdía acceso al ticket
// (auditoría 2026-08-27).
//
// Ubica el ticket dueño de un archivo por su nombre en disco: primero en el array
// de adjuntos del ticket, y si no aparece ahí, en los valores de campos dinámicos
// tipo "archivo" (TicketCampoValor). Usado tanto al emitir el token como al servir
// el archivo, para no duplicar la búsqueda.
const findTicketByAttachmentFilename = async (filename) => {
    const fileUrl = `/api/uploads/${filename}`;
    const likeFileUrl = Sequelize.where(Sequelize.cast(Sequelize.col('attachments'), 'CHAR'), { [Op.like]: `%${fileUrl}%` });
    let ticket = await Ticket.findOne({ where: likeFileUrl });
    if (!ticket) {
        const campoValor = await TicketCampoValor.findOne({
            where: Sequelize.where(Sequelize.col('valor'), { [Op.like]: `%${fileUrl}%` })
        });
        if (campoValor) {
            ticket = await Ticket.findByPk(campoValor.ticket_id);
        }
    }
    return ticket;
};

// El link de descarga es un <a href> (navegación de browser normal, para que
// funcione sin JS extra) — no puede mandar los headers x-user-id/x-user-role que
// usa el resto de la app, y ponerlos en crudo en la URL habría dejado un uid/role
// editables a mano (cualquiera cambia el uid y se hace pasar por otro usuario, con
// el agravante de que ahora queda escrito en un link compartible/en el historial).
// En vez de eso: el frontend primero pide aquí un token firmado y de corta
// duración (15 min), ligado a ticketId+uid+expiración — eso sí requiere una
// petición con headers reales (fetch, vía api.js), o sea la identidad la sigue
// dando el mismo modelo de siempre, pero el <a href> final solo lleva un token que
// no se puede editar para suplantar a otro usuario sin la clave del servidor.
app.get('/api/uploads/:filename/token', requireAuthenticated, async (req, res) => {
    try {
        const { filename } = req.params;
        if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
            return res.status(400).json({ error: 'Nombre de archivo inválido.' });
        }
        const ticket = await findTicketByAttachmentFilename(filename);
        if (!ticket) {
            return res.status(404).json({ error: 'Archivo no encontrado.' });
        }
        const allowed = await checkTicketAccess(ticket, req.user);
        if (!allowed) {
            return res.status(403).json({ error: 'No tienes permisos para ver este archivo.' });
        }
        const token = jwt.sign({ ticketId: ticket.id, uid: req.user.id }, DOWNLOAD_TOKEN_SECRET, { expiresIn: DOWNLOAD_TOKEN_TTL });
        res.json({ token });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al generar el enlace de descarga.' });
    }
});

app.get('/api/uploads/:filename', async (req, res) => {
    try {
        const { filename } = req.params;
        if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
            return res.status(400).json({ error: 'Nombre de archivo inválido.' });
        }
        let payload;
        try {
            payload = jwt.verify(String(req.query.token || ''), DOWNLOAD_TOKEN_SECRET);
        } catch (e) {
            return res.status(401).json({ error: 'Enlace de descarga inválido o expirado. Vuelve a abrir el archivo desde el ticket.' });
        }
        const filePath = path.join(getAttachmentDir(), filename);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Archivo no encontrado.' });
        }
        const ticket = await findTicketByAttachmentFilename(filename);
        // El token es válido, pero solo para el ticket con el que se emitió — evita
        // reusar un token real de un ticket propio para bajar un archivo de otro.
        if (!ticket || ticket.id !== payload.ticketId) {
            return res.status(403).json({ error: 'No tienes permisos para ver este archivo.' });
        }
        // El rol NUNCA se toma del token/query — se re-consulta el usuario real en
        // la base de datos por el uid del token, así el permiso lo decide el estado
        // actual del usuario y del ticket, no un dato que alguien pudiera fijar.
        const tokenUser = await User.findByPk(payload.uid);
        if (!tokenUser) {
            return res.status(401).json({ error: 'Usuario no encontrado.' });
        }
        const allowed = await checkTicketAccess(ticket, { id: tokenUser.id, role: tokenUser.role });
        if (!allowed) {
            return res.status(403).json({ error: 'No tienes permisos para ver este archivo.' });
        }
        res.sendFile(filePath);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al obtener el archivo.' });
    }
});

// ─── AUTENTICACIÓN ────────────────────────────────────────────────────────
// Ruta pública (sin gate, obviamente — el usuario todavía no tiene id/rol).
// Antes el login era 100% client-side: el frontend descargaba TODA la tabla
// de usuarios (incluida la columna password, sin hashear) vía GET /api/users
// antes de que existiera ninguna sesión, y comparaba la contraseña en el
// propio navegador. Esta ruta reemplaza esa comparación: el password nunca
// sale del servidor. Cuentas creadas antes de este cambio siguen con su
// password en texto plano en la BD — isBcryptHash() detecta eso y compara en
// texto plano UNA vez, migrando la cuenta a hash en ese mismo login exitoso.
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body || {};
        if (!email || !password) {
            return res.status(400).json({ error: 'Email y contraseña son requeridos.' });
        }
        const user = await User.findOne({
            where: Sequelize.where(Sequelize.fn('LOWER', Sequelize.col('email')), String(email).toLowerCase())
        });
        if (!user) {
            return res.status(401).json({ error: 'Credenciales inválidas.' });
        }

        let valid;
        if (isBcryptHash(user.password)) {
            valid = await bcrypt.compare(password, user.password);
        } else {
            valid = password === user.password;
            if (valid) {
                user.password = password; // el hook beforeSave en db.js la hashea al guardar
                await user.save();
            }
        }
        if (!valid) {
            return res.status(401).json({ error: 'Credenciales inválidas.' });
        }

        const { password: _pw, ...userWithoutPassword } = user.toJSON();
        res.json(userWithoutPassword);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al iniciar sesión.' });
    }
});

// ─── RUTAS DE CONFIGURACIÓN ──────────────────────────────────────────────────

app.get('/api/config', async (req, res) => {
    try {
        const configRow = await Config.findByPk('tms_config');
        if (!configRow) {
            return res.status(404).json({ error: 'Configuración no encontrada' });
        }
        let value = configRow.value;
        // Esta ruta no tiene auth (se llama también antes del login, para lo que
        // necesita la pantalla de Login) y antes devolvía el config COMPLETO sin
        // filtrar — un group_admin autenticado recibía el catálogo (Tipos,
        // Categorías, Prioridades, Productos, topes de Bloqueo) de TODOS los
        // grupos de Volcán Desk, y de Voltik también, con solo abrir la pestaña
        // Red del navegador; la pantalla solo lo acotaba después, en el cliente.
        // Nunca se le debe mezclar Voltik, ni mostrar catálogo de un grupo que ni
        // siquiera puede ver.
        //
        // OJO: se filtra contra `allowedGroups` (getUserGroupContext — su grupo
        // administrado MÁS cualquier otro grupo del que sea miembro o tenga acceso
        // extra), NO contra getGroupAdminScope (un solo grupo). Un primer intento
        // usó solo el grupo administrado y rompió la vista "Todos" (bug reportado en
        // vivo 2026-08-27): un group_admin con visibilidad sobre varios grupos veía
        // tickets de un grupo que no administra, pero el catálogo ya venía filtrado a
        // SOLO su grupo, así que Prioridad/Categoría de esos otros tickets no
        // encontraban su label y se mostraba el value crudo (ej. "baja__<grupoId>").
        // getGroupAdminScope() sigue siendo el correcto para los POST/PUT/DELETE de
        // más abajo — administrar (escribir) sí debe quedar acotado a un solo grupo,
        // ver (leer) no.
        if (req.user.role === 'group_admin') {
            const visibleGroupIds = await getConfigVisibleGroupIds(req.user);
            const scopedOnly = (arr) => (arr || []).filter(item => (item.modulo || 'voltik') === 'volcan_desk' && visibleGroupIds.has(item.grupoId));
            value = {
                ...value,
                types: scopedOnly(value.types),
                categories: scopedOnly(value.categories),
                priorities: scopedOnly(value.priorities),
                products: scopedOnly(value.products),
                groupBloqueoCaps: value.groupBloqueoCaps
                    ? Object.fromEntries(Object.entries(value.groupBloqueoCaps).filter(([gid]) => visibleGroupIds.has(gid)))
                    : {},
                emailNotificationsByGroup: value.emailNotificationsByGroup
                    ? Object.fromEntries(Object.entries(value.emailNotificationsByGroup).filter(([gid]) => visibleGroupIds.has(gid)))
                    : {},
            };
        }
        res.json(value);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al obtener la configuración' });
    }
});

// Interruptores de correo por grupo (agregado 2026-08-27) — ruta dedicada en vez de
// pasar por POST /api/config: ese endpoint rechaza cualquier clave fuera de
// SCOPED_SECTIONS (types/categories/priorities/products) cuando quien escribe es
// group_admin, y emailNotificationsByGroup es otra clave más — ampliar esa lógica
// genérica para un caso más habría sido más riesgoso que una ruta chica y explícita.
app.put('/api/config/email-notifications', requireAdminOrGroupAdmin, async (req, res) => {
    try {
        const { groupId, eventKey, enabled } = req.body || {};
        if (!groupId || !EMAIL_EVENT_KEYS.includes(eventKey) || typeof enabled !== 'boolean') {
            return res.status(400).json({ error: 'Parámetros inválidos.' });
        }
        if (req.user.role === 'group_admin') {
            const scope = await getGroupAdminScope(req.user);
            if (!scope || groupId !== scope) {
                return res.status(403).json({ error: 'Solo puedes cambiar las notificaciones de tu propio grupo.' });
            }
        }
        const configRow = await Config.findByPk('tms_config');
        const current = configRow?.value || {};
        const emailNotificationsByGroup = { ...(current.emailNotificationsByGroup || {}) };
        emailNotificationsByGroup[groupId] = { ...(emailNotificationsByGroup[groupId] || {}), [eventKey]: enabled };
        await Config.upsert({ key: 'tms_config', value: { ...current, emailNotificationsByGroup } });

        let responseMap = emailNotificationsByGroup;
        if (req.user.role === 'group_admin') {
            const visibleGroupIds = await getConfigVisibleGroupIds(req.user);
            responseMap = Object.fromEntries(Object.entries(emailNotificationsByGroup).filter(([gid]) => visibleGroupIds.has(gid)));
        }
        res.json({ emailNotificationsByGroup: responseMap });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al actualizar la configuración de notificaciones.' });
    }
});

app.post('/api/config', requireAdminOrGroupAdmin, async (req, res) => {
    try {
        let bodyToSave = req.body;

        // group_admin: solo puede tocar sus propios ítems de Tipos/Categorías/Prioridades/Productos
        // dentro de Volcán Desk, y su propia entrada en los objetos por-grupo
        // (groupBloqueoCaps, emailNotificationsByGroup) — todo lo demás debe quedar
        // intacto.
        if (req.user.role === 'group_admin') {
            const scope = await getGroupAdminScope(req.user);
            if (!scope) {
                return res.status(403).json({ error: 'Tu usuario no tiene un grupo administrado asignado.' });
            }
            const currentRow = await Config.findByPk('tms_config');
            const current = currentRow?.value || {};
            const incoming = req.body || {};
            const SCOPED_SECTIONS = ['types', 'categories', 'priorities', 'products'];
            const GROUP_SCOPED_OBJECT_SECTIONS = ['groupBloqueoCaps', 'emailNotificationsByGroup'];
            // "De otro grupo" = cualquier ítem de Voltik (un group_admin nunca toca ese módulo),
            // o de Volcán Desk con un grupoId que no es el propio. Los ítems de Volcán Desk sin
            // grupoId (legado, sin asignar) SÍ son tocables — puede reclamarlos para su grupo,
            // igual que ya podía hacer un admin general desde la pantalla de reasignar.
            const belongsToOther = (item) => {
                const itemModulo = item.modulo || 'voltik';
                if (itemModulo !== 'volcan_desk') return true;
                return !!item.grupoId && item.grupoId !== scope;
            };

            const otherKeysChanged = Object.keys({ ...current, ...incoming }).some(key => {
                if (SCOPED_SECTIONS.includes(key) || GROUP_SCOPED_OBJECT_SECTIONS.includes(key)) return false;
                return JSON.stringify(current[key]) !== JSON.stringify(incoming[key]);
            });
            if (otherKeysChanged) {
                return res.status(403).json({ error: 'No tienes permiso para modificar esta parte de la configuración.' });
            }

            // No se compara "incoming vs current" para las secciones por-grupo — desde
            // que GET /api/config empezó a filtrar estas secciones a solo lo que el
            // group_admin puede ver (2026-08-27), su payload YA NO trae los ítems/
            // entradas de otros grupos (nunca los recibió), así que compararlos byte a
            // byte contra el estado completo del servidor siempre fallaba, aunque el
            // group_admin no hubiera tocado nada ajeno (bug real, confirmado en vivo:
            // ni siquiera un guardado sin cambios pasaba). En vez de eso: se PRESERVA
            // lo que el servidor ya tenía para todo lo que no es del propio group_admin,
            // y solo se aplica lo suyo, tal como venga en el payload.
            bodyToSave = { ...current, ...incoming };
            for (const section of SCOPED_SECTIONS) {
                const currentOthers = (current[section] || []).filter(belongsToOther);
                const incomingOwn = (incoming[section] || []).filter(item => !belongsToOther(item));
                bodyToSave[section] = [...currentOthers, ...incomingOwn];
            }
            for (const key of GROUP_SCOPED_OBJECT_SECTIONS) {
                const currentObj = current[key] || {};
                const incomingOwn = (incoming[key] || {})[scope];
                bodyToSave[key] = { ...currentObj, [scope]: incomingOwn !== undefined ? incomingOwn : currentObj[scope] };
            }
        }

        const [configRow] = await Config.upsert({
            key: 'tms_config',
            value: bodyToSave
        });
        res.json(configRow.value);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al guardar la configuración' });
    }
});

// ─── RUTAS DE COMPAÑÍAS ──────────────────────────────────────────────────────

app.get('/api/companies', async (req, res) => {
    try {
        const companies = await Company.findAll();
        res.json(companies);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al obtener compañías' });
    }
});

app.post('/api/companies', requireAdmin, async (req, res) => {
    try {
        const company = await Company.create(req.body);
        res.status(201).json(company);
    } catch (error) {
        console.error(error);
        res.status(400).json({ error: 'Datos de compañía inválidos' });
    }
});

app.put('/api/companies/:id', requireAdmin, async (req, res) => {
    try {
        const company = await Company.findByPk(req.params.id);
        if (company) {
            await company.update(req.body);
            res.json(company);
        } else {
            res.status(404).json({ error: 'Compañía no encontrada' });
        }
    } catch (error) {
        console.error(error);
        res.status(400).json({ error: 'Error al actualizar compañía' });
    }
});

app.delete('/api/companies/:id', requireAdmin, async (req, res) => {
    try {
        const company = await Company.findByPk(req.params.id);
        if (company) {
            await company.destroy();
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Compañía no encontrada' });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al eliminar compañía' });
    }
});

// ─── RUTAS DE PERMISOS EXTRA (AreaAccesoExtra) ───────────────────────────────

app.get('/api/area-acceso-extra', requireAdmin, async (req, res) => {
    try {
        const accesos = await AreaAccesoExtra.findAll();
        res.json(accesos);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al obtener accesos extra' });
    }
});

app.post('/api/area-acceso-extra', requireAdmin, async (req, res) => {
    try {
        const acceso = await AreaAccesoExtra.create(req.body);
        res.status(201).json(acceso);
    } catch (error) {
        console.error(error);
        res.status(400).json({ error: 'Datos de acceso inválidos' });
    }
});

app.delete('/api/area-acceso-extra/:id', requireAdmin, async (req, res) => {
    try {
        const acceso = await AreaAccesoExtra.findByPk(req.params.id);
        if (acceso) {
            await acceso.destroy();
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Acceso no encontrado' });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al eliminar acceso extra' });
    }
});

// ─── RUTAS DE GRUPOS DE SOPORTE ──────────────────────────────────────────────

app.get('/api/groups', async (req, res) => {
    try {
        const groups = await Group.findAll();
        res.json(groups);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al obtener grupos' });
    }
});

app.post('/api/groups', requireAdmin, async (req, res) => {
    try {
        const group = await Group.create(req.body);
        res.status(201).json(group);
    } catch (error) {
        console.error(error);
        res.status(400).json({ error: 'Datos de grupo inválidos' });
    }
});

app.put('/api/groups/:id', requireAdmin, async (req, res) => {
    try {
        const group = await Group.findByPk(req.params.id);
        if (group) {
            // El módulo de un grupo es inmutable tras su creación: evita que un
            // grupo "migre" de Voltik a Volcán Desk (o viceversa) por una edición.
            const data = { ...req.body };
            delete data.modulo;
            await group.update(data);
            res.json(group);
        } else {
            res.status(404).json({ error: 'Grupo no encontrado' });
        }
    } catch (error) {
        console.error(error);
        res.status(400).json({ error: 'Error al actualizar grupo' });
    }
});

app.delete('/api/groups/:id', requireAdmin, async (req, res) => {
    try {
        const group = await Group.findByPk(req.params.id);
        if (group) {
            await group.destroy();
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Grupo no encontrado' });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al eliminar grupo' });
    }
});

// ─── RUTAS DE USUARIOS ───────────────────────────────────────────────────────

app.get('/api/users', requireAuthenticated, async (req, res) => {
    try {
        const users = await User.findAll({
            attributes: { exclude: ['password'] },
            include: [{ model: Company, attributes: ['id', 'name'] }]
        });
        res.json(users);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al obtener usuarios' });
    }
});

// Solo 'admin' (nunca 'group_admin') gestiona Usuarios — ver el comentario del
// campo User.role en db.js: "NO puede gestionar Usuarios (eso es exclusivo de
// 'admin')". Estas 3 rutas usaban requireAdminOrGroupAdmin (solo valida el rol,
// sin acotar a ningún grupo) — cualquier group_admin podía crear/editar/borrar
// CUALQUIER usuario, incluido volverse admin él mismo con un PUT a su propia
// cuenta. requireAdmin cierra esto exactamente como ya documentaba el modelo.
app.post('/api/users', requireAdmin, async (req, res) => {
    try {
        const user = await User.create(req.body);
        const { password: _pw, ...userWithoutPassword } = user.toJSON();
        res.status(201).json(userWithoutPassword);
    } catch (error) {
        console.error(error);
        res.status(400).json({ error: 'Datos de usuario inválidos' });
    }
});

app.put('/api/users/:id', requireAdmin, async (req, res) => {
    try {
        const user = await User.findByPk(req.params.id);
        if (user) {
            // El módulo de un usuario interno es inmutable tras su creación: evita
            // que un agente/supervisor "migre" de Voltik a Volcán Desk (o viceversa)
            // por una edición. Si la misma persona debe atender ambos módulos, se
            // crea una cuenta nueva para el otro módulo.
            const data = { ...req.body };
            delete data.modulo;
            await user.update(data);
            const { password: _pw, ...userWithoutPassword } = user.toJSON();
            res.json(userWithoutPassword);
        } else {
            res.status(404).json({ error: 'Usuario no encontrado' });
        }
    } catch (error) {
        console.error(error);
        res.status(400).json({ error: 'Error al actualizar usuario' });
    }
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
    try {
        const user = await User.findByPk(req.params.id);
        if (user) {
            await user.destroy();
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Usuario no encontrado' });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al eliminar usuario' });
    }
});

// ─── RUTAS DE TICKETS ────────────────────────────────────────────────────────

app.get('/api/tickets', requireAuthenticated, async (req, res) => {
    try {
        const { ambito } = req.query; // 'externo' o 'interno'
        const whereClause = {};
        // Se guarda para el post-filtro preciso de abajo (el LIKE de apoyos en el
        // whereClause solo puede buscar el id del grupo dentro del JSON crudo, no
        // si ese apoyo puntual ya quedó "Resuelto" — por eso trae de más y se
        // recorta después con la misma regla exacta que usa el frontend).
        let allowedGroupsForApoyoFilter = null;

        if (req.user.role === 'client') {
            // Client only sees 'externo' and only their own company/creator tickets
            whereClause.ambito = 'externo';
            const currentUser = await User.findByPk(req.user.id);
            if (currentUser && currentUser.companyId) {
                whereClause.companyId = currentUser.companyId;
            } else {
                whereClause.createdBy = req.user.id;
            }
        } else if (req.user.role) {
            // Agentes, supervisores, admin
            if (ambito === 'interno') {
                whereClause.ambito = 'interno';
                // Si NO es admin, filtrar por grupos y áreas extra
                if (req.user.role !== 'admin') {
                    const currentUser = await User.findByPk(req.user.id);
                    const userGroups = currentUser.groups || [];

                    const accesosExtra = await AreaAccesoExtra.findAll({ where: { usuario_id: req.user.id } });
                    const extraGroupIds = accesosExtra.map(a => a.area_id);
                    // group_admin: ve todos los tickets de su único grupo administrado, como un admin acotado.
                    const groupAdminScope = currentUser.role === 'group_admin' && currentUser.admin_group_id ? [currentUser.admin_group_id] : [];
                    const allowedGroups = [...userGroups, ...extraGroupIds, ...groupAdminScope];
                    allowedGroupsForApoyoFilter = allowedGroups;

                    // `group` puede venir como NOMBRE en vez de id (tickets viejos o
                    // tras un "Escalar/Transferir") — resolver_group_id es la fuente
                    // de verdad cuando existe. Sin esta condición, un ticket ya
                    // ruteado al grupo del usuario pero aún sin asignar a nadie no
                    // aparecía ni siquiera en el listado (mismo bug que ya se había
                    // corregido en checkTicketAccess/isAuthorizedResolverGroupMember,
                    // pero este endpoint arma su propio where-clause por separado).
                    whereClause[Op.or] = [
                        { group: { [Op.in]: allowedGroups } },
                        { resolver_group_id: { [Op.in]: allowedGroups } },
                        { area_origen_id: { [Op.in]: allowedGroups } },
                        { createdBy: req.user.id }, // Siempre puede ver los que él creó
                        ...allowedGroups.map(gid => Sequelize.where(Sequelize.cast(Sequelize.col('apoyos'), 'CHAR'), { [Op.like]: `%"grupo_solicitado":"${gid}"%` }))
                    ];
                }
            } else {
                whereClause.ambito = 'externo'; // Por defecto los internos ven los externos si no piden interno explícitamente
                // Un usuario interno fijado a Volcán Desk (User.modulo) nunca debe ver
                // tickets de Voltik — nada debe mezclarse entre los dos módulos. admin
                // es el único rol global sin modulo real, sigue viendo todo. Antes esta
                // rama no filtraba nada: cualquier agent/supervisor/group_admin de
                // Volcán Desk recibía TODOS los tickets de Voltik (con notas privadas
                // incluidas) con solo cargar la app, sin pedir ni manipular nada — se
                // veía con solo abrir la pestaña Red del navegador.
                if (req.user.role !== 'admin') {
                    const currentUser = await User.findByPk(req.user.id);
                    if ((currentUser?.modulo || 'voltik') !== 'voltik') {
                        return res.json([]);
                    }
                }
            }
        }

        const tickets = await Ticket.findAll({
            where: whereClause,
            include: [
                { model: User, as: 'Creator', attributes: ['id', 'name', 'role', 'avatar'] },
                { model: User, as: 'Agent', attributes: ['id', 'name', 'role', 'avatar'] },
                { model: User, as: 'OwnerAgent', attributes: ['id', 'name', 'role', 'avatar'] },
                { model: User, as: 'ResolverAgent', attributes: ['id', 'name', 'role', 'avatar'] },
                { model: Company, as: 'Company', attributes: ['id', 'name'] },
                { 
                    model: Comment, 
                    as: 'comments',
                    include: [{ model: User, attributes: ['id', 'name', 'role', 'avatar'] }] 
                },
                {
                    model: TicketCampoValor,
                    as: 'camposValores',
                    include: [{ model: CampoCatalogo, as: 'Campo' }]
                },
                { model: TicketBloqueoHistorial, as: 'bloqueos' }
            ],
            order: [['createdAt', 'DESC']]
        });
        // Recorte preciso: el whereClause de arriba puede traer de más para el
        // OR de apoyos (el LIKE solo ve si el id del grupo aparece en algún
        // lado del JSON, sin importar su status) — aquí sí se descarta un
        // ticket que SOLO calificaba por un apoyo ya "Resuelto" y ninguna otra
        // razón real (grupo resolutor, área origen, o ser el creador). Caso
        // reportado en vivo: un group_admin seguía viendo en su bandeja un
        // ticket de otro grupo cuyo apoyo ya había marcado como resuelto.
        const finalTickets = allowedGroupsForApoyoFilter
            ? tickets.filter(t => {
                const effectiveGroupId = t.resolver_group_id || t.group;
                const hasActiveApoyo = (t.apoyos || []).some(a =>
                    allowedGroupsForApoyoFilter.includes(a.grupo_solicitado) && a.status !== 'Resuelto'
                );
                return allowedGroupsForApoyoFilter.includes(effectiveGroupId)
                    || allowedGroupsForApoyoFilter.includes(t.area_origen_id)
                    || t.createdBy === req.user.id
                    || hasActiveApoyo;
            })
            : tickets;

        const ctx = await getUserGroupContext(req.user);
        res.json(finalTickets.map(t => sanitizeTicketForUser(t.toJSON(), req.user, ctx)));
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al obtener tickets' });
    }
});

app.get('/api/tickets/:id', requireAuthenticated, async (req, res) => {
    try {
        const ticket = await Ticket.findByPk(req.params.id, {
            include: [
                { model: User, as: 'Creator', attributes: ['id', 'name', 'role', 'avatar'] },
                { model: User, as: 'Agent', attributes: ['id', 'name', 'role', 'avatar'] },
                { model: User, as: 'OwnerAgent', attributes: ['id', 'name', 'role', 'avatar'] },
                { model: User, as: 'ResolverAgent', attributes: ['id', 'name', 'role', 'avatar'] },
                { model: Company, as: 'Company', attributes: ['id', 'name'] },
                {
                    model: Comment,
                    as: 'comments',
                    include: [{ model: User, attributes: ['id', 'name', 'role', 'avatar'] }]
                },
                {
                    model: TicketCampoValor,
                    as: 'camposValores',
                    include: [{ model: CampoCatalogo, as: 'Campo' }]
                },
                { model: TicketBloqueoHistorial, as: 'bloqueos' }
            ]
        });
        if (!ticket) {
            return res.status(404).json({ error: 'Ticket no encontrado' });
        }
        const allowed = await checkTicketAccess(ticket, req.user);
        if (!allowed) {
            return res.status(403).json({ error: 'No tienes permisos para ver este ticket.' });
        }
        const ctx = await getUserGroupContext(req.user);
        res.json(sanitizeTicketForUser(ticket.toJSON(), req.user, ctx));
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al obtener el ticket' });
    }
});

// ─── EXPORTACIÓN PARA SISTEMA EXTERNO (Volcán Desk, agregado 2026-08-27) ─────
// Mismos campos que ya genera el botón "Exportar CSV" de Tickets.jsx
// (handleExportCSV) — labels ya resueltos (Prioridad/Categoría/Tipo/Estado como
// texto, no ids crudos), nunca comments/activities/apoyos/camposValores. Solo
// Volcán Desk (ambito='interno') — Voltik no se toca. Filtra por el grupo
// RESOLUTOR (resolver_group_id || group), el mismo criterio de "a qué grupo
// pertenece este ticket" usado en todo el resto de la app.
const EXPORT_STATUS_LABELS = {
    to_do: 'Pendiente',
    on_going: 'En ejecución',
    in_testing: 'Pruebas técnicas',
    under_review: 'Revisión (funcional o de negocio)',
    done: 'Terminado',
};

// Puerto server-side de computeSlaStatus (frontend/src/services/ticketService.js) +
// slaLabelFor (Tickets.jsx) — agregado 2026-08-27 a pedido del usuario, para que
// "SLA Resolucion" en esta API sea el mismo estado EN VIVO que ya muestra el CSV,
// no solo el objetivo estático. Resulta que NO tiene lógica de horario hábil (una
// suposición mía anterior, incorrecta) — es reloj de pared menos el tiempo pausado
// por Bloqueo, así que se pudo replicar completo, no solo una aproximación. Solo
// cubre la rama de Volcán Desk (ambito='interno'), que es todo lo que esta ruta
// necesita — la rama de Voltik (SLA por Prioridad) no se portó.
const isDeskTerminalStatus = (status) => status === 'done'; // único behavior:'terminal' en INTERNAL_STATUSES

// Copia server-side del catálogo fijo MOTIVO_BLOQUEO_OPTIONS de
// frontend/src/services/configService.js (no vive en Config.value — es fijo, igual
// que INTERNAL_STATUSES/EXPORT_STATUS_LABELS arriba).
const EXPORT_MOTIVO_BLOQUEO_LABELS = {
    waiting_approval: 'Esperando aprobación',
    waiting_feedback: 'Esperando feedback',
    on_hold: 'En espera',
};

// Momento efectivo de "fin" de un ticket: ahora mismo si sigue activo, o el
// timestamp real de cuando pasó a un estado terminal ('done') si ya se resolvió —
// buscado en su historial de actividad (mismo criterio que ya usaba
// computeSlaStatusExport). Compartido con "Dias en proceso" (más abajo) para que
// ambos campos se congelen en el mismo momento al cerrar un ticket, en vez de
// que "Dias en proceso" siguiera sumando después de resuelto (bug reportado en
// vivo 2026-08-27 — el nombre del campo ya implicaba que debía congelarse).
const getTicketEndTime = (ticket) => {
    if (!isDeskTerminalStatus(ticket.status)) return Date.now();
    // `fecha_resolucion` es la fuente de verdad: el server la estampa solo (ver
    // PUT /api/tickets/:id) el instante exacto en que el ticket entra a un estado
    // terminal — no depende de reconstruir nada del historial. Confirmado 2026-08-27
    // contra datos reales: coincide exacto con el cierre real de un ticket de
    // prueba. Se prefiere sobre el escaneo de activities de abajo, que se deja
    // solo como respaldo (tickets viejos donde por lo que sea no quedó estampada).
    if (ticket.fecha_resolucion) {
        return new Date(ticket.fecha_resolucion).getTime();
    }
    // Respaldo: buscar el último cambio de Estado a un valor terminal en el
    // historial. Los cambios de estado se registran por el tracking genérico de
    // campos (TRACKED_TICKET_FIELDS en server.js), NO con type:'status_change'
    // (ese type nunca existió en ningún activity real — bug confirmado y
    // corregido 2026-08-27, el mismo que tenía computeSlaStatus en
    // ticketService.js del frontend).
    const statusActivities = (ticket.activities || [])
        .filter(a => a.type === 'campo_editado' && a.data?.field === 'Estado')
        .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    const lastAct = statusActivities[statusActivities.length - 1];
    if (lastAct && isDeskTerminalStatus(lastAct.data?.to)) {
        return new Date(lastAct.ts).getTime();
    }
    return Date.now();
};

const computeSlaStatusExport = (ticket, cfg) => {
    const catConf = (cfg.categories || []).find(c => c.id === ticket.category);
    const noSlaConfigured = !catConf || catConf.slaMinutes == null;
    const targetMinutes = noSlaConfigured ? 1440 : catConf.slaMinutes;

    const endTime = getTicketEndTime(ticket);
    let elapsedMinutes = (endTime - new Date(ticket.createdAt).getTime()) / 60000;

    if (Array.isArray(ticket.bloqueos) && ticket.bloqueos.length > 0) {
        const capMinutes = cfg.groupBloqueoCaps?.[ticket.resolver_group_id || ticket.group];
        const capMs = (capMinutes != null && capMinutes > 0) ? capMinutes * 60000 : null;
        let totalBloqueoMs = 0;
        ticket.bloqueos.forEach(b => {
            if (b.bloqueado_desde) {
                const start = new Date(b.bloqueado_desde).getTime();
                let end = b.bloqueado_hasta ? new Date(b.bloqueado_hasta).getTime() : endTime;
                if (end > endTime) end = endTime;
                if (start < endTime) {
                    let durationMs = end - start;
                    if (capMs !== null && durationMs > capMs) durationMs = capMs;
                    totalBloqueoMs += durationMs;
                }
            }
        });
        elapsedMinutes = Math.max(0, elapsedMinutes - (totalBloqueoMs / 60000));
    }

    if (noSlaConfigured || targetMinutes === 0) {
        return { targetMinutes: noSlaConfigured ? null : 0, status: 'ok' };
    }

    const percentage = Math.min((elapsedMinutes / targetMinutes) * 100, 100);
    const status = percentage >= 100 ? 'breached' : percentage >= 80 ? 'warning' : 'ok';
    return { targetMinutes, status };
};

const SLA_STATUS_LABELS = { ok: 'En tiempo', warning: 'Próximo a vencer', breached: 'Vencido' };
const slaLabelExport = (ticket, cfg) => {
    const sla = computeSlaStatusExport(ticket, cfg);
    if (sla.targetMinutes === null) return 'Sin SLA';
    if (sla.targetMinutes === 0) return 'Sin límite';
    const targetHours = Math.round((sla.targetMinutes / 60) * 10) / 10;
    return `${SLA_STATUS_LABELS[sla.status] || sla.status} (objetivo ${targetHours}h)`;
};

// Diferencia en días de FECHA DE CALENDARIO (hora del servidor, misma zona que
// toLocaleDateString('es-MX') usa para "Fecha de creacion" abajo) entre dos
// fechas — no en periodos de 24h exactas. Ver "Dias en proceso" más abajo.
const daysBetweenCalendarDates = (a, b) => {
    const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return Math.round((startOfDay(b) - startOfDay(a)) / 86400000);
};

// Fecha del comentario PÚBLICO más reciente de un "lado" del ticket — nunca notas
// privadas (isPrivate). "Del solicitante" = comentarios de quien creó el ticket
// (createdBy); "del resolutor" = cualquier comentario público de alguien más
// (mismo criterio binario que ya usa el sistema de correos — emailService.js /
// isCreator en server.js — para decidir a quién avisar de una respuesta nueva).
const lastPublicReplyFrom = (ticket, side) => {
    const matches = (ticket.comments || []).filter(c => {
        if (c.isPrivate) return false;
        const isFromRequester = c.userId === ticket.createdBy;
        return side === 'solicitante' ? isFromRequester : !isFromRequester;
    });
    if (matches.length === 0) return null;
    return matches.reduce((latest, c) => (new Date(c.createdAt) > new Date(latest.createdAt) ? c : latest)).createdAt;
};

app.get('/api/export/tickets', requireExportApiKey, async (req, res) => {
    try {
        const { groupId } = req.query;
        const whereClause = { ambito: 'interno' };
        if (groupId) {
            whereClause[Op.or] = [
                { resolver_group_id: groupId },
                { resolver_group_id: null, group: groupId },
            ];
        }

        const [tickets, configRow, groups] = await Promise.all([
            Ticket.findAll({
                where: whereClause,
                include: [
                    { model: User, as: 'Creator', attributes: ['name'] },
                    { model: User, as: 'Agent', attributes: ['name'] },
                    { model: TicketBloqueoHistorial, as: 'bloqueos' },
                    // Solo para derivar "Ultima respuesta del resolutor/solicitante" abajo
                    // — el contenido de los comentarios (text/attachments) nunca se pide ni
                    // se expone, igual que el resto de esta ruta.
                    { model: Comment, as: 'comments', attributes: ['userId', 'createdAt', 'isPrivate'] },
                ],
                order: [['createdAt', 'DESC']],
            }),
            Config.findByPk('tms_config'),
            Group.findAll({ attributes: ['id', 'name'] }),
        ]);

        const cfg = configRow?.value || {};
        const groupName = (id) => id ? (groups.find(g => g.id === id)?.name || id) : '';
        const catalogLabel = (list, idOrLabel) => {
            if (!idOrLabel) return '';
            const match = (list || []).find(x => x.id === idOrLabel);
            return match ? match.label : idOrLabel;
        };
        const priorityLabel = (value) => {
            if (!value) return 'Sin prioridad';
            const match = (cfg.priorities || []).find(p => p.value === value || p.id === value);
            return match ? match.label : value;
        };

        const data = tickets.map(t => {
            const created = t.createdAt ? new Date(t.createdAt) : null;
            return {
                Codigo: t.id,
                Asunto: t.title,
                'Grupo solicitante': groupName(t.area_origen_id),
                'Grupo resolutor': groupName(t.resolver_group_id || t.group),
                Tipo: catalogLabel(cfg.types, t.type),
                Categoria: catalogLabel(cfg.categories, t.category),
                Producto: t.product || '',
                Prioridad: priorityLabel(t.priority),
                Estado: EXPORT_STATUS_LABELS[t.status] || t.status,
                // "Etiquetas" en la app — el subestado configurable por estado
                // (config.deskSubStatuses[status]), no un catálogo fijo. Un ticket
                // puede tener más de uno (es multiselect); se unen con coma. Vacío si
                // no tiene ninguno asignado.
                Subestado: (t.etiquetas || [])
                    .map(e => (cfg.deskSubStatuses?.[t.status] || []).find(o => o.value === e)?.label || e)
                    .join(', '),
                Solicitante: t.Creator?.name || t.createdBy || 'Desconocido',
                'Fecha de creacion': created ? created.toLocaleDateString('es-MX') : '',
                'Hora de creacion': created ? created.toLocaleTimeString('es-MX') : '',
                'Asignado A': t.Agent?.name || (t.assignedTo ? t.assignedTo : 'Sin asignar'),
                // A pedido del usuario: la fecha real de cierre, visible (antes solo se
                // usaba internamente para calcular SLA Resolucion/Dias en proceso). Viene
                // de fecha_resolucion (la estampa el server solo al pasar a terminal) —
                // vacío mientras el ticket siga activo.
                'Fecha de resolucion': t.fecha_resolucion ? new Date(t.fecha_resolucion).toLocaleDateString('es-MX') : '',
                'Hora de resolucion': t.fecha_resolucion ? new Date(t.fecha_resolucion).toLocaleTimeString('es-MX') : '',
                // Última respuesta PÚBLICA de cada lado — nunca notas privadas, ni la
                // "estampa" pública de "Solicitar apoyo" cuenta como respuesta de nadie en
                // particular salvo que coincida con el criterio de arriba (es un comentario
                // público normal como cualquier otro, así que si lo escribió el
                // solicitante/resolutor sí se contabiliza igual). Vacío si ese lado nunca
                // respondió públicamente.
                'Ultima respuesta del resolutor': (() => {
                    const d = lastPublicReplyFrom(t, 'resolutor');
                    return d ? new Date(d).toLocaleString('es-MX') : '';
                })(),
                'Ultima respuesta del solicitante': (() => {
                    const d = lastPublicReplyFrom(t, 'solicitante');
                    return d ? new Date(d).toLocaleString('es-MX') : '';
                })(),
                'Fecha estimada de inicio': t.fecha_estimada_inicio || '',
                'Fecha estimada de conclusion': t.fecha_estimada_conclusion || '',
                'Estimacion HUs (horas)': t.estimacion_hus ?? '',
                'SLA Resolucion': slaLabelExport(t, cfg),
                // A pedido del usuario: diferencia de FECHA de calendario (no de 24h
                // exactas) entre hoy y la fecha de creación — un ticket creado "ayer" ya
                // cuenta como 1 día sin importar la hora exacta. Corregido 2026-08-27: la
                // primera versión restaba milisegundos exactos y redondeaba hacia abajo,
                // así que dos tickets con fechas de calendario distintas (ej. creados
                // 26/8 7pm y 27/8 2pm — menos de 24h de diferencia real entre sí) podían
                // mostrar el mismo número de días, algo que se reportó como confuso en
                // vivo. Sin restar pausas de Bloqueo (eso ya lo cubre "SLA Resolucion"
                // aparte) — sigue avanzando mientras esté Bloqueado, pero se CONGELA al
                // llegar a Terminado (usa getTicketEndTime, mismo criterio que "SLA
                // Resolucion") — corregido 2026-08-27: el nombre "en proceso" ya implicaba
                // que debía detenerse al dejar de estarlo, y la primera versión seguía
                // sumando días indefinidamente después de resuelto.
                'Dias en proceso': created ? daysBetweenCalendarDates(created, new Date(getTicketEndTime(t))) : '',
                // Los 3 siguientes se agregaron a pedido del usuario, sugeridos por Claude
                // como enriquecimiento adicional del export (2026-08-27).
                Bloqueado: t.bloqueado ? 'Sí' : 'No',
                'Motivo de bloqueo': t.bloqueado ? (EXPORT_MOTIVO_BLOQUEO_LABELS[t.motivo_bloqueo] || t.motivo_bloqueo || '') : '',
                // Cuenta de veces que cambió de grupo resolutor — señal de calidad/recorrido
                // del ticket, no el detalle de cada escalamiento (eso sigue sin exponerse).
                'Veces escalado': (t.activities || []).filter(a => a.type === 'escalamiento').length,
                // Último toque de CUALQUIER tipo (edición de campo, comentario, bloqueo,
                // escalamiento...) — a diferencia de "Ultima respuesta del resolutor/
                // solicitante" (solo respuestas públicas), esto marca actividad de cualquier
                // clase, útil para detectar tickets abandonados sin que necesariamente haya
                // habido conversación.
                'Ultima actualizacion': t.updatedAt ? new Date(t.updatedAt).toLocaleString('es-MX') : '',
            };
        });

        res.json(data);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al exportar tickets.' });
    }
});

// La vista pública de solo lectura (POST/DELETE /api/tickets/:id/public-token,
// GET /api/public/tickets/:token) se agregó aquí el 2026-08-27 y se REVIRTIÓ el
// mismo día — el campo Ticket.public_share_token que necesitaba nunca se creó en
// la tabla real (ver el comentario largo en db.js), y como todas las consultas de
// tickets seleccionan todas las columnas del modelo, tumbó GET /api/tickets y
// GET /api/tickets/:id enteros hasta revertir. Pendiente reintentar una vez
// resuelto por qué sequelize.sync({ alter: true }) no aplicó el ALTER TABLE.

app.post('/api/tickets', requireAuthenticated, async (req, res) => {
    try {
        const data = { ...req.body };
        
        // SECURITY: If user is client, prevent them from setting ambito = 'interno'
        if (req.user.role === 'client') {
            if (data.ambito === 'interno') {
                return res.status(403).json({ error: 'Acceso denegado. Los clientes no pueden crear tickets internos.' });
            }
            data.ambito = 'externo';
            data.createdBy = req.user.id;
        }

        // Procesar y decodificar adjuntos si los hay
        if (data.attachments && data.attachments.length > 0) {
            data.attachments = processAttachments(data.attachments);
        }
        // Initialize owner and resolver logic
        if (data.assignedTo && !data.owner_agent_id) {
            data.owner_agent_id = data.assignedTo;
        }
        if (data.assignedTo && !data.resolver_agent_id) {
            data.resolver_agent_id = data.assignedTo;
        }
        if (data.group && !data.resolver_group_id) {
            data.resolver_group_id = data.group;
        }
        const creator = await User.findByPk(data.createdBy);
        const isCreatorClient = creator ? creator.role === 'client' : true;
        data.ultimo_mensaje_de = isCreatorClient ? 'cliente' : 'agente';
        data.ultimo_mensaje_at = new Date();
        data.visto_por_agente = isCreatorClient ? false : true;
        data.visto_por_cliente = isCreatorClient ? true : false;

        // El folio de Volcán Desk (VD-<grupo origen>-<consecutivo GLOBAL>) llega ya
        // calculado por el cliente (ticketService.js), leyendo su caché local de
        // tickets — que puede estar desactualizada. Dos creaciones casi simultáneas
        // (antes del próximo polling de 8s) pueden calcular el MISMO próximo número
        // y chocar contra la primary key (auditoría 2026-08-27). Como el server es
        // quien de verdad decide si el id ya existe, se recalcula aquí — con
        // reintento ante choque — para que sea la fuente única de verdad, no el
        // cliente. El prefijo (grupo origen) se conserva tal cual llegó; solo el
        // consecutivo numérico se recalcula.
        let ticket;
        if (data.ambito === 'interno' && typeof data.id === 'string' && data.id.startsWith('VD-')) {
            const prefix = data.id.substring(0, data.id.lastIndexOf('-') + 1);
            for (let attempt = 1; attempt <= 5 && !ticket; attempt++) {
                const existing = await Ticket.findAll({ where: { ambito: 'interno' }, attributes: ['id'] });
                let maxNum = 0;
                existing.forEach(t => {
                    if (typeof t.id === 'string' && t.id.startsWith('VD-')) {
                        const parts = t.id.split('-');
                        const num = parseInt(parts[parts.length - 1], 10);
                        if (!isNaN(num) && num > maxNum) maxNum = num;
                    }
                });
                data.id = `${prefix}${String(maxNum + 1).padStart(6, '0')}`;
                try {
                    ticket = await Ticket.create(data);
                } catch (e) {
                    if (e.name !== 'SequelizeUniqueConstraintError' || attempt === 5) throw e;
                    // Otro request ganó la carrera con ese número — recalcular y reintentar.
                }
            }
        } else {
            ticket = await Ticket.create(data);
        }

        // Save dynamic field values
        if (req.body.camposValores && typeof req.body.camposValores === 'object') {
            const fieldInserts = Object.keys(req.body.camposValores).map(campoId => ({
                ticket_id: ticket.id,
                campo_id: campoId,
                valor: processCampoArchivoValue(req.body.camposValores[campoId])
            }));
            if (fieldInserts.length > 0) {
                await TicketCampoValor.bulkCreate(fieldInserts);
            }
        }

        const createdTicket = await Ticket.findByPk(ticket.id, {
            include: [
                { model: User, as: 'Creator', attributes: ['id', 'name', 'role', 'avatar'] },
                { model: User, as: 'Agent', attributes: ['id', 'name', 'role', 'avatar'] },
                { model: User, as: 'OwnerAgent', attributes: ['id', 'name', 'role', 'avatar'] },
                { model: User, as: 'ResolverAgent', attributes: ['id', 'name', 'role', 'avatar'] },
                { model: Company, as: 'Company', attributes: ['id', 'name'] },
                { 
                    model: Comment, 
                    as: 'comments',
                    include: [{ model: User, attributes: ['id', 'name', 'role', 'avatar'] }] 
                },
                {
                    model: TicketCampoValor,
                    as: 'camposValores',
                    include: [{ model: CampoCatalogo, as: 'Campo' }]
                },
                { model: TicketBloqueoHistorial, as: 'bloqueos' }
            ]
        });

        // Enviar notificaciones de correo de forma asíncrona — solo Volcán Desk
        // (auditoría 2026-08-27: antes no había ningún chequeo de ambito, así que un
        // ticket de Voltik con owner_agent_id o resolver_group_id/group también
        // disparaba estos correos con branding "Volcán Desk", mezclando los módulos).
        if (createdTicket.ambito === 'interno') (async () => {
            try {
                const creatorName = createdTicket.Creator ? createdTicket.Creator.name : 'Usuario';

                if (createdTicket.owner_agent_id) {
                    // Ya tiene un usuario resolutor asignado
                    const targetGroup = createdTicket.resolver_group_id || createdTicket.group;
                    if (await isGroupEmailEventEnabled(targetGroup, 'nuevoTicketAsignado')) {
                        const assignedUser = await User.findByPk(createdTicket.owner_agent_id);
                        if (assignedUser && assignedUser.email) {
                            const html = emailService.templates.newTicketUser(createdTicket, assignedUser, creatorName);
                            await emailService.sendHtmlEmail(assignedUser.email, `[Nuevo Ticket] ${createdTicket.id}: ${createdTicket.title}`, html);
                        }
                    }
                } else if (createdTicket.resolver_group_id || createdTicket.group) {
                    // Opción A: No tiene usuario, notificar a todos los del grupo
                    const targetGroup = createdTicket.resolver_group_id || createdTicket.group;
                    if (await isGroupEmailEventEnabled(targetGroup, 'nuevoTicketSinAsignar')) {
                        const allUsers = await User.findAll({
                            where: { role: { [Op.in]: ['group_admin', 'agent', 'supervisor'] } }
                        });

                        const membersToNotify = allUsers.filter(u => {
                            if (u.role === 'group_admin' && u.admin_group_id === targetGroup) return true;
                            if (u.groups && Array.isArray(u.groups) && u.groups.includes(targetGroup)) return true;
                            return false;
                        });

                        if (membersToNotify.length > 0) {
                            let groupName = 'el Grupo';
                            if (Group) {
                                const groupInfo = await Group.findByPk(targetGroup);
                                if (groupInfo) groupName = groupInfo.name;
                            }

                            const html = emailService.templates.newTicketGroup(createdTicket, groupName, creatorName);
                            await Promise.all(membersToNotify.map(async u => {
                                if (u.email) {
                                    await emailService.sendHtmlEmail(u.email, `[Bandeja de Grupo] Nuevo Ticket ${createdTicket.id}`, html);
                                }
                            }));
                        }
                    }
                }
            } catch (err) {
                console.error("Error enviando notificaciones de nuevo ticket:", err);
            }
        })();

        const createCtx = await getUserGroupContext(req.user);
        res.status(201).json(sanitizeTicketForUser(createdTicket.toJSON(), req.user, createCtx));
    } catch (error) {
        console.error(error);
        res.status(400).json({ error: 'Datos de ticket inválidos' });
    }
});

app.put('/api/tickets/:id', requireAuthenticated, async (req, res) => {
    try {
        const ticket = await Ticket.findByPk(req.params.id);
        if (!ticket) {
            return res.status(404).json({ error: 'Ticket no encontrado' });
        }

        const allowed = await checkTicketAccess(ticket, req.user);
        if (!allowed) {
            return res.status(403).json({ error: 'No tienes permisos para modificar este ticket.' });
        }

        const data = { ...req.body };
        // Adjuntos que este ticket tenía ANTES de aplicar la actualización — se
        // compara contra los que queden después para saber cuáles se quitaron y
        // limpiar su archivo físico si ya nadie más lo referencia (ver
        // deleteAttachmentFileIfOrphaned más abajo).
        const oldAttachmentUrls = (ticket.attachments || []).map(a => a?.fileUrl).filter(Boolean);
        // El cliente jamás controla el log de actividad ni el ámbito del ticket.
        // fecha_resolucion tampoco es editable directamente: solo la estampa el server más abajo.
        delete data.activities;
        delete data.fecha_resolucion;
        if (req.user.role === 'client') {
            if (data.ambito === 'interno') data.ambito = 'externo';
            RESTRICTED_TICKET_FIELDS.forEach(field => delete data[field]);
        }

        const isInternalUser = ['admin', 'group_admin', 'agent', 'supervisor'].includes(req.user.role);
        const now = new Date();
        const newActivities = [];

        // ─── VALIDACIÓN: "Tomar ticket" / "Cambiar responsable" (Volcán Desk) ───
        // Solo un miembro autorizado del grupo resolutor ACTUAL puede tomar o
        // reasignar, y el nuevo responsable debe pertenecer a ese mismo grupo
        // (doc "lógica de visualización" §5-7, CA05/CA08). Esto NO aplica cuando
        // también cambia el grupo resolutor en el mismo request — ese caso (escalar)
        // se valida más abajo, contra el grupo DESTINO.
        // "=== undefined" originalmente exigía que resolver_group_id viniera AUSENTE
        // del payload para activar esta validación — pero si el caller lo reenvía con
        // el mismo valor que ya tiene el ticket (sin cambiarlo), la condición también
        // fallaba (undefined !== <valor>) y el chequeo se saltaba por completo. Con
        // eso, cualquier interno con solo acceso de lectura al ticket (p. ej. el
        // solicitante) podía reasignar resolver_agent_id con un PUT que además
        // "reenviara" el resolver_group_id actual sin cambio real. Comparar contra el
        // valor actual (no solo contra "ausente") cierra ese hueco.
        if (ticket.ambito === 'interno' && isInternalUser && data.resolver_agent_id !== undefined
            && (data.resolver_group_id === undefined || data.resolver_group_id === ticket.resolver_group_id)
            && data.resolver_agent_id !== ticket.resolver_agent_id) {
            const actorAllowed = await isAuthorizedResolverGroupMember(ticket, req.user);
            if (!actorAllowed) {
                return res.status(403).json({ error: 'Solo un miembro del grupo resolutor puede tomar o reasignar este ticket.' });
            }
            if (data.resolver_agent_id) {
                const targetUser = await User.findByPk(data.resolver_agent_id);
                const effectiveGroupId = ticket.resolver_group_id || ticket.group;
                const targetInGroup = targetUser?.role === 'admin' || (targetUser?.groups || []).includes(effectiveGroupId);
                if (!targetInGroup) {
                    return res.status(403).json({ error: 'El responsable debe pertenecer al grupo resolutor del ticket.' });
                }
            }
        }

        // ─── VALIDACIÓN: campos exclusivos del grupo resolutor (Volcán Desk) ───
        // Doc "lógica de visualización" §16 "Regla de oro" + CA07/CA11/CA12: el
        // solicitante puede VER y RESPONDER su ticket, pero status/prioridad/
        // categoría/tipo/bloqueo/etiquetas/fechas estimadas son del resorte del
        // grupo resolutor — no del solicitante ni de cualquier interno con acceso
        // de lectura. Antes solo resolver_agent_id/resolver_group_id tenían esta
        // verificación explícita (arriba); el resto solo dependía de
        // checkTicketAccess, que también es true para el creador del ticket (a
        // propósito, para que pueda verlo y responder), así que el creador podía
        // escribir estos campos directo por API aunque el frontend no le
        // mostrara el control para hacerlo.
        const RESOLVER_ONLY_FIELDS = ['status', 'priority', 'category', 'type', 'product', 'bloqueado', 'motivo_bloqueo', 'etiquetas', 'fecha_estimada_inicio', 'fecha_estimada_conclusion', 'estimacion_hus'];
        // Mismo bypass que arriba: "=== undefined" solo cubría resolver_group_id
        // AUSENTE del payload — reenviarlo con el valor que el ticket ya tiene (sin
        // escalar de verdad) también hacía data.resolver_group_id !== undefined y
        // saltaba este bloque entero, dejando RESOLVER_ONLY_FIELDS (status, prioridad,
        // bloqueo, estimacion_hus, etc.) sin ninguna validación de quién puede
        // tocarlos. Confirmado explotable por cualquier interno con solo acceso de
        // lectura al ticket (p. ej. el propio solicitante).
        if (ticket.ambito === 'interno' && isInternalUser
            && (data.resolver_group_id === undefined || data.resolver_group_id === ticket.resolver_group_id)) {
            const touchedRestricted = RESOLVER_ONLY_FIELDS.some(f => data[f] !== undefined && JSON.stringify(data[f]) !== JSON.stringify(ticket[f]));
            if (touchedRestricted) {
                const actorAllowed = await isAuthorizedResolverGroupMember(ticket, req.user);
                if (!actorAllowed) {
                    return res.status(403).json({ error: 'Solo un miembro del grupo resolutor puede modificar estos campos del ticket.' });
                }
            }
        }

        // ─── ESCALAMIENTO / TRANSFERENCIA DE PROPIEDAD (revalidado en servidor) ───
        const isEscalation = isInternalUser && data.resolver_group_id !== undefined && data.resolver_group_id !== ticket.resolver_group_id;
        if (isEscalation) {
            if (ticket.ambito === 'interno') {
                const actorAllowed = await isAuthorizedResolverGroupMember(ticket, req.user);
                if (!actorAllowed) {
                    return res.status(403).json({ error: 'Solo un miembro del grupo resolutor actual puede escalar este ticket.' });
                }
            }
            const targetGroup = await Group.findByPk(data.resolver_group_id);
            // Bug encontrado en pruebas en vivo: Voltik y Volcán Desk pueden tener grupos con
            // el mismo nombre pero IDs distintos ("BI & Development" en ambos) — sin esta
            // validación era posible escalar un ticket interno hacia un grupo de Voltik (o
            // viceversa) y dejar resolver_group_id apuntando al módulo equivocado.
            const expectedModulo = ticket.ambito === 'interno' ? 'volcan_desk' : 'voltik';
            if (targetGroup && (targetGroup.modulo || 'voltik') !== expectedModulo) {
                return res.status(400).json({ error: 'El grupo destino no pertenece al mismo módulo (Voltik / Volcán Desk) que el ticket.' });
            }
            const transfiere = !!(targetGroup && targetGroup.transfiere_propiedad);
            // Al escalar/cambiar de grupo resolutor, el responsable vuelve a "Sin
            // asignar" por defecto (para que el grupo destino pueda tomarlo) — el
            // responsable anterior NO se conserva a menos que el caller elija
            // explícitamente un nuevo agente en el mismo request (doc "lógica de
            // visualización" §8/§9, CA09).
            const targetAgentId = data.resolver_agent_id || data.assignedTo || null;
            const [actorUser, targetAgent] = await Promise.all([
                User.findByPk(req.user.id),
                targetAgentId ? User.findByPk(targetAgentId) : null
            ]);
            // Si además se eligió un agente destino, debe pertenecer al grupo NUEVO
            // (no al viejo) — no tendría sentido asignar al grupo B un responsable
            // que solo pertenece al grupo A.
            if (ticket.ambito === 'interno' && targetAgentId && targetAgent?.role !== 'admin') {
                const targetInNewGroup = (targetAgent?.groups || []).includes(data.resolver_group_id);
                if (!targetInNewGroup) {
                    return res.status(403).json({ error: 'El agente destino debe pertenecer al grupo al que se está escalando.' });
                }
            }
            const groupName = targetGroup?.name || data.group || ticket.group;

            if (transfiere) {
                data.previous_owner_id = ticket.owner_agent_id;
                data.owner_agent_id = targetAgentId;
            } else {
                // Ignorar cualquier owner_agent_id/previous_owner_id que el cliente API haya intentado forzar
                data.owner_agent_id = ticket.owner_agent_id;
                data.previous_owner_id = ticket.previous_owner_id;
            }
            data.resolver_agent_id = targetAgentId;
            data.assignedTo = targetAgentId;
            data.group = groupName;

            newActivities.push({
                id: crypto.randomUUID(),
                type: transfiere ? 'transferencia_propiedad' : 'escalamiento',
                userId: req.user.id,
                ts: now,
                data: {
                    actor: actorUser?.name || 'Agente',
                    groupDest: groupName,
                    agentDest: targetAgent?.name || 'Sin asignar'
                }
            });
        } else {
            // ─── EDICIÓN DE CAMPOS INDIVIDUALES (no es un escalamiento) ───
            TRACKED_TICKET_FIELDS.forEach(({ key, label }) => {
                if (data[key] !== undefined && data[key] !== ticket[key]) {
                    newActivities.push({
                        id: crypto.randomUUID(),
                        type: 'campo_editado',
                        userId: req.user.id,
                        ts: now,
                        data: { field: label, from: ticket[key] ?? 'Ninguno', to: data[key] ?? 'Ninguno' }
                    });
                }
            });
        }

        // ─── SOLICITAR APOYO A OTRO GRUPO ───
        // No es ni un campo de TRACKED_TICKET_FIELDS ni una escalación (el
        // resolver_group_id no cambia), así que necesita su propia entrada de
        // actividad — solo cuando se AGREGA un apoyo nuevo, no cuando solo
        // cambia el estado de uno ya existente (ni cuando se auto-resuelven al
        // cerrar el ticket, ver ticketService.updateTicket en el frontend).
        if (data.apoyos !== undefined) {
            const oldApoyosArr = Array.isArray(ticket.apoyos) ? ticket.apoyos : [];
            if (data.apoyos.length > oldApoyosArr.length) {
                const addedApoyo = data.apoyos[data.apoyos.length - 1];
                const apoyoGroup = await Group.findByPk(addedApoyo.grupo_solicitado);
                newActivities.push({
                    id: crypto.randomUUID(),
                    type: 'apoyo_solicitado',
                    userId: req.user.id,
                    ts: now,
                    data: { grupoConsultado: apoyoGroup?.name || addedApoyo.grupo_solicitado }
                });
            }
        }

        data.activities = [...(ticket.activities || []), ...newActivities];

        if (data.attachments && data.attachments.length > 0) {
            data.attachments = processAttachments(data.attachments);
        }

        // ─── HISTORIAL DE BLOQUEOS (abre/cierra registro en cada transición) ───
        if (data.bloqueado !== undefined && data.bloqueado !== ticket.bloqueado) {
            if (data.bloqueado === true) {
                await TicketBloqueoHistorial.create({
                    ticket_id: ticket.id,
                    motivo: data.motivo_bloqueo || ticket.motivo_bloqueo || null,
                    bloqueado_desde: now,
                    bloqueado_hasta: null
                });
            } else {
                const openRecord = await TicketBloqueoHistorial.findOne({
                    where: { ticket_id: ticket.id, bloqueado_hasta: null },
                    order: [['bloqueado_desde', 'DESC']]
                });
                if (openRecord) await openRecord.update({ bloqueado_hasta: now });
            }
        }

        // ─── FECHA DE RESOLUCIÓN (Volcán Desk) ───
        // Se estampa sola al entrar a 'done' (único estado terminal del catálogo fijo
        // INTERNAL_STATUSES en src/services/configService.js — si ese catálogo cambia,
        // actualizar también aquí) y se limpia si el ticket se reabre.
        if (ticket.ambito === 'interno' && data.status !== undefined && data.status !== ticket.status) {
            const wasTerminal = ticket.status === 'done';
            const isTerminal = data.status === 'done';
            if (isTerminal && !wasTerminal) {
                data.fecha_resolucion = now;
            } else if (!isTerminal && wasTerminal) {
                data.fecha_resolucion = null;
            }
        }

        await ticket.update(data);

        // Limpieza de archivos huérfanos: solo corre si este PUT tocó attachments
        // explícitamente (si no vino en el body, no hubo cambio que limpiar).
        if (data.attachments !== undefined) {
            const newAttachmentUrls = (data.attachments || []).map(a => a?.fileUrl).filter(Boolean);
            const removedUrls = oldAttachmentUrls.filter(u => !newAttachmentUrls.includes(u));
            await Promise.all(removedUrls.map(deleteAttachmentFileIfOrphaned));
        }

        // Retornar el ticket actualizado con relaciones
        const updatedTicket = await Ticket.findByPk(ticket.id, {
            include: [
                { model: User, as: 'Creator', attributes: ['id', 'name', 'role', 'avatar'] },
                { model: User, as: 'Agent', attributes: ['id', 'name', 'role', 'avatar'] },
                { model: User, as: 'OwnerAgent', attributes: ['id', 'name', 'role', 'avatar'] },
                { model: User, as: 'ResolverAgent', attributes: ['id', 'name', 'role', 'avatar'] },
                { model: Company, as: 'Company', attributes: ['id', 'name'] },
                {
                    model: Comment,
                    as: 'comments',
                    include: [{ model: User, attributes: ['id', 'name', 'role', 'avatar'] }]
                },
                {
                    model: TicketCampoValor,
                    as: 'camposValores',
                    include: [{ model: CampoCatalogo, as: 'Campo' }]
                },
                { model: TicketBloqueoHistorial, as: 'bloqueos' }
            ]
        });
        const updateCtx = await getUserGroupContext(req.user);
        res.json(sanitizeTicketForUser(updatedTicket.toJSON(), req.user, updateCtx));
    } catch (error) {
        console.error(error);
        res.status(400).json({ error: 'Error al actualizar ticket' });
    }
});

app.put('/api/tickets/:id/read', requireAuthenticated, async (req, res) => {
    try {
        const { role } = req.body;
        const ticket = await Ticket.findByPk(req.params.id);
        if (ticket) {
            // Faltaba este chequeo (auditoría 2026-08-27) — cualquier autenticado
            // podía marcar como leído/no-leído un ticket ajeno con solo conocer su
            // id, sin importar empresa/grupo. Mismo criterio que PUT /api/tickets/:id.
            const allowed = await checkTicketAccess(ticket, req.user);
            if (!allowed) {
                return res.status(403).json({ error: 'No tienes permisos para modificar este ticket.' });
            }
            if (role === 'client') {
                await ticket.update({ visto_por_cliente: true });
            } else {
                await ticket.update({ visto_por_agente: true });
            }
            res.json({ success: true, ticketId: ticket.id });
        } else {
            res.status(404).json({ error: 'Ticket no encontrado' });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al marcar ticket como leído' });
    }
});

app.delete('/api/tickets/:id', requireAdmin, async (req, res) => {
    try {
        const ticket = await Ticket.findByPk(req.params.id);
        if (ticket) {
            await ticket.destroy();
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Ticket no encontrado' });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al eliminar ticket' });
    }
});

// ─── RUTAS DE COMENTARIOS ────────────────────────────────────────────────────

app.post('/api/tickets/:ticketId/comments', requireAuthenticated, async (req, res) => {
    try {
        const { ticketId } = req.params;
        const ticket = await Ticket.findByPk(ticketId);
        if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });
        
        if (ticket.ambito === 'interno' && req.user.role === 'client') {
            return res.status(403).json({ error: 'Acceso denegado a ticket interno' });
        }

        const allowedToView = await checkTicketAccess(ticket, req.user);
        if (!allowedToView) {
            return res.status(403).json({ error: 'No tienes permisos sobre este ticket.' });
        }

        const isPrivate = !!req.body.isPrivate;

        if (isPrivate) {
            // Solo agentes/admins/supervisores pueden dejar notas privadas
            if (req.user.role === 'client') {
                return res.status(403).json({ error: 'Los clientes no pueden crear notas privadas.' });
            }
        } else if (req.user.role !== 'client') {
            // Respuesta pública en Volcán Desk (interno): cualquier miembro autorizado del
            // grupo resolutor ACTUAL puede responder, no solo quien tiene la responsabilidad
            // directa (doc "lógica de visualización" CA11/CA12). Voltik (externo) conserva
            // la regla histórica: solo el owner del ticket o un admin. En ambos casos, el
            // SOLICITANTE (createdBy) siempre puede responder a su propio ticket, sin
            // importar si pertenece al grupo resolutor — se me había quedado fuera en la
            // primera pasada (doc §11: "Juan... es el solicitante → puede responder a su
            // propio ticket").
            const isRequester = req.user.id === ticket.createdBy;
            let allowed = isRequester;
            if (!allowed && ticket.ambito === 'interno') {
                allowed = await isAuthorizedResolverGroupMember(ticket, req.user);
            } else if (!allowed) {
                allowed = req.user.id === ticket.owner_agent_id || req.user.role === 'admin';
            }
            if (!allowed) {
                return res.status(403).json({ error: ticket.ambito === 'interno'
                    ? 'Solo un miembro del grupo resolutor puede enviar respuestas al solicitante. Usa una nota interna.'
                    : 'Solo el propietario (owner) del ticket puede enviar respuestas públicas. Usa una nota privada.' });
            }
        }

        const data = { ...req.body, ticketId };

        if (data.attachments && data.attachments.length > 0) {
            data.attachments = processAttachments(data.attachments);
        }
        
        const comment = await Comment.create(data);
        
        // Update ticket message status and read flags for public comments
        if (!comment.isPrivate) {
            const isClient = req.user.role === 'client';
            await Ticket.update({
                ultimo_mensaje_de: isClient ? 'cliente' : 'agente',
                ultimo_mensaje_at: comment.createdAt || new Date(),
                visto_por_agente: isClient ? false : true,
                visto_por_cliente: isClient ? true : false
            }, {
                where: { id: ticketId }
            });
        }
        
        // Retornar comentario con información de usuario
        const createdComment = await Comment.findByPk(comment.id, {
            include: [{ model: User, attributes: ['id', 'name', 'role', 'avatar'] }]
        });

        // Enviar notificación de nuevo comentario
        if (!comment.isPrivate) {
            (async () => {
                try {
                    const ticketWithUsers = await Ticket.findByPk(ticketId, {
                        include: [
                            { model: User, as: 'Creator', attributes: ['id', 'name', 'email'] },
                            { model: User, as: 'OwnerAgent', attributes: ['id', 'name', 'email'] }
                        ]
                    });
                    
                    // Solo Volcán Desk (auditoría 2026-08-27 — antes esto también disparaba
                    // para comentarios de Voltik, con branding "Volcán Desk" incorrecto).
                    if (ticketWithUsers && ticketWithUsers.ambito === 'interno') {
                        const authorName = createdComment.User ? createdComment.User.name : 'Un usuario';
                        const isCreator = req.user.id === ticketWithUsers.createdBy;
                        const targetGroup = ticketWithUsers.resolver_group_id || ticketWithUsers.group;

                        // Si comenta el solicitante -> notificar al resolutor
                        if (isCreator && ticketWithUsers.OwnerAgent && ticketWithUsers.OwnerAgent.email
                            && await isGroupEmailEventEnabled(targetGroup, 'respuestaSolicitante')) {
                            const html = emailService.templates.newComment(ticketWithUsers, comment, authorName, ticketWithUsers.OwnerAgent.name);
                            await emailService.sendHtmlEmail(ticketWithUsers.OwnerAgent.email, `Nuevo mensaje en [${ticketWithUsers.id}]`, html);
                        }
                        // Si comenta el agente -> notificar al solicitante
                        else if (!isCreator && ticketWithUsers.Creator && ticketWithUsers.Creator.email
                            && await isGroupEmailEventEnabled(targetGroup, 'respuestaResolutor')) {
                            const html = emailService.templates.newComment(ticketWithUsers, comment, authorName, ticketWithUsers.Creator.name);
                            await emailService.sendHtmlEmail(ticketWithUsers.Creator.email, `Nuevo mensaje en [${ticketWithUsers.id}]`, html);
                        }
                    }
                } catch (err) {
                    console.error("Error enviando correo de comentario:", err);
                }
            })();
        }
        
        res.status(201).json(createdComment);
    } catch (error) {
        console.error(error);
        res.status(400).json({ error: 'Datos de comentario inválidos' });
    }
});

// --- RUTAS DE CAMPOS DINÁMICOS Y FLUJOS ---

// GET /api/campos-catalogo
app.get('/api/campos-catalogo', async (req, res) => {
    try {
        let campos = await CampoCatalogo.findAll();
        // Mismo criterio que GET /api/config (ver getConfigVisibleGroupIds): filtra
        // contra todo grupo cuyo catálogo el group_admin pueda necesitar resolver,
        // no solo el que administra — para no romper la resolución de labels en
        // vistas que agregan varios grupos (ej. "Todos").
        if (req.user.role === 'group_admin') {
            const visibleGroupIds = await getConfigVisibleGroupIds(req.user);
            campos = campos.filter(c => (c.modulo || 'voltik') === 'volcan_desk' && visibleGroupIds.has(c.grupo_id));
        }
        res.json(campos);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al obtener campos del catálogo' });
    }
});

// POST /api/campos-catalogo
app.post('/api/campos-catalogo', requireAdminOrGroupAdmin, async (req, res) => {
    try {
        const scope = await getGroupAdminScope(req.user);
        if (scope && req.body.grupo_id !== scope) {
            return res.status(403).json({ error: 'Solo puedes crear campos para tu propio grupo.' });
        }
        const campo = await CampoCatalogo.create(req.body);
        res.status(201).json(campo);
    } catch (error) {
        console.error(error);
        res.status(400).json({ error: 'Error al crear campo de catálogo' });
    }
});

// PUT /api/campos-catalogo/:id
app.put('/api/campos-catalogo/:id', requireAdminOrGroupAdmin, async (req, res) => {
    try {
        const campo = await CampoCatalogo.findByPk(req.params.id);
        if (!campo) return res.status(404).json({ error: 'Campo no encontrado' });
        const scope = await getGroupAdminScope(req.user);
        if (scope && (campo.grupo_id !== scope || (req.body.grupo_id !== undefined && req.body.grupo_id !== scope))) {
            return res.status(403).json({ error: 'Solo puedes modificar campos de tu propio grupo.' });
        }
        await campo.update(req.body);
        res.json(campo);
    } catch (error) {
        console.error(error);
        res.status(400).json({ error: 'Error al actualizar campo de catálogo' });
    }
});

// DELETE /api/campos-catalogo/:id
app.delete('/api/campos-catalogo/:id', requireAdminOrGroupAdmin, async (req, res) => {
    try {
        const campo = await CampoCatalogo.findByPk(req.params.id);
        if (!campo) return res.status(404).json({ error: 'Campo no encontrado' });
        const scope = await getGroupAdminScope(req.user);
        if (scope && campo.grupo_id !== scope) {
            return res.status(403).json({ error: 'Solo puedes eliminar campos de tu propio grupo.' });
        }
        await campo.destroy();
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al eliminar campo' });
    }
});

// GET /api/reglas-flujo
app.get('/api/reglas-flujo', async (req, res) => {
    try {
        let reglas = await ReglaFlujo.findAll();
        // Mismo criterio que GET /api/config y /api/campos-catalogo (ver
        // getConfigVisibleGroupIds): filtra contra todo grupo cuyo catálogo el
        // group_admin pueda necesitar resolver, no solo el que administra. ReglaFlujo
        // no guarda su propio grupo — se resuelve vía el Tipo (resolveTipoGroup,
        // definido más abajo).
        if (req.user.role === 'group_admin') {
            const visibleGroupIds = await getConfigVisibleGroupIds(req.user);
            const groupByTipo = await Promise.all(reglas.map(r => resolveTipoGroup(r.tipo_id)));
            reglas = reglas.filter((_, i) => visibleGroupIds.has(groupByTipo[i]));
        }
        res.json(reglas);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al obtener reglas' });
    }
});

// Resuelve a qué grupo pertenece un Tipo de ticket (guardado en el blob de Config, no en su
// propia tabla) — usado para que un group_admin solo pueda tocar reglas de flujo de su grupo.
const resolveTipoGroup = async (tipoId) => {
    const configRow = await Config.findByPk('tms_config');
    const tipo = configRow?.value?.types?.find(t => t.id === tipoId);
    return tipo?.grupoId || null;
};

// POST /api/reglas-flujo
app.post('/api/reglas-flujo', requireAdminOrGroupAdmin, async (req, res) => {
    try {
        const scope = await getGroupAdminScope(req.user);
        if (scope && (await resolveTipoGroup(req.body.tipo_id)) !== scope) {
            return res.status(403).json({ error: 'Solo puedes crear reglas para tipos de tu propio grupo.' });
        }
        const regla = await ReglaFlujo.create(req.body);
        res.status(201).json(regla);
    } catch (error) {
        console.error(error);
        res.status(400).json({ error: 'Error al crear regla' });
    }
});

// PUT /api/reglas-flujo/:id
app.put('/api/reglas-flujo/:id', requireAdminOrGroupAdmin, async (req, res) => {
    try {
        const regla = await ReglaFlujo.findByPk(req.params.id);
        if (!regla) return res.status(404).json({ error: 'Regla no encontrada' });
        const scope = await getGroupAdminScope(req.user);
        if (scope && (await resolveTipoGroup(req.body.tipo_id || regla.tipo_id)) !== scope) {
            return res.status(403).json({ error: 'Solo puedes modificar reglas de tu propio grupo.' });
        }
        await regla.update(req.body);
        res.json(regla);
    } catch (error) {
        console.error(error);
        res.status(400).json({ error: 'Error al actualizar regla' });
    }
});

// DELETE /api/reglas-flujo/:id
app.delete('/api/reglas-flujo/:id', requireAdminOrGroupAdmin, async (req, res) => {
    try {
        const regla = await ReglaFlujo.findByPk(req.params.id);
        if (!regla) return res.status(404).json({ error: 'Regla no encontrada' });
        const scope = await getGroupAdminScope(req.user);
        if (scope && (await resolveTipoGroup(regla.tipo_id)) !== scope) {
            return res.status(403).json({ error: 'Solo puedes eliminar reglas de tu propio grupo.' });
        }
        await regla.destroy();
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al eliminar regla' });
    }
});

// GET /api/reglas-flujo/resolve
app.get('/api/reglas-flujo/resolve', async (req, res) => {
    try {
        const { tipo_id, categoria_id } = req.query;
        if (!tipo_id) {
            return res.status(400).json({ error: 'Falta tipo_id' });
        }

        const reglas = await ReglaFlujo.findAll({
            where: { tipo_id, activo: true }
        });

        if (reglas.length === 0) {
            return res.json(null);
        }

        if (categoria_id) {
            const exactMatch = reglas.find(r => r.categoria_id === categoria_id);
            if (exactMatch) {
                return res.json(exactMatch);
            }
        }

        // Regla "General" (categoria_id null) del Tipo: aplica cuando la categoría
        // elegida no tiene una regla propia. Si tampoco hay una regla general,
        // NO se debe aplicar ninguna regla — antes esto caía en reglas[0] (la
        // primera regla del Tipo, sin importar la categoría real elegida), que
        // es justo el bug de "siempre aplica el mismo flujo pase lo que pase".
        const typeOnlyMatch = reglas.find(r => !r.categoria_id);
        if (typeOnlyMatch) {
            return res.json(typeOnlyMatch);
        }

        res.json(null);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al resolver la regla de flujo' });
    }
});

// ─── RUTAS DE NOTIFICACIONES ─────────────────────────────────────────────────
// Antes vivían solo en localStorage del navegador que disparaba la acción
// (ver notificationService.js del frontend) — nunca llegaban a otro usuario u
// otro dispositivo. Ahora persistidas acá: cada usuario hace polling de las
// suyas por su propio x-user-id.

app.get('/api/notifications', async (req, res) => {
    try {
        if (!req.user.id) return res.status(401).json({ error: 'No autenticado' });
        const notifs = await Notification.findAll({
            where: { toUserId: req.user.id },
            order: [['createdAt', 'DESC']],
            limit: 50,
        });
        res.json(notifs);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al obtener notificaciones' });
    }
});

// Acepta un array de notificaciones en un solo request (ej. avisar a todo un
// grupo de una sola vez) — el cliente siempre manda un array, incluso para
// una sola notificación.
app.post('/api/notifications', requireAuthenticated, async (req, res) => {
    try {
        const items = Array.isArray(req.body) ? req.body : [req.body];
        if (items.length === 0) return res.json([]);
        const created = await Notification.bulkCreate(items.map(it => ({
            toUserId: it.toUserId,
            fromUser: it.fromUser || null,
            ticketId: it.ticketId || null,
            ticketTitle: it.ticketTitle || null,
            type: it.type || null,
            message: it.message,
        })));
        res.status(201).json(created);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al crear notificación' });
    }
});

app.put('/api/notifications/read-all', requireAuthenticated, async (req, res) => {
    try {
        if (!req.user.id) return res.status(401).json({ error: 'No autenticado' });
        await Notification.update({ read: true }, { where: { toUserId: req.user.id, read: false } });
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al marcar notificaciones leídas' });
    }
});

app.put('/api/notifications/:id/read', requireAuthenticated, async (req, res) => {
    try {
        const notif = await Notification.findByPk(req.params.id);
        if (!notif) return res.status(404).json({ error: 'Notificación no encontrada' });
        notif.read = true;
        await notif.save();
        res.json(notif);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al marcar notificación leída' });
    }
});

app.delete('/api/notifications/:id', requireAuthenticated, async (req, res) => {
    try {
        const notif = await Notification.findByPk(req.params.id);
        if (notif) await notif.destroy();
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al borrar notificación' });
    }
});

// Inicializar base de datos y arrancar el servidor
initDB().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Servidor backend corriendo en http://localhost:${PORT}`);
        console.log(`Guardando archivos adjuntos en: ${getAttachmentDir()}`);
    });
});
