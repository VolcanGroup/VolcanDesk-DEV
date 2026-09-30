import React, { useState, useEffect, useRef } from 'react';
import DOMPurify from 'dompurify';
import './TicketDetailView.css';

// La descripción del ticket y los comentarios se guardan como HTML crudo
// (vienen de RichTextEditor, que permite pegar HTML desde el portapapeles) y
// se renderizaban con dangerouslySetInnerHTML sin sanitizar — XSS almacenado:
// cualquiera que pudiera crear un ticket o comentario (incluido un cliente)
// podía inyectar un payload que se ejecutaba para todo el que abriera el
// ticket después. La config por default de DOMPurify ya quita <script>,
// atributos on* y hrefs "javascript:" — no se personaliza para no debilitarla.
const sanitizeHtml = (html) => DOMPurify.sanitize(html || '');
import { formatRelativeTime, formatExactTime, formatDate, formatDateShort, businessDaysBetween, formatDatePill } from '../utils/helpers';
import {
    IoArrowBack,
    IoLockClosed,
    IoSend,
    IoDocumentText,
    IoEllipsisVertical,
    IoArrowForwardOutline,
    IoPeopleOutline,
    IoWarningOutline,
    IoArrowUndoOutline,
    IoAttachOutline,
    IoDownloadOutline,
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
    IoCheckmark,
    IoLinkOutline,
    IoTrashOutline,
    IoExpandOutline,
    IoContractOutline,
} from 'react-icons/io5';
import Badge from './Badge';
import RichTextEditor from './RichTextEditor';
import Modal from './Modal';
import { addNotification } from '../services/notificationService';
import { getCompanyById, getContactById } from '../services/companyService';
import { getConfig, resolveStatus, INTERNAL_STATUSES, MOTIVO_BLOQUEO_OPTIONS, getEtiquetaOptionsForStatus } from '../services/configService';
import { computeSlaStatus } from '../services/ticketService';
import { getGroups } from '../services/groupService';
import { API_ORIGIN, api } from '../services/api';
import AttachmentPill from './AttachmentPill';
import ClickToEdit from './ClickToEdit';
import SidebarSection from './SidebarSection';
import TicketProgressStepper from './TicketProgressStepper';
import MessageEditBox from './MessageEditBox';

// Paleta de colores por participante (2026-09-18, a pedido del usuario) —
// cada persona en la conversación mantiene el mismo color de avatar/nombre en
// TODOS sus mensajes, sin importar si el mensaje queda a la izquierda o a la
// derecha (eso lo sigue decidiendo isRight; esto es aparte, para distinguir
// entre varios participantes del mismo lado). Se soportan hasta 20 personas
// distintas antes de que el color se repita — un hash simple y determinista
// del id de usuario elige siempre el mismo color para la misma persona.
const PARTICIPANT_COLORS = [
    '#2563EB', '#DC2626', '#059669', '#7C3AED', '#DB2777',
    '#D97706', '#0891B2', '#65A30D', '#9333EA', '#E11D48',
    '#0D9488', '#CA8A04', '#4F46E5', '#C2410C', '#0284C7',
    '#BE185D', '#16A34A', '#7E22CE', '#B91C1C', '#0369A1',
];
const getParticipantColor = (userId) => {
    if (!userId) return '#64748B';
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
        hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
    }
    return PARTICIPANT_COLORS[hash % PARTICIPANT_COLORS.length];
};

