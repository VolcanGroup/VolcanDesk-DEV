import { IoGridOutline, IoTicketOutline, IoSendOutline, IoPeopleOutline, IoSettingsOutline, IoPersonCircleOutline } from 'react-icons/io5';
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
  // Volcán Desk: "Solicitudes" era una sola página con un selector interno
  // (Solicitudes/Atención/Todos) que a todo mundo le costaba entender — a
  // pedido del usuario (2026-09-07) se separa en dos entradas de menú
  // explícitas: qué me piden a mí/mi grupo vs. qué pedí yo/mi grupo. Voltik no
  // tiene este concepto (no hay grupo solicitante/resolutor) y se queda igual.
  const deskTicketItems = [
    { id: 'tickets-recibidas', label: 'Solicitudes Recibidas', icon: IoTicketOutline },
    { id: 'tickets-enviadas', label: 'Solicitudes Enviadas', icon: IoSendOutline },
  ];
  const ticketItems = activeWorkspace === 'volcan_desk'
    ? deskTicketItems
    : [{ id: 'tickets', label: 'Tickets', icon: IoTicketOutline }];
  const groups = [
    { label:'Principal', items:[{id:'dashboard',label:'Inicio',icon:IoGridOutline,show:!requesterOnly}, ...ticketItems] },
    // Usuarios: admin general (gestión completa) o admin de grupo (solo crear
    // Agente/Admin de Grupo para su propio grupo, 2026-09-07, ampliado 2026-09-14
    // — Users.jsx ya acota el resto). Configuración: admin general o admin de grupo (las páginas internas
    // ya acotan a group_admin a su propio grupo/catálogo).
    { label:'Administración', items:[{id:'users',label:'Usuarios',icon:IoPeopleOutline,show:admin||groupAdmin},{id:'settings',label:'Configuración',icon:IoSettingsOutline,show:admin||groupAdmin}] }
  ];
  const logo = currentTheme === 'dark' ? '/VolcanBlanco.png' : '/Logo_Volcaìn_sin_fondo.png';
  const headerClass = activeWorkspace === 'volcan_desk' ? 'sidebar-header desk-header' : 'sidebar-header';

  // Solo el logo, centrado en su espacio (2026-09-08, a pedido del usuario) —
  // antes también mostraba el nombre del módulo al lado ("Volcán Desk"/
  // "Voltik"), redundante con lo que ya dice el header arriba.
  return <aside className="sidebar"><div className={headerClass}><div className="sidebar-logo"><img src={logo} alt="Volcán" className="sidebar-logo-img"/></div></div><nav className="sidebar-nav">{groups.map(group => <div className="sidebar-group" key={group.label}><div className="sidebar-group-header">{group.label}</div><div className="sidebar-group-items expanded">{group.items.filter(i=>i.show!==false).map(item => <button key={item.id} className={`sidebar-item ${currentPage===item.id?'active':''}`} onClick={()=>onNavigate(item.id)}><item.icon size={18}/><span>{item.label}</span></button>)}</div></div>)}</nav><div className="sidebar-user"><IoPersonCircleOutline size={28}/><div><strong>{user?.name}</strong><span>{user?.role}</span></div></div></aside>;
}
