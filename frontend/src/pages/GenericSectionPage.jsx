import { useState } from 'react';
import { IoArrowBack, IoSwapVerticalOutline, IoCheckmarkOutline, IoCloseOutline, IoPencilOutline, IoTrashOutline, IoAddOutline } from 'react-icons/io5';
import { getGroups } from '../services/groupService';
import { getCurrentUser } from '../services/authService';
import { GroupScopePicker, GroupScopeReassign, GroupScopeBreadcrumb } from '../components/GroupScopeGate';


// ─── Generic section detail ───────────────────────────────────────────────────
export default function GenericSectionPage({ section, config, activeWorkspace, onBack, onAdd, onRemove, onUpdate, onReorder }) {
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

    // Ordenar A-Z (2026-09-08, a pedido del usuario): el catálogo se agrega
    // siempre al final ("Agregar" añade al final del array) — sin esto, algo
    // que empieza con "A" agregado después de una lista larga quedaba hasta
    // abajo para siempre, sin forma de reordenar. Solo reordena los items
    // dentro del mismo alcance visible ahora mismo (módulo + grupo si aplica)
    // — los de otros grupos/módulos, en el mismo array de config, no se tocan.
    const handleSortAlpha = () => {
        const full = config[section.key] || [];
        const inScope = (it) => (it.modulo || 'voltik') === activeWorkspace && (!isDesk || it.grupoId === selectedGroupId);
        const sortedScoped = full.filter(inScope).slice().sort((a, b) => a.label.localeCompare(b.label, 'es', { sensitivity: 'base' }));
        let cursor = 0;
        const reordered = full.map(it => inScope(it) ? sortedScoped[cursor++] : it);
        onReorder(section.key, reordered);
    };

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
                    <div className="settings-edit-title">
                        Opciones actuales <span className="settings-count-badge">{items.length}</span>
                        {items.length > 1 && (
                            <button className="settings-sort-btn" onClick={handleSortAlpha} title="Ordenar alfabéticamente">
                                <IoSwapVerticalOutline size={14} /> Ordenar A-Z
                            </button>
                        )}
                    </div>
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
                    {section.locked && <p className="settings-locked-note">Los elementos no pueden eliminarse, solo renombrarse.</p>}
                </div>
            </div>
        </div>
    );
}
