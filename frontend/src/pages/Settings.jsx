import React, { useState } from 'react';
import {
    IoCheckmarkOutline, IoChevronForwardOutline,
    IoTicketOutline, IoFolderOutline,
    IoRefreshCircleOutline, IoFlashOutline,
    IoListOutline, IoAppsOutline,
    IoMailOutline,
} from 'react-icons/io5';
import { getConfig, addConfigItem, removeConfigItem, updateConfigItem, reorderConfigItems, updateBrandName } from '../services/configService';
import { getCurrentUser } from '../services/authService';
import { WorkspaceContext } from '../context/WorkspaceContext';
import FlowsConfigPage from './FlowsConfigPage';
import FormFieldsConfigPage from './FormFieldsConfigPage';
// Las 6 páginas de detalle de esta sección se dividieron en archivos propios
// (2026-09-21) — antes vivían las 6 definidas dentro de este mismo archivo
// (Settings.jsx llegó a 1,444 líneas). Este archivo ahora es solo el "hub"
// que decide cuál mostrar.
import GenericSectionPage from './GenericSectionPage';
import StatusSlaPage from './StatusSlaPage';
import PrioritySlaPage from './PrioritySlaPage';
import CategoriesConfigPage from './CategoriesConfigPage';
import EmailNotificationsConfigPage from './EmailNotificationsConfigPage';
import './Settings.css';

// ─── Non-status sections ──────────────────────────────────────────────────────
const BASE_SECTIONS = [
    { key: 'types',      label: 'Tipos de Ticket',   icon: IoTicketOutline,        color: '#0066CC', description: 'Tipos disponibles al crear un ticket.',              locked: false, special: false },
    { key: 'categories', label: 'Categorías',        icon: IoFolderOutline,        color: '#34c759', description: 'Clasificación por área o producto.',                 locked: false, special: false },
    { key: 'products',   label: 'Productos',         icon: IoTicketOutline,        color: '#5856d6', description: 'Productos disponibles al crear un ticket.',          locked: false, special: false },
    { key: 'formFields', label: 'Campos del Formulario', icon: IoAppsOutline,      color: '#0891b2', description: 'Qué campos aparecen al crear un ticket/solicitud.', locked: false, special: true  },
    { key: 'flows',      label: 'Flujos de Ticket',  icon: IoListOutline,          color: '#8e8e93', description: 'Reglas y campos dinámicos para formularios.',           locked: false, special: true  },
    { key: 'statuses',   label: 'Estados de Vida',   icon: IoRefreshCircleOutline, color: '#ff9500', description: 'Ciclo de vida, estados y objetivo inicial.',         locked: false, special: true  },
    { key: 'priorities', label: 'Prioridades & SLA', icon: IoFlashOutline,         color: '#ff3b30', description: 'Niveles de urgencia y tiempos de resolución (SLA).', locked: true,  special: true },
    // Solo Volcán Desk — el sistema de correos (server.js) solo dispara para
    // ambito='interno', así que este ajuste no aplica ni se muestra en Voltik.
    { key: 'emailNotifications', label: 'Notificaciones por correo', icon: IoMailOutline, color: '#0891b2', description: 'Qué correos automáticos recibe cada grupo.', locked: false, special: true, deskOnly: true },
];

