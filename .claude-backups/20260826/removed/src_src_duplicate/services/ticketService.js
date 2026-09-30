import { api } from './api';
import { generateId, generateConsecutiveId } from '../utils/helpers';
import { getCurrentUser } from './authService';
import { isOnHoldStatus, isTerminalStatus } from './configService';
import { getCompanyById } from './companyService';
import { getGroupById } from './groupService';
import { getUsers } from './userService';
import { sendNotifications } from './notificationService';

// ─── Group scoping helpers (Dashboard / Reportes) ─────────────────────────────
// Mismo criterio que Tickets.jsx usa para sus 4 vistas de Volcán Desk: para
// group_admin, su único grupo administrado; para el resto, los grupos de los
// que es miembro. Un admin sin grupo propio no tiene "mi grupo" — ve todo.
export const getUserGroupsForScoping = (currentUser) => {
    if (!currentUser) return [];
    if (currentUser.role === 'group_admin') return [currentUser.admin_group_id].filter(Boolean);
    return currentUser.groups || [];
};

// ¿El ticket me pertenece directamente (soy el solicitante o el responsable)?
export const isMyTicket = (t, currentUser) =>
    t.createdBy === currentUser?.id || t.assignedTo === currentUser?.id || t.resolver_agent_id === currentUser?.id;

// ¿El ticket pertenece a alguno de mis grupos, como solicitante o resolutor?
// `t.group` puede venir como nombre en vez de id en algunos tickets viejos —
// resolver_group_id es la fuente de verdad cuando existe.
export const isGroupTicket = (t, myGroups) =>
    myGroups.includes(t.area_origen_id) || myGroups.includes(t.resolver_group_id || t.group);

// ─── Notificaciones (solo Volcán Desk, ambito='interno') ───────────────────
// 4 eventos: 1) ticket nuevo -> grupo resolutor; 2) el resolutor responde ->
// solicitante; 3) el solicitante responde -> resolutor (el agente asignado
// si ya hay uno, o todo el grupo si el ticket sigue sin asignar); 4)
// escalación -> el grupo destino. Voltik no usa esto — ya tiene su propio
// flujo de notificación por @menciones en TicketDetailView.jsx.
const membersOfGroup = (groupId, excludeUserId) => {
    if (!groupId) return [];
    return getUsers().filter(u =>
        u.id !== excludeUserId &&
        ((u.groups || []).includes(groupId) || u.admin_group_id === groupId)
    );
};

const notifyGroup = (groupId, { fromUser, ticketId, ticketTitle, message, type }, excludeUserId) => {
    const recipients = membersOfGroup(groupId, excludeUserId);
    if (recipients.length === 0) return;
    sendNotifications(recipients.map(u => ({ toUserId: u.id, fromUser, ticketId, ticketTitle, message, type })));
};

const notifyUser = (toUserId, { fromUser, ticketId, ticketTitle, message, type }, excludeUserId) => {
    if (!toUserId || toUserId === excludeUserId) return;
    sendNotifications([{ toUserId, fromUser, ticketId, ticketTitle, message, type }]);
};

const STORAGE_KEY = 'tms_tickets';
let cachedTickets = [];

// IDs de tickets con una escritura optimista (crear/editar/comentar/adjuntar/
// escalar/borrar) todavía en vuelo hacia el servidor. loadTicketsFromServer()
// se llama cada 8s desde varias páginas (Tickets/Dashboard/Reports) además de
// al montar la app — si ese GET sale (o el servidor responde) antes de que el
// POST/PUT optimista termine de comprometerse, el GET trae una versión vieja
// (o de plano no trae el ticket, si es una creación reciente) y el reemplazo
// completo `cachedTickets = tickets` borraba silenciosamente el cambio local
// hasta el siguiente refresco — el reporte era "creo un ticket/comentario y a
// veces desaparece, pero al refrescar vuelve a aparecer". Con este set,
// loadTicketsFromServer conserva la versión local de cualquier ticket con una
// escritura pendiente en vez de pisarla con la respuesta del servidor.
const pendingTicketWrites = new Set();

