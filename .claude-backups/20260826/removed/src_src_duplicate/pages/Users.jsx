import './Users.css';
import { useState, useEffect, useRef } from 'react';
import { 
    IoAddOutline, IoTrashOutline, IoPencilOutline, IoPersonOutline, 
    IoBusinessOutline, IoShieldCheckmarkOutline, IoPeopleOutline, 
    IoSearchOutline, IoChevronForwardOutline, IoCloudUploadOutline, IoTimeOutline, IoCheckmarkCircleOutline 
} from 'react-icons/io5';
import { getUsers, createUser, updateUser, deleteUser } from '../services/userService';
import { getGroups, createGroup, updateGroup, deleteGroup, loadAreaAccesoExtra, createAreaAccesoExtra, deleteAreaAccesoExtra } from '../services/groupService';
import { getCompanies, createCompany, updateCompany, deleteCompany, getContacts, createContact, updateContact, deleteContact } from '../services/companyService';
import { getCurrentUser } from '../services/authService';
import { WorkspaceContext } from '../context/WorkspaceContext';
import { useContext } from 'react';
import Modal from '../components/Modal';
import Badge from '../components/Badge';

export default function Users() {
    const { activeWorkspace } = useContext(WorkspaceContext);
    const [activeTab, setActiveTab] = useState('internal'); // internal | groups | companies | extras
    const [users, setUsers] = useState([]);
    const [groups, setGroups] = useState([]);
    const [companies, setCompanies] = useState([]);
    const [accesosExtra, setAccesosExtra] = useState([]);
    
    // Modals
    const [showUserModal, setShowUserModal] = useState(false);
    const [showGroupModal, setShowGroupModal] = useState(false);
    const [showCompanyModal, setShowCompanyModal] = useState(false);
    const [showContactModal, setShowContactModal] = useState(false);
    const [showAccesoModal, setShowAccesoModal] = useState(false);
    
    // Editing
    const [editingItem, setEditingItem] = useState(null);
    const [selectedCompany, setSelectedCompany] = useState(null);
    // Rol elegido en el formulario del modal de Usuario — controla si se muestra
    // el selector de "grupo administrado" (solo aplica a group_admin).
    const [userFormRole, setUserFormRole] = useState('agent');
    
    const currentUser = getCurrentUser();
    const isAdmin = currentUser?.role === 'admin';

    useEffect(() => {
        refreshData();
    }, []);

    useEffect(() => {
        if (activeWorkspace === 'volcan_desk' && activeTab === 'companies') {
            setActiveTab('internal');
        }
    }, [activeWorkspace, activeTab]);

    const refreshData = async () => {
        setUsers(getUsers());
        setGroups(getGroups());
        setCompanies(getCompanies());
        try {
            const extra = await loadAreaAccesoExtra();
            setAccesosExtra(extra);
        } catch (e) {
            console.error(e);
        }
    };

    if (!isAdmin) {
        return (
            <div className="unauthorized-container">
                <IoShieldCheckmarkOutline size={64} color="var(--color-error)" />
                <h2>Acceso Denegado</h2>
                <p>Solo los administradores pueden gestionar usuarios, grupos y empresas.</p>
            </div>
        );
    }

    // ─── HANDLERS ────────────────────────────────────────────────────────────

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
        } else {
            // group_admin solo existe en Volcán Desk, independientemente del workspace activo.
            createUser({ ...userData, modulo: role === 'group_admin' ? 'volcan_desk' : activeWorkspace });
        }
        setShowUserModal(false);
        setEditingItem(null);
        refreshData();
    };

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
        refreshData();
    };

    const handleCompanySubmit = (e) => {
        e.preventDefault();
        const formData = new FormData(e.target);
        const data = {
            name: formData.get('name'),
            emisor: formData.get('emisor'),
            tipoSaldos: formData.get('tipoSaldos'),
            tipoBin: formData.get('tipoBin'),
            embozador: formData.get('embozador'),
            notes: formData.get('notes'),
        };

        if (editingItem) {
            updateCompany(editingItem.id, data);
        } else {
            createCompany(data);
        }
        setShowCompanyModal(false);
        setEditingItem(null);
        refreshData();
    };

    const handleContactSubmit = (e) => {
        e.preventDefault();
        const formData = new FormData(e.target);
        const data = {
            companyId: selectedCompany.id,
            name: formData.get('name'),
            email: formData.get('email'),
            password: formData.get('password') || (editingItem ? editingItem.password : ''),
            phone: formData.get('phone'),
            position: formData.get('position'),
        };

        if (editingItem) {
            updateContact(editingItem.id, data);
        } else {
            createContact(data);
        }
        setShowContactModal(false);
        setEditingItem(null);
        refreshData();
    };

    const uploadFile = (companyId, e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = (loadEvent) => {
            updateCompany(companyId, {
                funcionariosAdjunto: {
                    name: file.name,
                    dataUrl: loadEvent.target.result,
                    type: file.type,
                    uploadedAt: new Date().toISOString()
                }
            });
            refreshData();
        };
        reader.readAsDataURL(file);
    };

    // ─── HANDLERS ACCESOS EXTRA ────────────────────────────────────────────────────────────

    const handleAccesoSubmit = async (e) => {
        e.preventDefault();
        const formData = new FormData(e.target);
        const data = {
            usuario_id: formData.get('usuario_id'),
            area_id: formData.get('area_id')
        };
        await createAreaAccesoExtra(data);
        setShowAccesoModal(false);
        refreshData();
    };

    const handleDeleteAcceso = async (id) => {
        if (window.confirm('¿Eliminar este acceso especial?')) {
            await deleteAreaAccesoExtra(id);
            refreshData();
        }
    };

    // ─── RENDER HELPERS ──────────────────────────────────────────────────────

    const getRoleLabel = (role) => {
        const labels = {
            admin: 'Administrador',
            group_admin: 'Admin de Grupo',
            supervisor: 'Supervisor',
            agent: 'Ejecutivo (Agente)',
            client: 'Cliente'
        };
        return labels[role] || role;
    };

    return (
        <div className="users-layout">
            <div className="users-page-header">
                <div className="header-info">
                    <h1>👥 Gestión de Accesos</h1>
                    <p className="text-muted">Administra usuarios internos, grupos de trabajo y empresas externas.</p>
                </div>
            </div>

            {/* Tabs Sidebar/Top */}
            <div className="users-tabs">
                <button className={`tab-item ${activeTab === 'internal' ? 'active' : ''}`} onClick={() => setActiveTab('internal')}>
                    <IoShieldCheckmarkOutline size={18} />
                    <span>Usuarios Internos</span>
                </button>
                <button className={`tab-item ${activeTab === 'groups' ? 'active' : ''}`} onClick={() => setActiveTab('groups')}>
                    <IoPeopleOutline size={18} />
                    <span>Grupos de Soporte</span>
                </button>
                {activeWorkspace !== 'volcan_desk' && (
                    <button className={`tab-item ${activeTab === 'companies' ? 'active' : ''}`} onClick={() => setActiveTab('companies')}>
                        <IoBusinessOutline size={18} />
                        <span>Empresas y Clientes</span>
                    </button>
                )}
                <button className={`tab-item ${activeTab === 'accesos' ? 'active' : ''}`} onClick={() => setActiveTab('accesos')}>
                    <IoShieldCheckmarkOutline size={18} />
                    <span>Accesos Especiales</span>
                </button>
            </div>

            <div className="users-tab-content">
                {/* ─── Tab: Internal Users ─── */}
                {activeTab === 'internal' && (
                    <div className="tab-pane fade-in">
                        <div className="pane-header">
                            <h2>Usuarios Administrativos</h2>
                            <button className="btn btn-primary" onClick={() => { setEditingItem(null); setUserFormRole('agent'); setShowUserModal(true); }}>
                                <IoAddOutline size={18} /> Nuevo Usuario
                            </button>
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
                                        .filter(u => u.role === 'admin' || u.role === 'group_admin' || u.role === 'agent' || u.role === 'supervisor')
                                        .filter(u => u.role === 'admin' || (u.modulo || 'voltik') === activeWorkspace)
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
                                                    <Badge variant={user.role === 'admin' ? 'error' : user.role === 'group_admin' ? 'error' : user.role === 'supervisor' ? 'success' : 'warning'}>
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
                                                    <div className="table-actions">
                                                        <button className="btn-icon-sm" title="Editar" onClick={() => { setEditingItem(user); setUserFormRole(user.role); setShowUserModal(true); }}><IoPencilOutline size={13}/></button>
                                                        <button className="btn-icon-sm danger" title="Eliminar" disabled={user.id === currentUser.id} onClick={() => { if(confirm('¿Eliminar usuario?')) { deleteUser(user.id); refreshData(); } }}><IoTrashOutline size={13}/></button>
                                                    </div>
                                                </td>
                                            </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {/* ─── Tab: Groups ─── */}
                {activeTab === 'groups' && (
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
                                                        <button className="btn-icon-sm danger" title="Eliminar" onClick={() => { if(confirm('¿Eliminar grupo?')) { deleteGroup(group.id); refreshData(); } }}><IoTrashOutline size={13}/></button>
                                                    </div>
                                                </td>
                                            </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {/* ─── Tab: Companies ─── */}
                {activeTab === 'companies' && (
                    <div className="tab-pane fade-in">
                        <div className="pane-header">
                            <h2>Cartera de Empresas</h2>
                            <button className="btn btn-primary" onClick={() => { setEditingItem(null); setShowCompanyModal(true); }}>
                                <IoAddOutline size={18} /> Nueva Empresa
                            </button>
                        </div>
                        <div className="company-grid">
                            {companies.map(company => (
                                <div key={company.id} className="company-card">
                                    <div className="company-card-header">
                                        <div className="company-icon"><IoBusinessOutline size={28}/></div>
                                        <div className="company-title">
                                            <h3>{company.name}</h3>
                                            <span className="company-emisor">BIN: {company.emisor}</span>
                                        </div>
                                        <div className="company-actions-top">
                                            <button className="btn-icon" onClick={() => { setEditingItem(company); setShowCompanyModal(true); }}><IoPencilOutline/></button>
                                            <button className="btn-icon btn-danger" onClick={() => { if(confirm('Eliminar empresa?')) { deleteCompany(company.id); refreshData(); } }}><IoTrashOutline/></button>
                                        </div>
                                    </div>
                                    <div className="company-details">
                                        <div className="detail-row"><span>Saldos:</span> <strong>{company.tipoSaldos}</strong></div>
                                        <div className="detail-row"><span>Tipo BIN:</span> <strong>{company.tipoBin}</strong></div>
                                        <div className="detail-row"><span>Embozador:</span> <strong>{company.embozador || 'N/A'}</strong></div>
                                        
                                        <div className="company-attachment">
                                            <label className="attachment-label">
                                                <IoCloudUploadOutline /> Funcionarios Autorizados
                                                <input type="file" onChange={(e) => uploadFile(company.id, e)} hidden />
                                            </label>
                                            {company.funcionariosAdjunto && (
                                                <div className="attachment-info">
                                                    <IoCheckmarkCircleOutline color="var(--color-success)"/> 
                                                    <span>{company.funcionariosAdjunto.name}</span>
                                                    <div className="timestamp"><IoTimeOutline/> {new Date(company.funcionariosAdjunto.uploadedAt).toLocaleString()}</div>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                    <div className="company-footer">
                                        <button className="btn btn-secondary btn-sm" onClick={() => { setSelectedCompany(company); }}>
                                            Gestionar Contactos ({getContacts(company.id).length})
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                        
                        {/* Sub-pane: contacts for selected company */}
                        {selectedCompany && (
                            <div className="contacts-subpane fade-in">
                                <div className="subpane-header">
                                    <div className="subpane-title">
                                        <button className="btn-back" onClick={() => setSelectedCompany(null)}><IoChevronForwardOutline style={{transform:'rotate(180deg)'}}/></button>
                                        <h3>Contactos: {selectedCompany.name}</h3>
                                    </div>
                                    <button className="btn btn-primary btn-sm" onClick={() => { setEditingItem(null); setShowContactModal(true); }}>
                                        <IoAddOutline/> Nuevo Contacto
                                    </button>
                                </div>
                                <div className="contact-list">
                                    {getContacts(selectedCompany.id).map(contact => (
                                        <div key={contact.id} className="contact-row">
                                            <img src={contact.avatar} alt="" className="contact-avatar"/>
                                            <div className="contact-info">
                                                <strong>{contact.name}</strong>
                                                <span>{contact.email}</span>
                                            </div>
                                            <div className="contact-meta">
                                                <span>{contact.position || 'Sin puesto'}</span>
                                                <span>{contact.phone}</span>
                                            </div>
                                            <div className="contact-actions">
                                                <button className="btn-icon" onClick={() => { setEditingItem(contact); setShowContactModal(true); }}><IoPencilOutline/></button>
                                                <button className="btn-icon btn-danger" onClick={() => { if(confirm('Eliminar contacto?')) { deleteContact(contact.id); refreshData(); } }}><IoTrashOutline/></button>
                                            </div>
                                        </div>
                                    ))}
                                    {getContacts(selectedCompany.id).length === 0 && <p className="empty-text">No hay contactos registrados para esta empresa.</p>}
                                </div>
                            </div>
                        )}
                    </div>
                )}
                
                {/* ─── Tab: Accesos Especiales ─── */}
                {activeTab === 'accesos' && (
                    <div className="tab-pane fade-in">
                        <div className="pane-header">
                            <div>
                                <h2>Accesos Cruzados (Extra)</h2>
                                <p className="text-muted" style={{fontSize: '0.85rem', marginTop: '4px'}}>
                                    Permite a un agente ver o editar tickets de un área a la que normalmente no pertenece.
                                </p>
                            </div>
                            <button className="btn btn-primary" onClick={() => setShowAccesoModal(true)}>
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
                    </div>
                )}
            </div>

            {/* ─── MODALS ─────────────────────────────────────────────────── */}

            {/* User Modal */}
            <Modal isOpen={showUserModal} onClose={() => setShowUserModal(false)} title={editingItem ? 'Editar Usuario' : 'Nuevo Usuario Interno'}>
                <form onSubmit={handleUserSubmit}>
                    <div className="input-group"><label>Nombre</label><input name="name" defaultValue={editingItem?.name} required /></div>
                    <div className="input-group"><label>Email</label><input type="email" name="email" defaultValue={editingItem?.email} required /></div>
                    <div className="input-group"><label>Password</label><input type="password" name="password" placeholder={editingItem ? 'Mantener actual' : 'Obligatorio'} required={!editingItem} /></div>
                    <div className="input-group">
                        <label>Rol</label>
                        <select name="role" defaultValue={editingItem?.role || 'agent'} onChange={e => setUserFormRole(e.target.value)}>
                            <option value="admin">Administrador (Todo)</option>
                            {(activeWorkspace === 'volcan_desk' || editingItem?.role === 'group_admin') && (
                                <option value="group_admin">Admin de Grupo (Volcán Desk)</option>
                            )}
                            <option value="supervisor">Supervisor (Ver Todo)</option>
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
                    <div className="modal-footer">
                        <button type="button" className="btn btn-secondary" onClick={() => setShowUserModal(false)}>Cancelar</button>
                        <button type="submit" className="btn btn-primary">{editingItem ? 'Guardar' : 'Crear'}</button>
                    </div>
                </form>
            </Modal>

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

            {/* Company Modal */}
            <Modal isOpen={showCompanyModal} onClose={() => setShowCompanyModal(false)} title={editingItem ? 'Editar Empresa' : 'Nueva Empresa'}>
                <form onSubmit={handleCompanySubmit}>
                    <div className="input-group"><label>Nombre de la Empresa *</label><input name="name" defaultValue={editingItem?.name} required /></div>
                    <div className="input-group"><label>Emisor (BIN) *</label><input name="emisor" defaultValue={editingItem?.emisor} required /></div>
                    <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:16}}>
                        <div className="input-group">
                            <label>Tipo de Saldos</label>
                            <select name="tipoSaldos" defaultValue={editingItem?.tipoSaldos || 'internos'}>
                                <option value="internos">Internos</option>
                                <option value="externos">Externos</option>
                            </select>
                        </div>
                        <div className="input-group">
                            <label>Tipo de BIN</label>
                            <select name="tipoBin" defaultValue={editingItem?.tipoBin || 'sponsor'}>
                                <option value="sponsor">Sponsor</option>
                                <option value="miembro_principal">Miembro Principal</option>
                            </select>
                        </div>
                    </div>
                    <div className="input-group">
                        <label>Embozador</label>
                        <select name="embozador" defaultValue={editingItem?.embozador || ''}>
                            <option value="">Seleccionar...</option>
                            <option value="Mycard">Mycard</option>
                            <option value="forza">Forza</option>
                            <option value="banet">Banet</option>
                            <option value="Idemia">Idemia</option>
                            <option value="plasticard">Plasticard</option>
                            <option value="otro">Otro</option>
                        </select>
                    </div>
                    <div className="input-group"><label>Notas</label><textarea name="notes" defaultValue={editingItem?.notes} rows="2" /></div>
                    <div className="modal-footer">
                        <button type="button" className="btn btn-secondary" onClick={() => setShowCompanyModal(false)}>Cancelar</button>
                        <button type="submit" className="btn btn-primary">Guardar</button>
                    </div>
                </form>
            </Modal>

            {/* Contact Modal */}
            <Modal isOpen={showContactModal} onClose={() => setShowContactModal(false)} title={editingItem ? 'Editar Contacto' : 'Nuevo Contacto de Empresa'}>
                <form onSubmit={handleContactSubmit}>
                    <div className="input-group"><label>Nombre Completo *</label><input name="name" defaultValue={editingItem?.name} required /></div>
                    <div className="input-group"><label>Correo Electrónico *</label><input type="email" name="email" defaultValue={editingItem?.email} required /></div>
                    <div className="input-group"><label>Contraseña</label><input type="password" name="password" placeholder={editingItem ? 'Mantener actual' : 'Obligatorio'} required={!editingItem} /></div>
                    <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:16}}>
                        <div className="input-group"><label>Teléfono</label><input name="phone" defaultValue={editingItem?.phone} /></div>
                        <div className="input-group"><label>Puesto</label><input name="position" defaultValue={editingItem?.position} /></div>
                    </div>
                    <div className="modal-footer">
                        <button type="button" className="btn btn-secondary" onClick={() => setShowContactModal(false)}>Cancelar</button>
                        <button type="submit" className="btn btn-primary">Guardar</button>
                    </div>
                </form>
            </Modal>

            {/* Acceso Modal */}
            <Modal isOpen={showAccesoModal} onClose={() => setShowAccesoModal(false)} title="Otorgar Acceso Especial">
                <form onSubmit={handleAccesoSubmit}>
                    <div className="input-group">
                        <label>Usuario (Agente)</label>
                        <select name="usuario_id" required>
                            <option value="">Seleccione un usuario...</option>
                            {users.filter(u => u.role === 'agent' || u.role === 'supervisor').map(u => (
                                <option key={u.id} value={u.id}>{u.name} ({u.email})</option>
                            ))}
                        </select>
                    </div>
                    <div className="input-group">
                        <label>Área a la que tendrá acceso</label>
                        <select name="area_id" required>
                            <option value="">-- Seleccionar Área --</option>
                            {groups.filter(g => (g.modulo || 'voltik') === activeWorkspace).map(g => (
                                <option key={g.id} value={g.id}>{g.name}</option>
                            ))}
                        </select>
                    </div>
                    <div className="modal-footer">
                        <button type="button" className="btn btn-secondary" onClick={() => setShowAccesoModal(false)}>Cancelar</button>
                        <button type="submit" className="btn btn-primary">Otorgar</button>
                    </div>
                </form>
            </Modal>
        </div>
    );
}
