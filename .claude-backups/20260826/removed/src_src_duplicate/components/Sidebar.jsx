import { IoGridOutline, IoTicketOutline, IoStatsChartOutline, IoPeopleOutline, IoSettingsOutline, IoPersonCircleOutline } from 'react-icons/io5';
import './Sidebar.css';
import { getCurrentUser } from '../services/authService';
import { isDeskRequesterOnly } from '../services/groupService';
import { useContext } from 'react';
import { WorkspaceContext } from '../context/WorkspaceContext';

export default function Sidebar({ currentPage, onNavigate, currentTheme }) {
  const { activeWorkspace } = useContext(WorkspaceContext);
  const user = getCurrentUser();
  const admin = user?.role === 'admin';
  const groupAdmin = user?.role === 'group_admin';
  const requesterOnly = isDeskRequesterOnly(user);
  const groups = [
    { label:'Principal', items:[{id:'dashboard',label:'Inicio',icon:IoGridOutline,show:!requesterOnly},{id:'tickets',label:activeWorkspace === 'volcan_desk' ? 'Solicitudes' : 'Tickets',icon:IoTicketOutline},{id:'reports',label:'Reportes',icon:IoStatsChartOutline,show:!requesterOnly}] },
    // Usuarios: solo admin general. Configuración: admin general o admin de grupo
    // (las páginas internas ya acotan a group_admin a su propio grupo/catálogo).
    { label:'Administración', items:[{id:'users',label:'Usuarios',icon:IoPeopleOutline,show:admin},{id:'settings',label:'Configuración',icon:IoSettingsOutline,show:admin||groupAdmin}] }
  ];
  const logo = currentTheme === 'dark' ? '/VolcanBlanco.png' : '/Logo_Volcaìn_sin_fondo.png';
  const brandName = activeWorkspace === 'volcan_desk' ? 'Volcán Desk' : 'Voltik';
  const headerClass = activeWorkspace === 'volcan_desk' ? 'sidebar-header desk-header' : 'sidebar-header';
  
  return <aside className="sidebar"><div className={headerClass}><div className="sidebar-logo"><img src={logo} alt="Volcán" className="sidebar-logo-img"/><span>{brandName}</span></div></div><nav className="sidebar-nav">{groups.map(group => <div className="sidebar-group" key={group.label}><div className="sidebar-group-header">{group.label}</div><div className="sidebar-group-items expanded">{group.items.filter(i=>i.show!==false).map(item => <button key={item.id} className={`sidebar-item ${currentPage===item.id?'active':''}`} onClick={()=>onNavigate(item.id)}><item.icon size={18}/><span>{item.label}</span></button>)}</div></div>)}</nav><div className="sidebar-user"><IoPersonCircleOutline size={28}/><div><strong>{user?.name}</strong><span>{user?.role}</span></div></div></aside>;
}