// Encadena los PUT hacia el mismo ticket para que lleguen al servidor en el
// mismo orden en que el usuario disparó los cambios. Sin esto, dos ediciones
// rápidas y consecutivas al mismo ticket (ej. cambiar el select de "Grupo"
// dos veces seguidas) generan dos PUT en paralelo cuya respuesta — y cuyo
// UPDATE en la base — puede llegar en cualquier orden: si el PRIMER PUT
// termina de procesarse en el servidor DESPUÉS que el segundo, su resultado
// pisa el del segundo y el cambio más reciente se pierde en silencio. Bug
// reportado en vivo: cambiar "Grupo" dos veces seguidas dejaba el ticket en
// el primer grupo elegido (con categoría/tipo ya reseteados por el segundo
// intento) en vez del segundo. `enqueueTicketWrite` no toca el cache local
// (que ya se actualiza de forma optimista y síncrona, en orden correcto) —
// solo pospone el envío de red hasta que la escritura anterior a este mismo
// ticket haya recibido respuesta.
const pendingWriteChains = new Map();
const enqueueTicketWrite = (id, writeFn) => {
    const prevChain = pendingWriteChains.get(id) || Promise.resolve();
    const thisWrite = prevChain.catch(() => {}).then(writeFn);
    pendingWriteChains.set(id, thisWrite);
    return thisWrite;
};

// Combina la respuesta fresca del servidor con el cache local, respetando
// cualquier ticket con una escritura optimista todavía pendiente (ver arriba).
const mergeServerTickets = (freshTickets) => {
    if (pendingTicketWrites.size === 0) return freshTickets;
    const freshById = new Map(freshTickets.map(t => [t.id, t]));
    const localById = new Map(cachedTickets.map(t => [t.id, t]));
    // Si un ticket pendiente ya no está en el cache local, es que se borró
    // localmente (deleteTicket) — no dejar que la respuesta del servidor,
    // que todavía no procesó el DELETE, lo "resucite".
    const merged = freshTickets
        .filter(t => !(pendingTicketWrites.has(t.id) && !localById.has(t.id)))
        .map(t => (pendingTicketWrites.has(t.id) ? (localById.get(t.id) || t) : t));
    // Tickets recién creados que el servidor todavía no devuelve en el GET.
    localById.forEach((t, id) => {
        if (pendingTicketWrites.has(id) && !freshById.has(id)) merged.push(t);
    });
    return merged;
};

// Default tickets to seed if database is empty
const defaultTickets = [
    {
        id: 'TKT-1001',
        title: 'Error en el sistema de login',
        description: '<p>Los usuarios no pueden iniciar sesión correctamente.</p>',
        status: 'in_progress',
        priority: 'urgent',
        assignedTo: '2',
        createdBy: 'su1',
        createdAt: new Date(Date.now() - 3600000 * 5).toISOString(),
        updatedAt: new Date(Date.now() - 3600000 * 2).toISOString(),
        comments: [
            {
                id: 'c_default_1',
                userId: '2',
                text: 'Investigando el problema, parece ser un issue con la base de datos',
                createdAt: new Date(Date.now() - 3600000 * 2).toISOString(),
                isPrivate: false,
                attachments: []
            }
        ],
        attachments: [],
        activities: [
            {
                id: 'act_1',
                type: 'created',
                userId: 'su1',
                ts: new Date(Date.now() - 3600000 * 5).toISOString(),
                data: { status: 'new' }
            },
            {
                id: 'act_2',
                type: 'status_change',
                userId: '2',
                ts: new Date(Date.now() - 3600000 * 2).toISOString(),
                data: { from: 'new', to: 'in_progress' }
            }
        ]
    },
    {
        id: 'TKT-1002',
        title: 'Solicitud de nueva funcionalidad',
        description: '<p>Añadir exportación de reportes a Excel en el dashboard principal.</p>',
        status: 'new',
        priority: 'medium',
        assignedTo: null,
        createdBy: 'su1',
        createdAt: new Date(Date.now() - 3600000 * 24).toISOString(),
        updatedAt: new Date(Date.now() - 3600000 * 24).toISOString(),
        comments: [],
        attachments: [],
        activities: [
            {
                id: 'act_3',
                type: 'created',
                userId: 'su1',
                ts: new Date(Date.now() - 3600000 * 24).toISOString(),
                data: { status: 'new' }
            }
        ]
    }
];

