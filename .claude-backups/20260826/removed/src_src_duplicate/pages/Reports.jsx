import './Reports.css';
import { useState, useEffect, useMemo } from 'react';
import { IoStatsChartOutline } from 'react-icons/io5';
import { getVisibleTickets, getUserGroupsForScoping, isMyTicket, isGroupTicket, loadTicketsFromServer } from '../services/ticketService';
import { getUsers } from '../services/userService';
import { getGroups } from '../services/groupService';
import { calculatePercentage } from '../utils/helpers';

import { getCurrentUser } from '../services/authService';
import { computeSlaStatus } from '../services/ticketService';
import { getConfig, isTerminalStatus, resolvePriority } from '../services/configService';
import { WorkspaceContext } from '../context/WorkspaceContext';
import { useContext } from 'react';

// Mismo fix que en Dashboard.jsx: toISOString() usa UTC, lo que en cualquier
// huso horario negativo (toda América) corre la fecha "de hoy" un día hacia
// atrás y excluye tickets creados hoy mismo del rango por defecto. Se arman
// las fechas con componentes locales y se parsean con parseLocalDate en vez
// de new Date(str) (que también asume UTC para strings 'YYYY-MM-DD').
const toDateInputValue = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
};
const defaultDateFrom = () => { const d = new Date(); d.setDate(d.getDate() - 30); return toDateInputValue(d); };
const defaultDateTo = () => toDateInputValue(new Date());
const parseLocalDate = (str) => {
    const [y, m, d] = str.split('-').map(Number);
    return new Date(y, m - 1, d);
};

