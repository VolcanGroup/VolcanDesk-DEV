import { useState, useEffect } from 'react';
import { IoArrowBack, IoFolderOutline, IoTimeOutline, IoSwapVerticalOutline, IoCheckmarkOutline, IoCloseOutline, IoPencilOutline, IoTrashOutline, IoAddOutline } from 'react-icons/io5';
import { getConfig, addConfigItem, removeConfigItem, updateConfigItem, reorderConfigItems, updateGroupBloqueoCap } from '../services/configService';
import { getGroups } from '../services/groupService';
import { getReglasFlujo } from '../services/flowService';
import { getCurrentUser } from '../services/authService';
import { GroupScopePicker, GroupScopeReassign, GroupScopeBreadcrumb } from '../components/GroupScopeGate';
import { SLA_OPTIONS, BLOQUEO_CAP_OPTIONS } from './settingsConstants';


// ─── Categorías (solo Volcán Desk): vinculadas a un Tipo, con SLA propio ──────
// Cada categoría se crea ligada a un único Tipo del mismo grupo — el SLA general
// de "Prioridades & SLA" ya no aplica en Volcán Desk, cada combinación Tipo+
// Categoría define su propio SLA aquí. Sin SLA configurado ⇒ el ticket nunca se
// marca en riesgo/vencido (ver computeSlaStatus en ticketService.js).
export default function CategoriesConfigPage({ config, activeWorkspace, onBack, onRefresh }) {
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
    // Confirmación visual de que "Agregar" sí funcionó — reportado en vivo
    // 2026-09-08: sin ningún feedback, un usuario que agregó una categoría no
    // vio cambiar nada en pantalla (bug real aparte, ver handleAdd) y volvió a
    // hacer click repetidas veces pensando que no había pasado nada, generando
    // 9 duplicados idénticos en el catálogo real antes de notarlo.
    const [justAddedId, setJustAddedId] = useState(null);

    // Reglas de Flujo cargadas aparte (viven en su propia tabla, no en este
    // blob de Config) — solo para el aviso de "categoría en uso" de abajo, el
    // backend (POST /api/config) es quien de verdad lo bloquea si esto llegara
    // a estar desactualizado (2026-09-16, a pedido del usuario).
    const [reglasFlujo, setReglasFlujo] = useState([]);
    useEffect(() => {
        getReglasFlujo().then(setReglasFlujo).catch(() => {});
    }, []);

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
        // Bug real corregido 2026-09-08: esta línea llamaba a setShowAdd(false),
        // una variable que no existe en este componente (pertenece a
        // PrioritiesConfigPage, copiada por error) — lanzaba un ReferenceError
        // que interrumpía todo lo que seguía (limpiar el formulario, refrescar
        // la lista), aunque addConfigItem ya había guardado la categoría. El
        // usuario no veía ningún cambio y volvía a hacer click, duplicando la
        // categoría cada vez.
        addConfigItem('categories', newLabel.trim(), {
            tipoId: newTipoId,
            slaMinutes: newSla === '' ? null : Number(newSla),
            modulo: activeWorkspace,
            grupoId: selectedGroupId
        });
        const updated = getConfig();
        const added = updated.categories[updated.categories.length - 1];
        setNewLabel('');
        setNewTipoId('');
        setNewSla('');
        onRefresh();
        if (added) {
            setJustAddedId(added.id);
            setTimeout(() => setJustAddedId(current => current === added.id ? null : current), 2500);
        }
    };

    const handleDelete = (id) => {
        // Aviso inmediato en cliente — el backend (POST /api/config) es quien
        // de verdad lo bloquea si `reglasFlujo` llegara a estar desactualizado
        // (2026-09-16, a pedido del usuario, tras encontrar en vivo una regla
        // huérfana de una categoría ya borrada). Una regla INACTIVA no cuenta
        // — inactivarla es la forma de "liberar" la categoría para borrarla.
        const blocking = reglasFlujo.find(r => r.categoria_id === id && r.activo !== false);
        if (blocking) {
            const tipoLabel = moduleTypes.find(t => t.id === blocking.tipo_id)?.label || 'un Tipo';
            alert(`No puedes eliminar esta categoría — todavía tiene una Regla de Flujo activa (Tipo: ${tipoLabel}). Inactívala o bórrala primero en Flujos de Ticket.`);
            return;
        }
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

    // Ordenar A-Z (2026-09-08) — mismo criterio que GenericSectionPage: solo
    // reordena las categorías del grupo actualmente seleccionado, sin tocar
    // las de otros grupos que viven en el mismo config.categories.
    const handleSortAlpha = () => {
        const full = config.categories || [];
        const inScope = (c) => (c.modulo || 'voltik') === activeWorkspace && c.grupoId === selectedGroupId;
        const sortedScoped = full.filter(inScope).slice().sort((a, b) => a.label.localeCompare(b.label, 'es', { sensitivity: 'base' }));
        let cursor = 0;
        const reordered = full.map(c => inScope(c) ? sortedScoped[cursor++] : c);
        reorderConfigItems('categories', reordered);
        onRefresh();
    };

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
                    <div className="settings-edit-title">
                        Opciones actuales <span className="settings-count-badge">{categories.length}</span>
                        {categories.length > 1 && (
                            <button className="settings-sort-btn" onClick={handleSortAlpha} title="Ordenar alfabéticamente">
                                <IoSwapVerticalOutline size={14} /> Ordenar A-Z
                            </button>
                        )}
                    </div>

                    {groupTypes.length === 0 && (
                        <div className="sla-info-box" style={{ marginTop: 12 }}>
                            Este grupo todavía no tiene Tipos de Ticket. Crea al menos uno en "Tipos de Ticket" antes de poder agregar categorías.
                        </div>
                    )}

                    <div className="settings-items-list">
                        {categories.map(c => (
                            <div key={c.id}
                                ref={el => { if (c.id === justAddedId && el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }}
                                className={`settings-item-row ${c.id === justAddedId ? 'just-added' : ''}`}
                                style={{ flexWrap: 'wrap', rowGap: 6 }}>
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
