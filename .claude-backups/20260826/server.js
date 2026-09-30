const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Op, Sequelize } = require('sequelize');
const { sequelize, initDB, Ticket, User, Comment, Company, Config, Group, CampoCatalogo, ReglaFlujo, TicketCampoValor, AreaAccesoExtra, TicketBloqueoHistorial, Notification } = require('./db');
const emailService = require('./services/emailService');

const app = express();
const PORT = process.env.PORT || 4000;

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

// Función para procesar y decodificar adjuntos en base64
const processAttachments = (attachments) => {
    if (!attachments || !Array.isArray(attachments)) return [];

    const dir = getAttachmentDir();
    return attachments.map(att => {
        if (att.fileData && att.fileData.startsWith('data:')) {
            try {
                const parts = att.fileData.split(';base64,');
                const mime = parts[0].split(':')[1];
                const base64Data = parts[1];
                const buffer = Buffer.from(base64Data, 'base64');

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
            } catch (err) {
                console.error('Error al guardar archivo adjunto:', err);
                return att;
            }
        }
        return att; // Si ya tiene URL y no base64, dejarlo igual
    });
};

// Servir archivos adjuntos estáticamente
app.use('/api/uploads', express.static(getAttachmentDir()));

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
    'fecha_estimada_inicio', 'fecha_estimada_conclusion'
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
    const isApoyo = (ticketJson.apoyos || []).some(a => ctx.allowedGroups.includes(a.grupo_solicitado));
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
        const isApoyo = (ticket.apoyos || []).some(a => allowedGroups.includes(a.grupo_solicitado));
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

// ─── RUTAS DE CONFIGURACIÓN ──────────────────────────────────────────────────

