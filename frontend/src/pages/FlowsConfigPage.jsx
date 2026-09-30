import React, { useState, useEffect } from 'react';
import {
    IoArrowBack, IoAddOutline, IoTrashOutline, IoPencilOutline,
    IoCheckmarkOutline, IoCloseOutline, IoSettingsOutline,
    IoListOutline, IoAlertCircleOutline
} from 'react-icons/io5';
import {
    getCamposCatalogo, createCampoCatalogo, updateCampoCatalogo, deleteCampoCatalogo,
    getReglasFlujo, createReglaFlujo, updateReglaFlujo, deleteReglaFlujo
} from '../services/flowService';
import { getCurrentUser } from '../services/authService';
import { getGroups } from '../services/groupService';
import { GroupScopePicker, GroupScopeReassign, GroupScopeBreadcrumb } from '../components/GroupScopeGate';
import './FlowsConfigPage.css';

export default function FlowsConfigPage({ onBack, config, activeWorkspace }) {
    const currentUser = getCurrentUser();
    const isGroupAdminUser = currentUser?.role === 'group_admin';
    // "isAdmin" aquí significa "puede administrar este catálogo" — admin general
    // o group_admin (acotado a su propio grupo vía deskGroups/selectedGroupId abajo).
    const isAdmin = currentUser?.role === 'admin' || isGroupAdminUser;
    const isDesk = activeWorkspace === 'volcan_desk';
    const deskGroups = isDesk
        ? getGroups().filter(g => g.modulo === 'volcan_desk' && (!isGroupAdminUser || g.id === currentUser.admin_group_id))
        : [];

    // ── Group gate (Volcán Desk only) ──
    // group_admin salta el picker: ya tiene su único grupo preseleccionado.
    const [selectedGroupId, setSelectedGroupId] = useState(isGroupAdminUser ? currentUser.admin_group_id : null);
    const [reassigning, setReassigning] = useState(false);

    // Las reglas se definen sobre un Tipo, y cada Tipo ya pertenece a un solo
    // módulo — filtrar aquí evita mezclar reglas/tipos de Voltik y Volcán Desk.
    // En Volcán Desk, además se acotan al grupo de soporte elegido.
    const modTypesAll = (config.types || []).filter(t => (t.modulo || 'voltik') === activeWorkspace);
    const modTypes = isDesk ? modTypesAll.filter(t => t.grupoId === selectedGroupId) : modTypesAll;
    const modCategoriesAll = (config.categories || []).filter(c => (c.modulo || 'voltik') === activeWorkspace);
    const modCategories = isDesk ? modCategoriesAll.filter(c => c.grupoId === selectedGroupId) : modCategoriesAll;
    const modTypeIds = new Set(modTypes.map(t => t.id));

    const [activeTab, setActiveTab] = useState('campos'); // 'campos' | 'reglas'

    // Catalog fields states — todos los campos del módulo (sin acotar a grupo, para el picker)
    const [moduleCampos, setModuleCampos] = useState([]);
    const campos = isDesk ? moduleCampos.filter(c => c.grupo_id === selectedGroupId) : moduleCampos;
    const [showCampoModal, setShowCampoModal] = useState(false);
    const [editingCampo, setEditingCampo] = useState(null);
    const [campoForm, setCampoForm] = useState({
        nombre: '',
        tipo_dato: 'texto',
        opciones: '',
        formato: ''
    });

    // Rules states
    const [reglas, setReglas] = useState([]);
    const modReglas = reglas.filter(r => modTypeIds.has(r.tipo_id));
    const [showReglaModal, setShowReglaModal] = useState(false);
    const [editingRegla, setEditingRegla] = useState(null);
    const [reglaForm, setReglaForm] = useState({
        tipo_id: '',
        categoria_id: '',
        activo: true,
        camposSeleccionados: {} // { campo_id: { obligatorio: boolean, orden: number } }
    });

    const loadData = async () => {
        try {
            const listCampos = await getCamposCatalogo();
            // Catálogo propio de Flujos — no mezclar con los campos "base" de
            // Campos del Formulario (scope='base'), aunque compartan la misma tabla,
            // y acotar por módulo para no mezclar Voltik con Volcán Desk.
            setModuleCampos((listCampos || []).filter(c => c.scope !== 'base' && (c.modulo || 'voltik') === activeWorkspace));
            const listReglas = await getReglasFlujo();
            setReglas(listReglas || []);
        } catch (error) {
            console.error('Error loading flows data:', error);
        }
    };

    useEffect(() => {
        loadData();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeWorkspace]);

    // Campos catalog actions
    const handleOpenCampoModal = (campo = null) => {
        if (!isAdmin) return;
        if (campo) {
            setEditingCampo(campo);
            setCampoForm({
                nombre: campo.nombre,
                tipo_dato: campo.tipo_dato,
                opciones: Array.isArray(campo.opciones) ? campo.opciones.join(', ') : '',
                formato: campo.formato || ''
            });
        } else {
            setEditingCampo(null);
            setCampoForm({
                nombre: '',
                tipo_dato: 'texto',
                opciones: '',
                formato: ''
            });
        }
        setShowCampoModal(true);
    };

    const handleSaveCampo = async (e) => {
        e.preventDefault();
        const nombreTrimmed = campoForm.nombre.trim();
        if (!nombreTrimmed) return;

        // Aviso inmediato en cliente antes de llamar al servidor (que igual lo
        // vuelve a validar — ver POST/PUT /api/campos-catalogo). `campos` ya
        // viene acotado a este módulo+grupo, que es el mismo alcance en el que
        // el backend compara (2026-09-16, a pedido del usuario).
        const duplicado = campos.find(c =>
            c.nombre.trim().toLowerCase() === nombreTrimmed.toLowerCase() &&
            (!editingCampo || c.id !== editingCampo.id)
        );
        if (duplicado) {
            alert(`Ya existe un campo llamado "${duplicado.nombre}" — edítalo en vez de crear uno nuevo.`);
            return;
        }

        const optionsArray = campoForm.tipo_dato === 'select'
            ? campoForm.opciones.split(',').map(o => o.trim()).filter(Boolean)
            : null;

        const payload = {
            nombre: campoForm.nombre.trim(),
            tipo_dato: campoForm.tipo_dato,
            opciones: optionsArray,
            formato: campoForm.formato.trim() || null,
            scope: 'flujo',
            modulo: activeWorkspace,
            ...(isDesk ? { grupo_id: selectedGroupId } : {}),
        };

        try {
            if (editingCampo) {
                await updateCampoCatalogo(editingCampo.id, payload);
            } else {
                await createCampoCatalogo(payload);
            }
            setShowCampoModal(false);
            loadData();
        } catch (error) {
            alert('Error al guardar el campo: ' + error.message);
        }
    };

    const handleDeleteCampo = async (id) => {
        if (!isAdmin) return;
        if (window.confirm('¿Seguro que deseas eliminar este campo? Se desvinculará de las reglas.')) {
            try {
                await deleteCampoCatalogo(id);
                loadData();
            } catch (error) {
                alert('Error al eliminar campo: ' + error.message);
            }
        }
    };

    // Reglas actions
    const handleOpenReglaModal = (regla = null) => {
        if (!isAdmin) return;
        
        // Initial selected fields
        const camposSel = {};
        campos.forEach(c => {
            camposSel[c.id] = { checked: false, obligatorio: false, orden: 1 };
        });

        if (regla) {
            setEditingRegla(regla);
            if (Array.isArray(regla.campos)) {
                regla.campos.forEach(rc => {
                    camposSel[rc.campo_id] = {
                        checked: true,
                        obligatorio: !!rc.obligatorio,
                        orden: rc.orden || 1
                    };
                });
            }
            setReglaForm({
                tipo_id: regla.tipo_id || '',
                categoria_id: regla.categoria_id || '',
                activo: regla.activo !== false,
                camposSeleccionados: camposSel
            });
        } else {
            setEditingRegla(null);
            setReglaForm({
                tipo_id: modTypes?.[0]?.id || '',
                categoria_id: '',
                activo: true,
                camposSeleccionados: camposSel
            });
        }
        setShowReglaModal(true);
    };

    const handleSaveRegla = async (e) => {
        e.preventDefault();
        if (!reglaForm.tipo_id) return;

        // Aviso inmediato en cliente antes de llamar al servidor (que igual lo
        // vuelve a validar — ver POST/PUT /api/reglas-flujo) — cuenta cualquier
        // regla existente para el mismo Tipo+Categoría, activa o inactiva, y se
        // excluye a sí misma si se está editando (2026-09-16, a pedido del
        // usuario, tras encontrar en vivo una regla huérfana de una Categoría
        // ya borrada).
        const targetCategoriaId = reglaForm.categoria_id || null;
        const duplicada = modReglas.find(r =>
            r.tipo_id === reglaForm.tipo_id &&
            (r.categoria_id || null) === targetCategoriaId &&
            (!editingRegla || r.id !== editingRegla.id)
        );
        if (duplicada) {
            alert(`Ya existe una regla para esta combinación de Tipo y Categoría${duplicada.activo ? '' : ' (está inactiva)'} — edítala en vez de crear una nueva.`);
            return;
        }

        // Build campos array [{campo_id, obligatorio, orden}]
        const camposPayload = [];
        Object.keys(reglaForm.camposSeleccionados).forEach(campoId => {
            const cs = reglaForm.camposSeleccionados[campoId];
            if (cs.checked) {
                camposPayload.push({
                    campo_id: campoId,
                    obligatorio: !!cs.obligatorio,
                    orden: parseInt(cs.orden) || 1
                });
            }
        });

        // Sort by order ascending
        camposPayload.sort((a, b) => a.orden - b.orden);

        const payload = {
            tipo_id: reglaForm.tipo_id,
            categoria_id: reglaForm.categoria_id || null,
            activo: reglaForm.activo,
            campos: camposPayload
        };

        try {
            if (editingRegla) {
                await updateReglaFlujo(editingRegla.id, payload);
            } else {
                await createReglaFlujo(payload);
            }
            setShowReglaModal(false);
            loadData();
        } catch (error) {
            alert('Error al guardar la regla: ' + error.message);
        }
    };

    const handleDeleteRegla = async (id) => {
        if (!isAdmin) return;
        if (window.confirm('¿Seguro que deseas eliminar esta regla de flujo?')) {
            try {
                await deleteReglaFlujo(id);
                loadData();
            } catch (error) {
                alert('Error al eliminar regla: ' + error.message);
            }
        }
    };

    const toggleCampoInRule = (campoId) => {
        setReglaForm(prev => {
            const updated = { ...prev.camposSeleccionados };
            const current = updated[campoId] || { checked: false, obligatorio: false, orden: 1 };
            updated[campoId] = {
                ...current,
                checked: !current.checked
            };
            return { ...prev, camposSeleccionados: updated };
        });
    };

    const toggleObligatorioInRule = (campoId) => {
        setReglaForm(prev => {
            const updated = { ...prev.camposSeleccionados };
            const current = updated[campoId] || { checked: false, obligatorio: false, orden: 1 };
            updated[campoId] = {
                ...current,
                obligatorio: !current.obligatorio
            };
            return { ...prev, camposSeleccionados: updated };
        });
    };

    const changeOrdenInRule = (campoId, orden) => {
        setReglaForm(prev => {
            const updated = { ...prev.camposSeleccionados };
            const current = updated[campoId] || { checked: false, obligatorio: false, orden: 1 };
            updated[campoId] = {
                ...current,
                orden: parseInt(orden) || 1
            };
            return { ...prev, camposSeleccionados: updated };
        });
    };

    const getTipoLabel = (id) => {
        const type = config.types?.find(t => t.id === id);
        return type ? type.label : 'Tipo eliminado';
    };

    const getCategoriaLabel = (id) => {
        if (!id) return 'Todas las categorías';
        const cat = config.categories?.find(c => c.id === id);
        // Antes mostraba el id crudo (ej. "c1789509687137") cuando la categoría
        // ya no existe — reglas huérfanas de una categoría borrada, ahora
        // bloqueado en el backend (ver POST /api/config), pero cualquier
        // huérfana que ya exista de antes sigue necesitando un texto legible
        // en vez del id interno (reportado en vivo, 2026-09-16).
        return cat ? cat.label : 'Categoría eliminada';
    };

    const assignCampoGroup = async (campo, groupId) => {
        try {
            await updateCampoCatalogo(campo.id, { grupo_id: groupId });
            loadData();
        } catch (error) {
            alert('Error al reasignar el campo: ' + error.message);
        }
    };

    if (isDesk && reassigning) {
        return (
            <div className="flow-config-container">
                <div className="flow-header">
                    <button className="flow-back-btn" onClick={onBack}><IoArrowBack size={20} /> Volver a Configuración</button>
                    <div style={{ marginTop: 12 }}><h1>Flujos de Ticket — reasignar</h1></div>
                </div>
                <div className="flow-content">
                    <GroupScopeReassign
                        itemLabelPlural="campos de flujo"
                        items={moduleCampos}
                        groups={deskGroups}
                        getGroupId={c => c.grupo_id}
                        getLabel={c => c.nombre}
                        onAssign={assignCampoGroup}
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
                        <h1>Flujos de Ticket</h1>
                        <p>Elige el grupo de soporte. Los Tipos/Categorías que veas aquí y los campos que agregues quedarán propios de ese grupo.</p>
                    </div>
                </div>
                <div className="flow-content">
                    <GroupScopePicker
                        itemLabelPlural="campos de flujo"
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
            {/* Header */}
            <div className="flow-header">
                <button className="flow-back-btn" onClick={onBack}>
                    <IoArrowBack size={20} /> Volver a Configuración
                </button>
                <div style={{ marginTop: 12 }}>
                    <h1>Flujos de Ticket</h1>
                    <p>Administra campos obligatorios y personalizados requeridos por Tipo y Categoría de ticket.</p>
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

            {/* Admin Warning */}
            {!isAdmin && (
                <div className="flow-admin-warning">
                    <IoAlertCircleOutline size={20} />
                    <span>Esta sección es de solo lectura. Solo los Administradores pueden editar campos y reglas de flujo.</span>
                </div>
            )}

            {/* Tabs */}
            <div className="flow-tabs">
                <button
                    className={`flow-tab ${activeTab === 'campos' ? 'active' : ''}`}
                    onClick={() => setActiveTab('campos')}
                >
                    Catálogo de Campos ({campos.length})
                </button>
                <button
                    className={`flow-tab ${activeTab === 'reglas' ? 'active' : ''}`}
                    onClick={() => setActiveTab('reglas')}
                >
                    Reglas de Flujos ({modReglas.length})
                </button>
            </div>

            {/* Tab Contents */}
            <div className="flow-content">
                {activeTab === 'campos' ? (
                    <div className="flow-tab-pane">
                        <div className="flow-action-row">
                            <h3>Catálogo de Campos Personalizados</h3>
                            {isAdmin && (
                                <button className="btn btn-primary flow-add-btn" onClick={() => handleOpenCampoModal(null)}>
                                    <IoAddOutline size={18} /> Crear Campo
                                </button>
                            )}
                        </div>

                        <div className="table-responsive-container">
                            <table className="custom-data-table">
                                <thead>
                                    <tr>
                                        <th>Campo</th>
                                        <th>Tipo de Dato</th>
                                        <th>Formato / Máscara</th>
                                        <th>Opciones</th>
                                        {isAdmin && <th style={{ textAlign: 'right' }}>Acciones</th>}
                                    </tr>
                                </thead>
                                <tbody>
                                    {[...campos]
                                        .sort((a, b) => a.nombre.localeCompare(b.nombre, undefined, { sensitivity: 'base' }))
                                        .map(c => (
                                            <tr key={c.id}>
                                                <td style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>{c.nombre}</td>
                                                <td className="capitalize">{c.tipo_dato}</td>
                                                <td>{c.formato || <span className="text-muted">—</span>}</td>
                                                <td>
                                                    {c.opciones && Array.isArray(c.opciones) && c.opciones.length > 0 ? (
                                                        <div className="flow-options-chips">
                                                            {c.opciones.map((o, idx) => (
                                                                <span key={idx} className="flow-option-chip">{o}</span>
                                                            ))}
                                                        </div>
                                                    ) : (
                                                        <span className="text-muted">—</span>
                                                    )}
                                                </td>
                                                {isAdmin && (
                                                    <td>
                                                        <div className="table-actions">
                                                            <button className="btn-icon" title="Editar" onClick={() => handleOpenCampoModal(c)}>
                                                                <IoPencilOutline size={13} />
                                                            </button>
                                                            <button className="btn-icon text-danger" title="Eliminar" onClick={() => handleDeleteCampo(c.id)}>
                                                                <IoTrashOutline size={13} />
                                                            </button>
                                                        </div>
                                                    </td>
                                                )}
                                            </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                ) : (
                    <div className="flow-tab-pane">
                        <div className="flow-action-row">
                            <h3>Reglas de Flujos Activas</h3>
                            {isAdmin && (
                                <button className="btn btn-primary flow-add-btn" onClick={() => handleOpenReglaModal(null)}>
                                    <IoAddOutline size={18} /> Crear Regla
                                </button>
                            )}
                        </div>

                        <div className="table-responsive-container">
                            <table className="custom-data-table">
                                <thead>
                                    <tr>
                                        <th>Tipo de Ticket</th>
                                        <th>Categoría</th>
                                        <th>Estado</th>
                                        <th>Campos Inyectados</th>
                                        {isAdmin && <th style={{ textAlign: 'right' }}>Acciones</th>}
                                    </tr>
                                </thead>
                                <tbody>
                                    {[...modReglas]
                                        .sort((a, b) => {
                                            const typeA = getTipoLabel(a.tipo_id) || '';
                                            const typeB = getTipoLabel(b.tipo_id) || '';
                                            return typeA.localeCompare(typeB, undefined, { sensitivity: 'base' });
                                        })
                                        .map(r => (
                                            <tr key={r.id} className={!r.activo ? 'inactive' : ''}>
                                                <td style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>{getTipoLabel(r.tipo_id)}</td>
                                                <td>{getCategoriaLabel(r.categoria_id)}</td>
                                                <td>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                                        <span className={`status-dot ${r.activo ? 'active' : 'inactive'}`} title={r.activo ? 'Activa' : 'Inactiva'}></span>
                                                        <span style={{ fontSize: '0.8rem', color: r.activo ? 'var(--color-success)' : 'var(--color-text-muted)' }}>
                                                            {r.activo ? 'Activo' : 'Inactivo'}
                                                        </span>
                                                    </div>
                                                </td>
                                                <td>
                                                    <div className="flow-rule-fields-summary">
                                                        {Array.isArray(r.campos) && r.campos.length > 0 ? (
                                                            r.campos.map(rc => {
                                                                const field = campos.find(c => c.id === rc.campo_id);
                                                                if (!field) return null;
                                                                return (
                                                                    <span key={rc.campo_id} className={`flow-rule-field-chip ${rc.obligatorio ? 'required' : ''}`}>
                                                                        {field.nombre} {rc.obligatorio && '*'}
                                                                    </span>
                                                                );
                                                            })
                                                        ) : (
                                                            <span className="text-muted">Sin campos adicionales</span>
                                                        )}
                                                    </div>
                                                </td>
                                                {isAdmin && (
                                                    <td>
                                                        <div className="table-actions">
                                                            <button className="btn-icon" title="Editar" onClick={() => handleOpenReglaModal(r)}>
                                                                <IoPencilOutline size={13} />
                                                            </button>
                                                            <button className="btn-icon text-danger" title="Eliminar" onClick={() => handleDeleteRegla(r.id)}>
                                                                <IoTrashOutline size={13} />
                                                            </button>
                                                        </div>
                                                    </td>
                                                )}
                                            </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}
            </div>

            {/* Campo Modal */}
            {showCampoModal && (
                <div className="flow-modal-overlay">
                    <div className="flow-modal">
                        <div className="flow-modal-header">
                            <h2>{editingCampo ? 'Editar Campo' : 'Crear Nuevo Campo'}</h2>
                            <button className="flow-modal-close" onClick={() => setShowCampoModal(false)}>
                                <IoCloseOutline size={22} />
                            </button>
                        </div>
                        <form onSubmit={handleSaveCampo}>
                            <div className="flow-form-group">
                                <label>Nombre del Campo *</label>
                                <input
                                    type="text"
                                    required
                                    value={campoForm.nombre}
                                    onChange={e => setCampoForm({ ...campoForm, nombre: e.target.value })}
                                    placeholder="ej. Tarjeta de crédito"
                                />
                            </div>

                            <div className="flow-form-group">
                                <label>Tipo de Dato</label>
                                <select
                                    value={campoForm.tipo_dato}
                                    onChange={e => setCampoForm({ ...campoForm, tipo_dato: e.target.value })}
                                >
                                    <option value="texto">Texto</option>
                                    <option value="numero">Número</option>
                                    <option value="fecha">Fecha</option>
                                    <option value="hora">Hora</option>
                                    <option value="moneda">Moneda</option>
                                    <option value="select">Lista de Selección (Select)</option>
                                    <option value="archivo">Archivo (adjuntar)</option>
                                </select>
                            </div>

                            {campoForm.tipo_dato === 'select' && (
                                <div className="flow-form-group">
                                    <label>Opciones (separadas por coma) *</label>
                                    <input
                                        type="text"
                                        required
                                        value={campoForm.opciones}
                                        onChange={e => setCampoForm({ ...campoForm, opciones: e.target.value })}
                                        placeholder="ej. Visa, Mastercard, Carnet, American Express"
                                    />
                                    <small className="form-help">Ingresa las opciones separadas por coma.</small>
                                </div>
                            )}

                            <div className="flow-form-group">
                                <label>Formato / Máscara (Opcional)</label>
                                <input
                                    type="text"
                                    value={campoForm.formato}
                                    onChange={e => setCampoForm({ ...campoForm, formato: e.target.value })}
                                    placeholder="ej. XXXX-XXXX-XXXX-XXXX, $ 0.00"
                                />
                                <small className="form-help">Instrucciones visuales o formato requerido para llenar el campo.</small>
                            </div>

                            <div className="flow-modal-actions">
                                <button type="button" className="btn btn-outline" onClick={() => setShowCampoModal(false)}>
                                    Cancelar
                                </button>
                                <button type="submit" className="btn btn-primary">
                                    <IoCheckmarkOutline size={18} /> Guardar Campo
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Regla Modal */}
            {showReglaModal && (
                <div className="flow-modal-overlay">
                    <div className="flow-modal flow-modal-large">
                        <div className="flow-modal-header">
                            <h2>{editingRegla ? 'Editar Regla de Flujo' : 'Crear Regla de Flujo'}</h2>
                            <button className="flow-modal-close" onClick={() => setShowReglaModal(false)}>
                                <IoCloseOutline size={22} />
                            </button>
                        </div>
                        <form onSubmit={handleSaveRegla}>
                            <div className="flow-form-row">
                                <div className="flow-form-group flex-1">
                                    <label>Tipo de Ticket *</label>
                                    <select
                                        value={reglaForm.tipo_id}
                                        required
                                        onChange={e => {
                                            const newTipoId = e.target.value;
                                            // Cada Categoría ya está ligada a un solo Tipo (ver
                                            // Configuración > Categorías) — si la categoría elegida
                                            // no es de este Tipo nuevo, se limpia en vez de dejar
                                            // guardar una combinación inconsistente (ej. Tipo
                                            // "Consulta" con Categoría "Nuevo RPA", que en realidad
                                            // pertenece a "Desarrollo").
                                            const categoriaSigueValida = modCategories.some(
                                                c => c.id === reglaForm.categoria_id && c.tipoId === newTipoId
                                            );
                                            setReglaForm({
                                                ...reglaForm,
                                                tipo_id: newTipoId,
                                                categoria_id: categoriaSigueValida ? reglaForm.categoria_id : '',
                                            });
                                        }}
                                    >
                                        <option value="">-- Seleccionar Tipo --</option>
                                        {modTypes?.map(t => (
                                            <option key={t.id} value={t.id}>{t.label}</option>
                                        ))}
                                    </select>
                                </div>

                                <div className="flow-form-group flex-1">
                                    <label>Categoría (Opcional)</label>
                                    <select
                                        value={reglaForm.categoria_id}
                                        disabled={!reglaForm.tipo_id}
                                        onChange={e => setReglaForm({ ...reglaForm, categoria_id: e.target.value })}
                                    >
                                        <option value="">Todas las Categorías (General)</option>
                                        {modCategories?.filter(c => c.tipoId === reglaForm.tipo_id).map(c => (
                                            <option key={c.id} value={c.id}>{c.label}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>

                            <div className="flow-form-group check-inline">
                                <input
                                    type="checkbox"
                                    id="rule-active"
                                    checked={reglaForm.activo}
                                    onChange={e => setReglaForm({ ...reglaForm, activo: e.target.checked })}
                                />
                                <label htmlFor="rule-active">Regla Activa</label>
                            </div>

                            <div className="flow-form-group">
                                <label style={{ marginBottom: 12 }}>Selecciona los campos del catálogo para inyectar:</label>
                                <div className="flow-modal-fields-selector">
                                    <div className="flow-selector-header">
                                        <span>Campo</span>
                                        <span style={{ textAlign: 'center' }}>¿Activo?</span>
                                        <span style={{ textAlign: 'center' }}>¿Obligatorio?</span>
                                        <span style={{ textAlign: 'center', width: '80px' }}>Orden</span>
                                    </div>
                                    <div className="flow-selector-body">
                                        {campos.length > 0 ? (
                                            campos.map(c => {
                                                const currentSel = reglaForm.camposSeleccionados[c.id] || { checked: false, obligatorio: false, orden: 1 };
                                                return (
                                                    <div key={c.id} className={`flow-selector-item ${currentSel.checked ? 'selected' : ''}`}>
                                                        <div className="field-info">
                                                            <strong>{c.nombre}</strong>
                                                            <span className="muted">({c.tipo_dato})</span>
                                                        </div>
                                                        <div className="checkbox-col">
                                                            <input
                                                                type="checkbox"
                                                                checked={currentSel.checked}
                                                                onChange={() => toggleCampoInRule(c.id)}
                                                            />
                                                        </div>
                                                        <div className="checkbox-col">
                                                            <input
                                                                type="checkbox"
                                                                disabled={!currentSel.checked}
                                                                checked={currentSel.obligatorio}
                                                                onChange={() => toggleObligatorioInRule(c.id)}
                                                            />
                                                        </div>
                                                        <div className="input-col" style={{ width: '80px' }}>
                                                            <input
                                                                type="number"
                                                                min="1"
                                                                disabled={!currentSel.checked}
                                                                value={currentSel.orden}
                                                                onChange={(e) => changeOrdenInRule(c.id, e.target.value)}
                                                                style={{ width: '60px', textAlign: 'center', padding: '4px' }}
                                                            />
                                                        </div>
                                                    </div>
                                                );
                                            })
                                        ) : (
                                            <div className="flow-empty-state" style={{ padding: 20 }}>
                                                <p>Por favor crea campos en el catálogo primero.</p>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>

                            <div className="flow-modal-actions" style={{ marginTop: 24 }}>
                                <button type="button" className="btn btn-outline" onClick={() => setShowReglaModal(false)}>
                                    Cancelar
                                </button>
                                <button type="submit" className="btn btn-primary" disabled={campos.length === 0}>
                                    <IoCheckmarkOutline size={18} /> Guardar Regla
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
