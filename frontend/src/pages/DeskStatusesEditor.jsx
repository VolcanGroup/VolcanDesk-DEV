import { useState } from 'react';
import { IoArrowBack, IoRefreshCircleOutline, IoLockClosedOutline, IoCheckmarkOutline, IoCloseOutline, IoPencilOutline, IoTrashOutline, IoAddOutline, IoTimeOutline } from 'react-icons/io5';
import { BEHAVIORS, INTERNAL_STATUSES, addDeskSubStatus, removeDeskSubStatus, updateDeskSubStatus } from '../services/configService';


// ─── Volcán Desk: estados fijos + subestados editables ────────────────────────
// Los 5 estados principales (INTERNAL_STATUSES) son fijos en código a propósito
// — filtros, columnas por vista y SLA en toda la app dependen de esos ids exactos
// (to_do/on_going/...). Los SUBESTADOS (lo que sale en "Etiquetas" del ticket) sí
// se pueden agregar/renombrar/quitar aquí; se guardan en config.deskSubStatuses y
// getEtiquetaOptionsForStatus() los lee en vivo, así que un cambio aquí se refleja
// de inmediato en el dropdown "Etiquetas" del detalle de la solicitud.
export default function DeskStatusesEditor({ config, onBack, onRefresh }) {
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
