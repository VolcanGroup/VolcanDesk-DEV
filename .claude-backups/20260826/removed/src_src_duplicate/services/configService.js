import { api } from './api';

// configService.js — manages all user-configurable dropdown lists
const KEY = 'tms_config';

// ─── Status Category Behaviors ────────────────────────────────────────────────
export const BEHAVIORS = [
    { id: 'active',   label: 'En Proceso',  description: 'SLA activo y en conteo',                    slaConfigurable: true  },
    { id: 'paused',   label: 'En Espera',   description: 'SLA pausado; reanuda al volver a En Proceso', slaConfigurable: false },
    { id: 'terminal', label: 'Terminal',    description: 'SLA se detiene definitivamente',              slaConfigurable: false },
];

// ─── INTERNAL DESK STATUSES (Fixed Catalog) ──────────────────────────────────
// Catálogo fijo y no configurable por área (Volcán Desk). No confundir con
// config.statusCategories, que sólo aplica a Voltik.
export const INTERNAL_STATUSES = [
    { id: 'to_do', label: 'Pendiente', color: '#94a3b8', behavior: 'active' },
    { id: 'on_going', label: 'En ejecución', color: '#0066CC', behavior: 'active' },
    { id: 'in_testing', label: 'Pruebas técnicas', color: '#8b5cf6', behavior: 'active' },
    { id: 'under_review', label: 'Revisión (funcional o de negocio)', color: '#f59e0b', behavior: 'active' },
    { id: 'done', label: 'Terminado', color: '#10b981', behavior: 'terminal' },
];

export const MOTIVO_BLOQUEO_OPTIONS = [
    { value: 'waiting_approval', label: 'Esperando aprobación' },
    { value: 'waiting_feedback', label: 'Esperando feedback' },
    { value: 'on_hold', label: 'En espera' },
];

