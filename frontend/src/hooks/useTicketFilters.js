import { useMemo } from 'react';
import { getApoyoParaGrupo, getUserGroupsForScoping, computeSlaStatus } from '../services/ticketService';
import { isTerminalStatus } from '../services/configService';
import { getGroupById } from '../services/groupService';
import { normalizeText } from '../utils/helpers';

// new Date('YYYY-MM-DD') parsea como medianoche UTC, no local — para
// cualquier huso horario negativo (toda América) eso corre el filtro de
// fecha un día hacia atrás y un ticket creado "hoy" queda fuera del rango
// "hoy a hoy" por unas horas. Mismo bug ya encontrado y corregido en
// Dashboard.jsx (su propio date-range picker); el filtro de
// fecha del drawer "Filtros" de esta página es una implementación aparte
// que se quedó sin el fix. Se arma el Date a mano con los componentes
// LOCALES del string en vez de dejar que new Date(str) decida.
export const parseLocalDate = (str) => {
    const [y, m, d] = str.split('-').map(Number);
    return new Date(y, m - 1, d);
};

// Volcán Desk — las cuatro vistas de "mi relación con el ticket" (doc "lógica de
// visualización" §3/§13). 'all' es la 5ta pestaña, solo para admin/group_admin,
// que no tienen una pertenencia de grupo 1:1 como un agente normal.
export const deskRoleViewMatch = (t, view, currentUser, myGroups) => {
    switch (view) {
        case 'requester': return t.createdBy === currentUser.id;
        case 'attention': return t.assignedTo === currentUser.id || t.resolver_agent_id === currentUser.id;
        // "De mi grupo" SIEMPRE debe incluir "Mías" — a pedido del usuario (2026-09-07):
        // "en las de mi grupo también deben estar las mías, eso debe funcionar como
        // 'Todas'". Antes solo miraba area_origen_id/resolver_group_id, así que un
        // ticket sin area_origen_id poblado (caso real confirmado en vivo — se puede
        // crear sin Grupo asociado) se caía de "De mi grupo" aunque el propio usuario
        // lo hubiera creado. El OR con el criterio de "Mías" lo garantiza siempre,
        // sin depender de que esos campos vengan bien poblados en cada ticket.
        case 'groupRequests': return myGroups.includes(t.area_origen_id) || t.createdBy === currentUser.id;
        case 'groupAttention': return myGroups.includes(t.resolver_group_id || t.group) || !!getApoyoParaGrupo(t, myGroups)
            || t.assignedTo === currentUser.id || t.resolver_agent_id === currentUser.id;
        default: return true; // 'all'
    }
};

