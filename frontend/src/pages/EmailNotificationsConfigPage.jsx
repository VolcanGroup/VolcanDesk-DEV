import { useState } from 'react';
import { IoArrowBack, IoMailOutline, IoPeopleOutline, IoChevronForwardOutline } from 'react-icons/io5';
import { getGroupEmailNotificationSettings, updateGroupEmailNotificationSetting } from '../services/configService';
import { getGroups } from '../services/groupService';
import { getCurrentUser } from '../services/authService';
import { GroupScopeBreadcrumb } from '../components/GroupScopeGate';

// ─── Notificaciones por correo (Volcán Desk, agregado 2026-08-27) ────────────
// 4 interruptores independientes por grupo — NO es un módulo general on/off: cada
// grupo decide por su cuenta cuáles de estos 4 escenarios le disparan correo (a
// pedido explícito del usuario). admin general elige el grupo primero (igual que
// Tipos/Categorías/Prioridades); group_admin ya tiene su único grupo preseleccionado
// y nunca ve el selector ni el de ningún otro grupo.
const EMAIL_EVENTS = [
    { key: 'nuevoTicketAsignado', label: 'Ticket nuevo asignado a un agente', description: 'Cuando un ticket nace ya con un responsable, se le avisa por correo a esa persona.' },
    { key: 'nuevoTicketSinAsignar', label: 'Ticket nuevo sin asignar', description: 'Cuando un ticket cae a la bandeja del grupo sin responsable, se avisa a todo el grupo (group_admin y agentes).' },
    { key: 'respuestaSolicitante', label: 'El solicitante responde', description: 'Avisa al responsable del ticket cuando el solicitante agrega un comentario público (no notas privadas).' },
    { key: 'respuestaResolutor', label: 'El resolutor responde', description: 'Avisa al solicitante cuando alguien del grupo resolutor agrega un comentario público (no notas privadas).' },
    { key: 'mencion', label: 'Te mencionan (@)', description: 'Avisa a la persona cuando alguien la @menciona en un comentario, público o nota privada.' },
    { key: 'respuestaApoyo', label: 'El grupo de apoyo responde', description: 'Avisa al Resolutor original cuando alguien del grupo al que le pidió apoyo comenta en el ticket.' },
    { key: 'nuevoApoyoSolicitado', label: 'Le piden apoyo a tu grupo', description: 'Avisa a todo el grupo (group_admin y agentes) cuando otro grupo solicita su apoyo en un ticket.' },
];

export default function EmailNotificationsConfigPage({ onBack }) {
    const currentUser = getCurrentUser();
    const isGroupAdminUser = currentUser?.role === 'group_admin';
    const deskGroups = getGroups().filter(g => g.modulo === 'volcan_desk' && (!isGroupAdminUser || g.id === currentUser.admin_group_id));
    const [selectedGroupId, setSelectedGroupId] = useState(isGroupAdminUser ? currentUser.admin_group_id : null);
    // Snapshot local de settings por grupo — se refresca leyendo configService tras
    // cada cambio, igual que el resto de las páginas de esta sección.
    const [settings, setSettings] = useState(() => getGroupEmailNotificationSettings(selectedGroupId));
    const [savingKey, setSavingKey] = useState(null);

    const groupName = deskGroups.find(g => g.id === selectedGroupId)?.name || '';
    const isEnabled = (key) => settings[key] !== false; // default ON hasta que se apague explícitamente

    const handleToggle = async (key) => {
        const nextValue = !isEnabled(key);
        setSavingKey(key);
        try {
            await updateGroupEmailNotificationSetting(selectedGroupId, key, nextValue);
            setSettings(getGroupEmailNotificationSettings(selectedGroupId));
        } catch (err) {
            console.error('Error al actualizar la notificación:', err);
            alert('No se pudo guardar el cambio. Intenta de nuevo.');
        } finally {
            setSavingKey(null);
        }
    };

    if (!selectedGroupId) {
        return (
            <div className="settings-detail-page">
                <div className="settings-detail-header">
                    <button className="settings-back-btn" onClick={onBack}><IoArrowBack size={18} /> Configuración</button>
                    <div className="settings-detail-title-row">
                        <div className="settings-section-icon" style={{ background: '#0891b218', color: '#0891b2' }}><IoMailOutline size={22} /></div>
                        <div><h1>Notificaciones por correo</h1><p>Elige qué correos automáticos recibe cada grupo.</p></div>
                    </div>
                </div>
                <div className="settings-detail-body" style={{ display: 'block' }}>
                    <div className="gsg-picker">
                        <p className="gsg-picker-hint">Elige un grupo de soporte para configurar sus notificaciones. Cada grupo decide por su cuenta.</p>
                        <div className="gsg-group-grid">
                            {deskGroups.map(g => (
                                <button key={g.id} className="gsg-group-card" onClick={() => { setSelectedGroupId(g.id); setSettings(getGroupEmailNotificationSettings(g.id)); }}>
                                    <div className="gsg-group-icon"><IoPeopleOutline size={18} /></div>
                                    <div className="gsg-group-body"><div className="gsg-group-name">{g.name}</div></div>
                                    <IoChevronForwardOutline size={16} className="gsg-group-arrow" />
                                </button>
                            ))}
                            {deskGroups.length === 0 && (
                                <div className="gsg-empty">No hay grupos de soporte creados todavía para Volcán Desk.</div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="settings-detail-page">
            <div className="settings-detail-header">
                <button className="settings-back-btn" onClick={onBack}><IoArrowBack size={18} /> Configuración</button>
                <div className="settings-detail-title-row">
                    <div className="settings-section-icon" style={{ background: '#0891b218', color: '#0891b2' }}><IoMailOutline size={22} /></div>
                    <div><h1>Notificaciones por correo</h1><p>Elige qué correos automáticos recibe cada grupo.</p></div>
                </div>
            </div>
            <div className="settings-detail-body" style={{ display: 'block' }}>
                {!isGroupAdminUser && (
                    <GroupScopeBreadcrumb groupName={groupName} onChangeGroup={() => setSelectedGroupId(null)} />
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
                    {EMAIL_EVENTS.map(ev => (
                        <div key={ev.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '14px 18px' }}>
                            <div>
                                <div style={{ fontWeight: 600, fontSize: '0.92rem', color: '#1e293b' }}>{ev.label}</div>
                                <div style={{ fontSize: '0.8rem', color: '#64748b', marginTop: 2 }}>{ev.description}</div>
                            </div>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: savingKey === ev.key ? 'wait' : 'pointer', flexShrink: 0 }}>
                                <input
                                    type="checkbox"
                                    checked={isEnabled(ev.key)}
                                    disabled={savingKey === ev.key}
                                    onChange={() => handleToggle(ev.key)}
                                    style={{ width: 18, height: 18, cursor: 'inherit' }}
                                />
                                <span style={{ fontSize: '0.82rem', fontWeight: 600, color: isEnabled(ev.key) ? '#16a34a' : '#94a3b8', minWidth: 60 }}>
                                    {isEnabled(ev.key) ? 'Activado' : 'Apagado'}
                                </span>
                            </label>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