// Load tickets from server
export const loadTicketsFromServer = async () => {
    try {
        // El backend, si no se le pide explícitamente, solo devuelve ambito='externo'.
        // Los usuarios internos (agent/supervisor/admin) también necesitan los
        // 'interno' para que Volcán Desk (y su polling) no pierda tickets ya creados.
        const currentUser = getCurrentUser();
        const isInternalUser = currentUser?.role && currentUser.role !== 'client';

        let tickets = await api.get('/tickets');
        if (isInternalUser) {
            const internos = await api.get('/tickets?ambito=interno');
            tickets = [...tickets, ...internos];
        }

        if (tickets.length === 0) {
            console.log('Database has no tickets. Seeding default tickets...');
            for (const ticket of defaultTickets) {
                // Remove comments because they will be added separately or handled
                const { comments, ...ticketData } = ticket;
                const created = await api.post('/tickets', ticketData);

                // Add comments to database for the seeded ticket
                if (comments && comments.length > 0) {
                    for (const comment of comments) {
                        const { id: _, ...commentData } = comment;
                        await api.post(`/tickets/${created.id}/comments`, commentData);
                    }
                }
            }
            tickets = await api.get('/tickets');
        }
        cachedTickets = mergeServerTickets(tickets);
        return cachedTickets;
    } catch (error) {
        console.error('Failed to load tickets from server, using local fallback:', error);
        const local = localStorage.getItem(STORAGE_KEY);
        cachedTickets = local ? JSON.parse(local) : defaultTickets;
        return cachedTickets;
    }
};

// Get all tickets (sync)
export const getTickets = () => {
    return cachedTickets;
};

// Tickets visibles para currentUser dentro del workspace activo (ambito).
// Misma regla que Tickets.jsx usa para su listado base: filtra por ambito y,
// para 'agent', por pertenencia a grupo/área de origen o autoría (igual que
// checkTicketAccess en el backend). Se centraliza aquí porque Dashboard y
// Reports necesitan el mismo recorte y no deben quedar desincronizados de él.
export const getVisibleTickets = (currentUser, activeWorkspace) => {
    const currentAmbito = activeWorkspace === 'volcan_desk' ? 'interno' : 'externo';
    let visible = getTickets().filter(t => (t.ambito || 'externo') === currentAmbito);

    if (currentUser?.role === 'agent') {
        const userGroups = currentUser.groups || [];
        // t.group puede venir como NOMBRE en vez de id en tickets viejos/reasignados
        // (ej. tras un "Escalar/Transferir") — resolver_group_id es la fuente de
        // verdad cuando existe. Comparar solo contra t.group hacía que un ticket
        // ruteado al grupo del agente pero aún sin asignar a nadie desapareciera
        // por completo de Dashboard/Reportes (y de este listado base).
        visible = visible.filter(t =>
            userGroups.includes(t.resolver_group_id || t.group) ||
            userGroups.includes(t.area_origen_id) ||
            t.createdBy === currentUser.id
        );
    } else if (currentUser?.role === 'client') {
        visible = visible.filter(t => t.companyId === currentUser.companyId);
    }
    // Admin y Supervisor ven todo dentro del ambito activo (igual que en Tickets.jsx)

    return visible;
};

// Get ticket by ID (sync)
export const getTicketById = (id) => {
    return cachedTickets.find(ticket => ticket.id === id);
};

