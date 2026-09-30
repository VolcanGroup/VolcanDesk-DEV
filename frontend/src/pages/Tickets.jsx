import './Tickets.css';
import './TicketsProposal.css';
import { useState, useEffect, useContext, useRef } from 'react';
import { WorkspaceContext } from '../context/WorkspaceContext';
import {
    IoAddOutline,
    IoSearchOutline,
    IoFunnelOutline,
    IoCloseOutline,
    IoRefreshOutline,
    IoFilterOutline,
    IoChevronDownOutline,
    IoListOutline,
    IoGridOutline,
    IoCalendarOutline,
    IoDownloadOutline
} from 'react-icons/io5';
import { getTickets, createTicket, updateTicket, escalateTicket, addComment, editComment, deleteComment, addAttachment, removeAttachment, computeSlaStatus, loadTicketsFromServer, markTicketAsRead, getUserGroupsForScoping, fetchTicketDetail } from '../services/ticketService';
import { getUsers } from '../services/userService';
import { getContacts, getCompanies, loadCompaniesFromServer } from '../services/companyService';
import { getCurrentUser } from '../services/authService';
import { getConfig, loadConfigFromServer, INTERNAL_STATUSES, isTerminalStatus, getFormFields, resolveStatus, resolvePriority } from '../services/configService';
import { getGroups, getGroupById, isDeskRequesterOnly } from '../services/groupService';
import { exportToCSV } from '../utils/helpers';
import { useTicketFilters, deskRoleViewMatch } from '../hooks/useTicketFilters';
import { resolveReglaFlujo, getCamposCatalogo } from '../services/flowService';
import Modal from '../components/Modal';
import Badge from '../components/Badge';
import TicketTable from '../components/TicketTable';
import ErrorBoundary from '../components/ErrorBoundary';
import KanbanBoard from '../components/KanbanBoard';
import CronogramaView from '../components/CronogramaView';
import TicketDetailView from '../components/TicketDetailView';
import ContactAutocomplete from '../components/ContactAutocomplete';
import RichTextEditor from '../components/RichTextEditor';
import Multiselect from '../components/Multiselect';

const ALL_COLUMNS = [
    { key: 'id', label: 'Ticket' },
    { key: 'status', label: 'Estado' },
    { key: 'sla', label: 'SLA' },
    { key: 'assignedTo', label: 'Asignado' },
    { key: 'updatedAt', label: 'Actualización' },
    { key: 'group', label: 'Grupo' },
    { key: 'category', label: 'Categoría' },
    { key: 'priority', label: 'Prioridad' }
];

// Las mismas 4 vistas, pero agrupadas por "eje" (qué relación tengo con el ticket:
// lo solicité vs. lo atiendo) sin importar el alcance (mías vs. de mi grupo) — solo
// para los contadores del nivel 1 de la jerarquía visual (feedback del usuario:
// separar "Solicitudes"/"Atención" como eje principal y "Mías"/"De mi grupo" como
// sub-nivel, en vez de 4 pestañas planas al mismo nivel).
const deskAxisMatch = (t, axis, currentUser, myGroups) => {
    if (axis === 'solicitudes') return deskRoleViewMatch(t, 'requester', currentUser, myGroups) || deskRoleViewMatch(t, 'groupRequests', currentUser, myGroups);
    if (axis === 'atencion') return deskRoleViewMatch(t, 'attention', currentUser, myGroups) || deskRoleViewMatch(t, 'groupAttention', currentUser, myGroups);
    return true; // 'all'
};

// Descripción en lenguaje natural de cada combinación eje+alcance — se muestra como
// subtítulo dinámico bajo los dos niveles de pestañas, para que la vista activa
// quede inequívoca sin tener que leer 4 etiquetas técnicas distintas a la vez.
const DESK_VIEW_DESCRIPTIONS = {
    'solicitudes:mias': { title: 'Lo que solicité', desc: 'Tickets que tú pediste a otra área.' },
    'solicitudes:grupo': { title: 'Lo que solicitó mi grupo', desc: 'Tickets que personas de tu grupo pidieron a otras áreas.' },
    'atencion:mias': { title: 'Lo que atiendo', desc: 'Tickets que están asignados a ti para resolver.' },
    'atencion:grupo': { title: 'Lo que atiende mi grupo', desc: 'Tickets que fueron enviados a tu grupo para resolver, estén o no asignados a ti.' },
};

// Columnas de tabla por vista (doc §14) — cada vista destaca una relación distinta
// con el ticket, así que no siempre son las mismas columnas ni en el mismo orden.
const DESK_VIEW_COLUMN_PRESETS = {
    requester: ['id', 'status', 'sla', 'group', 'assignedTo', 'updatedAt', 'priority'],
    attention: ['id', 'status', 'sla', 'requester', 'group', 'updatedAt', 'priority'],
    groupRequests: ['id', 'requester', 'group', 'assignedTo', 'status', 'sla', 'priority'],
    groupAttention: ['id', 'requester', 'assignedTo', 'status', 'sla', 'updatedAt', 'priority'],
    all: ['id', 'status', 'subestado', 'priority', 'type', 'category', 'requesterGroup', 'group', 'assignedTo', 'createdAt', 'sla'],
};


