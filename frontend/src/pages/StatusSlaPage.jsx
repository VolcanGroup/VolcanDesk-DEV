import { useState } from 'react';
import { IoArrowBack, IoRefreshCircleOutline, IoTimeOutline, IoCheckmarkOutline, IoCloseOutline, IoPencilOutline, IoTrashOutline, IoAddOutline } from 'react-icons/io5';
import { BEHAVIORS, addStatusCategory, removeStatusCategory, updateStatusCategory, addSubStatus, removeSubStatus, updateSubStatus, updateNewSla, updateCategorySla } from '../services/configService';
import { SLA_OPTIONS } from './settingsConstants';
import DeskStatusesEditor from './DeskStatusesEditor';


// ─── Status & SLA page ────────────────────────────────────────────────────────
export default function StatusSlaPage({ config, activeWorkspace, onBack, onRefresh }) {
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