// Create ticket (optimistic sync cache + async DB write & swap)
export const createTicket = (ticketData) => {
    const currentUser = getCurrentUser();
    const now = new Date().toISOString();
    
    const cleanString = (str) => {
        if (!str) return '';
        return str.normalize('NFD').replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, '');
    };
    const isInterno = ticketData.ambito === 'interno';
    const company = getCompanyById(ticketData.companyId);

    let nextId;
    if (isInterno) {
        // v1 usaba el prefijo fijo "VOLCANDESK" para todo Volcán Desk (colisionaba
        // entre grupos). v2 usó el grupo RESOLUTOR (TI-CREDITO-00001) — pero el
        // resolutor es mutable: una escalación (TI -> Finanzas) hubiera obligado a
        // renombrar el ticket, y un identificador no debería cambiar nunca.
        // v3 (definitiva): el grupo SOLICITANTE (area_origen_id) sí es un dato
        // histórico fijo — de dónde nació el ticket — y el consecutivo es GLOBAL
        // (no por grupo/prefijo), para que sobreviva a una reorganización de
        // grupos y cada número sea único. Formato: VD-<ORIGEN>-<000001 global>.
        // El grupo/producto/tipo/etc. viven como datos normales del ticket, no
        // como parte del id.
        const originGroup = getGroupById(ticketData.area_origen_id) || getGroupById(ticketData.group);
        const originClean = cleanString(originGroup?.name) || 'DESK';
        const prefix = `VD-${originClean}`;

        let maxNum = 0;
        cachedTickets.forEach(t => {
            if ((t.ambito || 'externo') === 'interno' && typeof t.id === 'string' && t.id.startsWith('VD-')) {
                const parts = t.id.split('-');
                const num = parseInt(parts[parts.length - 1], 10);
                if (!isNaN(num) && num > maxNum) maxNum = num;
            }
        });
        nextId = `${prefix}-${String(maxNum + 1).padStart(6, '0')}`;
    } else {
        const companyNameClean = company ? cleanString(company.name) || 'VOLTIK' : 'VOLTIK';
        const productNameClean = cleanString(ticketData.product) || 'GENERAL';
        const prefix = `${companyNameClean}-${productNameClean}`;

        let maxNum = 0;
        cachedTickets.forEach(t => {
            if (t.id && t.id.startsWith(prefix)) {
                const parts = t.id.split('-');
                if (parts.length >= 3) {
                    const num = parseInt(parts[parts.length - 1], 10);
                    if (!isNaN(num) && num > maxNum) maxNum = num;
                }
            }
        });
        nextId = `${prefix}-${String(maxNum + 1).padStart(5, '0')}`;
    }

    const newTicket = {
        id: nextId,
        title: ticketData.title,
        description: ticketData.description,
        status: ticketData.status || 'new',
        priority: ticketData.priority || 'medium',
        category: ticketData.category || null,
        group: ticketData.group || null,
        product: ticketData.product || null,
        type: ticketData.type || null,
        tags: ticketData.tags || [],
        // Volcán Desk: un ticket "nace" pendiente y sin dueño — se etiqueta
        // así desde la creación usando el subestado ya existente en el
        // catálogo (SUBESTADO_OPTIONS_BY_STATUS.to_do → 'nuevo_sin_asignar'),
        // en vez de dejar que quede sin etiquetas hasta que alguien la ponga
        // a mano. Voltik no usa este catálogo de subestados.
        etiquetas: ticketData.etiquetas || ((ticketData.ambito === 'interno' && (ticketData.status || 'to_do') === 'to_do') ? ['nuevo_sin_asignar'] : []),
        createdBy: currentUser?.id || ticketData.createdBy,
        assignedTo: ticketData.assignedTo || null,
        companyId: ticketData.companyId || null,
        createdAt: now,
        updatedAt: now,
        comments: [],
        attachments: ticketData.attachments || [],
        camposValores: ticketData.camposValores || null,
        owner_agent_id: ticketData.assignedTo || null,
        resolver_agent_id: ticketData.assignedTo || null,
        resolver_group_id: ticketData.group || null,
        previous_owner_id: null,
        ambito: ticketData.ambito || 'externo',
        area_origen_id: ticketData.area_origen_id || null,
        ultimo_mensaje_de: (currentUser?.role === 'client') ? 'cliente' : 'agente',
        ultimo_mensaje_at: now,
        visto_por_agente: (currentUser?.role === 'client') ? false : true,
        visto_por_cliente: (currentUser?.role === 'client') ? true : false,
        activities: [
            {
                id: generateId(),
                type: 'created',
                userId: currentUser?.id || ticketData.createdBy,
                ts: now,
                data: { status: 'new' },
            }
        ],
    };

    // Optimistic cache insert
    pendingTicketWrites.add(newTicket.id);
    cachedTickets.unshift(newTicket);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedTickets));

    // Notificación 1: ticket nuevo -> avisar a todo el grupo resolutor.
    if (newTicket.ambito === 'interno') {
        notifyGroup(
            newTicket.resolver_group_id || newTicket.group,
            {
                fromUser: { id: currentUser?.id, name: currentUser?.name },
                ticketId: newTicket.id,
                ticketTitle: newTicket.title,
                message: 'creó una nueva solicitud en tu grupo',
                type: 'new_ticket',
            },
            currentUser?.id
        );
    }

    // Background write + Swap returned ticket (to get decrypted attachments URLs)
    api.post('/tickets', newTicket)
        .then(savedTicket => {
            const idx = cachedTickets.findIndex(t => t.id === newTicket.id);
            if (idx !== -1) {
                // Preserving comments if any were added instantly
                savedTicket.comments = cachedTickets[idx].comments || [];
                cachedTickets[idx] = savedTicket;
                localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedTickets));
            }
            window.dispatchEvent(new CustomEvent('ticket-create-settled', { detail: { id: newTicket.id, ok: true } }));
        })
        .catch(err => {
            console.error('Error creating ticket on server:', err);
            // El guardado en el servidor falló de verdad: no dejar un ticket
            // "fantasma" que solo existe en el navegador de quien lo creó.
            cachedTickets = cachedTickets.filter(t => t.id !== newTicket.id);
            localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedTickets));
            window.dispatchEvent(new CustomEvent('ticket-create-settled', {
                detail: { id: newTicket.id, ok: false, title: newTicket.title, error: err.message }
            }));
        })
        .finally(() => pendingTicketWrites.delete(newTicket.id));

    return newTicket;
};

