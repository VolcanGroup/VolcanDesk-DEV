import { formatRelativeTime, formatDateShort, formatDuration, formatDate, formatDateCompact } from '../utils/helpers';
import { getUserById } from '../services/userService';
import { getCompanyById } from '../services/companyService';
import { computeSlaStatus } from '../services/ticketService';
import { getGroups } from '../services/groupService';
import { resolveStatus, resolvePriority, getEtiquetaOptionsForStatus, MOTIVO_BLOQUEO_OPTIONS } from '../services/configService';
import { getEstadoAgrupacion, sortByUrgency, sortByDate, parseApoyos } from '../services/ticketService';
import { IoChevronDownOutline, IoChevronForwardOutline, IoCheckmarkCircle, IoAlertCircle, IoPauseCircle, IoTimeOutline, IoRemoveCircleOutline } from 'react-icons/io5';
import { useState } from 'react';
import './TicketTable.css';

const statusLabel = { new: 'Nuevo', 'in progress': 'En progreso', resolved: 'Resuelto', closed: 'Cerrado' };

// Avatares de "Asignado" (Volcán Desk): iniciales sobre un color determinístico
// por id de usuario, para reconocimiento visual instantáneo en la tabla sin
// depender de una foto real.
const AVATAR_COLORS = ['#4f46e5', '#059669', '#d97706', '#dc2626', '#0891b2', '#7c3aed', '#db2777', '#65a30d'];
const getInitials = (name) => {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  const initials = (parts[0]?.[0] || '') + (parts[1]?.[0] || '');
  return (initials || name[0] || '?').toUpperCase();
};
const getAvatarColor = (seed) => {
  const s = String(seed || '');
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
};
const hexToRgba = (hex, alpha) => {
  const h = (hex || '#94a3b8').replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const bigint = parseInt(full, 16) || 0x94a3b8;
  const r = (bigint >> 16) & 255, g = (bigint >> 8) & 255, b = bigint & 255;
  return `rgba(${r},${g},${b},${alpha})`;
};