// deskFixedAxis ('atencion' | 'solicitudes' | undefined): cuando se manda, esta
// página se comporta como una de las dos entradas de menú separadas de Volcán
// Desk ("Solicitudes Recibidas"/"Solicitudes Enviadas", 2026-09-07) — el eje
// queda fijo (sin selector Solicitudes/Atención/Todos) y solo se elige entre
// "Mías"/"De mi grupo" dentro de ese eje. undefined preserva el comportamiento
// original de una sola página con los 3 ejes (usado hoy solo por Voltik).
export default function Tickets({ createTicketTrigger, deskFixedAxis }) {
    const { activeWorkspace, changeWorkspace } = useContext(WorkspaceContext);
    const currentUser = getCurrentUser();
    const isInternalUser = currentUser?.role !== 'client';
    const [tickets, setTickets] = useState([]);
    const [users, setUsers] = useState([]);
    // Exportar (Solicitudes, no Reportes): 'filtered' usa exactamente lo que
    // está en pantalla ahora (pestaña + Filtros + búsqueda), 'all' usa el
    // universo permitido antes de esos recortes.
    const [exportScope, setExportScope] = useState('filtered');
    const [searchTerm, setSearchTerm] = useState('');
    const [showCreateModal, setShowCreateModal] = useState(false);
    // Bloquear doble clic en "Crear Solicitud" (2026-09-29, a pedido del
    // usuario) — createTicket() es síncrono/optimista (el ticket ya se ve en
    // la lista al instante), así que antes el modal se cerraba de inmediato
    // sin esperar nada del servidor. Ahora el modal se queda abierto con el
    // botón deshabilitado ("Guardando…") hasta que el POST real se resuelve
    // (evento 'ticket-create-settled', ya existente para el aviso de error) —
    // así el usuario ve una confirmación real antes de poder volver a
    // intentar, en vez de un cierre instantáneo sin retroalimentación.
    const [isCreatingTicket, setIsCreatingTicket] = useState(false);
    const pendingCreateIdRef = useRef(null);
    const [selectedTicket, setSelectedTicket] = useState(null);
    const [showFilterPanel, setShowFilterPanel] = useState(false);
    const [quickView, setQuickView] = useState('all'); // Voltik: barra de pestañas heredada (sin cambios)
    // Volcán Desk: dos niveles separados en vez de una sola fila de pestañas mezclando
    // criterios distintos — 1) mi relación con el ticket, 2) su estado.
    // 'groupAttention' (Atención → De mi grupo) es el default para todo el que
    // resuelve tickets dentro de UN grupo (agent/group_admin) — a pedido
    // del usuario (2026-09-07): al entrar debe verse de inmediato la cola real del
    // equipo, incluidos los tickets sin asignar, en vez de solo "lo mío" o un
    // panorama genérico. 'requester' sigue siendo el default para quien únicamente
    // levanta solicitudes (sin grupo resolutor). 'all' se queda para 'admin': no
    // pertenece a ningún grupo puntual (myGroups vacío), así que "de mi grupo" no
    // le mostraría nada — necesita el panorama completo desde el inicio.
    const [deskRoleView, setDeskRoleView] = useState(() => {
        // Página de eje fijo (Solicitudes Recibidas/Enviadas, 2026-09-07): siempre
        // arranca en el alcance "De mi grupo" de ese eje — ya incluye "lo mío" por
        // construcción (deskRoleViewMatch no distingue quién es el responsable
        // dentro del grupo), así que es el panorama completo, no una vista parcial.
        if (deskFixedAxis === 'solicitudes') return 'groupRequests';
        if (deskFixedAxis === 'atencion') return 'groupAttention';
        if (currentUser?.role === 'admin') return 'all';
        if (isDeskRequesterOnly(currentUser)) return 'requester';
        return 'groupAttention';
    });
    const [deskEstadoView, setDeskEstadoView] = useState('all'); // 'all' | 'pending' | 'open' | 'closed'
    const [config, setConfig] = useState(getConfig());
    // Accordion open state for filter sections (all open by default)
    const [openFilters, setOpenFilters] = useState({ status: true, priority: true, agent: false, date: false, type: false });
    const toggleFilter = (key) => setOpenFilters(p => ({ ...p, [key]: !p[key] }));

    const [newTicket, setNewTicket] = useState({
        contactId: null,
        subject: '',
        type: '',
        group: '',
        category: '',
        status: 'new',
        priority: 'medium',
        description: '', // HTML content
        plainDescription: '', // Plain text content
        tags: '',
        attachments: [],
    });
    const [newTicketContact, setNewTicketContact] = useState(null);
    const [newTicketAttachments, setNewTicketAttachments] = useState([]);

    // Filters state
    const [filters, setFilters] = useState({
        status: [],
        priority: [],
        type: [],
        companyId: [],
        group: [],
        dateFrom: '',
        dateTo: '',
        assignedTo: [],
        assignment: 'all', // 'all' | 'assigned' | 'unassigned'
        sla: 'all', // 'all' | 'ontime' | 'warning' | 'breached'
        hasUnread: false,
        bloqueado: false,
    });

    const [catalogoCampos, setCatalogoCampos] = useState([]);
    const [activeDynamicFields, setActiveDynamicFields] = useState([]);
    const [extraBaseFieldDefs, setExtraBaseFieldDefs] = useState([]);
    const [dynamicFieldValues, setDynamicFieldValues] = useState({});
    const [flowValidationErrors, setFlowValidationErrors] = useState([]);
    const [flowBannerMsg, setFlowBannerMsg] = useState('');
    const [saveErrorBanner, setSaveErrorBanner] = useState('');

    // Campos "nuevos" configurados en Configuración → Campos del Formulario
    // (scope='base', propios del módulo) para que siempre aparezcan, sin
    // depender del Tipo/Categoría — catálogo independiente del de Flujos.
    // En Volcán Desk además quedan acotados al Grupo elegido en el formulario.
    useEffect(() => {
        const list = catalogoCampos.filter(c =>
            c.scope === 'base' &&
            (c.modulo || 'voltik') === activeWorkspace &&
            (activeWorkspace !== 'volcan_desk' || c.grupo_id === newTicket.group)
        );
        setExtraBaseFieldDefs(list);
        setDynamicFieldValues(prev => {
            const next = { ...prev };
            list.forEach(f => { if (!(f.id in next)) next[f.id] = ''; });
            return next;
        });
    }, [activeWorkspace, catalogoCampos, newTicket.group]);

    // Auto-resolve dynamic fields rule on Type/Category changes (campos
    // CONDICIONALES — se combinan con extraBaseFieldDefs, que son siempre visibles)
    useEffect(() => {
        const preserveExtraOnly = (prev) => {
            const preserved = {};
            extraBaseFieldDefs.forEach(f => { preserved[f.id] = prev[f.id] ?? ''; });
            return preserved;
        };

        const resolveFieldsForType = async () => {
            setFlowBannerMsg('');
            if (!newTicket.type) {
                setActiveDynamicFields([]);
                setDynamicFieldValues(preserveExtraOnly);
                setFlowValidationErrors([]);
                return;
            }
            try {
                const rule = await resolveReglaFlujo(newTicket.type, newTicket.category);
                if (rule && rule.activo && Array.isArray(rule.campos) && rule.campos.length > 0) {
                    const mapped = rule.campos.map(rc => {
                        const originalField = catalogoCampos.find(c => c.id === rc.campo_id);
                        if (!originalField) return null;
                        return {
                            ...originalField,
                            obligatorio: rc.obligatorio,
                            orden: rc.orden
                        };
                    }).filter(Boolean);
                    setActiveDynamicFields(mapped);

                    setDynamicFieldValues(prev => {
                        const next = preserveExtraOnly(prev);
                        mapped.forEach(f => { next[f.id] = f.id in next ? next[f.id] : ''; });
                        return next;
                    });
                    setFlowValidationErrors([]);
                } else {
                    setActiveDynamicFields([]);
                    setDynamicFieldValues(preserveExtraOnly);
                    setFlowValidationErrors([]);
                }
            } catch (error) {
                console.error('Error resolving flow rule:', error);
                setActiveDynamicFields([]);
                setDynamicFieldValues(preserveExtraOnly);
                setFlowValidationErrors([]);
            }
        };

        resolveFieldsForType();
    }, [newTicket.type, newTicket.category, catalogoCampos, extraBaseFieldDefs]);

    // Lista combinada que realmente se muestra/valida en el formulario:
    // los "siempre visibles" primero, luego los condicionales de la regla activa.
    const allDynamicFields = [
        ...extraBaseFieldDefs,
        ...activeDynamicFields.filter(f => !extraBaseFieldDefs.some(e => e.id === f.id))
    ].sort((a, b) => (a.orden || 0) - (b.orden || 0));

    const [companies, setCompanies] = useState([]);
    const [activeFilterCount, setActiveFilterCount] = useState(0);

    // Columns Visibility State
    const [showColumnDropdown, setShowColumnDropdown] = useState(false);
    const [visibleColumns, setVisibleColumns] = useState(['id', 'status', 'sla', 'assignedTo', 'updatedAt', 'group', 'category', 'priority']);

    // Vista Tabla/Tablero/Cronograma (solo Volcán Desk)
    const [viewMode, setViewMode] = useState('table'); // 'table' | 'board' | 'gantt'
    const [groupBy, setGroupBy] = useState('status'); // 'status' | 'area' | 'priority' | 'assignee'
    const [sortMode, setSortMode] = useState('urgency'); // 'urgency' | 'date' — vista Tabla

    // Bug encontrado en vivo: tras escalar (o cualquier acción que saque un ticket
    // del alcance del usuario actual, p.ej. ya no pertenece a su grupo resolutor),
    // `getTickets().find(...)` deja de encontrarlo — pero como cada call site hacía
    // `{ ...getTickets().find(...) }` directo, un `find` fallido (undefined) se
    // convertía silenciosamente en un objeto VACÍO `{}` (spread de undefined no
    // truena), y ese objeto vacío sí pasa el `if (selectedTicket)` de abajo: se
    // renderiza TicketDetailView con un ticket sin ningún campo — encabezado "#"
    // vacío, comentario en blanco, "Sin propietario", panel de solicitante
    // genérico. En vez de eso, si ya no se encuentra, se cierra el detalle y se
    // avisa por qué (el usuario perdió acceso), tal como pide la vista de "Ver
    // detalle" al no tener el ticket disponible.
    // getTickets() (el listado) ya no trae comments/camposValores por
    // rendimiento (ver loadTicketsFromServer en ticketService.js, 2026-09-17)
    // — intentar "preservar" esos campos a mano en cada refresco se rompe en
    // cuanto se agrega un comentario nuevo (el objeto local recién mutado solo
    // tiene el comentario nuevo, no el historial completo; preservar el viejo
    // pierde el nuevo, y viceversa). Más simple y correcto: el ticket ABIERTO
    // siempre se refresca con su detalle real y completo (GET
    // /api/tickets/:id) — es UN solo ticket, no toda la organización, así que
    // no reintroduce el costo que se le quitó al listado. getTickets() solo se
    // usa aquí para confirmar que el usuario todavía tiene acceso (el mismo
    // chequeo de antes, sin depender de comments/camposValores para nada).
    const refreshSelectedTicketOrClose = async (ticketId) => {
        const stillVisible = getTickets().some(t => t.id === ticketId);
        if (!stillVisible) {
            setSelectedTicket(null);
            setSaveErrorBanner('Ya no tienes acceso a este ticket — probablemente fue escalado o movido fuera de tu grupo.');
            return;
        }
        try {
            const full = await fetchTicketDetail(ticketId);
            setSelectedTicket(prev => (prev === null || prev.id === ticketId ? full : prev));
        } catch (err) {
            console.error('Error al refrescar el detalle del ticket:', err);
        }
    };

    // Evita volver a empujar una entrada de historial cuando el cambio de
    // selectedTicket vino de "atrás/adelante" del navegador (ver popstate más
    // abajo) — si no, cada "atrás" generaría también un "adelante" fantasma.
    const isPopNavRef = useRef(false);

    // Id de página real para el historial del navegador — Solicitudes
    // Recibidas/Enviadas (Volcán Desk) no son 'tickets', son
    // 'tickets-recibidas'/'tickets-enviadas' (ver App.jsx). Antes esto se
    // pusheaba siempre como 'tickets' a secas, así que el listener de
    // popstate de abajo (que compara contra 'tickets') nunca coincidía en
    // Volcán Desk y el botón "Atrás" del navegador se quedaba sin hacer
    // nada mientras se veía el detalle de un ticket (reportado en vivo
    // 2026-09-14).
    const historyPageId = deskFixedAxis === 'atencion' ? 'tickets-recibidas'
        : deskFixedAxis === 'solicitudes' ? 'tickets-enviadas'
        : 'tickets';

    const handleSelectTicket = (ticket) => {
        if (ticket) {
            // El marcado como leído ocurre automáticamente dentro de TicketDetailView al abrir
            refreshTickets();
            // Se muestra de inmediato con lo que ya se tenía (de la fila en la
            // que se hizo clic) para que el panel abra sin espera — sin
            // comments/camposValores todavía. refreshSelectedTicketOrClose,
            // abajo, pide el detalle real completo y lo reemplaza en cuanto
            // llega (normalmente un instante después).
            setSelectedTicket(ticket);
            refreshSelectedTicketOrClose(ticket.id);
            // Un link compartido puede apuntar a un ticket del otro workspace (Voltik vs.
            // Volcán Desk) — se sincroniza aquí para que "Volver a Tickets" caiga en la
            // lista correcta en vez de dejar al usuario viendo el módulo equivocado.
            const ticketWorkspace = ticket.ambito === 'interno' ? 'volcan_desk' : 'voltik';
            if (ticketWorkspace !== activeWorkspace) changeWorkspace(ticketWorkspace);
            if (!isPopNavRef.current) {
                sessionStorage.setItem('openTicketId', ticket.id);
                // La URL visible ahora refleja el ticket abierto (antes pushState se
                // llamaba con url = '', así que la barra de direcciones nunca cambiaba y
                // siempre mostraba la raíz del sitio, sin importar qué ticket estuviera
                // abierto) — así el link de la barra de direcciones ya es compartible/embebible.
                // Formato /tickets/<id> para que coincida con los links que ya manda
                // emailService.js (backend) — serve-static.cjs sirve index.html para
                // cualquier ruta que no sea un archivo, así que no requiere nada del servidor.
                const url = `/tickets/${encodeURIComponent(ticket.id)}`;
                window.history.pushState({ ...(window.history.state || {}), page: historyPageId, ticketId: ticket.id }, '', url);
            }
        } else {
            setSelectedTicket(null);
            if (!isPopNavRef.current) {
                sessionStorage.removeItem('openTicketId');
                window.history.pushState({ ...(window.history.state || {}), page: historyPageId, ticketId: null }, '', '/');
            }
        }
        isPopNavRef.current = false;
    };

    // "Atrás"/"adelante" del navegador mientras se está en Tickets: cierra o
    // reabre el detalle del ticket según el ticketId de esa entrada de
    // historial, en vez de sacar al usuario del sitio (antes no había ningún
    // listener, así que el navegador manejaba el evento por su cuenta).
    useEffect(() => {
        const onPopState = (e) => {
            if (e.state?.page !== historyPageId) return;
            isPopNavRef.current = true;
            const ticketId = e.state?.ticketId || null;
            const t = ticketId ? getTickets().find(tk => tk.id === ticketId) : null;
            handleSelectTicket(t || null);
        };
        window.addEventListener('popstate', onPopState);
        return () => window.removeEventListener('popstate', onPopState);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleMarkAsRead = (ticketId) => {
        markTicketAsRead(ticketId, currentUser.role);
        refreshTickets();
        refreshSelectedTicketOrClose(ticketId);
    };

    // Un ticket se muestra optimistamente al crearlo, pero el guardado real es
    // en segundo plano. Si falla, esto avisa y quita el ticket fantasma de la vista.
    useEffect(() => {
        const onSettled = (e) => {
            const { ok, id, title, error } = e.detail || {};
            if (!ok) {
                setSaveErrorBanner(`No se pudo guardar "${title}" en el servidor. Vuelve a intentarlo.${error ? ` (${error})` : ''}`);
            }
            refreshTickets();
            // Solo cierra/reinicia el modal si este settle es el de la creación
            // que el modal está esperando — evita que un settle de otra
            // creación (en teoría no debería pasar, el modal no deja abrir dos
            // a la vez, pero es una guarda barata) cierre el modal actual.
            if (pendingCreateIdRef.current && id === pendingCreateIdRef.current) {
                pendingCreateIdRef.current = null;
                setIsCreatingTicket(false);
                if (ok) {
                    setShowCreateModal(false);
                    setNewTicket({ contactId: null, subject: '', type: '', product: '', group: '', category: '', status: 'new', priority: 'medium', description: '', plainDescription: '', tags: '', assignedTo: null });
                    setNewTicketContact(null);
                    setNewTicketAttachments([]);
                    setActiveDynamicFields([]);
                    setDynamicFieldValues({});
                    setFlowValidationErrors([]);
                    setFlowBannerMsg('');
                }
                // Si falló (ok=false), el modal se queda abierto con los datos
                // tal como estaban — el banner de error ya avisó, y así el
                // usuario no pierde lo que había escrito y puede reintentar.
            }
        };
        window.addEventListener('ticket-create-settled', onSettled);
        return () => window.removeEventListener('ticket-create-settled', onSettled);
    }, []);

    useEffect(() => {
        const loadInitialData = async () => {
            await loadCompaniesFromServer();
            setCompanies(getCompanies());
            try {
                const list = await getCamposCatalogo();
                setCatalogoCampos(list || []);
            } catch (err) {
                console.error(err);
            }
        };
        loadInitialData();
        refreshTickets();
        const internalUsers = getUsers();
        const externalContacts = getContacts();
        setUsers([...internalUsers, ...externalContacts]);
        setConfig(getConfig());
        // Un ticket abierto puede venir de la URL (link compartido, ej.
        // /tickets/VD-BI-000123 — el formato que ya usa emailService.js en los
        // correos — o el ?ticket=VD-BI-000123 más viejo, por compatibilidad con
        // links ya copiados) o de sessionStorage (el que ya estaba abierto antes de
        // un F5) — la URL manda si hay varias señales presentes, por ser la más
        // explícita. A diferencia de antes, sessionStorage ya NO se borra al leerlo
        // aquí: así un refresh de la página reabre el mismo ticket en vez de siempre
        // caer en la lista. Sidebar sí lo limpia al hacer clic en "Tickets" para
        // pedir una lista fresca.
        const pathMatch = window.location.pathname.match(/^\/tickets\/(.+)$/);
        const urlTicketId = (pathMatch ? decodeURIComponent(pathMatch[1]) : null)
            || new URLSearchParams(window.location.search).get('ticket');
        let pendingId = urlTicketId || sessionStorage.getItem('openTicketId');
        if (pendingId) {
            const allTickets = getTickets();
            const t = allTickets.find(tk => tk.id === pendingId);
            if (t) {
                isPopNavRef.current = true; // ya está en la URL/sessionStorage, no duplicar el push
                handleSelectTicket(t);
            } else {
                // El ticket puede no estar todavía en el caché de la lista — ese caché
                // solo se refresca cada 8s (poll) o en otros puntos explícitos, nunca
                // aquí al montar. Un clic en una notificación es justo el caso donde
                // más probable es que el ticket sea DEMASIADO reciente (comentario
                // nuevo, ticket recién escalado a tu grupo) para ya estar en ese
                // caché — antes esto se rendía de inmediato y aterrizaba en la lista
                // sin abrir nada, aunque el ticket sí existiera y sí fuera visible
                // para el usuario (reportado en vivo 2026-09-18). Se intenta un fetch
                // directo del detalle (mismo mecanismo que refreshSelectedTicketOrClose)
                // antes de darlo por perdido.
                fetchTicketDetail(pendingId)
                    .then(full => {
                        isPopNavRef.current = true;
                        handleSelectTicket(full);
                    })
                    .catch(() => {
                        // Antes solo avisaba si venía de un link de URL — un clic en una
                        // notificación que apunta a un ticket ya borrado (notificación
                        // huérfana, confirmado en vivo 2026-09-18: dos de tres notificaciones
                        // de un usuario apuntaban a tickets ya no existentes) se quedaba
                        // callado, dejando al usuario en la tabla sin ninguna pista de qué
                        // pasó. El aviso aplica igual sin importar de dónde vino el intento.
                        sessionStorage.removeItem('openTicketId');
                        setSaveErrorBanner('Ese ticket ya no existe o no tienes acceso a él.');
                        window.history.replaceState({ ...(window.history.state || {}), page: historyPageId, ticketId: null }, '', '/');
                    });
            }
        }
        // Ancla el ticketId (si lo hay) a la entrada de historial actual, para que el
        // primer "atrás" del navegador la encuentre, y deja la URL visible en sync.
        window.history.replaceState(
            { ...(window.history.state || {}), page: historyPageId, ticketId: pendingId || null },
            '',
            pendingId ? `/tickets/${encodeURIComponent(pendingId)}` : '/'
        );
    }, []);

    useEffect(() => {
        const interval = setInterval(async () => {
            try {
                await loadTicketsFromServer();
                refreshTickets();
                // Este poll de 8s tenía SU PROPIA copia de "refrescar el ticket
                // abierto desde el listado" — separada de refreshSelectedTicketOrClose
                // (arriba), así que el fix de ahí no la cubría: cada 8s volvía a
                // pisar el panel con la versión del listado (sin comments/
                // camposValores desde 2026-09-17), borrando la conversación que
                // ya se había cargado bien al abrir el ticket. Reportado en vivo
                // el mismo día ("se ve, pero al rato se borra sola"). Ahora usa
                // la misma función ya corregida — el `setSelectedTicket` de acá
                // solo sirve para leer el `prev` más reciente sin depender de
                // selectedTicket en las deps del efecto (este interval se crea
                // una sola vez); el refresh real (con fetch completo) lo hace
                // refreshSelectedTicketOrClose por su cuenta.
                setSelectedTicket(prev => {
                    if (prev) refreshSelectedTicketOrClose(prev.id);
                    return prev;
                });
                // Catálogos (Tipos/Categorías/Productos/Prioridades) también se editan
                // en vivo desde Configuración — sin este refresh, un usuario con esta
                // pantalla ya abierta necesitaba F5 para ver un ítem que otro admin
                // acababa de agregar (reportado en vivo 2026-09-16). Mismo intervalo
                // que el de tickets, no uno aparte, para no multiplicar timers.
                await loadConfigFromServer();
                setConfig(getConfig());
            } catch (err) {
                console.error("Error auto-polling tickets:", err);
            }
        }, 30000);
        return () => clearInterval(interval);
    }, []);



    // Extraído a src/hooks/useTicketFilters.js (2026-09-21) — mismo cálculo,
    // ahora como valor derivado (useMemo) en vez de estado propio + efecto.
    const filteredTickets = useTicketFilters({ tickets, activeWorkspace, currentUser, searchTerm, filters, deskFixedAxis, config, deskRoleView, quickView });

    useEffect(() => {
        // Count active (non-default) filters
        let count = 0;
        if (filters.status && filters.status.length > 0) count++;
        if (filters.priority && filters.priority.length > 0) count++;
        if (filters.type && filters.type.length > 0) count++;
        if (filters.companyId && filters.companyId.length > 0) count++;
        if (filters.group && filters.group.length > 0) count++;
        if (filters.assignedTo && filters.assignedTo.length > 0) count++;
        if (filters.dateFrom || filters.dateTo) count++;
        if (filters.assignment && filters.assignment !== 'all') count++;
        if (filters.sla && filters.sla !== 'all') count++;
        if (filters.hasUnread) count++;
        if (filters.bloqueado) count++;
        setActiveFilterCount(count);
    }, [filters]);

    const refreshTickets = () => setTickets([...getTickets()]);

    const resetFilters = () => {
        setFilters({
            status: [],
            priority: [],
            type: [],
            companyId: [],
            group: [],
            dateFrom: '',
            dateTo: '',
            assignedTo: [],
            assignment: 'all',
            sla: 'all',
            hasUnread: false,
            bloqueado: false
        });
        setSearchTerm('');
        setQuickView('all');
        setDeskEstadoView('all');
    };

    const setFilter = (key, value) => setFilters(prev => ({ ...prev, [key]: value }));

    const handleCreateTicket = (e) => {
        e.preventDefault();
        if (isCreatingTicket) return;

        // Volcán Desk: Tipo, Producto y Categoría son obligatorios (dependen del Grupo elegido),
        // salvo que el campo esté deshabilitado desde Campos del Formulario.
        if (isDeskCreate) {
            const missingBase = [];
            if (enabledFormFields.includes('tipo') && !newTicket.type) missingBase.push('Tipo');
            if (enabledFormFields.includes('producto') && !newTicket.product) missingBase.push('Producto');
            if (enabledFormFields.includes('categoria') && !newTicket.category) missingBase.push('Categoría');
            if (missingBase.length > 0) {
                setFlowBannerMsg(`Faltan datos obligatorios: ${missingBase.join(', ')}`);
                return;
            }
        }

        // Validate dynamic fields
        const missingFields = [];
        allDynamicFields.forEach(f => {
            if (f.obligatorio) {
                const val = dynamicFieldValues[f.id];
                if (val === undefined || val === null || String(val).trim() === '') {
                    missingFields.push(f);
                }
            }
        });

        if (missingFields.length > 0) {
            setFlowValidationErrors(missingFields.map(f => f.id));
            const missingNames = missingFields.map(f => f.nombre.toLowerCase()).join(', ');
            setFlowBannerMsg(`Faltan datos obligatorios: ${missingNames}`);
            return;
        }
        setFlowBannerMsg('');

        // Find companyId automatically
        let mappedCompanyId = null;
        let finalContactId = null;

        if (activeWorkspace === 'volcan_desk') {
            finalContactId = currentUser.id;
        } else if (currentUser.role === 'client') {
            mappedCompanyId = currentUser.companyId;
            finalContactId = currentUser.id;
        } else if (newTicketContact) {
            mappedCompanyId = newTicketContact.companyId;
            finalContactId = newTicketContact.id;
        }

        setIsCreatingTicket(true);
        const created = createTicket({
            title: newTicket.subject,
            description: newTicket.description, // HTML from RTE
            priority: newTicket.priority,
            type: newTicket.type || null,
            category: newTicket.category || null,
            group: newTicket.group || null,
            // "Grupo solicitante": foto del grupo del creador al momento de levantar el
            // ticket, independiente del grupo resolutor — no debe cambiar después,
            // ni siquiera si el ticket se reasigna o escala (ver doc "lógica de
            // visualización" §2/§9). Solo aplica a Volcán Desk.
            //
            // 2026-09-14 (producción): un group_admin guarda su único grupo en
            // admin_group_id, no en groups (ese array es para agent) —
            // usar solo currentUser.groups?.[0] dejaba area_origen_id en null para
            // cualquier ticket creado por un group_admin (reportado en vivo: el
            // panel "Solicitante" y el breadcrumb del ticket mostraban "—" en vez
            // del grupo real). Mismo criterio que ya se usa en TicketDetailView.jsx
            // (ownGroupId) para el mismo problema.
            area_origen_id: activeWorkspace === 'volcan_desk'
                ? ((currentUser.role === 'group_admin' ? currentUser.admin_group_id : currentUser.groups?.[0]) || null)
                : null,
            status: activeWorkspace === 'volcan_desk' ? 'to_do' : 'new',
            tags: newTicket.tags,
            contactId: finalContactId,
            companyId: mappedCompanyId,
            product: newTicket.product || null,
            assignedTo: (isInternalUser && activeWorkspace !== 'volcan_desk') ? (newTicket.assignedTo || currentUser.id) : (newTicket.assignedTo || null),
            createdBy: currentUser.id,
            ambito: activeWorkspace === 'volcan_desk' ? 'interno' : 'externo',
            attachments: newTicketAttachments, // Save attachments
            camposValores: dynamicFieldValues, // Save dynamic fields values
        });

        // El modal ya NO se cierra ni se reinicia aquí — se queda abierto con
        // el botón deshabilitado ("Guardando…") hasta que llegue el evento
        // 'ticket-create-settled' de este mismo ticket (ver el listener
        // arriba), para no permitir un segundo envío mientras el primero
        // sigue en camino al servidor.
        pendingCreateIdRef.current = created.id;
        refreshTickets();
    };

    const handleUpdateStatus = async (ticketId, newStatus) => {
        const pending = updateTicket(ticketId, { status: newStatus });
        refreshTickets();
        await pending;
        if (selectedTicket?.id === ticketId) {
            refreshSelectedTicketOrClose(ticketId);
        }
    };

    const handleAddComment = async (ticketId, text, isPrivate, attachments = []) => {
        // refreshSelectedTicketOrClose ahora pide el detalle real del servidor
        // (2026-09-17, ver su definición arriba) en vez de leer el caché local
        // ya mutado — así que hay que esperar a que la escritura real termine
        // ANTES de refrescar, o se corre el riesgo de traer una versión sin el
        // comentario recién agregado (el servidor todavía no lo procesa). Antes
        // no hacía falta esperar porque el refresh leía el caché local, que
        // addComment ya había mutado de forma síncrona.
        const pending = addComment(ticketId, currentUser.id, text, isPrivate, attachments);
        refreshTickets();
        await pending;
        refreshSelectedTicketOrClose(ticketId);
    };

    // Editar/eliminar un comentario propio dentro de la ventana de 60s
    // (2026-09-23, a pedido del usuario) — mismo patrón que el resto de
    // handlers de esta página: refrescar el listado y luego pedir el detalle
    // real del servidor, no confiar en un actualismo local.
    const handleEditComment = async (ticketId, commentId, text, startedEditingAt) => {
        const pending = editComment(ticketId, commentId, text, startedEditingAt);
        refreshTickets();
        await pending;
        refreshSelectedTicketOrClose(ticketId);
    };

    const handleDeleteComment = async (ticketId, commentId) => {
        const pending = deleteComment(ticketId, commentId);
        refreshTickets();
        await pending;
        refreshSelectedTicketOrClose(ticketId);
    };

    const handleUpdatePriority = async (ticketId, priority) => {
        const pending = updateTicket(ticketId, { priority });
        refreshTickets();
        await pending;
        if (selectedTicket?.id === ticketId) {
            refreshSelectedTicketOrClose(ticketId);
        }
    };

    if (selectedTicket) {
        return (
            <TicketDetailView
                ticket={selectedTicket}
                users={users}
                config={config}
                currentUser={currentUser}
                onBack={() => handleSelectTicket(null)}
                onUpdateStatus={handleUpdateStatus}
                onUpdatePriority={handleUpdatePriority}
                onUpdateAssignee={async (ticketId, assignee) => {
                    const pending = updateTicket(ticketId, { resolver_agent_id: assignee });
                    refreshTickets();
                    await pending;
                    refreshSelectedTicketOrClose(ticketId);
                }}
                onUpdateField={async (ticketId, updates) => {
                    // Antes esto no esperaba la escritura antes de refrescar (mismo bug ya
                    // corregido en handleAddComment el 2026-09-17, nunca aplicado aquí) — el
                    // fetch de detalle podía ganarle a la escritura y traer de vuelta la
                    // versión vieja, pisando el cambio recién hecho. Reportado en vivo
                    // 2026-09-18: la Etiqueta había que elegirla 2-3 veces para que se
                    // quedara, porque volvía a "Sin etiqueta" cada vez.
                    const pending = updateTicket(ticketId, updates);
                    refreshTickets();
                    await pending;
                    refreshSelectedTicketOrClose(ticketId);
                }}
                onEscalate={async (ticketId, groupId, agentId, transfersPropiedad, groupName, agentName) => {
                    const pending = escalateTicket(ticketId, groupId, agentId, transfersPropiedad, groupName, agentName);
                    refreshTickets();
                    await pending;
                    refreshSelectedTicketOrClose(ticketId);
                }}
                onAddComment={handleAddComment}
                onEditComment={handleEditComment}
                onDeleteComment={handleDeleteComment}
                onMarkAsRead={handleMarkAsRead}
            />
        );
    }

    // Campos base habilitados en el formulario de creación (configurables por admin)
    const enabledFormFields = getFormFields(activeWorkspace);

    // ─── Opciones de filtro reales, por workspace (nada hardcodeado/genérico) ───
    const statusFilterOptions = activeWorkspace === 'volcan_desk'
        ? INTERNAL_STATUSES.map(s => ({ value: s.id, label: s.label }))
        : [
            { value: 'new', label: 'Nuevo' },
            ...(config.statusCategories || []).flatMap(cat =>
                (config.subStatuses?.[cat.id] || []).map(sub => ({ value: sub.value, label: `${cat.label} · ${sub.label}` }))
            )
        ];
    const priorityFilterOptions = (config.priorities || []).map(p => ({ value: p.value, label: p.label }));
    const typeFilterOptions = (config.types || [])
        .filter(t => (t.modulo || 'voltik') === activeWorkspace)
        .map(t => ({ value: t.id, label: t.label }));
    const areaFilterOptions = getGroups()
        .filter(g => (g.modulo || 'voltik') === activeWorkspace)
        .map(g => ({ value: g.id, label: g.name }));

    // Tickets visibles por rol (sin filtros adicionales), para calcular badges de tabs con precisión
    const roleFilteredTickets = tickets.filter(t => {
        // Ámbito check (Workspace)
        if (activeWorkspace === 'volcan_desk') {
            if (t.ambito !== 'interno') return false;
        } else {
            if (t.ambito === 'interno') return false;
        }

        if (currentUser.role === 'admin') return true;
        if (currentUser.role === 'client') {
            return t.companyId === currentUser.companyId;
        }
        
        return true; // Agentes ven lo que el backend les envió (que ya está filtrado por seguridad)
    });

    // ─── Volcán Desk: pestañas de "mi relación con el ticket" (doc §3/§13) ───
    // "Todos" solo para roles de gestión, que no tienen un vínculo de pertenencia
    // a un grupo 1:1 como sí lo tiene un agente normal.
    const canSeeDeskAll = ['admin', 'group_admin'].includes(currentUser.role);
    // "Mis grupos": para group_admin es su único grupo administrado; para el resto,
    // los grupos de los que es miembro (sirven tanto para pedir como para resolver).
    // Para 'admin' (sin grupo propio) se usan TODOS los grupos de Volcán Desk —
    // antes un admin puro dependía de la pestaña "Todos" (que mezclaba ambos ejes)
    // para ver algo, porque "De mi grupo" siempre le salía vacío; al separar
    // Recibidas/Enviadas en páginas fijas por eje (2026-09-07, sin "Todos" en esta
    // fase) hacía falta un equivalente que sí respete el eje — tratar a admin como
    // "miembro de todos los grupos" logra exactamente eso sin abrir ningún acceso
    // nuevo (admin ya podía ver cualquier ticket de todas formas). También suma los
    // grupos de Acceso Especial (AreaAccesoExtra) — 2026-09-16. Antes este cálculo
    // vivía duplicado aquí Y en applyFilters() bajo un nombre distinto
    // (myGroupsForFilter), y solo este tenía el caso 'admin' — unificado en
    // getUserGroupsForScoping (ticketService.js), única fuente de verdad ahora.
    const myGroups = getUserGroupsForScoping(currentUser);
    // "Solicitudes de mi grupo" / "Atención de mi grupo" solo tienen sentido si el
    // usuario pertenece a algún grupo — un admin puro las tendría siempre vacías
    // (ya tiene "Todos", que las contiene por completo).
    const canSeeDeskGroupViews = myGroups.length > 0;

    // Jerarquía visual de 2 niveles (feedback del usuario, ago 2026): en vez de 4
    // pestañas técnicas al mismo nivel ("Mis solicitudes" / "Mi atención" /
    // "Solicitudes de mi grupo" / "Atención de mi grupo"), se separan en un eje
    // principal ("Solicitudes" vs "Atención") y un sub-nivel de alcance ("Mías" vs
    // "De mi grupo"). deskRoleView sigue siendo la única fuente de verdad (uno de
    // requester/attention/groupRequests/groupAttention/all) — deskAxis/deskScope
    // solo se derivan de él para pintar los dos niveles, y sus setters traducen el
    // click de vuelta a un valor válido de deskRoleView.
    const deskAxis = (deskRoleView === 'attention' || deskRoleView === 'groupAttention') ? 'atencion'
        : (deskRoleView === 'all') ? 'all'
        : 'solicitudes';
    const deskScope = (deskRoleView === 'groupRequests' || deskRoleView === 'groupAttention') ? 'grupo' : 'mias';
    const setDeskAxis = (axis) => {
        if (axis === 'all') { setDeskRoleView('all'); return; }
        const scope = deskScope === 'grupo' && canSeeDeskGroupViews ? 'grupo' : 'mias';
        setDeskRoleView(axis === 'solicitudes' ? (scope === 'grupo' ? 'groupRequests' : 'requester') : (scope === 'grupo' ? 'groupAttention' : 'attention'));
    };
    const setDeskScope = (scope) => {
        const axis = deskAxis === 'all' ? 'solicitudes' : deskAxis;
        setDeskRoleView(axis === 'solicitudes' ? (scope === 'grupo' ? 'groupRequests' : 'requester') : (scope === 'grupo' ? 'groupAttention' : 'attention'));
    };

    // Vista prioritaria: tickets nuevos (to_do) y sin responsable que le tocan al
    // grupo del usuario para atender — hoy sólo eran visibles entrando manualmente
    // a "Atención de mi grupo", lo que hacía fácil perderlos (doc feedback #1).
    // Se calcula sobre roleFilteredTickets (ya filtrado por permisos/ambito), sin
    // depender de qué pestaña esté activa en este momento.
    const deskPriorityTickets = activeWorkspace === 'volcan_desk'
        ? roleFilteredTickets.filter(t =>
            deskRoleViewMatch(t, currentUser.role === 'admin' ? 'all' : 'groupAttention', currentUser, myGroups)
            && t.status === 'to_do'
            && !t.assignedTo && !t.resolver_agent_id
          )
        : [];

    // Agentes elegibles para el filtro "Agente" — deben coincidir con quién puede
    // realmente terminar asignado a un ticket (misma regla que el dropdown
    // "Asignado A" de TicketDetailView.jsx): en Voltik, admin/agent; en Volcán
    // Desk, group_admin/agent (nunca admin general — nunca puede ser
    // asignado, pero antes SÍ aparecía en este filtro; y group_admin
    // SÍ puede ser asignado pero antes NO aparecía — reportado en vivo
    // 2026-09-07: "no salen todos los agentes del segmento").
    //
    // Acotado siempre a TU propio grupo (myGroups) — no al grupo resolutor/
    // solicitante de lo que se esté viendo en ese momento. Dos intentos
    // anteriores (2026-09-07) usaron los grupos de los tickets visibles
    // (solicitante+resolutor primero, luego solo resolutor), y ambos mezclaban
    // gente ajena a tu grupo en cuanto veías tickets de OTRO grupo — caso real:
    // en "Solicitudes Enviadas" de Javier (BI & Development) aparecían agentes
    // de los grupos que le RESUELVEN sus solicitudes (David/Guillermo/Jorge
    // Cano), no de su propio equipo. "Agente" siempre debe ser tú o tu propio
    // grupo, sin importar qué eje/página estés viendo — igual que ya hacía
    // (correctamente) el Área elegida a mano, que sigue teniendo prioridad
    // CUANDO esa área representa al grupo resolutor (Enviadas/Voltik). En
    // Recibidas el filtro "Área" pasó a significar el grupo SOLICITANTE
    // (2026-09-07) — esos ids ya no son grupos resolutores, así que buscar
    // agentes "de esa área" ahí ya no tiene sentido; se ignora y siempre se
    // usa tu propio grupo.
    const areaFilterIsResolverGroup = !(activeWorkspace === 'volcan_desk' && deskFixedAxis === 'atencion');
    const deskVisibleGroupIds = activeWorkspace === 'volcan_desk' ? new Set(myGroups) : null;
    const agents = users.filter(u => {
        const eligibleRole = activeWorkspace === 'volcan_desk'
            ? (u.role === 'group_admin' || u.role === 'agent')
            : (u.role === 'admin' || u.role === 'agent');
        if (!eligibleRole) return false;
        const belongsTo = (groupId) => u.role === 'group_admin' ? u.admin_group_id === groupId : (u.groups || []).includes(groupId);
        if (areaFilterIsResolverGroup && filters.group && filters.group.length > 0) {
            return filters.group.some(belongsTo);
        }
        if (deskVisibleGroupIds) {
            return [...deskVisibleGroupIds].some(belongsTo);
        }
        return (u.groups || []).some(groupId => {
            const groupObj = getGroups().find(g => g.id === groupId);
            return groupObj && (groupObj.modulo || 'voltik') === activeWorkspace;
        });
    });

    // ─── Exportar: solo admin general y group_admin ───────────────────────────
    // Vive acá (Solicitudes) y no en Reportes porque acá es donde realmente
    // están los filtros (pestaña, búsqueda, Filtros/drawer, Estado) que deben
    // servir como parámetros de exportación — "con filtros actuales" exporta
    // `filteredTickets` tal cual se ve en la tabla; "todo" exporta
    // `roleFilteredTickets`, el universo permitido antes de esos recortes
    // (sigue acotado por permisos/grupo, solo ignora pestaña/búsqueda/Filtros).
    const canExport = currentUser?.role === 'admin' || currentUser?.role === 'group_admin';
    const exportTickets = exportScope === 'all' ? roleFilteredTickets : filteredTickets;

    const resolveGroupName = (groupIdOrName) => {
        if (!groupIdOrName) return '';
        const g = getGroupById(groupIdOrName);
        return g ? g.name : groupIdOrName;
    };
    const resolveCatalogLabel = (list, idOrLabel) => {
        if (!idOrLabel) return '';
        const match = (list || []).find(x => x.id === idOrLabel);
        return match ? match.label : idOrLabel;
    };
    const slaLabelFor = (t) => {
        const sla = computeSlaStatus(t, config);
        if (sla.targetMinutes === null || (sla.isTerminated && sla.targetMinutes === -1)) return 'Sin SLA';
        if (sla.targetMinutes === 0) return 'Sin límite';
        const labels = { ok: 'En tiempo', warning: 'Próximo a vencer', breached: 'Vencido' };
        const targetHours = Math.round((sla.targetMinutes / 60) * 10) / 10;
        return `${labels[sla.status] || sla.status} (objetivo ${targetHours}h)`;
    };
    const userName = (id) => users.find(u => u.id === id)?.name || (id ? id : 'Sin asignar');

    // "Los datos que se suben en la creación de tickets" + fecha/hora de
    // creación separadas, Asignado A, fechas estimadas y SLA — CSV con
    // encabezados, separado por comas.
    const handleExportCSV = () => {
        const csvData = exportTickets.map(t => {
            const created = new Date(t.createdAt);
            return {
                Codigo: t.id,
                Asunto: t.title,
                'Grupo solicitante': resolveGroupName(t.area_origen_id),
                'Grupo resolutor': resolveGroupName(t.resolver_group_id || t.group),
                Tipo: resolveCatalogLabel(config.types, t.type),
                Producto: t.product || '',
                Categoria: resolveCatalogLabel(config.categories, t.category),
                Prioridad: resolvePriority(t.priority).label,
                Estado: resolveStatus(t.status).label,
                Solicitante: userName(t.createdBy),
                'Fecha de creacion': created.toLocaleDateString(),
                'Hora de creacion': created.toLocaleTimeString(),
                'Asignado A': t.assignedTo ? userName(t.assignedTo) : 'Sin asignar',
                'Fecha estimada de inicio': t.fecha_estimada_inicio || '',
                'Fecha estimada de conclusion': t.fecha_estimada_conclusion || '',
                'Estimacion HUs (horas)': t.estimacion_hus ?? '',
                'SLA Resolucion': slaLabelFor(t),
            };
        });
        exportToCSV(csvData, `solicitudes-${exportScope}-${Date.now()}.csv`);
    };

    // Columnas de tabla: antes cada una de las 4 vistas resaltaba una relación
    // distinta con el ticket y traía su propio set/orden de columnas (doc §14) —
    // a pedido del usuario (2026-08-27) todas las vistas de Volcán Desk usan ahora
    // la misma estructura que "Todos" (DESK_VIEW_COLUMN_PRESETS.all), para que
    // Solicitudes/Atención/Todos se vean consistentes entre sí. El resto de
    // DESK_VIEW_COLUMN_PRESETS queda sin usar — se deja documentado por si se
    // quiere volver a diferenciar por vista más adelante. El selector manual
    // "Columnas" solo aplica en Voltik.
    const deskEffectiveColumns = activeWorkspace === 'volcan_desk'
        ? DESK_VIEW_COLUMN_PRESETS.all
        : visibleColumns;
    const deskHeaderOverrides = activeWorkspace === 'volcan_desk'
        ? { group: 'Grupo resolutor', requester: 'Solicitante', assignedTo: 'Agente Resolutor' }
        : undefined;

    // Cronograma: visibilidad más estricta que Tabla/Tablero — el resolutor asignado
    // ve sus propios tickets, quien levanta el ticket ve los suyos, admin/group_admin
    // (ya acotado por grupo desde el backend) ve todo lo que ya llegó en filteredTickets.
    // Tabla, Tablero y Cronograma son solo "modos de visualización" del mismo
    // universo ya elegido con las pestañas + filtros — no deben tener su propia
    // regla de visibilidad aparte (doc "lógica de visualización" CA14). Antes esto
    // filtraba de nuevo por mi/asignado/creador, lo cual chocaba con vistas como
    // "Atención de mi grupo" (que debe mostrar tickets de todo el grupo, no solo
    // los míos).
    const cronogramaVisibleTickets = filteredTickets;

    // Contactos de la misma empresa del cliente (para el campo Colaborador)
    const companyContacts = users.filter(u =>
        u.companyId === currentUser.companyId && u.id !== currentUser.id
    );

    // ─── Formulario de creación en Volcán Desk: Tipo/Producto/Categoría/Prioridad
    // quedan acotados al Grupo elegido, para que cada grupo tenga su propio catálogo
    // sin mezclarse con el de otros grupos (Finanzas no ve los campos de BI, etc.) ───
    const isDeskCreate = activeWorkspace === 'volcan_desk';
    const createTypeOptions = (config.types || [])
        .filter(t => (t.modulo || 'voltik') === activeWorkspace)
        .filter(t => !isDeskCreate || t.grupoId === newTicket.group);
    const createProductOptions = (config.products || [])
        .filter(pr => (pr.modulo || 'voltik') === activeWorkspace)
        .filter(pr => !isDeskCreate || pr.grupoId === newTicket.group);
    const createCategoryOptions = (config.categories || [])
        .filter(c => (c.modulo || 'voltik') === activeWorkspace)
        .filter(c => !isDeskCreate || c.grupoId === newTicket.group)
        // Volcán Desk: cada Categoría está ligada a un único Tipo — no tiene caso
        // ofrecer categorías de otro Tipo (además su SLA sale de esa combinación).
        .filter(c => !isDeskCreate || !newTicket.type || c.tipoId === newTicket.type);
    const createPriorityOptions = (config.priorities || [])
        .filter(p => (p.modulo || 'voltik') === activeWorkspace)
        .filter(p => !isDeskCreate || p.grupoId === newTicket.group);

    return (
        <div className="tickets-layout">
            {/* Backdrop / Overlay background */}
            {showFilterPanel && (
                <div className="filter-overlay-backdrop" onClick={() => setShowFilterPanel(false)} />
            )}

            {/* ─── Filter Panel Drawer ─── */}
            {showFilterPanel && (
                <aside className="filter-panel-drawer">
                    <div className="filter-panel-header">
                        <div className="filter-panel-title-container">
                            <span className="filter-panel-title">Filtros</span>
                            <span className="filter-panel-subtitle">Refina tu búsqueda</span>
                        </div>
                        <div className="filter-panel-actions">
                            {activeFilterCount > 0 && (
                                <button className="filter-reset-btn" onClick={resetFilters}>
                                    RESET ALL
                                </button>
                            )}
                            <button className="filter-close-btn" onClick={() => setShowFilterPanel(false)}>
                                <IoCloseOutline size={20} />
                            </button>
                        </div>
                    </div>

                    <div className="filter-panel-body">
                        {/* 2-column Grid style matching Bin Manager */}
                        <div className="filter-grid">
                            {/* Desde Date picker */}
                            <div className="filter-field">
                                <label className="filter-label">DESDE</label>
                                <input
                                    type="date"
                                    className="filter-select"
                                    value={filters.dateFrom}
                                    max={filters.dateTo || undefined}
                                    onChange={e => setFilter('dateFrom', e.target.value)}
                                />
                            </div>

                            {/* Hasta Date picker */}
                            <div className="filter-field">
                                <label className="filter-label">HASTA</label>
                                <input
                                    type="date"
                                    className="filter-select"
                                    value={filters.dateTo}
                                    min={filters.dateFrom || undefined}
                                    onChange={e => setFilter('dateTo', e.target.value)}
                                />
                            </div>

                            {/* Estado Multiselect */}
                            <Multiselect
                                label="ESTADO"
                                options={statusFilterOptions}
                                selected={filters.status}
                                onChange={vals => setFilter('status', vals)}
                            />

                            {/* Prioridad Multiselect */}
                            <Multiselect
                                label="PRIORIDAD"
                                options={priorityFilterOptions}
                                selected={filters.priority}
                                onChange={vals => setFilter('priority', vals)}
                            />

                            {/* Área/Grupo Multiselect — la etiqueta aclara qué dimensión se está
                                filtrando (2026-09-07): en Recibidas el resolutor eres siempre tú/tu
                                grupo, así que lo que varía es quién solicitó; en Enviadas es al revés. */}
                            <Multiselect
                                label={activeWorkspace === 'volcan_desk' && deskFixedAxis === 'atencion' ? 'ÁREA SOLICITANTE' : activeWorkspace === 'volcan_desk' && deskFixedAxis === 'solicitudes' ? 'ÁREA DESTINO' : 'ÁREA'}
                                options={areaFilterOptions}
                                selected={filters.group}
                                onChange={vals => setFilter('group', vals)}
                            />

                            {/* Agente Multiselect — se acota según el Área seleccionada */}
                            <Multiselect
                                label="AGENTE"
                                options={agents.map(a => ({ value: a.id, label: a.name }))}
                                selected={filters.assignedTo}
                                onChange={vals => setFilter('assignedTo', vals)}
                            />

                            {/* Tipo Multiselect */}
                            <Multiselect
                                label="TIPO"
                                options={typeFilterOptions}
                                selected={filters.type}
                                onChange={vals => setFilter('type', vals)}
                            />

                            {/* Empresa Multiselect — solo aplica a Voltik (clientes externos) */}
                            {activeWorkspace !== 'volcan_desk' && (
                                <Multiselect
                                    label="EMPRESA"
                                    options={companies.map(c => ({ value: c.id, label: c.name }))}
                                    selected={filters.companyId}
                                    onChange={vals => setFilter('companyId', vals)}
                                />
                            )}

                            {/* Asignación — antes era un checkbox "Sin asignar"; ahora es un
                                criterio de 3 posiciones, separado de la relación con el ticket
                                (que ahora vive en las pestañas Mis solicitudes/Mi atención).
                                Mismo control (select) que Estado/Prioridad/Área/etc. para que
                                el panel se vea uniforme. */}
                            <div className="filter-field">
                                <label className="filter-label">ASIGNACIÓN</label>
                                <select className="filter-select" value={filters.assignment} onChange={e => setFilter('assignment', e.target.value)}>
                                    <option value="all">Todos</option>
                                    <option value="assigned">Asignados</option>
                                    <option value="unassigned">Sin asignar</option>
                                </select>
                            </div>

                            {/* SLA — condición de cumplimiento, criterio propio (no una pestaña). */}
                            <div className="filter-field">
                                <label className="filter-label">SLA</label>
                                <select className="filter-select" value={filters.sla} onChange={e => setFilter('sla', e.target.value)}>
                                    <option value="all">Todos</option>
                                    <option value="ontime">En tiempo</option>
                                    <option value="warning">Por vencer</option>
                                    <option value="breached">Vencido</option>
                                </select>
                            </div>

                            {/* Bloqueado Checkbox — solo aplica a Volcán Desk, siempre al final */}
                            {activeWorkspace === 'volcan_desk' && (
                                <div style={{ display: 'flex', alignItems: 'center', gridColumn: 'span 1' }}>
                                    <label className="filter-checkbox" style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#475569', cursor: 'pointer', fontWeight: 500, marginTop: '22px' }}>
                                        <input type="checkbox" checked={filters.bloqueado} onChange={e => setFilter('bloqueado', e.target.checked)} />
                                        <span>Bloqueados</span>
                                    </label>
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="filter-apply-footer">
                        <button className="filter-apply-btn" onClick={() => setShowFilterPanel(false)}>
                            APLICAR FILTROS
                        </button>
                    </div>
                </aside>
            )}

            {/* ─── Main Content ─── */}
            <div className="tickets-main">
                {saveErrorBanner && (
                    <div style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        marginBottom: 12, padding: '10px 14px',
                        background: 'rgba(239, 68, 68, 0.08)',
                        border: '1px solid var(--color-error)',
                        borderRadius: 'var(--radius-md)',
                        color: 'var(--color-error)', fontSize: '0.85rem', fontWeight: 500
                    }}>
                        <span style={{ flex: 1 }}>{saveErrorBanner}</span>
                        <button
                            type="button"
                            onClick={() => setSaveErrorBanner('')}
                            style={{ background: 'none', border: 'none', color: 'var(--color-error)', cursor: 'pointer' }}
                        >
                            <IoCloseOutline size={16} />
                        </button>
                    </div>
                )}
                {/* Header */}
                <div className="tickets-header">
                    <div className="tickets-title-block">
                        <h1>
                            {deskFixedAxis === 'atencion' ? 'Solicitudes Recibidas'
                                : deskFixedAxis === 'solicitudes' ? 'Solicitudes Enviadas'
                                : activeWorkspace === 'volcan_desk' ? 'Solicitudes' : 'Bandeja de tickets'}
                        </h1>
                        <p>
                            {deskFixedAxis === 'atencion' ? 'Tickets y requerimientos asignados a tu grupo de resolución para atender.'
                                : deskFixedAxis === 'solicitudes' ? 'Requerimientos que tú o tu grupo han emitido a otros departamentos.'
                                : activeWorkspace === 'volcan_desk' ? 'Gestiona tus solicitudes y los tickets que tu grupo debe atender.' : 'Prioriza, asigna y da seguimiento desde un solo lugar.'}
                        </p>
                    </div>
                    <div className="visible-count"><strong>{filteredTickets.length}</strong><span>{activeWorkspace === 'volcan_desk' ? 'solicitudes visibles' : 'tickets visibles'}</span></div>
                </div>

                {/* Search bar */}
                <div className="proposal-toolbar-card"><div className="tickets-search-bar">
                    <div className="search-box">
                        <IoSearchOutline className="search-icon" />
                        <input
                            type="text"
                            placeholder={activeWorkspace === 'volcan_desk' ? 'Buscar por código, asunto o grupo solicitante' : 'Buscar por ID, asunto o cliente'}
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                        />
                        {searchTerm && (
                            <button
                                className="search-clear"
                                onClick={() => setSearchTerm('')}
                            >
                                <IoCloseOutline size={14}/>
                            </button>
                        )}
                    </div>
                    <button className={`proposal-filter-button ${showFilterPanel ? 'active' : ''}`} onClick={() => setShowFilterPanel(p => !p)}><IoFilterOutline size={15}/>Filtros{activeFilterCount > 0 && <span>{activeFilterCount}</span>}</button>

                    {/* Toggle Tabla / Tablero — exclusivo de Volcán Desk */}
                    {activeWorkspace === 'volcan_desk' && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                            <div className="view-segmented">
                                <button
                                    type="button"
                                    className={`view-segmented-btn ${viewMode === 'table' ? 'active' : ''}`}
                                    onClick={() => setViewMode('table')}
                                >
                                    <IoListOutline size={15} /> Tabla
                                </button>
                                <button
                                    type="button"
                                    className={`view-segmented-btn ${viewMode === 'board' ? 'active' : ''}`}
                                    onClick={() => setViewMode('board')}
                                >
                                    <IoGridOutline size={15} /> Tablero
                                </button>
                                <button
                                    type="button"
                                    className={`view-segmented-btn ${viewMode === 'gantt' ? 'active' : ''}`}
                                    onClick={() => setViewMode('gantt')}
                                >
                                    <IoCalendarOutline size={15} /> Cronograma
                                </button>
                            </div>
                            {viewMode === 'board' && (
                                <select
                                    value={groupBy}
                                    onChange={e => setGroupBy(e.target.value)}
                                    className="proposal-filter-button"
                                    style={{ cursor: 'pointer' }}
                                >
                                    <option value="status">Agrupar por: Estado</option>
                                    <option value="area">Agrupar por: {deskFixedAxis === 'atencion' ? 'Área solicitante' : 'Área destino'}</option>
                                    <option value="priority">Agrupar por: Prioridad</option>
                                    <option value="assignee">Agrupar por: Asignado</option>
                                </select>
                            )}
                            {/* Orden por defecto (urgencia: SLA > prioridad > actividad) hacía que un
                                ticket recién creado apareciera hasta abajo si había otros ya vencidos —
                                reportado como poco intuitivo. Esta es la alternativa "más nuevo arriba",
                                sin reemplazar el orden por urgencia que sigue siendo el default. */}
                            {viewMode === 'table' && (
                                <select
                                    value={sortMode}
                                    onChange={e => setSortMode(e.target.value)}
                                    className="proposal-filter-button"
                                    style={{ cursor: 'pointer' }}
                                >
                                    <option value="urgency">Ordenar por: Urgencia</option>
                                    <option value="date">Ordenar por: Fecha de creación</option>
                                </select>
                            )}
                        </div>
                    )}

                    {/* Columns Selector Dropdown — solo Voltik: en Volcán Desk cada una de las
                        4 vistas trae su propio set de columnas por diseño (doc §14), así que
                        un selector manual aparte ya no aplica. */}
                    {activeWorkspace !== 'volcan_desk' && (
                        <div className="column-select-dropdown-container" style={{ position: 'relative' }}>
                            <button
                                className={`proposal-filter-button ${showColumnDropdown ? 'active' : ''}`}
                                onClick={() => setShowColumnDropdown(p => !p)}
                            >
                                <IoListOutline size={15}/>Columnas
                            </button>
                            {showColumnDropdown && (
                                <>
                                    <div className="column-dropdown-backdrop" onClick={() => setShowColumnDropdown(false)} style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100 }} />
                                    <div className="column-dropdown-panel" style={{ position: 'absolute', right: 0, top: '48px', background: '#ffffff', border: '1px solid #dfe5ee', borderRadius: '8px', padding: '12px', boxShadow: '0 8px 24px rgba(15,23,42,0.08)', zIndex: 101, display: 'flex', flexDirection: 'column', gap: '8px', minWidth: '160px' }}>
                                        <span style={{ fontSize: '11px', fontWeight: '700', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>Mostrar columnas</span>
                                        {ALL_COLUMNS.map(col => (
                                            <label key={col.key} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#334155', cursor: 'pointer' }}>
                                                <input
                                                    type="checkbox"
                                                    checked={visibleColumns.includes(col.key)}
                                                    onChange={() => {
                                                        setVisibleColumns(prev => {
                                                            if (prev.includes(col.key)) {
                                                                if (prev.length <= 1) return prev;
                                                                return prev.filter(k => k !== col.key);
                                                            } else {
                                                                return ALL_COLUMNS.map(c => c.key).filter(k => k === col.key || prev.includes(k));
                                                            }
                                                        });
                                                    }}
                                                />
                                                <span>{col.label}</span>
                                            </label>
                                        ))}
                                    </div>
                                </>
                            )}
                        </div>
                    )}

                    {canExport && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
                            <select
                                value={exportScope}
                                onChange={e => setExportScope(e.target.value)}
                                className="proposal-filter-button"
                                style={{ cursor: 'pointer' }}
                                aria-label="Alcance de exportación"
                            >
                                <option value="filtered">Exportar: con filtros actuales</option>
                                <option value="all">Exportar: todo</option>
                            </select>
                            {/* Un solo botón, CSV (comas + encabezados, se abre directo en
                                Excel) — se quitó el botón JSON aparte porque nadie lo pidió y
                                sumaba un control más a una fila que ya iba justa de espacio;
                                con dos botones casi idénticos uno quedaba tapado por "Nueva
                                solicitud" y un usuario no técnico no sabía cuál tocar. */}
                            <button type="button" className="proposal-filter-button" onClick={handleExportCSV}>
                                <IoDownloadOutline size={15} /> Exportar CSV
                            </button>
                        </div>
                    )}

                    {/* Crear una solicitud es, por definición, un acto de "enviar" — no tiene
                        sentido en "Solicitudes Recibidas" (2026-09-07). */}
                    {deskFixedAxis !== 'atencion' && (
                        <button
                            className="header-new-ticket"
                            onClick={() => setShowCreateModal(true)}
                            style={{ marginLeft: canExport ? 0 : 'auto', background: '#1267e8', display: 'flex', alignItems: 'center', gap: '6px', height: '40px', padding: '0 18px', border: '0', borderRadius: '8px', color: '#fff', fontWeight: '700', fontSize: '13px', cursor: 'pointer' }}
                        >
                            <IoAddOutline size={17}/>{activeWorkspace === 'volcan_desk' ? 'Nueva solicitud' : 'Nuevo ticket'}
                        </button>
                    )}

                    {activeFilterCount > 0 && (
                        <div className="active-filters-chips">
                            {filters.status && filters.status.length > 0 && <span className="active-chip">Estado ({filters.status.length}) <button onClick={() => setFilter('status',[])}>×</button></span>}
                            {filters.priority && filters.priority.length > 0 && <span className="active-chip">Prioridad ({filters.priority.length}) <button onClick={() => setFilter('priority',[])}>×</button></span>}
                            {filters.type && filters.type.length > 0 && <span className="active-chip">Tipo ({filters.type.length}) <button onClick={() => setFilter('type',[])}>×</button></span>}
                            {filters.group && filters.group.length > 0 && <span className="active-chip">{activeWorkspace === 'volcan_desk' && deskFixedAxis === 'atencion' ? 'Área solicitante' : activeWorkspace === 'volcan_desk' && deskFixedAxis === 'solicitudes' ? 'Área destino' : 'Área'} ({filters.group.length}) <button onClick={() => setFilter('group',[])}>×</button></span>}
                            {activeWorkspace !== 'volcan_desk' && filters.companyId && filters.companyId.length > 0 && <span className="active-chip">Empresa ({filters.companyId.length}) <button onClick={() => setFilter('companyId',[])}>×</button></span>}
                            {filters.assignedTo && filters.assignedTo.length > 0 && <span className="active-chip">Agente ({filters.assignedTo.length}) <button onClick={() => setFilter('assignedTo',[])}>×</button></span>}
                            {filters.assignment !== 'all' && <span className="active-chip">{filters.assignment === 'unassigned' ? 'Sin asignar' : 'Asignados'} <button onClick={() => setFilter('assignment', 'all')}>×</button></span>}
                            {filters.sla !== 'all' && <span className="active-chip">SLA: {{ ontime: 'En tiempo', warning: 'Por vencer', breached: 'Vencido' }[filters.sla]} <button onClick={() => setFilter('sla', 'all')}>×</button></span>}
                            {filters.bloqueado && <span className="active-chip">Bloqueados <button onClick={() => setFilter('bloqueado', false)}>×</button></span>}
                            {(filters.dateFrom || filters.dateTo) && <span className="active-chip">Fecha: {filters.dateFrom || '∞'} → {filters.dateTo || '∞'} <button onClick={() => { setFilter('dateFrom',''); setFilter('dateTo',''); }}>×</button></span>}
                        </div>
                    )}
                </div></div>

                {activeWorkspace === 'volcan_desk' ? (
                    <>
                        {/* Vista prioritaria: nuevas sin asignar — antes sólo se veían entrando
                            manualmente a "Atención de mi grupo"; ahora se avisan de entrada. Solo
                            aplica del lado de Atención/Recibidas — en Enviadas no hay nada que
                            "atender" (2026-09-07). */}
                        {deskPriorityTickets.length > 0 && deskFixedAxis !== 'solicitudes' && (
                            <div
                                className="desk-priority-banner"
                                style={{
                                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                    background: '#fff7ed', border: '1px solid #fdba74', borderRadius: 8,
                                    padding: '8px 14px', margin: '0 0 10px', cursor: 'pointer'
                                }}
                                onClick={() => {
                                    if (deskFixedAxis === 'atencion') {
                                        setDeskScope('grupo');
                                    } else {
                                        setDeskRoleView(canSeeDeskAll ? 'all' : 'groupAttention');
                                    }
                                    setDeskEstadoView('pending');
                                    setFilter('assignment', 'unassigned');
                                }}
                            >
                                <span style={{ fontSize: '13px', color: '#9a3412', fontWeight: 600 }}>
                                    {deskPriorityTickets.length} solicitud{deskPriorityTickets.length !== 1 ? 'es' : ''} nueva{deskPriorityTickets.length !== 1 ? 's' : ''} sin asignar {canSeeDeskAll ? '' : 'en tu grupo'}
                                </span>
                                <span style={{ fontSize: '12px', color: '#9a3412', textDecoration: 'underline' }}>Ver ahora →</span>
                            </div>
                        )}
                        {/* Nivel 1: eje principal — ¿estoy viendo lo que pedí o lo que atiendo?
                            Ya no aplica cuando el eje viene fijo por página (Recibidas/Enviadas,
                            2026-09-07) — la página misma ya lo deja claro. */}
                        {!deskFixedAxis && (
                            <div className="proposal-quick-tabs desk-role-tabs desk-axis-tabs">
                                <button className={deskAxis === 'solicitudes' ? 'active' : ''} onClick={() => setDeskAxis('solicitudes')}>Solicitudes <b>{roleFilteredTickets.filter(t => deskAxisMatch(t, 'solicitudes', currentUser, myGroups)).length}</b></button>
                                <button className={deskAxis === 'atencion' ? 'active' : ''} onClick={() => setDeskAxis('atencion')}>Atención <b>{roleFilteredTickets.filter(t => deskAxisMatch(t, 'atencion', currentUser, myGroups)).length}</b></button>
                                {canSeeDeskAll && (
                                    <button className={deskAxis === 'all' ? 'active' : ''} onClick={() => setDeskAxis('all')}>Todos <b>{roleFilteredTickets.length}</b></button>
                                )}
                            </div>
                        )}
                        {/* Nivel 2: alcance — ¿lo mío o lo de todo mi grupo? Solo aplica dentro de
                            un eje (no tiene sentido cuando el eje es "Todos"). */}
                        {deskAxis !== 'all' && (
                            <div className="desk-scope-tabs">
                                <button className={deskScope === 'mias' ? 'active' : ''} onClick={() => setDeskScope('mias')}>
                                    Mías <b>{roleFilteredTickets.filter(t => deskRoleViewMatch(t, deskAxis === 'solicitudes' ? 'requester' : 'attention', currentUser, myGroups)).length}</b>
                                </button>
                                {canSeeDeskGroupViews && (
                                    <button className={deskScope === 'grupo' ? 'active' : ''} onClick={() => setDeskScope('grupo')}>
                                        De mi grupo <b>{roleFilteredTickets.filter(t => deskRoleViewMatch(t, deskAxis === 'solicitudes' ? 'groupRequests' : 'groupAttention', currentUser, myGroups)).length}</b>
                                    </button>
                                )}
                            </div>
                        )}
                        {/* Subtítulo dinámico: la combinación eje+alcance en una frase inequívoca,
                            en vez de depender de que 4 etiquetas técnicas se lean todas a la vez. */}
                        {deskAxis !== 'all' && DESK_VIEW_DESCRIPTIONS[`${deskAxis}:${deskScope}`] && (
                            <p className="desk-view-subtitle">
                                <strong>{DESK_VIEW_DESCRIPTIONS[`${deskAxis}:${deskScope}`].title}.</strong> {DESK_VIEW_DESCRIPTIONS[`${deskAxis}:${deskScope}`].desc}
                            </p>
                        )}
                    </>
                ) : (
                    <div className="proposal-quick-tabs">
                        <button className={quickView === 'all' ? 'active' : ''} onClick={() => setQuickView('all')}>Todos <b>{roleFilteredTickets.length}</b></button>
                        {currentUser.role !== 'client' && (
                            <button className={quickView === 'requester' ? 'active' : ''} onClick={() => setQuickView('requester')}>Mis solicitudes <b>{roleFilteredTickets.filter(t => t.createdBy === currentUser.id).length}</b></button>
                        )}
                        {currentUser.role === 'client' ? (
                            <button className={quickView === 'requester' ? 'active' : ''} onClick={() => setQuickView('requester')}>Mis tickets <b>{roleFilteredTickets.filter(t => t.contactId === currentUser.id || t.createdBy === currentUser.id).length}</b></button>
                        ) : (
                            <button className={quickView === 'attention' ? 'active' : ''} onClick={() => setQuickView('attention')}>Atención <b>{roleFilteredTickets.filter(t => t.assignedTo === currentUser.id || t.resolver_agent_id === currentUser.id).length}</b></button>
                        )}
                        <button className={quickView === 'active' ? 'active' : ''} onClick={() => setQuickView('active')}>En proceso <b>{roleFilteredTickets.filter(t => !isTerminalStatus(t.status)).length}</b></button>
                        <button className={quickView === 'done' ? 'active' : ''} onClick={() => setQuickView('done')}>Terminado <b>{roleFilteredTickets.filter(t => isTerminalStatus(t.status)).length}</b></button>
                        <button className={quickView === 'unassigned' ? 'active' : ''} onClick={() => setQuickView('unassigned')}>Sin asignar <b>{roleFilteredTickets.filter(t => !t.assignedTo && !t.resolver_agent_id).length}</b></button>
                        <button className={quickView === 'warning' ? 'active' : ''} onClick={() => setQuickView('warning')}>Por vencer <b>{roleFilteredTickets.filter(t => !isTerminalStatus(t.status) && computeSlaStatus(t, config).status === 'warning').length}</b></button>
                        <button className={quickView === 'breached' ? 'active' : ''} onClick={() => setQuickView('breached')}>Vencidos <b>{roleFilteredTickets.filter(t => !isTerminalStatus(t.status) && computeSlaStatus(t, config).status === 'breached').length}</b></button>
                        <button className={quickView === 'waiting' ? 'active' : ''} onClick={() => setQuickView('waiting')}>Esperando respuesta <b>{roleFilteredTickets.filter(t => !isTerminalStatus(t.status) && (currentUser.role === 'client' ? (t.ultimo_mensaje_de === 'agente' && !t.visto_por_cliente) : (t.ultimo_mensaje_de === 'cliente' && !t.visto_por_agente))).length}</b></button>
                    </div>
                )}

                {/* Table / Board / Cronograma (Tablero y Cronograma solo en Volcán Desk) */}
                {/* El div extra es intencional: aísla el scroll horizontal propio del
                    tablero de una regla CSS heredada (.tickets-main > div:last-child)
                    que fuerza overflow:hidden en el hijo directo — sin este nivel extra
                    esa regla se lo come y el tablero desborda sin scrollbar. */}
                {activeWorkspace === 'volcan_desk' && viewMode === 'board' ? (
                    <div className="kanban-view-wrapper" style={{ minWidth: 0, width: '100%' }}>
                        <KanbanBoard
                            tickets={filteredTickets}
                            users={users}
                            config={config}
                            groupBy={groupBy}
                            areaAxis={deskFixedAxis === 'atencion' ? 'origen' : 'resolutor'}
                            onUpdateStatus={handleUpdateStatus}
                            onTicketClick={handleSelectTicket}
                        />
                    </div>
                ) : activeWorkspace === 'volcan_desk' && viewMode === 'gantt' ? (
                    <div className="kanban-view-wrapper" style={{ minWidth: 0, width: '100%' }}>
                        <CronogramaView
                            tickets={cronogramaVisibleTickets}
                            config={config}
                            onTicketClick={handleSelectTicket}
                        />
                    </div>
                ) : (
                    // Mismo workaround que kanban-view-wrapper arriba: sin este div con
                    // minWidth:0/width:100% en estilo INLINE (gana cualquier duda de cascada
                    // CSS), el intento anterior de scroll horizontal seguía sin verse en
                    // pantallas normales (reportado en vivo 2026-09-07, dos veces).
                    <div style={{ minWidth: 0, width: '100%' }}>
                        <ErrorBoundary><TicketTable
                            tickets={filteredTickets}
                            config={config}
                            onTicketClick={handleSelectTicket}
                            visibleColumns={deskEffectiveColumns}
                            headerOverrides={deskHeaderOverrides}
                            currentUser={currentUser}
                            isDesk={activeWorkspace === 'volcan_desk'}
                            sortMode={sortMode}
                            deskFixedAxis={deskFixedAxis}
                        /></ErrorBoundary>
                    </div>
                )}
            </div>

            {/* ─── Create Ticket Modal ─── */}
            <Modal
                isOpen={showCreateModal}
                onClose={() => setShowCreateModal(false)}
                title={activeWorkspace === 'volcan_desk' ? 'Crear Nueva Solicitud' : 'Crear Nuevo Ticket'}
                closeOnBackdropClick={false}
            >
                <form onSubmit={handleCreateTicket}>
                    {/* Contacto */}
                    {activeWorkspace !== 'volcan_desk' && (
                        <div className="input-group">
                            <label>Contacto *</label>
                            {isInternalUser ? (
                                <ContactAutocomplete
                                    users={users}
                                    value={newTicketContact?.id}
                                    onChange={setNewTicketContact}
                                    placeholder="Busca por nombre o correo..."
                                />
                            ) : (
                                <div style={{
                                    display: 'flex', alignItems: 'center', gap: 8,
                                    padding: '8px 12px',
                                    background: 'var(--color-bg-tertiary)',
                                    border: '1px solid var(--glass-border)',
                                    borderRadius: 'var(--radius-md)',
                                    opacity: 0.8,
                                    fontSize: '0.875rem',
                                    color: 'var(--color-text-secondary)',
                                    cursor: 'not-allowed'
                                }}>
                                    <div style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--color-primary)', color:'#fff', fontWeight: 700, fontSize: '0.7rem', display:'flex', alignItems:'center', justifyContent:'center'}}>
                                        {currentUser.name.substring(0,2).toUpperCase()}
                                    </div>
                                    <div>
                                        <div style={{fontWeight:600, color:'var(--color-text-primary)'}}>{currentUser.name}</div>
                                        <div style={{fontSize:'0.75rem', color:'var(--color-text-muted)'}}>{currentUser.email}</div>
                                    </div>
                                    <span style={{marginLeft:'auto', fontSize:'0.7rem', color:'var(--color-text-muted)', background:'var(--color-bg-secondary)', padding:'2px 8px', borderRadius:10}}>tú</span>
                                </div>
                            )}
                        </div>
                    )}


                    {/* Asunto */}
                    <div className="input-group">
                        <label>Asunto *</label>
                        <input
                            type="text"
                            required
                            placeholder="Describe el problema brevemente"
                            value={newTicket.subject}
                            onChange={e => setNewTicket(p => ({ ...p, subject: e.target.value }))}
                        />
                    </div>

                    {isDeskCreate ? (
                        <>
                            {/* Volcán Desk: Grupo primero — es el que habilita Tipo/Producto/Categoría */}
                            {(enabledFormFields.includes('producto') || enabledFormFields.includes('grupo')) && (
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                                    {enabledFormFields.includes('grupo') && (
                                        <div className="input-group">
                                            <label>Grupo *</label>
                                            <select
                                                value={newTicket.group}
                                                onChange={e => {
                                                    const newGroupId = e.target.value;
                                                    // La prioridad siempre nace en "Baja" para el grupo elegido — el
                                                    // usuario la puede subir después si aplica.
                                                    const groupPriorities = (config.priorities || [])
                                                        .filter(pr => (pr.modulo || 'voltik') === 'volcan_desk' && pr.grupoId === newGroupId);
                                                    const bajaPriority = groupPriorities.find(pr => /baja/i.test(pr.label)) || groupPriorities[groupPriorities.length - 1];
                                                    setNewTicket(p => ({ ...p, group: newGroupId, type: '', product: '', category: '', priority: bajaPriority?.value || '' }));
                                                }}
                                            >
                                                <option value="">-- Seleccionar --</option>
                                                {getGroups().filter(g => (g.modulo || 'voltik') === activeWorkspace).map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                                            </select>
                                            {!newTicket.group && (
                                                <small className="form-help">Elige primero el grupo destino: Tipo, Producto y Categoría dependen de él.</small>
                                            )}
                                        </div>
                                    )}
                                    {enabledFormFields.includes('producto') && (
                                        <div className="input-group">
                                            <label>Producto *</label>
                                            <select value={newTicket.product || ''} disabled={!newTicket.group} onChange={e => setNewTicket(p => ({ ...p, product: e.target.value }))}>
                                                <option value="">-- Seleccionar --</option>
                                                {createProductOptions.map(pr => <option key={pr.id} value={pr.label}>{pr.label}</option>)}
                                            </select>
                                        </div>
                                    )}
                                </div>
                            )}
                            {(enabledFormFields.includes('tipo') || enabledFormFields.includes('categoria')) && (
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                                    {enabledFormFields.includes('tipo') && (
                                        <div className="input-group">
                                            <label>Tipo *</label>
                                            <select
                                                value={newTicket.type}
                                                disabled={!newTicket.group}
                                                onChange={e => setNewTicket(p => ({ ...p, type: e.target.value, category: '' }))}
                                            >
                                                <option value="">-- Seleccionar --</option>
                                                {createTypeOptions.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                                            </select>
                                        </div>
                                    )}
                                    {enabledFormFields.includes('categoria') && (
                                        <div className="input-group">
                                            <label>Categoría *</label>
                                            <select value={newTicket.category} disabled={!newTicket.type} onChange={e => setNewTicket(p => ({ ...p, category: e.target.value }))}>
                                                <option value="">-- Seleccionar --</option>
                                                {createCategoryOptions.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                                            </select>
                                            {newTicket.type && !newTicket.category && createCategoryOptions.length === 0 && (
                                                <small className="form-help">Este Tipo aún no tiene categorías configuradas.</small>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}
                        </>
                    ) : (
                        <>
                            {/* Tipo + Producto */}
                            {(enabledFormFields.includes('tipo') || enabledFormFields.includes('producto')) && (
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                                    {enabledFormFields.includes('tipo') && (
                                        <div className="input-group">
                                            <label>Tipo</label>
                                            <select value={newTicket.type} onChange={e => setNewTicket(p => ({ ...p, type: e.target.value }))}>
                                                <option value="">-- Seleccionar --</option>
                                                {createTypeOptions.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                                            </select>
                                        </div>
                                    )}
                                    {enabledFormFields.includes('producto') && (
                                        <div className="input-group">
                                            <label>Producto</label>
                                            <select value={newTicket.product || ''} onChange={e => setNewTicket(p => ({ ...p, product: e.target.value }))}>
                                                <option value="">-- Seleccionar --</option>
                                                {createProductOptions.map(pr => <option key={pr.id} value={pr.label}>{pr.label}</option>)}
                                            </select>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Grupo + Categoría */}
                            {(enabledFormFields.includes('grupo') || enabledFormFields.includes('categoria')) && (
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                                    {enabledFormFields.includes('grupo') && (
                                        <div className="input-group">
                                            <label>Grupo</label>
                                            <select value={newTicket.group} onChange={e => setNewTicket(p => ({ ...p, group: e.target.value }))}>
                                                <option value="">-- Seleccionar --</option>
                                                {getGroups().filter(g => (g.modulo || 'voltik') === activeWorkspace).map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                                            </select>
                                        </div>
                                    )}
                                    {enabledFormFields.includes('categoria') && (
                                        <div className="input-group">
                                            <label>Categoría</label>
                                            <select value={newTicket.category} onChange={e => setNewTicket(p => ({ ...p, category: e.target.value }))}>
                                                <option value="">-- Seleccionar --</option>
                                                {createCategoryOptions.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                                            </select>
                                        </div>
                                    )}
                                </div>
                            )}
                        </>
                    )}

                    {activeWorkspace === 'volcan_desk' && (
                        <div style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)', marginBottom: 16, marginTop: -4 }}>
                            Sin asignar por default — cualquier miembro del grupo destino puede tomar la solicitud.
                        </div>
                    )}

                    {/* Agente + Prioridad */}
                    {(() => {
                        const showAgente = activeWorkspace !== 'volcan_desk' && enabledFormFields.includes('agente');
                        const showPrioridad = enabledFormFields.includes('prioridad');
                        if (!showAgente && !showPrioridad) return null;
                        return (
                            <div style={{ display: 'grid', gridTemplateColumns: (showAgente && showPrioridad) ? '1fr 1fr' : '1fr', gap: 16 }}>
                                {showAgente && (
                                    <div className="input-group">
                                        <label>{isInternalUser ? 'Agente' : 'Colaborador'}</label>
                                        {isInternalUser ? (
                                            <select
                                                value={newTicket.assignedTo || currentUser.id}
                                                onChange={e => setNewTicket(p => ({ ...p, assignedTo: e.target.value || null }))}
                                            >
                                                <option value={currentUser.id}>{currentUser.name} (yo)</option>
                                                {agents.filter(a => a.id !== currentUser.id).map(u => (
                                                    <option key={u.id} value={u.id}>{u.name}</option>
                                                ))}
                                                <option value="">Sin asignar</option>
                                            </select>
                                        ) : (
                                            <select
                                                value={newTicket.assignedTo || ''}
                                                onChange={e => setNewTicket(p => ({ ...p, assignedTo: e.target.value || null }))}
                                            >
                                                <option value="">-- Sin colaborador --</option>
                                                {companyContacts.map(c => (
                                                    <option key={c.id} value={c.id}>{c.name}</option>
                                                ))}
                                            </select>
                                        )}
                                    </div>
                                )}
                                {showPrioridad && (
                                    <div className="input-group">
                                        <label>Prioridad</label>
                                        <select value={newTicket.priority} disabled={isDeskCreate && !newTicket.group} onChange={e => setNewTicket(p => ({ ...p, priority: e.target.value }))}>
                                            {(isDeskCreate ? createPriorityOptions : (config.priorities || [])).map(p => <option key={p.id} value={p.value}>{p.label}</option>)}
                                        </select>
                                    </div>
                                )}
                            </div>
                        );
                    })()}

                    {/* Estado (read-only: siempre el estado inicial del módulo) — en Volcán Desk
                        siempre es "Pendiente" y no aporta nada mostrarlo en el formulario. */}
                    {!isDeskCreate && (
                        <div className="input-group">
                            <label>Estado <span style={{color:'var(--color-text-muted)', fontWeight:400}}>(siempre Nuevo)</span></label>
                            <input type="text" value="Nuevo" disabled style={{ color: 'var(--color-success)', opacity: 0.9 }} />
                        </div>
                    )}

                    {/* Banner de error: campos obligatorios faltantes */}
                    {flowBannerMsg && (
                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            marginTop: 16,
                            padding: '10px 14px',
                            background: 'rgba(239, 68, 68, 0.08)',
                            border: '1px solid var(--color-error)',
                            borderRadius: 'var(--radius-md)',
                            color: 'var(--color-error)',
                            fontSize: '0.85rem',
                            fontWeight: 500
                        }}>
                            <span style={{ flex: 1 }}>{flowBannerMsg}</span>
                            <button
                                type="button"
                                onClick={() => setFlowBannerMsg('')}
                                style={{ background: 'none', border: 'none', color: 'var(--color-error)', cursor: 'pointer', fontSize: '1rem', lineHeight: 1 }}
                            >
                                <IoCloseOutline size={16} />
                            </button>
                        </div>
                    )}

                    {/* Campos adicionales: siempre-visibles (configurados en Campos del Formulario) + condicionales por Tipo/Categoría */}
                    {allDynamicFields.length > 0 && (
                        <div className="dynamic-fields-section" style={{
                            marginTop: 20,
                            marginBottom: 20,
                            padding: '16px 20px',
                            background: 'var(--color-bg-secondary)',
                            borderRadius: 'var(--radius-md)',
                            border: '1px dashed var(--glass-border)'
                        }}>
                            <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--color-primary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
                                Campos adicionales
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                                {allDynamicFields.map(f => {
                                    const hasError = flowValidationErrors.includes(f.id);
                                    return (
                                        <div key={f.id} className="input-group" style={{ margin: 0 }}>
                                            <label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                                {f.nombre} {f.obligatorio && <span style={{ color: 'var(--color-error)' }}>*</span>}
                                            </label>
                                            
                                            {f.tipo_dato === 'select' ? (
                                                <select
                                                    value={dynamicFieldValues[f.id] || ''}
                                                    onChange={e => setDynamicFieldValues(p => ({ ...p, [f.id]: e.target.value }))}
                                                    style={{ borderColor: hasError ? 'var(--color-error)' : '' }}
                                                >
                                                    <option value="">-- Seleccionar --</option>
                                                    {Array.isArray(f.opciones) && f.opciones.map((o, idx) => (
                                                        <option key={idx} value={o}>{o}</option>
                                                    ))}
                                                </select>
                                            ) : f.tipo_dato === 'fecha' ? (
                                                <input
                                                    type="date"
                                                    value={dynamicFieldValues[f.id] || ''}
                                                    onChange={e => setDynamicFieldValues(p => ({ ...p, [f.id]: e.target.value }))}
                                                    style={{ borderColor: hasError ? 'var(--color-error)' : '' }}
                                                />
                                            ) : f.tipo_dato === 'hora' ? (
                                                <input
                                                    type="time"
                                                    value={dynamicFieldValues[f.id] || ''}
                                                    onChange={e => setDynamicFieldValues(p => ({ ...p, [f.id]: e.target.value }))}
                                                    style={{ borderColor: hasError ? 'var(--color-error)' : '' }}
                                                />
                                            ) : f.tipo_dato === 'numero' ? (
                                                <input
                                                    type="number"
                                                    value={dynamicFieldValues[f.id] || ''}
                                                    placeholder={f.formato || ''}
                                                    onChange={e => setDynamicFieldValues(p => ({ ...p, [f.id]: e.target.value }))}
                                                    style={{ borderColor: hasError ? 'var(--color-error)' : '' }}
                                                />
                                            ) : f.tipo_dato === 'moneda' ? (
                                                <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                                                    <span style={{ position: 'absolute', left: 12, color: 'var(--color-text-muted)', fontSize: '13px' }}>$</span>
                                                    <input
                                                        type="number"
                                                        step="0.01"
                                                        value={dynamicFieldValues[f.id] || ''}
                                                        placeholder="0.00"
                                                        onChange={e => setDynamicFieldValues(p => ({ ...p, [f.id]: e.target.value }))}
                                                        style={{ paddingLeft: '24px', borderColor: hasError ? 'var(--color-error)' : '' }}
                                                    />
                                                </div>
                                            ) : f.tipo_dato === 'archivo' ? (
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                                                    <label
                                                        className="btn btn-secondary"
                                                        style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, margin: 0, borderColor: hasError ? 'var(--color-error)' : '' }}
                                                    >
                                                        Seleccionar archivo
                                                        <input
                                                            type="file"
                                                            style={{ display: 'none' }}
                                                            onChange={e => {
                                                                const file = e.target.files?.[0];
                                                                if (!file) return;
                                                                const reader = new FileReader();
                                                                reader.onload = (ev) => {
                                                                    setDynamicFieldValues(p => ({
                                                                        ...p,
                                                                        [f.id]: {
                                                                            fileName: file.name,
                                                                            fileSize: file.size,
                                                                            fileType: file.type,
                                                                            fileData: ev.target.result
                                                                        }
                                                                    }));
                                                                };
                                                                reader.readAsDataURL(file);
                                                            }}
                                                        />
                                                    </label>
                                                    <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
                                                        {dynamicFieldValues[f.id]?.fileName || 'Ningún archivo seleccionado'}
                                                    </span>
                                                </div>
                                            ) : (
                                                <input
                                                    type="text"
                                                    value={dynamicFieldValues[f.id] || ''}
                                                    placeholder={f.formato || ''}
                                                    onChange={e => setDynamicFieldValues(p => ({ ...p, [f.id]: e.target.value }))}
                                                    style={{ borderColor: hasError ? 'var(--color-error)' : '' }}
                                                />
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {/* Descripción (Rich Text) */}
                    <div className="input-group">
                        <label>Descripción *</label>
                        <RichTextEditor
                            placeholder="Detalla el problema o solicitud..."
                            mentionableUsers={users.filter(u => u.role !== 'client')}
                            attachments={newTicketAttachments}
                            onAttachmentsChange={setNewTicketAttachments}
                            onChange={(content) => {
                                setNewTicket(prev => ({
                                    ...prev,
                                    description: content.html,
                                    plainDescription: content.text
                                }));
                            }}
                        />
                    </div>

                    {/* Tags */}
                    {enabledFormFields.includes('etiquetas') && (
                        <div className="input-group" style={{ marginTop: 16 }}>
                            <label>Etiquetas <span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}>(separadas por coma)</span></label>
                            <input
                                type="text"
                                placeholder="e.g. urgente, cliente-vip"
                                value={newTicket.tags}
                                onChange={e => setNewTicket(p => ({ ...p, tags: e.target.value }))}
                            />
                        </div>
                    )}

                    <div className="modal-footer" style={{ padding: 0, border: 'none', marginTop: 'var(--spacing-lg)' }}>
                        <button type="button" className="btn btn-secondary" disabled={isCreatingTicket} onClick={() => setShowCreateModal(false)}>Cancelar</button>
                        <button type="submit" className="btn btn-primary" disabled={!newTicket.subject.trim() || !newTicket.plainDescription.trim() || isCreatingTicket}>
                            {isCreatingTicket ? 'Guardando…' : (activeWorkspace === 'volcan_desk' ? 'Crear Solicitud' : 'Crear Ticket')}
                        </button>
                    </div>
                </form>
            </Modal>
        </div>
    );
}
