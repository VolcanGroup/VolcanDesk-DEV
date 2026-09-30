const express = require('express');
const cors = require('cors');
const compression = require('compression');
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

// PREVIENE CAÍDAS DEL SERVIDOR POR ERRORES ASÍNCRONOS NO MANEJADOS
// (ej. el error "EENVELOPE / 421 4.3.0 Temporary System Problem" del socket TLS
// de nodemailer cuando Gmail hace rate-limiting). Sin esto, cualquier promesa
// sin catch o error de socket escapa y hace que el proceso Node.js muera entero.
process.on('uncaughtException', (err) => {
    console.error('CRITICAL UNCAUGHT EXCEPTION:', err);
    // No apagamos el servidor, lo dejamos vivo.
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL UNHANDLED REJECTION at:', promise, 'reason:', reason);
    // No apagamos el servidor, lo dejamos vivo.
});

// Firma los tokens de descarga de /api/uploads (ver más abajo) — igual que el resto
// de secretos de este proyecto, trae un default para que la app funcione sin .env,
// pero en un despliegue real conviene fijar DOWNLOAD_TOKEN_SECRET a algo propio.
const DOWNLOAD_TOKEN_SECRET = process.env.DOWNLOAD_TOKEN_SECRET || 'volcandesk-download-token-dev-secret-2026';
const DOWNLOAD_TOKEN_TTL = '15m';

// Relaciones base de Ticket (autor, agentes, empresa) — antes este mismo bloque
// estaba copiado y pegado en 4 rutas distintas (GET /api/tickets, GET
// /api/tickets/:id, POST /api/tickets, PUT /api/tickets/:id). Agregar un campo
// o relación nueva obligaba a recordar actualizar los 4 sitios; olvidar uno
// producía una inconsistencia silenciosa (el campo se ve en una pantalla y en
// otra no) — el mismo patrón que ya causó el bug recurrente de
// `ticket.group` vs `resolver_group_id` documentado en CLAUDE.md. Centralizado
// aquí, un cambio se hace una sola vez.
const TICKET_BASE_INCLUDES = [
    { model: User, as: 'Creator', attributes: ['id', 'name', 'role', 'avatar'] },
    { model: User, as: 'Agent', attributes: ['id', 'name', 'role', 'avatar'] },
    { model: User, as: 'OwnerAgent', attributes: ['id', 'name', 'role', 'avatar'] },
    { model: User, as: 'ResolverAgent', attributes: ['id', 'name', 'role', 'avatar'] },
    { model: Company, as: 'Company', attributes: ['id', 'name'] },
];
// Relaciones completas (base + comments/camposValores/bloqueos) — usadas por
// GET /api/tickets/:id, y por POST/PUT /api/tickets al devolver el ticket ya
// creado/actualizado. GET /api/tickets (el listado) NO usa esta — a propósito
// no trae comments/camposValores por rendimiento (ver nota 2026-09-17 más abajo).
const TICKET_FULL_INCLUDES = [
    ...TICKET_BASE_INCLUDES,
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
];

app.use(cors());
// Comprime las respuestas (gzip) antes de mandarlas — las respuestas JSON de
// /api/tickets, /api/config, etc. viajaban sin comprimir; en redes lentas
// (VPN, WiFi) eso se siente como lentitud aunque el servidor responda rápido.
app.use(compression());
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
    if (!['admin', 'group_admin', 'agent'].includes(req.user.role)) {
        return res.status(403).json({ error: 'Acceso denegado. Se requiere rol de usuario interno.' });
    }
    next();
};

const VALID_ROLES = ['admin', 'group_admin', 'agent', 'client'];
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

// Campos que solo agent/admin/group_admin pueden modificar directamente (nunca el client)
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
    const whereClause = {
        ambito: 'interno',
        [Op.or]: [
            { createdBy: user.id },
            ...allowedGroups.map(gid => Sequelize.where(Sequelize.cast(Sequelize.col('apoyos'), 'CHAR'), { [Op.like]: `%"grupo_solicitado":"${gid}"%` }))
        ]
    };
    const relatedTickets = await Ticket.findAll({
        where: whereClause,
        attributes: ['group', 'resolver_group_id', 'area_origen_id', 'apoyos'],
    });
    relatedTickets.forEach(t => {
        // Para tickets obtenidos por apoyo, filtrar si el apoyo sigue activo
        const hasActiveApoyo = t.createdBy === user.id || (t.apoyos || []).some(a => allowedGroups.includes(a.grupo_solicitado) && a.status !== 'Resuelto');
        if (!hasActiveApoyo) return;
        
        if (t.resolver_group_id) groupIds.add(t.resolver_group_id);
        if (t.group) groupIds.add(t.group);
        if (t.area_origen_id) groupIds.add(t.area_origen_id);
        (t.apoyos || []).forEach(a => { if (a.grupo_solicitado) groupIds.add(a.grupo_solicitado); });
    });
    return groupIds;
};

// Los escenarios reales que disparan correo (ver los sendHtmlEmail en este
// archivo) — cada grupo de Volcán Desk los prende/apaga de forma independiente
// (a pedido del usuario 2026-08-27: no es un interruptor general, cada grupo
// decide qué le llega). 'mencion', 'respuestaApoyo' y 'nuevoApoyoSolicitado' se
// agregaron 2026-09-14 (a pedido del usuario): te @mencionan, el grupo al que
// le pediste apoyo responde, y a tu grupo le llega una solicitud de apoyo nueva.
const EMAIL_EVENT_KEYS = ['nuevoTicketAsignado', 'nuevoTicketSinAsignar', 'respuestaSolicitante', 'respuestaResolutor', 'mencion', 'respuestaApoyo', 'nuevoApoyoSolicitado'];

// Default ON si el grupo nunca lo configuró — preserva el comportamiento que ya
// existía antes de que existiera este ajuste.
const isGroupEmailEventEnabled = async (groupId, eventKey) => {
    if (!groupId) return true;
    const configRow = await Config.findByPk('tms_config');
    const groupSettings = configRow?.value?.emailNotificationsByGroup?.[groupId];
    if (!groupSettings || !(eventKey in groupSettings)) return true;
    return groupSettings[eventKey] !== false;
};

// Extrae los ids de usuario @mencionados en el HTML de un comentario —
// RichTextEditor.jsx inserta cada mención como <span data-userid="..."> (ver
// insertMention), así que no hace falta que el cliente mande una lista aparte.
// Agregado 2026-09-14 para el correo de menciones.
const extractMentionedUserIds = (html) => {
    if (!html) return [];
    const ids = new Set();
    const re = /data-userid="([^"]+)"/g;
    let m;
    while ((m = re.exec(html))) ids.add(m[1]);
    return [...ids];
};

// Grupo "propio" de un usuario interno — group_admin lo guarda en
// admin_group_id, agent en groups[0] (ver CLAUDE.md, mismo criterio usado en
// varios lugares del frontend). Usado por los correos de mención/apoyo para
// saber contra qué grupo consultar isGroupEmailEventEnabled.
const getUserOwnGroupId = (user) => {
    if (!user) return null;
    return user.role === 'group_admin' ? user.admin_group_id : (user.groups || [])[0] || null;
};