app.get('/api/config', async (req, res) => {
    try {
        const configRow = await Config.findByPk('tms_config');
        if (configRow) {
            res.json(configRow.value);
        } else {
            res.status(404).json({ error: 'Configuración no encontrada' });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al obtener la configuración' });
    }
});

app.post('/api/config', async (req, res) => {
    try {
        // group_admin: solo puede tocar sus propios ítems de Tipos/Categorías/Prioridades/Productos
        // dentro de Volcán Desk — todo lo demás en el config debe llegar sin cambios.
        if (req.user.role === 'group_admin') {
            const scope = await getGroupAdminScope(req.user);
            if (!scope) {
                return res.status(403).json({ error: 'Tu usuario no tiene un grupo administrado asignado.' });
            }
            const currentRow = await Config.findByPk('tms_config');
            const current = currentRow?.value || {};
            const incoming = req.body || {};
            const SCOPED_SECTIONS = ['types', 'categories', 'priorities', 'products'];
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
                if (SCOPED_SECTIONS.includes(key)) return false;
                return JSON.stringify(current[key]) !== JSON.stringify(incoming[key]);
            });
            if (otherKeysChanged) {
                return res.status(403).json({ error: 'No tienes permiso para modificar esta parte de la configuración.' });
            }
            for (const section of SCOPED_SECTIONS) {
                const currentOthers = (current[section] || []).filter(belongsToOther);
                const incomingOthers = (incoming[section] || []).filter(belongsToOther);
                if (JSON.stringify(currentOthers) !== JSON.stringify(incomingOthers)) {
                    return res.status(403).json({ error: 'Solo puedes modificar el catálogo de tu propio grupo.' });
                }
            }
        }

        const [configRow] = await Config.upsert({
            key: 'tms_config',
            value: req.body
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

app.post('/api/companies', async (req, res) => {
    try {
        const company = await Company.create(req.body);
        res.status(201).json(company);
    } catch (error) {
        console.error(error);
        res.status(400).json({ error: 'Datos de compañía inválidos' });
    }
});

app.put('/api/companies/:id', async (req, res) => {
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

app.delete('/api/companies/:id', async (req, res) => {
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

app.post('/api/groups', async (req, res) => {
    try {
        const group = await Group.create(req.body);
        res.status(201).json(group);
    } catch (error) {
        console.error(error);
        res.status(400).json({ error: 'Datos de grupo inválidos' });
    }
});

app.put('/api/groups/:id', async (req, res) => {
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

app.delete('/api/groups/:id', async (req, res) => {
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

app.get('/api/users', async (req, res) => {
    try {
        const users = await User.findAll({
            include: [{ model: Company, attributes: ['id', 'name'] }]
        });
        res.json(users);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al obtener usuarios' });
    }
});

app.post('/api/users', requireAdminOrGroupAdmin, async (req, res) => {
    try {
        const user = await User.create(req.body);
        res.status(201).json(user);
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
            // que un agente/supervisor "migre" de Voltik a Volcán Desk (o viceversa)
            // por una edición. Si la misma persona debe atender ambos módulos, se
            // crea una cuenta nueva para el otro módulo.
            const data = { ...req.body };
            delete data.modulo;
            await user.update(data);
            res.json(user);
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

app.get('/api/tickets', async (req, res) => {
    try {
        const { ambito } = req.query; // 'externo' o 'interno'
        const whereClause = {};

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
        const ctx = await getUserGroupContext(req.user);
        res.json(tickets.map(t => sanitizeTicketForUser(t.toJSON(), req.user, ctx)));
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al obtener tickets' });
    }
});

app.get('/api/tickets/:id', async (req, res) => {
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

app.post('/api/tickets', async (req, res) => {
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

        const ticket = await Ticket.create(data);

        // Save dynamic field values
        if (req.body.camposValores && typeof req.body.camposValores === 'object') {
            const fieldInserts = Object.keys(req.body.camposValores).map(campoId => ({
                ticket_id: ticket.id,
                campo_id: campoId,
                valor: String(req.body.camposValores[campoId] === null || req.body.camposValores[campoId] === undefined ? '' : req.body.camposValores[campoId])
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

        // Enviar notificaciones de correo de forma asíncrona
        (async () => {
            try {
                const creatorName = createdTicket.Creator ? createdTicket.Creator.name : 'Usuario';
                
                if (createdTicket.owner_agent_id) {
                    // Ya tiene un usuario resolutor asignado
                    const assignedUser = await User.findByPk(createdTicket.owner_agent_id);
                    if (assignedUser && assignedUser.email) {
                        const html = emailService.templates.newTicketUser(createdTicket, assignedUser, creatorName);
                        await emailService.sendHtmlEmail(assignedUser.email, `[Nuevo Ticket] VD-${createdTicket.id}: ${createdTicket.title}`, html);
                    }
                } else if (createdTicket.resolver_group_id || createdTicket.group) {
                    // Opción A: No tiene usuario, notificar a todos los del grupo
                    const targetGroup = createdTicket.resolver_group_id || createdTicket.group;
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
                                await emailService.sendHtmlEmail(u.email, `[Bandeja de Grupo] Nuevo Ticket VD-${createdTicket.id}`, html);
                            }
                        }));
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

app.put('/api/tickets/:id', async (req, res) => {
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
        if (ticket.ambito === 'interno' && isInternalUser && data.resolver_agent_id !== undefined
            && data.resolver_group_id === undefined && data.resolver_agent_id !== ticket.resolver_agent_id) {
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
        const RESOLVER_ONLY_FIELDS = ['status', 'priority', 'category', 'type', 'product', 'bloqueado', 'motivo_bloqueo', 'etiquetas', 'fecha_estimada_inicio', 'fecha_estimada_conclusion'];
        if (ticket.ambito === 'interno' && isInternalUser && data.resolver_group_id === undefined) {
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

app.put('/api/tickets/:id/read', async (req, res) => {
    try {
        const { role } = req.body;
        const ticket = await Ticket.findByPk(req.params.id);
        if (ticket) {
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

app.delete('/api/tickets/:id', async (req, res) => {
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

app.post('/api/tickets/:ticketId/comments', async (req, res) => {
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
                    
                    if (ticketWithUsers) {
                        const authorName = createdComment.User ? createdComment.User.name : 'Un usuario';
                        const isCreator = req.user.id === ticketWithUsers.createdBy;
                        
                        // Si comenta el solicitante -> notificar al resolutor
                        if (isCreator && ticketWithUsers.OwnerAgent && ticketWithUsers.OwnerAgent.email) {
                            const html = emailService.templates.newComment(ticketWithUsers, comment, authorName, ticketWithUsers.OwnerAgent.name);
                            await emailService.sendHtmlEmail(ticketWithUsers.OwnerAgent.email, `Nuevo mensaje en [VD-${ticketWithUsers.id}]`, html);
                        } 
                        // Si comenta el agente -> notificar al solicitante
                        else if (!isCreator && ticketWithUsers.Creator && ticketWithUsers.Creator.email) {
                            const html = emailService.templates.newComment(ticketWithUsers, comment, authorName, ticketWithUsers.Creator.name);
                            await emailService.sendHtmlEmail(ticketWithUsers.Creator.email, `Nuevo mensaje en [VD-${ticketWithUsers.id}]`, html);
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
        const campos = await CampoCatalogo.findAll();
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
app.post('/api/notifications', async (req, res) => {
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

app.put('/api/notifications/read-all', async (req, res) => {
    try {
        if (!req.user.id) return res.status(401).json({ error: 'No autenticado' });
        await Notification.update({ read: true }, { where: { toUserId: req.user.id, read: false } });
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al marcar notificaciones leídas' });
    }
});

app.put('/api/notifications/:id/read', async (req, res) => {
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

app.delete('/api/notifications/:id', async (req, res) => {
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
