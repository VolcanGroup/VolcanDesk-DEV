import { useState } from 'react';
import { IoAddOutline, IoTrashOutline } from 'react-icons/io5';
import { createAreaAccesoExtra, deleteAreaAccesoExtra } from '../services/groupService';
import Modal from '../components/Modal';
import Multiselect from '../components/Multiselect';

export default function AccesosExtraTab({ users, groups, accesosExtra, activeWorkspace, onRefresh }) {
    const [showAccesoModal, setShowAccesoModal] = useState(false);
    // Áreas elegidas en "Otorgar Acceso Especial" — antes era un <select> de
    // una sola opción, había que repetir todo el modal una vez por grupo
    // (2026-09-17, a pedido del usuario). Ahora se eligen varias de una vez y
    // se crea un AreaAccesoExtra por cada una al enviar.
    const [accesoAreaIds, setAccesoAreaIds] = useState([]);

    const handleAccesoSubmit = async (e) => {
        e.preventDefault();
        const formData = new FormData(e.target);
        const usuario_id = formData.get('usuario_id');
        // Una fila de AreaAccesoExtra por cada área elegida en el multiselect,
        // todas en paralelo — antes había que repetir el modal completo por
        // cada grupo (2026-09-17, a pedido del usuario).
        await Promise.all(accesoAreaIds.map(area_id => createAreaAccesoExtra({ usuario_id, area_id })));
        setShowAccesoModal(false);
        onRefresh();
    };

    const handleDeleteAcceso = async (id) => {
        if (window.confirm('¿Eliminar este acceso especial?')) {
            await deleteAreaAccesoExtra(id);
            onRefresh();
        }
    };

    return (
        <div className="tab-pane fade-in">
            <div className="pane-header">
                <div>
                    <h2>Accesos Cruzados (Extra)</h2>
                    <p className="text-muted" style={{fontSize: '0.85rem', marginTop: '4px'}}>
                        Permite a un agente ver o editar tickets de un área a la que normalmente no pertenece.
                    </p>
                </div>
                <button className="btn btn-primary" onClick={() => { setAccesoAreaIds([]); setShowAccesoModal(true); }}>
                    <IoAddOutline size={18} /> Nuevo Acceso Extra
                </button>
            </div>
            <div className="table-responsive-container">
                <table className="custom-data-table">
                    <thead>
                        <tr>
                            <th>Usuario</th>
                            <th>Área con Acceso</th>
                            <th style={{ textAlign: 'right' }}>Acciones</th>
                        </tr>
                    </thead>
                    <tbody>
                        {accesosExtra.map(acceso => {
                            const u = users.find(x => x.id === acceso.usuario_id);
                            const g = groups.find(x => x.id === acceso.area_id);
                            return (
                                <tr key={acceso.id}>
                                    <td>{u ? u.name : acceso.usuario_id}</td>
                                    <td>{g ? g.name : acceso.area_id}</td>
                                    <td>
                                        <div className="table-actions">
                                            <button className="btn-icon btn-danger" title="Eliminar" onClick={() => handleDeleteAcceso(acceso.id)}>
                                                <IoTrashOutline />
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                        {accesosExtra.length === 0 && (
                            <tr>
                                <td colSpan="3" style={{ textAlign: 'center', padding: '24px', color: 'var(--color-text-tertiary)' }}>
                                    No hay accesos especiales configurados.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            {/* Acceso Modal */}
            <Modal isOpen={showAccesoModal} onClose={() => setShowAccesoModal(false)} title="Otorgar Acceso Especial">
                <form onSubmit={handleAccesoSubmit}>
                    <div className="input-group">
                        <label>Usuario (Agente)</label>
                        <select name="usuario_id" required>
                            <option value="">Seleccione un usuario...</option>
                            {users.filter(u => u.role === 'agent').map(u => (
                                <option key={u.id} value={u.id}>{u.name} ({u.email})</option>
                            ))}
                        </select>
                    </div>
                    <div className="input-group">
                        <Multiselect
                            label="Área(s) a las que tendrá acceso"
                            options={groups.filter(g => (g.modulo || 'voltik') === activeWorkspace).map(g => ({ value: g.id, label: g.name }))}
                            selected={accesoAreaIds}
                            onChange={setAccesoAreaIds}
                            placeholder="Selecciona una o más áreas..."
                        />
                    </div>
                    <div className="modal-footer">
                        <button type="button" className="btn btn-secondary" onClick={() => setShowAccesoModal(false)}>Cancelar</button>
                        <button type="submit" className="btn btn-primary" disabled={accesoAreaIds.length === 0}>
                            Otorgar{accesoAreaIds.length > 1 ? ` (${accesoAreaIds.length})` : ''}
                        </button>
                    </div>
                </form>
            </Modal>
        </div>
    );
}