export default function TicketTable({ tickets, onTicketClick, config, visibleColumns, currentUser, headerOverrides, isDesk, sortMode = 'urgency', deskFixedAxis }) {
  // "Terminado" arranca colapsado (ahorra espacio en pantalla para tickets que
  // ya no requieren acción) — el resto de secciones arranca expandido.
  const [collapsedSections, setCollapsedSections] = useState({ done: true });
  const toggleSection = (sectionId) => {
    setCollapsedSections(prev => ({ ...prev, [sectionId]: !prev[sectionId] }));
  };
  // Preview inline por ticket (Volcán Desk): clic en la fila sigue abriendo el
  // ticket completo de inmediato (comportamiento de siempre); el chevron de la
  // derecha, aparte, expande/colapsa este resumen sin salir de la tabla.
  const [expandedTicketId, setExpandedTicketId] = useState(null);
  const toggleExpanded = (id) => setExpandedTicketId(prev => (prev === id ? null : id));

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

  // Antes caían al id crudo (ej. "c1789616712302_ms") cuando el ticket sí tenía
  // categoría/tipo asignado pero ese id ya no existe en el catálogo actual
  // (reorganización de Categorías/Tipos) — mismo caso ya resuelto en
  // FlowsConfigPage ("Categoría eliminada"/"Tipo eliminado") y en Dashboard.jsx
  // (reportado en vivo 2026-09-18, primero visto en el gráfico "Top Categorías
  // de Solicitud", luego confirmado que la misma tabla de tickets tenía el
  // mismo problema).
  const getCategoryLabel = (val) => {
    if (!val) return 'Sin categoría';
    const foundCat = config?.categories?.find(c => String(c.id) === String(val));
    if (foundCat) return foundCat.name || foundCat.label;
    const foundType = config?.types?.find(t => String(t.id) === String(val));
    if (foundType) return foundType.name || foundType.label;
    return 'Categoría eliminada';
  };

  const getTypeLabel = (val) => {
    if (!val) return 'Sin tipo';
    const found = config?.types?.find(t => String(t.id) === String(val));
    return found ? (found.name || found.label) : 'Tipo eliminado';
  };

  const formatTime = (min) => {
    if (min < 60) return `${min} min`;
    const hrs = (min / 60).toFixed(1);
    return hrs.endsWith('.0') ? `${Math.round(min / 60)}h` : `${hrs}h`;
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

            if (ticket.ambito === 'interno') {
              // Volcán Desk no tiene rol 'client' — solicitante y resolutor son
              // ambos internos, así que hay que resolver de qué LADO está viendo
              // este usuario el ticket (no por rol) para saber si el punto azul
              // le toca a él. ultimo_mensaje_de/visto_por_* usan los valores
              // 'solicitante'/'resolutor' aquí (mismo campo que 'cliente'/'agente'
              // en tickets externos — ver nota en server.js, creación de ticket).
              const isRequester = currentUser?.id === ticket.createdBy;
              const isResolverSide = !isRequester && isOwnerGroup;
              const isRequesterSide = isRequester || (!isResolverSide && !!ticket.area_origen_id && userGroups.includes(ticket.area_origen_id));
              if (isRequesterSide) {
                hasPendingAction = ticket.ultimo_mensaje_de === 'resolutor' && !ticket.visto_por_cliente && !isClosedOrResolved;
                if (ticket.ultimo_mensaje_de === 'resolutor') {
                  helperText = 'Resolutor respondió';
                } else if (ticket.ultimo_mensaje_de === 'solicitante') {
                  helperText = 'En revisión por el resolutor';
                } else {
                  helperText = 'Actualizado por el sistema';
                }
              } else {
                hasPendingAction = ticket.ultimo_mensaje_de === 'solicitante' && !ticket.visto_por_agente && !isClosedOrResolved;
                if (ticket.ultimo_mensaje_de === 'solicitante') {
                  helperText = 'Solicitante respondió';
                } else if (ticket.ultimo_mensaje_de === 'resolutor') {
                  if (ticket.assignedTo === currentUser?.id || ticket.resolver_agent_id === currentUser?.id) {
                    helperText = 'Tú respondiste, esperando solicitante';
                  } else {
                    helperText = `${agent?.name || 'Agente'} respondió, esperando solicitante`;
                  }
                } else {
                  helperText = 'Sistema actualizó, esperando solicitante';
                }
              }
            } else if (currentUser?.role === 'client') {
              hasPendingAction = ticket.ultimo_mensaje_de === 'agente' && !ticket.visto_por_cliente && !isClosedOrResolved;
              if (ticket.ultimo_mensaje_de === 'agente') {
                helperText = `${brandName} respondió`;
              } else if (ticket.ultimo_mensaje_de === 'cliente') {
                helperText = `En revisión por ${brandName}`;
              } else {
                helperText = 'Actualizado por el sistema';
              }
            } else {
              hasPendingAction = ticket.ultimo_mensaje_de === 'cliente' && !ticket.visto_por_agente && !isClosedOrResolved;
              if (ticket.ultimo_mensaje_de === 'cliente') {
                helperText = 'Cliente respondió';
              } else if (ticket.ultimo_mensaje_de === 'agente') {
                if (ticket.assignedTo === currentUser?.id || ticket.resolver_agent_id === currentUser?.id) {
                  helperText = 'Tú respondiste, esperando cliente';
                } else {
                  helperText = `${agent?.name || 'Agente'} respondió, esperando cliente`;
                }
              } else {
                helperText = 'Sistema actualizó, esperando cliente';
              }
            }

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
                            <strong style={{ fontWeight: hasPendingAction ? '600' : '500' }}>{ticket.title}</strong>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px', flexWrap: 'wrap' }}>
                            <small>#{ticket.id} · {ticket.ambito === 'interno' ? getGroupLabel(ticket.group) : (company?.name || 'Sin empresa')}</small>
                            {hasPendingAction ? (
                              <span className="pending-reply-badge">Te toca responder</span>
                            ) : (
                              <span style={{ fontSize: '11px', color: '#64748b' }}>· {helperText}</span>
                            )}
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

  // Fila de ticket para Volcán Desk: columnas consolidadas (Detalle / Estado &
  // Sub-estado / Asignado con avatar / SLA con semántica de color correcta) en
  // vez de las ~11 columnas planas de antes — el resto de metadata (tipo,
  // categoría, grupo solicitante, fecha de creación) vive en el preview que se
  // expande con el chevron, no compite por espacio horizontal todo el tiempo.
  const renderDeskTicketRow = (ticket) => {
    const sla = computeSlaStatus(ticket, config);
    const agent = getUserById(ticket.assignedTo || ticket.resolver_agent_id);

    const isEffectivelyPaused = ticket.bloqueado && !sla.bloqueoCapExceeded;
    const slaText = isEffectivelyPaused ? 'Pausado' :
      sla.isTerminated ? 'Finalizado' :
      sla.targetMinutes === null ? 'Sin SLA' :
      sla.targetMinutes === 0 ? 'Sin límite' :
      sla.status === 'breached' ? `Vencido hace ${formatTime(Math.max(1, sla.elapsedMinutes - sla.targetMinutes))}` :
      sla.status === 'warning' ? 'Vence pronto' :
      `Vence en ${formatTime(Math.max(1, sla.targetMinutes - sla.elapsedMinutes))}`;

    // Semántica de color estricta pedida por el usuario (2026-09-07): rojo solo
    // para vencido, verde para a-tiempo/finalizado (sin importar si se resolvió
    // tarde — una vez cerrado ya no debe leerse como urgente), ámbar para
    // pausado. `sla.status` crudo puede seguir en 'breached' para un ticket ya
    // Finalizado (se resolvió después de su SLA) — no se usa directo para no
    // pintar de rojo algo que ya está resuelto.
    const slaVisual = isEffectivelyPaused ? 'paused' : sla.isTerminated ? 'done' : sla.status;
    const SlaIcon = slaVisual === 'done' || slaVisual === 'ok' ? IoCheckmarkCircle
      : slaVisual === 'warning' ? IoTimeOutline
      : slaVisual === 'breached' ? IoAlertCircle
      : slaVisual === 'paused' ? IoPauseCircle
      : IoRemoveCircleOutline;

    const statusInfo = resolveStatus(ticket.status);
    const etiquetaOptions = getEtiquetaOptionsForStatus(ticket.status);
    const subestadoLabels = (ticket.etiquetas || []).map(e => etiquetaOptions.find(o => o.value === e)?.label || e);
    let subestadoText = subestadoLabels.join(', ');
    if (ticket.bloqueado) {
      const motivoLabel = MOTIVO_BLOQUEO_OPTIONS.find(o => o.value === ticket.motivo_bloqueo)?.label || 'Bloqueado';
      subestadoText = subestadoText ? `${subestadoText} · ${motivoLabel}` : motivoLabel;
    }

    const isTerminal = sla.isTerminated;
    // Este renderer es solo para tickets internos (Volcán Desk). No hay rol
    // 'client' que distinga solicitante de resolutor, así que hay que saber de
    // qué LADO está viendo la tabla este usuario. Si la página tiene el eje fijo
    // (Solicitudes Recibidas = 'atencion' → resolutor, Solicitudes Enviadas =
    // 'solicitudes' → solicitante) se usa directo; si no (vista genérica sin eje
    // fijo), se infiere por ticket igual que en renderTicketRow/markTicketAsRead.
    const isRequesterPerspective = deskFixedAxis === 'solicitudes' ? true
      : deskFixedAxis === 'atencion' ? false
      : (() => {
          const isRequester = currentUser?.id === ticket.createdBy;
          const resolverGroupId = ticket.resolver_group_id || ticket.group;
          const userGroups = currentUser?.groups || [];
          const isResolverSide = !isRequester && (currentUser?.role === 'admin'
            || userGroups.includes(resolverGroupId)
            || (currentUser?.role === 'group_admin' && currentUser?.admin_group_id === resolverGroupId));
          return isRequester || (!isResolverSide && !!ticket.area_origen_id && userGroups.includes(ticket.area_origen_id));
        })();
    let helperText = '';
    let hasPendingAction = false;
    if (isRequesterPerspective) {
      hasPendingAction = ticket.ultimo_mensaje_de === 'resolutor' && !ticket.visto_por_cliente && !isTerminal;
      if (ticket.ultimo_mensaje_de === 'resolutor') {
        helperText = 'Resolutor respondió';
      } else if (ticket.ultimo_mensaje_de === 'solicitante') {
        helperText = 'En revisión por el resolutor';
      } else {
        helperText = 'Sistema actualizó, esperando resolutor';
      }
    } else {
      hasPendingAction = ticket.ultimo_mensaje_de === 'solicitante' && !ticket.visto_por_agente && !isTerminal;
      if (ticket.ultimo_mensaje_de === 'solicitante') {
        helperText = 'Solicitante respondió';
      } else if (ticket.ultimo_mensaje_de === 'resolutor') {
        helperText = (ticket.assignedTo === currentUser?.id || ticket.resolver_agent_id === currentUser?.id)
          ? 'Tú respondiste, esperando solicitante'
          : `${agent?.name || 'Agente'} respondió, esperando solicitante`;
      } else {
        helperText = 'Sistema actualizó, esperando solicitante';
      }
    }

    const isNewUnassigned = ticket.status === 'to_do' && !ticket.assignedTo && !ticket.resolver_agent_id;
    const shouldHighlight = !isEffectivelyPaused && (ticket.status === 'to_do' || hasPendingAction || isNewUnassigned);
    const isUrgent = resolvePriority(ticket.priority).label === 'Urgente';
    const isExpanded = expandedTicketId === ticket.id;

    return (
      <div key={ticket.id} className="desk-ticket-wrap">
        <button
          type="button"
          className={`desk-ticket-row ${shouldHighlight ? 'action-required-highlight' : ''} ${isEffectivelyPaused ? 'row-paused' : ''}`}
          onClick={() => onTicketClick(ticket)}
        >
          <span className="desk-col desk-col-detail">
            <span className="desk-title-line">
              <strong>{ticket.title}</strong>
              {isUrgent && <span className="urgent-badge">Urgente</span>}
            </span>
            <span className="desk-subtitle-line">
              <small>#{ticket.id} · {getGroupLabel(ticket.resolver_group_id || ticket.group)}</small>
              {hasPendingAction && <span className="pending-reply-badge">Te toca responder</span>}
            </span>
          </span>
          {/* El badge de Estado se quitó de aquí (a pedido del usuario, 2026-09-18)
              — ya es redundante: la fila vive dentro de un grupo acordeón que
              agrupa por ese mismo Estado (ver .ticket-group-header más abajo),
              así que repetirlo en cada fila no aporta nada. Solo queda el
              Sub-estado, que sí varía dentro de un mismo grupo. */}
          <span className="desk-col desk-col-status">
            {subestadoText ? <span className="desk-status-sub-solo">{subestadoText}</span> : <span className="unassigned">—</span>}
          </span>
          <span className="desk-col desk-col-created">
            {formatDateCompact(ticket.createdAt)}
          </span>
          {/* Antes solo vivía en el preview expandible (ver abajo) — a pedido del
              usuario (2026-09-17) se promueve a la fila principal para no tener
              que desplegar el acordeón solo para ver Tipo/Categoría. Orden
              Categoría/Tipo invertido a pedido del usuario (2026-09-18): antes
              mostraba Tipo arriba y Categoría abajo. */}
          <span className="desk-col desk-col-classification">
            <span className="desk-classification-value">{getCategoryLabel(ticket.category)}</span>
            <small className="desk-classification-sub">{getTypeLabel(ticket.type)}</small>
          </span>
          <span className="desk-col desk-col-assigned">
            {agent ? (
              <>
                <span className="desk-avatar" style={{ background: getAvatarColor(agent.id) }}>{getInitials(agent.name)}</span>
                <span className="desk-assigned-name">{agent.name}</span>
              </>
            ) : <span className="unassigned">Sin asignar</span>}
          </span>
          <span className={`desk-col desk-col-sla sla-visual-${slaVisual}`}>
            <SlaIcon className="desk-sla-icon" />
            <span className="desk-sla-text">{slaText}</span>
          </span>
          <span
            className="desk-col-expand"
            role="button"
            tabIndex={0}
            aria-label={isExpanded ? 'Contraer detalle' : 'Ver detalle rápido'}
            onClick={(e) => { e.stopPropagation(); toggleExpanded(ticket.id); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); toggleExpanded(ticket.id); } }}
          >
            {isExpanded ? <IoChevronDownOutline /> : <IoChevronForwardOutline />}
          </span>
        </button>
        {isExpanded && (
          <div className="desk-ticket-preview">
            <div className="desk-preview-fields">
              {/* "Clasificación" (Tipo/Categoría) se quitó de aquí — ya vive en la
                  fila principal, repetirla en el preview era redundante. */}
              <div>
                <span className="desk-preview-label">Origen</span>
                <div className="desk-preview-value">{getGroupLabel(ticket.area_origen_id)}</div>
                <div className="desk-preview-sub">{formatDate(ticket.createdAt)}</div>
              </div>
              <div>
                <span className="desk-preview-label">Detalle del estado</span>
                <div className="desk-preview-value">{subestadoText || statusInfo.label}</div>
                <div className="desk-preview-sub">{helperText}</div>
              </div>
            </div>
          </div>
        )}
      </div>
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
      {isDesk ? (
        <div className="desk-table-head">
          <span>Ticket</span>
          <span>Sub-estado</span>
          <span>Fecha</span>
          <span>Clasificación</span>
          <span>Asignado</span>
          <span>SLA</span>
          <span></span>
        </div>
      ) : (
        <div className="proposal-table-head" style={{ gridTemplateColumns: gridStyle }}>
          {cols.map(col => (
            <span key={col}>{headers[col] || col}</span>
          ))}
          <span></span>
        </div>
      )}
      <div>
        {tickets.length ? (() => {

          const isVolcanDesk = isDesk || tickets.some(t => (t.ambito || 'externo') === 'interno');
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
              // Antes '#f59e0b', igual que 'under_review' — Pendiente y Revisión se
              // veían con el mismo punto ámbar en el encabezado del grupo (reportado
              // en vivo 2026-09-18). Se usa el mismo gris que ya tiene 'to_do' en
              // INTERNAL_STATUSES (configService.js) — el badge de Estado de cada fila
              // ya lo pinta así, así que de paso queda consistente con eso.
              'to_do': '#94a3b8',
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
              grouped[k].sort(sortMode === 'date' ? sortByDate : (a, b) => sortByUrgency(a, b, config));
          });

          const rowRenderer = isDesk ? renderDeskTicketRow : renderTicketRow;

          return SECTION_ORDER.concat(['Otros']).filter(k => grouped[k] && grouped[k].length > 0).map(groupKey => {
              const groupTickets = grouped[groupKey];
              const isCollapsed = collapsedSections[groupKey];
              return (
                  <div key={groupKey} className="ticket-group-section">
                      <div className={`ticket-group-header ${isCollapsed ? 'collapsed' : ''}`} onClick={() => toggleSection(groupKey)}>
                          {isCollapsed ? <IoChevronForwardOutline /> : <IoChevronDownOutline />}
                          <span className="ticket-group-dot" style={{ background: SECTION_COLORS[groupKey] || '#94a3b8' }}></span>
                          {SECTION_NAMES[groupKey] || groupKey}
                          <span className="ticket-group-count">{groupTickets.length}</span>
                      </div>
                      {!isCollapsed && (
                          <div className="ticket-group-content">
                              {groupTickets.map(rowRenderer)}
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
