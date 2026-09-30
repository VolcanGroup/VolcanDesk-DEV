require('dotenv').config();
const { Sequelize, DataTypes } = require('sequelize');

// Configuración de conexión a MariaDB/MySQL
const sequelize = new Sequelize(
    process.env.DB_NAME || 'tickets_db',
    process.env.DB_USER || 'tickets_user',
    process.env.DB_PASSWORD || 'TktPass2026!',
    {
        host: process.env.DB_HOST || '10.23.105.36',
        port: process.env.DB_PORT || 3306,
        dialect: 'mysql',
        logging: false,
        dialectOptions: {
            // Permitir fechas locales correctas
            dateStrings: true,
            typeCast: true
        },
        timezone: '-06:00' // Ajustar a tu huso horario local si es necesario
    }
);

// Modelos

const Company = sequelize.define('Company', {
    id: { type: DataTypes.STRING, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    name: { type: DataTypes.STRING, allowNull: false },
    emisor: { type: DataTypes.STRING, defaultValue: '' },
    tipoSaldos: { type: DataTypes.STRING, defaultValue: 'internos' },
    tipoBin: { type: DataTypes.STRING, defaultValue: 'sponsor' },
    embozador: { type: DataTypes.STRING, defaultValue: '' },
    contactosPrincipales: { type: DataTypes.JSON }, // [{name, email}]
    funcionariosAdjunto: { type: DataTypes.JSON }, // {name, dataUrl, type}
    notes: { type: DataTypes.TEXT }
});

const User = sequelize.define('User', {
    id: { type: DataTypes.STRING, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    name: { type: DataTypes.STRING, allowNull: false },
    email: { type: DataTypes.STRING, unique: true, allowNull: false },
    password: { type: DataTypes.STRING, allowNull: false },
    // 'group_admin': admin de un solo grupo de soporte en Volcán Desk — ve/configura
    // catálogos (Tipos, Categorías, Campos, Flujos, Prioridades y SLA) solo de su
    // grupo (admin_group_id) y tiene acceso a los tickets de ese grupo como un admin,
    // pero NO puede gestionar Usuarios (eso es exclusivo de 'admin').
    role: { type: DataTypes.ENUM('admin', 'group_admin', 'agent', 'supervisor', 'client'), defaultValue: 'client' },
    // Módulo al que pertenece el usuario interno (agent/supervisor). Se define una
    // sola vez al crearlo y nunca cambia — evita que un usuario "viva" en ambos
    // módulos a la vez. No aplica a 'admin' (rol global) ni a 'client' (siempre Voltik).
    modulo: { type: DataTypes.STRING, defaultValue: 'voltik' },
    // Solo aplica cuando role='group_admin': el único grupo (Volcán Desk) que administra.
    admin_group_id: { type: DataTypes.STRING, allowNull: true, references: { model: 'Groups', key: 'id' } },
    groups: { type: DataTypes.JSON }, // Array de strings ['ig1', 'ig2']
    avatar: { type: DataTypes.STRING },
    phone: { type: DataTypes.STRING, defaultValue: '' },
    position: { type: DataTypes.STRING, defaultValue: '' }
});

const Ticket = sequelize.define('Ticket', {
    id: { type: DataTypes.STRING, primaryKey: true }, // Format: TKT-1001
    title: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT('long'), allowNull: false },
    status: { type: DataTypes.STRING, defaultValue: 'new' }, // new, in progress, resolved, closed
    priority: { type: DataTypes.STRING, defaultValue: 'medium' }, // low, medium, high, urgent
    category: { type: DataTypes.STRING }, // Categoría de ticket
    group: { type: DataTypes.STRING }, // Grupo asignado
    product: { type: DataTypes.STRING },
    type: { type: DataTypes.STRING }, // Tipo de ticket
    tags: { type: DataTypes.JSON }, // Array de strings
    attachments: { type: DataTypes.JSON }, // [{id, fileName, fileSize, fileType, fileUrl}]
    activities: { type: DataTypes.JSON }, // Array de objetos log de cambios
    owner_agent_id: { type: DataTypes.STRING },
    resolver_agent_id: { type: DataTypes.STRING },
    resolver_group_id: { type: DataTypes.STRING },
    previous_owner_id: { type: DataTypes.STRING },
    ultimo_mensaje_de: { type: DataTypes.STRING, defaultValue: 'cliente' },
    ultimo_mensaje_at: { type: DataTypes.DATE },
    visto_por_agente: { type: DataTypes.BOOLEAN, defaultValue: false },
    visto_por_cliente: { type: DataTypes.BOOLEAN, defaultValue: false },
    ambito: { type: DataTypes.ENUM('externo', 'interno'), defaultValue: 'externo' },
    bloqueado: { type: DataTypes.BOOLEAN, defaultValue: false },
    motivo_bloqueo: { type: DataTypes.STRING },
    etiquetas: { type: DataTypes.JSON },
    area_origen_id: { type: DataTypes.STRING, references: { model: 'Groups', key: 'id' } },
    // Planificación (Volcán Desk): capturadas a mano por el resolutor, no son un compromiso duro —
    // solo ayudan a solicitante/resolutor a ubicarse. fecha_resolucion es la única automática:
    // se estampa sola cuando el ticket entra a un estado terminal.
    fecha_estimada_inicio: { type: DataTypes.DATEONLY, allowNull: true },
    fecha_estimada_conclusion: { type: DataTypes.DATEONLY, allowNull: true },
    fecha_resolucion: { type: DataTypes.DATE, allowNull: true },
    apoyos: { type: DataTypes.JSON, defaultValue: [] } // [{ id, grupo_solicitado, status, fecha_solicitud, fecha_respuesta, descripcion, responded_by }]
});

const Comment = sequelize.define('Comment', {
    id: { type: DataTypes.STRING, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    text: { type: DataTypes.TEXT('long'), allowNull: false },
    isPrivate: { type: DataTypes.BOOLEAN, defaultValue: false },
    attachments: { type: DataTypes.JSON } // [{id, fileName, fileSize, fileType, fileUrl}]
});

const Config = sequelize.define('Config', {
    key: { type: DataTypes.STRING, primaryKey: true },
    value: { type: DataTypes.JSON, allowNull: false }
});

const Group = sequelize.define('Group', {
    id: { type: DataTypes.STRING, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    name: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT },
    transfiere_propiedad: { type: DataTypes.BOOLEAN, defaultValue: false },
    modulo: { type: DataTypes.STRING, defaultValue: 'voltik' }
});

const AreaAccesoExtra = sequelize.define('AreaAccesoExtra', {
    id: { type: DataTypes.STRING, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    usuario_id: { type: DataTypes.STRING, allowNull: false },
    area_id: { type: DataTypes.STRING, references: { model: 'Groups', key: 'id' }, allowNull: false },
    nivel: { type: DataTypes.STRING, defaultValue: 'lectura' }
});

const TicketBloqueoHistorial = sequelize.define('TicketBloqueoHistorial', {
    id: { type: DataTypes.STRING, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    ticket_id: { type: DataTypes.STRING, references: { model: 'Tickets', key: 'id' }, allowNull: false },
    motivo: { type: DataTypes.STRING },
    bloqueado_desde: { type: DataTypes.DATE, allowNull: false },
    bloqueado_hasta: { type: DataTypes.DATE, allowNull: true }
});

const CampoCatalogo = sequelize.define('CampoCatalogo', {
    id: { type: DataTypes.STRING, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    nombre: { type: DataTypes.STRING, allowNull: false },
    tipo_dato: { type: DataTypes.ENUM('texto', 'numero', 'fecha', 'hora', 'moneda', 'select', 'archivo'), defaultValue: 'texto' },
    opciones: { type: DataTypes.JSON }, // Array de strings para select
    formato: { type: DataTypes.STRING }, // Mascara o formato
    // 'flujo'  -> reutilizable en Reglas de Flujo (condicional por Tipo/Categoría)
    // 'base'   -> campo fijo, siempre visible en el formulario de un módulo (no se mezcla con 'flujo')
    scope: { type: DataTypes.ENUM('flujo', 'base'), defaultValue: 'flujo' },
    modulo: { type: DataTypes.STRING, defaultValue: 'voltik' }, // aplica a ambos scopes: separa Voltik de Volcán Desk
    // Solo aplica cuando modulo='volcan_desk': a qué Grupo de soporte pertenece este campo,
    // para que Finanzas/BI/Proyectos/etc. no compartan catálogo entre sí. null = sin
    // grupo asignado todavía (dato legado, pendiente de reasignar desde la UI). No aplica a Voltik.
    grupo_id: { type: DataTypes.STRING, allowNull: true, references: { model: 'Groups', key: 'id' } },
    obligatorio: { type: DataTypes.BOOLEAN, defaultValue: false }, // solo aplica cuando scope='base'
    orden: { type: DataTypes.INTEGER, defaultValue: 1 } // solo aplica cuando scope='base'
});

const ReglaFlujo = sequelize.define('ReglaFlujo', {
    id: { type: DataTypes.STRING, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    tipo_id: { type: DataTypes.STRING, allowNull: false },
    categoria_id: { type: DataTypes.STRING, allowNull: true },
    activo: { type: DataTypes.BOOLEAN, defaultValue: true },
    campos: { type: DataTypes.JSON, defaultValue: [] } // [{ campo_id, obligatorio: boolean, orden: number }]
});

const TicketCampoValor = sequelize.define('TicketCampoValor', {
    id: { type: DataTypes.STRING, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    ticket_id: { type: DataTypes.STRING, allowNull: false },
    campo_id: { type: DataTypes.STRING, allowNull: false },
    valor: { type: DataTypes.TEXT }
});

// Antes las notificaciones vivían solo en localStorage del navegador que
// disparaba la acción (ver notificationService.js), así que nunca llegaban
// realmente a otro usuario/dispositivo — de ahí el reporte de "las
// notificaciones no funcionan". Persistidas aquí para que cualquier sesión
// del usuario destinatario las vea al hacer polling, y para poder disparar
// notificaciones por correo desde el mismo evento más adelante.
const Notification = sequelize.define('Notification', {
    id: { type: DataTypes.STRING, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    toUserId: { type: DataTypes.STRING, allowNull: false },
    fromUser: { type: DataTypes.JSON }, // snapshot {id, name} de quien la disparó
    ticketId: { type: DataTypes.STRING },
    ticketTitle: { type: DataTypes.STRING },
    // 'new_ticket' | 'reply_requester' | 'reply_resolver' | 'escalation' | 'mention'
    type: { type: DataTypes.STRING },
    message: { type: DataTypes.STRING, allowNull: false },
    read: { type: DataTypes.BOOLEAN, defaultValue: false }
});

// Relaciones

Company.hasMany(User, { foreignKey: 'companyId', constraints: false });
User.belongsTo(Company, { foreignKey: 'companyId', constraints: false });

User.hasMany(Ticket, { foreignKey: 'createdBy', as: 'Creator', constraints: false });
Ticket.belongsTo(User, { foreignKey: 'createdBy', as: 'Creator', constraints: false });

User.hasMany(Ticket, { foreignKey: 'assignedTo', as: 'Agent', constraints: false });
Ticket.belongsTo(User, { foreignKey: 'assignedTo', as: 'Agent', constraints: false });

User.hasMany(Ticket, { foreignKey: 'owner_agent_id', as: 'OwnerAgent', constraints: false });
Ticket.belongsTo(User, { foreignKey: 'owner_agent_id', as: 'OwnerAgent', constraints: false });

User.hasMany(Ticket, { foreignKey: 'resolver_agent_id', as: 'ResolverAgent', constraints: false });
Ticket.belongsTo(User, { foreignKey: 'resolver_agent_id', as: 'ResolverAgent', constraints: false });

Company.hasMany(Ticket, { foreignKey: 'companyId', as: 'CompanyTickets', constraints: false });
Ticket.belongsTo(Company, { foreignKey: 'companyId', as: 'Company', constraints: false });

Ticket.hasMany(Comment, { foreignKey: 'ticketId', as: 'comments', onDelete: 'CASCADE', constraints: false });
Comment.belongsTo(Ticket, { foreignKey: 'ticketId', constraints: false });

User.hasMany(Comment, { foreignKey: 'userId', constraints: false });
Comment.belongsTo(User, { foreignKey: 'userId', constraints: false });

TicketCampoValor.belongsTo(CampoCatalogo, { foreignKey: 'campo_id', as: 'Campo', constraints: false });
CampoCatalogo.hasMany(TicketCampoValor, { foreignKey: 'campo_id', constraints: false });

Ticket.hasMany(TicketCampoValor, { foreignKey: 'ticket_id', as: 'camposValores', onDelete: 'CASCADE', constraints: false });
TicketCampoValor.belongsTo(Ticket, { foreignKey: 'ticket_id', constraints: false });

Ticket.hasMany(TicketBloqueoHistorial, { foreignKey: 'ticket_id', as: 'bloqueos', onDelete: 'CASCADE', constraints: false });
TicketBloqueoHistorial.belongsTo(Ticket, { foreignKey: 'ticket_id', constraints: false });

Group.hasMany(Ticket, { foreignKey: 'area_origen_id', as: 'AreaOrigenTickets' });
Ticket.belongsTo(Group, { foreignKey: 'area_origen_id', as: 'AreaOrigen' });

// Initialize Function
const initDB = async () => {
    try {
        await sequelize.authenticate();
        console.log('Conexión a MariaDB establecida correctamente.');
        
        // Sync creará las tablas si no existen.
        await sequelize.sync({ alter: true });
        console.log('Modelos sincronizados con la BD de MariaDB.');
    } catch (error) {
        console.error('No se pudo conectar a la BD de MariaDB:', error);
    }
};

module.exports = { sequelize, initDB, User, Company, Ticket, Comment, Config, Group, CampoCatalogo, ReglaFlujo, TicketCampoValor, AreaAccesoExtra, TicketBloqueoHistorial, Notification };
