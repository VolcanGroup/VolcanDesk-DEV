import { useState } from 'react';
import { IoChatbubbleOutline, IoLockClosedOutline } from 'react-icons/io5';
import { INTERNAL_STATUSES, MOTIVO_BLOQUEO_OPTIONS, resolvePriority } from '../services/configService';
import { getGroups } from '../services/groupService';
import { getUserById } from '../services/userService';
import { formatDuration, formatDateShort } from '../utils/helpers';
import './KanbanBoard.css';

// Color determinístico y estable para un valor de catálogo (área/categoría/tipo),
// sin necesitar una columna nueva en base de datos: mismo string -> mismo color siempre.
const PALETTE = ['#0066CC', '#34c759', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#ec4899', '#10b981', '#f97316', '#6366f1'];
const colorForValue = (value) => {
    if (!value) return '#94a3b8';
    let hash = 0;
    for (let i = 0; i < value.length; i++) hash = value.charCodeAt(i) + ((hash << 5) - hash);
    return PALETTE[Math.abs(hash) % PALETTE.length];
};

// "area" puede significar el grupo SOLICITANTE o el RESOLUTOR según qué eje se
// esté viendo — en "Solicitudes Recibidas" el resolutor eres siempre tú/tu
// grupo (fijo), así que lo único que varía y vale la pena agrupar/etiquetar es
// quién lo pidió (area_origen_id); en "Enviadas" es al revés (2026-09-07,
// reportado en vivo: "Agrupar por Área destino" en Recibidas agrupaba todo en
// una sola columna porque el destino siempre era el mismo grupo).
const getAreaGroupId = (ticket, areaAxis) => areaAxis === 'origen' ? ticket.area_origen_id : (ticket.resolver_group_id || ticket.group);

// En Volcán Desk cada grupo tiene su propio catálogo de prioridades con
// "value" distinto por grupo (ej. "media" para un grupo, "media__<grupoId>"
// para otro) — agrupar/columnas por value crudo generaba columnas duplicadas
// "Baja"/"Media"/"Alta" (una por grupo) y dejaba vacías las que no coincidían
// con el grupo del ticket (reportado en vivo 2026-09-07). Se agrupa por la
// ETIQUETA resuelta (mismo criterio ya usado en Dashboard.jsx), que es lo que
// el usuario realmente ve y espera que unifique "Media" sin importar el grupo.
const PRIORITY_ORDER = ['Baja', 'Media', 'Alta', 'Urgente'];
const getColumnKey = (ticket, groupBy, areaAxis) => {
    switch (groupBy) {
        case 'area': return getAreaGroupId(ticket, areaAxis) || '__none__';
        case 'priority': return resolvePriority(ticket.priority).label || '__none__';
        case 'assignee': return ticket.resolver_agent_id || ticket.assignedTo || '__none__';
        default: return ticket.status || 'to_do';
    }
};

export default function KanbanBoard({ tickets, users, config, groupBy, areaAxis = 'resolutor', onUpdateStatus, onTicketClick }) {
    const [draggedId, setDraggedId] = useState(null);
    const groups = getGroups().filter(g => (g.modulo || 'voltik') === 'volcan_desk');
    const agents = users.filter(u => u.role === 'admin' || u.role === 'agent');

    const columns = (() => {
        if (groupBy === 'area') {
            return [...groups.map(g => ({ id: g.id, label: g.name })), { id: '__none__', label: 'Sin área' }];
        }
        if (groupBy === 'priority') {
            const seen = new Map();
            (config.priorities || []).forEach(p => { if (!seen.has(p.label)) seen.set(p.label, true); });
            const labels = Array.from(seen.keys()).sort((a, b) => {
                const ia = PRIORITY_ORDER.indexOf(a), ib = PRIORITY_ORDER.indexOf(b);
                if (ia !== -1 && ib !== -1) return ia - ib;
                if (ia !== -1) return -1;
                if (ib !== -1) return 1;
                return a.localeCompare(b);
            });
            return [...labels.map(l => ({ id: l, label: l })), { id: '__none__', label: 'Sin prioridad' }];
        }
        if (groupBy === 'assignee') {
            return [...agents.map(a => ({ id: a.id, label: a.name })), { id: '__none__', label: 'Sin asignar' }];
        }
        // Estado: catálogo fijo, siempre las 5 columnas aunque estén vacías
        return INTERNAL_STATUSES.map(s => ({ id: s.id, label: s.label }));
    })();

    const canDrag = groupBy === 'status';

    const handleDrop = (e, columnId) => {
        e.preventDefault();
        if (!canDrag || !draggedId) { setDraggedId(null); return; }
        const ticket = tickets.find(t => t.id === draggedId);
        if (ticket && ticket.status !== columnId) {
            if (columnId === 'done' && ticket.bloqueado) {
                alert('Este ticket está bloqueado. Desbloquéalo antes de moverlo a Terminado.');
                setDraggedId(null);
                return;
            }
            onUpdateStatus(draggedId, columnId);
        }
        setDraggedId(null);
    };

    // Red de seguridad: si el usuario suelta la tarjeta fuera de una columna
    // (en el espacio entre columnas, en el padding del scroll, etc.), el navegador
    // toma el control del drop por defecto — en algunos casos eso puede navegar
    // fuera de la app (p. ej. si el drag empezó sobre el avatar/imagen de la
    // tarjeta), dejando la SPA en un estado del que solo se sale refrescando.
    // Interceptamos dragover/drop en todo el contenedor para que eso nunca pase.
    const swallowDragOver = (e) => { if (canDrag) e.preventDefault(); };
    const swallowDrop = (e) => {
        e.preventDefault();
        setDraggedId(null);
    };

    return (
        <div className="kboard-scroll" onDragOver={swallowDragOver} onDrop={swallowDrop}>
            <div className="kboard-columns">
                {columns.map(col => {
                    const colTickets = tickets.filter(t => getColumnKey(t, groupBy, areaAxis) === col.id);
                    return (
                        <div
                            key={col.id}
                            className="kboard-column"
                            onDragOver={(e) => canDrag && e.preventDefault()}
                            onDrop={(e) => handleDrop(e, col.id)}
                        >
                            <div className="kboard-column-header">
                                <span className="kboard-column-title">{col.label}</span>
                                <span className="kboard-column-count">{colTickets.length}</span>
                            </div>
                            <div className="kboard-column-body">
                                {colTickets.map(ticket => {
                                    const areaGroupId = getAreaGroupId(ticket, areaAxis);
                                    const areaLabel = groups.find(g => g.id === areaGroupId)?.name || areaGroupId;
                                    const catLabel = config.categories?.find(c => c.id === ticket.category)?.label || config.types?.find(t => t.id === ticket.category)?.label;
                                    const resolver = getUserById(ticket.resolver_agent_id || ticket.assignedTo);
                                    const commentCount = (ticket.comments || []).length;
                                    const motivoLabel = MOTIVO_BLOQUEO_OPTIONS.find(o => o.value === ticket.motivo_bloqueo)?.label || ticket.motivo_bloqueo;

                                    return (
                                        <div
                                            key={ticket.id}
                                            className="kboard-card"
                                            draggable={canDrag}
                                            onDragStart={(e) => {
                                                if (!canDrag) return;
                                                // dataTransfer explícito: evita que el navegador recurra a su propio
                                                // comportamiento de arrastre (p. ej. sobre un <img> de avatar interno)
                                                e.dataTransfer.effectAllowed = 'move';
                                                e.dataTransfer.setData('text/plain', ticket.id);
                                                setDraggedId(ticket.id);
                                            }}
                                            onDragEnd={() => setDraggedId(null)}
                                            onClick={() => onTicketClick(ticket)}
                                            style={{ borderLeftColor: config.priorities?.find(p => p.value === ticket.priority)?.color || '#94a3b8' }}
                                        >
                                            <div className="kboard-card-title">{ticket.title}</div>
                                            <div className="kboard-card-tags">
                                                {areaLabel && (
                                                    <span className="kboard-tag" style={{ background: `${colorForValue(areaLabel)}22`, color: colorForValue(areaLabel) }}>
                                                        {areaLabel}
                                                    </span>
                                                )}
                                                {catLabel && (
                                                    <span className="kboard-tag" style={{ background: `${colorForValue(catLabel)}22`, color: colorForValue(catLabel) }}>
                                                        {catLabel}
                                                    </span>
                                                )}
                                            </div>
                                            <div style={{ fontSize: '10.5px', color: '#8592a6', margin: '4px 0', display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' }}>
                                                <span>⏱ {formatDuration(ticket.createdAt, ticket.fecha_resolucion || undefined)}</span>
                                                {(ticket.fecha_estimada_inicio || ticket.fecha_estimada_conclusion) && (
                                                    <span>
                                                        · {ticket.fecha_estimada_inicio ? formatDateShort(ticket.fecha_estimada_inicio) : '—'}
                                                        {' → '}
                                                        {ticket.fecha_estimada_conclusion ? formatDateShort(ticket.fecha_estimada_conclusion) : '—'}
                                                    </span>
                                                )}
                                            </div>
                                            {ticket.bloqueado && (
                                                <div className="kboard-blocked-badge">
                                                    <IoLockClosedOutline size={11} /> Bloqueado{motivoLabel ? ` · ${motivoLabel}` : ''}
                                                </div>
                                            )}
                                            <div className="kboard-card-footer">
                                                <div className="kboard-card-comments">
                                                    <IoChatbubbleOutline size={13} /> {commentCount}
                                                </div>
                                                <div className="kboard-card-avatar" title={resolver?.name || 'Sin asignar'}>
                                                    {resolver?.avatar
                                                        ? <img src={resolver.avatar} alt={resolver.name} />
                                                        : <span>{(resolver?.name || '??').substring(0, 2).toUpperCase()}</span>
                                                    }
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                                {colTickets.length === 0 && (
                                    <div className="kboard-empty">Sin solicitudes</div>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