// Update ticket (optimistic sync cache + async DB write & swap)
export const updateTicket = (id, updates) => {
    const index = cachedTickets.findIndex(ticket => ticket.id === id);
    if (index !== -1) {
        const old = cachedTickets[index];
        const now = new Date().toISOString();
        const currentUser = getCurrentUser();
        const newActivities = [...(old.activities || [])];

        // Track and sync assignedTo <-> resolver_agent_id
        if (updates.assignedTo !== undefined && updates.resolver_agent_id === undefined) {
            updates.resolver_agent_id = updates.assignedTo;
        } else if (updates.resolver_agent_id !== undefined && updates.assignedTo === undefined) {
            updates.assignedTo = updates.resolver_agent_id;
        }

        // Define owner_agent_id if it's the first assignment
        if (!old.owner_agent_id && (updates.resolver_agent_id || updates.assignedTo)) {
            updates.owner_agent_id = updates.resolver_agent_id || updates.assignedTo;
        }

        // El ticket deja de ser "nuevo/sin asignar" en cuanto alguien lo toma
        // (ej. "Tomar ticket") — si no se limpia, la etiqueta
        // 'nuevo_sin_asignar' (puesta al crear el ticket, ver createTicket)
        // se queda pegada y la tabla seguiría mostrando "Nuevo / Sin asignar"
        // en un ticket que ya tiene dueño. Solo actúa si esta misma llamada
        // no viene ya con un `etiquetas` explícito (para no pisar un cambio
        // manual del usuario en Configuración → Estados de Vida).
        const gettingAssigned = (updates.resolver_agent_id || updates.assignedTo) && !(old.resolver_agent_id || old.assignedTo);
        if (gettingAssigned && updates.etiquetas === undefined && (old.etiquetas || []).includes('nuevo_sin_asignar')) {
            updates.etiquetas = (old.etiquetas || []).filter(e => e !== 'nuevo_sin_asignar');
        }

        // List of fields to track as field modifications (campo_editado)
        const fieldsToTrack = [
            { key: 'status', label: 'Estado' },
            { key: 'product', label: 'Producto' },
            { key: 'priority', label: 'Prioridad' },
            { key: 'group', label: 'Grupo' },
            { key: 'category', label: 'Categoría' },
            { key: 'type', label: 'Tipo' },
            { key: 'resolver_agent_id', label: 'Agente Asignado' }
        ];

        fieldsToTrack.forEach(fieldInfo => {
            const { key, label } = fieldInfo;
            if (updates[key] !== undefined && updates[key] !== old[key]) {
                newActivities.push({
                    id: generateId(),
                    type: 'campo_editado',
                    userId: currentUser?.id,
                    ts: now,
                    data: {
                        field: label,
                        from: old[key] || 'Ninguno',
                        to: updates[key] || 'Ninguno'
                    }
                });
            }
        });

        const updatedLocal = {
            ...old,
            ...updates,
            activities: newActivities,
            updatedAt: now,
        };

        // Optimistic update
        pendingTicketWrites.add(id);
        cachedTickets[index] = updatedLocal;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedTickets));

        // Background write — encadenado (ver enqueueTicketWrite) para que dos
        // cambios rápidos al mismo ticket no lleguen al servidor fuera de orden.
        enqueueTicketWrite(id, () => api.put(`/tickets/${id}`, updatedLocal))
            .then(savedTicket => {
                const idx = cachedTickets.findIndex(t => t.id === id);
                if (idx !== -1) {
                    // Preserving comments locally
                    savedTicket.comments = cachedTickets[idx].comments || [];
                    cachedTickets[idx] = savedTicket;
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedTickets));
                }
            })
            .catch(err => console.error('Error updating ticket on server:', err))
            .finally(() => pendingTicketWrites.delete(id));

        return updatedLocal;
    }
    return null;
};