// Extraído de Tickets.jsx (2026-09-21) — antes era una función de ~180 líneas
// dentro del componente (`applyFilters`), imposible de testear de forma
// aislada. Misma lógica exacta, sin cambios de comportamiento; el único
// cambio real es que ahora es un useMemo (recalcula solo cuando cambia algo
// de lo que en verdad usa) en vez de un useEffect+setState aparte — el
// resultado es idéntico para las mismas entradas.
export function useTicketFilters({ tickets, activeWorkspace, currentUser, searchTerm, filters, deskFixedAxis, config, deskRoleView, quickView }) {
    return useMemo(() => {
        let result = [...tickets];

        // ─── AMBITO (WORKSPACE) VISIBILITY ───
        result = result.filter(t => {
            const ticketAmbito = t.ambito || 'externo';
            const currentAmbito = activeWorkspace === 'volcan_desk' ? 'interno' : 'externo';
            return ticketAmbito === currentAmbito;
        });

        // ─── ROLE-BASED VISIBILITY (STRICT) ───
        if (currentUser.role === 'agent') {
            // Ejecutivos: ven tickets de sus grupos asignados, de su área origen,
            // o los que ellos mismos crearon (aunque no pertenezcan al grupo
            // destino — ej. un solicitante de Volcán Desk viendo su propia solicitud).
            // `t.group` puede venir como NOMBRE en vez de id (tickets viejos o
            // creados vía API/pruebas) — resolver_group_id es la fuente de verdad
            // cuando existe. Mismo bug ya corregido en ticketService.getVisibleTickets,
            // server.js checkTicketAccess y server.js GET /api/tickets: sin este
            // fallback, un ticket ya ruteado al grupo pero con `group` como nombre
            // se contaba en el badge de la pestaña (que confía en el backend) pero
            // desaparecía de la tabla renderizada (que reaplicaba este filtro más
            // estricto en el cliente). Igual que el bug anterior, este filtro debe
            // usar getUserGroupsForScoping (incluye AreaAccesoExtra), no el array
            // nativo currentUser.groups a secas — si no, un usuario cuyo único
            // acceso a un grupo viene de un Acceso Especial (ej. groups: [] pero
            // con permisos extra) veía el badge de la pestaña correcto pero la
            // tabla completamente vacía (reportado en vivo 2026-09-16, cuenta
            // "Kendy test": 3 accesos especiales, 0 grupos nativos).
            const userGroups = getUserGroupsForScoping(currentUser);
            result = result.filter(t =>
                userGroups.includes(t.resolver_group_id || t.group) ||
                userGroups.includes(t.area_origen_id) ||
                t.createdBy === currentUser.id ||
                !!getApoyoParaGrupo(t, userGroups)
            );
        } else if (currentUser.role === 'client') {
            // Clients: STRICTLY see tickets from their company
            const companyId = currentUser.companyId;
            result = result.filter(t => t.companyId === companyId);
        }
        // Admin ve todo

        // ─── USER FILTERS ───
        if (searchTerm) {
            // Insensible a mayúsculas/acentos ("credito" debe encontrar "Crédito"),
            // y no solo por id/asunto/descripción: también por producto y por
            // nombre de grupo solicitante/resolutor — el placeholder del buscador
            // promete "grupo solicitante" pero antes no se comparaba contra nada
            // de eso, así que buscar por grupo nunca traía resultados.
            const s = normalizeText(searchTerm);
            result = result.filter(t => {
                const originGroupName = t.area_origen_id ? (getGroupById(t.area_origen_id)?.name || '') : '';
                const resolverRaw = t.resolver_group_id || t.group;
                const resolverGroupName = getGroupById(resolverRaw)?.name || (typeof resolverRaw === 'string' ? resolverRaw : '');
                return [t.title, t.description, t.id, t.product, originGroupName, resolverGroupName]
                    .some(field => field && normalizeText(field).includes(s));
            });
        }

        if (filters.status && filters.status.length > 0) {
            result = result.filter(t => filters.status.includes(t.status));
        }
        if (filters.priority && filters.priority.length > 0) {
            result = result.filter(t => filters.priority.includes(t.priority));
        }
        if (filters.type && filters.type.length > 0) {
            result = result.filter(t => filters.type.includes(t.category));
        }
        if (filters.companyId && filters.companyId.length > 0) {
            result = result.filter(t => filters.companyId.includes(t.companyId));
        }
        if (filters.group && filters.group.length > 0) {
            // En "Solicitudes Recibidas" el resolutor eres siempre tú/tu grupo
            // (fijo) — lo único que varía y tiene sentido filtrar es quién PIDIÓ
            // el ticket (area_origen_id). Filtrar por resolver_group_id ahí nunca
            // matcheaba nada (reportado en vivo 2026-09-07: filtrar "Operaciones"
            // en Recibidas no encontraba un ticket que SÍ vino de Operaciones,
            // porque resolver_group_id era el propio grupo, no Operaciones).
            // En "Enviadas" es al revés: el origen eres tú/tu grupo (fijo), lo
            // que varía es a quién se lo mandaste (resolver_group_id||group).
            if (activeWorkspace === 'volcan_desk' && deskFixedAxis === 'atencion') {
                result = result.filter(t => filters.group.includes(t.area_origen_id));
            } else if (activeWorkspace === 'volcan_desk' && deskFixedAxis === 'solicitudes') {
                result = result.filter(t => filters.group.includes(t.resolver_group_id || t.group));
            } else {
                result = result.filter(t => filters.group.includes(t.group) || filters.group.includes(t.resolver_group_id) || filters.group.includes(t.area_origen_id));
            }
        }
        if (filters.bloqueado) {
            result = result.filter(t => t.bloqueado);
        }
        if (filters.assignedTo && filters.assignedTo.length > 0) {
            // En "Solicitudes Enviadas" el filtro "Agente" significa "quién de mi
            // grupo pidió esto" (createdBy) — nunca "quién lo resuelve" (eso es
            // alguien de OTRO grupo, nunca coincide con las opciones del filtro,
            // que ya están acotadas a tu propio grupo). Reportado en vivo
            // 2026-09-07: filtrar por Javier en Enviadas no encontraba sus propios
            // 2 tickets, porque ninguno tiene resolver_agent_id/assignedTo = Javier.
            result = result.filter(t => deskFixedAxis === 'solicitudes'
                ? filters.assignedTo.includes(t.createdBy)
                : (filters.assignedTo.includes(t.assignedTo) || filters.assignedTo.includes(t.resolver_agent_id)));
        }
        // Asignación: reemplaza el viejo checkbox booleano "Sin asignar" por un
        // criterio de 3 posiciones (Todos/Asignados/Sin asignar), vive en "Más filtros".
        if (filters.assignment === 'unassigned') {
            result = result.filter(t => !t.assignedTo && !t.resolver_agent_id);
        } else if (filters.assignment === 'assigned') {
            result = result.filter(t => t.assignedTo || t.resolver_agent_id);
        }
        // SLA: criterio propio, vive en "Más filtros" — ya no es una pestaña.
        if (filters.sla && filters.sla !== 'all') {
            const slaKey = filters.sla === 'ontime' ? 'ok' : filters.sla;
            result = result.filter(t => !isTerminalStatus(t.status) && computeSlaStatus(t, config).status === slaKey);
        }

        const waitingFilter = (t) => {
            const waitingMsgDe = currentUser.role === 'client' ? 'agente' : 'cliente';
            return t.ultimo_mensaje_de === waitingMsgDe && !t[currentUser.role === 'client' ? 'visto_por_cliente' : 'visto_por_agente'] && !isTerminalStatus(t.status);
        };

        if (activeWorkspace === 'volcan_desk') {
            // ─── Volcán Desk: dos niveles separados ───
            // Nivel 1 — mi relación con el ticket (4 pestañas + Todos para gestión).
            // getUserGroupsForScoping es la única fuente de verdad para "qué grupos
            // veo" (admin/group_admin/Acceso Especial incluidos) — 2026-09-16, ver
            // su comentario en ticketService.js para el bug que esto reemplaza.
            result = result.filter(t => deskRoleViewMatch(t, deskRoleView, currentUser, getUserGroupsForScoping(currentUser)));

            // Nivel 2 — estado (selector, no pestaña). Simplificado a 3
            // categorías (antes había 5, con "En proceso"/"Esperando
            // respuesta" separados, que resultaban redundantes en la
            // práctica): Pendiente = recién creado; Abiertos = todo lo que
            // no está terminado, incluye a los pendientes; Cerrados = estado
            // terminal.

        } else {
            // ─── Voltik: barra de pestañas heredada, sin cambios ───
            if (quickView === 'requester') {
                result = result.filter(t => t.createdBy === currentUser.id || (currentUser.role === 'client' && t.contactId === currentUser.id));
            }
            if (quickView === 'attention') {
                result = result.filter(t => t.assignedTo === currentUser.id || t.resolver_agent_id === currentUser.id);
            }
            if (quickView === 'active') result = result.filter(t => !isTerminalStatus(t.status));
            if (quickView === 'done') result = result.filter(t => isTerminalStatus(t.status));
            if (quickView === 'unassigned') result = result.filter(t => !t.assignedTo && !t.resolver_agent_id);
            if (quickView === 'warning') result = result.filter(t => computeSlaStatus(t, config).status === 'warning' && !isTerminalStatus(t.status));
            if (quickView === 'breached') result = result.filter(t => computeSlaStatus(t, config).status === 'breached' && !isTerminalStatus(t.status));
            if (quickView === 'waiting') {
                result = result.filter(waitingFilter);
                result.sort((a, b) => {
                    const da = a.ultimo_mensaje_at ? new Date(a.ultimo_mensaje_at).getTime() : 0;
                    const db = b.ultimo_mensaje_at ? new Date(b.ultimo_mensaje_at).getTime() : 0;
                    return da - db;
                });
            }
        }

        if (filters.dateFrom || filters.dateTo) {
            result = result.filter(t => {
                const created = new Date(t.createdAt);
                created.setHours(0, 0, 0, 0);
                if (filters.dateFrom) {
                    const from = parseLocalDate(filters.dateFrom);
                    from.setHours(0, 0, 0, 0);
                    if (created < from) return false;
                }
                if (filters.dateTo) {
                    const to = parseLocalDate(filters.dateTo);
                    to.setHours(23, 59, 59, 999);
                    if (created > to) return false;
                }
                return true;
            });
        }

        return result;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tickets, activeWorkspace, currentUser, searchTerm, filters, deskFixedAxis, config, deskRoleView, quickView]);
}
