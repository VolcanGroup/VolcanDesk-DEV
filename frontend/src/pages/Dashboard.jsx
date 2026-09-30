import './Dashboard.css';
import { useEffect, useMemo, useState } from 'react';
import { getVisibleTickets, computeSlaStatus, getUserGroupsForScoping, loadTicketsFromServer } from '../services/ticketService';
import { getConfig, loadConfigFromServer, isTerminalStatus, resolvePriority, resolveStatus, INTERNAL_STATUSES, MOTIVO_BLOQUEO_OPTIONS } from '../services/configService';
import { getGroups } from '../services/groupService';
import { getUsers } from '../services/userService';
import { getCurrentUser } from '../services/authService';
import { calculatePercentage } from '../utils/helpers';
import { WorkspaceContext } from '../context/WorkspaceContext';
import { useContext } from 'react';
import ChartCanvas from '../components/ChartCanvas';

// Rango de fechas por defecto: últimos 30 días (mismo periodo que antes mostraba
// el select decorativo, ahora sí conectado a datos reales).
// OJO: toISOString() convierte a UTC. Para cualquier usuario en huso horario
// negativo (toda América), eso hace que la fecha "de hoy" calculada acá quede
// un día ATRASADA respecto al calendario local del usuario, y un ticket creado
// hoy mismo termina fuera del rango por unas horas — se ve como si el ticket
// "no existiera" en Inicio/Reportes cuando en realidad es un error de zona
// horaria en el límite superior del filtro. Se arma el string a mano con los
// componentes LOCALES de la fecha en vez de toISOString().
const toDateInputValue = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
};
const defaultDateFrom = () => { const d = new Date(); d.setDate(d.getDate() - 30); return toDateInputValue(d); };
const defaultDateTo = () => toDateInputValue(new Date());
// new Date('YYYY-MM-DD') también parsea como UTC medianoche (no local) — usar
// esto en vez de new Date(str) directo para evitar el mismo corrimiento al
// convertir el input de los date pickers de vuelta a un Date real.
const parseLocalDate = (str) => {
    const [y, m, d] = str.split('-').map(Number);
    return new Date(y, m - 1, d);
};
const fmtShort = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;

// Paleta compartida por las gráficas de distribución (producto/tipo) — mismo
// criterio de color que ya usa el resto de la app para series categóricas.
const PALETTE = ['#6366f1', '#3b82f6', '#10b981', '#f59e0b', '#a855f7', '#ef4444', '#0ea5e9', '#f43f5e', '#14b8a6', '#eab308'];