// ─── SUBESTADOS (Etiquetas contextuales por estado principal) ───────────────
// Metadata que se agrega sobre el estado principal (INTERNAL_STATUSES) — nunca
// lo reemplaza. Cada estado principal tiene su propio set de subestados; el
// ticket puede, por ejemplo, estar en `under_review` con `bloqueado = true` y
// `motivo_bloqueo = 'waiting_approval'` sin necesidad de un estado nuevo.
// `under_review` no tiene subestados definidos en el catálogo.
//
// Los 5 estados principales (INTERNAL_STATUSES) son fijos en código a propósito
// (filtros, columnas por vista y SLA dependen de sus IDs). Los SUBESTADOS, en
// cambio, sí son configurables por el admin desde Configuración → Estados de
// Vida — este objeto es solo el set de fábrica usado para sembrar `config.
// deskSubStatuses` la primera vez; después de eso la fuente de verdad es config
// (ver getEtiquetaOptionsForStatus más abajo).
export const SUBESTADO_OPTIONS_BY_STATUS = {
    to_do: [
        { value: 'nuevo_sin_asignar', label: 'Nuevo / Sin asignar', description: 'El ticket acaba de ser creado o reportado y aún no tiene responsable ni clasificación.' },
        { value: 'en_backlog', label: 'En Backlog / Por priorizar', description: 'Fue revisado y aceptado, pero no está planeado para trabajarse en el corto plazo.' },
        { value: 'en_refinamiento', label: 'En Refinamiento', description: 'Se están definiendo requisitos, criterios de aceptación o el diseño técnico.' },
        { value: 'bloqueado_dependencias', label: 'Bloqueado por dependencias', description: 'Detenido por falta de definiciones del negocio, accesos o trabajo de terceros.' },
        { value: 'listo_desarrollo', label: 'Listo para desarrollo', description: 'Completamente definido, estimado y en fila para ser tomado inmediatamente.' },
    ],
    on_going: [
        { value: 'asignacion_planificacion', label: 'Asignación / Planificación', description: 'Comprometido para el ciclo de trabajo, definiendo quién y cómo se abordará.' },
        { value: 'revision_cab', label: 'Revisión de comité (CAB)', description: 'Esperando autorización de arquitectura, seguridad o control de cambios.' },
        { value: 'desarrollo_activo', label: 'Desarrollo activo', description: 'Trabajo directo en código, base de datos o configuración.' },
        { value: 'revision_codigo', label: 'Revisión de código', description: 'El trabajo terminó y está en Pull Request esperando validación técnica de un par.' },
        { value: 'despliegue_entorno', label: 'Despliegue a entorno', description: 'El código fue aprobado y se está subiendo al entorno de pruebas o QA.' },
    ],
    in_testing: [
        { value: 'listo_qa', label: 'Listo para QA', description: 'En el entorno de pruebas, esperando en la fila del equipo de calidad.' },
        { value: 'pruebas_ejecucion', label: 'Pruebas en ejecución', description: 'Corriendo activamente casos de prueba (manuales o automatizados).' },
        { value: 'pruebas_fallidas', label: 'Pruebas fallidas / Retrabajo', description: 'Se encontraron incidencias; pausado esperando correcciones del equipo técnico.' },
        { value: 'pruebas_uat', label: 'Pruebas de usuario (UAT)', description: 'Validado técnicamente, esperando que el usuario final confirme que cumple el negocio.' },
        { value: 'listo_produccion', label: 'Listo para producción', description: 'Pruebas exitosas, esperando la ventana de liberación para cerrarse.' },
    ],
    under_review: [],
    done: [
        { value: 'liberado_produccion', label: 'Liberado en producción', description: 'El ticket fue implementado exitosamente en el entorno real y está disponible para el uso.' },
        { value: 'monitoreo_post_despliegue', label: 'Monitoreo post-despliegue', description: 'El código ya está en producción, pero se mantiene en observación un tiempo para asegurar estabilidad.' },
        { value: 'cerrado_cancelado', label: 'Cerrado - Cancelado / Rechazado', description: 'Se decidió no trabajar en este ticket por cambio de prioridades, o porque el comité lo rechazó.' },
        { value: 'cerrado_duplicado', label: 'Cerrado - Duplicado', description: 'El mismo requerimiento o incidencia ya había sido reportado y se está atendiendo en otro ticket.' },
        { value: 'cerrado_no_reproducible', label: 'Cerrado - No reproducible', description: 'No se pudo replicar el error reportado tras varios intentos o por falta de información del usuario.' },
    ],
};

// Devuelve las opciones de "Etiquetas" (subestados) válidas para el estado
// principal dado. Siempre relacionado con el estado principal exclusivamente.
// Lee de config.deskSubStatuses (editable desde Configuración); si no hay config
// cargada aún (ej. primer render) cae al catálogo de fábrica.
export const getEtiquetaOptionsForStatus = (status) =>
    cachedConfig.deskSubStatuses?.[status] ?? SUBESTADO_OPTIONS_BY_STATUS[status] ?? [];

// Catálogo plano legado (Voltik / usos genéricos no ligados a un estado).
export const ETIQUETA_OPTIONS = [
    { value: 'retrabajo', label: 'Retrabajo' },
    { value: 'tracking', label: 'Tracking' },
    { value: 'baja_prioridad', label: 'Baja prioridad' },
];

// ─── CAMPOS BASE DEL FORMULARIO "Crear Ticket/Solicitud" ─────────────────────
// Asunto y Descripción son siempre obligatorios y no se pueden quitar. Estos
// son los únicos campos NATIVOS del ticket que el admin puede prender/apagar
// por módulo. Para agregar campos nuevos (no nativos), ver CampoCatalogo con
// scope='base' (propio catálogo, independiente del de "Flujos de Ticket").
export const FORM_FIELD_DEFS = [
    { key: 'tipo', label: 'Tipo' },
    { key: 'producto', label: 'Producto' },
    { key: 'grupo', label: 'Grupo' },
    { key: 'categoria', label: 'Categoría' },
    { key: 'agente', label: 'Agente', note: 'Solo aplica a Voltik — en Volcán Desk nunca se muestra (nadie se auto-asigna).' },
    { key: 'prioridad', label: 'Prioridad' },
    { key: 'etiquetas', label: 'Etiquetas' },
];
const DEFAULT_FORM_FIELDS_VOLTIK = ['tipo', 'producto', 'grupo', 'categoria', 'agente', 'prioridad', 'etiquetas'];
const DEFAULT_FORM_FIELDS_DESK = ['tipo', 'producto', 'grupo', 'categoria', 'prioridad', 'etiquetas'];

