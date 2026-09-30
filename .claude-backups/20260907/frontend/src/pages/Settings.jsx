import React, { useState } from 'react';
import {
    IoArrowBack, IoAddOutline, IoTrashOutline, IoPencilOutline,
    IoCheckmarkOutline, IoCloseOutline, IoChevronForwardOutline,
    IoTicketOutline, IoPeopleOutline, IoFolderOutline,
    IoRefreshCircleOutline, IoFlashOutline, IoTimeOutline,
    IoStarOutline, IoListOutline, IoAppsOutline, IoLockClosedOutline,
    IoMailOutline,
} from 'react-icons/io5';
import {
    getConfig, addConfigItem, removeConfigItem, updateConfigItem,
    BEHAVIORS, INTERNAL_STATUSES,
    addStatusCategory, removeStatusCategory, updateStatusCategory,
    addSubStatus, removeSubStatus, updateSubStatus,
    addDeskSubStatus, removeDeskSubStatus, updateDeskSubStatus,
    updateNewSla, updateCategorySla, updateBrandName,
    getGroupBloqueoCapMinutes, updateGroupBloqueoCap,
    getGroupEmailNotificationSettings, updateGroupEmailNotificationSetting,
} from '../services/configService';
import { getGroups } from '../services/groupService';
import { getCurrentUser } from '../services/authService';
import { WorkspaceContext } from '../context/WorkspaceContext';
import FlowsConfigPage from './FlowsConfigPage';
import FormFieldsConfigPage from './FormFieldsConfigPage';
import { GroupScopePicker, GroupScopeReassign, GroupScopeBreadcrumb } from '../components/GroupScopeGate';
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

const SLA_OPTIONS = [
    { value: 60,    label: '1 hora' },
    { value: 120,   label: '2 horas' },
    { value: 240,   label: '4 horas' },
    { value: 480,   label: '8 horas' },
    { value: 720,   label: '12 horas' },
    { value: 1440,  label: '24 horas' },
    { value: 2880,  label: '48 horas' },
    { value: 10080, label: '7 días' },
    { value: 0,     label: 'Sin límite' },
];

// Tope máximo de pausa por Bloqueo ("Stop SLA") — un ticket puede seguir marcado
// como Bloqueado más tiempo, pero pasado este tope el SLA vuelve a correr solo.
const BLOQUEO_CAP_OPTIONS = [
    { value: 1440,  label: '1 día' },
    { value: 7200,  label: '5 días' },
    { value: 14400, label: '10 días' },
    { value: 21600, label: '15 días' },
    { value: 28800, label: '20 días' },
    { value: 36000, label: '25 días' },
    { value: 43200, label: '30 días' },
];

// ─── Generic section detail ───────────────────────────────────────────────────
function GenericSectionPage({ section, config, activeWorkspace, onBack, onAdd, onRemove, onUpdate }) {
    const isDesk = activeWorkspace === 'volcan_desk';
    const currentUser = getCurrentUser();
    const isGroupAdminUser = currentUser?.role === 'group_admin';
    // group_admin solo administra un grupo — no ve el resto ni el picker.
    const deskGroups = isDesk
        ? getGroups().filter(g => g.modulo === 'volcan_desk' && (!isGroupAdminUser || g.id === currentUser.admin_group_id))
        : [];
    const moduleItems = (config[section.key] || []).filter(i => (i.modulo || 'voltik') === activeWorkspace);

    // ── Group gate (Volcán Desk only): pick a support group before managing this domain ──
    // All hooks live at the top, unconditionally, so the early-return branches below
    // (group picker / reassign screens) don't break the Rules of Hooks.
    // group_admin salta el picker: ya tiene su único grupo preseleccionado.
    const [selectedGroupId, setSelectedGroupId] = useState(isGroupAdminUser ? currentUser.admin_group_id : null);
    const [reassigning, setReassigning] = useState(false);
    const [newLabel, setNewLabel] = useState('');
    const [editingId, setEditingId] = useState(null);
    const [editLabel, setEditLabel] = useState('');

    if (isDesk && reassigning) {
        return (
            <div className="settings-detail-page">
                <div className="settings-detail-header">
                    <button className="settings-back-btn" onClick={onBack}><IoArrowBack size={18} /> Configuración</button>
                    <div className="settings-detail-title-row">
                        <div className="settings-section-icon" style={{ background: `${section.color}18`, color: section.color }}><section.icon size={22} /></div>
                        <div><h1>{section.label} — reasignar</h1><p>{section.description}</p></div>
                    </div>
                </div>
                <div className="settings-detail-body" style={{ display: 'block' }}>
                    <GroupScopeReassign
                        itemLabelPlural={section.label.toLowerCase()}
                        items={moduleItems}
                        groups={deskGroups}
                        getGroupId={i => i.grupoId}
                        getLabel={i => i.label}
                        onAssign={(item, groupId) => onUpdate(section.key, item.id, { grupoId: groupId })}
                        onBack={() => setReassigning(false)}
                    />
                </div>
            </div>
        );
    }

    if (isDesk && !selectedGroupId) {
        return (
            <div className="settings-detail-page">
                <div className="settings-detail-header">
                    <button className="settings-back-btn" onClick={onBack}><IoArrowBack size={18} /> Configuración</button>
                    <div className="settings-detail-title-row">
                        <div className="settings-section-icon" style={{ background: `${section.color}18`, color: section.color }}><section.icon size={22} /></div>
                        <div><h1>{section.label}</h1><p>{section.description}</p></div>
                    </div>
                </div>
                <div className="settings-detail-body" style={{ display: 'block' }}>
                    <GroupScopePicker
                        itemLabelPlural={section.label.toLowerCase()}
                        groups={deskGroups}
                        items={moduleItems}
                        getGroupId={i => i.grupoId}
                        onSelectGroup={setSelectedGroupId}
                        onManageUnassigned={() => setReassigning(true)}
                    />
                </div>
            </div>
        );
    }

    const items = isDesk ? moduleItems.filter(i => i.grupoId === selectedGroupId) : moduleItems;
    const Icon = section.icon;

    const handleAdd = () => {
        if (!newLabel.trim()) return;
        onAdd(section.key, newLabel.trim(), isDesk ? { grupoId: selectedGroupId } : {});
        setNewLabel('');
    };
    const startEdit = (item) => { setEditingId(item.id); setEditLabel(item.label); };
    const saveEdit = () => { if (editLabel.trim()) onUpdate(section.key, editingId, { label: editLabel.trim() }); setEditingId(null); };

    return (
        <div className="settings-detail-page">
            <div className="settings-detail-header">
                <button className="settings-back-btn" onClick={onBack}><IoArrowBack size={18} /> Configuración</button>
                <div className="settings-detail-title-row">
                    <div className="settings-section-icon" style={{ background: `${section.color}18`, color: section.color }}><Icon size={22} /></div>
                    <div><h1>{section.label}</h1><p>{section.description}</p></div>
                </div>
            </div>
            {isDesk && (
                <div style={{ padding: '0 0 4px' }}>
                    <GroupScopeBreadcrumb
                        groupName={deskGroups.find(g => g.id === selectedGroupId)?.name || '—'}
                        onChangeGroup={() => setSelectedGroupId(null)}
                    />
                </div>
            )}
            <div className="settings-detail-body">
                <div className="settings-preview-panel">
                    <div className="settings-preview-title">Vista Previa</div>
                    <p className="settings-preview-subtitle">Así se verán estas opciones al crear un ticket:</p>
                    <div className="settings-preview-dropdown">
                        <div className="spd-label">-- Seleccionar {section.label} --</div>
                        {items.map(item => (
                            <div key={item.id} className="spd-option">
                                {item.color && <span className="spd-dot" style={{ background: item.color }} />}
                                {item.label}
                                {item.isDefault && <span className="spd-default">predeterminado</span>}
                            </div>
                        ))}
                        {items.length === 0 && <div className="spd-empty">Sin opciones todavía</div>}
                    </div>
                </div>
                <div className="settings-edit-panel">
                    <div className="settings-edit-title">Opciones actuales <span className="settings-count-badge">{items.length}</span></div>
                    <div className="settings-items-list">
                        {items.map(item => (
                            <div key={item.id} className="settings-item-row">
                                {item.color && <span className="settings-item-dot" style={{ background: item.color }} />}
                                {editingId === item.id ? (
                                    <>
                                        <input value={editLabel} onChange={e => setEditLabel(e.target.value)}
                                            onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditingId(null); }}
                                            autoFocus className="settings-inline-input" />
                                        <button className="btn btn-primary btn-sm" onClick={saveEdit} style={{ padding: '4px 10px' }}><IoCheckmarkOutline size={14} /></button>
                                        <button className="btn btn-secondary btn-sm" onClick={() => setEditingId(null)} style={{ padding: '4px 10px' }}><IoCloseOutline size={14} /></button>
                                    </>
                                ) : (
                                    <>
                                        <span className="settings-item-label">{item.label}{item.isDefault && <span className="settings-item-default">predeterminado</span>}</span>
                                        <button className="settings-icon-btn" onClick={() => startEdit(item)}><IoPencilOutline size={15} /></button>
                                        {!section.locked && !item.isDefault && <button className="settings-icon-btn danger" onClick={() => onRemove(section.key, item.id)}><IoTrashOutline size={15} /></button>}
                                    </>
                                )}
                            </div>
                        ))}
                        {items.length === 0 && <div className="settings-empty-state">Sin opciones. Agrega una abajo.</div>}
                    </div>
                    {!section.locked && (
                        <div className="settings-add-row">
                            <input value={newLabel} onChange={e => setNewLabel(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }} placeholder="Nueva opción..." className="settings-add-input" />
                            <button className="btn btn-primary btn-sm" onClick={handleAdd} disabled={!newLabel.trim()}><IoAddOutline size={16} /> Agregar</button>
                        </div>
                    )}
                    {section.locked && <p className="settings-locked-note">🔒 Los elementos no pueden eliminarse, solo renombrarse.</p>}
                </div>
            </div>
        </div>
    );
}

