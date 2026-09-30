import { api } from './api';
import { generateId, generateConsecutiveId } from '../utils/helpers';
import { getCurrentUser } from './authService';
import { isOnHoldStatus, isTerminalStatus } from './configService';
import { getCompanyById } from './companyService';
import { getGroupById, getGroups, getMyExtraGroupIds } from './groupService';
import { getUsers } from './userService';
import { sendNotifications } from './notificationService';

// ─── Helpers de Agrupamiento y Ordenamiento de Apoyos ────────────────────────

export const parseApoyos = (ticket) => {
    if (!ticket || !ticket.apoyos) return [];
    if (Array.isArray(ticket.apoyos)) return ticket.apoyos;
    if (typeof ticket.apoyos === 'string') {
        try {
            return JSON.parse(ticket.apoyos);
        } catch (e) {
            return [];
        }
    }
    return [];
};

export const getApoyoActivo = (ticket) => {
    const apoyos = parseApoyos(ticket);
    return apoyos.find(a => a.status !== 'Resuelto') || null;
};

export const getApoyoParaGrupo = (ticket, misGrupos) => {
    const apoyos = parseApoyos(ticket);
    return apoyos.find(a => misGrupos.includes(a.grupo_solicitado) && a.status !== 'Resuelto') || null;
};

// Determina la sección visual del ticket en la tabla
export const getEstadoAgrupacion = (ticket, currentUser, misGrupos) => {
    const isAdmin = currentUser?.role === 'admin';
    const isOwnerGroup = isAdmin || misGrupos.includes(ticket.resolver_group_id || ticket.group);

    // Si soy del grupo dueño (o admin), veo el estado global del ticket.
    if (isOwnerGroup) {
        return ticket.status || 'to_do';
    }

    // Si NO soy del grupo dueño, mi única relación es un apoyo.
    const apoyo = getApoyoParaGrupo(ticket, misGrupos);
    if (apoyo) {
        return `Apoyo · ${apoyo.status}`; // 'Apoyo · Pendiente' o 'Apoyo · En progreso'
    }

    // Fallback de seguridad (en teoría no llegaría aquí por los filtros de visibilidad)
    return ticket.status || 'to_do';
};

// Ordenar por Urgencia: 1) SLA, 2) Prioridad, 3) Actividad
export function sortByUrgency(a, b, config) {
    // 1. SLA
    const slaA = computeSlaStatus(a, config);
    const slaB = computeSlaStatus(b, config);

    const rankSla = (sla) => {
        if (sla.status === 'breached') return 1;
        if (sla.status === 'warning') return 2;
        return 3;
    };

    const rankA = rankSla(slaA);
    const rankB = rankSla(slaB);

    if (rankA !== rankB) return rankA - rankB; // Mayor urgencia SLA primero

    // Si ambos son breached, el más vencido primero (targetMinutes - elapsedMinutes será más negativo)
    // Si ambos son ok, el más cercano a vencer primero
    const remA = slaA.targetMinutes - slaA.elapsedMinutes;
    const remB = slaB.targetMinutes - slaB.elapsedMinutes;
    if (remA !== remB) return remA - remB; // Menos tiempo restante primero

    // 2. Prioridad (Urgente > Alta > Media > Baja)
    const prioOrder = { 'urgent': 1, 'high': 2, 'medium': 3, 'low': 4 };
    const pA = prioOrder[a.priority] || 99;
    const pB = prioOrder[b.priority] || 99;
    if (pA !== pB) return pA - pB;

    // 3. Actividad
    const dateA = a.ultimo_mensaje_at ? new Date(a.ultimo_mensaje_at).getTime() : 0;
    const dateB = b.ultimo_mensaje_at ? new Date(b.ultimo_mensaje_at).getTime() : 0;
    return dateB - dateA; // Más reciente primero
};

// Ordenar por fecha de creación — a diferencia de sortByUrgency (SLA > prioridad
// > actividad), esto ignora por completo qué tan urgente es un ticket. Se
// agregó 2026-09-29 porque el orden por urgencia hacía que un ticket recién
// creado apareciera hasta abajo de la lista si había otros ya vencidos, algo
// que Guillermo reportó como poco intuitivo — esta es la alternativa directa
// "más nuevo arriba" que puede elegirse en la tabla.
export function sortByDate(a, b) {
    const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return dateB - dateA; // Más reciente primero
};

