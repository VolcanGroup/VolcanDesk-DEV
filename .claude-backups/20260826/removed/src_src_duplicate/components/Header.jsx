import './Header.css';
import { IoAddOutline, IoLogOutOutline, IoChevronDownOutline, IoHeadsetOutline, IoFlameOutline } from 'react-icons/io5';
import NotificationInbox from './NotificationInbox';
import { getCompanyById } from '../services/companyService';
import { useContext, useState, useRef, useEffect } from 'react';
import { WorkspaceContext } from '../context/WorkspaceContext';

const labels = {
  dashboard: 'Inicio',
  tickets: 'Tickets',
  reports: 'Reportes',
  users: 'Usuarios',
  settings: 'Configuración'
};

export default function Header({ user, onNavigateToTicket, currentPage, onLogout }) {
  const { activeWorkspace, changeWorkspace } = useContext(WorkspaceContext);
  const [showWorkspaceMenu, setShowWorkspaceMenu] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
      const handleClickOutside = (event) => {
          if (menuRef.current && !menuRef.current.contains(event.target)) {
              setShowWorkspaceMenu(false);
          }
      };
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  let environmentName = 'Voltik';
  let subtitle = '';
  const isInternal = user?.role !== 'client';
  
  if (!isInternal) {
    const company = getCompanyById(user.companyId);
    environmentName = company ? company.name : 'Cliente';
    // Use position if available, fallback to 'Cliente'
    subtitle = user.position || 'Cliente';
  } else {
    const roleLabels = {
      admin: 'Administrador',
      group_admin: 'Admin de Grupo',
      agent: 'Agente',
      supervisor: 'Supervisor'
    };
    subtitle = roleLabels[user?.role] || user?.role || '';
    environmentName = activeWorkspace === 'volcan_desk' ? 'Volcán Desk' : 'Voltik';
  }

  // Separación estricta por módulo: un usuario agent/supervisor pertenece a UN
  // solo módulo (user.modulo, fijado al crearlo) y nunca lo cruza. Solo 'admin'
  // es un rol global que administra ambos módulos y puede cambiar libremente.
  const hasAccessToWorkspace = (workspaceName) => {
    if (user?.role === 'admin') return true;
    if (user?.role === 'client') return false;
    return (user?.modulo || 'voltik') === workspaceName;
  };

  const canSwitchWorkspace = user?.role === 'admin';

  // Agent/supervisor quedan fijos a su propio módulo — sin importar qué había
  // en localStorage (que es por navegador, no por usuario).
  useEffect(() => {
      if (isInternal && user?.role !== 'admin') {
          const userModulo = user?.modulo || 'voltik';
          if (activeWorkspace !== userModulo) {
              changeWorkspace(userModulo);
          }
      }
  }, [isInternal, user, activeWorkspace, changeWorkspace]);

  const isDesk = activeWorkspace === 'volcan_desk';
  const breadcrumbTop = (currentPage === 'tickets' && isDesk) ? 'Mesa de ayuda interna' : 'Centro de servicio';
  const pageLabel = (currentPage === 'tickets' && isDesk) ? 'Solicitudes' : (labels[currentPage] || (isDesk ? 'Volcán Desk' : 'Voltik'));

  return (
    <header className={`header ${activeWorkspace === 'volcan_desk' ? 'header-desk' : ''}`}>
      <div className="header-content">
        <div className="header-title">
          <span>{breadcrumbTop}</span>
          <h2>{pageLabel}</h2>
        </div>
        
        {/* Centered Environment indicator */}
        <div className="header-environment" ref={menuRef}>
          <div 
            className={`env-badge ${canSwitchWorkspace ? 'clickable' : ''}`} 
            title="Entorno actual de trabajo"
            onClick={() => canSwitchWorkspace && setShowWorkspaceMenu(!showWorkspaceMenu)}
            style={canSwitchWorkspace ? { cursor: 'pointer' } : {}}
          >
            {environmentName}
            {canSwitchWorkspace && <IoChevronDownOutline style={{marginLeft: '4px'}} />}
          </div>
          
          {showWorkspaceMenu && canSwitchWorkspace && (
            <div className="workspace-dropdown">
              {hasAccessToWorkspace('voltik') && (
                  <div
                    className={`workspace-option ${activeWorkspace === 'voltik' ? 'active' : ''}`}
                    onClick={() => { changeWorkspace('voltik'); setShowWorkspaceMenu(false); }}
                  >
                    <IoHeadsetOutline size={18} className="workspace-option-icon" />
                    <div className="workspace-option-text">
                      <strong>Voltik</strong>
                      <span>Centro de servicio · clientes</span>
                    </div>
                    {activeWorkspace === 'voltik' && <span className="workspace-option-check">✓</span>}
                  </div>
              )}
              {hasAccessToWorkspace('volcan_desk') && (
                  <div
                    className={`workspace-option ${activeWorkspace === 'volcan_desk' ? 'active' : ''}`}
                    onClick={() => { changeWorkspace('volcan_desk'); setShowWorkspaceMenu(false); }}
                  >
                    <IoFlameOutline size={18} className="workspace-option-icon" />
                    <div className="workspace-option-text">
                      <strong>Volcán Desk</strong>
                      <span>Mesa de ayuda interna · áreas</span>
                    </div>
                    {activeWorkspace === 'volcan_desk' && <span className="workspace-option-check">✓</span>}
                  </div>
              )}
              <div className="workspace-dropdown-footer">Cambiar no cierra tu sesión</div>
            </div>
          )}
        </div>
        
        <div className="header-actions">
          <NotificationInbox currentUser={user} onNavigateToTicket={onNavigateToTicket}/>
          
          <div className="header-divider"></div>
          
          <div className="header-user-info">
            {user?.avatar && <img src={user.avatar} alt={user.name} className="header-avatar" />}
            <div className="header-user-details">
              <span className="header-user-name">{user?.name || 'Usuario'}</span>
              <span className="header-user-role">{subtitle}</span>
            </div>
          </div>
          
          <div className="header-divider"></div>
          
          <button className="header-logout-btn" onClick={onLogout} title="Cerrar sesión">
            <IoLogOutOutline size={20}/>
            <span className="logout-text">Salir</span>
          </button>
        </div>
      </div>
    </header>
  );
}
