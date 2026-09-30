import { useState } from 'react';
import { IoAddOutline, IoTrashOutline, IoPencilOutline, IoPeopleOutline } from 'react-icons/io5';
import { createGroup, updateGroup, deleteGroup } from '../services/groupService';
import Modal from '../components/Modal';
import Badge from '../components/Badge';

export default function GroupsTab({ groups, users, activeWorkspace, onRefresh }) {
    const [showGroupModal, setShowGroupModal] = useState(false);
    const [editingItem, setEditingItem] = useState(null);

    const handleGroupSubmit = (e) => {
        e.preventDefault();
        const formData = new FormData(e.target);
        const data = {
            name: formData.get('name'),
            description: formData.get('description'),
            transfiere_propiedad: e.target.transfiere_propiedad.checked,
        };

        if (editingItem) {
            // El módulo del grupo NUNCA se reescribe al editar (mismo principio que
            // en Usuarios) — antes se recalculaba desde activeWorkspace en cada
            // guardado, lo que "migraba" grupos de módulo sin que nadie lo pidiera.
            updateGroup(editingItem.id, data);
        } else {
            createGroup({ ...data, modulo: activeWorkspace });
        }
        setShowGroupModal(false);
        setEditingItem(null);
        onRefresh();
    };

    return (
        <div className="tab-pane fade-in">
            <div className="pane-header">
                <h2>Grupos de Trabajo</h2>
                <button className="btn btn-primary" onClick={() => { setEditingItem(null); setShowGroupModal(true); }}>
                    <IoAddOutline size={18} /> Nuevo Grupo
                </button>
            </div>
            <div className="table-responsive-container">
                <table className="custom-data-table">
                    <thead>
                        <tr>
                            <th>Grupo</th>
                            <th>Descripción</th>
                            <th>Miembros</th>
                            <th>Transfiere Propiedad</th>
                            <th style={{ textAlign: 'right' }}>Acciones</th>
                        </tr>
                    </thead>
                    <tbody>
                        {[...groups]
                            .filter(g => (g.modulo || 'voltik') === activeWorkspace)
                            .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
                            .map(group => (
                                <tr key={group.id}>
                                    <td style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                            <IoPeopleOutline size={18} style={{ color: 'var(--color-primary)' }} />
                                            {group.name}
                                        </div>
                                    </td>
                                    <td>
                                        <span style={{ color: 'var(--color-text-muted)', fontSize: '0.875rem' }}>{group.description}</span>
                                    </td>
                                    <td>
                                        <Badge variant="primary">
                                            {users.filter(u => u.groups?.includes(group.id)).length} usuarios
                                        </Badge>
                                    </td>
                                    <td>
                                        {group.transfiere_propiedad ? (
                                            <Badge variant="warning">Sí</Badge>
                                        ) : (
                                            <span className="text-muted" style={{ fontSize: '0.85rem' }}>No</span>
                                        )}
                                    </td>
                                    <td>
                                        <div className="table-actions">
                                            <button className="btn-icon-sm" title="Editar" onClick={() => { setEditingItem(group); setShowGroupModal(true); }}><IoPencilOutline size={13}/></button>
                                            <button className="btn-icon-sm danger" title="Eliminar" onClick={() => { if(confirm('¿Eliminar grupo?')) { deleteGroup(group.id); onRefresh(); } }}><IoTrashOutline size={13}/></button>
                                        </div>
                                    </td>
                                </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* Group Modal */}
            <Modal isOpen={showGroupModal} onClose={() => setShowGroupModal(false)} title={editingItem ? 'Editar Grupo' : 'Nuevo Grupo'}>
                <form onSubmit={handleGroupSubmit}>
                    <div className="input-group"><label>Nombre del Grupo</label><input name="name" defaultValue={editingItem?.name} required /></div>
                    <div className="input-group"><label>Descripción</label><textarea name="description" defaultValue={editingItem?.description} rows="3" /></div>
                    <div className="input-group">
                        <label>Módulo</label>
                        <div style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)' }}>
                            {editingItem
                                ? `Fijo en ${(editingItem.modulo || 'voltik') === 'volcan_desk' ? 'Volcán Desk' : 'Voltik'} (no se puede cambiar).`
                                : <>Se creará en <strong>{activeWorkspace === 'volcan_desk' ? 'Volcán Desk' : 'Voltik'}</strong> (el workspace activo).</>}
                        </div>
                    </div>
                    <div className="input-group" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '8px', marginTop: '12px' }}>
                        <input
                            type="checkbox"
                            name="transfiere_propiedad"
                            defaultChecked={editingItem?.transfiere_propiedad || false}
                            id="transfiere_propiedad"
                        />
                        <label htmlFor="transfiere_propiedad" style={{ cursor: 'pointer', margin: 0, fontSize: '0.85rem' }}>Transfiere propiedad de ticket al escalar</label>
                    </div>
                    <div className="modal-footer">
                        <button type="button" className="btn btn-secondary" onClick={() => setShowGroupModal(false)}>Cancelar</button>
                        <button type="submit" className="btn btn-primary">Guardar</button>
                    </div>
                </form>
            </Modal>
        </div>
    );
}
