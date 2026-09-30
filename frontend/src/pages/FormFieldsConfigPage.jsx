import React, { useState, useEffect } from 'react';
import {
    IoArrowBack, IoAppsOutline,
    IoAddOutline, IoPencilOutline, IoTrashOutline, IoCheckmarkOutline, IoCloseOutline, IoRemoveOutline,
} from 'react-icons/io5';
import { FORM_FIELD_DEFS, getFormFields, setFormFieldEnabled } from '../services/configService';
import {
    getCamposCatalogo, createCampoCatalogo, updateCampoCatalogo, deleteCampoCatalogo,
} from '../services/flowService';
import { getGroups } from '../services/groupService';
import { getCurrentUser } from '../services/authService';
import { GroupScopePicker, GroupScopeReassign, GroupScopeBreadcrumb } from '../components/GroupScopeGate';
import './FlowsConfigPage.css';

export default function FormFieldsConfigPage({ activeWorkspace, onBack, onRefresh }) {
    const enabled = getFormFields(activeWorkspace);
    const moduleLabel = activeWorkspace === 'volcan_desk' ? 'Volcán Desk' : 'Voltik';
    const isDesk = activeWorkspace === 'volcan_desk';
    const currentUser = getCurrentUser();
    const isGroupAdminUser = currentUser?.role === 'group_admin';
    const deskGroups = isDesk
        ? getGroups().filter(g => g.modulo === 'volcan_desk' && (!isGroupAdminUser || g.id === currentUser.admin_group_id))
        : [];

    const [moduleCampos, setModuleCampos] = useState([]);
    // group_admin salta el picker: ya tiene su único grupo preseleccionado.
    const [selectedGroupId, setSelectedGroupId] = useState(isGroupAdminUser ? currentUser.admin_group_id : null);
    const [reassigning, setReassigning] = useState(false);
    const [showModal, setShowModal] = useState(false);
    const [editing, setEditing] = useState(null);
    const [form, setForm] = useState({ nombre: '', tipo_dato: 'texto', opciones: '', formato: '', obligatorio: false });

    const loadBaseCampos = () => {
        getCamposCatalogo()
            .then(list => setModuleCampos((list || []).filter(c => c.scope === 'base' && (c.modulo || 'voltik') === activeWorkspace)))
            .catch(() => setModuleCampos([]));
    };

    useEffect(() => { loadBaseCampos(); }, [activeWorkspace]);

    const baseCampos = isDesk ? moduleCampos.filter(c => c.grupo_id === selectedGroupId) : moduleCampos;

    const toggleNative = (key, checked) => {
        setFormFieldEnabled(activeWorkspace, key, checked);
        onRefresh();
    };

    const openCreate = () => {
        setEditing(null);
        setForm({ nombre: '', tipo_dato: 'texto', opciones: '', formato: '', obligatorio: false });
        setShowModal(true);
    };

    const openEdit = (c) => {
        setEditing(c);
        setForm({
            nombre: c.nombre,
            tipo_dato: c.tipo_dato,
            opciones: Array.isArray(c.opciones) ? c.opciones.join(', ') : '',
            formato: c.formato || '',
            obligatorio: !!c.obligatorio,
        });
        setShowModal(true);
    };

    const handleSave = async (e) => {
        e.preventDefault();
        if (!form.nombre.trim()) return;
        const payload = {
            nombre: form.nombre.trim(),
            tipo_dato: form.tipo_dato,
            opciones: form.tipo_dato === 'select' ? form.opciones.split(',').map(o => o.trim()).filter(Boolean) : null,
            formato: form.formato.trim() || null,
            obligatorio: form.obligatorio,
            scope: 'base',
            modulo: activeWorkspace,
            orden: editing ? editing.orden : baseCampos.length + 1,
            ...(isDesk ? { grupo_id: selectedGroupId } : {}),
        };
        try {
            if (editing) {
                await updateCampoCatalogo(editing.id, payload);
            } else {
                await createCampoCatalogo(payload);
            }
            setShowModal(false);
            loadBaseCampos();
        } catch (error) {
            alert('Error al guardar el campo: ' + error.message);
        }
    };

    const handleDelete = async (c) => {
        if (!window.confirm(`¿Eliminar el campo "${c.nombre}"? Ya no aparecerá en el formulario.`)) return;
        try {
            await deleteCampoCatalogo(c.id);
            loadBaseCampos();
        } catch (error) {
            alert('Error al eliminar campo: ' + error.message);
        }
    };

    const assignGroup = async (campo, groupId) => {
        try {
            await updateCampoCatalogo(campo.id, { grupo_id: groupId });
            loadBaseCampos();
        } catch (error) {
            alert('Error al reasignar el campo: ' + error.message);
        }
    };

    if (isDesk && reassigning) {
        return (
            <div className="flow-config-container">
                <div className="flow-header">
                    <button className="flow-back-btn" onClick={onBack}><IoArrowBack size={20} /> Volver a Configuración</button>
                    <div style={{ marginTop: 12 }}>
                        <h1>Campos del Formulario — {moduleLabel} — reasignar</h1>
                    </div>
                </div>
                <div className="flow-content">
                    <GroupScopeReassign
                        itemLabelPlural="campos"
                        items={moduleCampos}
                        groups={deskGroups}
                        getGroupId={c => c.grupo_id}
                        getLabel={c => c.nombre}
                        onAssign={assignGroup}
                        onBack={() => setReassigning(false)}
                    />
                </div>
            </div>
        );
    }

    if (isDesk && !selectedGroupId) {
        return (
            <div className="flow-config-container">
                <div className="flow-header">
                    <button className="flow-back-btn" onClick={onBack}><IoArrowBack size={20} /> Volver a Configuración</button>
                    <div style={{ marginTop: 12 }}>
                        <h1>Campos del Formulario — {moduleLabel}</h1>
                        <p>Elige el grupo de soporte cuyos campos vas a administrar. Los campos de sistema (Tipo, Grupo, Prioridad, etc.) siguen siendo compartidos.</p>
                    </div>
                </div>
                <div className="flow-content">
                    <GroupScopePicker
                        itemLabelPlural="campos"
                        groups={deskGroups}
                        items={moduleCampos}
                        getGroupId={c => c.grupo_id}
                        onSelectGroup={setSelectedGroupId}
                        onManageUnassigned={() => setReassigning(true)}
                    />
                </div>
            </div>
        );
    }

    return (
        <div className="flow-config-container">
            <div className="flow-header">
                <button className="flow-back-btn" onClick={onBack}><IoArrowBack size={20} /> Volver a Configuración</button>
                <div style={{ marginTop: 12 }}>
                    <h1>Campos del Formulario — {moduleLabel}</h1>
                    <p>Decide qué campos aparecen en "Crear Nuevo Ticket / Nueva Solicitud" para este módulo. Asunto y Descripción siempre están presentes y no aparecen aquí.</p>
                </div>
                {isDesk && (
                    <div style={{ marginTop: 10 }}>
                        <GroupScopeBreadcrumb
                            groupName={deskGroups.find(g => g.id === selectedGroupId)?.name || '—'}
                            onChangeGroup={() => setSelectedGroupId(null)}
                        />
                    </div>
                )}
            </div>

            <div className="flow-content">
                <div className="flow-tab-pane">
                    <div className="flow-action-row">
                        <h3>Campos del Formulario ({FORM_FIELD_DEFS.length + baseCampos.length})</h3>
                        <button className="btn btn-primary flow-add-btn" onClick={openCreate}>
                            <IoAddOutline size={18} /> Crear Campo
                        </button>
                    </div>

                    <div className="table-responsive-container">
                        <table className="custom-data-table">
                            <thead>
                                <tr>
                                    <th>Campo</th>
                                    <th>Tipo de Dato</th>
                                    <th>Formato / Máscara</th>
                                    <th>Opciones</th>
                                    <th>Obligatorio</th>
                                    <th>Visible</th>
                                    <th style={{ textAlign: 'right' }}>Acciones</th>
                                </tr>
                            </thead>
                            <tbody>
                                {/* ─── Campos del sistema (nativos del ticket, fijos) ─── */}
                                {FORM_FIELD_DEFS.map(f => {
                                    const isAgenteInDesk = f.key === 'agente' && activeWorkspace === 'volcan_desk';
                                    const isChecked = enabled.includes(f.key);
                                    const lockedForGroupAdmin = isGroupAdminUser;
                                    return (
                                        <tr key={f.key} style={{ opacity: isAgenteInDesk ? 0.45 : 1 }}>
                                            <td style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>
                                                {f.label} <span className="flow-option-chip" style={{ marginLeft: 6, fontWeight: 400 }}>Sistema</span>
                                            </td>
                                            <td className="text-muted">—</td>
                                            <td className="text-muted">—</td>
                                            <td className="text-muted">—</td>
                                            <td className="text-muted">—</td>
                                            <td>
                                                <input
                                                    type="checkbox"
                                                    checked={isAgenteInDesk ? false : isChecked}
                                                    disabled={isAgenteInDesk || lockedForGroupAdmin}
                                                    title={lockedForGroupAdmin ? 'Este campo es compartido por todos los grupos — solo un administrador general puede cambiarlo.' : (f.note || '')}
                                                    onChange={e => toggleNative(f.key, e.target.checked)}
                                                />
                                            </td>
                                            <td><span className="text-muted" style={{ fontSize: '0.75rem' }}>{f.note ? f.note : '—'}</span></td>
                                        </tr>
                                    );
                                })}

                                {/* ─── Campos personalizados propios de este módulo ─── */}
                                {[...baseCampos].sort((a, b) => (a.orden || 0) - (b.orden || 0)).map(c => (
                                    <tr key={c.id}>
                                        <td style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>{c.nombre}</td>
                                        <td className="capitalize">{c.tipo_dato}</td>
                                        <td>{c.formato || <span className="text-muted">—</span>}</td>
                                        <td>
                                            {c.opciones && Array.isArray(c.opciones) && c.opciones.length > 0 ? (
                                                <div className="flow-options-chips">
                                                    {c.opciones.map((o, idx) => <span key={idx} className="flow-option-chip">{o}</span>)}
                                                </div>
                                            ) : <span className="text-muted">—</span>}
                                        </td>
                                        <td>{c.obligatorio ? <IoCheckmarkOutline color="var(--color-success)" /> : <IoRemoveOutline className="text-muted" />}</td>
                                        <td><IoCheckmarkOutline color="var(--color-success)" title="Siempre visible" /></td>
                                        <td>
                                            <div className="table-actions">
                                                <button className="btn-icon" title="Editar" onClick={() => openEdit(c)}><IoPencilOutline size={13} /></button>
                                                <button className="btn-icon text-danger" title="Eliminar" onClick={() => handleDelete(c)}><IoTrashOutline size={13} /></button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            {showModal && (
                <div className="flow-modal-overlay">
                    <div className="flow-modal">
                        <div className="flow-modal-header">
                            <h2>{editing ? 'Editar Campo' : 'Crear Campo'} — {moduleLabel}</h2>
                            <button className="flow-modal-close" onClick={() => setShowModal(false)}><IoCloseOutline size={22} /></button>
                        </div>
                        <form onSubmit={handleSave}>
                            <div className="flow-form-group">
                                <label>Nombre del Campo *</label>
                                <input type="text" required value={form.nombre} onChange={e => setForm({ ...form, nombre: e.target.value })} placeholder="ej. Área solicitante" />
                            </div>
                            <div className="flow-form-group">
                                <label>Tipo de Dato</label>
                                <select value={form.tipo_dato} onChange={e => setForm({ ...form, tipo_dato: e.target.value })}>
                                    <option value="texto">Texto</option>
                                    <option value="numero">Número</option>
                                    <option value="fecha">Fecha</option>
                                    <option value="hora">Hora</option>
                                    <option value="moneda">Moneda</option>
                                    <option value="select">Lista de Selección (Select)</option>
                                    <option value="archivo">Archivo (adjuntar)</option>
                                </select>
                            </div>
                            {form.tipo_dato === 'select' && (
                                <div className="flow-form-group">
                                    <label>Opciones (separadas por coma) *</label>
                                    <input type="text" required value={form.opciones} onChange={e => setForm({ ...form, opciones: e.target.value })} placeholder="ej. Opción A, Opción B" />
                                </div>
                            )}
                            <div className="flow-form-group">
                                <label>Formato / Máscara (Opcional)</label>
                                <input type="text" value={form.formato} onChange={e => setForm({ ...form, formato: e.target.value })} placeholder="ej. XXXX-XXXX" />
                            </div>
                            <div className="flow-form-group check-inline">
                                <input type="checkbox" id="campo-obligatorio" checked={form.obligatorio} onChange={e => setForm({ ...form, obligatorio: e.target.checked })} />
                                <label htmlFor="campo-obligatorio">Obligatorio</label>
                            </div>
                            <div className="flow-modal-actions">
                                <button type="button" className="btn btn-outline" onClick={() => setShowModal(false)}>Cancelar</button>
                                <button type="submit" className="btn btn-primary"><IoCheckmarkOutline size={18} /> Guardar</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
