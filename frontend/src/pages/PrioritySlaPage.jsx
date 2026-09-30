import { useState } from 'react';
import { IoArrowBack, IoFlashOutline, IoCheckmarkOutline, IoCloseOutline, IoTimeOutline, IoPencilOutline, IoTrashOutline, IoAddOutline } from 'react-icons/io5';
import { addConfigItem, removeConfigItem, updateConfigItem } from '../services/configService';
import { getGroups } from '../services/groupService';
import { getCurrentUser } from '../services/authService';
import { GroupScopePicker, GroupScopeReassign, GroupScopeBreadcrumb } from '../components/GroupScopeGate';
import { SLA_OPTIONS } from './settingsConstants';


// ─── Priority SLA page ────────────────────────────────────────────────────────
export default function PrioritySlaPage({ config, activeWorkspace, onBack, onRefresh }) {
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