export default function Dashboard() {
  const { activeWorkspace } = useContext(WorkspaceContext);
  const currentUser = getCurrentUser();
  const isDesk = activeWorkspace === 'volcan_desk';

  const myGroups = useMemo(() => getUserGroupsForScoping(currentUser), [currentUser?.id]);
  const canScopeByGroup = isDesk && myGroups.length > 0;
  // Default "Totales de mi grupo" para todos los roles (2026-09-17, a pedido
  // del usuario) — antes un agent arrancaba en "Mis totales" ("como Mi
  // atención en Solicitudes"), pero eso hacía que Inicio pareciera vacío/en
  // ceros a primera vista para cualquiera sin tickets propios asignados.
  const [scope, setScope] = useState('group');
  const [dateFrom, setDateFrom] = useState(defaultDateFrom());
  const [dateTo, setDateTo] = useState(defaultDateTo());

  // Un admin general no pertenece a ningún grupo (myGroups=[]), así que nunca
  // ve el toggle Mis totales/Totales de mi grupo y siempre miraba todos los
  // grupos mezclados sin poder desglosar. Este selector le permite elegir un
  // grupo puntual para ver "como si fuera" ese equipo.
  const deskGroups = useMemo(
    () => isDesk ? getGroups().filter(g => (g.modulo || 'voltik') === 'volcan_desk') : [],
    [isDesk]
  );
  const canFilterByGroup = isDesk && (currentUser?.role === 'admin' || myGroups.length > 1);
  // Un admin general sí puede elegir cualquier grupo del sistema (por eso
  // deskGroups completo arriba) — pero un agent/group_admin con varios grupos
  // (nativos + Acceso Especial) solo debe poder filtrar entre LOS SUYOS, no
  // ver el catálogo completo de la empresa en este selector (reportado en
  // vivo 2026-09-17, cuenta "Kendy test": veía los 16 grupos de Volcán Desk
  // en vez de sus 3 grupos con acceso).
  const filterableGroups = currentUser?.role === 'admin' ? deskGroups : deskGroups.filter(g => myGroups.includes(g.id));
  const [groupFilter, setGroupFilter] = useState('all');

  const [tickets, setTickets] = useState([]);
  const [refreshTick, setRefreshTick] = useState(0);
  // Reportes se fusionó aquí y esa pestaña se quitó (2026-09-07, a pedido del
  // usuario: "todo debe cuadrar con los datos de Solicitudes Recibidas") — lo
  // único que Reportes tenía y Inicio no era "Productividad por Agente"; el
  // resto (SLA, prioridad, estado) ya vivía acá, dos veces era redundante.
  const [users, setUsers] = useState([]);
  useEffect(() => { setUsers(getUsers()); }, [activeWorkspace]);

  // getVisibleTickets lee de un cache en memoria (cachedTickets) que solo se
  // llena una vez al montar la app y luego solo se refresca mientras la
  // página Solicitudes está abierta (su propio polling de 8s). Si un usuario
  // entra directo a "Inicio" y no visita Solicitudes, el dashboard se queda
  // pegado con los datos del momento en que cargó la app. Se agrega el mismo
  // patrón de refresco acá para que Inicio siempre muestre datos vivos.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        await loadTicketsFromServer();
        // Mismo motivo que tickets: catálogos (Tipos/Categorías/Productos)
        // editados por otro admin no se veían aquí hasta un F5 (reportado en
        // vivo 2026-09-16) — getConfig() se lee fresco en cada render, solo
        // hacía falta mantener el caché del módulo al día.
        await loadConfigFromServer();
        if (!cancelled) setRefreshTick(t => t + 1);
      } catch (err) {
        console.error('Error auto-actualizando tickets del dashboard:', err);
      }
    };
    refresh();
    const interval = setInterval(refresh, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [activeWorkspace]);

  useEffect(() => {
    let visible = getVisibleTickets(currentUser, activeWorkspace);

    if (canScopeByGroup) {
      visible = scope === 'mine'
        // "Mis totales" usaba isMyTicket (matchea también createdBy, o sea tickets
        // que el usuario PIDIÓ) — bug reportado en vivo 2026-09-07: el Dashboard
        // debe reflejar solo "Solicitudes Recibidas" (lo que el usuario/su grupo
        // RESUELVE), nunca lo que enviaron a otros grupos. Un group_admin con 1
        // ticket asignado veía "3" en Mis totales porque se sumaban 2 tickets que
        // él mismo había solicitado a otro grupo. Mismo criterio de fondo que la
        // rama "de mi grupo" de abajo: resolver_agent_id/assignedTo, nunca createdBy.
        ? visible.filter(t => t.assignedTo === currentUser.id || t.resolver_agent_id === currentUser.id)
        // "Totales de mi grupo" usaba isGroupTicket (matchea requester-o-resolutor-o-
        // apoyo) — bug reportado en vivo 2026-08-27: un group_admin de BI & Development
        // veía en SU dashboard tickets resueltos por TI, solo porque el ticket había
        // NACIDO (area_origen_id) en BI & Development aunque ya no fuera su cola de
        // trabajo. Mismo patrón ya documentado en CLAUDE.md para Kanban/deskRoleViewMatch/
        // Tickets.jsx: la cola real de un equipo es resolver_group_id || group, nunca
        // isGroupTicket() sola — igual que ya hace groupFilter más abajo.
        : visible.filter(t => myGroups.includes(t.resolver_group_id || t.group));
    }

    if (canFilterByGroup && groupFilter !== 'all') {
      // A propósito NO usa isGroupTicket (esa función también matchea por
      // area_origen_id, el grupo SOLICITANTE). Acá el admin quiere ver la
      // carga de un equipo resolutor puntual — mismo criterio que las
      // columnas del Kanban en Solicitudes, que agrupan por resolver_group_id.
      // Si se usara isGroupTicket, un ticket pedido por "Operaciones" pero
      // resuelto por "BI & Development" aparecería en ambos grupos.
      visible = visible.filter(t => (t.resolver_group_id || t.group) === groupFilter);
    }

    if (dateFrom) {
      const from = parseLocalDate(dateFrom); from.setHours(0, 0, 0, 0);
      visible = visible.filter(t => new Date(t.createdAt) >= from);
    }
    if (dateTo) {
      const to = parseLocalDate(dateTo); to.setHours(23, 59, 59, 999);
      visible = visible.filter(t => new Date(t.createdAt) <= to);
    }

    setTickets(visible);
  }, [currentUser?.id, activeWorkspace, scope, canScopeByGroup, canFilterByGroup, groupFilter, dateFrom, dateTo, refreshTick]);

  const stats = useMemo(() => {
    const config = getConfig();
    // "Abiertos"/"Resueltos" con isTerminalStatus, que ya sabe leer tanto el
    // catálogo fijo de Volcán Desk como las categorías configurables de Voltik
    // — antes esto comparaba contra literales de Voltik ('new'/'in_progress'/...)
    // y por eso los totales de Volcán Desk siempre daban 0.
    const resolved = tickets.filter(t => isTerminalStatus(t.status)).length;
    const open = tickets.filter(t => !isTerminalStatus(t.status)).length;

    const sla = { ok: 0, warning: 0, breached: 0 };
    tickets.forEach(ticket => {
      const status = computeSlaStatus(ticket, config).status;
      if (sla[status] !== undefined) sla[status] += 1;
    });

    // Distribución por prioridad: se agrupa por la ETIQUETA resuelta (no por el
    // valor crudo), porque en Volcán Desk cada grupo puede tener su propio
    // catálogo de prioridades con values distintos ("baja", "baja__<grupoId>",
    // etc.) — comparar contra 'low'/'medium'/'high'/'urgent' fijos dejaba esta
    // sección siempre en cero para Volcán Desk.
    const priorityMap = new Map();
    tickets.forEach(t => {
      const info = resolvePriority(t.priority);
      if (!priorityMap.has(info.label)) priorityMap.set(info.label, { label: info.label, color: info.color, count: 0 });
      priorityMap.get(info.label).count += 1;
    });
    const priorityOrder = ['Baja', 'Media', 'Alta', 'Urgente'];
    const byPriority = Array.from(priorityMap.values()).sort((a, b) => {
      const ia = priorityOrder.indexOf(a.label), ib = priorityOrder.indexOf(b.label);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.label.localeCompare(b.label);
    });

    // Desglose real por estado de vida, en el mismo orden que se ve en el Kanban.
    // `behavior` se conserva (no solo id/label/color) para poder distinguir
    // pendiente/en-proceso/terminal más abajo sin tener que volver a resolver
    // cada estado contra el catálogo.
    const statusCatalog = isDesk
      ? INTERNAL_STATUSES.map(s => ({ id: s.id, label: s.label, color: s.color, behavior: s.behavior }))
      : [
          { id: 'new', label: 'Nuevo', color: '#0066CC', behavior: 'new' },
          ...(config.statusCategories || []).map(c => ({ id: c.id, label: c.label, color: c.color, behavior: c.behavior })),
        ];
    const byStatus = statusCatalog.map(s => ({
      ...s,
      count: tickets.filter(t => resolveStatus(t.status).categoryId === s.id).length,
    }));

    return {
      total: tickets.length,
      open,
      resolved,
      sla,
      byPriority,
      byStatus,
    };
  }, [tickets, isDesk]);

  const attention = useMemo(() => tickets.filter(t => !isTerminalStatus(t.status)).map(ticket => {
    const sla = computeSlaStatus(ticket, getConfig());
    const reason = sla.status === 'breached' ? 'SLA vencido' : sla.status === 'warning' ? 'Próximo a vencer' : !ticket.assignedTo ? 'Sin asignar' : ticket.priority === 'urgent' ? 'Urgente' : null;
    // Volcán Desk no tiene empresa/cliente — el subtítulo debe mostrar el grupo
    // resolutor (mismo criterio que ya se usa en TicketTable.jsx, doc §25).
    // Sin esto caía en el fallback 'Cliente' de abajo, que no aplica aquí.
    const groupLabel = isDesk ? (deskGroups.find(g => g.id === (ticket.resolver_group_id || ticket.group))?.name || ticket.group || 'Sin grupo') : null;
    return { ...ticket, sla, reason, groupLabel };
  }).filter(t => t.reason).slice(0, 6), [tickets, isDesk, deskGroups]);

  // KPIs de cabecera, al estilo del dashboard de ejemplo (Total / Pendientes /
  // En Proceso / SLA en tiempo). "Pendientes" es el primer estado (to_do/new);
  // "En Proceso" (2026-09-08, antes "En Ejecución" — a pedido del usuario, solo
  // contaba on_going) ahora suma TODOS los estados activos que no son
  // Pendiente ni terminales (on_going + in_testing + under_review en Volcán
  // Desk; cualquier statusCategory no-'new' y no-terminal en Voltik), para que
  // Pendientes + En Proceso sea exactamente el 100% de los tickets abiertos.
  const pendingId = isDesk ? 'to_do' : 'new';
  const pendingCount = stats.byStatus.find(s => s.id === pendingId)?.count ?? 0;
  const executingCount = stats.byStatus
    .filter(s => s.id !== pendingId && s.behavior !== 'terminal')
    .reduce((sum, s) => sum + s.count, 0);
  const slaTotal = stats.sla.ok + stats.sla.warning + stats.sla.breached;
  const slaPct = slaTotal ? calculatePercentage(stats.sla.ok, slaTotal) : 100;

  // "Productividad por Agente": acotado al módulo activo y, salvo para un admin
  // sin grupo propio, a agentes que comparten grupo con el usuario actual —
  // antes se mostraban TODOS los agentes del sistema (incluyendo los de Voltik)
  // sin importar quién mira.
  const scopedAgents = useMemo(() => {
    const modulo = isDesk ? 'volcan_desk' : 'voltik';
    let agentsList = users.filter(u => u.role !== 'client' && (u.modulo || 'voltik') === modulo);
    if (isDesk && myGroups.length > 0) {
      // (a.groups || []) a secas se salta a un group_admin: su membresía real
      // vive en admin_group_id, no en groups (ese array es de agent) — un
      // group_admin con groups:[] desaparecía de esta gráfica aunque sí
      // administrara uno de myGroups. Reportado en vivo 2026-09-17 (caso real:
      // Adrián González, admin de BI Development & Risk, ausente de
      // "Productividad y Carga por Agente" viendo esa gráfica como su propio
      // compañero de grupo Guillermo Martínez).
      agentsList = agentsList.filter(a =>
        (a.role === 'group_admin' && myGroups.includes(a.admin_group_id))
        || (a.groups || []).some(g => myGroups.includes(g))
      );
    }
    return agentsList;
  }, [users, isDesk, myGroups]);

  // Se calcula sobre `tickets` (ya acotado arriba a "Solicitudes Recibidas" —
  // resolver_agent_id/assignedTo, nunca lo que el agente solicitó a otro grupo).
  const agentStats = useMemo(() => scopedAgents.map(agent => {
    const agentTickets = tickets.filter(t => t.assignedTo === agent.id || t.resolver_agent_id === agent.id);
    const resolved = agentTickets.filter(t => isTerminalStatus(t.status)).length;
    const horas = agentTickets.reduce((sum, t) => sum + (parseFloat(t.estimacion_hus) || 0), 0);
    return {
      name: agent.name,
      total: agentTickets.length,
      resolved,
      enProgreso: agentTickets.length - resolved,
      horas,
      resolutionRate: calculatePercentage(resolved, agentTickets.length),
    };
  }).sort((a, b) => b.resolved - a.resolved), [scopedAgents, tickets]);

  // Ingreso vs Resolución por semana (o el bucket de días que corresponda si el
  // rango elegido es más largo de 8 semanas) — usa fecha_resolucion cuando existe
  // y, si el ticket ya está en un estado terminal pero nunca se estampó esa fecha
  // (dato legado), cae a updatedAt como mejor aproximación disponible.
  const weeklySeries = useMemo(() => {
    if (!dateFrom || !dateTo) return { labels: [], ingresados: [], resueltos: [] };
    const from = parseLocalDate(dateFrom); from.setHours(0, 0, 0, 0);
    const to = parseLocalDate(dateTo); to.setHours(23, 59, 59, 999);
    const totalDays = Math.max(1, Math.round((to - from) / 86400000) + 1);
    const maxBuckets = 8;
    const bucketDays = Math.max(1, Math.ceil(totalDays / maxBuckets));
    const buckets = [];
    let cursor = new Date(from);
    while (cursor <= to) {
      const start = new Date(cursor);
      const end = new Date(cursor); end.setDate(end.getDate() + bucketDays - 1); end.setHours(23, 59, 59, 999);
      if (end > to) end.setTime(to.getTime());
      buckets.push({ start, end, ingresados: 0, resueltos: 0 });
      cursor.setDate(cursor.getDate() + bucketDays);
    }
    tickets.forEach(t => {
      const created = new Date(t.createdAt);
      const bucketIn = buckets.find(b => created >= b.start && created <= b.end);
      if (bucketIn) bucketIn.ingresados += 1;
      if (isTerminalStatus(t.status)) {
        const resolvedDate = t.fecha_resolucion ? new Date(t.fecha_resolucion) : new Date(t.updatedAt);
        const bucketOut = buckets.find(b => resolvedDate >= b.start && resolvedDate <= b.end);
        if (bucketOut) bucketOut.resueltos += 1;
      }
    });
    return {
      labels: buckets.map(b => bucketDays <= 1 ? fmtShort(b.start) : `${fmtShort(b.start)}-${fmtShort(b.end)}`),
      ingresados: buckets.map(b => b.ingresados),
      resueltos: buckets.map(b => b.resueltos),
    };
  }, [tickets, dateFrom, dateTo]);

  // Cerrados por mes (últimos 6 meses, fijo): a propósito NO usa `tickets`
  // (que está acotado al date-range-picker del dashboard, por defecto 30 días)
  // — se vuelve a resolver el mismo scope (mine/group/groupFilter) directo
  // sobre getVisibleTickets(), sin el filtro de fecha, para que esta gráfica
  // siempre muestre el histórico real de los últimos 6 meses sin importar qué
  // rango tenga seleccionado el resto del dashboard.
  const closedByMonth = useMemo(() => {
    let scoped = getVisibleTickets(currentUser, activeWorkspace);
    if (canScopeByGroup) {
      scoped = scope === 'mine'
        ? scoped.filter(t => t.assignedTo === currentUser.id || t.resolver_agent_id === currentUser.id)
        : scoped.filter(t => myGroups.includes(t.resolver_group_id || t.group));
    }
    if (canFilterByGroup && groupFilter !== 'all') {
      scoped = scoped.filter(t => (t.resolver_group_id || t.group) === groupFilter);
    }
    const now = new Date();
    const buckets = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      buckets.push({ year: d.getFullYear(), month: d.getMonth(), count: 0 });
    }
    scoped.forEach(t => {
      if (!isTerminalStatus(t.status)) return;
      const closedDate = t.fecha_resolucion ? new Date(t.fecha_resolucion) : new Date(t.updatedAt);
      const bucket = buckets.find(b => b.year === closedDate.getFullYear() && b.month === closedDate.getMonth());
      if (bucket) bucket.count += 1;
    });
    const MONTH_NAMES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    return {
      labels: buckets.map(b => `${MONTH_NAMES[b.month]} ${b.year}`),
      counts: buckets.map(b => b.count),
    };
  }, [currentUser?.id, activeWorkspace, scope, canScopeByGroup, canFilterByGroup, groupFilter, refreshTick]);

  const byProduct = useMemo(() => {
    const config = getConfig();
    const map = new Map();
    tickets.forEach(t => {
      const label = config.products?.find(p => p.id === t.product)?.label || t.product || 'Sin producto';
      map.set(label, (map.get(label) || 0) + 1);
    });
    return Array.from(map.entries()).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
  }, [tickets]);

  const byType = useMemo(() => {
    const config = getConfig();
    const map = new Map();
    tickets.forEach(t => {
      // Antes caía al id crudo (ej. "t1789415185557") cuando el ticket sí tenía un
      // tipo asignado pero ese id ya no existe en el catálogo (reorganización de
      // categorías/tipos, mismo caso ya resuelto en FlowsConfigPage con "Tipo
      // eliminado" — reportado en vivo 2026-09-18 para Categorías, aplica igual aquí).
      const label = t.type
        ? (config.types?.find(ty => ty.id === t.type)?.label || 'Tipo eliminado')
        : 'Sin tipo';
      map.set(label, (map.get(label) || 0) + 1);
    });
    return Array.from(map.entries()).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
  }, [tickets]);

  const topCategories = useMemo(() => {
    const config = getConfig();
    const map = new Map();
    tickets.forEach(t => {
      // Mismo caso: un ticket con category poblado pero apuntando a un id que ya
      // no existe en el catálogo mostraba el id crudo en vez de un texto legible
      // (reportado en vivo 2026-09-18: "c1789616712302_ms"/"_mi" en el gráfico
      // "Top Categorías de Solicitud" — 17 tickets viejos del grupo BI Development
      // & Risk, de antes de una reorganización del catálogo; los tickets siguen
      // existiendo, solo la categoría vieja ya no).
      const label = t.category
        ? (config.categories?.find(c => c.id === t.category)?.label || 'Categoría eliminada')
        : 'Sin categoría';
      map.set(label, (map.get(label) || 0) + 1);
    });
    return Array.from(map.entries()).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count).slice(0, 6);
  }, [tickets]);

  const slaByPriority = useMemo(() => {
    const config = getConfig();
    const map = new Map();
    tickets.forEach(t => {
      const info = resolvePriority(t.priority);
      const slaStatus = computeSlaStatus(t, config).status;
      if (!map.has(info.label)) map.set(info.label, { label: info.label, ok: 0, warning: 0, breached: 0 });
      const entry = map.get(info.label);
      if (entry[slaStatus] !== undefined) entry[slaStatus] += 1;
    });
    const priorityOrder = ['Baja', 'Media', 'Alta', 'Urgente'];
    return Array.from(map.values()).sort((a, b) => {
      const ia = priorityOrder.indexOf(a.label), ib = priorityOrder.indexOf(b.label);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.label.localeCompare(b.label);
    });
  }, [tickets]);

  // Razones de pausa: agrega el historial de bloqueos (TicketBloqueoHistorial)
  // de todos los tickets en alcance, no solo los bloqueados ahora mismo — así
  // se ve el cuello de botella recurrente aunque el ticket ya se haya reanudado.
  // Estado ACTUAL del tablero (bloqueado=true ahora mismo), no el historial de
  // bloqueos — un ticket pausado y reanudado varias veces (común en pruebas)
  // no debe seguir contando aquí una vez que ya se reanudó. Para el historial
  // completo de bloqueos por ticket, ver `ticket.bloqueos` (TicketBloqueoHistorial).
  const pauseReasons = useMemo(() => {
    const map = new Map();
    tickets.forEach(t => {
      if (!t.bloqueado) return;
      const label = MOTIVO_BLOQUEO_OPTIONS.find(m => m.value === t.motivo_bloqueo)?.label || t.motivo_bloqueo || 'Sin motivo';
      map.set(label, (map.get(label) || 0) + 1);
    });
    return Array.from(map.entries()).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count).slice(0, 6);
  }, [tickets]);

  return <div className="dashboard">
    <div className="dashboard-header">
      <div><span className="eyebrow">Resumen operativo</span><h1>Buenos días, {currentUser?.name?.split(' ')[0]}</h1><p>Esto es lo que requiere atención hoy.</p></div>
      <div className="dashboard-header-controls">
        {canScopeByGroup && (
          <div className="scope-toggle">
            <button className={scope === 'mine' ? 'active' : ''} onClick={() => setScope('mine')}>Mis totales</button>
            <button className={scope === 'group' ? 'active' : ''} onClick={() => setScope('group')}>Totales de mi grupo</button>
          </div>
        )}
        {canFilterByGroup && (
          <select className="group-filter-select" aria-label="Filtrar por grupo" value={groupFilter} onChange={e => setGroupFilter(e.target.value)}>
            <option value="all">Todos los grupos</option>
            {filterableGroups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        )}
        <div className="date-range-picker">
          <input type="date" aria-label="Fecha inicio" value={dateFrom} max={dateTo || undefined} onChange={e => setDateFrom(e.target.value)} />
          <span>→</span>
          <input type="date" aria-label="Fecha fin" value={dateTo} min={dateFrom || undefined} max={defaultDateTo()} onChange={e => setDateTo(e.target.value)} />
        </div>
      </div>
    </div>

    <section className="kpi-grid">
      <div className="kpi-card"><span>Total Tickets</span><strong>{stats.total}</strong><small>Histórico: pendientes + en proceso + cerrados</small></div>
      <div className="kpi-card"><span>Pendientes</span><strong className="kpi-warning">{pendingCount}</strong><small>Sin asignar o sin iniciar</small></div>
      <div className="kpi-card"><span>En Proceso</span><strong className="kpi-info">{executingCount}</strong><small>En atención activa</small></div>
      <div className="kpi-card"><span>En Tiempo (SLA)</span><strong className="kpi-success">{slaPct}%</strong><small>Cumplimiento del SLA</small></div>
    </section>

    <section className="charts-grid">
      <div className="chart-card chart-card-wide">
        <h2>Ingreso vs Resolución por Semana</h2>
        <div className="chart-box">
          <ChartCanvas type="line" data={{
            labels: weeklySeries.labels,
            datasets: [
              { label: 'Ingresados', data: weeklySeries.ingresados, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.12)', borderWidth: 2, fill: true, tension: 0.3 },
              { label: 'Resueltos', data: weeklySeries.resueltos, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.12)', borderWidth: 2, fill: true, tension: 0.3 },
            ],
          }} options={{
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'top' } },
            scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
          }} />
        </div>
      </div>

      <div className="chart-card">
        {/* Terminado se quita (2026-09-08, a pedido del usuario) — esta gráfica
            es sobre la carga ACTIVA (qué tan lleno está cada estado de trabajo
            en curso); los terminados ya tienen su propia gráfica de "Cerrados
            por mes" al lado. */}
        <h2>Volumen de Tickets por Estado</h2>
        <div className="chart-box">
          <ChartCanvas type="bar" data={{
            labels: stats.byStatus.filter(s => s.behavior !== 'terminal').map(s => s.label),
            datasets: [{ label: 'Tickets', data: stats.byStatus.filter(s => s.behavior !== 'terminal').map(s => s.count), backgroundColor: stats.byStatus.filter(s => s.behavior !== 'terminal').map(s => s.color), borderRadius: 6 }],
          }} options={{
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
          }} />
        </div>
      </div>

      <div className="chart-card">
        <h2>Cerrados por Mes (últimos 6 meses)</h2>
        <div className="chart-box">
          <ChartCanvas type="bar" data={{
            labels: closedByMonth.labels,
            datasets: [{ label: 'Cerrados', data: closedByMonth.counts, backgroundColor: '#10b981', borderRadius: 6 }],
          }} options={{
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
          }} />
        </div>
      </div>

      <div className="chart-card">
        <h2>Distribución por Producto</h2>
        <div className="chart-box">
          <ChartCanvas type="doughnut" data={{
            labels: byProduct.map(p => p.label),
            datasets: [{ data: byProduct.map(p => p.count), backgroundColor: byProduct.map((_, i) => PALETTE[i % PALETTE.length]), borderWidth: 0, hoverOffset: 4 }],
          }} options={{
            responsive: true, maintainAspectRatio: false, cutout: '65%',
            plugins: { legend: { position: 'right' } },
          }} />
        </div>
      </div>

      <div className="chart-card">
        <h2>Distribución por Tipo</h2>
        <div className="chart-box">
          <ChartCanvas type="pie" data={{
            labels: byType.map(t => t.label),
            datasets: [{ data: byType.map(t => t.count), backgroundColor: byType.map((_, i) => PALETTE[i % PALETTE.length]), borderWidth: 0, hoverOffset: 4 }],
          }} options={{
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { position: 'right' } },
          }} />
        </div>
      </div>

      <div className="chart-card">
        <h2>Cumplimiento de SLA por Prioridad</h2>
        <div className="chart-box">
          <ChartCanvas type="bar" data={{
            labels: slaByPriority.map(p => p.label),
            datasets: [
              { label: 'En tiempo', data: slaByPriority.map(p => p.ok), backgroundColor: '#10b981', stack: 's' },
              { label: 'Por vencer', data: slaByPriority.map(p => p.warning), backgroundColor: '#f59e0b', stack: 's' },
              { label: 'Vencido', data: slaByPriority.map(p => p.breached), backgroundColor: '#ef4444', stack: 's' },
            ],
          }} options={{
            responsive: true, maintainAspectRatio: false,
            scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } },
            plugins: { legend: { position: 'bottom' } },
          }} />
        </div>
      </div>

      <div className="chart-card">
        <h2>Top Categorías de Solicitud</h2>
        <div className="chart-box">
          <ChartCanvas type="bar" data={{
            labels: topCategories.map(c => c.label),
            datasets: [{ label: 'Volumen', data: topCategories.map(c => c.count), backgroundColor: '#f59e0b', borderRadius: 4 }],
          }} options={{
            indexAxis: 'y', responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { x: { beginAtZero: true, ticks: { precision: 0 } } },
          }} />
        </div>
      </div>

      <div className="chart-card">
        <h2>Tickets Bloqueados Ahora (por motivo)</h2>
        <div className="chart-box">
          <ChartCanvas type="bar" data={{
            labels: pauseReasons.map(p => p.label),
            datasets: [{ label: 'Tickets', data: pauseReasons.map(p => p.count), backgroundColor: '#ef4444', borderRadius: 4 }],
          }} options={{
            indexAxis: 'y', responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { x: { beginAtZero: true, ticks: { precision: 0 } } },
          }} />
        </div>
      </div>

      {currentUser?.role !== 'client' && (
        <div className="chart-card chart-card-wide">
          <h2>Productividad y Carga por Agente</h2>
          <div className="chart-box chart-box-tall">
            <ChartCanvas type="bar" data={{
              labels: agentStats.map(a => a.name),
              datasets: [
                { type: 'bar', label: 'Terminados', data: agentStats.map(a => a.resolved), backgroundColor: '#10b981', stack: 's', order: 2 },
                { type: 'bar', label: 'En progreso', data: agentStats.map(a => a.enProgreso), backgroundColor: '#3b82f6', stack: 's', order: 2 },
                ...(isDesk ? [{ type: 'line', label: 'Esfuerzo estimado (HUs)', data: agentStats.map(a => a.horas), borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.2)', borderWidth: 3, tension: 0.3, fill: true, yAxisID: 'y1', order: 1 }] : []),
              ],
            }} options={{
              responsive: true, maintainAspectRatio: false,
              interaction: { mode: 'index', intersect: false },
              scales: {
                x: { stacked: true },
                y: { type: 'linear', position: 'left', stacked: true, beginAtZero: true, title: { display: true, text: 'Tickets' } },
                ...(isDesk ? { y1: { type: 'linear', position: 'right', beginAtZero: true, title: { display: true, text: 'Horas estimadas' }, grid: { drawOnChartArea: false } } } : {}),
              },
              plugins: { legend: { position: 'top' } },
            }} />
          </div>
        </div>
      )}
    </section>

    <section className="attention-panel" style={{ marginTop: 24 }}>
      <div className="section-heading"><div><h2>Necesitan atención</h2><p>Tickets con riesgo, urgentes o sin responsable.</p></div><span>{attention.length} tickets</span></div>
      <div className="attention-list">
        {attention.length ? attention.map(t => <div className="attention-row" key={t.id}><span className={`attention-dot ${t.sla.status}`}></span><div className="ticket-name"><strong>{t.title}</strong><small>#{t.id} · {isDesk ? t.groupLabel : (t.company || 'Cliente')}</small></div><span className="attention-reason">{t.reason}</span><span className="assignee">{t.assignedTo || 'Sin asignar'}</span><strong className={t.sla.status}>{t.sla.label || t.reason}</strong></div>) : <div className="empty-state"><strong>Todo está bajo control</strong><span>No hay tickets críticos con los filtros actuales.</span></div>}
      </div>
    </section>
  </div>;
}