export default function TicketDetailView({
    ticket, users, currentUser, config,
    onBack, onUpdateStatus, onUpdatePriority, onUpdateAssignee, onAddComment,
    onEditComment, onDeleteComment,
    onUpdateField, onEscalate, onMarkAsRead
}) {
    const [replyMode, setReplyMode] = useState('public');
    const [editorContent, setEditorContent] = useState({ html: '', text: '', mentionedUserIds: [], attachments: [] });
    const [attachments, setAttachments] = useState([]);
    const [previewAttachment, setPreviewAttachment] = useState(null);
    // Cambios del panel lateral derecho (Estado/Etiqueta/Prioridad/Bloqueado/
    // Responsabilidad/Clasificación/Planificación) en borrador hasta que se
    // confirman con "Guardar cambios" — antes cada select/input guardaba solo
    // con elegir la opción (reportado en vivo 2026-09-10: "si por un dedazo
    // pone mal un dato, ya se registró"). Se resetea solo al cambiar de ticket;
    // navegar fuera sin guardar simplemente descarta el borrador (mismo
    // criterio que cualquier formulario sin guardar).
    const [pendingChanges, setPendingChanges] = useState({});
    const [isSavingChanges, setIsSavingChanges] = useState(false);
    useEffect(() => { setPendingChanges({}); }, [ticket.id]);
    const stageChange = (fields) => setPendingChanges(prev => ({ ...prev, ...fields }));
    const draftValue = (key) => (pendingChanges[key] !== undefined ? pendingChanges[key] : ticket[key]);
    const hasPendingChanges = Object.keys(pendingChanges).length > 0;
    const handleDiscardChanges = () => setPendingChanges({});
    const handleSaveChanges = async () => {
        if (!hasPendingChanges) return;
        setIsSavingChanges(true);
        try {
            onUpdateField(ticket.id, pendingChanges);
            // Aviso en el chat (mismo estilo que "Solicitar apoyo") cuando la
            // estimación HU cambió — antes se disparaba en el propio onChange,
            // ahora recién al confirmar el guardado.
            if (pendingChanges.estimacion_hus !== undefined && pendingChanges.estimacion_hus !== null) {
                onAddComment(ticket.id, `<span data-hus-consulta="1"><strong>${currentUser?.name}</strong> (${grupoResolutor}) ha estimado la HU en <strong>${pendingChanges.estimacion_hus} horas</strong></span>`, false, []);
            }
            setPendingChanges({});
        } finally {
            setIsSavingChanges(false);
        }
    };
    const [isReplying, setIsReplying] = useState(false);
    // Antes "Enviar Respuesta"/"Guardar Nota" cerraba el editor de inmediato, sin
    // esperar a que el adjunto realmente terminara de subirse al servidor — con
    // archivos grandes parecía que no había pasado nada, y algunos usuarios volvían
    // a adjuntar el mismo archivo pensando que había fallado (reportado en vivo
    // 2026-09-07). Ahora se espera onAddComment antes de cerrar/limpiar, y mientras
    // tanto el botón queda deshabilitado y dice "Guardando…".
    const [isSendingReply, setIsSendingReply] = useState(false);
    // Responder citando un mensaje/nota puntual (estilo WhatsApp) — guarda una
    // vista previa congelada (autor + fragmento de texto) más el id del
    // original, para poder saltar a él con scroll+resaltado al hacer clic en
    // la cita dentro de la respuesta ya enviada.
    const [replyingTo, setReplyingTo] = useState(null);
    // Alternar la barra compacta a un editor expandido (2026-09-24, a pedido
    // del usuario) — para respuestas largas/informes formales. Es solo una
    // clase CSS sobre el mismo contentEditable (no se desmonta ni se
    // reemplaza por otro editor), así que el texto ya escrito nunca se
    // pierde al expandir/contraer.
    const [isComposerExpanded, setIsComposerExpanded] = useState(false);
    // Editar/eliminar un comentario propio dentro de 60s de enviado
    // (2026-09-23, a pedido del usuario). editingCommentId + editingText
    // controlan el modo edición inline (reemplaza el cuerpo del mensaje por
    // un contentEditable simple con Guardar/Cancelar, no el RichTextEditor
    // completo — es una corrección rápida, no una redacción nueva).
    const [editingCommentId, setEditingCommentId] = useState(null);
    const [editingText, setEditingText] = useState('');
    // Cita ("Responder a este mensaje") que pudiera venir embebida al INICIO
    // de comment.text — se separa del cuerpo editable para que el editor no
    // deje escribir encima de ella (bug reportado en vivo 2026-09-24: borrar
    // todo el contenido dejaba editar "dentro" de la cita). Se guarda aparte
    // y se vuelve a anteponer tal cual al guardar.
    const [editingQuoteHtml, setEditingQuoteHtml] = useState('');
    // Momento (Date.now()) en que se le dio clic al lápiz — se manda al
    // servidor como `startedEditingAt` para que la ventana de 60s solo se
    // exija al EMPEZAR a editar, no otra vez al guardar (2026-09-28, a
    // pedido del usuario: "no importa el tiempo que tarde" una vez que ya
    // dio clic a tiempo).
    const [editingStartedAt, setEditingStartedAt] = useState(null);
    const [isSavingEdit, setIsSavingEdit] = useState(false);
    // Error de editar/eliminar (típicamente "ya pasó el minuto") — antes se
    // mostraba con alert() nativo, que bloquea TODA la pestaña hasta que
    // alguien le da OK (confirmado en vivo probando esto mismo: un alert()
    // colgado hace parecer que la app se congeló). Mensaje normal en pantalla,
    // se limpia solo a los 4s.
    const [commentActionError, setCommentActionError] = useState('');
    useEffect(() => {
        if (!commentActionError) return;
        const t = setTimeout(() => setCommentActionError(''), 4000);
        return () => clearTimeout(t);
    }, [commentActionError]);
    const EDIT_WINDOW_MS = 60 * 1000;
    // "Reloj" que avanza cada 3s solo para que los botones de editar/eliminar
    // desaparezcan solos cuando se cumple el minuto — sin esto, una vez
    // renderizado el botón se quedaría visible indefinidamente hasta el
    // siguiente refresco de datos (cada 30s de polling), que es demasiado
    // tarde para que el límite se sienta real.
    const [editWindowTick, setEditWindowTick] = useState(() => Date.now());
    useEffect(() => {
        const interval = setInterval(() => setEditWindowTick(Date.now()), 3000);
        return () => clearInterval(interval);
    }, []);
    const canEditOrDelete = (comment) =>
        !comment.isDeleted && comment.userId === currentUser?.id
        && (editWindowTick - new Date(comment.createdAt).getTime()) < EDIT_WINDOW_MS;
    // Copiar texto de la conversación (burbujas de mensaje/nota) arrastraba el
    // fondo de color al pegar en otra app (Word, correo, Slack...) — el
    // navegador arma el HTML del portapapeles con los estilos YA calculados
    // (incluido background de la burbuja verde/blanca), no solo con las clases
    // CSS originales. Reportado en vivo 2026-09-29: "se ve feo". Se intercepta
    // el evento copy SOLO cuando la selección empieza dentro del hilo
    // (.conversation-scroll-area) y se manda nada más el texto plano — fuera
    // de ese contenedor (ej. copiar un campo de formulario) el navegador sigue
    // con su comportamiento normal.
    useEffect(() => {
        const handleCopy = (e) => {
            const selection = window.getSelection();
            if (!selection || selection.isCollapsed) return;
            const anchorEl = selection.anchorNode?.nodeType === 1
                ? selection.anchorNode
                : selection.anchorNode?.parentElement;
            if (!anchorEl?.closest?.('.conversation-scroll-area')) return;
            e.clipboardData.setData('text/plain', selection.toString());
            e.preventDefault();
        };
        document.addEventListener('copy', handleCopy);
        return () => document.removeEventListener('copy', handleCopy);
    }, []);
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
    const [openSidebarSection, setOpenSidebarSection] = useState('Ejecución');
    const [showMoreActions, setShowMoreActions] = useState(false);
    // Confirmación breve del botón "Copiar enlace" (ver ticket-header-actions más abajo).
    const [linkCopied, setLinkCopied] = useState(false);
    const [linkCopyFailed, setLinkCopyFailed] = useState(false);
    const handleCopyLink = async () => {
        // Tickets.jsx ya mantiene la URL visible en sync con el ticket abierto
        // (?ticket=<id>), así que copiar window.location.href alcanza — no hay que
        // reconstruir el link a mano aquí.
        const text = window.location.href;
        let copied = false;
        // navigator.clipboard.writeText exige un contexto seguro (HTTPS o
        // localhost) — este servidor se sirve en HTTP plano por IP interna
        // (http://10.23.105.36:5173), así que esto siempre fallaba en silencio
        // aquí (bug reportado en vivo 2026-08-27: el botón decía "Copiado" pero
        // nunca copiaba nada de verdad, porque el catch de abajo no distinguía
        // éxito de fallo).
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
                copied = true;
            }
        } catch (e) { /* cae al fallback de abajo */ }
        if (!copied) {
            // Fallback que sí funciona en HTTP: document.execCommand('copy') está
            // deprecado pero todos los navegadores actuales lo siguen soportando
            // justo para este caso (sin acceso a la Clipboard API moderna).
            try {
                const textarea = document.createElement('textarea');
                textarea.value = text;
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.focus();
                textarea.select();
                copied = document.execCommand('copy');
                document.body.removeChild(textarea);
            } catch (e) { /* copied sigue false */ }
        }
        if (copied) {
            setLinkCopied(true);
            setTimeout(() => setLinkCopied(false), 1500);
        } else {
            // No fingir éxito si de verdad no se pudo copiar — el usuario puede
            // copiar la URL directo de la barra de direcciones.
            setLinkCopyFailed(true);
            setTimeout(() => setLinkCopyFailed(false), 2500);
        }
    };
    // El botón/estado "Copiar enlace público" (Volcán Desk, link de solo lectura sin
    // sesión) se agregó aquí el 2026-08-27 y se REVIRTIÓ el mismo día junto con las
    // rutas de backend que dependían de Ticket.public_share_token — esa columna
    // nunca se creó de verdad en la BD y tumbó las consultas de tickets. Ver el
    // comentario largo en db.js/server.js antes de reintentar.
    const moreActionsRef = useRef(null);
    const [showSupportModal, setShowSupportModal] = useState(false);
    const [showTransferModal, setShowTransferModal] = useState(false);
    const [supportGroup, setSupportGroup] = useState('');
    const [supportReason, setSupportReason] = useState('');
    const [transferGroup, setTransferGroup] = useState('');
    const [transferAgent, setTransferAgent] = useState('');
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
    const isInternalUser = currentUser?.role === 'admin' || currentUser?.role === 'agent' || currentUser?.role === 'group_admin';
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

    // Un group_admin pertenece a su grupo administrado (admin_group_id) aunque su
    // columna `groups` esté vacía/desactualizada — mismo criterio ya usado arriba
    // para "Tomar ticket"/asignar (bug real: Javier Polanco, `groups: []`).
    const isMemberOfGroup = (u, groupId) => {
        if (!u || !groupId) return false;
        if (u.role === 'group_admin' && u.admin_group_id === groupId) return true;
        return (u.groups || []).includes(groupId);
    };

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
    // Simétrico a isAuthorizedGroupMember (cualquier miembro del grupo RESOLUTOR puede
    // responder, no solo el responsable asignado) — hasta 2026-09-29 el lado
    // SOLICITANTE no tenía su equivalente: solo la persona exacta que dio clic en
    // "Crear Solicitud" (isRequester) podía responder, aunque un compañero de su
    // mismo equipo (mismo area_origen_id) quisiera dar seguimiento al ticket de su
    // propio grupo. checkTicketAccess (quién puede VER el ticket, en server.js) ya
    // trataba a area_origen_id de forma simétrica desde antes — esto solo lleva ese
    // mismo criterio a "quién puede responder". Reportado en vivo: Sofía (grupo
    // Producto) no podía responder un ticket que su compañera Cindy (también
    // Producto) había creado hacia Soporte TI.
    const isAuthorizedRequesterGroupMember = currentUser?.role === 'admin'
        || (currentUser?.role === 'group_admin' && currentUser?.admin_group_id === ticket.area_origen_id)
        || (!!ticket.area_origen_id && (currentUser?.groups || []).includes(ticket.area_origen_id));
    const canReplyPublicly = isClient || isRequester || (ticketModulo === 'volcan_desk' ? (isAuthorizedGroupMember || isAuthorizedRequesterGroupMember) : isOwner);

    // De qué lado ve ESTE usuario el ticket (Volcán Desk no tiene rol 'client',
    // así que "hay algo sin leer" no se puede resolver por rol como en Voltik —
    // ver mismo criterio en canReplyPublicly, justo arriba). Usado por
    // "Marcar como leído" más abajo (auto-marcado + botón).
    const viewerSide = ticketModulo === 'volcan_desk'
        ? (isRequester ? 'solicitante' : isAuthorizedGroupMember ? 'resolutor' : isAuthorizedRequesterGroupMember ? 'solicitante' : null)
        : null;
    const hasUnreadReply = ticketModulo === 'volcan_desk'
        ? (viewerSide === 'solicitante'
            ? ticket.ultimo_mensaje_de === 'resolutor' && !ticket.visto_por_cliente
            : viewerSide === 'resolutor'
                ? ticket.ultimo_mensaje_de === 'solicitante' && !ticket.visto_por_agente
                : false)
        : (isClient
            ? ticket.ultimo_mensaje_de === 'agente' && !ticket.visto_por_cliente
            : ticket.ultimo_mensaje_de === 'cliente' && !ticket.visto_por_agente);

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
    const productOptions = scopedByGroup(config.products);
    const selectedPriorityConf = priorityOptions.find(p => p.value === ticket.priority);
    const grupoResolutor = groups.find(g => g.id === effectiveGroupId)?.name || ticket.group || 'Sin grupo';

    let parsedApoyos = [];
    if (typeof ticket.apoyos === 'string') {
        try { parsedApoyos = JSON.parse(ticket.apoyos); } catch(e) {}
    } else if (Array.isArray(ticket.apoyos)) {
        parsedApoyos = ticket.apoyos;
    }
    // Miembro de un grupo que solo fue consultado para dar apoyo puntual (no es
    // el dueño/resolutor del ticket) — puede ver/responder notas y cambiar el
    // estado de su propio apoyo, sin tener el resto de permisos de canEdit.
    const isSupportGroupMember = parsedApoyos.some(a =>
        currentUser?.role === 'admin'
        || (currentUser?.role === 'group_admin' && currentUser?.admin_group_id === a.grupo_solicitado)
        || (currentUser?.groups || []).includes(a.grupo_solicitado)
    );

    // Auto-marcar como leído al entrar al detalle (indicador se limpia al abrir, no requiere acción manual)
    useEffect(() => {
        if (hasUnreadReply && onMarkAsRead) {
            onMarkAsRead(ticket.id);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ticket.id]);

    // Si el usuario solo es del grupo de apoyo (no es el dueño/resolutor), abre
    // directamente la sección "Apoyos Solicitados" para que vea de inmediato
    // qué se le pidió, sin tener que navegar por Ejecución o Responsabilidad.
    useEffect(() => {
        const isOwnerGroup = (currentUser?.groups || []).includes(effectiveGroupId)
            || (currentUser?.role === 'group_admin' && currentUser?.admin_group_id === effectiveGroupId)
            || currentUser?.role === 'admin';
        if (!isOwnerGroup && isSupportGroupMember && parsedApoyos.length > 0) {
            setOpenSidebarSection('Apoyos');
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ticket.id]);

    // Cerrar el menú "Más acciones" al hacer click fuera
    useEffect(() => {
        if (!showMoreActions) return;
        const handler = (e) => {
            if (moreActionsRef.current && !moreActionsRef.current.contains(e.target)) setShowMoreActions(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [showMoreActions]);

    // Use resolveStatus for accurate label+color from the new configService
    const getStatusLabel = (val) => {
        if (!val) return { label: '—', color: '#999' };
        const r = resolveStatus(val);
        return { label: r.label, color: r.color };
    };

    const handleEditorChange = (data) => {
        setEditorContent(data);
    };

    // Convierte el HTML guardado de un comentario/nota a texto plano corto,
    // para la vista previa de la cita — igual que hace WhatsApp con el mensaje
    // al que se responde.
    const plainTextSnippet = (html, max = 120) => {
        const tmp = document.createElement('div');
        tmp.innerHTML = html || '';
        const text = (tmp.textContent || '').replace(/\s+/g, ' ').trim();
        return text.length > max ? `${text.slice(0, max)}…` : text;
    };

    // Un comentario que responde a otro guarda el bloque de cita PEGADO al
    // inicio de su propio comment.text (ver handleSendReply: `quoted + text`)
    // — no vive aparte. Para editar sin dejar tocar la cita, se separa aquí
    // en {quoteHtml, bodyHtml}; se reconstruyen igual (quoteHtml + bodyHtml)
    // al guardar. El bloque siempre tiene la misma forma exacta (generada por
    // esta misma app, nunca por el usuario a mano), así que un patrón fijo
    // basta — no hace falta un parser HTML real.
    const splitQuotedReply = (html) => {
        const match = (html || '').match(/^(<div class="quoted-reply"[^>]*>.*?<\/div><\/div>)/s);
        if (!match) return { quoteHtml: '', bodyHtml: html || '' };
        return { quoteHtml: match[1], bodyHtml: html.slice(match[1].length) };
    };

    const handleReplyToComment = (comment) => {
        const commenter = users.find(u => u.id === comment.userId);
        setReplyingTo({
            id: comment.id,
            authorName: commenter?.name || 'Usuario',
            snippet: plainTextSnippet(comment.text),
            isNote: comment.isPrivate,
        });
        // Responder a una nota debe seguir siendo nota; responder a un mensaje
        // público, público (si el permiso lo permite) — "con sus reglas".
        setReplyMode(comment.isPrivate ? 'note' : (canReplyPublicly ? 'public' : 'note'));
        setIsReplying(true);
    };

    const handleStartEditComment = (comment) => {
        const { quoteHtml, bodyHtml } = splitQuotedReply(comment.text);
        setEditingCommentId(comment.id);
        setEditingQuoteHtml(quoteHtml);
        setEditingText(bodyHtml);
        setEditingStartedAt(Date.now());
    };

    const handleCancelEditComment = () => {
        setEditingCommentId(null);
        setEditingText('');
        setEditingQuoteHtml('');
        setEditingStartedAt(null);
    };

    const handleSaveEditComment = async (comment) => {
        if (isSavingEdit) return;
        const text = editingText.trim();
        if (!text) return;
        setIsSavingEdit(true);
        try {
            await onEditComment(ticket.id, comment.id, editingQuoteHtml + editingText, editingStartedAt);
            setEditingCommentId(null);
            setEditingText('');
            setEditingQuoteHtml('');
            setEditingStartedAt(null);
        } catch (err) {
            console.error('Error al editar el comentario:', err);
            setCommentActionError('No se pudo guardar la edición — es posible que ya haya pasado el minuto permitido.');
        } finally {
            setIsSavingEdit(false);
        }
    };

    const handleDeleteComment = async (comment) => {
        if (!window.confirm('¿Eliminar este mensaje? Los demás verán "Mensaje eliminado" en su lugar.')) return;
        try {
            await onDeleteComment(ticket.id, comment.id);
        } catch (err) {
            console.error('Error al eliminar el comentario:', err);
            setCommentActionError('No se pudo eliminar el mensaje — es posible que ya haya pasado el minuto permitido.');
        }
    };

    const handleSendReply = async () => {
        if (isSendingReply) return; // evita doble envío mientras ya se está guardando
        const text = editorContent.html?.trim() || editorContent.text?.trim();
        if (!text) return;

        const isNote = !canReplyPublicly || replyMode === 'note';
        const quoted = replyingTo
            ? `<div class="quoted-reply" data-reply-id="${replyingTo.id}"><div class="quoted-reply-author">${replyingTo.authorName}</div><div class="quoted-reply-text">${replyingTo.snippet.replace(/</g, '&lt;')}</div></div>`
            : '';

        setIsSendingReply(true);
        try {
            await onAddComment(ticket.id, quoted + text, isNote, attachments);

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

            // Resetear estado — solo una vez que el adjunto de verdad ya se guardó.
            setAttachments([]);
            setEditorContent({ html: '', text: '', mentionedUserIds: [], attachments: [] });
            setIsReplying(false);
            setReplyingTo(null);
            setIsComposerExpanded(false);
        } catch (err) {
            console.error('Error al enviar la respuesta:', err);
            // Antes: alert() genérico ("Intenta de nuevo") que ignoraba el mensaje
            // real del servidor (err.message, ya viene armado por api.js desde
            // errorBody.error) — un rechazo de permiso claro y correcto (ej. "Solo
            // un miembro del grupo resolutor... puede crear notas privadas") se
            // mostraba como si fuera una falla técnica transitoria, y un alert()
            // nativo además congela toda la pestaña. Reportado en vivo 2026-09-28
            // con Sofía. Mismo banner inline que ya usa la edición/borrado de
            // comentarios (commentActionError, se autolimpia a los 4s).
            setCommentActionError(err.message || 'No se pudo guardar la respuesta. Intenta de nuevo.');
        } finally {
            setIsSendingReply(false);
        }
    };

    // Salta al mensaje/nota original al hacer clic en una cita (data-reply-id)
    // dentro de una respuesta ya enviada — con un resaltado breve para ubicarlo.
    const scrollToQuotedMessage = (e) => {
        const quoteEl = e.target.closest('.quoted-reply');
        if (!quoteEl) return;
        e.stopPropagation(); // no disparar el colapsar/expandir del mensaje contenedor
        const targetId = quoteEl.getAttribute('data-reply-id');
        const target = document.getElementById(`msg-${targetId}`);
        if (!target) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('msg-highlight-flash');
        setTimeout(() => target.classList.remove('msg-highlight-flash'), 1600);
    };

    // Descarga de un campo dinámico tipo "archivo": /api/uploads ya no acepta un
    // <a href> directo (ver server.js) — primero hay que pedir un token firmado y de
    // corta duración con una petición autenticada de verdad (esta sí manda los
    // headers x-user-id/x-user-role vía api.js), y solo entonces abrir el archivo con
    // ese token en la URL. Así el link final no se puede editar a mano para suplantar
    // a otro usuario, como sí se podía si el uid iba en crudo en la URL.
    const [archivoDownloadState, setArchivoDownloadState] = useState({ id: null, status: null }); // status: 'loading' | 'error'
    const handleDownloadArchivoField = async (cvId, fileUrl, displayName) => {
        if (archivoDownloadState.status === 'loading') return;
        setArchivoDownloadState({ id: cvId, status: 'loading' });
        try {
            // El nombre en la URL (fileUrl) es el nombre de almacenamiento en disco
            // (un UUID, para no chocar entre archivos distintos con el mismo nombre
            // original) — nunca el que debe ver el usuario. displayName es el
            // fileName real guardado en TicketCampoValor.valor (ej. "CDF - Carga
            // 16sep.txt"); reportado en vivo 2026-09-17: se descargaba con el UUID.
            const storageFilename = fileUrl.split('/').pop();
            const filename = displayName || storageFilename;
            const { token } = await api.get(`/uploads/${storageFilename}/token`);
            const downloadUrl = `${API_ORIGIN}${fileUrl}?token=${encodeURIComponent(token)}`;
            // window.open() dejaba que el navegador decidiera cómo mostrar el
            // archivo según su Content-Type — para .txt (y cualquier otro tipo que
            // el navegador sepa renderizar) eso lo abría en la pestaña en vez de
            // descargarlo (reportado en vivo 2026-09-17: "esto siempre se debe
            // poder descargar"). El atributo `download` de un <a> no alcanza por
            // sí solo: frontend (5174) y backend (4001) son orígenes distintos, y
            // los navegadores ignoran `download` en links cross-origin. Se baja el
            // archivo primero como blob (fetch sí puede ser cross-origin, con CORS
            // ya abierto en este backend) y se fuerza la descarga desde ese blob
            // —mismo truco que ya usa handleDownload para adjuntos normales, que
            // si funciona porque ahí el dato ya viene embebido, no por URL.
            const res = await fetch(downloadUrl);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();
            const blobUrl = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = blobUrl;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(blobUrl);
            setArchivoDownloadState({ id: null, status: null });
        } catch (err) {
            console.error('Error al generar el enlace de descarga:', err);
            setArchivoDownloadState({ id: cvId, status: 'error' });
            setTimeout(() => setArchivoDownloadState(prev => (prev.id === cvId ? { id: null, status: null } : prev)), 3000);
        }
    };

    const handleDownload = (att) => {
        const link = document.createElement('a');
        link.href = att.dataUrl;
        link.download = att.name;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const ticketCreator = users.find(u => u.id === ticket.createdBy);
    const creatorInitials = ticketCreator ? ticketCreator.name.substring(0, 2).toUpperCase() : 'US';
    const ticketCompany = getCompanyById(ticket.companyId);
    const ticketContact = ticket.contactId ? (getContactById(ticket.contactId) || users.find(u => u.id === ticket.contactId)) : null;
    const createdDate = ticket.createdAt ? new Date(ticket.createdAt) : null;

    // Solo agentes/admins/admin de grupo pueden ser mencionados — y, en Volcán
    // Desk, solo si pertenecen al grupo SOLICITANTE o al grupo RESOLUTOR de este
    // ticket puntual. Antes no había ningún filtro por grupo: aparecía cualquier
    // agent/group_admin/admin de TODA la app, mezclando gente de grupos que no
    // tienen nada que ver con este ticket (reportado en vivo 2026-09-07). 'admin'
    // se queda sin acotar — no pertenece a ningún grupo puntual y puede necesitar
    // que lo mencionen en cualquier ticket.
    const mentionableRelevantGroupIds = ticket.ambito === 'interno'
        ? [effectiveGroupId, ticket.area_origen_id].filter(Boolean)
        : null;
    const belongsToMentionableGroup = (u) => {
        if (!mentionableRelevantGroupIds) return true; // Voltik: sin cambios, sin concepto de grupo aquí.
        if (u.role === 'group_admin') return mentionableRelevantGroupIds.includes(u.admin_group_id);
        return (u.groups || []).some(gid => mentionableRelevantGroupIds.includes(gid));
    };
    const mentionableUsers = users.filter(u =>
        (u.role === 'admin' || u.role === 'agent' || u.role === 'group_admin') && belongsToMentionableGroup(u)
    );

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
                                {act.type === 'apoyo_solicitado' && <IoPeopleOutline size={14} />}
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
                                    {act.type === 'apoyo_solicitado' && (
                                        <>
                                            {' solicitó apoyo al grupo '}<strong>{act.data?.grupoConsultado}</strong>
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginLeft: 'auto' }}>
                        {/* ─── BARRA DE ACCIONES RÁPIDAS ─── movida aquí arriba (junto a
                            Volver a Tickets/Copiar enlace) a pedido del usuario 2026-08-27 —
                            antes vivía en su propia fila debajo del stepper de avance. */}
                        {!isReplying && !(ticketModulo === 'volcan_desk' && isInternalUser && activeTicketTab === 'actividad') && (
                            <>
                                {/* Antes este botón no tenía ningún chequeo de permiso propio: si
                                    canReplyPublicly era false, se relabeleaba solo a "Nota Privada" y
                                    abría el compositor en modo nota — sin fijarse si el usuario en
                                    realidad cumple isAuthorizedGroupMember/isSupportGroupMember (la
                                    misma condición que SÍ protege al botón "Nota" de abajo desde
                                    2026-09-21). Alguien sin ningún derecho sobre el ticket (ej. de un
                                    grupo periférico, sin apoyo activo) igual veía "Nota Privada" y
                                    escribía algo que el servidor iba a rechazar — reportado en vivo
                                    2026-09-28 con Sofía. Ahora el botón no aparece si no hay NINGÚN
                                    modo válido disponible para este usuario en este ticket. */}
                                {(canReplyPublicly || isAuthorizedGroupMember || isSupportGroupMember) && (
                                    <button className="toolbar-btn primary-btn" onClick={() => {
                                        setReplyingTo(null);
                                        setReplyMode(canReplyPublicly ? 'public' : 'note');
                                        setIsReplying(true);
                                    }}>
                                        <IoArrowUndoOutline size={15} /> {canReplyPublicly ? 'Responder' : 'Nota Privada'}
                                    </button>
                                )}

                                {/* "Nota Privada" solo tiene sentido para quien SÍ puede verla después —
                                    el grupo resolutor actual, el/los grupo(s) de apoyo activo, o admin
                                    (misma condición que ya usa el filtro de lectura del lado servidor,
                                    ver sanitizeTicketForUser en server.js). Antes esto solo exigía
                                    canReplyPublicly && isInternalUser, así que el propio SOLICITANTE
                                    (canReplyPublicly=true vía isRequester, sin ser del grupo resolutor)
                                    podía escribir una nota privada que ni él mismo volvía a ver después
                                    — confirmado en vivo 2026-09-21 con una nota real de un solicitante
                                    que desapareció hasta para su propio autor. */}
                                {(isAuthorizedGroupMember || isSupportGroupMember) && (
                                    <button className="toolbar-btn note-btn" onClick={() => {
                                        setReplyingTo(null);
                                        setReplyMode('note');
                                        setIsReplying(true);
                                    }}>
                                        <IoLockClosed size={15} /> Nota
                                    </button>
                                )}

                                {canEdit && (
                                    <button className="toolbar-btn" onClick={() => setShowSupportModal(true)}>
                                        <IoPeopleOutline size={15} /> Solicitar apoyo a otro grupo
                                    </button>
                                )}
                            </>
                        )}
                        {/* Copiar enlace directo a este ticket — visible para cualquiera que
                            pueda ver el ticket (no solo canEdit), ya que un solicitante también
                            puede querer compartir/embeber el link de su propio ticket. */}
                        <button
                            className="activity-btn"
                            onClick={handleCopyLink}
                            title={linkCopyFailed ? 'No se pudo copiar automáticamente — copia la URL de la barra de direcciones' : 'Copiar enlace directo a este ticket'}
                        >
                            {linkCopied ? <IoCheckmark size={16} /> : <IoLinkOutline size={16} />}
                            {linkCopied ? 'Copiado' : linkCopyFailed ? 'No se pudo copiar' : 'Copiar enlace'}
                        </button>
                        {/* Botón Marcar como leído: aparece solo si hay respuesta no leída */}
                        {(() => {
                            if (!hasUnreadReply || !onMarkAsRead) return null;
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

                {commentActionError && (
                    <div className="comment-action-error">{commentActionError}</div>
                )}

                {/* A partir de aquí todo vive dentro de UN solo contenedor con scroll
                    (.conversation-scroll-area) — antes .ticket-header-actions era lo
                    único visible siempre, pero título/breadcrumb/stepper/pestañas
                    también se quedaban fijos por vivir fuera del área con scroll,
                    robándole espacio vertical a la conversación (reportado en vivo
                    2026-09-18). Solo .ticket-header-actions (arriba) se queda fijo. */}
                <div className="conversation-scroll-area">
                {/* ─── ENCABEZADO COMPACTO DEL TICKET ─── */}
                <div className="ticket-conv-header">
                    <div className="ticket-conv-title">{ticket.title}</div>
                    {ticketModulo === 'volcan_desk' && (() => {
                        const creatorUser = users.find(u => u.id === ticket.createdBy);
                        const solicitante = creatorUser?.name || 'Desconocido';
                        // Fallback al grupo actual del creador para tickets que se crearon sin
                        // area_origen_id (bug corregido 2026-09-14, ver Tickets.jsx) — un
                        // group_admin guarda su grupo en admin_group_id, no en groups.
                        const grupoSolicitante = groups.find(g => g.id === (
                            ticket.area_origen_id
                            || (creatorUser?.role === 'group_admin' ? creatorUser?.admin_group_id : creatorUser?.groups?.[0])
                        ))?.name || '—';
                        const responsable = users.find(u => u.id === (ticket.resolver_agent_id || ticket.assignedTo))?.name || null;
                        const estado = getStatusLabel(ticket.status).label;
                        return (
                            <div className="ticket-conv-meta">
                                <span className="tcm-id">#{ticket.id}</span>
                                <span className="tcm-sep">·</span>
                                <span>{solicitante}</span>
                                <span className="tcm-sep">·</span>
                                <span>{grupoSolicitante}</span>
                                <span className="tcm-arrow">→</span>
                                <span>{grupoResolutor}</span>
                                {responsable && <><span className="tcm-sep">·</span><span>{responsable}</span></>}
                                <span className="tcm-sep">·</span>
                                <span>{estado}</span>
                            </div>
                        );
                    })()}
                    {ticketModulo !== 'volcan_desk' && (
                        <div className="ticket-conv-meta">
                            <span className="tcm-id">#{ticket.id}</span>
                        </div>
                    )}
                </div>

                {/* ─── LÍNEA DE TIEMPO DE AVANCE (Volcán Desk) ─── */}
                {ticketModulo === 'volcan_desk' && <TicketProgressStepper status={ticket.status} />}

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
                    activityTimelineContent
                ) : (
                    <div className="conversation-thread">
                        {(() => {
                            // Píldora de fecha (rediseño 2026-09-18): se calcula sobre la marcha
                            // mientras se recorre el hilo — lastPillDate vive en el closure de este
                            // IIFE, no en un state (no hace falta re-render por esto).
                            let lastPillDate = null;
                            const maybeDatePill = (dateStr) => {
                                const key = new Date(dateStr).toDateString();
                                if (key === lastPillDate) return null;
                                lastPillDate = key;
                                return (
                                    <div className="msg-date-pill-row" key={`pill-${key}`}>
                                        <span className="msg-date-pill">{formatDatePill(dateStr)}</span>
                                    </div>
                                );
                            };
                            return (
                        <>
                        {maybeDatePill(ticket.createdAt)}
                        {/* Mensaje Inicial — Solicitante */}
                        <div className="msg-row msg-left msg-initial-card">
                            <div className="msg-top">
                                <div className="msg-avatar" style={{ background: getParticipantColor(ticketCreator?.id), color: '#fff' }}>{creatorInitials}</div>
                                <span className="msg-author" style={{ color: getParticipantColor(ticketCreator?.id) }}>{ticketCreator?.name || 'Cliente'}</span>
                                {ticketCompany && (
                                    <span className="rf-company" style={{ fontSize: '0.78rem' }}>{ticketCompany.name}</span>
                                )}
                                {ticketModulo === 'volcan_desk' && (
                                    <span className="author-role-badge exec-badge">Solicitante</span>
                                )}
                            </div>
                            <div className="msg-bubble">
                                <div className="msg-body" dangerouslySetInnerHTML={{ __html: sanitizeHtml(ticket.description) }} />

                                {ticket.camposValores && ticket.camposValores.length > 0 && (() => {
                                    // Ficha técnica de campos dinámicos (rediseño 2026-09-18, a pedido
                                    // del usuario): antes se veían como texto plano "Etiqueta: valor"
                                    // apilado, sin conexión visual con la Categoría/Tipo que los generó
                                    // (doc "Reglas de Flujo") — ahora es una tarjeta propia, con
                                    // encabezado de trazabilidad y grid de pares clave/valor que se
                                    // adapta solo a la cantidad de campos (1 campo = un bloque destacado
                                    // a lo ancho; 2+ = rejilla). El dato en sí siempre fue estructurado
                                    // (ticket.camposValores, un array real) — nunca fue texto concatenado
                                    // en la descripción, esto es solo el rediseño visual.
                                    const catLabel = categoryOptions.find(c => c.id === ticket.category)?.label;
                                    const typeLabel = typeOptions.find(t => t.id === ticket.type)?.label;
                                    const traceLabel = [typeLabel, catLabel].filter(Boolean).join(' · ');
                                    return (
                                        <div className="msg-fields-card">
                                            <div className="msg-fields-card-inner">
                                                <div className="msg-fields-header">
                                                    <span className="msg-fields-title">
                                                        {traceLabel || 'Campos del formulario'}
                                                    </span>
                                                    <span className="msg-fields-subtitle">Formulario de Solicitud</span>
                                                </div>
                                                <div className="msg-fields-grid">
                                                    {ticket.camposValores.map(cv => {
                                                        if (cv.Campo?.tipo_dato === 'archivo') {
                                                            let archivo = null;
                                                            try { archivo = JSON.parse(cv.valor); } catch { /* valor legado o vacío */ }
                                                            return (
                                                                <div key={cv.id}>
                                                                    <span className="msg-fields-item-label">{cv.Campo?.nombre || 'Campo'}</span>
                                                                    {archivo?.fileUrl ? (
                                                                        <div
                                                                            className="attachment-pill"
                                                                            style={{ marginTop: 2 }}
                                                                            onClick={() => handleDownloadArchivoField(cv.id, archivo.fileUrl, archivo.fileName)}
                                                                        >
                                                                            <IoAttachOutline size={14} />
                                                                            <span>
                                                                                {archivoDownloadState.id === cv.id && archivoDownloadState.status === 'error'
                                                                                    ? 'Error, reintentar'
                                                                                    : archivo.fileName}
                                                                            </span>
                                                                        </div>
                                                                    ) : (
                                                                        <span className="msg-fields-item-value">—</span>
                                                                    )}
                                                                </div>
                                                            );
                                                        }
                                                        return (
                                                            <div key={cv.id}>
                                                                <span className="msg-fields-item-label">{cv.Campo?.nombre || 'Campo'}</span>
                                                                <span className="msg-fields-item-value">
                                                                    {cv.Campo?.tipo_dato === 'moneda' ? `$${cv.valor}` : cv.valor}
                                                                </span>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })()}

                                {ticket.attachments && ticket.attachments.length > 0 && (
                                    <div className="message-attachments">
                                        {ticket.attachments.map(att => (
                                            <AttachmentPill key={att.id} att={att} onDownload={handleDownload} onPreview={setPreviewAttachment} />
                                        ))}
                                    </div>
                                )}
                                <div className="msg-bubble-footer">
                                    {formatRelativeTime(ticket.createdAt)} · {formatExactTime(ticket.createdAt)}
                                </div>
                            </div>
                        </div>

                        {/* Comentarios / Respuestas (FILTRADO POR PRIVACIDAD) */}
                        {[...(ticket.comments || [])]
                            .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
                            .filter(comment => isAuthorizedGroupMember || isSupportGroupMember || !comment.isPrivate)
                            .map((comment, commentIdx, commentsArr) => {
                            const isNote = comment.isPrivate;
                            // Estampa de "solicitar apoyo": PÚBLICA (la ve el solicitante también,
                            // a diferencia de la nota con la consulta real) pero no es un mensaje
                            // de conversación — es un aviso tipo WhatsApp ("Fulano solicitó apoyo
                            // a X"), texto plano centrado, sin burbuja.
                            const isApoyoStamp = typeof comment.text === 'string' && comment.text.includes('data-apoyo-consulta');
                            // Estampa de "Estimación HUs capturada" — mismo estilo de aviso
                            // plano centrado que la de apoyo, pero en rojo para distinguirla.
                            const isHusStamp = typeof comment.text === 'string' && comment.text.includes('data-hus-consulta');
                            // La nota con la consulta real de un apoyo (privada, igual que
                            // cualquier nota interna) se marca aparte para que quien la reciba
                            // la reconozca de inmediato como una petición de ayuda y no como una
                            // nota interna cualquiera del equipo.
                            const isApoyoNota = isNote && typeof comment.text === 'string' && comment.text.includes('data-apoyo-nota');
                            const commenter = users.find(u => u.id === comment.userId);
                            const initials = commenter ? commenter.name.substring(0, 2).toUpperCase() : 'EX';
                            const role = commenter?.role || 'client';
                            const isAgentOrAdmin = role === 'admin' || role === 'agent' || role === 'group_admin';
                            const isRequesterComment = comment.userId === ticket.createdBy;
                            const commenterIsResolverSide = isMemberOfGroup(commenter, effectiveGroupId);
                            // Alineación: solo mis propios mensajes a la derecha, todo lo demás a
                            // la izquierda — vuelto al criterio simple a pedido del usuario
                            // (2026-09-17). Hubo una versión que agrupaba por EQUIPO (todo mi lado
                            // del ticket a la derecha, no solo lo mío) entre 2026-09-07 y hoy; se
                            // quitó porque para alguien que pertenece al grupo resolutor, hacía que
                            // los mensajes de OTRA persona de su mismo equipo (ej. el solicitante,
                            // si por casualidad también es del grupo resolutor) también salieran a
                            // la derecha, confundiendo quién dijo qué.
                            const isRight = comment.userId === currentUser?.id;
                            // ─── Etiqueta de autor por grupo (Volcán Desk) ───
                            // En una conversación de soporte interno, "Ejecutivo" no dice quién
                            // está hablando. Mostramos en su lugar de qué grupo habla: el
                            // solicitante se marca como tal, un miembro del grupo resolutor
                            // actual se marca "Resolutor · <grupo>", y cualquier otro interno
                            // (ej. admin sin grupo propio) cae a su propio grupo o a "Admin".
                            const commenterGroupLabel = ticketModulo === 'volcan_desk' ? (() => {
                                if (isRequesterComment) return 'Solicitante';
                                if (commenterIsResolverSide) {
                                    const gName = groups.find(g => g.id === effectiveGroupId)?.name;
                                    return gName ? `Resolutor · ${gName}` : 'Resolutor';
                                }
                                const ownGroupId = commenter?.role === 'group_admin' ? commenter.admin_group_id : commenter?.groups?.[0];
                                const ownGroupName = ownGroupId ? groups.find(g => g.id === ownGroupId)?.name : null;
                                return ownGroupName || (role === 'admin' ? 'Admin' : null);
                            })() : null;

                            return (
                                <React.Fragment key={comment.id}>
                                {maybeDatePill(comment.createdAt)}
                                <div id={`msg-${comment.id}`} className={[
                                    'msg-row',
                                    (isApoyoStamp || isHusStamp) ? 'msg-center' : (isNote ? 'msg-note msg-center' : (isRight ? 'msg-right' : 'msg-left'))
                                ].filter(Boolean).join(' ')}>
                                    {isApoyoStamp ? (
                                        <div className="msg-apoyo-stamp">
                                            <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(comment.text) }} />
                                            <span className="msg-apoyo-time">{formatRelativeTime(comment.createdAt)} · {formatExactTime(comment.createdAt)}</span>
                                        </div>
                                    ) : isHusStamp ? (
                                        <div className="msg-apoyo-stamp msg-hus-stamp">
                                            <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(comment.text) }} />
                                            <span className="msg-apoyo-time">{formatRelativeTime(comment.createdAt)} · {formatExactTime(comment.createdAt)}</span>
                                        </div>
                                    ) : isNote ? (
                                        <div className={`msg-note-container ${isApoyoNota ? 'msg-note-apoyo' : ''}`}>
                                            <div className="msg-note-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                                <span className="msg-note-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                                    {isApoyoNota ? 'CONSULTA DE APOYO' : 'NOTA INTERNA'} <IoLockClosed size={11} />
                                                </span>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                    {!comment.isDeleted && canEditOrDelete(comment) && editingCommentId !== comment.id && (
                                                        <>
                                                            <button
                                                                className="msg-reply-btn"
                                                                title="Editar (menos de 1 min desde que se envió)"
                                                                onClick={(e) => { e.stopPropagation(); handleStartEditComment(comment); }}
                                                            >
                                                                <IoPencilOutline size={13} />
                                                            </button>
                                                            <button
                                                                className="msg-reply-btn"
                                                                title="Eliminar (menos de 1 min desde que se envió)"
                                                                onClick={(e) => { e.stopPropagation(); handleDeleteComment(comment); }}
                                                            >
                                                                <IoTrashOutline size={13} />
                                                            </button>
                                                        </>
                                                    )}
                                                    <button
                                                        className="msg-reply-btn"
                                                        title="Responder a esta nota"
                                                        onClick={(e) => { e.stopPropagation(); handleReplyToComment(comment); }}
                                                    >
                                                        <IoArrowUndoOutline size={13} />
                                                    </button>
                                                </div>
                                            </div>
                                            <span className="msg-note-author" style={{ color: getParticipantColor(commenter?.id) }}>{commenter?.name}</span>
                                            {comment.isDeleted ? (
                                                <div className="msg-note-body msg-deleted-body">Mensaje eliminado</div>
                                            ) : editingCommentId === comment.id ? (
                                                <MessageEditBox
                                                    text={editingText}
                                                    quoteHtml={editingQuoteHtml}
                                                    onChange={setEditingText}
                                                    onCancel={(e) => { e.stopPropagation(); handleCancelEditComment(); }}
                                                    onSave={(e) => { e.stopPropagation(); handleSaveEditComment(comment); }}
                                                    saving={isSavingEdit}
                                                />
                                            ) : (
                                                <>
                                                    <div className="msg-note-body" onClick={scrollToQuotedMessage} dangerouslySetInnerHTML={{ __html: sanitizeHtml(comment.text) }} />
                                                    {comment.attachments && comment.attachments.length > 0 && (
                                                        <div className="message-attachments" style={{ marginTop: 8 }}>
                                                            {comment.attachments.map(att => (
                                                                <AttachmentPill key={att.id} att={att} onDownload={handleDownload} onPreview={setPreviewAttachment} onClickCapture={e => e.stopPropagation()} />
                                                            ))}
                                                        </div>
                                                    )}
                                                </>
                                            )}
                                            <div className="msg-bubble-footer" style={{ textAlign: 'left', marginTop: 4 }}>
                                                {formatRelativeTime(comment.createdAt)} · {formatExactTime(comment.createdAt)}
                                                {!comment.isDeleted && comment.editedAt && ' · (editado)'}
                                            </div>
                                        </div>
                                    ) : (
                                        <>
                                            <div className="msg-top">
                                                {isRight ? (
                                                    <>
                                                        <span className="msg-author" style={{ color: getParticipantColor(commenter?.id) }}>{commenter?.name || 'Usuario'}</span>
                                                        {isAgentOrAdmin && ticketModulo === 'volcan_desk' && commenterGroupLabel && (
                                                            <span className="author-role-badge exec-badge">{commenterGroupLabel}</span>
                                                        )}
                                                        {isAgentOrAdmin && ticketModulo !== 'volcan_desk' && (
                                                            <span className="author-role-badge exec-badge">Ejecutivo</span>
                                                        )}
                                                        <div className="msg-avatar" style={{ background: getParticipantColor(commenter?.id), color: '#fff' }}>{initials}</div>
                                                    </>
                                                ) : (
                                                    <>
                                                        <div className="msg-avatar" style={{ background: getParticipantColor(commenter?.id), color: '#fff' }}>{initials}</div>
                                                        <span className="msg-author" style={{ color: getParticipantColor(commenter?.id) }}>{commenter?.name || 'Usuario'}</span>
                                                        {isAgentOrAdmin && ticketModulo === 'volcan_desk' && commenterGroupLabel && (
                                                            <span className="author-role-badge exec-badge">{commenterGroupLabel}</span>
                                                        )}
                                                        {isAgentOrAdmin && ticketModulo !== 'volcan_desk' && (
                                                            <span className="author-role-badge exec-badge">Ejecutivo</span>
                                                        )}
                                                    </>
                                                )}
                                                {!comment.isDeleted && canEditOrDelete(comment) && editingCommentId !== comment.id && (
                                                    <>
                                                        <button
                                                            className="msg-reply-btn"
                                                            title="Editar (menos de 1 min desde que se envió)"
                                                            onClick={(e) => { e.stopPropagation(); handleStartEditComment(comment); }}
                                                        >
                                                            <IoPencilOutline size={13} />
                                                        </button>
                                                        <button
                                                            className="msg-reply-btn"
                                                            title="Eliminar (menos de 1 min desde que se envió)"
                                                            onClick={(e) => { e.stopPropagation(); handleDeleteComment(comment); }}
                                                        >
                                                            <IoTrashOutline size={13} />
                                                        </button>
                                                    </>
                                                )}
                                                <button
                                                    className="msg-reply-btn"
                                                    title="Responder a este mensaje"
                                                    onClick={(e) => { e.stopPropagation(); handleReplyToComment(comment); }}
                                                >
                                                    <IoArrowUndoOutline size={13} />
                                                </button>
                                            </div>

                                            <div className={`msg-bubble ${isRight ? 'msg-bubble-blue' : ''}`}>
                                                {comment.isDeleted ? (
                                                    <div className="msg-body msg-deleted-body">Mensaje eliminado</div>
                                                ) : editingCommentId === comment.id ? (
                                                    <MessageEditBox
                                                        text={editingText}
                                                        quoteHtml={editingQuoteHtml}
                                                        onChange={setEditingText}
                                                        onCancel={(e) => { e.stopPropagation(); handleCancelEditComment(); }}
                                                        onSave={(e) => { e.stopPropagation(); handleSaveEditComment(comment); }}
                                                        saving={isSavingEdit}
                                                    />
                                                ) : (
                                                    <>
                                                        <div className="msg-body" onClick={scrollToQuotedMessage} dangerouslySetInnerHTML={{ __html: sanitizeHtml(comment.text) }} />

                                                        {comment.attachments && comment.attachments.length > 0 && (
                                                            <div className="message-attachments">
                                                                {comment.attachments.map(att => (
                                                                    <AttachmentPill key={att.id} att={att} onDownload={handleDownload} onPreview={setPreviewAttachment} />
                                                                ))}
                                                            </div>
                                                        )}
                                                    </>
                                                )}

                                                <div className="msg-bubble-footer">
                                                    {formatRelativeTime(comment.createdAt)} · {formatExactTime(comment.createdAt)}
                                                    {!comment.isDeleted && comment.editedAt && ' · (editado)'}
                                                </div>
                                            </div>
                                        </>
                                    )}
                                </div>
                                </React.Fragment>
                            );
                        })}
                        </>
                            );
                        })()}
                    </div>
                )}
                </div>


                {/* Capa de Respuesta (Overlay) — rediseño 2026-09-24 a barra
                    compacta estilo WhatsApp/Intercom (pedido explícito del
                    usuario, con spec detallada). Antes era una tarjeta fija
                    de ~400px con título+X, pestañas grandes y toolbar de
                    formato siempre visible; ahora es una barra angosta en
                    reposo (el editor de RichTextEditor crece solo con el
                    texto) con: toggle tipo píldora Pública/Privada, cita de
                    "responder a este mensaje" arriba del input si aplica,
                    accesos rápidos (adjuntar/plantillas/@/emoji) + editor +
                    botón de enviar circular en una sola fila, y la barra de
                    formato clásica colapsada detrás de "Aa". */}
                {isReplying && (() => {
                    const isNoteMode = !canReplyPublicly || replyMode === 'note';
                    const requesterUser = users.find(u => u.id === ticket.createdBy);
                    return (
                    <div className="reply-overlay fade-in">
                        <div className={`reply-panel reply-panel-compact ${isNoteMode ? 'note-mode' : ''}`}>
                            <div className="reply-bar-top">
                                <div className="reply-pill-toggle">
                                    {canReplyPublicly && (
                                        <button
                                            type="button"
                                            className={`reply-pill ${replyMode === 'public' ? 'active' : ''}`}
                                            onClick={() => setReplyMode('public')}
                                        >
                                            <IoSend size={12} /> Pública
                                        </button>
                                    )}
                                    {/* Mismo criterio que el botón "Nota" de la barra de arriba — ver ese
                                        comentario. Antes solo pedía isInternalUser, así que la pestaña
                                        "Nota Privada" aparecía incluso dentro del modal de "Responder" para
                                        alguien sin acceso a leerla después (ej. el solicitante). */}
                                    {isInternalUser && (isAuthorizedGroupMember || isSupportGroupMember) && (
                                        <button
                                            type="button"
                                            className={`reply-pill reply-pill-note ${isNoteMode ? 'active' : ''}`}
                                            onClick={() => setReplyMode('note')}
                                        >
                                            <IoLockClosed size={12} /> Privada
                                        </button>
                                    )}
                                </div>
                                <div className="reply-visibility-hint">
                                    {isNoteMode
                                        ? 'Solo tu equipo la verá'
                                        : `Visible para ${requesterUser?.name || counterpartCap} · recibirá notificación`}
                                </div>
                                <button
                                    type="button"
                                    className="btn-icon reply-expand-btn"
                                    onClick={() => setIsComposerExpanded(e => !e)}
                                    title={isComposerExpanded ? 'Volver a la barra compacta' : 'Expandir editor'}
                                >
                                    {isComposerExpanded ? <IoContractOutline size={16}/> : <IoExpandOutline size={16}/>}
                                </button>
                                <button className="btn-icon reply-close-btn" onClick={() => { setIsReplying(false); setReplyingTo(null); setIsComposerExpanded(false); }} title="Cerrar">
                                    <IoClose size={17}/>
                                </button>
                            </div>

                            {replyingTo && (
                                <div className="reply-quote-preview">
                                    <div className="reply-quote-bar" />
                                    <div className="reply-quote-content">
                                        <div className="quoted-reply-author">{replyingTo.authorName}</div>
                                        <div className="quoted-reply-text">{replyingTo.snippet}</div>
                                    </div>
                                    <button className="btn-icon" onClick={() => setReplyingTo(null)} title="Cancelar respuesta a este mensaje">
                                        <IoClose size={16} />
                                    </button>
                                </div>
                            )}

                            <div className="reply-editor-container">
                                <RichTextEditor
                                    compact
                                    expanded={isComposerExpanded}
                                    noteMode={isNoteMode}
                                    placeholder={!isNoteMode
                                        ? `Escribe una respuesta para el ${counterpart}... (usa @ para mencionar)`
                                        : (ticketModulo === 'volcan_desk'
                                            ? 'Nota privada — solo la ve tu grupo resolutor...'
                                            : 'Nota privada — solo visible para ejecutivos y admins...')
                                    }
                                    mentionableUsers={mentionableUsers}
                                    attachments={attachments}
                                    onAttachmentsChange={setAttachments}
                                    onChange={handleEditorChange}
                                    onSubmit={handleSendReply}
                                />
                                <button
                                    type="button"
                                    className="reply-send-circle"
                                    onClick={handleSendReply}
                                    disabled={!editorContent.text.trim() || isSendingReply}
                                    title={isSendingReply ? 'Guardando…' : (isNoteMode ? 'Guardar nota' : 'Enviar respuesta')}
                                >
                                    <IoSend size={16} />
                                </button>
                            </div>

                            {/* Además del banner de arriba del hilo (pensado para errores de
                                editar/borrar un mensaje ya existente), este mismo estado se
                                repite aquí — el compositor queda anclado abajo y ese otro banner
                                puede quedar fuera de vista mientras se escribe. */}
                            {commentActionError && (
                                <div className="comment-action-error reply-composer-error">{commentActionError}</div>
                            )}

                            <div className="reply-footer-hint">
                                Enter para enviar (Shift+Enter para salto de línea)
                            </div>
                        </div>
                    </div>
                    );
                })()}
            </div>

            {/* BARRA LATERAL DERECHA */}
            <div className="ticket-sidebar-right">
                {/* ════ 1. EJECUCIÓN ════ */}
                <SidebarSection title="Ejecución" isOpen={openSidebarSection === 'Ejecución'} onToggle={() => setOpenSidebarSection(openSidebarSection === 'Ejecución' ? null : 'Ejecución')}>
                    {/* ─── ESTADO ─── */}
                    <div className="property-group">
                        <label>Estado</label>
                        {canEdit ? (
                            ticket.ambito === 'interno' ? (
                                <select
                                    className={`property-select ${pendingChanges.status !== undefined ? 'has-pending-change' : ''}`}
                                    value={draftValue('status')}
                                    onChange={(e) => {
                                        const newStatus = e.target.value;
                                        // Los subestados ("etiquetas") son exclusivos del estado
                                        // principal — si el nuevo estado no comparte esas opciones,
                                        // se limpian para no arrastrar un subestado que ya no aplica.
                                        const validValues = getEtiquetaOptionsForStatus(newStatus).map(o => o.value);
                                        const keptEtiquetas = (draftValue('etiquetas') || []).filter(v => validValues.includes(v));
                                        stageChange({ status: newStatus, etiquetas: keptEtiquetas });
                                    }}
                                >
                                    {INTERNAL_STATUSES.map(s => (
                                        <option key={s.id} value={s.id}>{s.label}</option>
                                    ))}
                                </select>
                            ) : (
                                <select
                                    className={`property-select ${pendingChanges.status !== undefined ? 'has-pending-change' : ''}`}
                                    value={draftValue('status')}
                                    onChange={(e) => stageChange({ status: e.target.value })}
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

                    {/* ─── FECHA DE GENERACIÓN ─── */}
                    <div className="property-group">
                        <label>Fecha</label>
                        <div className="prop-readonly">{formatDate(ticket.createdAt)}</div>
                    </div>

                    {/* ─── ETIQUETA / SUBESTADO (solo Volcán Desk) ───
                        Antes usaba <Multiselect> (varias etiquetas a la vez) — a pedido del
                        usuario (2026-09-07) es de una sola a la vez, como un subestado normal:
                        <select> guarda el valor como array de un solo elemento para no cambiar
                        la forma del dato (Ticket.etiquetas sigue siendo JSON/array). */}
                    {ticket.ambito === 'interno' && (() => {
                        const draftStatus = draftValue('status');
                        const etiquetaOptions = getEtiquetaOptionsForStatus(draftStatus);
                        return (
                            <div className="property-group">
                                <label>Etiqueta</label>
                                {etiquetaOptions.length === 0 ? (
                                    <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
                                        Sin subestados disponibles para "{resolveStatus(draftStatus)?.label || draftStatus}"
                                    </span>
                                ) : canEdit ? (
                                    <select
                                        className={`property-select ${pendingChanges.etiquetas !== undefined ? 'has-pending-change' : ''}`}
                                        value={(draftValue('etiquetas') || [])[0] || ''}
                                        onChange={(e) => stageChange({ etiquetas: e.target.value ? [e.target.value] : [] })}
                                    >
                                        <option value="">Sin etiqueta</option>
                                        {etiquetaOptions.map(o => (
                                            <option key={o.value} value={o.value}>{o.label}</option>
                                        ))}
                                    </select>
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

                    {/* ─── PRIORIDAD & SLA ─── */}
                    <div className="property-group">
                        <label>Prioridad & SLA</label>
                        {canEdit ? (
                            <select
                                className={`property-select ${pendingChanges.priority !== undefined ? 'has-pending-change' : ''}`}
                                value={draftValue('priority')}
                                onChange={(e) => stageChange({ priority: e.target.value })}
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

                            if (sla.targetMinutes === null || sla.targetMinutes === 0) {
                                return (
                                    <div className="sla-block" style={{ marginTop: 12 }}>
                                        <div className="sla-row">
                                            <span className="sla-label">SLA Resolución</span>
                                            <span className="sla-pct" style={{ color: 'var(--color-text-muted)' }}>
                                                {sla.targetMinutes === 0 ? 'Sin límite' : 'Sin SLA'}
                                            </span>
                                        </div>
                                        {sla.targetMinutes === null && (
                                            <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginTop: 4 }}>
                                                Esta categoría aún no tiene un SLA configurado.
                                            </div>
                                        )}
                                    </div>
                                );
                            }

                            let barColor = 'var(--color-success)';
                            if (sla.status === 'warning') barColor = 'var(--color-warning)';
                            if (sla.status === 'breached') barColor = 'var(--color-error)';

                            return (
                                <div className="sla-block" style={{ marginTop: 12 }}>
                                    <div className="sla-row">
                                        <span className="sla-label">SLA Resolución</span>
                                        <span className="sla-pct" style={{ color: sla.isTerminated ? 'var(--color-text-muted)' : barColor }}>
                                            {sla.isTerminated ? 'Detenido' : `${sla.percentage}%`}
                                        </span>
                                    </div>
                                    <div className="sla-bar-track">
                                        <div className="sla-bar-fill" style={{ width: `${Math.min(sla.percentage, 100)}%`, background: sla.isTerminated ? 'var(--color-text-muted)' : barColor }} />
                                    </div>
                                    <div className="sla-time">
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

                    {/* ─── BLOQUEO (solo Volcán Desk) ─── */}
                    {ticket.ambito === 'interno' && (() => {
                        const bloqueoSla = computeSlaStatus(ticket, config);
                        return (
                        <div className="blocked-toggle-wrap">
                            {canEdit ? (
                                <>
                                    <label className={`blocked-toggle ${draftValue('bloqueado') ? 'is-blocked' : ''} ${pendingChanges.bloqueado !== undefined ? 'has-pending-change' : ''}`}>
                                        <div className="bt-switch-row">
                                            <input
                                                type="checkbox"
                                                checked={!!draftValue('bloqueado')}
                                                onChange={(e) => stageChange({
                                                    bloqueado: e.target.checked,
                                                    motivo_bloqueo: e.target.checked ? (draftValue('motivo_bloqueo') || 'on_hold') : null
                                                })}
                                            />
                                            <span className="bt-label">Bloqueado</span>
                                        </div>
                                        {draftValue('bloqueado') && (
                                            <span className="bt-sla-warn">
                                                {bloqueoSla.bloqueoCapExceeded ? '⏱ Se superó el tope de pausa — el SLA volvió a correr' : '⏸ Pausa el SLA'}
                                            </span>
                                        )}
                                    </label>
                                    {draftValue('bloqueado') && (
                                        <select
                                            className={`property-select ${pendingChanges.motivo_bloqueo !== undefined ? 'has-pending-change' : ''}`}
                                            style={{ marginTop: 6 }}
                                            value={draftValue('motivo_bloqueo') || 'on_hold'}
                                            onChange={(e) => stageChange({ motivo_bloqueo: e.target.value })}
                                        >
                                            {MOTIVO_BLOQUEO_OPTIONS.map(o => (
                                                <option key={o.value} value={o.value}>{o.label}</option>
                                            ))}
                                        </select>
                                    )}
                                </>
                            ) : (
                                ticket.bloqueado ? (
                                    <div className="blocked-badge">
                                        <IoWarningOutline size={13} />
                                        {MOTIVO_BLOQUEO_OPTIONS.find(o => o.value === ticket.motivo_bloqueo)?.label || ticket.motivo_bloqueo}
                                        <span style={{ fontSize: '0.7rem', marginLeft: 4 }}>
                                            · {bloqueoSla.bloqueoCapExceeded ? 'Tope de pausa superado, SLA corriendo' : 'Pausa el SLA'}
                                        </span>
                                    </div>
                                ) : (
                                    <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>No bloqueado</span>
                                )
                            )}
                        </div>
                        );
                    })()}
                </SidebarSection>

                {/* ════ 2. RESPONSABILIDAD ════ */}
                <SidebarSection title="Responsabilidad" isOpen={openSidebarSection === 'Responsabilidad'} onToggle={() => setOpenSidebarSection(openSidebarSection === 'Responsabilidad' ? null : 'Responsabilidad')}>
                    {/* ─── GRUPO ─── */}
                    <div className="property-group">
                        <label>Grupo</label>
                        {canEdit ? (
                            <select
                                className={`property-select ${pendingChanges.resolver_group_id !== undefined ? 'has-pending-change' : ''}`}
                                value={draftValue('resolver_group_id') || ''}
                                onChange={(e) => {
                                    const selectedGroupVal = e.target.value;
                                    const gName = groups.find(g => g.id === selectedGroupVal)?.name || selectedGroupVal;
                                    // Categoría/Tipo/Prioridad son catálogos propios de cada grupo en Volcán
                                    // Desk — al cambiar de grupo, los valores del grupo anterior ya no aplican.
                                    const resetScoped = ticketModulo === 'volcan_desk'
                                        ? { category: null, type: null, priority: null }
                                        : {};
                                    stageChange({ group: gName, resolver_group_id: selectedGroupVal, ...resetScoped });
                                }}
                            >
                                <option value="">-- Seleccionar --</option>
                                {deskGroups.map(g => (
                                    <option key={g.id} value={g.id}>{g.name}</option>
                                ))}
                            </select>
                        ) : (
                            <div className="prop-readonly">
                                {groups.find(g => g.id === (ticket.resolver_group_id || ticket.group))?.name || ticket.group || '—'}
                            </div>
                        )}
                    </div>

                    {/* ─── ASIGNADO A (RESOLUTOR) ───
                        "Propietario" (owner_agent_id) se quitó de aquí (2026-08-27, a pedido
                        del usuario) — no se usaba para nada visible en el flujo normal (solo
                        se fija una vez al crear el ticket o en una escalación con
                        "transfiere propiedad", nunca al reasignar/tomar), y competía
                        visualmente con este campo generando confusión ("¿por qué el
                        propietario es alguien distinto al solicitante y al asignado?"). El
                        campo/dato sigue existiendo en el backend (aún respalda el flujo de
                        "Transferir ticket" y algunos chequeos de permisos), solo se dejó de
                        mostrar acá. */}
                    <div className="property-group">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                            <label style={{ margin: 0 }}>Asignado A</label>
                            {ticket.resolver_group_id && !ticket.previous_owner_id && (
                                <span style={{ fontSize: '11px', background: '#eff6ff', color: '#1d4ed8', padding: '2px 6px', borderRadius: '4px', fontWeight: '600' }}>
                                    Escalado → {groups.find(g => g.id === ticket.resolver_group_id)?.name || ticket.group}
                                </span>
                            )}
                        </div>
                        {/* Una vez asignado, el dropdown queda BLOQUEADO (2026-08-27, a pedido
                            del usuario) — antes cualquier miembro del grupo podía cambiar el
                            responsable libremente desde aquí en cualquier momento, sin pasar
                            por "Más acciones". Ahora la única forma de reasignar es primero
                            "Más acciones → Quitar actual" (limpia resolver_agent_id), lo que
                            reabre este dropdown — evita reasignaciones accidentales/no
                            intencionadas mientras alguien ya está trabajando el ticket. */}
                        {canEdit && !(ticket.resolver_agent_id || ticket.assignedTo) ? (
                            <>
                                <select
                                    className={`property-select ${pendingChanges.resolver_agent_id !== undefined ? 'has-pending-change' : ''}`}
                                    value={pendingChanges.resolver_agent_id || ''}
                                    onChange={(e) => stageChange({ resolver_agent_id: e.target.value || null })}
                                >
                                    <option value="">Sin Asignar</option>
                                    {users
                                        .filter(u => {
                                            if (ticketModulo !== 'volcan_desk') {
                                                // Voltik: comportamiento histórico, sin cambios.
                                                return u.role === 'admin' || u.role === 'agent';
                                            }
                                            // Volcán Desk: cualquier integrante del grupo resolutor
                                            // actual, sin importar rol — antes se excluía a
                                            // group_admin aunque fuera del grupo. El admin
                                            // GENERAL nunca es asignable como responsable de un ticket
                                            // (corregido 2026-08-27 — un intento anterior lo incluía por
                                            // error): solo group_admin/agent del grupo.
                                            if (u.role !== 'group_admin' && u.role !== 'agent') return false;
                                            // Un group_admin pertenece a su grupo administrado (admin_group_id)
                                            // aunque su array `groups` esté vacío/desactualizado — antes esto
                                            // solo miraba `groups`, así que un group_admin sin esa entrada
                                            // duplicada (caso real: Javier Polanco, admin de BI & Development
                                            // con `groups: []`) desaparecía de esta lista aunque sí pudiera
                                            // administrar el ticket (bug reportado en vivo 2026-09-07).
                                            if (u.role === 'group_admin' && u.admin_group_id === effectiveGroupId) return true;
                                            return !effectiveGroupId || u.groups?.includes(effectiveGroupId);
                                        })
                                        .map(u => (
                                            <option key={u.id} value={u.id}>{u.name} ({u.role})</option>
                                        ))}
                                </select>
                                {ticketModulo === 'volcan_desk' && isAuthorizedGroupMember && (
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
                                {canEdit && (ticket.resolver_agent_id || ticket.assignedTo) && ticketModulo === 'volcan_desk' && (
                                    <div style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', fontWeight: 400, marginTop: 2 }}>
                                        Para reasignar, usa "Más acciones → Quitar actual"
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </SidebarSection>

                {/* ════ 3. CLASIFICACIÓN ════ */}
                <SidebarSection title="Clasificación" isOpen={openSidebarSection === 'Clasificación'} onToggle={() => setOpenSidebarSection(openSidebarSection === 'Clasificación' ? null : 'Clasificación')}>
                    {/* ─── PRODUCTO — click-to-edit ─── */}
                    <div className="property-group">
                        <label>Producto</label>
                        <ClickToEdit
                            disabled={!canEdit}
                            readValue={<>{draftValue('product') || '—'}{pendingChanges.product !== undefined && <span className="pending-dot" title="Cambio sin guardar" />}</>}
                            renderEdit={(close) => (
                                <select
                                    className="property-select"
                                    autoFocus
                                    value={draftValue('product') || ''}
                                    onChange={(e) => { stageChange({ product: e.target.value || null }); close(); }}
                                >
                                    <option value="">-- Seleccionar --</option>
                                    {productOptions.map(pr => (
                                        <option key={pr.id} value={pr.label}>{pr.label}</option>
                                    ))}
                                </select>
                            )}
                        />
                    </div>

                    {/* ─── CATEGORÍA — click-to-edit ─── */}
                    <div className="property-group">
                        <label>Categoría</label>
                        <ClickToEdit
                            disabled={!canEdit}
                            readValue={<>{categoryOptions.find(c => c.id === draftValue('category'))?.label || (draftValue('category') ? 'Categoría eliminada' : '—')}{pendingChanges.category !== undefined && <span className="pending-dot" title="Cambio sin guardar" />}</>}
                            renderEdit={(close) => (
                                <select
                                    className="property-select"
                                    autoFocus
                                    value={draftValue('category') || ''}
                                    onChange={(e) => { stageChange({ category: e.target.value || null }); close(); }}
                                >
                                    <option value="">-- Seleccionar --</option>
                                    {/* Antes listaba TODAS las categorías del grupo sin importar el
                                        Tipo elegido — permitía guardar combinaciones Tipo+Categoría que
                                        no existen (una Categoría siempre es 1:1 con un Tipo, mismo
                                        criterio que ya se aplicó en el modal de Reglas de Flujo).
                                        Reportado en vivo 2026-09-17. */}
                                    {categoryOptions
                                        .filter(c => !draftValue('type') || c.tipoId === draftValue('type'))
                                        .map(c => (
                                            <option key={c.id} value={c.id}>{c.label}</option>
                                        ))}
                                </select>
                            )}
                        />
                    </div>

                    {/* ─── TIPO — click-to-edit ─── */}
                    <div className="property-group">
                        <label>Tipo</label>
                        <ClickToEdit
                            disabled={!canEdit}
                            readValue={<>{typeOptions.find(t => t.id === draftValue('type'))?.label || (draftValue('type') ? 'Tipo eliminado' : '—')}{pendingChanges.type !== undefined && <span className="pending-dot" title="Cambio sin guardar" />}</>}
                            renderEdit={(close) => (
                                <select
                                    className="property-select"
                                    autoFocus
                                    value={draftValue('type') || ''}
                                    onChange={(e) => {
                                        const newTypeId = e.target.value || null;
                                        const changes = { type: newTypeId };
                                        // Si la Categoría ya elegida no pertenece al nuevo Tipo, se limpia
                                        // — evita dejar guardada una combinación Tipo+Categoría inválida.
                                        const currentCategoryId = draftValue('category');
                                        const currentCategory = categoryOptions.find(c => c.id === currentCategoryId);
                                        if (currentCategoryId && (!currentCategory || currentCategory.tipoId !== newTypeId)) {
                                            changes.category = null;
                                        }
                                        stageChange(changes);
                                        close();
                                    }}
                                >
                                    <option value="">-- Seleccionar --</option>
                                    {typeOptions.map(t => (
                                        <option key={t.id} value={t.id}>{t.label}</option>
                                    ))}
                                </select>
                            )}
                        />
                    </div>
                </SidebarSection>

                {/* ════ 4. PLANIFICACIÓN (solo Volcán Desk) ════ */}
                {ticketModulo === 'volcan_desk' && (
                    <SidebarSection title="Planificación" isOpen={openSidebarSection === 'Planificación'} onToggle={() => setOpenSidebarSection(openSidebarSection === 'Planificación' ? null : 'Planificación')}>
                        <div className="property-group">
                            <label>Fecha estimada de inicio</label>
                            <ClickToEdit
                                disabled={!canEdit}
                                readValue={<>{formatDateShort(draftValue('fecha_estimada_inicio')) || '—'}{pendingChanges.fecha_estimada_inicio !== undefined && <span className="pending-dot" title="Cambio sin guardar" />}</>}
                                renderEdit={(close) => (
                                    <input
                                        type="date"
                                        className="property-select"
                                        autoFocus
                                        value={draftValue('fecha_estimada_inicio') || ''}
                                        // Igual que "Estimación HUs" (mismo bug, 2026-09-17): elegir una
                                        // fecha con <input type="date"> es una interacción de VARIOS pasos
                                        // (flechas de mes/día/año, o escribir dígito por dígito) — cada paso
                                        // ya deja el input en un valor completo y válido, así que cerrar en
                                        // cada onChange cerraba el editor apenas se tocaba la primera flecha
                                        // o el primer dígito. Reportado en vivo 2026-09-29. Ahora solo cierra
                                        // al perder el foco (clic afuera, ya cubierto por ClickToEdit).
                                        onChange={(e) => stageChange({ fecha_estimada_inicio: e.target.value || null })}
                                        onBlur={close}
                                    />
                                )}
                            />
                        </div>

                        <div className="property-group">
                            <label>Fecha estimada de conclusión</label>
                            <ClickToEdit
                                disabled={!canEdit}
                                readValue={<>{formatDateShort(draftValue('fecha_estimada_conclusion')) || '—'}{pendingChanges.fecha_estimada_conclusion !== undefined && <span className="pending-dot" title="Cambio sin guardar" />}</>}
                                renderEdit={(close) => (
                                    <input
                                        type="date"
                                        className="property-select"
                                        autoFocus
                                        value={draftValue('fecha_estimada_conclusion') || ''}
                                        // Mismo arreglo que "Fecha estimada de inicio" arriba — ver ese
                                        // comentario.
                                        onChange={(e) => stageChange({ fecha_estimada_conclusion: e.target.value || null })}
                                        onBlur={close}
                                    />
                                )}
                            />
                        </div>

                        {draftValue('fecha_estimada_inicio') && draftValue('fecha_estimada_conclusion') && (
                            <div className="property-group">
                                <label>Estimación SLA</label>
                                <div className="prop-readonly">
                                    {businessDaysBetween(draftValue('fecha_estimada_inicio'), draftValue('fecha_estimada_conclusion'))} día(s) hábil(es)
                                </div>
                            </div>
                        )}

                        {/* Estimación de esfuerzo en Historias de Usuario (horas) — la captura
                            el resolutor, nunca el solicitante (mismo canEdit que el resto de
                            Planificación). Por ahora es solo informativo/exportable, sin
                            ningún cálculo asociado. El aviso en el chat ("... estimó la HU
                            en X horas") ya no se dispara aquí en el onChange — se movió a
                            handleSaveChanges, recién cuando el cambio se confirma. */}
                        <div className="property-group">
                            <label>Estimación HUs (horas)</label>
                            <ClickToEdit
                                disabled={!canEdit}
                                readValue={<>{draftValue('estimacion_hus') != null ? `${draftValue('estimacion_hus')} h` : '—'}{pendingChanges.estimacion_hus !== undefined && <span className="pending-dot" title="Cambio sin guardar" />}</>}
                                renderEdit={(close) => (
                                    <input
                                        type="number"
                                        min="0"
                                        step="0.5"
                                        className="property-select"
                                        autoFocus
                                        value={draftValue('estimacion_hus') ?? ''}
                                        onChange={(e) => {
                                            // A diferencia de un <select>/<input type="date">, un número se
                                            // escribe dígito por dígito — cerrar en cada onChange (como sí
                                            // corresponde para esos otros campos) cerraba este input apenas
                                            // se tecleaba el primer dígito, dejando "1" guardado en vez de
                                            // "10", o incluso vacío según qué tan rápido se escribiera.
                                            // Reportado en vivo 2026-09-17 (caso real: "David", ticket 201).
                                            // Ahora solo cierra al perder el foco o presionar Enter.
                                            const val = e.target.value === '' ? null : e.target.value;
                                            stageChange({ estimacion_hus: val });
                                        }}
                                        onBlur={close}
                                        onKeyDown={(e) => { if (e.key === 'Enter') close(); }}
                                    />
                                )}
                            />
                        </div>

                        <div className="property-group">
                            <label>Fecha de resolución</label>
                            <div className="prop-readonly" style={{ color: ticket.fecha_resolucion ? 'var(--color-text-main)' : 'var(--color-text-muted)', fontStyle: ticket.fecha_resolucion ? 'normal' : 'italic' }}>
                                {ticket.fecha_resolucion ? formatDate(ticket.fecha_resolucion) : 'Aún no resuelto — se llena sola al cerrar el ticket'}
                            </div>
                        </div>
                    </SidebarSection>
                )}

                {/* ════ 5. SOLICITANTE ════ */}
                <SidebarSection title="Solicitante" isOpen={openSidebarSection === 'Solicitante'} onToggle={() => setOpenSidebarSection(openSidebarSection === 'Solicitante' ? null : 'Solicitante')}>
                    <div className="requester-compact">
                        <div className="rc-avatar">
                            {ticketContact?.avatar
                                ? <img src={ticketContact.avatar} alt={ticketContact.name} />
                                : <span>{(ticketContact?.name || ticketCreator?.name || 'US').substring(0, 2).toUpperCase()}</span>
                            }
                        </div>
                        <div className="rc-info">
                            <div className="rc-name">{ticketContact?.name || ticketCreator?.name || '—'}</div>
                            <div className="rc-meta">
                                {ticketContact?.role || ticketCreator?.role || 'client'}
                                {/* Volcán Desk: el solicitante no tiene empresa, tiene grupo — mostrar el
                                    grupo solicitante (foto del grupo del creador al levantar el ticket),
                                    con fallback al grupo actual del creador para tickets viejos que no
                                    tenían area_origen_id todavía. Un group_admin guarda su grupo en
                                    admin_group_id, no en groups (2026-09-14, mismo criterio que
                                    ownGroupId más arriba) — sin este caso, el solicitante group_admin
                                    de un ticket sin area_origen_id se veía siempre como "—". */}
                                {ticketModulo === 'volcan_desk'
                                    ? ` · ${groups.find(g => g.id === (
                                        ticket.area_origen_id
                                        || (ticketCreator?.role === 'group_admin' ? ticketCreator?.admin_group_id : ticketCreator?.groups?.[0])
                                    ))?.name || '—'}`
                                    : ticketCompany ? ` · ${ticketCompany.name}` : ''}
                            </div>
                            <div className="rc-email">{ticketContact?.email || ticketCreator?.email || '—'}</div>
                            {(ticketContact?.phone || ticketCreator?.phone) && (
                                <div className="rc-email">{ticketContact?.phone || ticketCreator?.phone}</div>
                            )}
                            {createdDate && (
                                <div className="rc-date">
                                    {createdDate.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' })} · {createdDate.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}
                                </div>
                            )}
                        </div>
                    </div>
                </SidebarSection>

                {/* ════ 6. APOYOS SOLICITADOS ════ */}
                {(isAuthorizedGroupMember || isSupportGroupMember || currentUser?.role === 'admin') && parsedApoyos.length > 0 && (
                    <SidebarSection title="Apoyos Solicitados" isOpen={openSidebarSection === 'Apoyos'} onToggle={() => setOpenSidebarSection(openSidebarSection === 'Apoyos' ? null : 'Apoyos')}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            {/* Solo los 3 más recientes — el historial completo ya queda como
                                estampa "CONSULTA DE APOYO" en la conversación, no hace falta
                                repetirlo aquí. `originalIdx` se conserva para poder actualizar el
                                elemento correcto dentro de parsedApoyos (que no está ordenado). */}
                            {parsedApoyos
                                .map((apoyo, originalIdx) => ({ apoyo, originalIdx }))
                                .sort((a, b) => new Date(b.apoyo.fecha_solicitud || 0) - new Date(a.apoyo.fecha_solicitud || 0))
                                .slice(0, 3)
                                .map(({ apoyo, originalIdx }) => {
                                const idx = originalIdx;
                                const apoyoGroup = groups.find(g => g.id === apoyo.grupo_solicitado);
                                const statusColor = apoyo.status === 'Resuelto' ? '#16a34a' : apoyo.status === 'En progreso' ? '#2563eb' : '#d97706';
                                const canChangeStatus = isAuthorizedGroupMember || isSupportGroupMember || currentUser?.role === 'admin';
                                const subAsignadoUser = apoyo.sub_asignado ? users.find(u => u.id === apoyo.sub_asignado) : null;
                                const isMySupportGroup = (currentUser?.groups || []).includes(apoyo.grupo_solicitado)
                                    || (currentUser?.role === 'group_admin' && currentUser?.admin_group_id === apoyo.grupo_solicitado);
                                const canClaim = isMySupportGroup || currentUser?.role === 'admin';
                                return (
                                    <div key={apoyo.id || idx} style={{ background: 'var(--color-bg-secondary)', border: '1px solid var(--glass-border)', borderRadius: 8, padding: '10px 12px' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                                            <span style={{ fontWeight: 600, fontSize: '0.82rem' }}>
                                                {apoyoGroup?.name || apoyo.grupo_solicitado}
                                            </span>
                                            <span style={{ fontSize: '0.72rem', fontWeight: 700, color: statusColor, background: statusColor + '18', borderRadius: 20, padding: '2px 8px', border: `1px solid ${statusColor}40` }}>
                                                {apoyo.status || 'Pendiente'}
                                            </span>
                                        </div>
                                        {apoyo.descripcion && (
                                            <p style={{ margin: '0 0 8px', fontSize: '0.8rem', color: 'var(--color-text-muted)', lineHeight: 1.4 }}>
                                                {apoyo.descripcion}
                                            </p>
                                        )}
                                        {/* Sub-asignado dentro del grupo de apoyo */}
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                                            {subAsignadoUser ? (
                                                <>
                                                    <div style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--color-primary)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.65rem', fontWeight: 700, flexShrink: 0 }}>
                                                        {subAsignadoUser.name.substring(0, 2).toUpperCase()}
                                                    </div>
                                                    <span style={{ fontSize: '0.76rem', color: 'var(--color-text-muted)' }}>Asignado a <strong>{subAsignadoUser.name}</strong></span>
                                                </>
                                            ) : (
                                                <span style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', fontStyle: 'italic' }}>Sin agente asignado</span>
                                            )}
                                            {canClaim && apoyo.status !== 'Resuelto' && apoyo.sub_asignado !== currentUser?.id && (
                                                <button
                                                    onClick={() => {
                                                        const updated = parsedApoyos.map((a, i) => i === idx ? { ...a, sub_asignado: currentUser.id } : a);
                                                        onUpdateField(ticket.id, { apoyos: updated });
                                                    }}
                                                    style={{ marginLeft: 'auto', fontSize: '0.7rem', padding: '2px 8px', borderRadius: 20, border: '1px solid var(--color-primary)', background: 'transparent', color: 'var(--color-primary)', cursor: 'pointer', whiteSpace: 'nowrap' }}
                                                >
                                                    Reclamar para mí
                                                </button>
                                            )}
                                        </div>
                                        <div style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', marginBottom: canChangeStatus ? 8 : 0 }}>
                                            Solicitado: {apoyo.fecha_solicitud ? new Date(apoyo.fecha_solicitud).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}
                                        </div>
                                        {canChangeStatus && (
                                            <select
                                                className="property-select"
                                                style={{ fontSize: '0.78rem', padding: '4px 6px' }}
                                                value={apoyo.status || 'Pendiente'}
                                                onChange={(e) => {
                                                    const updated = parsedApoyos.map((a, i) => i === idx ? { ...a, status: e.target.value } : a);
                                                    onUpdateField(ticket.id, { apoyos: updated });
                                                }}
                                            >
                                                <option value="Pendiente">Pendiente</option>
                                                <option value="En progreso">En progreso</option>
                                                <option value="Resuelto">Resuelto</option>
                                            </select>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </SidebarSection>
                )}

                {/* ════ MÁS ACCIONES ════ */}
                {canEdit && (
                    <div className="more-actions-wrap" ref={moreActionsRef}>
                        <button className="more-actions-btn" onClick={() => setShowMoreActions(o => !o)}>
                            <IoEllipsisVertical size={15} /> Más acciones
                        </button>
                        {showMoreActions && (
                            <div className="more-actions-menu">
                                {/* Subtítulo bajo cada opción (2026-09-29, a pedido del usuario) —
                                    se confundían "Solicitar apoyo" con "Transferir" desde el propio
                                    menú, antes de siquiera abrir el modal de cada una — la diferencia
                                    real (temporal y sigues siendo responsable vs. permanente y pierdes
                                    el ticket) solo se explicaba DENTRO de cada modal, demasiado tarde
                                    para evitar el clic equivocado. */}
                                <button className="ma-item" onClick={() => { setShowSupportModal(true); setShowMoreActions(false); }}>
                                    <IoPeopleOutline size={15} className="ma-item-icon" />
                                    <span className="ma-item-text">
                                        <span className="ma-item-label">Solicitar apoyo a otro grupo</span>
                                        <span className="ma-item-sub">Pides ayuda sin perder el ticket</span>
                                    </span>
                                </button>
                                <button className="ma-item ma-item-danger" onClick={() => { setShowTransferModal(true); setShowMoreActions(false); }}>
                                    <IoArrowForwardOutline size={15} className="ma-item-icon" />
                                    <span className="ma-item-text">
                                        <span className="ma-item-label">Transferir ticket</span>
                                        <span className="ma-item-sub">Lo mueves por completo — no se puede deshacer</span>
                                    </span>
                                </button>
                                {/* Único lugar que puede limpiar un responsable ya asignado —
                                    el dropdown "Asignado A" del sidebar queda bloqueado en
                                    cuanto hay alguien asignado (ver arriba), así que esto es lo
                                    que lo vuelve a habilitar. Renombrado de "Reasignar agente
                                    (quitar actual)" — no reasigna nada, solo quita; el nombre
                                    anterior prometía algo que el botón no hacía. Solo se
                                    muestra si de verdad hay alguien que quitar. */}
                                {(ticket.resolver_agent_id || ticket.assignedTo) && (
                                    <>
                                        <div className="ma-divider" />
                                        <button className="ma-item" onClick={() => {
                                            onUpdateField(ticket.id, { resolver_agent_id: null });
                                            setShowMoreActions(false);
                                        }}>
                                            <IoPersonOutline size={15} /> Quitar actual
                                        </button>
                                    </>
                                )}
                            </div>
                        )}
                    </div>
                )}

                {/* Barra de confirmación — 2026-09-10, a pedido del usuario: antes cada
                    select/input del panel guardaba solo con elegir la opción ("si por un
                    dedazo pone mal un dato, ya se registró"). Ahora los campos quedan en
                    borrador (pendingChanges) hasta confirmar aquí; navegar a otro ticket
                    sin guardar simplemente descarta el borrador. */}
                {hasPendingChanges && (
                    <div className="sidebar-save-bar">
                        <span className="sidebar-save-bar-text">
                            <IoAlertCircleOutline size={14} /> Tienes cambios sin guardar
                        </span>
                        <div className="sidebar-save-bar-actions">
                            <button type="button" className="btn btn-secondary btn-sm" onClick={handleDiscardChanges} disabled={isSavingChanges}>
                                Descartar
                            </button>
                            <button type="button" className="btn btn-primary btn-sm" onClick={handleSaveChanges} disabled={isSavingChanges}>
                                {isSavingChanges ? 'Guardando…' : 'Guardar cambios'}
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* ─── MODAL: VISTA PREVIA DE IMAGEN ADJUNTA ─── */}
            <Modal
                isOpen={!!previewAttachment}
                onClose={() => setPreviewAttachment(null)}
                title={previewAttachment?.name}
                size="large"
                footer={
                    <button className="btn btn-primary" onClick={() => handleDownload(previewAttachment)}>
                        <IoDownloadOutline size={16} /> Descargar
                    </button>
                }
            >
                {previewAttachment && (
                    <img src={previewAttachment.dataUrl} alt={previewAttachment.name} className="attachment-preview-image" />
                )}
            </Modal>

            {/* ─── MODAL: SOLICITAR APOYO ─── */}
            {showSupportModal && (
                <div className="modal-overlay" onClick={() => setShowSupportModal(false)}>
                    <div className="modal-box" onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <h3>Solicitar apoyo a otro grupo</h3>
                            <button className="btn-icon" onClick={() => setShowSupportModal(false)}><IoClose size={20} /></button>
                        </div>
                        <p className="modal-desc">El ticket <strong>continúa siendo responsabilidad de {grupoResolutor}</strong>. Solo se notifica al otro grupo para pedir apoyo puntual.</p>
                        <div className="modal-field">
                            <label>Grupo a consultar</label>
                            <select className="property-select" value={supportGroup} onChange={e => setSupportGroup(e.target.value)}>
                                <option value="">-- Seleccionar grupo --</option>
                                {deskGroups.filter(g => g.id !== effectiveGroupId).map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                            </select>
                        </div>
                        <div className="modal-field">
                            <label>Motivo de la consulta</label>
                            <textarea className="property-select" rows={3} value={supportReason} onChange={e => setSupportReason(e.target.value)} placeholder="Describe brevemente qué necesitas del otro grupo..." />
                        </div>
                        <div className="modal-footer">
                            <button className="btn btn-secondary" onClick={() => setShowSupportModal(false)}>Cancelar</button>
                            <button className="btn btn-primary" disabled={!supportGroup || !supportReason.trim()}
                                onClick={() => {
                                    const g = groups.find(x => x.id === supportGroup);
                                    const newApoyo = {
                                        id: 'apoyo-' + Date.now(),
                                        grupo_solicitado: supportGroup,
                                        status: 'Pendiente',
                                        fecha_solicitud: new Date().toISOString(),
                                        descripcion: supportReason
                                    };
                                    onUpdateField(ticket.id, { apoyos: [...(parsedApoyos || []), newApoyo] });
                                    // Dos cosas separadas, no una:
                                    // 1) Estampa pública tipo WhatsApp ("X solicitó apoyo a Y") — la
                                    //    ve el solicitante también, para que sepa que su ticket está
                                    //    en consulta de segundo nivel. Sin el contenido de la consulta.
                                    onAddComment(ticket.id, `<span data-apoyo-consulta="1"><strong>${currentUser?.name}</strong> solicitó apoyo al área de <strong>${g?.name}</strong></span>`, false, []);
                                    // 2) Nota privada con la consulta real, sin cambios respecto a
                                    //    como ya funcionaba — solo la ve el resolutor y el grupo de apoyo.
                                    onAddComment(ticket.id, `<div data-apoyo-nota="1"><p>${supportReason}</p></div>`, true, []);
                                    setSupportGroup(''); setSupportReason('');
                                    setShowSupportModal(false);
                                }}>
                                Solicitar apoyo
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ─── MODAL: TRANSFERIR ─── */}
            {showTransferModal && (
                <div className="modal-overlay" onClick={() => setShowTransferModal(false)}>
                    <div className="modal-box" onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <h3>Transferir ticket</h3>
                            <button className="btn-icon" onClick={() => setShowTransferModal(false)}><IoClose size={20} /></button>
                        </div>
                        {/* Reforzado 2026-09-29 (a pedido del usuario) — se confundía con
                            "Solicitar apoyo" (esa SÍ deja el ticket como estaba, solo notifica
                            a otro grupo). Transferir es permanente y saca el ticket de tu
                            bandeja por completo, así que el aviso lo dice explícito, en vez de
                            solo "cambiará el grupo responsable". */}
                        <div className="modal-warning">
                            <IoWarningOutline size={16} />
                            <span>
                                Esta acción <strong>no se puede deshacer</strong>: {grupoResolutor} deja de ser responsable y el ticket ya no aparecerá en su bandeja. Es para canalizarlo por completo a otra área — si solo necesitas ayuda sin perder el ticket, usa <strong>"Solicitar apoyo a otro grupo"</strong> en su lugar.
                            </span>
                        </div>
                        <div className="modal-field">
                            <label>Grupo destino</label>
                            <select className="property-select" value={transferGroup}
                                onChange={e => { setTransferGroup(e.target.value); setTransferAgent(''); }}>
                                <option value="">-- Seleccionar grupo --</option>
                                {deskGroups.filter(g => g.id !== effectiveGroupId).map(g => (
                                    <option key={g.id} value={g.id}>{g.name}{g.transfiere_propiedad ? ' (transfiere propiedad)' : ''}</option>
                                ))}
                            </select>
                        </div>
                        <div className="modal-field">
                            <label>Agente destino <span style={{ fontWeight: 400 }}>(opcional)</span></label>
                            <select className="property-select" value={transferAgent} disabled={!transferGroup}
                                onChange={e => setTransferAgent(e.target.value)}>
                                <option value="">Sin asignar — el grupo lo toma después</option>
                                {users.filter(u => u.role === 'admin' || u.role === 'agent').filter(u => !transferGroup || u.groups?.includes(transferGroup))
                                    .map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                            </select>
                        </div>
                        <div className="modal-footer">
                            <button className="btn btn-secondary" onClick={() => setShowTransferModal(false)}>Cancelar</button>
                            <button className="btn btn-danger" disabled={!transferGroup}
                                onClick={() => {
                                    const g = groups.find(x => x.id === transferGroup);
                                    const a = users.find(x => x.id === transferAgent);
                                    onEscalate(ticket.id, transferGroup, transferAgent || null, g?.transfiere_propiedad, g?.name || transferGroup, a?.name || 'Sin asignar');
                                    setTransferGroup(''); setTransferAgent('');
                                    setShowTransferModal(false);
                                }}>
                                Transferir ticket
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}