export default function Reports() {
    const { activeWorkspace } = useContext(WorkspaceContext);
    const [allTickets, setAllTickets] = useState([]);
    const [users, setUsers] = useState([]);
    const currentUser = getCurrentUser();
    const isClient = currentUser?.role === 'client';
    const isDesk = activeWorkspace === 'volcan_desk';

    const myGroups = useMemo(() => getUserGroupsForScoping(currentUser), [currentUser?.id]);
    const canScopeByGroup = isDesk && myGroups.length > 0;
    const [scope, setScope] = useState(currentUser?.role === 'agent' ? 'mine' : 'group');
    const [dateFrom, setDateFrom] = useState(defaultDateFrom());
    const [dateTo, setDateTo] = useState(defaultDateTo());

    // Mismo selector que en Dashboard: un admin general no tiene grupo propio
    // (myGroups=[]) así que nunca ve el toggle mine/group y siempre mira todos
    // los grupos mezclados sin poder desglosar por equipo.
    const deskGroups = useMemo(
        () => isDesk ? getGroups().filter(g => (g.modulo || 'voltik') === 'volcan_desk') : [],
        [isDesk]
    );
    const canFilterByGroup = isDesk && (currentUser?.role === 'admin' || myGroups.length > 1);
    const [groupFilter, setGroupFilter] = useState('all');

    const [refreshTick, setRefreshTick] = useState(0);

    useEffect(() => {
        setUsers(getUsers());
    }, [activeWorkspace]);

    // getVisibleTickets lee de un cache en memoria que solo se llena una vez al
    // montar la app y solo se refresca mientras Solicitudes está abierta. Sin
    // esto, Reportes se queda con datos viejos si el usuario nunca visitó
    // Solicitudes — mismo fix aplicado en Dashboard.jsx.
    useEffect(() => {
        let cancelled = false;
        const refresh = async () => {
            try {
                await loadTicketsFromServer();
                if (!cancelled) {
                    setAllTickets(getVisibleTickets(currentUser, activeWorkspace));
                    setRefreshTick(t => t + 1);
                }
            } catch (err) {
                console.error('Error auto-actualizando tickets de reportes:', err);
            }
        };
        refresh();
        const interval = setInterval(refresh, 8000);
        return () => { cancelled = true; clearInterval(interval); };
    }, [isClient, currentUser?.companyId, activeWorkspace]);

    // Mismo recorte que el Dashboard: propio/grupo (solo Volcán Desk) + grupo
    // puntual (admin) + rango de fechas — reemplaza al viejo select "Último
    // mes" que no filtraba nada.
    const tickets = useMemo(() => {
        let result = allTickets;
        if (canScopeByGroup) {
            result = scope === 'mine'
                ? result.filter(t => isMyTicket(t, currentUser))
                : result.filter(t => isGroupTicket(t, myGroups));
        }
        if (canFilterByGroup && groupFilter !== 'all') {
            // Igual que en Dashboard: solo grupo RESOLUTOR, no isGroupTicket
            // (que también matchea area_origen_id, el grupo solicitante) —
            // así coincide con las columnas del Kanban de Solicitudes.
            result = result.filter(t => (t.resolver_group_id || t.group) === groupFilter);
        }
        if (dateFrom) {
            const from = parseLocalDate(dateFrom); from.setHours(0, 0, 0, 0);
            result = result.filter(t => new Date(t.createdAt) >= from);
        }
        if (dateTo) {
            const to = parseLocalDate(dateTo); to.setHours(23, 59, 59, 999);
            result = result.filter(t => new Date(t.createdAt) <= to);
        }
        return result;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [allTickets, canScopeByGroup, scope, myGroups, canFilterByGroup, groupFilter, dateFrom, dateTo, refreshTick]);

    // Agentes visibles en "Productividad por Agente": acotados al módulo activo
    // y, salvo para un admin sin grupo propio, a agentes que comparten grupo con
    // el usuario actual — antes se mostraban TODOS los agentes del sistema
    // (incluyendo los de Voltik) sin importar el rol de quien mira el reporte.
    const scopedAgents = useMemo(() => {
        const modulo = isDesk ? 'volcan_desk' : 'voltik';
        let agents = users.filter(u => u.role !== 'client' && (u.modulo || 'voltik') === modulo);
        if (isDesk && myGroups.length > 0) {
            agents = agents.filter(a => (a.groups || []).some(g => myGroups.includes(g)));
        }
        return agents;
    }, [users, isDesk, myGroups]);

    const getAgentStats = () => {
        return scopedAgents.map(agent => {
            const agentTickets = tickets.filter(t => t.assignedTo === agent.id || t.resolver_agent_id === agent.id);
            const resolved = agentTickets.filter(t => isTerminalStatus(t.status)).length;
            return {
                name: agent.name,
                total: agentTickets.length,
                resolved,
                resolutionRate: calculatePercentage(resolved, agentTickets.length)
            };
        }).sort((a, b) => b.resolved - a.resolved);
    };

    // Igual que en Dashboard: se agrupa por la etiqueta resuelta vía
    // resolvePriority(), no por valores fijos en inglés, porque Volcán Desk usa
    // sus propios values de prioridad por grupo ("baja", "baja__<grupoId>"...).
    const getPriorityDistribution = () => {
        const map = new Map();
        tickets.forEach(t => {
            const info = resolvePriority(t.priority);
            if (!map.has(info.label)) map.set(info.label, { label: info.label, color: info.color, count: 0 });
            map.get(info.label).count += 1;
        });
        const order = ['Baja', 'Media', 'Alta', 'Urgente'];
        return Array.from(map.values()).sort((a, b) => {
            const ia = order.indexOf(a.label), ib = order.indexOf(b.label);
            if (ia !== -1 && ib !== -1) return ia - ib;
            if (ia !== -1) return -1;
            if (ib !== -1) return 1;
            return a.label.localeCompare(b.label);
        });
    };

    // "Nuevos"/"En Progreso"/"Resueltos" via isTerminalStatus (workspace-agnostic)
    // en vez de literales de Voltik ('new'/'in progress'/'resolved'/'closed'),
    // que en Volcán Desk nunca hacían match y dejaban todo en 0.
    const getStatusDistribution = () => {
        const resolved = tickets.filter(t => isTerminalStatus(t.status)).length;
        const inProgress = tickets.filter(t => !isTerminalStatus(t.status) && t.status !== 'new' && t.status !== 'to_do').length;
        const nuevos = tickets.filter(t => t.status === 'new' || t.status === 'to_do').length;
        return { new: nuevos, inProgress, resolved };
    };


    const agentStats = getAgentStats();
    const priorityDist = getPriorityDistribution();
    const statusDist = getStatusDistribution();

    // SLA Computation
    const config = getConfig();

    let slaOk = 0, slaWarning = 0, slaBreached = 0;
    tickets.forEach(t => {
        const sla = computeSlaStatus(t, config);
        if (sla.status === 'ok') slaOk++;
        else if (sla.status === 'warning') slaWarning++;
        else if (sla.status === 'breached') slaBreached++;
    });

    const slaTotal = slaOk + slaWarning + slaBreached;
    const slaSuccessRate = slaTotal ? calculatePercentage(slaOk + slaWarning, slaTotal) : 100;

    return (
        <div className="reports-page">
            <div className="reports-header">
                <div>
                    <h1>Reportes</h1>
                    <p className="text-muted">Análisis y métricas del sistema</p>
                </div>
                <div className="reports-actions">
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

            <div className="reports-grid">
                <div className="card">
                    <div className="card-header">
                        <h3 className="card-title">
                            <IoStatsChartOutline />
                            Resumen General
                        </h3>
                    </div>
                    <div className="summary-stats">
                        <div className="summary-stat">
                            <span className="summary-label">Total Tickets</span>
                            <span className="summary-value">{tickets.length}</span>
                        </div>
                        <div className="summary-stat">
                            <span className="summary-label">Nuevos</span>
                            <span className="summary-value">{statusDist.new}</span>
                        </div>
                        <div className="summary-stat">
                            <span className="summary-label">En Progreso</span>
                            <span className="summary-value">{statusDist.inProgress}</span>
                        </div>
                        <div className="summary-stat">
                            <span className="summary-label">Resueltos</span>
                            <span className="summary-value">{statusDist.resolved}</span>
                        </div>
                        <div className="summary-stat">
                            <span className="summary-label">SLA Cumplimiento</span>
                            <span className="summary-value" style={{ color: slaSuccessRate >= 90 ? 'var(--color-success)' : 'var(--color-warning)' }}>
                                {slaSuccessRate}%
                            </span>
                        </div>
                    </div>
                </div>
                {!isClient && (
                    <div className="card">
                        <div className="card-header">
                            <h3 className="card-title">Productividad por Agente</h3>
                        </div>
                        <div className="agent-performance">
                            <table className="performance-table">
                                <thead>
                                    <tr>
                                        <th>Agente</th>
                                        <th>Total</th>
                                        <th>Resueltos</th>
                                        <th>Tasa</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {agentStats.map((agent, idx) => (
                                        <tr key={idx}>
                                            <td>{agent.name}</td>
                                            <td>{agent.total}</td>
                                            <td>{agent.resolved}</td>
                                            <td>
                                                <div className="progress-bar">
                                                    <div
                                                        className="progress-fill"
                                                        style={{ width: `${agent.resolutionRate}%` }}
                                                    />
                                                    <span className="progress-text">{agent.resolutionRate}%</span>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                    {agentStats.length === 0 && (
                                        <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>Sin agentes en este alcance.</td></tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                <div className="card">
                    <div className="card-header">
                        <h3 className="card-title">Distribución por Prioridad</h3>
                    </div>
                    <div className="priority-distribution">
                        {priorityDist.length ? priorityDist.map(item => (
                            <div key={item.label} className="dist-row">
                                <span className="dist-label">{item.label}</span>
                                <div className="dist-bar">
                                    <div
                                        className="dist-fill"
                                        style={{
                                            width: `${calculatePercentage(item.count, tickets.length)}%`,
                                            background: item.color
                                        }}
                                    />
                                </div>
                                <span className="dist-value">{item.count}</span>
                            </div>
                        )) : <div className="dist-row"><span className="dist-label">Sin datos</span></div>}
                    </div>
                </div>

                <div className="card">
                    <div className="card-header">
                        <h3 className="card-title">Métricas Clave</h3>
                    </div>
                    <div className="key-metrics">
                        <div className="metric-card">
                            <h4>En Tiempo (SLA)</h4>
                            <p className="metric-value">{slaOk}</p>
                            <span className="metric-label" style={{ color: 'var(--color-success)' }}>tickets</span>
                        </div>
                        <div className="metric-card">
                            <h4>En Peligro (SLA)</h4>
                            <p className="metric-value">{slaWarning}</p>
                            <span className="metric-label" style={{ color: 'var(--color-warning)' }}>tickets</span>
                        </div>
                        <div className="metric-card">
                            <h4>Vencidos (SLA)</h4>
                            <p className="metric-value">{slaBreached}</p>
                            <span className="metric-label" style={{ color: 'var(--color-error)' }}>tickets</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
