import { useState } from 'react';
import { IoAddOutline, IoTrashOutline, IoPencilOutline, IoSearchOutline, IoEyeOutline, IoEyeOffOutline } from 'react-icons/io5';
import { createUser, updateUser, deleteUser } from '../services/userService';
import Modal from '../components/Modal';
import Badge from '../components/Badge';
import { normalizeText } from '../utils/helpers';

const getRoleLabel = (role) => {
    const labels = {
        admin: 'Administrador',
        group_admin: 'Admin de Grupo',
        agent: 'Ejecutivo (Agente)',
        client: 'Cliente'
    };
    return labels[role] || role;
};

export default function UsersInternalTab({ users, groups, currentUser, isGroupAdmin, myGroupScope, activeWorkspace, onRefresh }) {
    const [showUserModal, setShowUserModal] = useState(false);
    const [editingItem, setEditingItem] = useState(null);
    // Rol elegido en el formulario del modal de Usuario — controla si se muestra
    // el selector de "grupo administrado" (solo aplica a group_admin).
    const [userFormRole, setUserFormRole] = useState('agent');
    // Ojito para revelar la contraseña al crear/editar (2026-09-16, a pedido
    // del usuario) — se resetea a oculto cada vez que se abre el modal, para
    // no dejarla visible si el admin abre el modal de otro usuario después.
    const [showUserPassword, setShowUserPassword] = useState(false);
    // Buscador + filtro de rol de "Usuarios Administrativos" (2026-09-17, a
    // pedido del usuario) — el buscador debe encontrar "Adrián González" con
    // "Adrian", "Gonzalez", "González", etc., así que compara sin acentos y
    // en minúsculas contra el nombre completo y el correo.
    const [internalSearch, setInternalSearch] = useState('');
    const [internalRoleFilter, setInternalRoleFilter] = useState('all');

    const handleUserSubmit = (e) => {
        e.preventDefault();
        const formData = new FormData(e.target);
        const selectedGroups = Array.from(formData.getAll('groups'));
        const role = formData.get('role');
        const userData = {
            name: formData.get('name'),
            email: formData.get('email'),
            password: formData.get('password') || (editingItem ? editingItem.password : ''),
            role,
            groups: selectedGroups,
            // Solo aplica a group_admin; se limpia para cualquier otro rol.
            admin_group_id: role === 'group_admin' ? (formData.get('admin_group_id') || null) : null,
        };

        if (editingItem) {
            // El módulo del usuario NUNCA se modifica al editar — se fija una sola
            // vez al crearlo, para que no pueda "migrar" de módulo sin querer.
            updateUser(editingItem.id, userData);
        } else if (isGroupAdmin) {
            // Un group_admin solo puede crear Agente/Admin de Grupo de su propio
            // grupo — el backend ya fuerza esto sin importar lo que se mande
            // (2026-09-07, ampliado a Admin de Grupo 2026-09-14), pero se manda ya
            // bien armado aquí también para que el formulario simplificado (sin
            // selector de grupo) tenga sentido de una vez.
            const chosenRole = userData.role === 'group_admin' ? 'group_admin' : 'agent';
            createUser({
                ...userData,
                role: chosenRole,
                modulo: 'volcan_desk',
                groups: chosenRole === 'agent' ? [myGroupScope] : [],
                admin_group_id: chosenRole === 'group_admin' ? myGroupScope : null,
            });
        } else {
            // group_admin solo existe en Volcán Desk, independientemente del workspace activo.
            createUser({ ...userData, modulo: role === 'group_admin' ? 'volcan_desk' : activeWorkspace });
        }
        setShowUserModal(false);
        setEditingItem(null);
        onRefresh();
    };

    return (
        <div className="tab-pane fade-in">
            <div className="pane-header">
                <h2>Usuarios Administrativos</h2>
                <button className="btn btn-primary" onClick={() => { setEditingItem(null); setUserFormRole('agent'); setShowUserPassword(false); setShowUserModal(true); }}>
                    <IoAddOutline size={18} /> Nuevo Usuario
                </button>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ position: 'relative', flex: '1 1 260px', minWidth: 220 }}>
                    <IoSearchOutline size={15} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-text-muted)' }} />
                    <input
                        type="text"
                        placeholder="Buscar por nombre o correo..."
                        value={internalSearch}
                        onChange={(e) => setInternalSearch(e.target.value)}
                        style={{ width: '100%', paddingLeft: 32, boxSizing: 'border-box' }}
                    />
                </div>
                <select value={internalRoleFilter} onChange={(e) => setInternalRoleFilter(e.target.value)} style={{ minWidth: 190, width: 'auto' }}>
                    <option value="all">Todos los roles</option>
                    <option value="admin">{getRoleLabel('admin')}</option>
                    <option value="group_admin">{getRoleLabel('group_admin')}</option>
                    <option value="agent">{getRoleLabel('agent')}</option>
                </select>
            </div>
            <div className="table-responsive-container">
                <table className="custom-data-table">
                    <thead>
                        <tr>
                            <th>Usuario</th>
                            <th>Correo Electrónico</th>
                            <th>Rol</th>
                            <th>Módulo</th>
                            <th>Grupos</th>
                            <th style={{ textAlign: 'right' }}>Acciones</th>
                        </tr>
                    </thead>
                    <tbody>
                        {[...users]
                            .filter(u => u.role === 'admin' || u.role === 'group_admin' || u.role === 'agent')
                            .filter(u => u.role === 'admin' || (u.modulo || 'voltik') === activeWorkspace)
                            // Un group_admin solo ve a los miembros de SU propio grupo — nunca
                            // otros grupos, ni admins/otros group_admin (2026-09-07).
                            .filter(u => !isGroupAdmin || u.admin_group_id === myGroupScope || (u.groups || []).includes(myGroupScope))
                            .filter(u => internalRoleFilter === 'all' || u.role === internalRoleFilter)
                            .filter(u => {
                                if (!internalSearch.trim()) return true;
                                const q = normalizeText(internalSearch);
                                return normalizeText(u.name).includes(q) || normalizeText(u.email).includes(q);
                            })
                            .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
                            .map(user => (
                                <tr key={user.id}>
                                    <td>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                            <img src={user.avatar} alt="" style={{ width: 26, height: 26, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                                            <span style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>{user.name}</span>
                                        </div>
                                    </td>
                                    <td>{user.email}</td>
                                    <td>
                                        <Badge variant={user.role === 'admin' ? 'error' : user.role === 'group_admin' ? 'error' : 'warning'}>
                                            {getRoleLabel(user.role)}
                                        </Badge>
                                    </td>
                                    <td>
                                        {user.role === 'admin' ? (
                                            <span className="text-muted" style={{ fontSize: '0.8rem' }}>Global (ambos)</span>
                                        ) : (
                                            <Badge variant={(user.modulo || 'voltik') === 'volcan_desk' ? 'warning' : 'primary'}>
                                                {(user.modulo || 'voltik') === 'volcan_desk' ? 'Volcán Desk' : 'Voltik'}
                                            </Badge>
                                        )}
                                    </td>
                                    <td>
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                            {user.role === 'group_admin' ? (
                                                user.admin_group_id ? (
                                                    <span className="group-tag">
                                                        {groups.find(g => g.id === user.admin_group_id)?.name || user.admin_group_id} (admin)
                                                    </span>
                                                ) : (
                                                    <span className="text-muted" style={{ fontSize: '0.8rem' }}>Sin grupo asignado</span>
                                                )
                                            ) : user.groups && user.groups.length > 0 ? (
                                                user.groups.map(gid => (
                                                    <span key={gid} className="group-tag">
                                                        {groups.find(g => g.id === gid)?.name || gid}
                                                    </span>
                                                ))
                                            ) : (
                                                <span className="text-muted" style={{ fontSize: '0.8rem' }}>Sin asignar</span>
                                            )}
                                        </div>
                                    </td>
                                    <td>
                                        {/* Un group_admin ya puede editar/eliminar (2026-09-14, a pedido del
                                            usuario) — el backend lo acepta ahora, pero solo para cuentas de
                                            SU propio grupo. No hace falta acotar aquí de nuevo: la tabla ya
                                            viene filtrada a esas mismas cuentas (ver los .filter de arriba),
                                            así que si el usuario aparece en la fila, ya es editable/eliminable. */}
                                        <div className="table-actions">
                                            <button className="btn-icon-sm" title="Editar" onClick={() => { setEditingItem(user); setUserFormRole(user.role); setShowUserPassword(false); setShowUserModal(true); }}><IoPencilOutline size={13}/></button>
                                            <button className="btn-icon-sm danger" title="Eliminar" disabled={user.id === currentUser.id} onClick={() => { if(confirm('¿Eliminar usuario?')) { deleteUser(user.id); onRefresh(); } }}><IoTrashOutline size={13}/></button>
                                        </div>
                                    </td>
                                </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* User Modal */}
            <Modal isOpen={showUserModal} onClose={() => setShowUserModal(false)} title={editingItem ? 'Editar Usuario' : 'Nuevo Usuario Interno'} closeOnBackdropClick={false}>
                <form onSubmit={handleUserSubmit}>
                    <div className="input-group"><label>Nombre</label><input name="name" defaultValue={editingItem?.name} required /></div>
                    <div className="input-group"><label>Email</label><input type="email" name="email" defaultValue={editingItem?.email} required /></div>
                    <div className="input-group">
                        <label>Password</label>
                        <div style={{ position: 'relative' }}>
                            <input type={showUserPassword ? 'text' : 'password'} name="password" placeholder={editingItem ? 'Mantener actual' : 'Obligatorio'} required={!editingItem} style={{ paddingRight: 36, width: '100%', boxSizing: 'border-box' }} />
                            <button type="button" onClick={() => setShowUserPassword(v => !v)} title={showUserPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', color: 'var(--color-text-muted)', padding: 4 }}>
                                {showUserPassword ? <IoEyeOffOutline size={16} /> : <IoEyeOutline size={16} />}
                            </button>
                        </div>
                    </div>
                    {isGroupAdmin ? (
                        // Formulario simplificado para group_admin (2026-09-07): no puede crear
                        // 'admin' ni elegir grupo — el backend fuerza igual estos valores, esto
                        // es solo para que el formulario no ofrezca opciones que de todos modos
                        // se van a ignorar/rechazar. Puede crear otro Admin de Grupo (para su
                        // mismo grupo) desde 2026-09-14, a pedido del usuario.
                        <>
                            <div className="input-group">
                                <label>Rol</label>
                                {/* defaultValue fijo en "agent" rompía la edición de un Admin de
                                    Grupo existente (siempre mostraba "Ejecutivo" seleccionado, aunque
                                    el usuario real fuera group_admin) — 2026-09-14. */}
                                <select name="role" defaultValue={editingItem?.role === 'group_admin' ? 'group_admin' : 'agent'}>
                                    <option value="agent">Ejecutivo</option>
                                    <option value="group_admin">Admin de Grupo</option>
                                </select>
                            </div>
                            <div className="input-group">
                                <label>Grupo</label>
                                <div style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)' }}>
                                    Se asignará automáticamente a <strong>{groups.find(g => g.id === myGroupScope)?.name || 'tu grupo'}</strong> — un admin de grupo solo puede crear cuentas para su propio grupo.
                                </div>
                            </div>
                        </>
                    ) : (
                        <>
                            <div className="input-group">
                                <label>Rol</label>
                                <select name="role" defaultValue={editingItem?.role || 'agent'} onChange={e => setUserFormRole(e.target.value)}>
                                    <option value="admin">Administrador (Todo)</option>
                                    {(activeWorkspace === 'volcan_desk' || editingItem?.role === 'group_admin') && (
                                        <option value="group_admin">Admin de Grupo (Volcán Desk)</option>
                                    )}
                                    <option value="agent">Ejecutivo (Por Grupo)</option>
                                </select>
                            </div>
                            <div className="input-group">
                                <label>Módulo</label>
                                {editingItem ? (
                                    <div style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)' }}>
                                        {editingItem.role === 'admin'
                                            ? 'Global — los administradores gestionan ambos módulos.'
                                            : editingItem.role === 'group_admin'
                                            ? 'Fijo en Volcán Desk (los admin de grupo solo existen en ese módulo).'
                                            : `Fijo en ${(editingItem.modulo || 'voltik') === 'volcan_desk' ? 'Volcán Desk' : 'Voltik'} (no se puede cambiar después de creado — crea un usuario nuevo si necesitas la misma persona en el otro módulo).`}
                                    </div>
                                ) : (
                                    <div style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)' }}>
                                        {userFormRole === 'group_admin'
                                            ? 'Se creará en Volcán Desk (los admin de grupo solo existen en ese módulo).'
                                            : <>Se creará en <strong>{activeWorkspace === 'volcan_desk' ? 'Volcán Desk' : 'Voltik'}</strong> (el workspace activo). Si el rol es Administrador, esto no aplica.</>}
                                    </div>
                                )}
                            </div>
                            {userFormRole === 'group_admin' && (
                                <div className="input-group">
                                    <label>Grupo Administrado</label>
                                    <select name="admin_group_id" defaultValue={editingItem?.admin_group_id || ''} required>
                                        <option value="">-- Seleccionar --</option>
                                        {groups.filter(g => (g.modulo || 'voltik') === 'volcan_desk').map(g => (
                                            <option key={g.id} value={g.id}>{g.name}</option>
                                        ))}
                                    </select>
                                    <small className="form-help">Podrá ver y configurar el catálogo (Tipos, Categorías, Campos, Flujos, Prioridades y SLA) solo de este grupo — no puede gestionar Usuarios.</small>
                                </div>
                            )}
                            <div className="input-group" style={{ display: userFormRole === 'group_admin' ? 'none' : undefined }}>
                                <label>Grupos Asignados</label>
                                <div className="checkbox-grid">
                                    {groups
                                        .filter(g => editingItem?.role === 'admin' || (g.modulo || 'voltik') === (editingItem ? (editingItem.modulo || 'voltik') : activeWorkspace))
                                        .map(g => (
                                            <label key={g.id} className="check-label">
                                                <input type="checkbox" name="groups" value={g.id} defaultChecked={editingItem?.groups?.includes(g.id)} />
                                                <span>{g.name}</span>
                                            </label>
                                    ))}
                                </div>
                            </div>
                        </>
                    )}
                    <div className="modal-footer">
                        <button type="button" className="btn btn-secondary" onClick={() => setShowUserModal(false)}>Cancelar</button>
                        <button type="submit" className="btn btn-primary">{editingItem ? 'Guardar' : 'Crear'}</button>
                    </div>
                </form>
            </Modal>
        </div>
    );
}