// ─── DEFAULTS ─────────────────────────────────────────────────────────────────
const DEFAULTS = {
    brandName: 'Volcán',
    formFields: {
        voltik: DEFAULT_FORM_FIELDS_VOLTIK,
        volcan_desk: DEFAULT_FORM_FIELDS_DESK,
    },
    types: [
        { id: 't1', label: 'Pregunta', modulo: 'voltik' },
        { id: 't2', label: 'Incidente', modulo: 'voltik' },
        { id: 't3', label: 'Problema', modulo: 'voltik' },
        { id: 't4', label: 'Feature Request', modulo: 'voltik' },
        { id: 't5', label: 'Tarea', modulo: 'voltik' },
    ],

    categories: [
        { id: 'c1', label: 'Soporte General', modulo: 'voltik' },
        { id: 'c2', label: 'Facturación', modulo: 'voltik' },
        { id: 'c3', label: 'Técnico', modulo: 'voltik' },
        { id: 'c4', label: 'Integración', modulo: 'voltik' },
    ],
    products: [
        { id: 'pr1', label: 'Prepago', modulo: 'voltik' },
        { id: 'pr2', label: 'Débito', modulo: 'voltik' },
        { id: 'pr3', label: 'Crédito', modulo: 'voltik' },
    ],
    priorities: [
        { id: 'p1', label: 'Baja',    value: 'low',    color: '#10b981', slaMinutes: 5760 },
        { id: 'p2', label: 'Media',   value: 'medium', color: '#f59e0b', slaMinutes: 2880 },
        { id: 'p3', label: 'Alta',    value: 'high',   color: '#f97316', slaMinutes: 1440 },
        { id: 'p4', label: 'Urgente', value: 'urgent', color: '#ef4444', slaMinutes: 240 },
    ],
    statusCategories: [
        { id: 'in_progress', label: 'En Proceso', behavior: 'active',   color: '#0066CC', slaMinutes: 480, isBuiltIn: false },
        { id: 'on_hold',     label: 'En Espera',  behavior: 'paused',   color: '#f59e0b', slaMinutes: 0,   isBuiltIn: false },
        { id: 'resolved',    label: 'Resuelto',   behavior: 'terminal', color: '#10b981', slaMinutes: 0,   isBuiltIn: false },
        { id: 'closed',      label: 'Cerrado',    behavior: 'terminal', color: '#64748b', slaMinutes: 0,   isBuiltIn: false },
    ],
    subStatuses: {
        in_progress: [
            { id: 'ss1', label: 'En Progreso',          value: 'in_progress' },
            { id: 'ss2', label: 'En espera del cliente', value: 'waiting_client' },
            { id: 'ss3', label: 'Escalación interna',    value: 'escalated' },
        ],
        on_hold: [
            { id: 'ss4', label: 'En Hold', value: 'on_hold' },
        ],
        resolved: [
            { id: 'ss5', label: 'Resuelto', value: 'resolved' },
        ],
        closed: [
            { id: 'ss6', label: 'Cerrado', value: 'closed' },
        ],
    },
    newSlaMinutes: 480,
    // Set de fábrica de subestados de Volcán Desk — sembrado desde SUBESTADO_OPTIONS_BY_STATUS
    // (mismo `value` que ya usan los tickets existentes, usado también como `id` de edición)
    // para que cada instalación arranque con el catálogo que ya armamos, pero quede
    // editable por el admin desde ese punto en adelante.
    deskSubStatuses: Object.fromEntries(
        Object.entries(SUBESTADO_OPTIONS_BY_STATUS).map(([statusId, opts]) =>
            [statusId, opts.map(o => ({ id: o.value, ...o }))]
        )
    ),
};

