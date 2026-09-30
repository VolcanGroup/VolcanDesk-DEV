import { getUserById } from '../services/userService';
import { getGroups } from '../services/groupService';
import { formatDateShort } from '../utils/helpers';
import './CronogramaView.css';

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_WIDTH = 34; // px por día en la línea de tiempo

const toDate = (d) => new Date(typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00` : d);
const daysBetween = (a, b) => Math.round((b - a) / DAY_MS);

export default function CronogramaView({ tickets, config, onTicketClick }) {
    const groups = getGroups();

    const scheduled = tickets.filter(t => t.fecha_estimada_inicio && t.fecha_estimada_conclusion);
    const unscheduled = tickets.filter(t => !t.fecha_estimada_inicio || !t.fecha_estimada_conclusion);

    if (scheduled.length === 0) {
        return (
            <div className="cronograma-empty">
                <strong>No hay tickets con fechas estimadas todavía.</strong>
                <span>Abre un ticket y define su Fecha estimada de inicio / conclusión para verlo aquí.</span>
                {unscheduled.length > 0 && (
                    <div className="cronograma-unscheduled-list">
                        {unscheduled.map(t => (
                            <button key={t.id} className="cronograma-unscheduled-item" onClick={() => onTicketClick(t)}>
                                {t.title} <span>#{t.id}</span>
                            </button>
                        ))}
                    </div>
                )}
            </div>
        );
    }

    const rows = scheduled
        .map(t => ({
            ticket: t,
            start: toDate(t.fecha_estimada_inicio),
            end: toDate(t.fecha_estimada_conclusion),
        }))
        .map(r => (r.start <= r.end ? r : { ...r, start: r.end, end: r.start }))
        .sort((a, b) => a.start - b.start);

    const rangeStart = new Date(Math.min(...rows.map(r => r.start)));
    const rangeEnd = new Date(Math.max(...rows.map(r => r.end)));
    const totalDays = Math.max(1, daysBetween(rangeStart, rangeEnd) + 1);
    const timelineWidth = totalDays * DAY_WIDTH;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayOffset = daysBetween(rangeStart, today);
    const showTodayMarker = todayOffset >= 0 && todayOffset <= totalDays;

    // Encabezado: una marca por semana (lunes) dentro del rango
    const weekTicks = [];
    const cursor = new Date(rangeStart);
    while (cursor <= rangeEnd) {
        if (cursor.getDay() === 1 || cursor.getTime() === rangeStart.getTime()) {
            weekTicks.push({ offset: daysBetween(rangeStart, cursor), date: new Date(cursor) });
        }
        cursor.setDate(cursor.getDate() + 1);
    }

    const getGroupLabel = (val) => {
        if (!val) return 'Sin grupo';
        const found = groups.find(g => String(g.id) === String(val));
        return found ? (found.name || found.label || val) : val;
    };

    return (
        <div className="cronograma-wrapper">
            <div className="cronograma-grid">
                <div className="cronograma-labels-col">
                    <div className="cronograma-labels-header">Ticket</div>
                    {rows.map(({ ticket }) => {
                        const agent = getUserById(ticket.resolver_agent_id || ticket.assignedTo);
                        const pConf = config?.priorities?.find(p => p.value === ticket.priority);
                        return (
                            <button key={ticket.id} className="cronograma-label-row" onClick={() => onTicketClick(ticket)}>
                                <span className="cronograma-label-dot" style={{ background: pConf?.color || '#8b97a9' }} />
                                <span className="cronograma-label-text">
                                    <strong>{ticket.title}</strong>
                                    <small>{getGroupLabel(ticket.group)} · {agent?.name || 'Sin asignar'}</small>
                                </span>
                            </button>
                        );
                    })}
                </div>

                <div className="cronograma-timeline-col">
                    <div className="cronograma-timeline-scroll">
                        <div className="cronograma-timeline-inner" style={{ width: timelineWidth }}>
                            <div className="cronograma-timeline-header">
                                {weekTicks.map((wt, i) => (
                                    <div key={i} className="cronograma-week-tick" style={{ left: wt.offset * DAY_WIDTH }}>
                                        {wt.date.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}
                                    </div>
                                ))}
                            </div>
                            <div className="cronograma-timeline-body" style={{ height: rows.length * 52 }}>
                                {weekTicks.map((wt, i) => (
                                    <div key={i} className="cronograma-gridline" style={{ left: wt.offset * DAY_WIDTH }} />
                                ))}
                                {showTodayMarker && (
                                    <div className="cronograma-today-line" style={{ left: todayOffset * DAY_WIDTH }} title="Hoy" />
                                )}
                                {rows.map(({ ticket, start, end }, i) => {
                                    const left = daysBetween(rangeStart, start) * DAY_WIDTH;
                                    const width = Math.max(DAY_WIDTH, (daysBetween(start, end) + 1) * DAY_WIDTH - 6);
                                    const pConf = config?.priorities?.find(p => p.value === ticket.priority);
                                    return (
                                        <button
                                            key={ticket.id}
                                            className="cronograma-bar"
                                            style={{ top: i * 52 + 10, left, width, background: pConf?.color || '#8b97a9' }}
                                            title={`${ticket.title} — ${formatDateShort(ticket.fecha_estimada_inicio)} → ${formatDateShort(ticket.fecha_estimada_conclusion)}`}
                                            onClick={() => onTicketClick(ticket)}
                                        >
                                            <span>{formatDateShort(ticket.fecha_estimada_inicio)} → {formatDateShort(ticket.fecha_estimada_conclusion)}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {unscheduled.length > 0 && (
                <div className="cronograma-unscheduled">
                    <div className="cronograma-unscheduled-title">Sin fechas estimadas ({unscheduled.length})</div>
                    <div className="cronograma-unscheduled-list">
                        {unscheduled.map(t => (
                            <button key={t.id} className="cronograma-unscheduled-item" onClick={() => onTicketClick(t)}>
                                {t.title} <span>#{t.id}</span>
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