// Todos los usuarios a notificar cuando algo cae en la bandeja de un grupo
// (ticket nuevo sin asignar, apoyo nuevo solicitado) — membresía nativa
// (admin_group_id / groups) MÁS quien tenga Acceso Especial (AreaAccesoExtra)
// a ese grupo (2026-09-16, a pedido del usuario): alguien sin ser miembro
// nativo ni group_admin del grupo, pero con acceso especial otorgado, también
// debe enterarse — es exactamente el caso de un director con visibilidad
// sobre varios grupos sin ser su admin. Factorizado aquí porque antes este
// mismo filtro estaba duplicado en dos rutas (POST /api/tickets y PUT
// /api/tickets/:id) y ya habían empezado a divergir.
const getGroupMemberUserIds = async (targetGroup) => {
    const [allUsers, accesosExtra] = await Promise.all([
        User.findAll({ where: { role: { [Op.in]: ['group_admin', 'agent'] } } }),
        AreaAccesoExtra.findAll({ where: { area_id: targetGroup } })
    ]);
    const memberIds = allUsers.filter(u => {
        if (u.role === 'group_admin' && u.admin_group_id === targetGroup) return true;
        if (u.groups && Array.isArray(u.groups) && u.groups.includes(targetGroup)) return true;
        return false;
    }).map(u => u.id);
    const combinedIds = new Set([...memberIds, ...accesosExtra.map(a => a.usuario_id)]);
    if (combinedIds.size === 0) return [];
    return User.findAll({ where: { id: { [Op.in]: [...combinedIds] } } });
};

// Un comentario borrado (isDeleted=true) nunca debe mandar su texto/adjuntos
// originales al cliente, sin importar quién lo esté viendo — el borrado es
// "suave" (la fila se conserva) pero el contenido real solo debe quedar en la
// base de datos, no viajar por la API una vez borrado. El frontend pinta el
// placeholder "Mensaje eliminado" cuando ve isDeleted=true.
const redactDeletedComments = (comments) => (comments || []).map(c =>
    c.isDeleted ? { ...c, text: '', attachments: [] } : c
);

// GET /api/tickets (el listado — tabla/Kanban/Cronograma, con polling cada
// 8-30s) NUNCA debe mandar el contenido real de los adjuntos del ticket, solo
// para saber "sí tiene adjuntos" — nada en esas vistas usa `att.dataUrl`
// (mismo criterio que ya se aplicó a `comments`/`camposValores` el
// 2026-09-17, que este endpoint nunca alcanzó). Medido en vivo 2026-09-28: de
// 154 tickets interno, solo 24 tienen adjuntos, pero esos 24 sumaban 12.3MB
// de base64 (un solo PDF de 6.18MB) — la respuesta completa pesaba 13.5MB sin
// comprimir y tardaba hasta 69s en bajar, en CADA ciclo de polling. El detalle
// de un ticket (GET /api/tickets/:id, aparte) no se toca — sigue trayendo el
// adjunto completo, que es donde de verdad hace falta para verlo/descargarlo.
const stripAttachmentData = (attachments) => (attachments || []).map(a => ({
    id: a.id,
    name: a.name,
    type: a.type
}));

const sanitizeTicketForUser = (ticketJson, user, ctx) => {
    if (ticketJson.ambito === 'externo') {
        if (user.role === 'client') {
            return {
                ...ticketJson,
                activities: [],
                comments: redactDeletedComments((ticketJson.comments || []).filter(c => !c.isPrivate))
            };
        }
        return { ...ticketJson, comments: redactDeletedComments(ticketJson.comments) };
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
    if (canSeePrivate) return { ...ticketJson, comments: redactDeletedComments(ticketJson.comments) };
    return {
        ...ticketJson,
        comments: redactDeletedComments((ticketJson.comments || []).filter(c => !c.isPrivate))
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

// Simétrico a isAuthorizedResolverGroupMember, pero para el lado SOLICITANTE
// (area_origen_id) — hasta 2026-09-29 solo `ticket.createdBy` exacto podía
// responder públicamente en nombre de su propio ticket, aunque un compañero de
// su mismo grupo quisiera dar seguimiento. checkTicketAccess (arriba) ya
// trataba a area_origen_id de forma simétrica al del grupo resolutor para
// decidir quién puede VER el ticket; esto lleva ese mismo criterio a "quién
// puede responder". Reportado en vivo: Sofía (grupo Producto) no podía
// responder un ticket que su compañera Cindy (también Producto) había creado.
const isAuthorizedRequesterGroupMember = async (ticket, user) => {
    if (user.role === 'admin') return true;
    if (!ticket.area_origen_id) return false;
    const currentUser = await User.findByPk(user.id);
    if (user.role === 'group_admin') return currentUser?.admin_group_id === ticket.area_origen_id;
    const userGroups = currentUser?.groups || [];
    if (userGroups.includes(ticket.area_origen_id)) return true;
    const accesosExtra = await AreaAccesoExtra.findAll({ where: { usuario_id: user.id } });
    return accesosExtra.some(a => a.area_id === ticket.area_origen_id);
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

// Cambiar la propia contraseña estando logueado. Solo opera sobre req.user.id
// (nunca recibe un id de usuario en el body/params) — así no hace falta ningún
// rol especial, cualquier usuario autenticado puede cambiar SU contraseña.
app.put('/api/auth/password', requireAuthenticated, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body || {};
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Contraseña actual y nueva son requeridas.' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres.' });
        }
        const user = await User.findByPk(req.user.id);
        if (!user) {
            return res.status(404).json({ error: 'Usuario no encontrado.' });
        }

        let valid;
        if (isBcryptHash(user.password)) {
            valid = await bcrypt.compare(currentPassword, user.password);
        } else {
            valid = currentPassword === user.password;
        }
        if (!valid) {
            return res.status(401).json({ error: 'La contraseña actual no es correcta.' });
        }

        user.password = newPassword; // el hook beforeSave en db.js la hashea al guardar
        await user.save();
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al cambiar la contraseña.' });
    }
});