let cachedConfig = DEFAULTS;

// Load config from server (called when App starts)
export const loadConfigFromServer = async () => {
    try {
        const config = await api.get('/config');
        cachedConfig = {
            ...DEFAULTS,
            ...config,
            statusCategories: config.statusCategories ?? DEFAULTS.statusCategories,
            subStatuses: config.subStatuses ?? DEFAULTS.subStatuses,
            deskSubStatuses: config.deskSubStatuses ?? DEFAULTS.deskSubStatuses,
            formFields: {
                voltik: config.formFields?.voltik ?? DEFAULTS.formFields.voltik,
                volcan_desk: config.formFields?.volcan_desk ?? DEFAULTS.formFields.volcan_desk,
            },
        };
        
        cachedConfig.priorities = cachedConfig.priorities.map(p => 
            p.slaMinutes === undefined 
            ? { ...p, slaMinutes: DEFAULTS.priorities.find(dp => dp.id === p.id)?.slaMinutes || 1440 } 
            : p
        );
        
        return cachedConfig;
    } catch (error) {
        console.warn('Config not found on server or error, attempting to save defaults...', error);
        try {
            // Seed defaults to server if not found
            await api.post('/config', DEFAULTS);
        } catch (e) {
            console.error('Failed to seed config to server:', e);
        }
        
        // Fallback to localStorage
        const stored = localStorage.getItem(KEY);
        if (stored) {
            try {
                cachedConfig = { deskSubStatuses: DEFAULTS.deskSubStatuses, ...JSON.parse(stored) };
            } catch {
                cachedConfig = DEFAULTS;
            }
        } else {
            cachedConfig = DEFAULTS;
            localStorage.setItem(KEY, JSON.stringify(DEFAULTS));
        }
        return cachedConfig;
    }
};

// Save updated config
const save = (config) => {
    cachedConfig = config;
    localStorage.setItem(KEY, JSON.stringify(config));
    
    // Background write to server
    api.post('/config', config).catch(err => console.error('Error saving config to server:', err));
};

export const getConfig = () => {
    return cachedConfig;
};

// ─── Generic CRUD (types | groups | categories | priorities) ─────────────────
export const addConfigItem = (section, label, extra = {}) => {
    const config = { ...cachedConfig };
    const newItem = { id: `${section[0]}${Date.now()}`, label, ...extra };
    config[section] = [...(config[section] || []), newItem];
    save(config);
    return config;
};

export const removeConfigItem = (section, id) => {
    const config = { ...cachedConfig };
    config[section] = (config[section] || []).filter(i => i.id !== id);
    save(config);
    return config;
};

export const updateConfigItem = (section, id, updates) => {
    const config = { ...cachedConfig };
    config[section] = (config[section] || []).map(i => i.id === id ? { ...i, ...updates } : i);
    save(config);
    return config;
};

export const reorderConfigItems = (section, items) => {
    const config = { ...cachedConfig };
    config[section] = items;
    save(config);
    return config;
};

// ─── Status Category CRUD ─────────────────────────────────────────────────────
export const addStatusCategory = (label, behavior, color) => {
    const config = { ...cachedConfig };
    const id = `cat_${Date.now()}`;
    config.statusCategories = [
        ...(config.statusCategories || []),
        { id, label, behavior, color, slaMinutes: 0, isBuiltIn: false },
    ];
    config.subStatuses = { ...(config.subStatuses || {}), [id]: [] };
    save(config);
    return config;
};