// ─── Group scoping helpers (Dashboard / Reportes / Tickets) ───────────────────
// Fuente única de verdad para "qué grupos de Volcán Desk puede ver este
// usuario" — group_admin: su único grupo administrado; admin: todos (no tiene
// "mi grupo" propio, así que ve todo); el resto (agent/client): los grupos de
// los que es miembro nativo. En los tres casos se suman además los grupos
// otorgados por Acceso Especial (AreaAccesoExtra) — 2026-09-16, a pedido del
// usuario, para que alguien como un director pueda ver varios grupos sin ser
// su admin ni pertenecer nativamente a ellos.
//
// Antes esta función y Tickets.jsx tenían CADA UNA su propio cálculo
// (`myGroups` vs `myGroupsForFilter`), y solo una de las dos tenía el caso
// 'admin' — la otra caía al `else` con un arreglo vacío, dejando a cualquier
// admin general viendo "Solicitudes Recibidas/Enviadas" vacías por default
// (reportado en vivo 2026-09-16, confirmado también en producción). Unificar
// todo en esta sola función, usada por Tickets.jsx y Dashboard.jsx, es lo que
// evita que ambos cálculos vuelvan a divergir.
export const getUserGroupsForScoping = (currentUser) => {
    if (!currentUser) return [];
    const extra = getMyExtraGroupIds(currentUser);
    if (currentUser.role === 'group_admin') {
        return [...new Set([currentUser.admin_group_id, ...extra].filter(Boolean))];
    }
    if (currentUser.role === 'admin') {
        return [...new Set([
            ...getGroups().filter(g => (g.modulo || 'voltik') === 'volcan_desk').map(g => g.id),
            ...extra,
        ])];
    }
    return [...new Set([...(currentUser.groups || []), ...extra])];
};

// ¿El ticket me pertenece directamente (soy el solicitante o el responsable)?
export const isMyTicket = (t, currentUser) =>
    t.createdBy === currentUser?.id || t.assignedTo === currentUser?.id || t.resolver_agent_id === currentUser?.id;

// ¿El ticket pertenece a alguno de mis grupos, como solicitante o resolutor?
// `t.group` puede venir como nombre en vez de id en algunos tickets viejos —
// resolver_group_id es la fuente de verdad cuando existe.
export const isGroupTicket = (t, myGroups) =>
    myGroups.includes(t.area_origen_id) || myGroups.includes(t.resolver_group_id || t.group) || !!getApoyoParaGrupo(t, myGroups);

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

// Wrapper seguro para localStorage.setItem: si el storage está lleno
// (QuotaExceededError — pasa cuando el JSON de todos los tickets supera los
// 5MB del límite por origen), la escritura local se omite silenciosamente y
// la app sigue funcionando. Los datos viven solo en memoria hasta el próximo
// poll del servidor; las escrituras al backend (api.post/put) continúan igual.
// Antes, el error se propagaba sin capturar y tumbaba el call-site (ej.
// createTicket), dejando el modal abierto y el ticket sin enviarse al servidor
// aunque el usuario hubiera llenado todos los campos (bug reportado en vivo
// 2026-09-24 en producción con ~135 tickets).
//
// El try/catch de arriba evita que la app se trabe cuando localStorage ya está
// lleno, pero no evita LLEGAR a ese límite — con suficientes tickets (cada uno
// con descripción HTML, comentarios y adjuntos en base64) el JSON completo
// sigue creciendo sin tope. Poda 2026-09-29: nunca se guardan más de
// MAX_CACHED_TICKETS en localStorage, priorizando los que siguen ABIERTOS
// (isTerminalStatus) y completando el resto con los más recientes por fecha
// de creación. Esto NO afecta qué se ve en pantalla — la tabla siempre lee de
// `cachedTickets` en memoria, que sigue trayendo la lista completa del
// servidor en cada poll; esta copia recortada es solo el respaldo instantáneo
// que se usa mientras carga esa primera respuesta.
const MAX_CACHED_TICKETS = 50;
const pruneForStorage = (tickets) => {
    if (!Array.isArray(tickets) || tickets.length <= MAX_CACHED_TICKETS) return tickets;
    const byNewest = (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    const open = tickets.filter(t => !isTerminalStatus(t.status));
    if (open.length >= MAX_CACHED_TICKETS) {
        return [...open].sort(byNewest).slice(0, MAX_CACHED_TICKETS);
    }
    const closed = tickets.filter(t => isTerminalStatus(t.status)).sort(byNewest);
    return [...open, ...closed.slice(0, MAX_CACHED_TICKETS - open.length)];
};

const saveToLocalStorage = (data) => {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(pruneForStorage(data)));
    } catch (e) {
        console.warn('[ticketService] localStorage lleno — caché local omitido. La app sigue funcionando normalmente:', e.message);
    }
};