// Escalate ticket with ownership rules
export const escalateTicket = (id, targetGroupId, targetAgentId, transfersPropiedad, groupName, agentName) => {
    const index = cachedTickets.findIndex(t => t.id === id);
    if (index !== -1) {
        const old = cachedTickets[index];
        const now = new Date().toISOString();
        const currentUser = getCurrentUser();
        const newActivities = [...(old.activities || [])];

        let updates = {};

        if (transfersPropiedad) {
            updates = {
                previous_owner_id: old.owner_agent_id || null,
                owner_agent_id: targetAgentId,
                resolver_agent_id: targetAgentId,
                resolver_group_id: targetGroupId,
                assignedTo: targetAgentId,
                group: groupName
            };
            newActivities.push({
                id: generateId(),
                type: 'transferencia_propiedad',
                userId: currentUser?.id,
                ts: now,
                data: {
                    actor: currentUser?.name || 'Agente',
                    groupDest: groupName,
                    agentDest: agentName
                }
            });
        } else {
            updates = {
                resolver_agent_id: targetAgentId,
                resolver_group_id: targetGroupId,
                assignedTo: targetAgentId,
                group: groupName
            };
            newActivities.push({
                id: generateId(),
                type: 'escalamiento',
                userId: currentUser?.id,
                ts: now,
                data: {
                    actor: currentUser?.name || 'Agente',
                    groupDest: groupName,
                    agentDest: agentName
                }
            });
        }

        const updatedLocal = {
            ...old,
            ...updates,
            activities: newActivities,
            updatedAt: now,
        };

        pendingTicketWrites.add(id);
        cachedTickets[index] = updatedLocal;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedTickets));

        // Notificación 4: escalación -> avisar a todo el grupo destino.
        if (old.ambito === 'interno') {
            notifyGroup(
                targetGroupId,
                {
                    fromUser: { id: currentUser?.id, name: currentUser?.name },
                    ticketId: id,
                    ticketTitle: old.title,
                    message: 'escaló una solicitud a tu grupo',
                    type: 'escalation',
                },
                currentUser?.id
            );
        }

        enqueueTicketWrite(id, () => api.put(`/tickets/${id}`, updatedLocal))
            .then(savedTicket => {
                const idx = cachedTickets.findIndex(t => t.id === id);
                if (idx !== -1) {
                    savedTicket.comments = cachedTickets[idx].comments || [];
                    cachedTickets[idx] = savedTicket;
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedTickets));
                }
            })
            .catch(err => console.error('Error escalating ticket on server:', err))
            .finally(() => pendingTicketWrites.delete(id));

        return updatedLocal;
    }
    return null;
};

// Delete ticket (optimistic sync cache + async DB write)
export const deleteTicket = (id) => {
    pendingTicketWrites.add(id);
    cachedTickets = cachedTickets.filter(ticket => ticket.id !== id);

    // Background write
    api.delete(`/tickets/${id}`)
        .catch(err => console.error('Error deleting ticket on server:', err))
        .finally(() => pendingTicketWrites.delete(id));

    localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedTickets));
    return true;
};