export const removeStatusCategory = (catId) => {
    const config = { ...cachedConfig };
    config.statusCategories = (config.statusCategories || []).filter(c => c.id !== catId);
    const newSubs = { ...(config.subStatuses || {}) };
    delete newSubs[catId];
    config.subStatuses = newSubs;
    save(config);
    return config;
};

export const updateStatusCategory = (catId, updates) => {
    const config = { ...cachedConfig };
    config.statusCategories = (config.statusCategories || []).map(c =>
        c.id === catId ? { ...c, ...updates } : c
    );
    save(config);
    return config;
};

// ─── Sub-status CRUD ──────────────────────────────────────────────────────────
export const addSubStatus = (catId, label) => {
    const config = { ...cachedConfig };
    const id = `ss${Date.now()}`;
    const value = label.toLowerCase().replace(/\s+/g, '_');
    config.subStatuses = {
        ...(config.subStatuses || {}),
        [catId]: [...((config.subStatuses || {})[catId] || []), { id, label, value }],
    };
    save(config);
    return config;
};

export const removeSubStatus = (catId, ssId) => {
    const config = { ...cachedConfig };
    config.subStatuses = {
        ...(config.subStatuses || {}),
        [catId]: ((config.subStatuses || {})[catId] || []).filter(s => s.id !== ssId),
    };
    save(config);
    return config;
};

export const updateSubStatus = (catId, ssId, updates) => {
    const config = { ...cachedConfig };
    config.subStatuses = {
        ...(config.subStatuses || {}),
        [catId]: ((config.subStatuses || {})[catId] || []).map(s =>
            s.id === ssId ? { ...s, ...updates } : s
        ),
    };
    save(config);
    return config;
};

// ─── Volcán Desk: subestado CRUD (el estado principal en sí es fijo) ─────────
// A diferencia de addStatusCategory/addSubStatus (Voltik, categorías libres),
// aquí `statusId` siempre es uno de los 5 INTERNAL_STATUSES fijos — solo se
// administra la lista de subestados dentro de cada uno.
export const addDeskSubStatus = (statusId, label, description = '') => {
    const config = { ...cachedConfig };
    const id = `dss_${Date.now()}`;
    const value = label.toLowerCase().trim().replace(/\s+/g, '_');
    config.deskSubStatuses = {
        ...(config.deskSubStatuses || {}),
        [statusId]: [...((config.deskSubStatuses || {})[statusId] || []), { id, value, label, description }],
    };
    save(config);
    return config;
};

export const removeDeskSubStatus = (statusId, ssId) => {
    const config = { ...cachedConfig };
    config.deskSubStatuses = {
        ...(config.deskSubStatuses || {}),
        [statusId]: ((config.deskSubStatuses || {})[statusId] || []).filter(s => s.id !== ssId),
    };
    save(config);
    return config;
};

export const updateDeskSubStatus = (statusId, ssId, updates) => {
    const config = { ...cachedConfig };
    config.deskSubStatuses = {
        ...(config.deskSubStatuses || {}),
        [statusId]: ((config.deskSubStatuses || {})[statusId] || []).map(s =>
            s.id === ssId ? { ...s, ...updates } : s
        ),
    };
    save(config);
    return config;
};

// ─── "Nuevo" SLA config ───────────────────────────────────────────────────────
export const updateNewSla = (minutes) => {
    const config = { ...cachedConfig };
    config.newSlaMinutes = minutes;
    save(config);
    return config;
};

// ─── Category SLA config ──────────────────────────────────────────────────────
export const updateCategorySla = (catId, minutes) => {
    const config = { ...cachedConfig };
    config.statusCategories = (config.statusCategories || []).map(c =>
        c.id === catId ? { ...c, slaMinutes: minutes } : c
    );
    save(config);
    return config;
};