// IDs de tickets con una escritura optimista (crear/editar/comentar/adjuntar/
// escalar/borrar) todavía en vuelo hacia el servidor. loadTicketsFromServer()
// se llama cada 8s desde varias páginas (Tickets/Dashboard) además de
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

// NOTA (2026-09-14): esta copia ya NO trae tickets de demostración para
// autosembrar la base de datos cuando la lista viene vacía. Una base de
// datos vacía debe quedarse vacía hasta que alguien cree tickets reales.

// Load tickets from server
export const loadTicketsFromServer = async () => {
    try {
        // Antes esto SIEMPRE pedía las dos tablas completas (Voltik + Volcán
        // Desk) para cualquier usuario interno, sin importar cuál módulo
        // estuviera viendo — cada ciclo de 8s de polling (Tickets.jsx/
        // Dashboard.jsx) traía la organización entera dos veces. Reportado en
        // vivo 2026-09-17 como lentitud creciente mientras la pestaña sigue
        // abierta. A pedido del usuario: Volcán Desk nunca debe volver a traer
        // nada de Voltik — se pide solo el ambito del workspace realmente
        // activo (persistido en localStorage por WorkspaceContext.jsx), nunca
        // los dos a la vez. Un cliente (externo puro) no cambia, nunca pidió
        // interno.
        const currentUser = getCurrentUser();
        const isInternalUser = currentUser?.role && currentUser.role !== 'client';

        let tickets;
        if (isInternalUser) {
            let storedWorkspace = 'volcan_desk';
            try { storedWorkspace = localStorage.getItem('tms_workspace') || 'volcan_desk'; } catch (e) {}
            tickets = storedWorkspace === 'volcan_desk'
                ? await api.get('/tickets?ambito=interno')
                : await api.get('/tickets');
        } else {
            tickets = await api.get('/tickets');
        }

        cachedTickets = mergeServerTickets(tickets);
        return cachedTickets;
    } catch (error) {
        console.error('Failed to load tickets from server, using local fallback:', error);
        const local = localStorage.getItem(STORAGE_KEY);
        cachedTickets = local ? JSON.parse(local) : [];
        return cachedTickets;
    }
};

// Get all tickets (sync)
export const getTickets = () => {
    return cachedTickets;
};

// Detalle completo de UN ticket (GET /api/tickets/:id) — a diferencia del
// listado (arriba), esta ruta nunca se tocó y siempre trae comments y
// camposValores completos. Se agregó este export 2026-09-17: el listado dejó
// de traer esos dos campos por rendimiento (ver loadTicketsFromServer), pero
// nada en el frontend pedía nunca este detalle por separado — Tickets.jsx
// solo tomaba el ticket ya cacheado del listado para abrir el panel derecho,
// así que al abrir un ticket se veía sin conversación ni adjuntos de campo
// dinámico (reportado en vivo el mismo día). Tickets.jsx la llama al abrir un
// ticket y fusiona el resultado sobre el ticket ya mostrado.
export const fetchTicketDetail = (id) => api.get(`/tickets/${encodeURIComponent(id)}`);

