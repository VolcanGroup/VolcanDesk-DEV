import { useState } from 'react';
import {
    IoAddOutline, IoTrashOutline, IoPencilOutline, IoBusinessOutline,
    IoChevronForwardOutline, IoCloudUploadOutline, IoTimeOutline, IoCheckmarkCircleOutline,
    IoEyeOutline, IoEyeOffOutline
} from 'react-icons/io5';
import { createCompany, updateCompany, deleteCompany, getContacts, createContact, updateContact, deleteContact } from '../services/companyService';
import Modal from '../components/Modal';

export default function CompaniesTab({ companies, onRefresh }) {
    const [showCompanyModal, setShowCompanyModal] = useState(false);
    const [showContactModal, setShowContactModal] = useState(false);
    const [editingItem, setEditingItem] = useState(null);
    const [selectedCompany, setSelectedCompany] = useState(null);
    const [showContactPassword, setShowContactPassword] = useState(false);

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
        onRefresh();
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
        onRefresh();
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
            onRefresh();
        };
        reader.readAsDataURL(file);
    };

    return (
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
                                <button className="btn-icon btn-danger" onClick={() => { if(confirm('Eliminar empresa?')) { deleteCompany(company.id); onRefresh(); } }}><IoTrashOutline/></button>
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
                        <button className="btn btn-primary btn-sm" onClick={() => { setEditingItem(null); setShowContactPassword(false); setShowContactModal(true); }}>
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
                                    <button className="btn-icon" onClick={() => { setEditingItem(contact); setShowContactPassword(false); setShowContactModal(true); }}><IoPencilOutline/></button>
                                    <button className="btn-icon btn-danger" onClick={() => { if(confirm('Eliminar contacto?')) { deleteContact(contact.id); onRefresh(); } }}><IoTrashOutline/></button>
                                </div>
                            </div>
                        ))}
                        {getContacts(selectedCompany.id).length === 0 && <p className="empty-text">No hay contactos registrados para esta empresa.</p>}
                    </div>
                </div>
            )}

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
                    <div className="input-group">
                        <label>Contraseña</label>
                        <div style={{ position: 'relative' }}>
                            <input type={showContactPassword ? 'text' : 'password'} name="password" placeholder={editingItem ? 'Mantener actual' : 'Obligatorio'} required={!editingItem} style={{ paddingRight: 36, width: '100%', boxSizing: 'border-box' }} />
                            <button type="button" onClick={() => setShowContactPassword(v => !v)} title={showContactPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', color: 'var(--color-text-muted)', padding: 4 }}>
                                {showContactPassword ? <IoEyeOffOutline size={16} /> : <IoEyeOutline size={16} />}
                            </button>
                        </div>
                    </div>
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
        </div>
    );
}