// ─── Status lookup helpers ────────────────────────────────────────────────────
export const resolveStatus = (statusValue) => {
    // Catálogo fijo homologado de Volcán Desk (ids no colisionan con los de Voltik)
    const internalMatch = INTERNAL_STATUSES.find(s => s.id === statusValue);
    if (internalMatch) {
        return { label: internalMatch.label, color: internalMatch.color, categoryId: internalMatch.id, behavior: internalMatch.behavior };
    }
    if (statusValue === 'new') {
        return { label: 'Nuevo', color: '#0066CC', categoryId: 'new', behavior: 'new' };
    }
    const config = cachedConfig;
    for (const cat of (config.statusCategories || [])) {
        const subs = (config.subStatuses || {})[cat.id] || [];
        const sub = subs.find(s => s.value === statusValue || s.id === statusValue);
        if (sub) return { label: sub.label, color: cat.color, categoryId: cat.id, behavior: cat.behavior };
    }
    const cat = (config.statusCategories || []).find(c => c.id === statusValue);
    if (cat) return { label: cat.label, color: cat.color, categoryId: cat.id, behavior: cat.behavior };
    return { label: statusValue, color: '#999', categoryId: null, behavior: 'active' };
};

export const isOnHoldStatus    = (v) => resolveStatus(v).behavior === 'paused';
export const isTerminalStatus  = (v) => resolveStatus(v).behavior === 'terminal';

// Resuelve un ticket.priority a { label, color }. config.priorities guarda el
// catálogo real (en Volcán Desk el `value` puede ser por-grupo, ej. "baja" o
// "baja__<grupoId>", y en Voltik son los ids en inglés 'low'/'medium'/'high'/
// 'urgent') — comparar contra literales fijos en inglés rompe los reportes de
// Volcán Desk. Si no hay match en config (dato legado), cae a las 4 etiquetas
// clásicas en inglés como último recurso.
export const resolvePriority = (priorityValue) => {
    const match = (cachedConfig.priorities || []).find(p => p.value === priorityValue || p.id === priorityValue);
    if (match) return { label: match.label, color: match.color || '#999' };
    const fallback = { low: 'Baja', medium: 'Media', high: 'Alta', urgent: 'Urgente' };
    return { label: fallback[priorityValue] || priorityValue || 'Sin prioridad', color: '#999' };
};

// ─── Campos base habilitados en el formulario de creación, por módulo ────────
export const getFormFields = (modulo) => {
    const fallback = modulo === 'volcan_desk' ? DEFAULT_FORM_FIELDS_DESK : DEFAULT_FORM_FIELDS_VOLTIK;
    return cachedConfig.formFields?.[modulo] ?? fallback;
};

export const setFormFieldEnabled = (modulo, fieldKey, enabled) => {
    const config = { ...cachedConfig };
    const current = new Set(getFormFields(modulo));
    if (enabled) current.add(fieldKey); else current.delete(fieldKey);
    config.formFields = { ...(config.formFields || {}), [modulo]: FORM_FIELD_DEFS.map(f => f.key).filter(k => current.has(k)) };
    save(config);
    return config;
};

// ─── SLA elapsed computation ──────────────────────────────────────────────────
export const computeSlaElapsed = (ticket) => {
    if (!ticket) return 0;
    const activities = ticket.activities || [];
    let elapsed = 0;
    let lastActive = new Date(ticket.createdAt);
    let isHeld = false;

    activities
        .filter(a => a.type === 'status_change')
        .sort((a, b) => new Date(a.ts) - new Date(b.ts))
        .forEach(a => {
            const ts = new Date(a.ts);
            if (!isHeld) elapsed += (ts - lastActive) / 60000;
            if (isOnHoldStatus(a.data?.to) || isTerminalStatus(a.data?.to)) {
                isHeld = true;
            } else {
                isHeld = false;
                lastActive = ts;
            }
        });

    if (!isHeld && !isTerminalStatus(ticket.status)) {
        elapsed += (Date.now() - lastActive) / 60000;
    }

    return Math.max(0, Math.round(elapsed));
};

export const updateBrandName = (name) => {
    const config = { ...cachedConfig };
    config.brandName = name;
    save(config);
    return config;
};