// Tickets visibles para currentUser dentro del workspace activo (ambito).
// Misma regla que Tickets.jsx usa para su listado base: filtra por ambito y,
// para 'agent', por pertenencia a grupo/área de origen o autoría (igual que
// checkTicketAccess en el backend). Se centraliza aquí porque Dashboard
// necesita el mismo recorte y no debe quedar desincronizado de él.
export const getVisibleTickets = (currentUser, activeWorkspace) => {
    const currentAmbito = activeWorkspace === 'volcan_desk' ? 'interno' : 'externo';
    let visible = getTickets().filter(t => (t.ambito || 'externo') === currentAmbito);

    if (currentUser?.role === 'agent') {
        // getUserGroupsForScoping (arriba) ya suma los grupos de Acceso Especial
        // (AreaAccesoExtra) — currentUser.groups a secas es solo los grupos
        // nativos. Sin esto, un agent cuyo único acceso a un grupo es por
        // Acceso Especial (ej. groups: []) veía Inicio/Dashboard en ceros
        // aunque el backend sí le mande sus tickets — reportado en vivo
        // 2026-09-17, cuenta "Kendy test" con 3 accesos especiales. Mismo
        // patrón ya corregido en Tickets.jsx/isDeskRequesterOnly.
        const userGroups = getUserGroupsForScoping(currentUser);
        // t.group puede venir como NOMBRE en vez de id en tickets viejos/reasignados
        // (ej. tras un "Escalar/Transferir") — resolver_group_id es la fuente de
        // verdad cuando existe. Comparar solo contra t.group hacía que un ticket
        // ruteado al grupo del agente pero aún sin asignar a nadie desapareciera
        // por completo de Dashboard/Reportes (y de este listado base).
        visible = visible.filter(t => {
            const effectiveGroup = t.resolver_group_id || t.group;
            const isApoyo = !!getApoyoParaGrupo(t, userGroups);
            return userGroups.includes(effectiveGroup) ||
                   userGroups.includes(t.area_origen_id) ||
                   t.createdBy === currentUser.id ||
                   isApoyo;
        });
    } else if (currentUser?.role === 'client') {
        visible = visible.filter(t => t.companyId === currentUser.companyId);
    }
    // Admin ve todo dentro del ambito activo (igual que en Tickets.jsx)

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
        // Copia optimista de la misma lógica del servidor (server.js, creación de
        // ticket): en tickets internos nadie tiene rol 'client', así que el campo
        // se reutiliza con 'solicitante'/'resolutor' en vez de 'cliente'/'agente'.
        // El creador de un ticket interno siempre es el solicitante.
        ultimo_mensaje_de: ticketData.ambito === 'interno' ? 'solicitante' : ((currentUser?.role === 'client') ? 'cliente' : 'agente'),
        ultimo_mensaje_at: now,
        visto_por_agente: ticketData.ambito === 'interno' ? false : ((currentUser?.role === 'client') ? false : true),
        visto_por_cliente: ticketData.ambito === 'interno' ? true : ((currentUser?.role === 'client') ? true : false),
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
    saveToLocalStorage(cachedTickets);

    // Background write + Swap returned ticket (to get decrypted attachments URLs)
    api.post('/tickets', newTicket)
        .then(savedTicket => {
            const idx = cachedTickets.findIndex(t => t.id === newTicket.id);
            if (idx !== -1) {
                // Preserving comments if any were added instantly
                savedTicket.comments = cachedTickets[idx].comments || [];
                cachedTickets[idx] = savedTicket;
                saveToLocalStorage(cachedTickets);
            }
            // Notificación 1: ticket nuevo -> avisar a todo el grupo resolutor. Antes
            // se mandaba ANTES de este POST, con el id que el propio navegador
            // calculaba localmente (newTicket.id) — pero ese id es solo una
            // propuesta: el servidor recalcula el consecutivo final con reintento
            // ante choque (ver el comentario en POST /api/tickets, server.js) si dos
            // creaciones casi simultáneas calculan el mismo número. Cuando el
            // servidor ajustaba el número, la notificación ya había salido con el id
            // viejo — que nunca llega a existir en la BD — dejando una notificación
            // huérfana permanente. Reportado en vivo 2026-09-18: clic en una
            // notificación de "ticket nuevo" decía "ya no existe" aunque el ticket sí
            // existía, con el número siguiente. Usar savedTicket.id (la respuesta
            // real y ya confirmada del servidor) elimina la carrera por completo —
            // de paso, si el POST llega a fallar del todo, ya no se manda ninguna
            // notificación de un ticket que nunca se guardó.
            if (savedTicket.ambito === 'interno') {
                notifyGroup(
                    savedTicket.resolver_group_id || savedTicket.group,
                    {
                        fromUser: { id: currentUser?.id, name: currentUser?.name },
                        ticketId: savedTicket.id,
                        ticketTitle: savedTicket.title,
                        message: 'creó una nueva solicitud en tu grupo',
                        type: 'new_ticket',
                    },
                    currentUser?.id
                );
            }
            window.dispatchEvent(new CustomEvent('ticket-create-settled', { detail: { id: newTicket.id, ok: true } }));
        })
        .catch(err => {
            console.error('Error creating ticket on server:', err);
            // El guardado en el servidor falló de verdad: no dejar un ticket
            // "fantasma" que solo existe en el navegador de quien lo creó.
            cachedTickets = cachedTickets.filter(t => t.id !== newTicket.id);
            saveToLocalStorage(cachedTickets);
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

        // Auto-resolver apoyos si el ticket pasa a estado terminal
        if (updates.status && updates.status !== old.status && isTerminalStatus(updates.status)) {
            const apoyosArray = parseApoyos(old);
            let apoyosModificados = false;
            const apoyosActualizados = apoyosArray.map(a => {
                if (a.status !== 'Resuelto') {
                    apoyosModificados = true;
                    return { ...a, status: 'Resuelto' };
                }
                return a;
            });
            if (apoyosModificados && updates.apoyos === undefined) {
                updates.apoyos = apoyosActualizados;
            }
        }

        // Registrar en Actividad cuando se agrega un nuevo apoyo (no cuando solo
        // cambia el estado de uno existente, ni cuando se auto-resuelven arriba).
        if (updates.apoyos !== undefined) {
            const oldApoyosCount = parseApoyos(old).length;
            if (updates.apoyos.length > oldApoyosCount) {
                const addedApoyo = updates.apoyos[updates.apoyos.length - 1];
                newActivities.push({
                    id: generateId(),
                    type: 'apoyo_solicitado',
                    userId: currentUser?.id,
                    ts: now,
                    data: { grupoConsultado: getGroupById(addedApoyo.grupo_solicitado)?.name || addedApoyo.grupo_solicitado }
                });
            }
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
        saveToLocalStorage(cachedTickets);

        // Background write — encadenado (ver enqueueTicketWrite) para que dos
        // cambios rápidos al mismo ticket no lleguen al servidor fuera de orden.
        // Devuelve esta promesa (en vez de `updatedLocal` síncrono, como antes)
        // por el mismo motivo ya documentado en addComment: quien llama a esto y
        // luego pide el detalle real del servidor (refreshSelectedTicketOrClose)
        // necesita poder esperar a que la escritura ya haya llegado, o corre el
        // riesgo de traer de vuelta la versión VIEJA y pisar el cambio recién
        // hecho — visualmente se veía como que el cambio "no se guardaba" y
        // regresaba a su valor anterior (reportado en vivo 2026-09-18: la
        // Etiqueta de un ticket había que elegirla 2-3 veces para que se
        // quedara, porque cada intento anterior se pisaba con la respuesta
        // tardía del fetch de detalle). Ningún caller de updateTicket() usaba
        // el valor de retorno síncrono anterior (confirmado por grep), así que
        // este cambio de contrato es seguro.
        return enqueueTicketWrite(id, () => api.put(`/tickets/${id}`, updatedLocal))
            .then(savedTicket => {
                const idx = cachedTickets.findIndex(t => t.id === id);
                if (idx !== -1) {
                    // Preserving comments locally
                    savedTicket.comments = cachedTickets[idx].comments || [];
                    cachedTickets[idx] = savedTicket;
                    saveToLocalStorage(cachedTickets);
                }
                return savedTicket;
            })
            .catch(err => {
                console.error('Error updating ticket on server:', err);
                throw err;
            })
            .finally(() => pendingTicketWrites.delete(id));
    }
    return Promise.resolve(null);
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
        saveToLocalStorage(cachedTickets);

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

        // Devuelve la promesa de escritura — mismo motivo que en updateTicket().
        return enqueueTicketWrite(id, () => api.put(`/tickets/${id}`, updatedLocal))
            .then(savedTicket => {
                const idx = cachedTickets.findIndex(t => t.id === id);
                if (idx !== -1) {
                    savedTicket.comments = cachedTickets[idx].comments || [];
                    cachedTickets[idx] = savedTicket;
                    saveToLocalStorage(cachedTickets);
                }
                return savedTicket;
            })
            .catch(err => {
                console.error('Error escalating ticket on server:', err);
                throw err;
            })
            .finally(() => pendingTicketWrites.delete(id));
    }
    return Promise.resolve(null);
};

// Delete ticket (optimistic sync cache + async DB write)
export const deleteTicket = (id) => {
    pendingTicketWrites.add(id);
    cachedTickets = cachedTickets.filter(ticket => ticket.id !== id);

    // Background write
    api.delete(`/tickets/${id}`)
        .catch(err => console.error('Error deleting ticket on server:', err))
        .finally(() => pendingTicketWrites.delete(id));

    saveToLocalStorage(cachedTickets);
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
            // Copia optimista de la misma lógica del servidor (server.js, POST
            // .../comments): en tickets internos no hay rol 'client', así que
            // 'solicitante'/'resolutor' reemplaza a 'cliente'/'agente'. Solo
            // distingue por coincidencia exacta con el creador (no por membresía
            // de grupo, a diferencia del servidor) — el próximo polling corrige
            // cualquier caso más fino en los ~30s siguientes.
            const isRequesterReplying = ticket.ambito === 'interno' && userId === ticket.createdBy;
            if (ticket.ambito === 'interno') {
                ticket.ultimo_mensaje_de = isRequesterReplying ? 'solicitante' : 'resolutor';
                ticket.visto_por_agente = !isRequesterReplying;
                ticket.visto_por_cliente = isRequesterReplying;
            } else {
                ticket.ultimo_mensaje_de = isClient ? 'cliente' : 'agente';
                ticket.visto_por_agente = isClient ? false : true;
                ticket.visto_por_cliente = isClient ? true : false;
            }
            ticket.ultimo_mensaje_at = now;

            // Notificaciones 2 y 3 (Volcán Desk): una respuesta pública siempre
            // va en una de dos direcciones — del solicitante hacia el
            // resolutor, o del resolutor hacia el solicitante. Las notas
            // privadas (isPrivate) no cuentan como "respuesta al usuario", así
            // que no disparan nada acá.
            if (ticket.ambito === 'interno') {
                const fromUser = { id: currentUser?.id, name: currentUser?.name };
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

        saveToLocalStorage(cachedTickets);

        // Background write comment. Antes esto era "fire and forget" (no devolvía
        // esta promesa) — el editor se cerraba y limpiaba de inmediato, sin esperar
        // a que el adjunto realmente terminara de subirse al servidor, así que no
        // había forma de mostrar "Guardando…" ni de saber cuándo ya era seguro dejar
        // que el usuario adjuntara otra cosa (reportado en vivo 2026-09-07: con
        // adjuntos grandes, parecía que no había pasado nada y algunos volvían a
        // subir el archivo). Ahora se devuelve la promesa real para que la UI pueda
        // esperarla — el comentario optimista de arriba ya se ve de inmediato en el
        // hilo; esta promesa es solo para saber cuándo el adjunto ya quedó a salvo
        // en el servidor.
        pendingTicketWrites.add(ticketId);
        return api.post(`/tickets/${ticketId}/comments`, localComment)
            .then(savedComment => {
                // Find ticket and swap the temporary comment with the saved server comment (having decoded attachments)
                const tIdx = cachedTickets.findIndex(t => t.id === ticketId);
                if (tIdx !== -1) {
                    const t = cachedTickets[tIdx];
                    t.comments = (t.comments || []).map(c => c.id === tempCommentId ? savedComment : c);
                    saveToLocalStorage(cachedTickets);
                }
                return savedComment;
            })
            .catch(err => {
                console.error('Error adding comment on server:', err);
                throw err;
            })
            .finally(() => pendingTicketWrites.delete(ticketId));
    }
    return Promise.resolve(null);
};

// Editar/eliminar un comentario propio dentro de los 60s de enviado
// (2026-09-23, a pedido del usuario). A diferencia de addComment, no hace
// falta actualismo optimista elaborado — Tickets.jsx vuelve a pedir el
// detalle completo del ticket al servidor justo después de cada llamada
// (mismo patrón que updateTicket/escalateTicket), que ya es la fuente de
// verdad real para esta vista.
export const editComment = (ticketId, commentId, text, startedEditingAt) => {
    return api.put(`/tickets/${ticketId}/comments/${commentId}`, { text, startedEditingAt });
};

// El borrado es "suave" del lado del servidor (ver server.js) — el texto
// real nunca vuelve a salir de la API una vez borrado, el frontend solo
// recibe isDeleted:true y pinta el placeholder "Mensaje eliminado".
export const deleteComment = (ticketId, commentId) => {
    return api.delete(`/tickets/${ticketId}/comments/${commentId}`);
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
        saveToLocalStorage(cachedTickets);

        // Background write: update whole ticket on server
        pendingTicketWrites.add(ticketId);
        api.put(`/tickets/${ticketId}`, { attachments: ticket.attachments })
            .then(savedTicket => {
                const idx = cachedTickets.findIndex(t => t.id === ticketId);
                if (idx !== -1) {
                    // Update only attachments from server (to get server fileUrls)
                    cachedTickets[idx].attachments = savedTicket.attachments;
                    saveToLocalStorage(cachedTickets);
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
            saveToLocalStorage(cachedTickets);

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

const BUSINESS_DAY_START_HOUR = 9;
const BUSINESS_DAY_END_HOUR = 18;

// Minutos "de oficina" entre dos fechas: solo cuenta lunes a viernes, 9:00-18:00
// — noches y fines de semana no suman nada. Usado para el SLA de Volcán Desk
// (ticket.ambito === 'interno'); Voltik sigue midiendo reloj de pared, sin cambios
// (reportado en vivo 2026-09-17: un ticket creado 5:22pm mostraba 19.4h de SLA
// transcurrido para un objetivo de 8h, porque contaba también la madrugada).
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

// Compute SLA Status (sync)
export const computeSlaStatus = (ticket, config) => {
    let targetMinutes = 1440;
    let noSlaConfigured = false;

    // Volcán Desk: el SLA vive en la Categoría (vinculada 1:1 a un Tipo), no en la
    // Prioridad — cada grupo configura su propio SLA por categoría. Voltik sigue
    // usando el SLA de Prioridad sin cambios.
    if (ticket.ambito === 'interno') {
        const catConf = (config?.categories || []).find(c => c.id === ticket.category);
        if (catConf && catConf.slaMinutes != null) {
            targetMinutes = catConf.slaMinutes;
        } else {
            noSlaConfigured = true;
        }
    } else if (config?.priorities) {
        const pConf = config.priorities.find(p => p.value === ticket.priority);
        if (pConf && pConf.slaMinutes) targetMinutes = pConf.slaMinutes;
    }

    if (targetMinutes === -1) {
        return { elapsedMinutes: 0, targetMinutes: -1, percentage: 0, status: 'ok', isTerminated: true, bloqueoCapExceeded: false };
    }

    const isNowTerminated = isTerminalStatus(ticket.status, config);
    let endTime = Date.now();
    
    // Si ya está terminado, intentamos buscar cuándo se terminó desde activities si está disponible.
    // Corregido 2026-08-27 (confirmado con datos reales en vivo, mientras se portaba
    // este mismo cálculo al backend para /api/export/tickets): los cambios de estado
    // NO se registran con type:'status_change' — ese type nunca existió en ningún
    // activity real. Van por el tracking genérico de campos (TRACKED_TICKET_FIELDS
    // en server.js), como cualquier otro campo editado: { type: 'campo_editado',
    // data: { field: 'Estado', from, to } }. Este filtro nunca encontraba nada y
    // siempre caía al respaldo "ahora" — así que el SLA mostrado para CUALQUIER
    // ticket ya cerrado (sidebar, tabla, CSV) se calculaba contra el momento actual
    // en vez del cierre real, pudiendo mostrar "Vencido" mucho después de haberse
    // resuelto a tiempo.
    if (isNowTerminated) {
        // ticket.fecha_resolucion es la fuente de verdad — el server la estampa solo
        // (PUT /api/tickets/:id) el instante exacto en que el ticket entra a un estado
        // terminal. Se prefiere sobre reconstruir la fecha del historial de
        // actividades; ese escaneo queda solo de respaldo por si algún ticket viejo
        // no la tuviera estampada (confirmado 2026-08-27 contra datos reales: coincide
        // exacto con el cierre real, mismo cambio aplicado en paralelo en server.js).
        if (ticket.fecha_resolucion) {
            endTime = new Date(ticket.fecha_resolucion).getTime();
        } else {
            const activities = ticket.activities || [];
            const statusActivities = activities
                .filter(a => a.type === 'campo_editado' && a.data?.field === 'Estado')
                .sort((a,b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
            const lastAct = statusActivities[statusActivities.length - 1];
            if (lastAct && isTerminalStatus(lastAct.data?.to, config)) {
                endTime = new Date(lastAct.ts).getTime();
            }
        }
    }

    const isDeskTicket = ticket.ambito === 'interno';
    let elapsedMinutes = isDeskTicket
        ? businessMinutesBetween(new Date(ticket.createdAt), new Date(endTime))
        : (endTime - new Date(ticket.createdAt).getTime()) / 60000;

    // SLA Pause: Restar tiempo de los bloqueos registrados en backend. "Stop SLA":
    // cada grupo puede configurar un tope máximo de pausa (config.groupBloqueoCaps);
    // pasado ese tope, esa pausa deja de acreditar tiempo adicional y el SLA sigue
    // corriendo solo, sin necesidad de un cron que reactive el ticket.
    let bloqueoCapExceeded = false;
    if (ticket.bloqueos && Array.isArray(ticket.bloqueos)) {
        const capMinutes = config?.groupBloqueoCaps?.[ticket.resolver_group_id || ticket.group];
        const capMs = (capMinutes != null && capMinutes > 0) ? capMinutes * 60000 : null;
        let totalBloqueoMs = 0;
        ticket.bloqueos.forEach(b => {
            if (b.bloqueado_desde) {
                const start = new Date(b.bloqueado_desde).getTime();
                let end = b.bloqueado_hasta ? new Date(b.bloqueado_hasta).getTime() : endTime;
                if (end > endTime) end = endTime;
                if (start < endTime) {
                    let durationMs = isDeskTicket
                        ? businessMinutesBetween(new Date(start), new Date(end)) * 60000
                        : (end - start);
                    if (capMs !== null && durationMs > capMs) {
                        durationMs = capMs;
                        if (!b.bloqueado_hasta) bloqueoCapExceeded = true;
                    }
                    totalBloqueoMs += durationMs;
                }
            }
        });
        const bloqueosMinutes = totalBloqueoMs / 60000;
        elapsedMinutes = Math.max(0, elapsedMinutes - bloqueosMinutes);
    }

    // Categoría de Volcán Desk sin SLA asignado todavía (null): no se marca como en
    // riesgo ni vencido hasta que un admin le configure un SLA explícito. "Sin límite"
    // (targetMinutes === 0, elegido a propósito en el selector) se comporta igual
    // (nunca vence) pero se distingue en el texto — y evita dividir entre 0 abajo.
    if (noSlaConfigured || targetMinutes === 0) {
        return {
            elapsedMinutes: Math.round(elapsedMinutes),
            targetMinutes: noSlaConfigured ? null : 0,
            percentage: 0,
            status: 'ok',
            isTerminated: isNowTerminated,
            bloqueoCapExceeded
        };
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
        isTerminated: isNowTerminated,
        bloqueoCapExceeded
    };
};

export const markTicketAsRead = (ticketId, role) => {
    const idx = cachedTickets.findIndex(t => t.id === ticketId);
    if (idx !== -1) {
        const ticket = cachedTickets[idx];
        if (ticket.ambito === 'interno') {
            // En tickets internos nadie tiene rol 'client' — hay que resolver el
            // lado real (solicitante/resolutor) igual que el servidor, no por rol
            // (ver markAsRead en server.js). Copia optimista aproximada (creador
            // exacto o membresía directa de grupo, sin AreaAccesoExtra); el
            // servidor manda la versión autoritativa.
            const currentUser = getCurrentUser();
            const isRequester = currentUser?.id === ticket.createdBy;
            const effectiveResolverGroup = ticket.resolver_group_id || ticket.group;
            const isResolverMember = !isRequester && (currentUser?.role === 'admin'
                || (!!effectiveResolverGroup && (currentUser?.groups || []).includes(effectiveResolverGroup)));
            const isRequesterSide = isRequester || (!isResolverMember && !!ticket.area_origen_id && (currentUser?.groups || []).includes(ticket.area_origen_id));
            if (isRequesterSide) {
                if (ticket.visto_por_cliente) return;
                ticket.visto_por_cliente = true;
            } else {
                if (ticket.visto_por_agente) return;
                ticket.visto_por_agente = true;
            }
        } else if (role === 'client') {
            if (ticket.visto_por_cliente) return;
            ticket.visto_por_cliente = true;
        } else {
            if (ticket.visto_por_agente) return;
            ticket.visto_por_agente = true;
        }
        saveToLocalStorage(cachedTickets);

        // Background API call
        pendingTicketWrites.add(ticketId);
        api.put(`/tickets/${ticketId}/read`, { role })
            .catch(err => console.error('Error marking ticket as read on server:', err))
            .finally(() => pendingTicketWrites.delete(ticketId));
    }
};