// ─── Volcán Desk: estados fijos + subestados editables ────────────────────────
// Los 5 estados principales (INTERNAL_STATUSES) son fijos en código a propósito
// — filtros, columnas por vista y SLA en toda la app dependen de esos ids exactos
// (to_do/on_going/...). Los SUBESTADOS (lo que sale en "Etiquetas" del ticket) sí
// se pueden agregar/renombrar/quitar aquí; se guardan en config.deskSubStatuses y
// getEtiquetaOptionsForStatus() los lee en vivo, así que un cambio aquí se refleja
// de inmediato en el dropdown "Etiquetas" del detalle de la solicitud.
function DeskStatusesEditor({ config, onBack, onRefresh }) {
    const deskSubs = config.deskSubStatuses || {};

    const [editSubId, setEditSubId] = useState(null); // `${statusId}::${ssId}`
    const [editLabel, setEditLabel] = useState('');
    const [editDesc, setEditDesc] = useState('');
    const [newSubLabel, setNewSubLabel] = useState({}); // { [statusId]: string }

    const startEdit = (statusId, sub) => {
        setEditSubId(`${statusId}::${sub.id}`);
        setEditLabel(sub.label);
        setEditDesc(sub.description || '');
    };

    const saveSubEdit = (statusId, ssId) => {
        if (!editLabel.trim()) return;
        updateDeskSubStatus(statusId, ssId, { label: editLabel.trim(), description: editDesc.trim() });
        setEditSubId(null);
        onRefresh();
    };

    const handleAddSub = (statusId) => {
        const label = (newSubLabel[statusId] || '').trim();
        if (!label) return;
        addDeskSubStatus(statusId, label);
        setNewSubLabel(p => ({ ...p, [statusId]: '' }));
        onRefresh();
    };

    const handleRemoveSub = (statusId, ssId) => {
        if (!window.confirm('¿Eliminar este subestado? Los tickets que ya lo tengan asignado conservarán el valor guardado, pero dejará de aparecer como opción.')) return;
        removeDeskSubStatus(statusId, ssId);
        onRefresh();
    };

    return (
        <div className="settings-detail-page">
            <div className="settings-detail-header">
                <button className="settings-back-btn" onClick={onBack}><IoArrowBack size={18} /> Configuración</button>
                <div className="settings-detail-title-row">
                    <div className="settings-section-icon" style={{ background: '#ff950015', color: '#ff9500' }}><IoRefreshCircleOutline size={22} /></div>
                    <div><h1>Estados de Vida</h1><p>Estados y subestados de Volcán Desk.</p></div>
                </div>
            </div>

            <div className="settings-sla-layout">
                <div className="settings-sla-left">
                    <div className="desk-fixed-note">
                        <IoLockClosedOutline size={15} />
                        <span>Los 5 estados principales son fijos (de ellos dependen filtros, columnas y el SLA de Volcán Desk). Los subestados sí son editables — se reflejan al instante en "Etiquetas" dentro de cada solicitud.</span>
                    </div>

                    {INTERNAL_STATUSES.map(s => {
                        const subOptions = deskSubs[s.id] || [];
                        const behavior = BEHAVIORS.find(b => b.id === s.behavior);
                        return (
                            <div key={s.id} className="desk-status-card" style={{ borderLeftColor: s.color }}>
                                <div className="desk-status-card-head">
                                    <span className="scb-dot" style={{ background: s.color }} />
                                    <span className="scb-label">{s.label}</span>
                                    <span className="scb-behavior-tag" style={{ background: `${s.color}18`, color: s.color }}>
                                        {behavior?.label || s.behavior}
                                    </span>
                                    <span className="desk-substate-count">{subOptions.length} subestado{subOptions.length !== 1 ? 's' : ''}</span>
                                </div>

                                <div className="settings-items-list" style={{ marginBottom: 0 }}>
                                    {subOptions.map(sub => {
                                        const subKey = `${s.id}::${sub.id}`;
                                        return (
                                            <div key={sub.id} className="settings-item-row" style={{ alignItems: editSubId === subKey ? 'flex-start' : 'center' }}>
                                                <span className="settings-item-dot" style={{ background: s.color, opacity: 0.7, marginTop: editSubId === subKey ? 8 : 0 }} />
                                                {editSubId === subKey ? (
                                                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                                                        <input className="settings-inline-input" value={editLabel}
                                                            onChange={e => setEditLabel(e.target.value)}
                                                            onKeyDown={e => { if (e.key === 'Escape') setEditSubId(null); }}
                                                            placeholder="Nombre del subestado" autoFocus />
                                                        <input className="settings-inline-input" value={editDesc}
                                                            onChange={e => setEditDesc(e.target.value)}
                                                            onKeyDown={e => { if (e.key === 'Enter') saveSubEdit(s.id, sub.id); if (e.key === 'Escape') setEditSubId(null); }}
                                                            placeholder="Descripción (opcional)" style={{ fontSize: '0.76rem' }} />
                                                        <div style={{ display: 'flex', gap: 6 }}>
                                                            <button className="btn btn-primary btn-sm" onClick={() => saveSubEdit(s.id, sub.id)}><IoCheckmarkOutline size={13} /> Guardar</button>
                                                            <button className="btn btn-secondary btn-sm" onClick={() => setEditSubId(null)}><IoCloseOutline size={13} /></button>
                                                        </div>
                                                    </div>
                                                ) : (
                                                    <>
                                                        <span className="settings-item-label" title={sub.description}>{sub.label}</span>
                                                        <button className="settings-icon-btn" onClick={() => startEdit(s.id, sub)}><IoPencilOutline size={13} /></button>
                                                        <button className="settings-icon-btn danger" onClick={() => handleRemoveSub(s.id, sub.id)}><IoTrashOutline size={13} /></button>
                                                    </>
                                                )}
                                            </div>
                                        );
                                    })}
                                    {subOptions.length === 0 && <div className="settings-empty-state">Sin subestados. Agrega uno abajo.</div>}

                                    <div className="settings-add-row" style={{ marginTop: 4 }}>
                                        <input
                                            className="settings-add-input"
                                            placeholder={`Agregar subestado en "${s.label}"...`}
                                            value={newSubLabel[s.id] || ''}
                                            onChange={e => setNewSubLabel(p => ({ ...p, [s.id]: e.target.value }))}
                                            onKeyDown={e => { if (e.key === 'Enter') handleAddSub(s.id); }}
                                        />
                                        <button className="btn btn-secondary btn-sm" onClick={() => handleAddSub(s.id)}
                                            disabled={!(newSubLabel[s.id] || '').trim()}>
                                            <IoAddOutline size={14} />
                                        </button>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>

                <div className="settings-sla-right">
                    <div className="settings-edit-title"><IoTimeOutline size={18} /> Comportamiento del SLA</div>
                    {BEHAVIORS.map(b => (
                        <div key={b.id} className="sla-config-row">
                            <div className="sla-cat-name">{b.label}</div>
                            <div className="sla-cat-behavior">{b.description}</div>
                        </div>
                    ))}
                    <div className="sla-info-box" style={{ marginTop: 20 }}>
                        <strong>Cómo funcionan los subestados</strong>
                        <ul>
                            <li>Son metadata sobre el estado principal — nunca lo reemplazan ni crean un estado nuevo.</li>
                            <li>Cada estado principal tiene su propio set editable; "Revisión" no trae ninguno por defecto.</li>
                            <li>Se seleccionan desde la solicitud misma, en el campo "Etiquetas" de la barra lateral — las opciones cambian según el Estado actual.</li>
                            <li>Al cambiar el estado principal de una solicitud, el subestado se limpia si ya no aplica.</li>
                            <li>Si borras un subestado que ya estaba asignado a alguna solicitud, esa solicitud conserva el valor guardado pero deja de mostrarse como opción seleccionable.</li>
                        </ul>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ─── Status & SLA page ────────────────────────────────────────────────────────
function StatusSlaPage({ config, activeWorkspace, onBack, onRefresh }) {
    if (activeWorkspace === 'volcan_desk') {
        return <DeskStatusesEditor config={config} onBack={onBack} onRefresh={onRefresh} />;
    }

    const cats = config.statusCategories || [];
    const subs = config.subStatuses || {};
    const newSla = config.newSlaMinutes ?? 480;

    // Category editing
    const [editCatId, setEditCatId] = useState(null);
    const [editCat, setEditCat] = useState({});
    // Sub-status editing
    const [editSubId, setEditSubId] = useState(null);   // `${catId}::${ssId}`
    const [editSubLabel, setEditSubLabel] = useState('');
    // New category form
    const [showAddCat, setShowAddCat] = useState(false);
    const [newCat, setNewCat] = useState({ label: '', behavior: 'active', color: '#0066CC' });
    // New sub-status per category
    const [newSubLabel, setNewSubLabel] = useState({});  // { [catId]: string }

    const refresh = onRefresh;

    // ── Category actions ────────────
    const saveCat = () => {
        updateStatusCategory(editCatId, editCat);
        if (editCat.slaMinutes !== undefined) updateCategorySla(editCatId, editCat.slaMinutes);
        refresh();
        setEditCatId(null);
    };

    const handleAddCat = () => {
        if (!newCat.label.trim()) return;
        addStatusCategory(newCat.label.trim(), newCat.behavior, newCat.color);
        setNewCat({ label: '', behavior: 'active', color: '#0066CC' });
        setShowAddCat(false);
        refresh();
    };

    const handleDeleteCat = (catId) => {
        if (!window.confirm('¿Eliminar esta categoría y todos sus sub-estados?')) return;
        removeStatusCategory(catId);
        refresh();
    };

    // ── Sub-status actions ──────────
    const handleAddSub = (catId) => {
        const label = (newSubLabel[catId] || '').trim();
        if (!label) return;
        addSubStatus(catId, label);
        setNewSubLabel(p => ({ ...p, [catId]: '' }));
        refresh();
    };

    const saveSubEdit = (catId, ssId) => {
        if (editSubLabel.trim()) updateSubStatus(catId, ssId, { label: editSubLabel.trim() });
        setEditSubId(null);
        refresh();
    };

    return (
        <div className="settings-detail-page">
            <div className="settings-detail-header">
                <button className="settings-back-btn" onClick={onBack}><IoArrowBack size={18} /> Configuración</button>
                <div className="settings-detail-title-row">
                    <div className="settings-section-icon" style={{ background: '#ff950015', color: '#ff9500' }}><IoRefreshCircleOutline size={22} /></div>
                    <div><h1>Estados de Vida</h1><p>Administra categorías de estado, sus sub-estados y el SLA del nuevo ticket.</p></div>
                </div>
            </div>

            <div className="settings-sla-layout">

                {/* ── LEFT: Categories + sub-states ─────────────── */}
                <div className="settings-sla-left">

                    {/* NUEVO - built-in special */}
                    <div className="status-category-block" style={{ borderLeftColor: '#0066CC' }}>
                        <div className="status-category-header">
                            <span className="scb-dot" style={{ background: '#0066CC' }} />
                            <div>
                                <span className="scb-label">Nuevo</span>
                                <span className="scb-built-in">estado inicial</span>
                            </div>
                            <span className="scb-desc">Todos los tickets nacen aquí. Sin sub-estados.</span>
                        </div>
                        <div className="status-new-sla-row">
                            <IoTimeOutline size={14} style={{ color: 'var(--color-text-muted)' }} />
                            <span className="sla-target-label">SLA objetivo:</span>
                            <select className="sla-select" value={newSla}
                                onChange={e => { updateNewSla(Number(e.target.value)); refresh(); }}>
                                {SLA_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                        </div>
                    </div>

                    {/* Editable categories */}
                    {cats.map(cat => {
                        const catSubs = subs[cat.id] || [];
                        const behavior = BEHAVIORS.find(b => b.id === cat.behavior);
                        return (
                            <div key={cat.id} className="status-category-block" style={{ borderLeftColor: cat.color }}>
                                {/* Category header */}
                                {editCatId === cat.id ? (
                                    <div className="status-cat-edit-form">
                                        <input className="settings-inline-input" value={editCat.label}
                                            onChange={e => setEditCat(p => ({ ...p, label: e.target.value }))}
                                            placeholder="Nombre de categoría" />
                                        <div className="status-edit-row">
                                            <label className="status-edit-field-label">Color</label>
                                            <input type="color" className="color-picker" value={editCat.color}
                                                onChange={e => setEditCat(p => ({ ...p, color: e.target.value }))} />
                                            <label className="status-edit-field-label">Comportamiento</label>
                                            <select className="status-cat-select" value={editCat.behavior}
                                                onChange={e => setEditCat(p => ({ ...p, behavior: e.target.value }))}>
                                                {BEHAVIORS.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}
                                            </select>
                                        </div>
                                        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                                            <button className="btn btn-primary btn-sm" onClick={saveCat}><IoCheckmarkOutline size={14} /> Guardar</button>
                                            <button className="btn btn-secondary btn-sm" onClick={() => setEditCatId(null)}><IoCloseOutline size={14} /></button>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="status-category-header">
                                        <span className="scb-dot" style={{ background: cat.color }} />
                                        <div style={{ flex: 1 }}>
                                            <span className="scb-label">{cat.label}</span>
                                            <span className="scb-behavior-tag" style={{ background: `${cat.color}18`, color: cat.color }}>
                                                {behavior?.label || cat.behavior}
                                            </span>
                                        </div>
                                        <button className="settings-icon-btn" onClick={() => { setEditCatId(cat.id); setEditCat({ label: cat.label, color: cat.color, behavior: cat.behavior, slaMinutes: cat.slaMinutes }); }}>
                                            <IoPencilOutline size={14} />
                                        </button>
                                        <button className="settings-icon-btn danger" onClick={() => handleDeleteCat(cat.id)}>
                                            <IoTrashOutline size={14} />
                                        </button>
                                    </div>
                                )}

                                {/* Sub-states — inherit category color */}
                                <div className="settings-items-list" style={{ marginLeft: 16, marginBottom: 0 }}>
                                    {catSubs.map(sub => {
                                        const subKey = `${cat.id}::${sub.id}`;
                                        return (
                                            <div key={sub.id} className="settings-item-row">
                                                <span className="settings-item-dot" style={{ background: cat.color, opacity: 0.7 }} />
                                                {editSubId === subKey ? (
                                                    <>
                                                        <input className="settings-inline-input" value={editSubLabel}
                                                            onChange={e => setEditSubLabel(e.target.value)}
                                                            onKeyDown={e => { if (e.key === 'Enter') saveSubEdit(cat.id, sub.id); if (e.key === 'Escape') setEditSubId(null); }}
                                                            autoFocus />
                                                        <button className="btn btn-primary btn-sm" onClick={() => saveSubEdit(cat.id, sub.id)} style={{ padding: '4px 10px' }}><IoCheckmarkOutline size={13} /></button>
                                                        <button className="btn btn-secondary btn-sm" onClick={() => setEditSubId(null)} style={{ padding: '4px 10px' }}><IoCloseOutline size={13} /></button>
                                                    </>
                                                ) : (
                                                    <>
                                                        <span className="settings-item-label">{sub.label}</span>
                                                        <button className="settings-icon-btn" onClick={() => { setEditSubId(subKey); setEditSubLabel(sub.label); }}><IoPencilOutline size={13} /></button>
                                                        <button className="settings-icon-btn danger" onClick={() => { removeSubStatus(cat.id, sub.id); refresh(); }}><IoTrashOutline size={13} /></button>
                                                    </>
                                                )}
                                            </div>
                                        );
                                    })}
                                    {/* Add sub-status */}
                                    <div className="settings-add-row" style={{ marginTop: 4 }}>
                                        <input
                                            className="settings-add-input"
                                            placeholder={`Agregar sub-estado en "${cat.label}"...`}
                                            value={newSubLabel[cat.id] || ''}
                                            onChange={e => setNewSubLabel(p => ({ ...p, [cat.id]: e.target.value }))}
                                            onKeyDown={e => { if (e.key === 'Enter') handleAddSub(cat.id); }}
                                        />
                                        <button className="btn btn-secondary btn-sm" onClick={() => handleAddSub(cat.id)}
                                            disabled={!(newSubLabel[cat.id] || '').trim()}>
                                            <IoAddOutline size={14} />
                                        </button>
                                    </div>
                                </div>
                            </div>
                        );
                    })}

                    {/* Add new category */}
                    {showAddCat ? (
                        <div className="status-add-block">
                            <div className="settings-edit-title" style={{ marginBottom: 10 }}>Nueva categoría principal</div>
                            <div className="status-add-form">
                                <input className="settings-add-input" style={{ flex: 2 }}
                                    placeholder="Nombre (ej. En Revisión)..."
                                    value={newCat.label}
                                    onChange={e => setNewCat(p => ({ ...p, label: e.target.value }))}
                                    onKeyDown={e => { if (e.key === 'Enter') handleAddCat(); }}
                                />
                                <input type="color" className="color-picker" value={newCat.color}
                                    onChange={e => setNewCat(p => ({ ...p, color: e.target.value }))} />
                                <select className="status-cat-select" value={newCat.behavior}
                                    onChange={e => setNewCat(p => ({ ...p, behavior: e.target.value }))}>
                                    {BEHAVIORS.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}
                                </select>
                                <button className="btn btn-primary btn-sm" onClick={handleAddCat} disabled={!newCat.label.trim()}>
                                    <IoCheckmarkOutline size={14} /> Agregar
                                </button>
                                <button className="btn btn-secondary btn-sm" onClick={() => setShowAddCat(false)}>
                                    <IoCloseOutline size={14} />
                                </button>
                            </div>
                        </div>
                    ) : (
                        <button className="status-add-cat-btn" onClick={() => setShowAddCat(true)}>
                            <IoAddOutline size={16} /> Agregar categoría principal
                        </button>
                    )}
                </div>

                {/* ── RIGHT: Behavior guide ─────────────────────── */}
                <div className="settings-sla-right">
                    <div className="settings-edit-title"><IoTimeOutline size={18} /> Comportamiento del SLA</div>

                    {BEHAVIORS.map(b => (
                        <div key={b.id} className="sla-config-row">
                            <div className="sla-cat-name">{b.label}</div>
                            <div className="sla-cat-behavior">{b.description}</div>
                        </div>
                    ))}
                    <div className="sla-info-box" style={{ marginTop: 20 }}>
                        <strong>Reglas de los Estados</strong>
                        <ul>
                            <li><strong>Nuevo:</strong> Configura su SLA específico (generalmente para tiempo de asignación o primera respuesta).</li>
                            <li><strong>En Proceso:</strong> El SLA de Resolución (configurado en Prioridades) sigue restando tiempo.</li>
                            <li><strong>En Espera:</strong> El tiempo de SLA de Resolución se pausa. Reanuda al volver a En Proceso.</li>
                            <li><strong>Terminal:</strong> El SLA se congela permanentemente, indicando fin de vida.</li>
                            <li>Los sub-estados heredan el comportamiento de su categoría principal.</li>
                        </ul>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ─── Priority SLA page ────────────────────────────────────────────────────────
function PrioritySlaPage({ config, activeWorkspace, onBack, onRefresh }) {
    const isDesk = activeWorkspace === 'volcan_desk';
    const currentUser = getCurrentUser();
    const isGroupAdminUser = currentUser?.role === 'group_admin';
    const deskGroups = isDesk
        ? getGroups().filter(g => g.modulo === 'volcan_desk' && (!isGroupAdminUser || g.id === currentUser.admin_group_id))
        : [];
    const moduleItems = (config.priorities || []).filter(p => (p.modulo || 'voltik') === activeWorkspace);
    // En Volcán Desk el SLA ahora vive en Categorías (ver CategoriesConfigPage) —
    // aquí solo se administran etiqueta/color de prioridad, sin SLA.
    const pageTitle = isDesk ? 'Prioridades' : 'Prioridades & SLA';
    const pageDesc = isDesk
        ? 'Niveles de urgencia para clasificar y ordenar solicitudes. El SLA se configura por Categoría.'
        : 'Niveles de urgencia y tiempos de resolución (SLA) para los tickets en proceso.';

    const [selectedGroupId, setSelectedGroupId] = useState(isGroupAdminUser ? currentUser.admin_group_id : null);
    const [reassigning, setReassigning] = useState(false);
    const [editingId, setEditingId] = useState(null);
    const [editLabel, setEditLabel] = useState('');
    const [editSlaMinutes, setEditSlaMinutes] = useState(1440);
    const [editColor, setEditColor] = useState('#ff3b30');

    const [showAdd, setShowAdd] = useState(false);
    const [newLabel, setNewLabel] = useState('');
    const [newSlaMinutes, setNewSlaMinutes] = useState(1440);
    const [newColor, setNewColor] = useState('#0066CC');

    const startEdit = (p) => {
        setEditingId(p.id);
        setEditLabel(p.label);
        setEditSlaMinutes(p.slaMinutes ?? 1440);
        setEditColor(p.color || '#ff3b30');
    };

    // El value se usa como llave de búsqueda de SLA/color en toda la app. En Volcán Desk cada
    // grupo tiene su propio catálogo, así que dos grupos pueden nombrar una prioridad igual
    // (ej. "Media") — se sufija con el grupo para que nunca choquen entre sí.
    const slugFor = (label) => {
        const base = label.toLowerCase().replace(/\s+/g, '_');
        return isDesk && selectedGroupId ? `${base}__${selectedGroupId}` : base;
    };

    const saveEdit = (id) => {
        if (!editLabel.trim()) return;
        updateConfigItem('priorities', id, {
            label: editLabel.trim(), color: editColor, value: slugFor(editLabel.trim()),
            ...(isDesk ? {} : { slaMinutes: editSlaMinutes })
        });
        setEditingId(null);
        onRefresh();
    };

    const handleAdd = () => {
        if (!newLabel.trim()) return;
        addConfigItem('priorities', newLabel.trim(), {
            color: newColor,
            value: slugFor(newLabel.trim()),
            modulo: activeWorkspace,
            ...(isDesk ? { grupoId: selectedGroupId } : { slaMinutes: newSlaMinutes }),
        });
        setShowAdd(false);
        setNewLabel('');
        onRefresh();
    };

    const handleDelete = (id) => {
        if(!confirm('¿Eliminar esta prioridad?')) return;
        removeConfigItem('priorities', id);
        onRefresh();
    }

    if (isDesk && reassigning) {
        return (
            <div className="settings-detail-page">
                <div className="settings-detail-header">
                    <button className="settings-back-btn" onClick={onBack}><IoArrowBack size={18} /> Configuración</button>
                    <div className="settings-detail-title-row">
                        <div className="settings-section-icon" style={{ background: '#ff3b3015', color: '#ff3b30' }}><IoFlashOutline size={22} /></div>
                        <div><h1>{pageTitle} — reasignar</h1><p>{pageDesc}</p></div>
                    </div>
                </div>
                <div className="settings-detail-body" style={{ display: 'block' }}>
                    <GroupScopeReassign
                        itemLabelPlural="prioridades"
                        items={moduleItems}
                        groups={deskGroups}
                        getGroupId={i => i.grupoId}
                        getLabel={i => i.label}
                        onAssign={(item, groupId) => { updateConfigItem('priorities', item.id, { grupoId: groupId }); onRefresh(); }}
                        onBack={() => setReassigning(false)}
                    />
                </div>
            </div>
        );
    }

    if (isDesk && !selectedGroupId) {
        return (
            <div className="settings-detail-page">
                <div className="settings-detail-header">
                    <button className="settings-back-btn" onClick={onBack}><IoArrowBack size={18} /> Configuración</button>
                    <div className="settings-detail-title-row">
                        <div className="settings-section-icon" style={{ background: '#ff3b3015', color: '#ff3b30' }}><IoFlashOutline size={22} /></div>
                        <div><h1>{pageTitle}</h1><p>{pageDesc}</p></div>
                    </div>
                </div>
                <div className="settings-detail-body" style={{ display: 'block' }}>
                    <GroupScopePicker
                        itemLabelPlural="prioridades"
                        groups={deskGroups}
                        items={moduleItems}
                        getGroupId={i => i.grupoId}
                        onSelectGroup={setSelectedGroupId}
                        onManageUnassigned={() => setReassigning(true)}
                    />
                </div>
            </div>
        );
    }

    const priorities = isDesk ? moduleItems.filter(p => p.grupoId === selectedGroupId) : moduleItems;

    return (
        <div className="settings-detail-page">
            <div className="settings-detail-header">
                <button className="settings-back-btn" onClick={onBack}><IoArrowBack size={18} /> Configuración</button>
                <div className="settings-detail-title-row">
                    <div className="settings-section-icon" style={{ background: '#ff3b3015', color: '#ff3b30' }}><IoFlashOutline size={22} /></div>
                    <div><h1>Prioridades & SLA</h1><p>Niveles de urgencia y tiempos de resolución (SLA) para los tickets en proceso.</p></div>
                </div>
            </div>
            {isDesk && (
                <div style={{ padding: '0 0 4px' }}>
                    <GroupScopeBreadcrumb
                        groupName={deskGroups.find(g => g.id === selectedGroupId)?.name || '—'}
                        onChangeGroup={() => setSelectedGroupId(null)}
                    />
                </div>
            )}

            <div className="settings-detail-body">
                <div className="settings-edit-panel" style={{ maxWidth: 700 }}>
                    <div className="settings-edit-title">Niveles de Prioridad <span className="settings-count-badge">{priorities.length}</span></div>

                    <div className="settings-items-list" style={{ marginTop: 16 }}>
                        {priorities.map(p => (
                            <div key={p.id} className="status-category-block" style={{ padding: 0, overflow: 'hidden' }}>
                                {editingId === p.id ? (
                                    <div className="status-cat-edit-form" style={{ padding: 12 }}>
                                        <input 
                                            value={editLabel} 
                                            onChange={e => setEditLabel(e.target.value)}
                                            className="settings-inline-input" placeholder="Nombre" style={{ marginBottom: 12 }}
                                        />
                                        <div className="status-edit-row">
                                            <label className="status-edit-field-label">Color</label>
                                            <input type="color" className="color-picker" value={editColor} onChange={e => setEditColor(e.target.value)} />
                                            {!isDesk && (
                                                <>
                                                    <label className="status-edit-field-label">SLA Resolución</label>
                                                    <select
                                                        className="sla-select"
                                                        value={editSlaMinutes}
                                                        onChange={e => setEditSlaMinutes(Number(e.target.value))}
                                                    >
                                                        {SLA_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                                    </select>
                                                </>
                                            )}
                                        </div>
                                        <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
                                            <button className="btn btn-primary btn-sm" onClick={() => saveEdit(p.id)}><IoCheckmarkOutline size={14} /> Guardar</button>
                                            <button className="btn btn-secondary btn-sm" onClick={() => setEditingId(null)}><IoCloseOutline size={14} /> Cancelar</button>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="status-category-header" style={{ borderLeftColor: p.color, borderTop: 0, borderRight: 0, borderBottom: 0, borderRadius: 0, background: 'transparent' }}>
                                        <span className="scb-dot" style={{ background: p.color }} />
                                        <div style={{ flex: 1 }}>
                                            <span className="scb-label" style={{ minWidth: 100, display: 'inline-block' }}>{p.label}</span>
                                            {!isDesk && (
                                                <span className="scb-sla-tag" style={{ marginLeft: 8 }}>
                                                    <IoTimeOutline size={12}/> {SLA_OPTIONS.find(o => o.value === p.slaMinutes)?.label || 'Sin límite'}
                                                </span>
                                            )}
                                        </div>
                                        <button className="settings-icon-btn" onClick={() => startEdit(p)}><IoPencilOutline size={15} /></button>
                                        <button className="settings-icon-btn danger" onClick={() => handleDelete(p.id)}><IoTrashOutline size={15} /></button>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>

                    {showAdd ? (
                        <div className="status-add-block" style={{ marginTop: 24 }}>
                            <div className="settings-edit-title" style={{ marginBottom: 10 }}>Nuevo Nivel de Prioridad</div>
                            <div className="status-add-form">
                                <input className="settings-add-input" style={{ flex: 2 }}
                                    placeholder="Nombre (ej. Crítico)..."
                                    value={newLabel}
                                    onChange={e => setNewLabel(e.target.value)}
                                />
                                <input type="color" className="color-picker" value={newColor} onChange={e => setNewColor(e.target.value)} />
                                {!isDesk && (
                                    <select className="status-cat-select" value={newSlaMinutes} onChange={e => setNewSlaMinutes(Number(e.target.value))}>
                                         {SLA_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                    </select>
                                )}
                                <button className="btn btn-primary btn-sm" onClick={handleAdd} disabled={!newLabel.trim()}>
                                    <IoCheckmarkOutline size={14} /> Agregar
                                </button>
                                <button className="btn btn-secondary btn-sm" onClick={() => setShowAdd(false)}>
                                    <IoCloseOutline size={14} />
                                </button>
                            </div>
                        </div>
                    ) : (
                        <button className="status-add-cat-btn" style={{ marginTop: 24 }} onClick={() => setShowAdd(true)}>
                            <IoAddOutline size={16} /> Agregar Nivel de Prioridad
                        </button>
                    )}

                </div>
            </div>
        </div>
    );
}

// ─── Categorías (solo Volcán Desk): vinculadas a un Tipo, con SLA propio ──────
// Cada categoría se crea ligada a un único Tipo del mismo grupo — el SLA general
// de "Prioridades & SLA" ya no aplica en Volcán Desk, cada combinación Tipo+
// Categoría define su propio SLA aquí. Sin SLA configurado ⇒ el ticket nunca se
// marca en riesgo/vencido (ver computeSlaStatus en ticketService.js).
function CategoriesConfigPage({ config, activeWorkspace, onBack, onRefresh }) {
    const currentUser = getCurrentUser();
    const isGroupAdminUser = currentUser?.role === 'group_admin';
    const deskGroups = getGroups().filter(g => g.modulo === 'volcan_desk' && (!isGroupAdminUser || g.id === currentUser.admin_group_id));
    const moduleItems = (config.categories || []).filter(c => (c.modulo || 'voltik') === activeWorkspace);
    const moduleTypes = (config.types || []).filter(t => (t.modulo || 'voltik') === activeWorkspace);

    const [selectedGroupId, setSelectedGroupId] = useState(isGroupAdminUser ? currentUser.admin_group_id : null);
    const [reassigning, setReassigning] = useState(false);
    const [editingId, setEditingId] = useState(null);
    const [editLabel, setEditLabel] = useState('');
    const [editTipoId, setEditTipoId] = useState('');
    const [editSla, setEditSla] = useState('');

    const [newLabel, setNewLabel] = useState('');
    const [newTipoId, setNewTipoId] = useState('');
    const [newSla, setNewSla] = useState('');

    const startEdit = (c) => {
        setEditingId(c.id);
        setEditLabel(c.label);
        setEditTipoId(c.tipoId || '');
        setEditSla(c.slaMinutes ?? '');
    };

    const saveEdit = (id) => {
        if (!editLabel.trim() || !editTipoId) return;
        updateConfigItem('categories', id, {
            label: editLabel.trim(),
            tipoId: editTipoId,
            slaMinutes: editSla === '' ? null : Number(editSla)
        });
        setEditingId(null);
        onRefresh();
    };

    const handleAdd = () => {
        if (!newLabel.trim() || !newTipoId) return;
        addConfigItem('categories', newLabel.trim(), {
            tipoId: newTipoId,
            slaMinutes: newSla === '' ? null : Number(newSla),
            modulo: activeWorkspace,
            grupoId: selectedGroupId
        });
        setShowAdd(false);
        setNewLabel('');
        setNewTipoId('');
        setNewSla('');
        onRefresh();
    };

    const handleDelete = (id) => {
        if (!window.confirm('¿Eliminar esta categoría?')) return;
        removeConfigItem('categories', id);
        onRefresh();
    };

    if (reassigning) {
        return (
            <div className="settings-detail-page">
                <div className="settings-detail-header">
                    <button className="settings-back-btn" onClick={onBack}><IoArrowBack size={18} /> Configuración</button>
                    <div className="settings-detail-title-row">
                        <div className="settings-section-icon" style={{ background: '#34c75918', color: '#34c759' }}><IoFolderOutline size={22} /></div>
                        <div><h1>Categorías — reasignar</h1><p>Clasificación por área o producto.</p></div>
                    </div>
                </div>
                <div className="settings-detail-body" style={{ display: 'block' }}>
                    <GroupScopeReassign
                        itemLabelPlural="categorías"
                        items={moduleItems}
                        groups={deskGroups}
                        getGroupId={i => i.grupoId}
                        getLabel={i => i.label}
                        onAssign={(item, groupId) => { updateConfigItem('categories', item.id, { grupoId: groupId }); onRefresh(); }}
                        onBack={() => setReassigning(false)}
                    />
                </div>
            </div>
        );
    }

    if (!selectedGroupId) {
        return (
            <div className="settings-detail-page">
                <div className="settings-detail-header">
                    <button className="settings-back-btn" onClick={onBack}><IoArrowBack size={18} /> Configuración</button>
                    <div className="settings-detail-title-row">
                        <div className="settings-section-icon" style={{ background: '#34c75918', color: '#34c759' }}><IoFolderOutline size={22} /></div>
                        <div><h1>Categorías</h1><p>Clasificación por área o producto, ligada a un Tipo. El SLA de cada solicitud sale de aquí.</p></div>
                    </div>
                </div>
                <div className="settings-detail-body" style={{ display: 'block' }}>
                    <GroupScopePicker
                        itemLabelPlural="categorías"
                        groups={deskGroups}
                        items={moduleItems}
                        getGroupId={i => i.grupoId}
                        onSelectGroup={setSelectedGroupId}
                        onManageUnassigned={() => setReassigning(true)}
                    />
                </div>
            </div>
        );
    }

    const categories = moduleItems.filter(c => c.grupoId === selectedGroupId);
    const groupTypes = moduleTypes.filter(t => t.grupoId === selectedGroupId);
    const slaLabel = (mins) => mins === null || mins === undefined ? 'Sin configurar' : (SLA_OPTIONS.find(o => o.value === mins)?.label || `${mins} min`);
    const tipoLabel = (tipoId) => groupTypes.find(t => t.id === tipoId)?.label || moduleTypes.find(t => t.id === tipoId)?.label || 'Tipo desconocido';

    return (
        <div className="settings-detail-page">
            <div className="settings-detail-header">
                <button className="settings-back-btn" onClick={onBack}><IoArrowBack size={18} /> Configuración</button>
                <div className="settings-detail-title-row">
                    <div className="settings-section-icon" style={{ background: '#34c75918', color: '#34c759' }}><IoFolderOutline size={22} /></div>
                    <div><h1>Categorías</h1><p>Clasificación por área o producto, ligada a un Tipo. El SLA de cada solicitud sale de aquí.</p></div>
                </div>
            </div>
            <div style={{ padding: '0 0 4px' }}>
                <GroupScopeBreadcrumb
                    groupName={deskGroups.find(g => g.id === selectedGroupId)?.name || '—'}
                    onChangeGroup={() => setSelectedGroupId(null)}
                />
            </div>

            {/* Tope de pausa por Bloqueo ("Stop SLA") — cada grupo configura el propio.
                Sin tope = pausa indefinida (comportamiento de siempre). Con tope, pasado
                ese tiempo el SLA vuelve a correr solo aunque el ticket siga Bloqueado. */}
            <div className="sla-info-box" style={{ margin: '0 0 16px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <IoTimeOutline size={15} />
                <span><strong>Tope de pausa (Stop SLA)</strong> para {deskGroups.find(g => g.id === selectedGroupId)?.name}:</span>
                <select
                    className="status-cat-select"
                    value={config.groupBloqueoCaps?.[selectedGroupId] ?? ''}
                    onChange={e => { updateGroupBloqueoCap(selectedGroupId, e.target.value === '' ? null : Number(e.target.value)); onRefresh(); }}
                >
                    <option value="">Sin tope (pausa indefinida)</option>
                    {BLOQUEO_CAP_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
            </div>

            <div className="settings-detail-body">
                <div className="settings-preview-panel">
                    <div className="settings-preview-title">Vista Previa</div>
                    <p className="settings-preview-subtitle">Así se verán estas opciones al crear una solicitud:</p>
                    <div className="settings-preview-dropdown">
                        <div className="spd-label">-- Seleccionar Categoría --</div>
                        {categories.map(item => (
                            <div key={item.id} className="spd-option">{item.label}</div>
                        ))}
                        {categories.length === 0 && <div className="spd-empty">Sin opciones todavía</div>}
                    </div>
                </div>
                <div className="settings-edit-panel">
                    <div className="settings-edit-title">Opciones actuales <span className="settings-count-badge">{categories.length}</span></div>

                    {groupTypes.length === 0 && (
                        <div className="sla-info-box" style={{ marginTop: 12 }}>
                            Este grupo todavía no tiene Tipos de Ticket. Crea al menos uno en "Tipos de Ticket" antes de poder agregar categorías.
                        </div>
                    )}

                    <div className="settings-items-list">
                        {categories.map(c => (
                            <div key={c.id} className="settings-item-row" style={{ flexWrap: 'wrap', rowGap: 6 }}>
                                {editingId === c.id ? (
                                    <>
                                        <input value={editLabel} onChange={e => setEditLabel(e.target.value)}
                                            onKeyDown={e => { if (e.key === 'Enter') saveEdit(c.id); if (e.key === 'Escape') setEditingId(null); }}
                                            autoFocus className="settings-inline-input" style={{ flex: '1 1 140px' }} />
                                        <select className="status-cat-select" value={editTipoId} onChange={e => setEditTipoId(e.target.value)}>
                                            <option value="">-- Tipo --</option>
                                            {groupTypes.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                                        </select>
                                        <select className="sla-select" value={editSla} onChange={e => setEditSla(e.target.value)}>
                                            <option value="">Sin configurar</option>
                                            {SLA_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                        </select>
                                        <button className="btn btn-primary btn-sm" onClick={() => saveEdit(c.id)} disabled={!editLabel.trim() || !editTipoId} style={{ padding: '4px 10px' }}><IoCheckmarkOutline size={14} /></button>
                                        <button className="btn btn-secondary btn-sm" onClick={() => setEditingId(null)} style={{ padding: '4px 10px' }}><IoCloseOutline size={14} /></button>
                                    </>
                                ) : (
                                    <>
                                        <span className="settings-item-label">{c.label}</span>
                                        <span className="scb-behavior-tag" style={{ background: '#34c75918', color: '#34c759' }}>
                                            {tipoLabel(c.tipoId)}
                                        </span>
                                        <span className="scb-sla-tag">
                                            <IoTimeOutline size={12}/> {slaLabel(c.slaMinutes)}
                                        </span>
                                        <button className="settings-icon-btn" onClick={() => startEdit(c)}><IoPencilOutline size={15} /></button>
                                        <button className="settings-icon-btn danger" onClick={() => handleDelete(c.id)}><IoTrashOutline size={15} /></button>
                                    </>
                                )}
                            </div>
                        ))}
                        {categories.length === 0 && <div className="settings-empty-state">Sin categorías. Agrega una abajo.</div>}
                    </div>

                    <div className="settings-add-row" style={{ flexWrap: 'wrap', rowGap: 6 }}>
                        <input value={newLabel} onChange={e => setNewLabel(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
                            placeholder="Nueva categoría..." className="settings-add-input" style={{ flex: '1 1 160px' }} />
                        <select className="status-cat-select" value={newTipoId} onChange={e => setNewTipoId(e.target.value)} disabled={groupTypes.length === 0}>
                            <option value="">-- Tipo --</option>
                            {groupTypes.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                        </select>
                        <select className="status-cat-select" value={newSla} onChange={e => setNewSla(e.target.value)}>
                            <option value="">Sin configurar</option>
                            {SLA_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                        <button className="btn btn-primary btn-sm" onClick={handleAdd} disabled={!newLabel.trim() || !newTipoId}><IoAddOutline size={16} /> Agregar</button>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ─── Notificaciones por correo (Volcán Desk, agregado 2026-08-27) ────────────
// 4 interruptores independientes por grupo — NO es un módulo general on/off: cada
// grupo decide por su cuenta cuáles de estos 4 escenarios le disparan correo (a
// pedido explícito del usuario). admin general elige el grupo primero (igual que
// Tipos/Categorías/Prioridades); group_admin ya tiene su único grupo preseleccionado
// y nunca ve el selector ni el de ningún otro grupo.
const EMAIL_EVENTS = [
    { key: 'nuevoTicketAsignado', label: 'Ticket nuevo asignado a un agente', description: 'Cuando un ticket nace ya con un responsable, se le avisa por correo a esa persona.' },
    { key: 'nuevoTicketSinAsignar', label: 'Ticket nuevo sin asignar', description: 'Cuando un ticket cae a la bandeja del grupo sin responsable, se avisa a todo el grupo (group_admin, agentes y supervisores).' },
    { key: 'respuestaSolicitante', label: 'El solicitante responde', description: 'Avisa al responsable del ticket cuando el solicitante agrega un comentario público (no notas privadas).' },
    { key: 'respuestaResolutor', label: 'El resolutor responde', description: 'Avisa al solicitante cuando alguien del grupo resolutor agrega un comentario público (no notas privadas).' },
];

function EmailNotificationsConfigPage({ onBack }) {
    const currentUser = getCurrentUser();
    const isGroupAdminUser = currentUser?.role === 'group_admin';
    const deskGroups = getGroups().filter(g => g.modulo === 'volcan_desk' && (!isGroupAdminUser || g.id === currentUser.admin_group_id));
    const [selectedGroupId, setSelectedGroupId] = useState(isGroupAdminUser ? currentUser.admin_group_id : null);
    // Snapshot local de settings por grupo — se refresca leyendo configService tras
    // cada cambio, igual que el resto de las páginas de esta sección.
    const [settings, setSettings] = useState(() => getGroupEmailNotificationSettings(selectedGroupId));
    const [savingKey, setSavingKey] = useState(null);

    const groupName = deskGroups.find(g => g.id === selectedGroupId)?.name || '';
    const isEnabled = (key) => settings[key] !== false; // default ON hasta que se apague explícitamente

    const handleToggle = async (key) => {
        const nextValue = !isEnabled(key);
        setSavingKey(key);
        try {
            await updateGroupEmailNotificationSetting(selectedGroupId, key, nextValue);
            setSettings(getGroupEmailNotificationSettings(selectedGroupId));
        } catch (err) {
            console.error('Error al actualizar la notificación:', err);
            alert('No se pudo guardar el cambio. Intenta de nuevo.');
        } finally {
            setSavingKey(null);
        }
    };

    if (!selectedGroupId) {
        return (
            <div className="settings-detail-page">
                <div className="settings-detail-header">
                    <button className="settings-back-btn" onClick={onBack}><IoArrowBack size={18} /> Configuración</button>
                    <div className="settings-detail-title-row">
                        <div className="settings-section-icon" style={{ background: '#0891b218', color: '#0891b2' }}><IoMailOutline size={22} /></div>
                        <div><h1>Notificaciones por correo</h1><p>Elige qué correos automáticos recibe cada grupo.</p></div>
                    </div>
                </div>
                <div className="settings-detail-body" style={{ display: 'block' }}>
                    <div className="gsg-picker">
                        <p className="gsg-picker-hint">Elige un grupo de soporte para configurar sus notificaciones. Cada grupo decide por su cuenta.</p>
                        <div className="gsg-group-grid">
                            {deskGroups.map(g => (
                                <button key={g.id} className="gsg-group-card" onClick={() => { setSelectedGroupId(g.id); setSettings(getGroupEmailNotificationSettings(g.id)); }}>
                                    <div className="gsg-group-icon"><IoPeopleOutline size={18} /></div>
                                    <div className="gsg-group-body"><div className="gsg-group-name">{g.name}</div></div>
                                    <IoChevronForwardOutline size={16} className="gsg-group-arrow" />
                                </button>
                            ))}
                            {deskGroups.length === 0 && (
                                <div className="gsg-empty">No hay grupos de soporte creados todavía para Volcán Desk.</div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="settings-detail-page">
            <div className="settings-detail-header">
                <button className="settings-back-btn" onClick={onBack}><IoArrowBack size={18} /> Configuración</button>
                <div className="settings-detail-title-row">
                    <div className="settings-section-icon" style={{ background: '#0891b218', color: '#0891b2' }}><IoMailOutline size={22} /></div>
                    <div><h1>Notificaciones por correo</h1><p>Elige qué correos automáticos recibe cada grupo.</p></div>
                </div>
            </div>
            <div className="settings-detail-body" style={{ display: 'block' }}>
                {!isGroupAdminUser && (
                    <GroupScopeBreadcrumb groupName={groupName} onChangeGroup={() => setSelectedGroupId(null)} />
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
                    {EMAIL_EVENTS.map(ev => (
                        <div key={ev.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '14px 18px' }}>
                            <div>
                                <div style={{ fontWeight: 600, fontSize: '0.92rem', color: '#1e293b' }}>{ev.label}</div>
                                <div style={{ fontSize: '0.8rem', color: '#64748b', marginTop: 2 }}>{ev.description}</div>
                            </div>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: savingKey === ev.key ? 'wait' : 'pointer', flexShrink: 0 }}>
                                <input
                                    type="checkbox"
                                    checked={isEnabled(ev.key)}
                                    disabled={savingKey === ev.key}
                                    onChange={() => handleToggle(ev.key)}
                                    style={{ width: 18, height: 18, cursor: 'inherit' }}
                                />
                                <span style={{ fontSize: '0.82rem', fontWeight: 600, color: isEnabled(ev.key) ? '#16a34a' : '#94a3b8', minWidth: 60 }}>
                                    {isEnabled(ev.key) ? 'Activado' : 'Apagado'}
                                </span>
                            </label>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

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
            onAdd={handleAdd} onRemove={handleRemove} onUpdate={handleUpdate}
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
                    const allItems = section.key === 'emailNotifications'
                        ? []
                        : section.special
                            ? (section.key === 'statuses' ? config.statusCategories || [] : config.priorities || [])
                            : (config[section.key] || []);
                    const items = allItems.filter(i => (i.modulo || 'voltik') === activeWorkspace);
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
