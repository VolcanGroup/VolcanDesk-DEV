import { formatRelativeTime, formatDateShort, formatDuration } from '../utils/helpers';
import { getUserById } from '../services/userService';
import { getCompanyById } from '../services/companyService';
import { computeSlaStatus } from '../services/ticketService';
import { getGroups } from '../services/groupService';
import { resolveStatus, getEtiquetaOptionsForStatus, MOTIVO_BLOQUEO_OPTIONS } from '../services/configService';
import { getEstadoAgrupacion, sortByUrgency, parseApoyos } from '../services/ticketService';
import { IoChevronDownOutline, IoChevronForwardOutline } from 'react-icons/io5';
import { useState } from 'react';
import './TicketTable.css';

const statusLabel = { new: 'Nuevo', 'in progress': 'En progreso', resolved: 'Resuelto', closed: 'Cerrado' };

export default function TicketTable({ tickets, onTicketClick, config, visibleColumns, currentUser, headerOverrides }) {
  const [collapsedSections, setCollapsedSections] = useState({});
  const toggleSection = (sectionId) => {
    setCollapsedSections(prev => ({ ...prev, [sectionId]: !prev[sectionId] }));
  };
  const cols = visibleColumns || ['id', 'status', 'sla', 'assignedTo', 'updatedAt', 'group', 'category', 'priority'];

  const headers = {
    id: 'Ticket',
    status: 'Estado',
    subestado: 'Sub-estado',
    sla: 'SLA',
    assignedTo: 'Asignado',
    updatedAt: 'Actualización',
    createdAt: 'Fecha de creación',
    group: 'Grupo',
    requesterGroup: 'Grupo solicitante',
    type: 'Tipo',
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
        colStyles.push('170px');
      } else if (col === 'assignedTo') {
        colStyles.push('140px');
      } else if (col === 'updatedAt') {
        colStyles.push('100px');
      } else if (col === 'createdAt') {
        colStyles.push('100px');
      } else if (col === 'group') {
        colStyles.push('120px');
      } else if (col === 'requesterGroup') {
        colStyles.push('120px');
      } else if (col === 'type') {
        colStyles.push('110px');
      } else if (col === 'subestado') {
        colStyles.push('130px');
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

  const getTypeLabel = (val) => {
    if (!val) return 'Sin tipo';
    const found = config?.types?.find(t => String(t.id) === String(val));
    return found ? (found.name || found.label) : val;
  };

  const renderTicketRow = (ticket) => {
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

            const ticketApoyos = parseApoyos(ticket);
            const resolverGroupId = ticket.resolver_group_id || ticket.group;
            const userGroups = currentUser?.groups || [];
            const userAdminGroup = currentUser?.role === 'group_admin' ? currentUser?.admin_group_id : null;
            const isOwnerGroup = currentUser?.role === 'admin' || userGroups.includes(resolverGroupId) || userAdminGroup === resolverGroupId;
            const resolvedApoyos = isOwnerGroup ? ticketApoyos.filter(a => a.status === 'Resuelto') : [];
            const hasResolvedApoyo = resolvedApoyos.length > 0;

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

            // Bloqueado tiene prioridad sobre cualquier otro texto de SLA — mientras
            // está pausado no tiene caso seguir diciendo "Vencido hace X"/"Vence en X"
            // (el cálculo ya excluye ese tiempo, pero el texto seguía sonando a que
            // corre). En cuanto se reactiva, vuelve a mostrar el conteo normal. Si el
            // grupo tiene un tope de pausa ("Stop SLA") y ya se superó, el SLA vuelve
            // a correr solo aunque el ticket siga marcado como Bloqueado.
            const isEffectivelyPaused = ticket.bloqueado && !sla.bloqueoCapExceeded;
            const slaText = isEffectivelyPaused ? 'PAUSADO' :
                            sla.isTerminated ? 'Finalizado' :
                            sla.targetMinutes === null ? 'Sin SLA' :
                            sla.targetMinutes === 0 ? 'Sin límite' :
                            sla.status === 'breached' ? `Vencido hace ${formatTime(Math.max(1, sla.elapsedMinutes - sla.targetMinutes))}` :
                            sla.status === 'warning' ? `Vence pronto` :
                            `Vence en ${formatTime(Math.max(1, sla.targetMinutes - sla.elapsedMinutes))}`;

            // Un ticket bloqueado/pausado no debe competir visualmente con los que sí
            // necesitan acción — se desvanece en vez de resaltarse, para que salte a
            // la vista que está en pausa sin usar otro color más en la bandeja.
            const isPaused = isEffectivelyPaused;
            const shouldHighlight = !isPaused && (ticket.status === 'to_do' || hasPendingAction || isNewUnassigned);

            return (

            <button

            className={`proposal-ticket-row ${shouldHighlight ? 'action-required-highlight' : ''} ${isPaused ? 'row-paused' : ''}`}
                key={ticket.id}
                onClick={() => onTicketClick(ticket)}
                style={{ gridTemplateColumns: gridStyle }}
              >
                {cols.map(col => {
                  switch (col) {
                    case 'id':
                      return (
                        <span key="id" className="proposal-ticket-name" style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'center', height: '100%' }}>

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
                      // Volcán Desk: el estado principal nunca se reemplaza. La etiqueta
                      // (subestado) tiene su propia columna dedicada ("subestado", más abajo)
                      // desde que se unificaron las columnas de Volcán Desk — mostrarla
                      // también aquí duplicaba la misma info en dos columnas a la vez
                      // (reportado en vivo 2026-09-07). Solo el motivo de bloqueo se queda
                      // aquí, porque no tiene columna propia.
                      let subLabel = null;
                      if (ticket.ambito === 'interno' && ticket.bloqueado) {
                        subLabel = MOTIVO_BLOQUEO_OPTIONS.find(o => o.value === ticket.motivo_bloqueo)?.label || 'Bloqueado';
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
                        <span key="sla" className={`sla-copy ${sla.status} ${isEffectivelyPaused ? 'sla-paused' : ''}`}>
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
                    case 'createdAt':
                      return (
                        <span key="createdAt" className="update-copy">
                          {formatDateShort(ticket.createdAt)}
                        </span>
                      );
                    case 'group':
                      // resolver_group_id es la fuente de verdad — ticket.group puede
                      // venir como NOMBRE en vez de id en tickets viejos/reasignados
                      // (mismo patrón recurrente documentado en CLAUDE.md).
                      return (
                        <span key="group" className="group-copy" style={{ fontSize: '12px', color: '#475569' }}>
                          {getGroupLabel(ticket.resolver_group_id || ticket.group)}
                        </span>
                      );
                    case 'requesterGroup':
                      return (
                        <span key="requesterGroup" className="group-copy" style={{ fontSize: '12px', color: '#475569' }}>
                          {getGroupLabel(ticket.area_origen_id)}
                        </span>
                      );
                    case 'type':
                      return (
                        <span key="type" className="category-copy" style={{ fontSize: '12px', color: '#475569' }}>
                          {getTypeLabel(ticket.type)}
                        </span>
                      );
                    case 'subestado': {
                      const etiquetaOptions = getEtiquetaOptionsForStatus(ticket.status);
                      const labels = (ticket.etiquetas || []).map(e => etiquetaOptions.find(o => o.value === e)?.label || e);
                      return (
                        <span key="subestado" style={{ fontSize: '12px', color: '#475569' }}>
                          {labels.length > 0 ? labels.join(', ') : '—'}
                        </span>
                      );
                    }
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

  };

  const gridStyle = getGridTemplateColumns();

  return (
    <div className="ticket-table-container">
      {/* Volcán Desk unificó las columnas a un set más ancho (11 en la vista "Todos")
          que no cabe en pantallas chicas. Un wrapper interno con su propio scroll
          (probado primero, 2026-09-07) sí scrolleaba, pero su barra quedaba al
          fondo de TODAS las filas — invisible/inalcanzable sin bajar primero toda
          la página (reportado en vivo el mismo día). El scroll real vive aquí, en
          .ticket-table-container: ya recibe overflow:auto + flex:1 heredado de
          Tickets.css (".tickets-main > div:last-child", más específico que el
          overflow:hidden propio de esta clase) — o sea que YA está acotado al alto
          visible de la pantalla; solo hacía falta min-width:0 (ver abajo) para que
          en vez de crecer hacia afuera, de verdad scrollee aquí mismo. */}
      <div className="proposal-table-head" style={{ gridTemplateColumns: gridStyle }}>
        {cols.map(col => (
          <span key={col}>{headers[col] || col}</span>
        ))}
        <span></span>
      </div>
      <div>
        {tickets.length ? (() => {

          const isVolcanDesk = tickets.some(t => (t.ambito || 'externo') === 'interno');
          if (!isVolcanDesk) {
              return tickets.map(renderTicketRow);
          }

          const myGroups = currentUser?.role === 'group_admin' ? [currentUser.admin_group_id].filter(Boolean) : (currentUser?.groups || []);

          const SECTION_ORDER = [
              'Apoyo · Pendiente',
              'to_do',
              'Apoyo · En progreso',
              'on_going',
              'in_testing',
              'under_review',
              'done',
              'Apoyo · Resuelto'
          ];
          const SECTION_NAMES = {
              'Apoyo · Pendiente': 'Apoyo · Pendiente',
              'to_do': 'Pendiente',
              'Apoyo · En progreso': 'Apoyo · En progreso',
              'on_going': 'En ejecución',
              'in_testing': 'Pruebas técnicas',
              'under_review': 'Revisión',
              'done': 'Terminado',
              'Apoyo · Resuelto': 'Apoyo · Resuelto'
          };
          const SECTION_COLORS = {
              'Apoyo · Pendiente': '#ef4444',
              'to_do': '#f59e0b',
              'Apoyo · En progreso': '#3b82f6',
              'on_going': '#3b82f6',
              'in_testing': '#8b5cf6',
              'under_review': '#f59e0b',
              'done': '#10b981',
              'Apoyo · Resuelto': '#10b981'
          };

          const grouped = {};
          SECTION_ORDER.forEach(s => grouped[s] = []);
          grouped['Otros'] = [];

          tickets.forEach(t => {
              let estadoAgrupacion = getEstadoAgrupacion(t, currentUser, myGroups);
              if (!SECTION_ORDER.includes(estadoAgrupacion)) {
                  estadoAgrupacion = 'Otros';
              }
              if (!grouped[estadoAgrupacion]) {
                  grouped[estadoAgrupacion] = [];
              }
              grouped[estadoAgrupacion].push(t);
          });

          Object.keys(grouped).forEach(k => {
              grouped[k].sort((a, b) => sortByUrgency(a, b, config));
          });

          return SECTION_ORDER.concat(['Otros']).filter(k => grouped[k] && grouped[k].length > 0).map(groupKey => {
              const groupTickets = grouped[groupKey];
              const isCollapsed = collapsedSections[groupKey];
              return (
                  <div key={groupKey} className="ticket-group-section" style={{ marginBottom: '32px', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05)' }}>
                      <div className="ticket-group-header" onClick={() => toggleSection(groupKey)} style={{ display: 'flex', alignItems: 'center', padding: '10px 16px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', borderTop: '1px solid #e2e8f0', cursor: 'pointer', gap: '8px', fontSize: '13px', fontWeight: 600, color: '#334155', borderRadius: isCollapsed ? '6px' : '6px 6px 0 0' }}>
                          {isCollapsed ? <IoChevronForwardOutline /> : <IoChevronDownOutline />}
                          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: SECTION_COLORS[groupKey] || '#94a3b8' }}></span>
                          {SECTION_NAMES[groupKey] || groupKey}
                          <span style={{ background: '#e2e8f0', padding: '2px 8px', borderRadius: 12, fontSize: '11px', color: '#64748b', marginLeft: 'auto' }}>{groupTickets.length}</span>
                      </div>
                      {!isCollapsed && (
                          <div className="ticket-group-content" style={{ border: '1px solid #e2e8f0', borderTop: 'none', borderRadius: '0 0 6px 6px', background: '#fff' }}>
                              {groupTickets.map(renderTicketRow)}
                          </div>
                      )}
                  </div>
              );
          });

})()
 : (
          <div className="proposal-empty">
            <strong>No hay tickets para mostrar</strong>
            <span>Prueba otra vista o limpia los filtros.</span>
          </div>
        )}
      </div>
    </div>
  );
}
