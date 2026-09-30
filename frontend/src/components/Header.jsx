import './Header.css';
import { IoLogOutOutline, IoKeyOutline } from 'react-icons/io5';
import NotificationInbox from './NotificationInbox';
import Modal from './Modal';
import { getCompanyById } from '../services/companyService';
import { getGroupById } from '../services/groupService';
import { changePassword } from '../services/authService';
import { useContext, useEffect, useState } from 'react';
import { WorkspaceContext } from '../context/WorkspaceContext';

const labels = {
  dashboard: 'Inicio',
  tickets: 'Tickets',
  'tickets-recibidas': 'Solicitudes Recibidas',
  'tickets-enviadas': 'Solicitudes Enviadas',
  users: 'Usuarios',
  settings: 'Configuración'
};

export default function Header({ user, onNavigateToTicket, currentPage, onLogout }) {
  const { activeWorkspace, changeWorkspace } = useContext(WorkspaceContext);

  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);

  const closePasswordModal = () => {
    setShowPasswordModal(false);
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setPasswordError('');
    setPasswordSuccess('');
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    setPasswordError('');
    setPasswordSuccess('');

    if (!currentPassword || !newPassword || !confirmPassword) {
      setPasswordError('Completa todos los campos');
      return;
    }
    if (newPassword.length < 6) {
      setPasswordError('La nueva contraseña debe tener al menos 6 caracteres');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('Las contraseñas no coinciden');
      return;
    }

    setPasswordLoading(true);
    try {
      await changePassword(currentPassword, newPassword);
      setPasswordSuccess('Contraseña actualizada correctamente');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setPasswordError(err.message || 'No se pudo cambiar la contraseña');
    } finally {
      setPasswordLoading(false);
    }
  };

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
      agent: 'Agente'
    };
    subtitle = roleLabels[user?.role] || user?.role || '';
    environmentName = activeWorkspace === 'volcan_desk' ? 'Volcán Desk' : 'Voltik';
  }

  // El badge central ya no es un selector de entorno (2026-09-07, a pedido del
  // usuario: "quita ya ese switch... ya no tiene sentido") — ahora identifica
  // el GRUPO real del usuario dentro de su módulo. Un admin general no
  // pertenece a ningún grupo, así que cae al nombre del entorno como antes.
  let groupBadgeLabel = environmentName;
  if (isInternal && user?.role !== 'admin') {
    const groupId = user?.role === 'group_admin' ? user?.admin_group_id : (user?.groups || [])[0];
    const group = groupId ? getGroupById(groupId) : null;
    if (group) groupBadgeLabel = group.name;
  }

  // Agent queda fijo a su propio módulo — sin importar qué había
  // en localStorage (que es por navegador, no por usuario). Esto sigue siendo
  // necesario aunque ya no haya UI para cambiar de módulo a mano: sin este
  // efecto, un agent que entra con el localStorage de otro usuario
  // (mismo navegador compartido) vería el módulo equivocado.
  useEffect(() => {
      if (isInternal && user?.role !== 'admin') {
          const userModulo = user?.modulo || 'voltik';
          if (activeWorkspace !== userModulo) {
              changeWorkspace(userModulo);
          }
      }
  }, [isInternal, user, activeWorkspace, changeWorkspace]);

  const isDesk = activeWorkspace === 'volcan_desk';
  // "Solicitudes" (una sola página) se separó en dos (Recibidas/Enviadas,
  // 2026-09-07) — currentPage ya no es siempre 'tickets' en Volcán Desk.
  const isDeskTicketsPage = isDesk && (currentPage === 'tickets-recibidas' || currentPage === 'tickets-enviadas');
  // "Centro de servicio" es el nombre de Voltik (centro de servicio a clientes)
  // — no aplicaba a Volcán Desk y quedaba mostrándose igual en Inicio/Usuarios/
  // Configuración (2026-09-08, reportado en vivo). Fuera de las páginas de
  // tickets (que ya dicen "Mesa de ayuda interna"), Volcán Desk muestra su
  // propio nombre.
  // Antes decía "Volcán Desk" también fuera de las páginas de tickets — pero
  // el badge de la derecha (env-badge) ya dice lo mismo cuando el usuario no
  // tiene grupo propio (ej. admin general), mostrando "VOLCÁN DESK" dos veces
  // en la misma barra (reportado en vivo 2026-09-17). En Voltik no hay ese
  // choque (el badge de la derecha siempre muestra el grupo/empresa, nunca
  // "Centro de servicio"), así que ese caso queda igual.
  const breadcrumbTop = isDeskTicketsPage ? 'Mesa de ayuda interna' : (isDesk ? '' : 'Centro de servicio');

  return (
    <header className={`header ${activeWorkspace === 'volcan_desk' ? 'header-desk' : ''}`}>
      <div className="header-content">
        {/* Antes traía debajo el nombre de la página (ej. "Solicitudes
            Recibidas") — quitado (2026-09-07, a pedido del usuario) porque
            cada página ya repite su propio título en el contenido; quedaba
            duplicado. Centrado dentro de su columna en vez de pegado a la
            izquierda. */}
        {/* El div se queda siempre montado (fija el 50% de ancho vía CSS que
            mantiene centrado el badge de environment, absoluto pero dentro
            de este flex) — solo el texto adentro es condicional. */}
        <div className="header-title">
          {breadcrumbTop && <span>{breadcrumbTop}</span>}
        </div>

        {/* Antes era un selector de entorno (Voltik/Volcán Desk) — quitado
            (2026-09-07): ya no tiene sentido mantenerlo aquí. Ahora identifica
            el grupo real del usuario dentro de su módulo, sin funcionalidad
            de cambio. */}
        <div className="header-environment">
          <div className="env-badge" title="Tu grupo">
            {groupBadgeLabel}
          </div>
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

          <button className="header-logout-btn" onClick={() => setShowPasswordModal(true)} title="Cambiar contraseña">
            <IoKeyOutline size={20}/>
            <span className="logout-text">Contraseña</span>
          </button>

          <div className="header-divider"></div>

          <button className="header-logout-btn" onClick={onLogout} title="Cerrar sesión">
            <IoLogOutOutline size={20}/>
            <span className="logout-text">Salir</span>
          </button>
        </div>
      </div>

      <Modal
        isOpen={showPasswordModal}
        onClose={closePasswordModal}
        title="Cambiar contraseña"
        footer={
          <>
            <button className="btn btn-secondary" onClick={closePasswordModal}>Cerrar</button>
            <button className="btn btn-primary" onClick={handleChangePassword} disabled={passwordLoading}>
              {passwordLoading ? 'Guardando...' : 'Guardar'}
            </button>
          </>
        }
      >
        <form onSubmit={handleChangePassword}>
          {passwordError && <div className="login-error" style={{ marginBottom: 'var(--spacing-md)' }}>{passwordError}</div>}
          {passwordSuccess && <div style={{ marginBottom: 'var(--spacing-md)', color: 'var(--color-success, #16a34a)', fontSize: 'var(--font-size-sm)' }}>{passwordSuccess}</div>}

          <div className="input-group">
            <label>Contraseña actual</label>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>

          <div className="input-group">
            <label>Nueva contraseña</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>

          <div className="input-group">
            <label>Confirmar nueva contraseña</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>
        </form>
      </Modal>
    </header>
  );
}
