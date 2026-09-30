import './Users.css';
import { useState, useEffect, useContext } from 'react';
import { IoShieldCheckmarkOutline, IoPeopleOutline, IoBusinessOutline } from 'react-icons/io5';
import { getUsers } from '../services/userService';
import { getGroups, loadAreaAccesoExtra } from '../services/groupService';
import { getCompanies } from '../services/companyService';
import { getCurrentUser } from '../services/authService';
import { WorkspaceContext } from '../context/WorkspaceContext';
// Las 4 pestañas de esta página se dividieron en componentes propios
// (2026-09-22) — antes las 4 vivían como un switch de JSX inline dentro de
// este mismo archivo (856 líneas). Cada pestaña ahora maneja su propio estado
// de modal/edición (nunca hay dos abiertas a la vez, así que esto es
// comportamiento idéntico) y llama a `onRefresh` para refrescar los datos
// compartidos que sí viven aquí arriba.
import UsersInternalTab from './UsersInternalTab';
import GroupsTab from './GroupsTab';
import CompaniesTab from './CompaniesTab';
import AccesosExtraTab from './AccesosExtraTab';

export default function Users() {
    const { activeWorkspace } = useContext(WorkspaceContext);
    const [activeTab, setActiveTab] = useState('internal'); // internal | groups | companies | extras
    const [users, setUsers] = useState([]);
    const [groups, setGroups] = useState([]);
    const [companies, setCompanies] = useState([]);
    const [accesosExtra, setAccesosExtra] = useState([]);

    const currentUser = getCurrentUser();
    const isAdmin = currentUser?.role === 'admin';
    // A pedido del usuario (2026-09-07): un group_admin ahora puede entrar aquí,
    // pero solo para crear cuentas Agente/Admin de Grupo de SU propio grupo — no ve
    // Grupos/Empresas/Accesos Especiales, ni puede editar/eliminar a nadie (esas
    // rutas del backend se quedan exclusivas de 'admin', sin cambios). Puede crear
    // otro group_admin desde 2026-09-14 (a pedido del usuario), pero nunca 'admin'.
    const isGroupAdmin = currentUser?.role === 'group_admin';
    const myGroupScope = isGroupAdmin ? currentUser.admin_group_id : null;

    useEffect(() => {
        refreshData();
    }, []);

    useEffect(() => {
        if (activeWorkspace === 'volcan_desk' && activeTab === 'companies') {
            setActiveTab('internal');
        }
        // group_admin solo tiene la pestaña "Usuarios Internos" — si por lo que sea
        // quedó en otra (ej. cambiando de rol sin recargar), la regresa.
        if (isGroupAdmin && activeTab !== 'internal') {
            setActiveTab('internal');
        }
    }, [activeWorkspace, activeTab, isGroupAdmin]);

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

    if (!isAdmin && !isGroupAdmin) {
        return (
            <div className="unauthorized-container">
                <IoShieldCheckmarkOutline size={64} color="var(--color-error)" />
                <h2>Acceso Denegado</h2>
                <p>Solo los administradores pueden gestionar usuarios, grupos y empresas.</p>
            </div>
        );
    }

    return (
        <div className="users-layout">
            <div className="users-page-header">
                <div className="header-info">
                    <h1>Gestión de Accesos</h1>
                    <p className="text-muted">Administra usuarios internos, grupos de trabajo y empresas externas.</p>
                </div>
            </div>

            {/* Tabs Sidebar/Top */}
            <div className="users-tabs">
                <button className={`tab-item ${activeTab === 'internal' ? 'active' : ''}`} onClick={() => setActiveTab('internal')}>
                    <IoShieldCheckmarkOutline size={18} />
                    <span>Usuarios Internos</span>
                </button>
                {/* Grupos/Empresas/Accesos Especiales quedan exclusivos de 'admin' —
                    un group_admin solo tiene "Usuarios Internos" (2026-09-07). */}
                {!isGroupAdmin && (
                    <button className={`tab-item ${activeTab === 'groups' ? 'active' : ''}`} onClick={() => setActiveTab('groups')}>
                        <IoPeopleOutline size={18} />
                        <span>Grupos de Soporte</span>
                    </button>
                )}
                {!isGroupAdmin && activeWorkspace !== 'volcan_desk' && (
                    <button className={`tab-item ${activeTab === 'companies' ? 'active' : ''}`} onClick={() => setActiveTab('companies')}>
                        <IoBusinessOutline size={18} />
                        <span>Empresas y Clientes</span>
                    </button>
                )}
                {!isGroupAdmin && (
                    <button className={`tab-item ${activeTab === 'accesos' ? 'active' : ''}`} onClick={() => setActiveTab('accesos')}>
                        <IoShieldCheckmarkOutline size={18} />
                        <span>Accesos Especiales</span>
                    </button>
                )}
            </div>

            <div className="users-tab-content">
                {activeTab === 'internal' && (
                    <UsersInternalTab
                        users={users}
                        groups={groups}
                        currentUser={currentUser}
                        isGroupAdmin={isGroupAdmin}
                        myGroupScope={myGroupScope}
                        activeWorkspace={activeWorkspace}
                        onRefresh={refreshData}
                    />
                )}
                {activeTab === 'groups' && (
                    <GroupsTab
                        groups={groups}
                        users={users}
                        activeWorkspace={activeWorkspace}
                        onRefresh={refreshData}
                    />
                )}
                {activeTab === 'companies' && (
                    <CompaniesTab
                        companies={companies}
                        onRefresh={refreshData}
                    />
                )}
                {activeTab === 'accesos' && (
                    <AccesosExtraTab
                        users={users}
                        groups={groups}
                        accesosExtra={accesosExtra}
                        activeWorkspace={activeWorkspace}
                        onRefresh={refreshData}
                    />
                )}
            </div>
        </div>
    );
}
