import React, { useState, useEffect } from 'react';
import './TicketDetailView.css';
import { formatRelativeTime, formatDate, formatDateShort, businessDaysBetween } from '../utils/helpers';
import {
    IoArrowBack,
    IoLockClosed,
    IoSend,
    IoDocumentText,
    IoChevronDown,
    IoChevronForward,
    IoAttachOutline,
    IoClose,
    IoTimeOutline,
    IoCheckmarkCircleOutline,
    IoPersonOutline,
    IoChatbubbleOutline,
    IoCreateOutline,
    IoAlertCircleOutline,
    IoPencilOutline,
    IoTrendingUpOutline,
    IoSwapHorizontalOutline,
    IoCheckmarkDoneOutline,
} from 'react-icons/io5';
import Badge from './Badge';
import Multiselect from './Multiselect';
import RichTextEditor from './RichTextEditor';
import { addNotification } from '../services/notificationService';
import { getCompanyById, getContactById } from '../services/companyService';
import { getConfig, resolveStatus, INTERNAL_STATUSES, MOTIVO_BLOQUEO_OPTIONS, getEtiquetaOptionsForStatus } from '../services/configService';
import { computeSlaStatus } from '../services/ticketService';
import { getGroups } from '../services/groupService';

export default function TicketDetailView({
    ticket, users, currentUser, config,
    onBack, onUpdateStatus, onUpdatePriority, onUpdateAssignee, onAddComment,
    onUpdateField, onEscalate, onMarkAsRead
}) {
    const [replyMode, setReplyMode] = useState('public');
    const [editorContent, setEditorContent] = useState({ html: '', text: '', mentionedUserIds: [], attachments: [] });
    const [attachments, setAttachments] = useState([]);
    const [collapsedComments, setCollapsedComments] = useState(new Set());
    const [isReplying, setIsReplying] = useState(false);
    const [showActivity, setShowActivity] = useState(false);
    // ─── Conversación vs Actividad (Volcán Desk) ───
    // Antes "Actividad" era un panel flotante que había que abrir aparte —
    // quedaba escondido y no se distinguía como algo tan importante como la
    // conversación. Doc "lógica de visualización" §15 (historial obligatorio)
    // + feedback en vivo: deben ser dos vistas igual de visibles dentro del
    // propio ticket — "Conversación" (lo que se dijeron solicitante y
    // resolutor) vs "Actividad" (lo que pasó administrativamente: tomar,
    // reasignar, escalar, cambiar campos). Solo aplica a Volcán Desk; Voltik
    // conserva el panel flotante de "Ver Actividad" sin cambios.
    const [activeTicketTab, setActiveTicketTab] = useState('conversacion');
    const [escalateGroup, setEscalateGroup] = useState('');
    const [escalateAgent, setEscalateAgent] = useState('');
    const groups = getGroups();

    const ticketModulo = ticket.ambito === 'interno' ? 'volcan_desk' : 'voltik';
    const isOwner = currentUser?.id === ticket.owner_agent_id;
    const isClient = currentUser?.role === 'client';
    // group_admin faltaba en ambas — por eso un admin de grupo veía el ticket
    // en modo solo-lectura (sin poder asignar, tomar, escalar ni editar
    // estado/prioridad) incluso en tickets de su propio grupo. La otra mitad
    // del permiso (isAuthorizedGroupMember, más abajo) sí lo contemplaba desde
    // antes, lo que hacía el bug más confuso: el botón "Tomar ticket" pasaba
    // su propia condición pero nunca se mostraba porque el canEdit ? … : …
    // que lo envuelve caía siempre en la rama de solo lectura.
    const isInternalUser = currentUser?.role === 'admin' || currentUser?.role === 'agent' || currentUser?.role === 'supervisor' || currentUser?.role === 'group_admin';
    // BUG encontrado en vivo: los selects de "Grupo" y "Grupo Destino" (escalar) listaban
    // TODOS los grupos del sistema sin filtrar por módulo — Voltik y Volcán Desk comparten
    // nombres ("BI & Development", "Operaciones"...) con IDs distintos, así que era posible
    // escalar/mover un ticket interno hacia el grupo de Voltik con el mismo nombre por error
    // (reproducido: quedó resolver_group_id apuntando a un grupo de Voltik). Estos selects
    // deben ofrecer solo los grupos del propio módulo del ticket.
    const deskGroups = groups.filter(g => (g.modulo || 'voltik') === ticketModulo);

    // ticket.group es inconsistente: al crear el ticket se guarda el ID del grupo, pero el
    // selector de Grupo en este mismo detalle sobreescribe el campo con el NOMBRE al editarlo.
    // Resolvemos el ID real probando resolver_group_id (siempre ID) -> nombre->ID vía catálogo -> tal cual.
    const effectiveGroupId = ticket.resolver_group_id || groups.find(g => g.name === ticket.group)?.id || ticket.group;

    // Miembro autorizado del grupo resolutor ACTUAL: puede responder al solicitante en
    // nombre del grupo aunque no sea el "responsable" (owner_agent_id) — ser responsable
    // ya no es requisito exclusivo para mostrar "Responder al solicitante" (doc "lógica de
    // visualización" §10/§11, CA11/CA12). El backend es quien realmente decide esto; aquí
    // solo evitamos mostrar un botón que el servidor rechazaría. Solo aplica a Volcán Desk —
    // Voltik conserva la regla histórica de "solo el owner puede responder".
    const isAuthorizedGroupMember = currentUser?.role === 'admin'
        || (currentUser?.role === 'group_admin' && currentUser?.admin_group_id === effectiveGroupId)
        || (!!effectiveGroupId && (currentUser?.groups || []).includes(effectiveGroupId));

    // El panel de propiedades (Estado, Prioridad, Categoría, Grupo, Bloqueo,
    // Asignado A, Escalar) antes se habilitaba solo por ROL (admin/agent/
    // group_admin), sin mirar si el usuario realmente pertenece al grupo
    // resolutor del ticket. Eso dejaba al propio SOLICITANTE (que en Volcán
    // Desk también tiene rol interno, nunca 'client') viendo y pudiendo tocar
    // todo el panel de un ticket que no es de su grupo — el servidor ya
    // rechaza esos cambios (ver RESOLVER_ONLY_FIELDS en server.js), pero la
    // UI seguía mostrando controles que iban a fallar. Doc "lógica de
    // visualización" §16 "Regla de oro": esos campos son del resorte del
    // grupo resolutor, no del solicitante. En Volcán Desk, canEdit ahora
    // exige además ser miembro autorizado del grupo resolutor actual (o
    // admin) — Voltik conserva el comportamiento histórico.
    const canEdit = ticketModulo === 'volcan_desk'
        ? isAuthorizedGroupMember
        : (currentUser?.role === 'admin' || currentUser?.role === 'agent' || currentUser?.role === 'group_admin');

    // El SOLICITANTE (quien creó el ticket) siempre puede responder a su propio ticket,
    // sin importar si pertenece o no al grupo resolutor — se me había quedado fuera en
    // la primera pasada: solo miraba membresía de grupo, así que un solicitante interno
    // (no cliente) que no fuera del grupo resolutor quedaba atrapado en modo "Nota
    // privada" incluso para dar seguimiento a su propia solicitud (doc §10/§11, CA11/CA12
    // — "Juan... es el solicitante → puede responder/agregar información a su propio ticket").
    const isRequester = currentUser?.id === ticket.createdBy;
    const canReplyPublicly = isClient || isRequester || (ticketModulo === 'volcan_desk' ? isAuthorizedGroupMember : isOwner);

    // En Volcán Desk no existe "cliente" — quien recibe la respuesta pública es el
    // solicitante (otro usuario interno). El modal de responder seguía con el texto
    // de Voltik ("...al Cliente", "el cliente recibirá un correo") sin adaptarse,
    // mismo bug de wording que ya se había corregido en TicketTable.jsx (fila de
    // lista) pero no aquí. Además, Volcán Desk no manda correo — el aviso es la
    // notificación en-app (ver notificationService.js), así que el footer también
    // debe decir eso y no prometer un correo que no se envía.
    const counterpart = ticketModulo === 'volcan_desk' ? 'solicitante' : 'cliente';
    const counterpartCap = ticketModulo === 'volcan_desk' ? 'Solicitante' : 'Cliente';

    // Catálogos por grupo (Volcán Desk): cada grupo tiene su propio set de prioridades,
    // categorías y tipos — no deben mezclarse entre grupos.
    const scopedByGroup = (items) => (items || [])
        .filter(i => (i.modulo || 'voltik') === ticketModulo)
        .filter(i => ticketModulo !== 'volcan_desk' || !i.grupoId || i.grupoId === effectiveGroupId);

    const priorityOptions = scopedByGroup(config.priorities);
    const categoryOptions = scopedByGroup(config.categories);
    const typeOptions = scopedByGroup(config.types);
    const selectedPriorityConf = priorityOptions.find(p => p.value === ticket.priority);

    // Auto-marcar como leído al entrar al detalle (indicador se limpia al abrir, no requiere acción manual)
    useEffect(() => {
        const hasUnread = isClient
            ? ticket.ultimo_mensaje_de === 'agente' && !ticket.visto_por_cliente
            : ticket.ultimo_mensaje_de === 'cliente' && !ticket.visto_por_agente;
        if (hasUnread && onMarkAsRead) {
            onMarkAsRead(ticket.id);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ticket.id]);

    useEffect(() => {
        if (sessionStorage.getItem('autoEscalate') === 'true') {
            sessionStorage.removeItem('autoEscalate');
            setTimeout(() => {
                const panel = document.getElementById('escalate-panel');
                if (panel) {
                    panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    panel.style.boxShadow = '0 0 0 3px var(--color-primary)';
                    setTimeout(() => panel.style.boxShadow = '', 2000);
                }
            }, 500);
        }
    }, [ticket.id]);

    // Use resolveStatus for accurate label+color from the new configService
    const getStatusLabel = (val) => {
        if (!val) return { label: '—', color: '#999' };
        const r = resolveStatus(val);
        return { label: r.label, color: r.color };
    };

    const handleEditorChange = (data) => {
        setEditorContent(data);
    };

    const handleSendReply = () => {
        const text = editorContent.html?.trim() || editorContent.text?.trim();
        if (!text) return;

        const isNote = !canReplyPublicly || replyMode === 'note';
        onAddComment(ticket.id, text, isNote, attachments);

        // Notificaciones para usuarios mencionados
        if (editorContent.mentionedUserIds?.length > 0) {
            editorContent.mentionedUserIds.forEach(userId => {
                if (userId !== currentUser.id) {
                    addNotification({
                        fromUser: { id: currentUser.id, name: currentUser.name },
                        toUserId: userId,
                        ticketId: ticket.id,
                        ticketTitle: ticket.title,
                        message: isNote
                            ? 'te etiquetó en una nota privada'
                            : 'te mencionó en una respuesta'
                    });
                }
            });
        }

        // Resetear estado
        setAttachments([]);
        setEditorContent({ html: '', text: '', mentionedUserIds: [], attachments: [] });
        setIsReplying(false);
    };

    const handleDownload = (att) => {
        const link = document.createElement('a');
        link.href = att.dataUrl;
        link.download = att.name;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const toggleComment = (id) => {
        setCollapsedComments(prev => {
            const s = new Set(prev);
            s.has(id) ? s.delete(id) : s.add(id);
            return s;
        });
    };

    const ticketCreator = users.find(u => u.id === ticket.createdBy);
    const creatorInitials = ticketCreator ? ticketCreator.name.substring(0, 2).toUpperCase() : 'US';
    const ticketCompany = getCompanyById(ticket.companyId);
    const ticketContact = ticket.contactId ? (getContactById(ticket.contactId) || users.find(u => u.id === ticket.contactId)) : null;
    const createdDate = ticket.createdAt ? new Date(ticket.createdAt) : null;

    // Solo agentes/admins/admin de grupo pueden ser mencionados
    const mentionableUsers = users.filter(u => u.role === 'admin' || u.role === 'agent' || u.role === 'group_admin');

    // Lista de actividad (histórico administrativo) — se reutiliza tal cual en el
    // panel flotante de Voltik y en la pestaña "Actividad" inline de Volcán Desk.
    const activityTimelineContent = (
        <div className="activity-timeline">
            {(ticket.activities || []).length === 0 && (
                <div className="activity-empty">Sin actividad registrada</div>
            )}
            {[...(ticket.activities || [])]
                .sort((a, b) => new Date(b.ts) - new Date(a.ts))
                .map(act => {
                    const actor = users.find(u => u.id === act.userId);
                    const actorName = actor?.name || 'Sistema';
                    return (
                        <div key={act.id} className={`activity-item activity-${act.type}`}>
                            <div className="activity-icon-wrap">
                                {act.type === 'created'        && <IoCreateOutline size={14} />}
                                {act.type === 'status_change'  && <IoCheckmarkCircleOutline size={14} />}
                                {act.type === 'assignee_change'&& <IoPersonOutline size={14} />}
                                {act.type === 'comment'        && <IoChatbubbleOutline size={14} />}
                                {act.type === 'note'           && <IoAlertCircleOutline size={14} />}
                                {act.type === 'campo_editado'  && <IoPencilOutline size={14} />}
                                {act.type === 'escalamiento'   && <IoTrendingUpOutline size={14} />}
                                {act.type === 'transferencia_propiedad' && <IoSwapHorizontalOutline size={14} />}
                            </div>
                            <div className="activity-content">
                                <div className="activity-desc">
                                    <strong>{actorName}</strong>
                                    {act.type === 'created' && ' creó el ticket'}
                                    {act.type === 'status_change' && (
                                        <>
                                            {' cambió estado: '}
                                            <span className="act-status-badge" style={{ background: `${getStatusLabel(act.data?.from).color}20`, color: getStatusLabel(act.data?.from).color }}>
                                                {getStatusLabel(act.data?.from).label}
                                            </span>
                                            {' → '}
                                            <span className="act-status-badge" style={{ background: `${getStatusLabel(act.data?.to).color}20`, color: getStatusLabel(act.data?.to).color }}>
                                                {getStatusLabel(act.data?.to).label}
                                            </span>
                                        </>
                                    )}
                                    {act.type === 'assignee_change' && (() => {
                                        const toUser = users.find(u => u.id === act.data?.to);
                                        return <> asignó a <strong>{toUser?.name || 'Sin asignar'}</strong></>;
                                    })()}
                                    {act.type === 'comment' && ' agregó una respuesta'}
                                    {act.type === 'note'    && ' agregó una nota privada'}
                                    {act.type === 'campo_editado' && (
                                        <>
                                            {' cambió el campo '}<strong>{act.data?.field}</strong>{': '}
                                            <span style={{ textDecoration: 'line-through', color: 'var(--color-text-muted)', marginRight: '4px' }}>
                                                {(() => {
                                                    if (act.data?.field === 'Agente Asignado') {
                                                        return users.find(u => u.id === act.data?.from)?.name || act.data?.from || 'Ninguno';
                                                    }
                                                    return act.data?.from || 'Ninguno';
                                                })()}
                                            </span>
                                            {' → '}
                                            <span style={{ fontWeight: '600' }}>
                                                {(() => {
                                                    if (act.data?.field === 'Agente Asignado') {
                                                        return users.find(u => u.id === act.data?.to)?.name || act.data?.to || 'Ninguno';
                                                    }
                                                    return act.data?.to || 'Ninguno';
                                                })()}
                                            </span>
                                        </>
                                    )}
                                    {act.type === 'escalamiento' && (
                                        <>
                                            {' escaló el ticket al grupo '}<strong>{act.data?.groupDest}</strong>{' y lo asignó a '}<strong>{act.data?.agentDest}</strong>
                                        </>
                                    )}
                                    {act.type === 'transferencia_propiedad' && (
                                        <>
                                            {' transfirió la propiedad del ticket a '}<strong>{act.data?.groupDest}</strong>{' — '}<strong>{act.data?.agentDest}</strong>{'. Este grupo transfiere propiedad.'}
                                        </>
                                    )}
                                </div>
                                <div className="activity-time">{formatRelativeTime(act.ts)}</div>
                            </div>
                        </div>
                    );
                })}
        </div>
    );

    return (
        <div className="ticket-detail-wrapper">
            {/* Activity panel overlay — solo Voltik (Volcán Desk usa las pestañas
                Conversación/Actividad inline, ver más abajo) */}
            {showActivity && ticketModulo !== 'volcan_desk' && (
                <div className="activity-panel">
                    <div className="activity-panel-header">
                        <div className="activity-panel-title">
                            <IoTimeOutline size={18} /> Actividad del Ticket
                        </div>
                        <button className="activity-close-btn" onClick={() => setShowActivity(false)}>
                            <IoClose size={18} />
                        </button>
                    </div>
                    {activityTimelineContent}
                </div>
            )}

            {/* ÁREA PRINCIPAL DE CONVERSACIÓN */}
            <div className="ticket-main-content">
                <div className="ticket-header-actions">
                    <button className="back-button" onClick={onBack}>
                        <IoArrowBack size={20} />
                        <span>Volver a Tickets</span>
                    </button>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {/* Botn Marcar como leído: aparece solo si hay respuesta no leída */}
                        {(() => {
                            const hasUnread = isClient
                                ? ticket.ultimo_mensaje_de === 'agente' && !ticket.visto_por_cliente
                                : ticket.ultimo_mensaje_de === 'cliente' && !ticket.visto_por_agente;
                            if (!hasUnread || !onMarkAsRead) return null;
                            return (
                                <button
                                    className="activity-btn"
                                    style={{ background: 'var(--color-primary-low)', color: 'var(--color-primary)', borderColor: 'var(--color-primary)' }}
                                    onClick={() => onMarkAsRead(ticket.id)}
                                    title="Marcar como leído"
                                >
                                    <IoCheckmarkDoneOutline size={16} />
                                    Marcar como leído
                                </button>
                            );
                        })()}
                        {isInternalUser && ticketModulo !== 'volcan_desk' && (
                            <button
                                className={`activity-btn ${showActivity ? 'active' : ''}`}
                                onClick={() => setShowActivity(p => !p)}
                            >
                                <IoTimeOutline size={16} />
                                Ver Actividad
                                {(ticket.activities?.length || 0) > 0 && (
                                    <span className="activity-count">{ticket.activities.length}</span>
                                )}
                            </button>
                        )}
                    </div>
                </div>

                {/* ─── PESTAÑAS CONVERSACIÓN / ACTIVIDAD (Volcán Desk) ───
                    Antes "Actividad" vivía en un panel flotante aparte, fácil de pasar
                    por alto. Ahora son dos vistas del mismo nivel dentro del ticket:
                    "Conversación" (lo que se dijeron solicitante y resolutor) y
                    "Actividad" (lo que pasó administrativamente: tomar, reasignar,
                    escalar, cambiar campos) — doc "lógica de visualización" §15. */}
                {ticketModulo === 'volcan_desk' && isInternalUser && (
                    <div className="ticket-tabs-row">
                        <button
                            className={`ticket-tab-btn ${activeTicketTab === 'conversacion' ? 'active' : ''}`}
                            onClick={() => setActiveTicketTab('conversacion')}
                        >
                            <IoChatbubbleOutline size={15} />
                            Conversación
                        </button>
                        <button
                            className={`ticket-tab-btn ${activeTicketTab === 'actividad' ? 'active' : ''}`}
                            onClick={() => setActiveTicketTab('actividad')}
                        >
                            <IoTimeOutline size={15} />
                            Actividad
                            {(ticket.activities?.length || 0) > 0 && (
                                <span className="activity-count">{ticket.activities.length}</span>
                            )}
                        </button>
                    </div>
                )}

                {ticketModulo === 'volcan_desk' && isInternalUser && activeTicketTab === 'actividad' ? (
                    <div className="conversation-scroll-area" style={{ flex: 1, overflowY: 'auto', paddingRight: '8px', marginBottom: '16px' }}>
                        {activityTimelineContent}
                    </div>
                ) : (
                <div className="conversation-scroll-area" style={{ flex: 1, overflowY: 'auto', paddingRight: '8px', marginBottom: '16px' }}>
                    <div className="ticket-title-large" style={{ marginBottom: ticketModulo === 'volcan_desk' ? '6px' : '24px' }}>
                        <span style={{ color: 'var(--color-text-muted)', marginRight: '8px' }}>#{ticket.id}</span>
                        {ticket.title}
                    </div>
                    {/* ─── CABECERA OPERATIVA (Volcán Desk) ───
                        Línea de contexto rápido debajo del título: quién pidió, de qué
                        grupo, a qué grupo se envió, quién lo atiende y en qué estado va —
                        las cuatro relaciones del modelo (doc "lógica de visualización" §2/§16)
                        de un vistazo, sin tener que leer el panel lateral completo. */}
                    {ticketModulo === 'volcan_desk' && (() => {
                        const solicitante = users.find(u => u.id === ticket.createdBy)?.name || 'Desconocido';
                        const grupoSolicitante = groups.find(g => g.id === ticket.area_origen_id)?.name || '—';
                        const grupoResolutor = groups.find(g => g.id === (ticket.resolver_group_id || ticket.group))?.name || ticket.group || 'Sin grupo';
                        const responsable = users.find(u => u.id === (ticket.resolver_agent_id || ticket.assignedTo))?.name || 'Sin asignar';
                        const estado = getStatusLabel(ticket.status).label;
                        return (
                            <div style={{ marginBottom: '20px', fontSize: '0.82rem', color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px' }}>
                                <span>{solicitante}</span>
                                <span>·</span>
                                <span>{grupoSolicitante}</span>
                                <span>→</span>
                                <span>{grupoResolutor}</span>
                                <span>·</span>
                                <span>{responsable}</span>
                                <span>·</span>
                                <span>{estado}</span>
                            </div>
                        );
                    })()}

                    <div className="conversation-thread">
                        {/* Mensaje Inicial */}
                        <div className="message-bubble initial-message">
                            <div className="message-header">
                                <div className="message-author-info">
                                    <div className="author-avatar">{creatorInitials}</div>
                                <div>
                                        <span className="author-name">{ticketCreator?.name || 'Cliente'}</span>
                                        {ticketCompany && (
                                            <span className="rf-company" style={{ marginLeft: '8px', fontSize: '0.85rem' }}>
                                                {ticketCompany.name}
                                            </span>
                                        )}
                                        {ticketModulo === 'volcan_desk' && (
                                            <span className="author-role-badge exec-badge">
                                                Solicitante
                                            </span>
                                        )}
                                    </div>
                                </div>
                                <span className="message-time">{formatRelativeTime(ticket.createdAt)}</span>
                            </div>
                            <div
                                className="message-body"
                                dangerouslySetInnerHTML={{ __html: ticket.description }}
                            />
                            {ticket.camposValores && ticket.camposValores.length > 0 && (
                                <div className="ticket-dynamic-fields-display" style={{
                                    marginTop: 16,
                                    padding: '12px 16px',
                                    background: 'var(--color-bg-secondary)',
                                    border: '1px dashed var(--glass-border)',
                                    borderRadius: 'var(--radius-md)',
                                    fontSize: '0.85rem'
                                }}>
                                    <div style={{ fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 8, fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                        📋 Datos Adicionales
                                    </div>
                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                                        {ticket.camposValores.map(cv => (
                                            <div key={cv.id} style={{ display: 'flex', flexDirection: 'column' }}>
                                                <span style={{ color: 'var(--color-text-muted)', fontSize: '0.75rem' }}>{cv.Campo?.nombre || 'Campo'}</span>
                                                <strong style={{ color: 'var(--color-text-primary)' }}>
                                                    {cv.Campo?.tipo_dato === 'moneda' ? `$${cv.valor}` : cv.valor}
                                                </strong>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                            {ticket.attachments && ticket.attachments.length > 0 && (
                                <div className="message-attachments">
                                    {ticket.attachments.map(att => (
                                        <div key={att.id} className="attachment-pill" onClick={() => handleDownload(att)}>
                                            <IoAttachOutline size={16} />
                                            <span>{att.name}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Comentarios / Respuestas (FILTRADO POR PRIVACIDAD) */}
                        {ticket.comments?.filter(comment => isInternalUser || !comment.isPrivate).map(comment => {
                            const isNote = comment.isPrivate;
                            const commenter = users.find(u => u.id === comment.userId);
                            const initials = commenter ? commenter.name.substring(0, 2).toUpperCase() : 'EX';
                            const role = commenter?.role || 'client';
                            const isAgentOrAdmin = role === 'admin' || role === 'agent' || role === 'group_admin';
                            const isInternalCommenter = role === 'admin' || role === 'agent' || role === 'supervisor' || role === 'group_admin';
                            const isCollapsed = collapsedComments.has(comment.id);
                            // ─── Etiqueta de autor por grupo (Volcán Desk) ───
                            // En una conversación de soporte interno, "Ejecutivo" no dice quién
                            // está hablando. Mostramos en su lugar de qué grupo habla: el
                            // solicitante se marca como tal, un miembro del grupo resolutor
                            // actual se marca "Resolutor · <grupo>", y cualquier otro interno
                            // (ej. admin sin grupo propio) cae a su propio grupo o a "Admin".
                            const commenterGroupLabel = ticketModulo === 'volcan_desk' ? (() => {
                                if (comment.userId === ticket.createdBy) return 'Solicitante';
                                if (effectiveGroupId && (commenter?.groups || []).includes(effectiveGroupId)) {
                                    const gName = groups.find(g => g.id === effectiveGroupId)?.name;
                                    return gName ? `Resolutor · ${gName}` : 'Resolutor';
                                }
                                const ownGroupName = commenter?.groups?.[0] ? groups.find(g => g.id === commenter.groups[0])?.name : null;
                                return ownGroupName || (role === 'admin' ? 'Admin' : null);
                            })() : null;

                            return (
                                <div key={comment.id} className={`message-bubble ${isNote ? 'private-note' : ''} ${isInternalCommenter ? 'message-internal' : 'message-client'} ${isCollapsed ? 'collapsed' : ''}`}>
                                    <div className="message-header" onClick={() => toggleComment(comment.id)}>
                                        <div className="message-author-info">
                                            <div className="author-avatar" style={{ background: isAgentOrAdmin ? 'var(--color-primary)' : 'var(--color-bg-tertiary)' }}>
                                                {initials}
                                            </div>
                                            <div>
                                                <span className="author-name">{commenter?.name || 'Usuario'}</span>
                                                {isNote && (
                                                    <span className="author-role-badge note-badge">
                                                        <IoLockClosed size={10} style={{ marginRight: '4px' }} /> Nota Interna
                                                    </span>
                                                )}
                                                {isAgentOrAdmin && !isNote && ticketModulo === 'volcan_desk' && commenterGroupLabel && (
                                                    <span className="author-role-badge exec-badge">
                                                        {commenterGroupLabel}
                                                    </span>
                                                )}
                                                {isAgentOrAdmin && !isNote && ticketModulo !== 'volcan_desk' && (
                                                    <span className="author-role-badge exec-badge">
                                                        Ejecutivo
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                            <span className="message-time">{formatRelativeTime(comment.createdAt)}</span>
                                            {isCollapsed
                                                ? <IoChevronForward color="var(--color-text-muted)" />
                                                : <IoChevronDown color="var(--color-text-muted)" />
                                            }
                                        </div>
                                    </div>
                                    <div
                                        className="message-body"
                                        dangerouslySetInnerHTML={{ __html: comment.text }}
                                    />
                                    {comment.attachments && comment.attachments.length > 0 && (
                                        <div className="message-attachments">
                                            {comment.attachments.map(att => (
                                                <div key={att.id} className="attachment-pill" onClick={() => handleDownload(att)}>
                                                    <IoAttachOutline size={16} />
                                                    <span>{att.name}</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
                )}

                {/* Botón Flotante de Respuesta — oculto en la pestaña Actividad, no aplica */}
                {!isReplying && !(ticketModulo === 'volcan_desk' && isInternalUser && activeTicketTab === 'actividad') && (
                    <button
                        className="fab-reply" 
                        onClick={() => { 
                            setReplyMode(canReplyPublicly ? 'public' : 'note'); 
                            setIsReplying(true); 
                        }} 
                        style={!canReplyPublicly ? { background: 'var(--color-warning)', color: '#000' } : {}}
                    >
                        {!canReplyPublicly ? <IoLockClosed size={24} /> : <IoSend size={24} />}
                        <span>{!canReplyPublicly ? 'Nota Privada' : 'Responder'}</span>
                    </button>
                )}

                {/* Capa de Respuesta (Overlay) */}
                {isReplying && (
                    <div className="reply-overlay fade-in">
                        <div className="reply-panel">
                            <div className="reply-overlay-header">
                                <h3>{(!canReplyPublicly || replyMode === 'note') ? 'Nueva Nota Privada' : `Nueva Respuesta al ${counterpartCap}`}</h3>
                                <button className="btn-icon" onClick={() => setIsReplying(false)}><IoClose size={24}/></button>
                            </div>
                            
                            {/* PESTAÑAS MEJORADAS CON ESTILOS EN LÍNEA */}
                            <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', paddingBottom: '12px', borderBottom: '1px solid var(--glass-border)' }}>
                                {canReplyPublicly && (
                                    <button
                                        onClick={() => setReplyMode('public')}
                                        style={{
                                            display: 'flex', alignItems: 'center', gap: '8px',
                                            padding: '8px 16px', borderRadius: 'var(--radius-md)',
                                            fontWeight: 600, fontSize: '0.9rem', cursor: 'pointer',
                                            transition: 'all 0.2s',
                                            background: replyMode === 'public' ? 'rgba(139, 92, 246, 0.15)' : 'transparent',
                                            color: replyMode === 'public' ? 'var(--color-primary-light)' : 'var(--color-text-muted)',
                                            border: `1px solid ${replyMode === 'public' ? 'var(--color-primary-light)' : 'transparent'}`
                                        }}
                                    >
                                        <IoSend size={16} /> Respuesta Pública
                                    </button>
                                )}
                                {isInternalUser && (
                                    <button
                                        onClick={() => setReplyMode('note')}
                                        style={{
                                            display: 'flex', alignItems: 'center', gap: '8px',
                                            padding: '8px 16px', borderRadius: 'var(--radius-md)',
                                            fontWeight: 600, fontSize: '0.9rem', cursor: 'pointer',
                                            transition: 'all 0.2s',
                                            background: (!canReplyPublicly || replyMode === 'note') ? 'rgba(245, 158, 11, 0.15)' : 'transparent',
                                            color: (!canReplyPublicly || replyMode === 'note') ? 'var(--color-warning)' : 'var(--color-text-muted)',
                                            border: `1px solid ${(!canReplyPublicly || replyMode === 'note') ? 'var(--color-warning)' : 'transparent'}`
                                        }}
                                    >
                                        <IoLockClosed size={16} /> Nota Privada
                                    </button>
                                )}
                            </div>

                            {/* ESTILOS DINÁMICOS PARA LA CAJA DEL EDITOR */}
                            {(!canReplyPublicly || replyMode === 'note') && (
                                <style>{`
                                    .reply-editor-container .rte-wrapper {
                                        border-color: var(--color-warning) !important;
                                        box-shadow: 0 0 0 1px var(--color-warning) !important;
                                        overflow: hidden;
                                    }
                                    .reply-editor-container .rte-editor {
                                        background-color: rgba(245, 158, 11, 0.05) !important;
                                    }
                                    .reply-editor-container .rte-toolbar {
                                        border-bottom-color: var(--color-warning) !important;
                                        background-color: rgba(245, 158, 11, 0.1) !important;
                                    }
                                `}</style>
                            )}

                            <div className="reply-editor-container">
                                <RichTextEditor
                                    noteMode={!canReplyPublicly || replyMode === 'note'}
                                    placeholder={canReplyPublicly && replyMode === 'public'
                                        ? `Escribe una respuesta para el ${counterpart}... (usa @ para mencionar)`
                                        : (ticketModulo === 'volcan_desk'
                                            ? '🔒 Nota privada — solo la ve tu grupo resolutor... (usa @ para mencionar)'
                                            : '🔒 Nota privada — solo visible para ejecutivos y admins... (usa @ para mencionar)')
                                    }
                                    mentionableUsers={mentionableUsers}
                                    attachments={attachments}
                                    onAttachmentsChange={setAttachments}
                                    onChange={handleEditorChange}
                                />
                            </div>

                            <div className="reply-overlay-footer">
                                <div className="status-tip">
                                    {(!canReplyPublicly || replyMode === 'note')
                                        ? '🔒 Solo el equipo interno verá esto'
                                        : (ticketModulo === 'volcan_desk'
                                            ? '🔔 El solicitante verá esta respuesta y recibirá una notificación'
                                            : '🌐 El cliente recibirá un correo con esta respuesta')}
                                </div>
                                <div className="reply-btns">
                                    <button className="btn btn-secondary" onClick={() => setIsReplying(false)}>Cancelar</button>
                                    <button 
                                        className="btn btn-primary" 
                                        onClick={handleSendReply}
                                        disabled={!editorContent.text.trim()}
                                        style={(!canReplyPublicly || replyMode === 'note') ? { background: 'var(--color-warning)', color: '#000' } : {}}
                                    >
                                        {(!canReplyPublicly || replyMode === 'note') ? '💾 Guardar Nota' : '✉️ Enviar Respuesta'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* BARRA LATERAL DERECHA */}
            <div className="ticket-sidebar-right">
                {/* ─── ESTADO ─── */}
                <div className="property-group">
                    <label>Estado</label>
                    {canEdit ? (
                        ticket.ambito === 'interno' ? (
                            <select
                                className="property-select"
                                value={ticket.status}
                                onChange={(e) => {
                                    const newStatus = e.target.value;
                                    // Los subestados ("etiquetas") son exclusivos del estado
                                    // principal — si el nuevo estado no comparte esas opciones,
                                    // se limpian para no arrastrar un subestado que ya no aplica.
                                    const validValues = getEtiquetaOptionsForStatus(newStatus).map(o => o.value);
                                    const keptEtiquetas = (ticket.etiquetas || []).filter(v => validValues.includes(v));
                                    onUpdateField(ticket.id, { status: newStatus, etiquetas: keptEtiquetas });
                                }}
                            >
                                {INTERNAL_STATUSES.map(s => (
                                    <option key={s.id} value={s.id}>{s.label}</option>
                                ))}
                            </select>
                        ) : (
                            <select
                                className="property-select"
                                value={ticket.status}
                                onChange={(e) => onUpdateField(ticket.id, { status: e.target.value })}
                            >
                                <option value="new">Nuevo</option>
                                {config.statusCategories?.map(cat => {
                                    const subs = config.subStatuses?.[cat.id] || [];
                                    if (subs.length === 0) return <option key={cat.id} value={cat.id} disabled>{cat.label} (Sin sub-estados)</option>;
                                    return (
                                        <optgroup key={cat.id} label={cat.label}>
                                            {subs.map(sub => (
                                                <option key={sub.value} value={sub.value}>{sub.label}</option>
                                            ))}
                                        </optgroup>
                                    );
                                })}
                            </select>
                        )
                    ) : (
                        <div style={{ pointerEvents: 'none' }}>
                            <Badge variant={ticket.status === 'new' ? 'primary' : ticket.status === 'resolved' || ticket.status === 'done' ? 'success' : 'warning'}>
                                {resolveStatus(ticket.status)?.label || ticket.status}
                            </Badge>
                        </div>
                    )}
                </div>

                {/* ─── BLOQUEO Y ETIQUETAS (solo Volcán Desk) ─── */}
                {ticket.ambito === 'interno' && (
                    <div className="property-group">
                        <label>Bloqueo</label>
                        {canEdit ? (
                            <>
                                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', marginBottom: ticket.bloqueado ? 6 : 0, cursor: 'pointer' }}>
                                    <input
                                        type="checkbox"
                                        checked={!!ticket.bloqueado}
                                        onChange={(e) => onUpdateField(ticket.id, {
                                            bloqueado: e.target.checked,
                                            motivo_bloqueo: e.target.checked ? (ticket.motivo_bloqueo || 'on_hold') : null
                                        })}
                                    />
                                    Bloqueado (pausa el SLA)
                                </label>
                                {ticket.bloqueado && (
                                    <select
                                        className="property-select"
                                        value={ticket.motivo_bloqueo || 'on_hold'}
                                        onChange={(e) => onUpdateField(ticket.id, { motivo_bloqueo: e.target.value })}
                                    >
                                        {MOTIVO_BLOQUEO_OPTIONS.map(o => (
                                            <option key={o.value} value={o.value}>{o.label}</option>
                                        ))}
                                    </select>
                                )}
                            </>
                        ) : (
                            ticket.bloqueado ? (
                                <Badge variant="warning">
                                    🔒 {MOTIVO_BLOQUEO_OPTIONS.find(o => o.value === ticket.motivo_bloqueo)?.label || ticket.motivo_bloqueo}
                                </Badge>
                            ) : (
                                <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>No bloqueado</span>
                            )
                        )}
                    </div>
                )}

                {ticket.ambito === 'interno' && (() => {
                    const etiquetaOptions = getEtiquetaOptionsForStatus(ticket.status);
                    return (
                        <div className="property-group">
                            <label>Etiquetas</label>
                            {etiquetaOptions.length === 0 ? (
                                <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
                                    Sin subestados disponibles para "{resolveStatus(ticket.status)?.label || ticket.status}"
                                </span>
                            ) : canEdit ? (
                                <Multiselect
                                    options={etiquetaOptions}
                                    selected={ticket.etiquetas || []}
                                    onChange={(vals) => onUpdateField(ticket.id, { etiquetas: vals })}
                                    placeholder="Sin etiquetas"
                                />
                            ) : (
                                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                    {(ticket.etiquetas || []).length > 0 ? (ticket.etiquetas || []).map(e => (
                                        <Badge key={e} variant="primary" title={etiquetaOptions.find(o => o.value === e)?.description || ''}>
                                            {etiquetaOptions.find(o => o.value === e)?.label || e}
                                        </Badge>
                                    )) : <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>—</span>}
                                </div>
                            )}
                        </div>
                    );
                })()}

                {/* ─── PRODUCTO ─── */}
                <div className="property-group">
                    <label>Producto</label>
                    {canEdit ? (
                        <select
                            className="property-select"
                            value={ticket.product || ''}
                            onChange={(e) => onUpdateField(ticket.id, { product: e.target.value || null })}
                        >
                            <option value="">-- Seleccionar --</option>
                            {config.products?.filter(pr => (pr.modulo || 'voltik') === ticketModulo).map(pr => (
                                <option key={pr.id} value={pr.label}>{pr.label}</option>
                            ))}
                        </select>
                    ) : (
                        <div style={{ border: '1px solid var(--glass-border)', padding: '6px 12px', borderRadius: 'var(--radius-sm)', background: 'var(--color-bg-tertiary)', fontSize: '0.85rem' }}>
                            {ticket.product || '—'}
                        </div>
                    )}
                </div>

                {/* ─── PRIORIDAD & SLA ─── */}
                <div className="property-group">
                    <label>Prioridad & SLA</label>
                    {canEdit ? (
                        <select
                            className="property-select"
                            value={ticket.priority}
                            onChange={(e) => onUpdateField(ticket.id, { priority: e.target.value })}
                        >
                            {priorityOptions.map(p => (
                                <option key={p.id} value={p.value}>{p.label}</option>
                            ))}
                        </select>
                    ) : (
                        <div style={{ pointerEvents: 'none' }}>
                            <Badge style={selectedPriorityConf?.color ? { background: `${selectedPriorityConf.color}22`, color: selectedPriorityConf.color } : undefined}>
                                {selectedPriorityConf?.label || ticket.priority}
                            </Badge>
                        </div>
                    )}
                    
                    {/* SLA Progress Bar Indicator */}
                    {(() => {
                        const sla = computeSlaStatus(ticket, config);
                        if (sla.targetMinutes === -1) return null;
                        
                        let barColor = 'var(--color-success)';
                        if (sla.status === 'warning') barColor = 'var(--color-warning)';
                        if (sla.status === 'breached') barColor = 'var(--color-error)';

                        return (
                            <div style={{ marginTop: 12, padding: 8, background: 'var(--color-bg-secondary)', borderRadius: 'var(--radius-sm)' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', marginBottom: 4 }}>
                                    <span style={{ color: 'var(--color-text-muted)' }}>SLA Resolución</span>
                                    <span style={{ fontWeight: 600, color: sla.isTerminated ? 'var(--color-text-muted)' : barColor }}>
                                        {sla.isTerminated ? 'Detenido' : `${sla.percentage}%`}
                                    </span>
                                </div>
                                <div style={{ width: '100%', height: 4, background: 'var(--color-bg-tertiary)', borderRadius: 2, overflow: 'hidden' }}>
                                    <div style={{ width: `${Math.min(sla.percentage, 100)}%`, height: '100%', background: sla.isTerminated ? 'var(--color-text-muted)' : barColor }} />
                                </div>
                                <div style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', marginTop: 4, textAlign: 'right' }}>
                                    {(() => {
                                        const formatTime = (min) => {
                                            if (min < 60) return `${min}m`;
                                            const hrs = (min / 60).toFixed(1);
                                            return hrs.endsWith('.0') ? `${Math.round(min / 60)}h` : `${hrs}h`;
                                        };
                                        return `${formatTime(sla.elapsedMinutes)} de ${formatTime(sla.targetMinutes)}`;
                                    })()}
                                </div>
                            </div>
                        );
                    })()}
                </div>

                {/* ─── GRUPO ─── */}
                <div className="property-group">
                    <label>Grupo</label>
                    {canEdit ? (
                        <select
                            className="property-select"
                            value={ticket.resolver_group_id || ''}
                            onChange={(e) => {
                                const selectedGroupVal = e.target.value;
                                const gName = groups.find(g => g.id === selectedGroupVal)?.name || selectedGroupVal;
                                // Categoría/Tipo/Prioridad son catálogos propios de cada grupo en Volcán
                                // Desk — al cambiar de grupo, los valores del grupo anterior ya no aplican.
                                const resetScoped = ticketModulo === 'volcan_desk'
                                    ? { category: null, type: null, priority: null }
                                    : {};
                                onUpdateField(ticket.id, { group: gName, resolver_group_id: selectedGroupVal, ...resetScoped });
                            }}
                        >
                            <option value="">-- Seleccionar --</option>
                            {deskGroups.map(g => (
                                <option key={g.id} value={g.id}>{g.name}</option>
                            ))}
                        </select>
                    ) : (
                        <div style={{ border: '1px solid var(--glass-border)', padding: '6px 12px', borderRadius: 'var(--radius-sm)', background: 'var(--color-bg-tertiary)', fontSize: '0.85rem' }}>
                            {groups.find(g => g.id === (ticket.resolver_group_id || ticket.group))?.name || ticket.group || '—'}
                        </div>
                    )}
                </div>

                {/* ─── CATEGORÍA ─── */}
                <div className="property-group">
                    <label>Categoría</label>
                    {canEdit ? (
                        <select
                            className="property-select"
                            value={ticket.category || ''}
                            onChange={(e) => onUpdateField(ticket.id, { category: e.target.value || null })}
                        >
                            <option value="">-- Seleccionar --</option>
                            {categoryOptions.map(c => (
                                <option key={c.id} value={c.id}>{c.label}</option>
                            ))}
                        </select>
                    ) : (
                        <div style={{ border: '1px solid var(--glass-border)', padding: '6px 12px', borderRadius: 'var(--radius-sm)', background: 'var(--color-bg-tertiary)', fontSize: '0.85rem' }}>
                            {categoryOptions.find(c => c.id === ticket.category)?.label || ticket.category || '—'}
                        </div>
                    )}
                </div>

                {/* ─── TIPO ─── */}
                <div className="property-group">
                    <label>Tipo</label>
                    {canEdit ? (
                        <select
                            className="property-select"
                            value={ticket.type || ''}
                            onChange={(e) => onUpdateField(ticket.id, { type: e.target.value || null })}
                        >
                            <option value="">-- Seleccionar --</option>
                            {typeOptions.map(t => (
                                <option key={t.id} value={t.id}>{t.label}</option>
                            ))}
                        </select>
                    ) : (
                        <div style={{ border: '1px solid var(--glass-border)', padding: '6px 12px', borderRadius: 'var(--radius-sm)', background: 'var(--color-bg-tertiary)', fontSize: '0.85rem' }}>
                            {typeOptions.find(t => t.id === ticket.type)?.label || ticket.type || '—'}
                        </div>
                    )}
                </div>

                {ticketModulo === 'volcan_desk' && (
                    <>
                        {/* ─── PLANIFICACIÓN (Volcán Desk) ─── */}
                        <div className="property-group">
                            <label>Fecha estimada de inicio</label>
                            {canEdit ? (
                                <input
                                    type="date"
                                    className="property-select"
                                    value={ticket.fecha_estimada_inicio || ''}
                                    onChange={(e) => onUpdateField(ticket.id, { fecha_estimada_inicio: e.target.value || null })}
                                />
                            ) : (
                                <div style={{ border: '1px solid var(--glass-border)', padding: '6px 12px', borderRadius: 'var(--radius-sm)', background: 'var(--color-bg-tertiary)', fontSize: '0.85rem' }}>
                                    {formatDateShort(ticket.fecha_estimada_inicio) || '—'}
                                </div>
                            )}
                        </div>

                        <div className="property-group">
                            <label>Fecha estimada de conclusión</label>
                            {canEdit ? (
                                <input
                                    type="date"
                                    className="property-select"
                                    value={ticket.fecha_estimada_conclusion || ''}
                                    onChange={(e) => onUpdateField(ticket.id, { fecha_estimada_conclusion: e.target.value || null })}
                                />
                            ) : (
                                <div style={{ border: '1px solid var(--glass-border)', padding: '6px 12px', borderRadius: 'var(--radius-sm)', background: 'var(--color-bg-tertiary)', fontSize: '0.85rem' }}>
                                    {formatDateShort(ticket.fecha_estimada_conclusion) || '—'}
                                </div>
                            )}
                        </div>

                        {ticket.fecha_estimada_inicio && ticket.fecha_estimada_conclusion && (
                            <div className="property-group">
                                <label>Estimación SLA</label>
                                <div style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
                                    {businessDaysBetween(ticket.fecha_estimada_inicio, ticket.fecha_estimada_conclusion)} día(s) hábil(es)
                                </div>
                            </div>
                        )}

                        <div className="property-group">
                            <label>Fecha de resolución</label>
                            <div style={{ border: '1px solid var(--glass-border)', padding: '6px 12px', borderRadius: 'var(--radius-sm)', background: 'var(--color-bg-tertiary)', fontSize: '0.85rem', color: ticket.fecha_resolucion ? 'var(--color-text-main)' : 'var(--color-text-muted)' }}>
                                {ticket.fecha_resolucion ? formatDate(ticket.fecha_resolucion) : 'Aún no resuelto — se llena sola al cerrar el ticket'}
                            </div>
                        </div>
                    </>
                )}

                <div className="property-divider" />

                {/* ─── PROPIETARIO ─── */}
                <div className="property-group">
                    <label>Propietario</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0' }}>
                        <span style={{ fontSize: '0.9rem', fontWeight: '600', color: 'var(--color-text-main)' }}>
                            {users.find(u => u.id === ticket.owner_agent_id)?.name || 'Sin propietario'}
                        </span>
                        {ticket.previous_owner_id && (
                            <Badge 
                                variant="warning" 
                                title={`Propietario anterior: ${users.find(u => u.id === ticket.previous_owner_id)?.name || 'Desconocido'}`}
                                style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', cursor: 'help' }}
                            >
                                🔀 Transferido
                            </Badge>
                        )}
                    </div>
                </div>

                {/* ─── ASIGNADO A (RESOLUTOR) ─── */}
                <div className="property-group">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                        <label style={{ margin: 0 }}>Asignado A</label>
                        {ticket.resolver_group_id && !ticket.previous_owner_id && (
                            <span style={{ fontSize: '11px', background: '#eff6ff', color: '#1d4ed8', padding: '2px 6px', borderRadius: '4px', fontWeight: '600' }}>
                                Escalado → {groups.find(g => g.id === ticket.resolver_group_id)?.name || ticket.group}
                            </span>
                        )}
                    </div>
                    {canEdit ? (
                        <>
                            <select
                                className="property-select"
                                value={ticket.resolver_agent_id || ticket.assignedTo || ''}
                                onChange={(e) => onUpdateField(ticket.id, { resolver_agent_id: e.target.value || null })}
                            >
                                <option value="">Sin Asignar</option>
                                {users
                                    .filter(u => u.role === 'admin' || u.role === 'agent')
                                    // Volcán Desk: el responsable solo puede ser alguien del grupo
                                    // resolutor actual (doc "lógica de visualización" §5-7, CA05/CA08)
                                    // — Voltik conserva el comportamiento histórico (cualquier agente).
                                    // El responsable ACTUAL siempre debe aparecer (aunque ya no
                                    // califique, p.ej. admin sin grupos propios) — si no, el
                                    // <select> no encuentra su valor actual entre las opciones y
                                    // se ve como "Sin Asignar" aunque el ticket sí tenga responsable.
                                    .filter(u => u.id === (ticket.resolver_agent_id || ticket.assignedTo) || ticketModulo !== 'volcan_desk' || !effectiveGroupId || u.groups?.includes(effectiveGroupId))
                                    .map(u => (
                                        <option key={u.id} value={u.id}>{u.name} ({u.role})</option>
                                    ))}
                            </select>
                            {ticketModulo === 'volcan_desk' && !(ticket.resolver_agent_id || ticket.assignedTo) && isAuthorizedGroupMember && (
                                <button
                                    type="button"
                                    className="btn btn-secondary"
                                    style={{ fontSize: '12px', height: '28px', marginTop: '6px', width: '100%' }}
                                    onClick={() => onUpdateField(ticket.id, { resolver_agent_id: currentUser.id })}
                                >
                                    Tomar ticket
                                </button>
                            )}
                        </>
                    ) : (
                        <div style={{ padding: '6px 0', fontSize: '0.9rem', fontWeight: '500' }}>
                            {users.find(u => u.id === (ticket.resolver_agent_id || ticket.assignedTo))?.name || 'Sin Asignar'}
                        </div>
                    )}
                </div>

                {/* ─── ESCALAMIENTO A OTRO GRUPO/AGENTE ─── */}
                {canEdit && (
                    <div id="escalate-panel" style={{ background: 'var(--color-bg-secondary)', border: '1px dashed var(--glass-border)', padding: '12px', borderRadius: 'var(--radius-md)', marginTop: '16px' }}>
                        <span style={{ fontSize: '11px', fontWeight: '700', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '8px' }}>Escalar / Transferir</span>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            <div>
                                <label style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginBottom: '2px', display: 'block' }}>Grupo Destino</label>
                                <select 
                                    className="property-select"
                                    value={escalateGroup}
                                    onChange={(e) => {
                                        setEscalateGroup(e.target.value);
                                        setEscalateAgent('');
                                    }}
                                    style={{ fontSize: '12px', height: '32px', padding: '2px 8px' }}
                                >
                                    <option value="">-- Seleccionar Grupo --</option>
                                    {deskGroups.map(g => (
                                        <option key={g.id} value={g.id}>{g.name} {g.transfiere_propiedad ? '⚡ (Transfiere)' : ''}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginBottom: '2px', display: 'block' }}>Agente Destino <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(opcional — el grupo destino puede tomarlo después)</span></label>
                                <select
                                    className="property-select"
                                    value={escalateAgent}
                                    onChange={(e) => setEscalateAgent(e.target.value)}
                                    style={{ fontSize: '12px', height: '32px', padding: '2px 8px' }}
                                    disabled={!escalateGroup}
                                >
                                    <option value="">Sin asignar</option>
                                    {users
                                        .filter(u => u.role === 'admin' || u.role === 'agent')
                                        .filter(u => !escalateGroup || u.groups?.includes(escalateGroup))
                                        .map(u => (
                                            <option key={u.id} value={u.id}>{u.name}</option>
                                        ))
                                    }
                                </select>
                            </div>
                            <button
                                className="btn btn-primary"
                                style={{ fontSize: '12px', height: '32px', marginTop: '4px', background: 'var(--color-text-main)', color: 'var(--color-bg-main)' }}
                                disabled={!escalateGroup}
                                onClick={() => {
                                    const g = groups.find(x => x.id === escalateGroup);
                                    const a = users.find(x => x.id === escalateAgent);
                                    // Escalar SIN elegir agente deja "Sin asignar" a propósito (CA09) —
                                    // el grupo destino se encarga de tomarlo desde ahí.
                                    onEscalate(ticket.id, escalateGroup, escalateAgent || null, g.transfiere_propiedad, g.name, a?.name || 'Sin asignar');
                                    setEscalateGroup('');
                                    setEscalateAgent('');
                                }}
                            >
                                Escalar ahora
                            </button>
                        </div>
                    </div>
                )}

                <div className="property-divider" />

                {/* ─── DATOS DEL SOLICITANTE ─── */}
                <div className="requester-card">
                    <div className="requester-card-title">Solicitante</div>

                    {/* Avatar + nombre */}
                    <div className="requester-avatar-row">
                        <div className="requester-avatar">
                            {ticketContact?.avatar
                                ? <img src={ticketContact.avatar} alt={ticketContact.name} />
                                : <span>{(ticketContact?.name || ticketCreator?.name || 'US').substring(0,2).toUpperCase()}</span>
                            }
                        </div>
                        <div>
                            <div className="requester-name">{ticketContact?.name || ticketCreator?.name || '—'}</div>
                            <div className="requester-role-badge">{ticketContact?.role || ticketCreator?.role || 'client'}</div>
                        </div>
                    </div>

                    <div className="requester-fields">
                        <div className="requester-field">
                            <span className="rf-label">Correo</span>
                            <span className="rf-value">{ticketContact?.email || ticketCreator?.email || '—'}</span>
                        </div>
                        {(ticketContact?.phone || ticketCreator?.phone) && (
                            <div className="requester-field">
                                <span className="rf-label">Teléfono</span>
                                <span className="rf-value">{ticketContact?.phone || ticketCreator?.phone}</span>
                            </div>
                        )}
                        {/* Volcán Desk: el solicitante no tiene empresa, tiene grupo — mostrar el
                            grupo solicitante (foto del grupo del creador al levantar el ticket),
                            con fallback al grupo actual del creador para tickets viejos que no
                            tenían area_origen_id todavía. */}
                        {ticketModulo === 'volcan_desk' ? (
                            <div className="requester-field">
                                <span className="rf-label">Grupo</span>
                                <span className="rf-value rf-company">
                                    {groups.find(g => g.id === (ticket.area_origen_id || ticketCreator?.groups?.[0]))?.name || '—'}
                                </span>
                            </div>
                        ) : (
                            <div className="requester-field">
                                <span className="rf-label">Empresa</span>
                                <span className="rf-value rf-company">{ticketCompany?.name || '—'}</span>
                            </div>
                        )}
                        <div className="requester-field">
                            <span className="rf-label">Fecha</span>
                            <span className="rf-value">
                                {createdDate ? createdDate.toLocaleDateString('es-MX', { day:'2-digit', month:'short', year:'numeric' }) : '—'}
                            </span>
                        </div>
                        <div className="requester-field">
                            <span className="rf-label">Hora</span>
                            <span className="rf-value">
                                {createdDate ? createdDate.toLocaleTimeString('es-MX', { hour:'2-digit', minute:'2-digit' }) : '—'}
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}