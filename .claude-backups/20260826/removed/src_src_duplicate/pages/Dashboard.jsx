import './Dashboard.css';
import { useEffect, useMemo, useState } from 'react';
import { getVisibleTickets, computeSlaStatus, getUserGroupsForScoping, isMyTicket, isGroupTicket, loadTicketsFromServer } from '../services/ticketService';
import { getConfig, isTerminalStatus, resolvePriority, resolveStatus, INTERNAL_STATUSES } from '../services/configService';
import { getGroups } from '../services/groupService';
import { getCurrentUser } from '../services/authService';
import { calculatePercentage } from '../utils/helpers';
import { WorkspaceContext } from '../context/WorkspaceContext';
import { useContext } from 'react';

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

export default function Dashboard() {
  const { activeWorkspace } = useContext(WorkspaceContext);
  const currentUser = getCurrentUser();
  const isDesk = activeWorkspace === 'volcan_desk';

  const myGroups = useMemo(() => getUserGroupsForScoping(currentUser), [currentUser?.id]);
  const canScopeByGroup = isDesk && myGroups.length > 0;
  // Agente normal arranca viendo lo suyo (como "Mi atención" en Solicitudes);
  // supervisor/group_admin arrancan viendo el panorama completo de su grupo.
  const [scope, setScope] = useState(currentUser?.role === 'agent' ? 'mine' : 'group');
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
  const [groupFilter, setGroupFilter] = useState('all');

  const [tickets, setTickets] = useState([]);
  const [refreshTick, setRefreshTick] = useState(0);

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
        if (!cancelled) setRefreshTick(t => t + 1);
      } catch (err) {
        console.error('Error auto-actualizando tickets del dashboard:', err);
      }
    };
    refresh();
    const interval = setInterval(refresh, 8000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [activeWorkspace]);

  useEffect(() => {
    let visible = getVisibleTickets(currentUser, activeWorkspace);

    if (canScopeByGroup) {
      visible = scope === 'mine'
        ? visible.filter(t => isMyTicket(t, currentUser))
        : visible.filter(t => isGroupTicket(t, myGroups));
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

    // Desglose real por estado de vida (reemplaza el viejo resumen genérico
    // Recibidos/Resueltos/Abiertos: con 0 resueltos, "abiertos" y "recibidos"
    // siempre daban el mismo número y la sección no explicaba nada). Usa el
    // catálogo fijo de Volcán Desk o statusCategories+Nuevo de Voltik, en el
    // mismo orden que se ve en el Kanban.
    const statusCatalog = isDesk
      ? INTERNAL_STATUSES.map(s => ({ id: s.id, label: s.label, color: s.color }))
      : [
          { id: 'new', label: 'Nuevo', color: '#0066CC' },
          ...(config.statusCategories || []).map(c => ({ id: c.id, label: c.label, color: c.color })),
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

  const attention = useMemo(() => tickets.map(ticket => {
    const sla = computeSlaStatus(ticket, getConfig());
    const reason = sla.status === 'breached' ? 'SLA vencido' : sla.status === 'warning' ? 'Próximo a vencer' : !ticket.assignedTo ? 'Sin asignar' : ticket.priority === 'urgent' ? 'Urgente' : null;
    // Volcán Desk no tiene empresa/cliente — el subtítulo debe mostrar el grupo
    // resolutor (mismo criterio que ya se usa en TicketTable.jsx, doc §25).
    // Sin esto caía en el fallback 'Cliente' de abajo, que no aplica aquí.
    const groupLabel = isDesk ? (deskGroups.find(g => g.id === (ticket.resolver_group_id || ticket.group))?.name || ticket.group || 'Sin grupo') : null;
    return { ...ticket, sla, reason, groupLabel };
  }).filter(t => t.reason).slice(0, 6), [tickets, isDesk, deskGroups]);

  const resolution = calculatePercentage(stats.resolved, stats.total);

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
            {deskGroups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        )}
        <div className="date-range-picker">
          <input type="date" aria-label="Fecha inicio" value={dateFrom} max={dateTo || undefined} onChange={e => setDateFrom(e.target.value)} />
          <span>→</span>
          <input type="date" aria-label="Fecha fin" value={dateTo} min={dateFrom || undefined} onChange={e => setDateTo(e.target.value)} />
        </div>
      </div>
    </div>
    <section className="metric-strip">
      <div><span>Tickets abiertos</span><strong>{stats.open}</strong><small>Activos en este momento</small></div>
      <div className="warning"><span>Próximos a vencer</span><strong>{stats.sla.warning}</strong><small>Revisa las próximas 2 horas</small></div>
      <div className="danger"><span>SLA vencidos</span><strong>{stats.sla.breached}</strong><small>Requieren atención</small></div>
      <div><span>Tasa de resolución</span><strong>{resolution}%</strong><small>{stats.resolved} tickets resueltos</small></div>
    </section>
    <section className="attention-panel">
      <div className="section-heading"><div><h2>Necesitan atención</h2><p>Tickets con riesgo, urgentes o sin responsable.</p></div><span>{attention.length} tickets</span></div>
      <div className="attention-list">
        {attention.length ? attention.map(t => <div className="attention-row" key={t.id}><span className={`attention-dot ${t.sla.status}`}></span><div className="ticket-name"><strong>{t.title}</strong><small>#{t.id} · {isDesk ? t.groupLabel : (t.company || 'Cliente')}</small></div><span className="attention-reason">{t.reason}</span><span className="assignee">{t.assignedTo || 'Sin asignar'}</span><strong className={t.sla.status}>{t.sla.label || t.reason}</strong></div>) : <div className="empty-state"><strong>Todo está bajo control</strong><span>No hay tickets críticos con los filtros actuales.</span></div>}
      </div>
    </section>
    <div className="operations-grid"><section className="operation-panel"><div className="section-heading"><div><h2>Tickets por estado</h2><p>Distribución real por etapa del ciclo de vida.</p></div></div><div className="simple-bars status-bars">{stats.byStatus.map(s => <div key={s.id}><span>{s.label}</span><div><i style={{width:`${s.count && stats.total ? Math.max(8, calculatePercentage(s.count, stats.total)) : 0}%`, background: s.color}}></i></div><strong>{s.count}</strong></div>)}</div></section><section className="operation-panel"><div className="section-heading"><div><h2>Carga operativa</h2><p>Distribución por prioridad.</p></div></div>{stats.byPriority.length ? stats.byPriority.map(p => <div className="workload-row" key={p.label}><span>{p.label}</span><strong>{p.count}</strong></div>) : <div className="workload-row"><span>Sin datos</span><strong>0</strong></div>}</section></div>
  </div>;
}