// ─── Hub page ─────────────────────────────────────────────────────────────────
export default function Settings() {
    const { activeWorkspace } = React.useContext(WorkspaceContext);
    const currentUser = getCurrentUser();
    const isAdmin = currentUser?.role === 'admin';
    const isGroupAdmin = currentUser?.role === 'group_admin';
    const [config, setConfig] = useState(getConfig());
    const [brandInput, setBrandInput] = useState(config.brandName || 'Volcán');
    const [activeSection, setActiveSection] = useState(null);

    if (!isAdmin && !isGroupAdmin) {
        return (
            <div className="unauthorized-container">
                <h2>Acceso Denegado</h2>
                <p>No tienes permisos para ver esta sección.</p>
            </div>
        );
    }

    // group_admin: solo catálogo por grupo — sin nombre de marca (tenant global) ni
    // Estados de Vida (ciclo de Voltik, no es por-grupo).
    const visibleSections = BASE_SECTIONS
        .filter(s => !isGroupAdmin || s.key !== 'statuses')
        .filter(s => !s.deskOnly || activeWorkspace === 'volcan_desk');

    const refresh = () => {
        const conf = getConfig();
        setConfig(conf);
        setBrandInput(conf.brandName || 'Volcán');
    };

    const handleSaveBrand = () => {
        if (brandInput.trim()) {
            updateBrandName(brandInput.trim());
            const conf = getConfig();
            setConfig(conf);
            setBrandInput(conf.brandName || 'Volcán');
            alert('Nombre de marca guardado correctamente.');
        }
    };

    const handleAdd    = (s, label, extra = {}) => { addConfigItem(s, label, { ...extra, modulo: activeWorkspace }); refresh(); };
    const handleRemove = (s, id)                => { removeConfigItem(s, id);          refresh(); };
    const handleUpdate = (s, id, updates)       => { updateConfigItem(s, id, updates); refresh(); };
    const handleReorder = (s, items)            => { reorderConfigItems(s, items);     refresh(); };

    if (activeSection?.special) {
        if (activeSection.key === 'statuses') {
            return <StatusSlaPage key={activeWorkspace} config={config} activeWorkspace={activeWorkspace} onBack={() => setActiveSection(null)} onRefresh={refresh} />;
        }
        if (activeSection.key === 'priorities') {
            return <PrioritySlaPage key={activeWorkspace} config={config} activeWorkspace={activeWorkspace} onBack={() => setActiveSection(null)} onRefresh={refresh} />;
        }
        if (activeSection.key === 'flows') {
            return <FlowsConfigPage key={activeWorkspace} onBack={() => setActiveSection(null)} config={config} activeWorkspace={activeWorkspace} />;
        }
        if (activeSection.key === 'formFields') {
            return (
                <FormFieldsConfigPage
                    key={activeWorkspace}
                    activeWorkspace={activeWorkspace}
                    onBack={() => setActiveSection(null)}
                    onRefresh={refresh}
                />
            );
        }
        if (activeSection.key === 'emailNotifications') {
            return <EmailNotificationsConfigPage key={activeWorkspace} onBack={() => setActiveSection(null)} />;
        }
    }

    // Volcán Desk: Categorías tiene su propia pantalla (vínculo a Tipo + SLA propio,
    // ver CategoriesConfigPage) en vez del editor genérico de lista simple. En Voltik
    // sigue siendo un GenericSectionPage normal.
    if (activeSection?.key === 'categories' && activeWorkspace === 'volcan_desk') {
        return <CategoriesConfigPage key={activeWorkspace} config={config} activeWorkspace={activeWorkspace} onBack={() => setActiveSection(null)} onRefresh={refresh} />;
    }

    if (activeSection) {
        return <GenericSectionPage
            key={`${activeSection.key}-${activeWorkspace}`}
            section={activeSection}
            config={config}
            activeWorkspace={activeWorkspace}
            onBack={() => setActiveSection(null)}
            onAdd={handleAdd} onRemove={handleRemove} onUpdate={handleUpdate} onReorder={handleReorder}
        />;
    }

    return (
        <div className="settings-hub">
            <div className="settings-hub-header">
                <h1>Configuración</h1>
                <p>Selecciona una sección para administrar sus opciones.</p>
            </div>

            {isAdmin && (
                <div className="settings-brand-container" style={{ background: '#fff', borderRadius: '12px', border: '1px solid #e2e8f0', padding: '16px 20px', marginBottom: '24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: '240px' }}>
                        <h3 style={{ fontSize: '15px', fontWeight: '600', color: '#1e293b', margin: '0 0 4px 0' }}>Nombre de la empresa (Tenant)</h3>
                        <p style={{ fontSize: '13px', color: '#64748b', margin: 0 }}>Nombre utilizado en los avisos enviados al cliente (ej. Voltik).</p>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <input
                            type="text"
                            value={brandInput}
                            onChange={(e) => setBrandInput(e.target.value)}
                            className="settings-inline-input"
                            style={{ width: '200px', padding: '8px 12px', fontSize: '13px', borderRadius: '6px', border: '1px solid #cbd5e1', outline: 'none' }}
                        />
                        <button
                            className="btn btn-primary"
                            onClick={handleSaveBrand}
                            style={{ padding: '8px 16px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px', background: '#0066CC', color: '#fff', border: 'none', borderRadius: '6px', fontWeight: '500', cursor: 'pointer' }}
                        >
                            <IoCheckmarkOutline size={15} /> Guardar
                        </button>
                    </div>
                </div>
            )}

            <div className="settings-hub-grid">
                {visibleSections.map(section => {
                    // 'special' agrupaba 5 secciones muy distintas bajo el mismo ternario de
                    // 2 ramas — todo lo que no fuera 'statuses' caía por error en
                    // config.priorities (bug reportado en vivo 2026-09-14: "Campos del
                    // Formulario" y "Flujos de Ticket" mostraban "Alto/Medio/Bajo", que son
                    // Prioridades). 'formFields' y 'flows' viven en sus propias tablas
                    // (CampoCatalogo/ReglaFlujo), no en este blob de Config, así que aquí no
                    // hay de dónde sacar una vista previa barata — se listan vacíos ("Sin
                    // opciones") en vez de mostrar datos ajenos.
                    const allItems = section.key === 'emailNotifications' || section.key === 'formFields' || section.key === 'flows'
                        ? []
                        : section.key === 'statuses'
                            ? config.statusCategories || []
                            : section.key === 'priorities'
                                ? config.priorities || []
                                : (config[section.key] || []);
                    const items = allItems
                        .filter(i => (i.modulo || 'voltik') === activeWorkspace)
                        // group_admin: mismo alcance por grupo que va a ver al entrar a la
                        // sección (Tipos/Categorías/Productos/Prioridades tienen grupoId) —
                        // antes el conteo del hub mezclaba TODOS los grupos de Volcán Desk,
                        // prometiendo "+8 más"/"+10 más" cuando su propia lista, ya adentro,
                        // solo tenía 5 (reportado en vivo 2026-09-14).
                        .filter(i => !isGroupAdmin || activeWorkspace !== 'volcan_desk' || i.grupoId === currentUser.admin_group_id);
                    const Icon = section.icon;
                    const isDeskPriorities = section.key === 'priorities' && activeWorkspace === 'volcan_desk';
                    const isDeskCategories = section.key === 'categories' && activeWorkspace === 'volcan_desk';
                    const cardLabel = isDeskPriorities ? 'Prioridades' : section.label;
                    const cardDesc = isDeskPriorities
                        ? 'Niveles de urgencia. El SLA se configura por Categoría.'
                        : isDeskCategories
                            ? 'Clasificación ligada a un Tipo — aquí se define el SLA de cada solicitud.'
                            : section.description;
                    return (
                        <button key={section.key} className="settings-hub-card" onClick={() => setActiveSection(section)}>
                            <div className="shc-icon" style={{ background: `${section.color}15`, color: section.color }}><Icon size={24} /></div>
                            <div className="shc-body">
                                <div className="shc-label">{cardLabel}</div>
                                <div className="shc-desc">{cardDesc}</div>
                                <div className="shc-preview">
                                    {items.slice(0, 3).map(i => (
                                        <span key={i.id} className="shc-chip">
                                            {i.color && <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: i.color, marginRight: 4, verticalAlign: 'middle' }} />}
                                            {i.label}
                                        </span>
                                    ))}
                                    {items.length > 3 && <span className="shc-chip shc-chip-more">+{items.length - 3} más</span>}
                                    {items.length === 0 && <span className="shc-chip shc-chip-empty">Sin opciones</span>}
                                </div>
                            </div>
                            <IoChevronForwardOutline size={18} className="shc-arrow" />
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
