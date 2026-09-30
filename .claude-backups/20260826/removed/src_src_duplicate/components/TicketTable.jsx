import { formatRelativeTime, formatDateShort, formatDuration } from '../utils/helpers';
import { getUserById } from '../services/userService';
import { getCompanyById } from '../services/companyService';
import { computeSlaStatus } from '../services/ticketService';
import { getGroups } from '../services/groupService';
import { resolveStatus, getEtiquetaOptionsForStatus, MOTIVO_BLOQUEO_OPTIONS } from '../services/configService';
import './TicketTable.css';

const statusLabel = { new: 'Nuevo', 'in progress': 'En progreso', resolved: 'Resuelto', closed: 'Cerrado' };

export default function TicketTable({ tickets, onTicketClick, config, visibleColumns, currentUser, headerOverrides }) {
  const cols = visibleColumns || ['id', 'status', 'sla', 'assignedTo', 'updatedAt', 'group', 'category', 'priority'];

  const headers = {
    id: 'Ticket',
    status: 'Estado',
    sla: 'SLA',
    assignedTo: 'Asignado',
    updatedAt: 'Actualización',
    group: 'Grupo',
    category: 'Categoría',
    priority: 'Prioridad',
    requester: 'Solicitante',
    ...headerOverrides,
  };

  const getGridTemplateColumns = () => {
    let colStyles = [];
    cols.forEach(col => {
      if (col === 'id') {
        colStyles.push('minmax(250px, 2.5fr)');
      } else if (col === 'status') {
        colStyles.push('120px');
      } else if (col === 'sla') {
        colStyles.push('150px');
      } else if (col === 'assignedTo') {
        colStyles.push('140px');
      } else if (col === 'updatedAt') {
        colStyles.push('100px');
      } else if (col === 'group') {
        colStyles.push('120px');
      } else if (col === 'requester') {
        colStyles.push('140px');
      } else if (col === 'category') {
        colStyles.push('120px');
      } else if (col === 'priority') {
        colStyles.push('100px');
      }
    });
    colStyles.push('18px');
    return colStyles.join(' ');
  };

  const getGroupLabel = (val) => {
    if (!val) return 'Sin grupo';
    const found = getGroups().find(g => String(g.id) === String(val));
    return found ? (found.name || found.label || val) : val;
  };

  const getCategoryLabel = (val) => {
    if (!val) return 'Sin categoría';
    const foundCat = config?.categories?.find(c => String(c.id) === String(val));
    if (foundCat) return foundCat.name || foundCat.label;
    const foundType = config?.types?.find(t => String(t.id) === String(val));
    if (foundType) return foundType.name || foundType.label;
    return val;
  };

  const gridStyle = getGridTemplateColumns();

  return (
    <div className="ticket-table-container">
      <div className="proposal-table-head" style={{ gridTemplateColumns: gridStyle }}>
        {cols.map(col => (
          <span key={col}>{headers[col] || col}</span>
        ))}
        <span></span>
      </div>
      <div>
        {tickets.length ? (
          tickets.map(ticket => {
            const sla = computeSlaStatus(ticket, config);
            const company = getCompanyById(ticket.companyId);
            const agent = getUserById(ticket.assignedTo);
            
            const brandName = config?.brandName || 'Voltik';
            const isClosedOrResolved = ticket.status === 'resolved' || ticket.status === 'closed';

            // Un ticket "nace" pendiente y sin responsable — antes se veía
            // igual que cualquier otro "Pendiente" ya tomado, así que era
            // fácil perderlo en la tabla. Se marca explícitamente como
            // "Nuevo · Sin asignar" y se resalta la fila (doc feedback:
            // los pendientes deben nacer con esa etiqueta).
            const isNewUnassigned = ticket.ambito === 'interno'
                && ticket.status === 'to_do'
                && !ticket.assignedTo && !ticket.resolver_agent_id;

            // Determine reading state and text based on role
            let hasPendingAction = false;
            let helperText = '';

            if (currentUser?.role === 'client') {
              hasPendingAction = ticket.ultimo_mensaje_de === 'agente' && !ticket.visto_por_cliente && !isClosedOrResolved;
              if (ticket.ultimo_mensaje_de === 'agente') {
                helperText = `${brandName} respondió`;
              } else if (ticket.ultimo_mensaje_de === 'cliente') {
                helperText = `En revisión por ${brandName}`;
              } else {
                helperText = 'Actualizado por el sistema';
              }          
            } else {
              // Volcán Desk (ambito 'interno') no tiene "cliente" — el que
              // levanta la solicitud es el "solicitante". Voltik conserva
              // "cliente" tal cual.
              const counterpart = ticket.ambito === 'interno' ? 'solicitante' : 'cliente';
              hasPendingAction = ticket.ultimo_mensaje_de === 'cliente' && !ticket.visto_por_agente && !isClosedOrResolved;
              if (ticket.ultimo_mensaje_de === 'cliente') {
                helperText = ticket.ambito === 'interno' ? 'Solicitante respondió' : 'Cliente respondió';
              } else if (ticket.ultimo_mensaje_de === 'agente') {
                if (ticket.assignedTo === currentUser?.id || ticket.resolver_agent_id === currentUser?.id) {
                  helperText = `Tú respondiste, esperando ${counterpart}`;
                } else {
                  helperText = `${agent?.name || 'Agente'} respondió, esperando ${counterpart}`;
                }
              } else {
                helperText = `Sistema actualizó, esperando ${counterpart}`;
              }
            }

            const formatTime = (min) => {
              if (min < 60) return `${min} min`;
              const hrs = (min / 60).toFixed(1);
              return hrs.endsWith('.0') ? `${Math.round(min / 60)}h` : `${hrs}h`;
            };
            
            const slaText = sla.isTerminated ? 'SLA pausado' : 
                            sla.status === 'breached' ? `Vencido hace ${formatTime(Math.max(1, sla.elapsedMinutes - sla.targetMinutes))}` : 
                            sla.status === 'warning' ? `Vence pronto` : 
                            `Vence en ${formatTime(Math.max(1, sla.targetMinutes - sla.elapsedMinutes))}`;

            return (
              <button
                className={`proposal-ticket-row ${hasPendingAction ? 'waiting-response-highlight' : ''} ${isNewUnassigned ? 'new-unassigned-highlight' : ''}`}
                key={ticket.id}
                onClick={() => onTicketClick(ticket)}
                style={{ gridTemplateColumns: gridStyle }}
              >
                {cols.map(col => {
                  switch (col) {
                    case 'id':
                      return (
                        <span key="id" className="proposal-ticket-name" style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'center', height: '100%' }}>
                          <span className="priority-mark" style={{ background: config?.priorities?.find(p => p.value === ticket.priority)?.color || '#8b97a9' }}></span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%' }}>
                            {hasPendingAction && (
                              <span 
                                className="indicator-dot" 
                                style={{ 
                                  display: 'inline-block', 
                                  width: '8px', 
                                  height: '8px', 
                                  borderRadius: '50%', 
                                  backgroundColor: '#0066CC', 
                                  flexShrink: 0 
                                }}
                              ></span>
                            )}
                            <strong style={{ fontWeight: hasPendingAction ? '600' : '500' }}>{ticket.title}</strong>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px', flexWrap: 'wrap' }}>
                            <small>#{ticket.id} · {ticket.ambito === 'interno' ? getGroupLabel(ticket.group) : (company?.name || 'Sin empresa')}</small>
                            <span 
                              style={{ 
                                fontSize: '11px', 
                                color: hasPendingAction ? '#0066CC' : '#64748b', 
                                fontWeight: hasPendingAction ? '600' : '400' 
                              }}
                            >
                              · {helperText}
                            </span>
                          </div>
                          {ticket.ambito === 'interno' && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '3px', flexWrap: 'wrap', fontSize: '10.5px', color: '#8592a6' }}>
                              <span>⏱ En proceso: {formatDuration(ticket.createdAt, ticket.fecha_resolucion || undefined)}</span>
                              {(ticket.fecha_estimada_inicio || ticket.fecha_estimada_conclusion) && (
                                <span>
                                  · {ticket.fecha_estimada_inicio ? formatDateShort(ticket.fecha_estimada_inicio) : '—'}
                                  {' → '}
                                  {ticket.fecha_estimada_conclusion ? formatDateShort(ticket.fecha_estimada_conclusion) : '—'}
                                </span>
                              )}
                            </div>
                          )}
                        </span>
                      );
                    case 'status': {
                      // Volcán Desk: el estado principal nunca se reemplaza, pero se
                      // complementa con el subestado (etiquetas) y/o el motivo de
                      // bloqueo activos, ej. "Under Review · Esperando aprobación".
                      let subLabel = null;
                      if (ticket.ambito === 'interno') {
                        if (ticket.bloqueado) {
                          subLabel = MOTIVO_BLOQUEO_OPTIONS.find(o => o.value === ticket.motivo_bloqueo)?.label || 'Bloqueado';
                        } else if ((ticket.etiquetas || []).length > 0) {
                          const opts = getEtiquetaOptionsForStatus(ticket.status);
                          subLabel = ticket.etiquetas.map(e => opts.find(o => o.value === e)?.label || e).join(', ');
                        } else if (isNewUnassigned) {
                          // Los tickets nuevos ya nacen con la etiqueta
                          // 'nuevo_sin_asignar' (ticketService.createTicket),
                          // pero este fallback cubre tickets creados antes de
                          // ese cambio o a los que alguien les quitó la
                          // etiqueta manualmente — mismo texto que usa el
                          // catálogo de subestados, para no duplicar redacción.
                          subLabel = 'Nuevo / Sin asignar';
                        }
                      }
                      return (
                        <span key="status" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <i className={`status-pill status-${ticket.status?.replace(' ', '-')} ${isNewUnassigned ? 'status-new-unassigned' : ''}`}>
                            {ticket.ambito === 'interno' ? resolveStatus(ticket.status).label : (statusLabel[ticket.status] || ticket.status)}
                            {subLabel ? ` · ${subLabel}` : ''}
                          </i>
                        </span>
                      );
                    }
                    case 'sla':
                      return (
                        <span key="sla" className={`sla-copy ${sla.status}`}>
                          <b></b>{slaText}
                        </span>
                      );
                    case 'assignedTo':
                      return (
                        <span key="assignedTo" className={!agent ? 'unassigned' : ''}>
                          {agent?.name || 'Sin asignar'}
                        </span>
                      );
                    case 'updatedAt':
                      return (
                        <span key="updatedAt" className="update-copy">
                          {formatRelativeTime(ticket.updatedAt)}
                        </span>
                      );
                    case 'group':
                      return (
                        <span key="group" className="group-copy" style={{ fontSize: '12px', color: '#475569' }}>
                          {getGroupLabel(ticket.group)}
                        </span>
                      );
                    case 'requester': {
                      const requester = getUserById(ticket.createdBy);
                      return (
                        <span key="requester" className="group-copy" style={{ fontSize: '12px', color: '#475569' }}>
                          {requester?.name || 'Desconocido'}
                        </span>
                      );
                    }
                    case 'category':
                      return (
                        <span key="category" className="category-copy" style={{ fontSize: '12px', color: '#475569' }}>
                          {getCategoryLabel(ticket.category)}
                        </span>
                      );
                    case 'priority': {
                      const pConf = config?.priorities?.find(p => p.value === ticket.priority);
                      return (
                        <span key="priority" className="priority-cell" style={{ fontSize: '12px', fontWeight: '500', color: pConf?.color || undefined }}>
                          <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: pConf?.color || '#8b97a9', marginRight: 6 }} />
                          {pConf?.label || ticket.priority}
                        </span>
                      );
                    }
                    default:
                      return <span key={col}>-</span>;
                  }
                })}
                <span className="row-arrow">›</span>
              </button>
            );
          })
        ) : (
          <div className="proposal-empty">
            <strong>No hay tickets para mostrar</strong>
            <span>Prueba otra vista o limpia los filtros.</span>
          </div>
        )}
      </div>
    </div>
  );
}