// Add comment to ticket (optimistic sync cache + async DB write & swap)
export const addComment = (ticketId, userId, text, isPrivate = false, attachments = []) => {
    const ticketIndex = cachedTickets.findIndex(t => t.id === ticketId);
    if (ticketIndex !== -1) {
        const ticket = cachedTickets[ticketIndex];
        const now = new Date().toISOString();
        const tempCommentId = generateId();
        
        const localComment = {
            id: tempCommentId,
            userId,
            text,
            isPrivate,
            attachments: attachments || [],
            createdAt: now,
        };

        // Optimistic cache update
        ticket.comments = [...(ticket.comments || []), localComment];
        ticket.activities = [
            ...(ticket.activities || []),
            {
                id: generateId(),
                type: isPrivate ? 'note' : 'comment',
                userId,
                ts: now,
                data: { commentId: tempCommentId },
            },
        ];
        ticket.updatedAt = now;
        
        if (!isPrivate) {
            const currentUser = getCurrentUser();
            const isClient = currentUser?.role === 'client';
            ticket.ultimo_mensaje_de = isClient ? 'cliente' : 'agente';
            ticket.ultimo_mensaje_at = now;
            ticket.visto_por_agente = isClient ? false : true;
            ticket.visto_por_cliente = isClient ? true : false;

            // Notificaciones 2 y 3 (Volcán Desk): una respuesta pública siempre
            // va en una de dos direcciones — del solicitante hacia el
            // resolutor, o del resolutor hacia el solicitante. Las notas
            // privadas (isPrivate) no cuentan como "respuesta al usuario", así
            // que no disparan nada acá.
            if (ticket.ambito === 'interno') {
                const fromUser = { id: currentUser?.id, name: currentUser?.name };
                const isRequesterReplying = userId === ticket.createdBy;
                if (isRequesterReplying) {
                    // 3) el solicitante respondió -> avisar al resolutor. Si
                    // todavía no hay nadie asignado, avisa a todo el grupo en
                    // vez de perder el aviso.
                    const resolverAgentId = ticket.resolver_agent_id || ticket.assignedTo;
                    if (resolverAgentId) {
                        notifyUser(resolverAgentId, {
                            fromUser, ticketId, ticketTitle: ticket.title,
                            message: 'respondió tu solicitud asignada',
                            type: 'reply_resolver',
                        }, userId);
                    } else {
                        notifyGroup(ticket.resolver_group_id || ticket.group, {
                            fromUser, ticketId, ticketTitle: ticket.title,
                            message: 'respondió en una solicitud de tu grupo',
                            type: 'reply_resolver',
                        }, userId);
                    }
                } else {
                    // 2) el resolutor respondió -> avisar al solicitante.
                    notifyUser(ticket.createdBy, {
                        fromUser, ticketId, ticketTitle: ticket.title,
                        message: 'respondió tu solicitud',
                        type: 'reply_requester',
                    }, userId);
                }
            }
        }

        localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedTickets));

        // Background write comment
        pendingTicketWrites.add(ticketId);
        api.post(`/tickets/${ticketId}/comments`, localComment)
            .then(savedComment => {
                // Find ticket and swap the temporary comment with the saved server comment (having decoded attachments)
                const tIdx = cachedTickets.findIndex(t => t.id === ticketId);
                if (tIdx !== -1) {
                    const t = cachedTickets[tIdx];
                    t.comments = (t.comments || []).map(c => c.id === tempCommentId ? savedComment : c);
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedTickets));
                }
            })
            .catch(err => console.error('Error adding comment on server:', err))
            .finally(() => pendingTicketWrites.delete(ticketId));

        return localComment;
    }
    return null;
};

// Get tickets by status (sync)
export const getTicketsByStatus = (status) => {
    return cachedTickets.filter(ticket => ticket.status === status);
};

// Get tickets by assignee (sync)
export const getTicketsByAssignee = (userId) => {
    return cachedTickets.filter(ticket => ticket.assignedTo === userId);
};

// Get ticket statistics (sync)
export const getTicketStats = (companyId = null) => {
    let tickets = cachedTickets;
    if (companyId) {
        tickets = tickets.filter(t => t.companyId === companyId);
    }
    
    return {
        total: tickets.length,
        new: tickets.filter(t => t.status === 'new').length,
        inProgress: tickets.filter(t => t.status === 'in_progress' || t.status === 'in progress').length,
        resolved: tickets.filter(t => t.status === 'resolved').length,
        closed: tickets.filter(t => t.status === 'closed').length,
        byPriority: {
            low: tickets.filter(t => t.priority === 'low').length,
            medium: tickets.filter(t => t.priority === 'medium').length,
            high: tickets.filter(t => t.priority === 'high').length,
            urgent: tickets.filter(t => t.priority === 'urgent').length,
        }
    };
};

// Add attachment to ticket (optimistic sync cache + async DB write & swap)
export const addAttachment = (ticketId, attachment) => {
    const ticketIndex = cachedTickets.findIndex(t => t.id === ticketId);
    if (ticketIndex !== -1) {
        const ticket = cachedTickets[ticketIndex];
        if (!ticket.attachments) ticket.attachments = [];
        
        ticket.attachments.push(attachment);
        ticket.updatedAt = new Date().toISOString();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedTickets));

        // Background write: update whole ticket on server
        pendingTicketWrites.add(ticketId);
        api.put(`/tickets/${ticketId}`, { attachments: ticket.attachments })
            .then(savedTicket => {
                const idx = cachedTickets.findIndex(t => t.id === ticketId);
                if (idx !== -1) {
                    // Update only attachments from server (to get server fileUrls)
                    cachedTickets[idx].attachments = savedTicket.attachments;
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedTickets));
                }
            })
            .catch(err => console.error('Error adding attachment to ticket on server:', err))
            .finally(() => pendingTicketWrites.delete(ticketId));

        return attachment;
    }
    return null;
};

