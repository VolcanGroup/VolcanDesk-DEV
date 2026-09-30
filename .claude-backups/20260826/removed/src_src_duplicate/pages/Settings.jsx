import React, { useState } from 'react';
import {
    IoArrowBack, IoAddOutline, IoTrashOutline, IoPencilOutline,
    IoCheckmarkOutline, IoCloseOutline, IoChevronForwardOutline,
    IoTicketOutline, IoPeopleOutline, IoFolderOutline,
    IoRefreshCircleOutline, IoFlashOutline, IoTimeOutline,
    IoStarOutline, IoListOutline, IoAppsOutline, IoLockClosedOutline,
} from 'react-icons/io5';
import {
    getConfig, addConfigItem, removeConfigItem, updateConfigItem,
    BEHAVIORS, INTERNAL_STATUSES,
    addStatusCategory, removeStatusCategory, updateStatusCategory,
    addSubStatus, removeSubStatus, updateSubStatus,
    addDeskSubStatus, removeDeskSubStatus, updateDeskSubStatus,
    updateNewSla, updateCategorySla, updateBrandName,
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
        updateConfigItem('priorities', id, { label: editLabel.trim(), slaMinutes: editSlaMinutes, color: editColor, value: slugFor(editLabel.trim()) });
        setEditingId(null);
        onRefresh();
    };

    const handleAdd = () => {
        if (!newLabel.trim()) return;
        addConfigItem('priorities', newLabel.trim(), {
            slaMinutes: newSlaMinutes, color: newColor,
            value: slugFor(newLabel.trim()),
            modulo: activeWorkspace,
            ...(isDesk ? { grupoId: selectedGroupId } : {}),
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
                        <div><h1>Prioridades & SLA — reasignar</h1><p>Niveles de urgencia y tiempos de resolución (SLA).</p></div>
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
                        <div><h1>Prioridades & SLA</h1><p>Niveles de urgencia y tiempos de resolución (SLA) para los tickets en proceso.</p></div>
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
                                            <label className="status-edit-field-label">SLA Resolución</label>
                                            <select 
                                                className="sla-select" 
                                                value={editSlaMinutes}
                                                onChange={e => setEditSlaMinutes(Number(e.target.value))}
                                            >
                                                {SLA_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                            </select>
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
                                            <span className="scb-sla-tag" style={{ marginLeft: 8 }}>
                                                <IoTimeOutline size={12}/> {SLA_OPTIONS.find(o => o.value === p.slaMinutes)?.label || 'Sin límite'}
                                            </span>
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
                                <select className="status-cat-select" value={newSlaMinutes} onChange={e => setNewSlaMinutes(Number(e.target.value))}>
                                     {SLA_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </select>
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
    const visibleSections = isGroupAdmin
        ? BASE_SECTIONS.filter(s => s.key !== 'statuses')
        : BASE_SECTIONS;

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
                    const allItems = section.special
                        ? (section.key === 'statuses' ? config.statusCategories || [] : config.priorities || [])
                        : (config[section.key] || []);
                    const items = allItems.filter(i => (i.modulo || 'voltik') === activeWorkspace);
                    const Icon = section.icon;
                    return (
                        <button key={section.key} className="settings-hub-card" onClick={() => setActiveSection(section)}>
                            <div className="shc-icon" style={{ background: `${section.color}15`, color: section.color }}><Icon size={24} /></div>
                            <div className="shc-body">
                                <div className="shc-label">{section.label}</div>
                                <div className="shc-desc">{section.description}</div>
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