// Solicitar recuperación de contraseña (pública, sin sesión). Responde igual
// exista o no el email en la BD — no confirmar/negar cuentas registradas.
app.post('/api/auth/forgot-password', async (req, res) => {
    try {
        const { email } = req.body || {};
        if (!email) {
            return res.status(400).json({ error: 'Email es requerido.' });
        }
        const genericResponse = { success: true, message: 'Si el correo está registrado, se envió un enlace para recuperar la contraseña.' };

        const user = await User.findOne({
            where: Sequelize.where(Sequelize.fn('LOWER', Sequelize.col('email')), String(email).toLowerCase())
        });
        if (!user) {
            return res.json(genericResponse);
        }

        const token = crypto.randomBytes(32).toString('hex');
        user.passwordResetToken = token;
        user.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hora
        await user.save();

        const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/reset-password?token=${token}`;
        await emailService.sendHtmlEmail(user.email, 'Recuperar contraseña — Volcán Desk', emailService.templates.passwordReset(user, resetUrl));

        res.json(genericResponse);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al solicitar la recuperación de contraseña.' });
    }
});

// Confirmar recuperación de contraseña con el token del correo (pública, sin sesión).
app.post('/api/auth/reset-password', async (req, res) => {
    try {
        const { token, newPassword } = req.body || {};
        if (!token || !newPassword) {
            return res.status(400).json({ error: 'Token y nueva contraseña son requeridos.' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres.' });
        }

        const user = await User.findOne({ where: { passwordResetToken: token } });
        if (!user || !user.passwordResetExpires || new Date(user.passwordResetExpires) < new Date()) {
            return res.status(400).json({ error: 'El enlace no es válido o ya expiró. Solicita uno nuevo.' });
        }

        user.password = newPassword; // el hook beforeSave en db.js la hashea al guardar
        user.passwordResetToken = null;
        user.passwordResetExpires = null;
        await user.save();

        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al restablecer la contraseña.' });
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
        // filtrar — un group_admin autenticado recibía topes de Bloqueo y ajustes
        // de notificaciones por correo de TODOS los grupos de Volcán Desk con solo
        // abrir la pestaña Red del navegador. Eso sí es configuración operativa
        // interna de cada grupo y se queda acotado a `visibleGroupIds`.
        //
        // types/categories/priorities/products (2026-09-10, revertido — reportado
        // en vivo: "por qué el solicitante no puede ver el producto/tipo/categoría
        // del grupo BI & Development") YA NO se filtran aquí: son el catálogo de
        // CLASIFICACIÓN que cualquier usuario interno necesita ver completo para
        // crear una Solicitud dirigida a CUALQUIER grupo (Tickets.jsx ya filtra
        // client-side por el grupo elegido en el formulario, `newTicket.group`).
        // Filtrarlos contra `visibleGroupIds` (grupo propio + grupos de tickets que
        // ESE usuario ya haya creado antes) rompía exactamente el primer ticket
        // hacia un grupo nuevo: el catálogo de ese grupo solo se volvía visible
        // DESPUÉS de haber creado un ticket hacia él — huevo y gallina, nunca
        // llegaba a completarse el primero. Son solo nombres de clasificación
        // (no datos de negocio sensibles), así que el costo de mostrarlos
        // completos es bajo comparado con romper el flujo de "Solicitudes
        // Enviadas" hacia un grupo con el que nunca se interactuó antes.
        // getGroupAdminScope() sigue siendo el correcto para los POST/PUT/DELETE de
        // más abajo — administrar (escribir) el catálogo sí queda acotado a un
        // solo grupo (el propio); solo verlo, no.
        if (req.user.role === 'group_admin') {
            const visibleGroupIds = await getConfigVisibleGroupIds(req.user);
            value = {
                ...value,
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
        const currentRow = await Config.findByPk('tms_config');
        const current = currentRow?.value || {};

        // group_admin: solo puede tocar sus propios ítems de Tipos/Categorías/Prioridades/Productos
        // dentro de Volcán Desk, y su propia entrada en los objetos por-grupo
        // (groupBloqueoCaps, emailNotificationsByGroup) — todo lo demás debe quedar
        // intacto.
        if (req.user.role === 'group_admin') {
            const scope = await getGroupAdminScope(req.user);
            if (!scope) {
                return res.status(403).json({ error: 'Tu usuario no tiene un grupo administrado asignado.' });
            }
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

            // 2026-09-14: se quitó el rechazo por "otherKeysChanged" que comparaba
            // incoming vs current byte a byte para cualquier llave fuera del alcance
            // del group_admin. Ese chequeo daba falso positivo (403 "No tienes
            // permiso...") apenas la base de datos era nueva y el Config todavía no
            // existía (current = {}): el cliente SIEMPRE manda su config completa en
            // caché (incluye defaults que el servidor nunca guardó), así que cualquier
            // llave ajena "aparecía" como cambiada aunque el group_admin no la hubiera
            // tocado — esto bloqueaba para siempre el primer guardado de Tipos/
            // Categorías/Productos en una instancia nueva (confirmado en vivo en
            // producción: bloqueó a Adrián al grado de que ni él ni Christian veían los
            // catálogos guardados en el servidor, solo en el caché local de cada quien).
            //
            // Mismo principio que ya se aplicaba a las secciones por-grupo: en vez de
            // comparar y rechazar, simplemente se PRESERVA lo que el servidor ya tenía
            // para todo lo que no es del propio group_admin, y solo se aplica lo suyo.
            bodyToSave = { ...current };
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

        // Bloquea borrar una Categoría que todavía tiene una Regla de Flujo
        // ACTIVA apuntándole (2026-09-16, a pedido del usuario) — antes se
        // podía borrar sin aviso, dejando la regla "huérfana": la pantalla de
        // Reglas de Flujo mostraba el id crudo de la categoría (ej.
        // "c1789509687137") en vez de un nombre, reportado en vivo. Una regla
        // ya INACTIVA no cuenta — inactivarla es la forma de "liberar" su
        // categoría para poder borrarla.
        const oldCategoryIds = new Set((current.categories || []).map(c => c.id));
        const newCategoryIds = new Set((bodyToSave.categories || []).map(c => c.id));
        const removedCategoryIds = [...oldCategoryIds].filter(id => !newCategoryIds.has(id));
        if (removedCategoryIds.length > 0) {
            const blockingReglas = await ReglaFlujo.findAll({
                where: { categoria_id: { [Op.in]: removedCategoryIds }, activo: true }
            });
            if (blockingReglas.length > 0) {
                const blockedCategory = (current.categories || []).find(c => c.id === blockingReglas[0].categoria_id);
                return res.status(409).json({
                    error: `No puedes eliminar la categoría "${blockedCategory?.label || blockingReglas[0].categoria_id}" — todavía tiene una Regla de Flujo activa. Inactívala o bórrala primero en Flujos de Ticket.`
                });
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

// Antes exclusivo de 'admin' (nadie más podía ni siquiera leer sus propios
// accesos) — un usuario con Acceso Especial necesita poder consultar sus
// propios grupos otorgados para armar su vista de "De mi grupo" en Recibidas/
// Enviadas/Inicio (2026-09-16, a pedido del usuario). Un no-admin solo ve sus
// propias filas, nunca las de otros; 'admin' sigue viendo todas (para la
// pantalla de gestión en Usuarios > Accesos Especiales).
app.get('/api/area-acceso-extra', requireAuthenticated, async (req, res) => {
    try {
        const where = req.user.role === 'admin' ? {} : { usuario_id: req.user.id };
        const accesos = await AreaAccesoExtra.findAll({ where });
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

// Un group_admin puede tocar Editar/Eliminar SOLO sobre cuentas de su propio
// grupo (a pedido del usuario, 2026-09-14) — nunca sobre 'admin' (general) ni
// sobre otro grupo. isUserInGroupAdminScope() es el único punto que decide
// esto, usado tanto en PUT como en DELETE, para no repetir la regla dos veces
// y arriesgar que diverjan. Editar/eliminar cuentas 'admin' o de otro grupo
// sigue siendo exclusivo de 'admin' general (ver el comentario del campo
// User.role en db.js) — ese hueco de seguridad (auto-ascenderse a admin, o
// tocar cuentas ajenas a tu grupo) ya se cerró una vez (2026-08-27) y no se
// vuelve a abrir aquí: el PUT fuerza role/groups/admin_group_id igual que ya
// hace el POST, así el payload nunca puede escaparse del propio grupo.
const isUserInGroupAdminScope = (scope, targetUser) => {
    if (!scope || !targetUser) return false;
    if (targetUser.role === 'group_admin') return targetUser.admin_group_id === scope;
    if (targetUser.role === 'agent') return (targetUser.groups || []).includes(scope);
    return false; // 'admin'/'client' u otro: nunca tocable por un group_admin
};
//
// POST sí se reabre para 'group_admin' (a pedido del usuario, 2026-09-07), pero
// ACOTADO: solo puede crear cuentas 'agent'/'group_admin' de Volcán Desk, y
// siempre asignadas a su propio grupo administrado (admin_group_id) — nunca
// 'admin' (evita que se dé a sí mismo o a un tercero el rol global capaz de
// gestionar Usuarios) y nunca otro grupo o el módulo Voltik. Un group_admin SÍ
// puede crear otro group_admin (a pedido del usuario, 2026-09-14), pero
// siempre acotado a SU MISMO grupo — nunca elige el grupo del nuevo admin.
// Todo lo que el caller haya mandado para esos campos se descarta y se
// reemplaza por el valor forzado, no solo se valida — así no hay combinación
// de payload que se escape.
app.post('/api/users', requireAdminOrGroupAdmin, async (req, res) => {
    try {
        let data = { ...req.body };
        if (req.user.role === 'group_admin') {
            const scope = await getGroupAdminScope(req.user);
            if (!scope) {
                return res.status(403).json({ error: 'Tu usuario no tiene un grupo administrado asignado.' });
            }
            if (!['agent', 'group_admin'].includes(data.role)) {
                return res.status(403).json({ error: 'Un admin de grupo solo puede crear cuentas de tipo Ejecutivo o Admin de Grupo.' });
            }
            data = data.role === 'group_admin'
                ? { ...data, modulo: 'volcan_desk', groups: [], admin_group_id: scope }
                : { ...data, modulo: 'volcan_desk', groups: [scope], admin_group_id: null };
        }
        const user = await User.create(data);
        const { password: _pw, ...userWithoutPassword } = user.toJSON();
        res.status(201).json(userWithoutPassword);
    } catch (error) {
        console.error(error);
        res.status(400).json({ error: 'Datos de usuario inválidos' });
    }
});

app.put('/api/users/:id', requireAdminOrGroupAdmin, async (req, res) => {
    try {
        const user = await User.findByPk(req.params.id);
        if (user) {
            // El módulo de un usuario interno es inmutable tras su creación: evita
            // que un agente "migre" de Voltik a Volcán Desk (o viceversa)
            // por una edición. Si la misma persona debe atender ambos módulos, se
            // crea una cuenta nueva para el otro módulo.
            const data = { ...req.body };
            delete data.modulo;
            if (req.user.role === 'group_admin') {
                const scope = await getGroupAdminScope(req.user);
                if (!isUserInGroupAdminScope(scope, user)) {
                    return res.status(403).json({ error: 'Solo puedes editar usuarios de tu propio grupo.' });
                }
                if (!['agent', 'group_admin'].includes(data.role)) {
                    return res.status(403).json({ error: 'Un admin de grupo solo puede asignar el rol de Ejecutivo o Admin de Grupo.' });
                }
                if (data.role === 'group_admin') {
                    data.admin_group_id = scope;
                    data.groups = [];
                } else {
                    data.groups = [scope];
                    data.admin_group_id = null;
                }
            }
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

app.delete('/api/users/:id', requireAdminOrGroupAdmin, async (req, res) => {
    try {
        const user = await User.findByPk(req.params.id);
        if (user) {
            if (req.user.role === 'group_admin') {
                const scope = await getGroupAdminScope(req.user);
                if (!isUserInGroupAdminScope(scope, user)) {
                    return res.status(403).json({ error: 'Solo puedes eliminar usuarios de tu propio grupo.' });
                }
            }
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
            // Agentes, group_admin, admin
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
                // rama no filtraba nada: cualquier agent/group_admin de
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

        // Antes este listado traía comentarios completos (con imágenes pegadas
        // embebidas como base64 en el texto) y camposValores por CADA ticket, en
        // CADA ciclo de polling de 8s — nada en la tabla/Kanban/Cronograma los
        // usa (ni un solo `.comments`/`.camposValores` en Tickets.jsx/
        // TicketTable.jsx). Medido en vivo 2026-09-17: ~2MB por ciclo en esta
        // sola instancia, con tickets individuales de más de 500KB por una
        // captura de pantalla pegada directo en un comentario. `bloqueos` SÍ se
        // queda — alimenta el cálculo de SLA que sí se muestra en cada fila de
        // la tabla. El detalle de un ticket (GET /api/tickets/:id, abajo) es una
        // ruta aparte que no se tocó — sigue trayendo todo completo.
        const tickets = await Ticket.findAll({
            where: whereClause,
            include: [
                ...TICKET_BASE_INCLUDES,
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
        res.json(finalTickets.map(t => {
            const sanitized = sanitizeTicketForUser(t.toJSON(), req.user, ctx);
            return { ...sanitized, attachments: stripAttachmentData(sanitized.attachments) };
        }));
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al obtener tickets' });
    }
});

app.get('/api/tickets/:id', requireAuthenticated, async (req, res) => {
    try {
        const ticket = await Ticket.findByPk(req.params.id, {
            include: TICKET_FULL_INCLUDES
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

const BUSINESS_DAY_START_HOUR = 9;
const BUSINESS_DAY_END_HOUR = 18;

// Copia server-side de businessMinutesBetween (frontend/src/services/ticketService.js)
// — minutos "de oficina" entre dos fechas: solo lunes a viernes, 9:00-18:00, nada
// de noches ni fines de semana. Esta función solo corre para tickets Volcán Desk
// (ver comentario arriba de computeSlaStatusExport), así que no necesita ninguna
// rama por ambito, a diferencia de la versión del frontend.
const businessMinutesBetween = (start, end) => {
    if (!(start instanceof Date) || !(end instanceof Date) || end <= start) return 0;
    let totalMs = 0;
    let cursor = new Date(start);
    while (cursor < end) {
        const dayOfWeek = cursor.getDay(); // 0=Dom, 6=Sáb
        const dayWindowStart = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), BUSINESS_DAY_START_HOUR, 0, 0, 0);
        const dayWindowEnd = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), BUSINESS_DAY_END_HOUR, 0, 0, 0);
        if (dayOfWeek !== 0 && dayOfWeek !== 6) {
            const segStart = cursor > dayWindowStart ? cursor : dayWindowStart;
            const segEnd = end < dayWindowEnd ? end : dayWindowEnd;
            if (segEnd > segStart) totalMs += segEnd.getTime() - segStart.getTime();
        }
        cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1, 0, 0, 0, 0);
    }
    return totalMs / 60000;
};

const computeSlaStatusExport = (ticket, cfg) => {
    const catConf = (cfg.categories || []).find(c => c.id === ticket.category);
    const noSlaConfigured = !catConf || catConf.slaMinutes == null;
    const targetMinutes = noSlaConfigured ? 1440 : catConf.slaMinutes;

    const endTime = getTicketEndTime(ticket);
    let elapsedMinutes = businessMinutesBetween(new Date(ticket.createdAt), new Date(endTime));

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
                    let durationMs = businessMinutesBetween(new Date(start), new Date(end)) * 60000;
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
                    // resolver_agent_id es la fuente de verdad de quién resuelve el ticket
                    // (assignedTo/Agent es el campo legado — ver CLAUDE.md) — se pide aparte
                    // para poder exponer su correo (agregado 2026-09-14, a pedido del usuario).
                    { model: User, as: 'ResolverAgent', attributes: ['name', 'email'] },
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
                // Correo del Resolutor real (resolver_agent_id), no del campo legado
                // "Asignado A" (assignedTo) — a pedido del usuario, 2026-09-14.
                'Email del resolutor': t.ResolverAgent?.email || '',
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
            RESTRICTED_TICKET_FIELDS.forEach(field => delete data[field]);
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
        // En tickets internos nadie tiene rol 'client' (solicitante y resolutor
        // son ambos roles internos), así que el binario cliente/agente no sirve
        // para saber quién debe responder — reutilizamos los mismos campos con
        // los valores 'solicitante'/'resolutor' en su lugar (columnas STRING sin
        // ENUM, no requiere cambio de esquema). El creador de un ticket interno
        // siempre es el solicitante por definición.
        if (data.ambito === 'interno') {
            data.ultimo_mensaje_de = 'solicitante';
            data.ultimo_mensaje_at = new Date();
            data.visto_por_agente = false;
            data.visto_por_cliente = true;
        } else {
            const creator = await User.findByPk(data.createdBy);
            const isCreatorClient = creator ? creator.role === 'client' : true;
            data.ultimo_mensaje_de = isCreatorClient ? 'cliente' : 'agente';
            data.ultimo_mensaje_at = new Date();
            data.visto_por_agente = isCreatorClient ? false : true;
            data.visto_por_cliente = isCreatorClient ? true : false;
        }

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
            // El reintento ante SequelizeUniqueConstraintError de abajo solo protege
            // contra el MISMO id completo repetido (mismo prefijo). Como el
            // consecutivo se calcula leyendo el máximo actual sin ningún lock, dos
            // creaciones casi simultáneas con PREFIJOS distintos (grupos de origen
            // distintos) podían leer el mismo máximo y crear dos tickets con el
            // mismo número bajo prefijos distintos — el unique constraint no lo
            // detecta porque los ids completos no coinciden. Confirmado en vivo
            // 2026-09-21: VD-OPERACIONES-000072 y VD-IMPLEMENTACION-000072
            // coexistiendo, dejando huérfana la notificación de respuesta del
            // primero (su ticket terminó con un número distinto, nunca reconciliado
            // en el lado del cliente). Se envuelve todo el ciclo lectura+creación en
            // una transacción que toma un lock real (FOR UPDATE) sobre la fila de
            // Config — la misma que ya existe como singleton de configuración — para
            // que cualquier otra creación de ticket interno concurrente espere aquí,
            // sin importar el prefijo.
            ticket = await sequelize.transaction(async (t) => {
                await Config.findByPk('tms_config', { transaction: t, lock: t.LOCK.UPDATE });
                let created;
                for (let attempt = 1; attempt <= 5 && !created; attempt++) {
                    const existing = await Ticket.findAll({ where: { ambito: 'interno' }, attributes: ['id'], transaction: t });
                    let maxNum = 0;
                    existing.forEach(tk => {
                        if (typeof tk.id === 'string' && tk.id.startsWith('VD-')) {
                            const parts = tk.id.split('-');
                            const num = parseInt(parts[parts.length - 1], 10);
                            if (!isNaN(num) && num > maxNum) maxNum = num;
                        }
                    });
                    data.id = `${prefix}${String(maxNum + 1).padStart(6, '0')}`;
                    try {
                        created = await Ticket.create(data, { transaction: t });
                    } catch (e) {
                        if (e.name !== 'SequelizeUniqueConstraintError' || attempt === 5) throw e;
                        // Otro request ganó la carrera con ese número — recalcular y reintentar.
                    }
                }
                return created;
            });
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
            include: TICKET_FULL_INCLUDES
        });

        // Enviar notificaciones de correo de forma asíncrona — solo Volcán Desk
        // (auditoría 2026-08-27: antes no había ningún chequeo de ambito, así que un
        // ticket de Voltik con owner_agent_id o resolver_group_id/group también
        // disparaba estos correos con branding "Volcán Desk", mezclando los módulos).
        if (createdTicket.ambito === 'interno') (async () => {
            try {
                const creatorName = createdTicket.Creator ? createdTicket.Creator.name : 'Usuario';
                // ticket.priority guarda el "value" interno del catálogo por grupo
                // (ej. "alta__<grupoId>"), no el nombre visible — sin resolverlo acá
                // salía crudo en el correo (reportado en vivo 2026-09-17).
                const priorityCfgRow = await Config.findByPk('tms_config');
                const priorityLabel = (priorityCfgRow?.value?.priorities || [])
                    .find(p => p.value === createdTicket.priority || p.id === createdTicket.priority)?.label
                    || createdTicket.priority || 'Sin prioridad';

                if (createdTicket.owner_agent_id) {
                    // Ya tiene un usuario resolutor asignado
                    const targetGroup = createdTicket.resolver_group_id || createdTicket.group;
                    if (await isGroupEmailEventEnabled(targetGroup, 'nuevoTicketAsignado')) {
                        const assignedUser = await User.findByPk(createdTicket.owner_agent_id);
                        if (assignedUser && assignedUser.email) {
                            const html = emailService.templates.newTicketUser(createdTicket, assignedUser, creatorName, priorityLabel);
                            await emailService.sendHtmlEmail(assignedUser.email, `[Nuevo Ticket] ${createdTicket.id}: ${createdTicket.title}`, html);
                        }
                    }
                } else if (createdTicket.resolver_group_id || createdTicket.group) {
                    // Opción A: No tiene usuario, notificar a todos los del grupo
                    const targetGroup = createdTicket.resolver_group_id || createdTicket.group;
                    if (await isGroupEmailEventEnabled(targetGroup, 'nuevoTicketSinAsignar')) {
                        const membersToNotify = await getGroupMemberUserIds(targetGroup);

                        if (membersToNotify.length > 0) {
                            let groupName = 'el Grupo';
                            if (Group) {
                                const groupInfo = await Group.findByPk(targetGroup);
                                if (groupInfo) groupName = groupInfo.name;
                            }

                            const html = emailService.templates.newTicketGroup(createdTicket, groupName, creatorName, priorityLabel);
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
        // El id (primary key) tampoco: en el flujo normal el frontend siempre
        // reenvía el mismo id que ya tenía el ticket, así que quitarlo no cambia
        // nada en el caso sano — pero sin este delete, un payload con un `id`
        // distinto (por ejemplo, un objeto de ticket equivocado reusado por
        // error) haría que ticket.update(data) reescriba la llave primaria del
        // registro encontrado por req.params.id, en vez de solo sus campos.
        delete data.activities;
        delete data.fecha_resolucion;
        delete data.id;
        if (req.user.role === 'client') {
            if (data.ambito === 'interno') data.ambito = 'externo';
            RESTRICTED_TICKET_FIELDS.forEach(field => delete data[field]);
        }

        const isInternalUser = ['admin', 'group_admin', 'agent'].includes(req.user.role);
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
                // Un group_admin pertenece a su grupo administrado (admin_group_id) aunque
                // su columna `groups` esté vacía/desactualizada — sin esto, "Tomar ticket"
                // rechazaba (403) a un group_admin real del grupo, y el frontend lo mostraba
                // como si el ticket se hubiera "limpiado" de responsable (bug reportado en
                // vivo 2026-09-07, caso real: Javier Polanco, admin de BI & Development con
                // `groups: []`).
                const targetInGroup = targetUser?.role === 'admin'
                    || (targetUser?.role === 'group_admin' && targetUser?.admin_group_id === effectiveGroupId)
                    || (targetUser?.groups || []).includes(effectiveGroupId);
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
            // que solo pertenece al grupo A. Mismo criterio que el chequeo de "Tomar
            // ticket" más arriba: un group_admin cuenta por su admin_group_id, no
            // solo por `groups` (bug del mismo origen, 2026-09-07).
            if (ticket.ambito === 'interno' && targetAgentId && targetAgent?.role !== 'admin') {
                const targetInNewGroup = (targetAgent?.role === 'group_admin' && targetAgent?.admin_group_id === data.resolver_group_id)
                    || (targetAgent?.groups || []).includes(data.resolver_group_id);
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
        // `addedApoyoForNotif` queda declarada fuera del if para poder mandar el
        // correo "nuevo apoyo solicitado" más abajo, después de que el ticket ya
        // se actualizó (agregado 2026-09-14, a pedido del usuario).
        let addedApoyoForNotif = null;
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
                addedApoyoForNotif = addedApoyo;
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
            include: TICKET_FULL_INCLUDES
        });

        // Correo "nuevo apoyo solicitado" (2026-09-14, a pedido del usuario) — a
        // todo el grupo al que se le acaba de pedir apoyo, mismo patrón que
        // nuevoTicketSinAsignar (POST /api/tickets) pero para un apoyo agregado a
        // un ticket ya existente, no un ticket nuevo. Solo Volcán Desk.
        if (addedApoyoForNotif && updatedTicket.ambito === 'interno') (async () => {
            try {
                const targetGroup = addedApoyoForNotif.grupo_solicitado;
                if (!targetGroup || !(await isGroupEmailEventEnabled(targetGroup, 'nuevoApoyoSolicitado'))) return;
                const membersToNotify = await getGroupMemberUserIds(targetGroup);
                if (membersToNotify.length === 0) return;
                const groupInfo = await Group.findByPk(targetGroup);
                const groupName = groupInfo?.name || 'su grupo';
                const requesterName = req.user.id === updatedTicket.createdBy
                    ? (updatedTicket.Creator?.name || 'Un usuario')
                    : (await User.findByPk(req.user.id))?.name || 'Un usuario';
                const html = emailService.templates.newApoyoGroup(updatedTicket, groupName, requesterName);
                await Promise.all(membersToNotify.map(async u => {
                    if (u.email) await emailService.sendHtmlEmail(u.email, `[Apoyo solicitado] Ticket ${updatedTicket.id}`, html);
                }));
            } catch (err) {
                console.error('Error enviando correo de apoyo solicitado:', err);
            }
        })();

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
            // En tickets internos el rol no dice de qué lado está el usuario
            // (nadie tiene rol 'client' ahí) — hay que resolver solicitante vs
            // resolutor igual que al comentar (ver POST .../comments más abajo).
            if (ticket.ambito === 'interno') {
                const isRequester = req.user.id === ticket.createdBy;
                let side = isRequester ? 'solicitante' : null;
                if (!side && await isAuthorizedResolverGroupMember(ticket, req.user)) {
                    side = 'resolutor';
                } else if (!side && await isAuthorizedRequesterGroupMember(ticket, req.user)) {
                    side = 'solicitante';
                }
                if (side === 'solicitante') {
                    await ticket.update({ visto_por_cliente: true });
                } else if (side === 'resolutor') {
                    await ticket.update({ visto_por_agente: true });
                }
            } else if (role === 'client') {
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
        // Solo relevante para tickets 'interno' con comentario público: de qué
        // lado (solicitante/resolutor) es el autor, para actualizar
        // ultimo_mensaje_de/visto_por_* correctamente más abajo — ver nota junto
        // a esos campos.
        let commenterSide = null;

        if (isPrivate) {
            // Solo agentes/admins/group_admin pueden dejar notas privadas
            if (req.user.role === 'client') {
                return res.status(403).json({ error: 'Los clientes no pueden crear notas privadas.' });
            }
            // Una nota privada en Volcán Desk solo tiene sentido para quien de verdad
            // puede volver a verla: el grupo resolutor actual (o admin), o un grupo
            // con apoyo ACTIVO en este ticket — mismo criterio que sanitizeTicketForUser
            // ya usa para decidir quién LEE notas privadas (arriba). Antes cualquier
            // interno con acceso de vista al ticket podía crear una — incluido el
            // propio SOLICITANTE cuando no pertenece al grupo resolutor, que después
            // ni él mismo volvía a ver su propia nota. Confirmado en vivo 2026-09-21
            // con un caso real. Solo aplica a interno — Voltik no tiene este concepto
            // de "grupo resolutor" para notas privadas.
            if (ticket.ambito === 'interno') {
                const resolverAllowed = await isAuthorizedResolverGroupMember(ticket, req.user);
                let supportAllowed = false;
                if (!resolverAllowed) {
                    const currentUser = await User.findByPk(req.user.id);
                    const userGroups = currentUser?.groups || [];
                    const groupAdminScope = currentUser?.role === 'group_admin' && currentUser.admin_group_id ? [currentUser.admin_group_id] : [];
                    const accesosExtra = await AreaAccesoExtra.findAll({ where: { usuario_id: req.user.id } });
                    const allowedGroups = [...userGroups, ...groupAdminScope, ...accesosExtra.map(a => a.area_id)];
                    supportAllowed = (ticket.apoyos || []).some(a => allowedGroups.includes(a.grupo_solicitado) && a.status !== 'Resuelto');
                }
                if (!resolverAllowed && !supportAllowed) {
                    return res.status(403).json({ error: 'Solo un miembro del grupo resolutor (o de un grupo con apoyo activo) puede crear notas privadas en este ticket.' });
                }
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
                if (allowed) {
                    commenterSide = 'resolutor';
                } else {
                    allowed = await isAuthorizedRequesterGroupMember(ticket, req.user);
                    if (allowed) commenterSide = 'solicitante';
                }
            } else if (!allowed) {
                allowed = req.user.id === ticket.owner_agent_id || req.user.role === 'admin';
            }
            if (isRequester && ticket.ambito === 'interno') {
                commenterSide = 'solicitante';
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
            // Mismo campo, dos espacios de valores según ambito (sin cambio de
            // esquema): 'cliente'/'agente' para tickets externos (rol 'client'
            // existe), 'solicitante'/'resolutor' para internos (ver nota en la
            // creación del ticket, más arriba en este archivo). commenterSide ya
            // quedó resuelto en el bloque de permisos de arriba.
            const isClient = req.user.role === 'client';
            const fieldsToUpdate = ticket.ambito === 'interno'
                ? {
                    ultimo_mensaje_de: commenterSide || 'resolutor',
                    ultimo_mensaje_at: comment.createdAt || new Date(),
                    visto_por_agente: commenterSide === 'resolutor',
                    visto_por_cliente: commenterSide === 'solicitante'
                }
                : {
                    ultimo_mensaje_de: isClient ? 'cliente' : 'agente',
                    ultimo_mensaje_at: comment.createdAt || new Date(),
                    visto_por_agente: isClient ? false : true,
                    visto_por_cliente: isClient ? true : false
                };
            await Ticket.update(fieldsToUpdate, {
                where: { id: ticketId }
            });
        }
        
        // Retornar comentario con información de usuario
        const createdComment = await Comment.findByPk(comment.id, {
            include: [{ model: User, attributes: ['id', 'name', 'role', 'avatar'] }]
        });

        // Correo de @menciones (agregado 2026-09-14, a pedido del usuario) — corre
        // para CUALQUIER comentario, público o nota privada (igual que la
        // notificación in-app que ya existía en TicketDetailView.jsx: una mención
        // en una nota privada también avisa a quien fue mencionado). Se acota a
        // Volcán Desk porque el on/off vive en emailNotificationsByGroup, que solo
        // existe para grupos de ese módulo.
        (async () => {
            try {
                const mentionedIds = extractMentionedUserIds(comment.text).filter(id => id !== req.user.id);
                if (mentionedIds.length === 0) return;
                const ticketForMention = await Ticket.findByPk(ticketId, { attributes: ['id', 'title', 'ambito'] });
                if (!ticketForMention || ticketForMention.ambito !== 'interno') return;
                const authorName = createdComment.User ? createdComment.User.name : 'Un usuario';
                const mentionedUsers = await User.findAll({ where: { id: { [Op.in]: mentionedIds } } });
                await Promise.all(mentionedUsers.map(async (mu) => {
                    if (!mu.email) return;
                    if (!(await isGroupEmailEventEnabled(getUserOwnGroupId(mu), 'mencion'))) return;
                    const html = emailService.templates.mention(ticketForMention, comment, authorName, mu.name);
                    await emailService.sendHtmlEmail(mu.email, `Te mencionaron en [${ticketForMention.id}]`, html);
                }));
            } catch (err) {
                console.error('Error enviando correo de mención:', err);
            }
        })();

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

                        // Respuesta del grupo de APOYO (2026-09-14, a pedido del usuario): si
                        // quien comenta pertenece a un grupo de apoyo todavía activo en este
                        // ticket (y no es ni el solicitante ni del grupo resolutor), se le
                        // avisa al Resolutor — ninguna de las dos ramas de arriba cubre esta
                        // tercera parte, así que es un correo aparte, no un reemplazo.
                        const apoyosActivos = (ticketWithUsers.apoyos || []).filter(a => a.status !== 'Resuelto');
                        if (!isCreator && apoyosActivos.length > 0 && ticketWithUsers.OwnerAgent && ticketWithUsers.OwnerAgent.email) {
                            const commenterFull = await User.findByPk(req.user.id);
                            const commenterGroup = getUserOwnGroupId(commenterFull);
                            const isApoyoReply = commenterGroup && commenterGroup !== targetGroup
                                && apoyosActivos.some(a => a.grupo_solicitado === commenterGroup);
                            if (isApoyoReply && await isGroupEmailEventEnabled(targetGroup, 'respuestaApoyo')) {
                                const html = emailService.templates.newComment(ticketWithUsers, comment, authorName, ticketWithUsers.OwnerAgent.name);
                                await emailService.sendHtmlEmail(ticketWithUsers.OwnerAgent.email, `Respuesta de apoyo en [${ticketWithUsers.id}]`, html);
                            }
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

// Editar/eliminar un comentario propio dentro de 60s de enviado (2026-09-23,
// a pedido del usuario) — antes no existía ninguna forma de corregir un
// mensaje ya enviado, ni un segundo después. Ambas rutas comparten las mismas
// dos condiciones: solo el AUTOR original (nunca un compañero de grupo,
// aunque comparta acceso al ticket) y solo dentro de la ventana de 60s desde
// comment.createdAt — pasada esa ventana el botón ya ni debería aparecer en
// el frontend, pero el backend la vuelve a exigir por si acaso.
const EDIT_WINDOW_MS = 60 * 1000;

const loadOwnEditableComment = async (req, res, { checkAgainst } = {}) => {
    const { ticketId, commentId } = req.params;
    const comment = await Comment.findByPk(commentId);
    if (!comment || comment.ticketId !== ticketId) {
        res.status(404).json({ error: 'Comentario no encontrado' });
        return null;
    }
    if (comment.userId !== req.user.id) {
        res.status(403).json({ error: 'Solo puedes editar o eliminar tus propios comentarios.' });
        return null;
    }
    if (comment.isDeleted) {
        res.status(400).json({ error: 'Este comentario ya fue eliminado.' });
        return null;
    }
    const referenceTime = checkAgainst ?? Date.now();
    const elapsed = referenceTime - new Date(comment.createdAt).getTime();
    if (elapsed > EDIT_WINDOW_MS || elapsed < 0) {
        res.status(403).json({ error: 'Ya pasó el minuto para editar o eliminar este comentario.' });
        return null;
    }
    return comment;
};

app.put('/api/tickets/:ticketId/comments/:commentId', requireAuthenticated, async (req, res) => {
    try {
        // El guardado ya NO revalida el reloj actual contra comment.createdAt
        // (2026-09-28, a pedido del usuario: "no importa el tiempo que tarde"
        // una vez que ya le dio clic a editar dentro del minuto). Ahora se
        // valida el MOMENTO EN QUE SE ABRIÓ el editor — el cliente lo manda en
        // `startedEditingAt` (capturado en TicketDetailView.jsx al hacer clic en
        // el lápiz, que ya estaba gateado por esta misma ventana). Si no llega
        // (cliente viejo/sin ese campo), se cae al comportamiento anterior
        // (revisar el reloj actual) — sigue siendo spoofable por el mismo
        // modelo de auth por headers que ya tiene toda esta app (ver CLAUDE.md,
        // "Auth model"), no es una superficie de riesgo nueva.
        const startedEditingAt = Number(req.body.startedEditingAt);
        const checkAgainst = Number.isFinite(startedEditingAt) && startedEditingAt > 0 ? startedEditingAt : Date.now();
        const comment = await loadOwnEditableComment(req, res, { checkAgainst });
        if (!comment) return;
        const newText = (req.body.text || '').toString();
        if (!newText.trim()) {
            return res.status(400).json({ error: 'El comentario no puede quedar vacío.' });
        }
        comment.text = newText;
        // Columna dedicada, no updatedAt (ver comentario en db.js sobre por
        // qué updatedAt no es confiable para esto).
        comment.editedAt = new Date();
        await comment.save();
        const updatedComment = await Comment.findByPk(comment.id, {
            include: [{ model: User, attributes: ['id', 'name', 'role', 'avatar'] }]
        });
        res.json(updatedComment);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al editar el comentario' });
    }
});

app.delete('/api/tickets/:ticketId/comments/:commentId', requireAuthenticated, async (req, res) => {
    try {
        const comment = await loadOwnEditableComment(req, res);
        if (!comment) return;
        // Borrado suave: la fila (y su texto original) se conserva en la base de
        // datos por si algún día hace falta auditar, pero desde este momento
        // sanitizeTicketForUser nunca vuelve a mandar ese texto al cliente —
        // el frontend solo recibe isDeleted=true y pinta "Mensaje eliminado".
        comment.isDeleted = true;
        await comment.save();
        res.json({ id: comment.id, isDeleted: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al eliminar el comentario' });
    }
});

// --- RUTAS DE CAMPOS DINÁMICOS Y FLUJOS ---

// GET /api/campos-catalogo
app.get('/api/campos-catalogo', async (req, res) => {
    try {
        // Sin filtro por grupo/rol (revertido 2026-09-10, mismo motivo que GET
        // /api/config): un group_admin creando su PRIMER ticket hacia un grupo
        // nuevo nunca podía ver los campos inyectados de ese grupo, porque el
        // filtro anterior (visibleGroupIds) solo incluía grupos de tickets que ya
        // había creado antes — huevo y gallina. El frontend (FlowsConfigPage.jsx)
        // ya filtra por módulo activo client-side, igual que siempre hacía para
        // cualquier rol que no fuera group_admin.
        const campos = await CampoCatalogo.findAll();
        res.json(campos);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al obtener campos del catálogo' });
    }
});

// POST /api/campos-catalogo
// 2026-09-16 (a pedido del usuario): bloquea crear/renombrar un campo del
// catálogo a un nombre que ya usa otro campo dentro del mismo módulo+grupo+
// scope — el mismo alcance en el que el frontend ya los filtra y muestra
// juntos en una sola tabla. La comparación es case-insensitive porque la
// colación de la tabla (utf8mb4_unicode_ci) ya lo es por defecto.
app.post('/api/campos-catalogo', requireAdminOrGroupAdmin, async (req, res) => {
    try {
        const scope = await getGroupAdminScope(req.user);
        if (scope && req.body.grupo_id !== scope) {
            return res.status(403).json({ error: 'Solo puedes crear campos para tu propio grupo.' });
        }
        const nombre = (req.body.nombre || '').trim();
        const duplicate = await CampoCatalogo.findOne({
            where: {
                nombre,
                modulo: req.body.modulo || null,
                grupo_id: req.body.grupo_id || null,
                scope: req.body.scope || 'flujo'
            }
        });
        if (duplicate) {
            return res.status(409).json({ error: `Ya existe un campo llamado "${duplicate.nombre}" — edítalo en vez de crear uno nuevo.` });
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
        if (req.body.nombre !== undefined) {
            const nombre = req.body.nombre.trim();
            const duplicate = await CampoCatalogo.findOne({
                where: {
                    nombre,
                    modulo: req.body.modulo !== undefined ? req.body.modulo : campo.modulo,
                    grupo_id: req.body.grupo_id !== undefined ? req.body.grupo_id : campo.grupo_id,
                    scope: req.body.scope !== undefined ? req.body.scope : campo.scope,
                    id: { [Op.ne]: campo.id }
                }
            });
            if (duplicate) {
                return res.status(409).json({ error: `Ya existe un campo llamado "${duplicate.nombre}" — edítalo en vez de duplicarlo.` });
            }
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
        // Sin filtro por grupo/rol (revertido 2026-09-10, mismo motivo que GET
        // /api/config y /api/campos-catalogo): un group_admin creando su PRIMER
        // ticket hacia un grupo nuevo nunca podía ver las reglas de flujo (campos
        // inyectados por Tipo/Categoría) de ese grupo. El frontend
        // (FlowsConfigPage.jsx, `modReglas`) ya filtra por los Tipos del
        // módulo+grupo actual client-side.
        const reglas = await ReglaFlujo.findAll();
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
// 2026-09-16 (a pedido del usuario, tras encontrar en vivo una regla huérfana
// apuntando a una Categoría ya borrada): bloquea crear una segunda regla para
// el mismo Tipo+Categoría — activa o inactiva, cualquiera cuenta — en vez de
// dejar acumularse duplicados silenciosos. `categoria_id` se normaliza a
// `null` (en vez de '' / undefined) porque así es como Sequelize compara
// contra la columna real (IS NULL, no comparación de string vacío).
app.post('/api/reglas-flujo', requireAdminOrGroupAdmin, async (req, res) => {
    try {
        const scope = await getGroupAdminScope(req.user);
        if (scope && (await resolveTipoGroup(req.body.tipo_id)) !== scope) {
            return res.status(403).json({ error: 'Solo puedes crear reglas para tipos de tu propio grupo.' });
        }
        const categoriaId = req.body.categoria_id || null;
        const duplicate = await ReglaFlujo.findOne({ where: { tipo_id: req.body.tipo_id, categoria_id: categoriaId } });
        if (duplicate) {
            return res.status(409).json({ error: 'Ya existe una regla para esta combinación de Tipo y Categoría — edítala en vez de crear una nueva.' });
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
        const effectiveTipoId = req.body.tipo_id || regla.tipo_id;
        if (scope && (await resolveTipoGroup(effectiveTipoId)) !== scope) {
            return res.status(403).json({ error: 'Solo puedes modificar reglas de tu propio grupo.' });
        }
        // Mismo chequeo de duplicados que el POST, excluyendo esta misma regla
        // (si no cambió Tipo/Categoría, se estaría comparando contra sí misma).
        const effectiveCategoriaId = req.body.categoria_id !== undefined ? (req.body.categoria_id || null) : regla.categoria_id;
        const duplicate = await ReglaFlujo.findOne({
            where: { tipo_id: effectiveTipoId, categoria_id: effectiveCategoriaId, id: { [Op.ne]: regla.id } }
        });
        if (duplicate) {
            return res.status(409).json({ error: 'Ya existe otra regla para esta combinación de Tipo y Categoría — edítala en vez de duplicarla.' });
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
        console.log(`Servidor backend corriendo en http://localhost:${PORT}`);
        console.log(`Guardando archivos adjuntos en: ${getAttachmentDir()}`);
    });
});