// Remove attachment from ticket (optimistic sync cache + async DB write)
export const removeAttachment = (ticketId, attachmentId) => {
    const ticketIndex = cachedTickets.findIndex(t => t.id === ticketId);
    if (ticketIndex !== -1) {
        const ticket = cachedTickets[ticketIndex];
        if (ticket.attachments) {
            ticket.attachments = ticket.attachments.filter(a => a.id !== attachmentId);
            ticket.updatedAt = new Date().toISOString();
            localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedTickets));

            // Background write
            pendingTicketWrites.add(ticketId);
            api.put(`/tickets/${ticketId}`, { attachments: ticket.attachments })
                .catch(err => console.error('Error removing attachment on server:', err))
                .finally(() => pendingTicketWrites.delete(ticketId));

            return true;
        }
    }
    return false;
};

// Compute SLA Status (sync)
export const computeSlaStatus = (ticket, config) => {
    let targetMinutes = 1440;
    if (config?.priorities) {
        const pConf = config.priorities.find(p => p.value === ticket.priority);
        if (pConf && pConf.slaMinutes) targetMinutes = pConf.slaMinutes;
    }

    if (targetMinutes === -1) {
        return { elapsedMinutes: 0, targetMinutes: -1, percentage: 0, status: 'ok', isTerminated: true };
    }

    const isNowTerminated = isTerminalStatus(ticket.status, config);
    let endTime = Date.now();
    
    // Si ya está terminado, intentamos buscar cuándo se terminó desde activities si está disponible
    if (isNowTerminated) {
        const activities = ticket.activities || [];
        const statusActivities = activities
            .filter(a => a.type === 'status_change')
            .sort((a,b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
        const lastAct = statusActivities[statusActivities.length - 1];
        if (lastAct && isTerminalStatus(lastAct.data?.to, config)) {
            endTime = new Date(lastAct.ts).getTime();
        }
    }

    let elapsedMinutes = (endTime - new Date(ticket.createdAt).getTime()) / 60000;
    
    // SLA Pause: Restar tiempo de los bloqueos registrados en backend
    if (ticket.bloqueos && Array.isArray(ticket.bloqueos)) {
        let totalBloqueoMs = 0;
        ticket.bloqueos.forEach(b => {
            if (b.bloqueado_desde) {
                const start = new Date(b.bloqueado_desde).getTime();
                let end = b.bloqueado_hasta ? new Date(b.bloqueado_hasta).getTime() : endTime;
                if (end > endTime) end = endTime;
                if (start < endTime) {
                    totalBloqueoMs += (end - start);
                }
            }
        });
        const bloqueosMinutes = totalBloqueoMs / 60000;
        elapsedMinutes = Math.max(0, elapsedMinutes - bloqueosMinutes);
    }
    
    const percentage = Math.min((elapsedMinutes / targetMinutes) * 100, 100);
    
    let status = 'ok';
    if (percentage >= 100) status = 'breached';
    else if (percentage >= 80) status = 'warning';

    return { 
        elapsedMinutes: Math.round(elapsedMinutes), 
        targetMinutes, 
        percentage: Math.round(percentage), 
        status, 
        isTerminated: isNowTerminated
    };
};

export const markTicketAsRead = (ticketId, role) => {
    const idx = cachedTickets.findIndex(t => t.id === ticketId);
    if (idx !== -1) {
        const ticket = cachedTickets[idx];
        if (role === 'client') {
            if (ticket.visto_por_cliente) return;
            ticket.visto_por_cliente = true;
        } else {
            if (ticket.visto_por_agente) return;
            ticket.visto_por_agente = true;
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedTickets));

        // Background API call
        pendingTicketWrites.add(ticketId);
        api.put(`/tickets/${ticketId}/read`, { role })
            .catch(err => console.error('Error marking ticket as read on server:', err))
            .finally(() => pendingTicketWrites.delete(ticketId));
    }
};
