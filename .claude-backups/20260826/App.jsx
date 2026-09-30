import './App.css';
import { useState, useEffect } from 'react';
import { login, logout, getCurrentUser, isAuthenticated } from './services/authService';
import Sidebar from './components/Sidebar';
import Header from './components/Header';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Tickets from './pages/Tickets';
import Kanban from './pages/Kanban';
import Reports from './pages/Reports';
import Users from './pages/Users';
import Settings from './pages/Settings';
import { loadConfigFromServer } from './services/configService';
import { loadCompaniesFromServer } from './services/companyService';
import { loadUsersFromServer } from './services/userService';
import { loadTicketsFromServer } from './services/ticketService';
import { loadGroupsFromServer, isDeskRequesterOnly } from './services/groupService';
import { WorkspaceProvider } from './context/WorkspaceContext';

export default function App() {
    const [currentPage, setCurrentPage] = useState('dashboard');
    const [user, setUser] = useState(null);
    const [theme, setTheme] = useState(localStorage.getItem('theme') || 'light');
    const [loading, setLoading] = useState(true);
    const [createTicketTrigger, setCreateTicketTrigger] = useState(0);
    const [ticketsViewKey, setTicketsViewKey] = useState(0);

    useEffect(() => {
        const initData = async () => {
            try {
                // Sincronizar configuración global
                await loadConfigFromServer();
                // Sincronizar compañías
                await loadCompaniesFromServer();
                // Sincronizar usuarios (incluye clientes/contactos)
                await loadUsersFromServer();
                // Sincronizar grupos de soporte
                await loadGroupsFromServer();
                // Sincronizar tickets
                await loadTicketsFromServer();
                
                if (isAuthenticated()) {
                    setUser(getCurrentUser());
                }
            } catch (err) {
                console.error("Error al inicializar datos:", err);
            } finally {
                setLoading(false);
            }
        };
        initData();
    }, []);

    // Los solicitantes puros de Volcán Desk no tienen Inicio/Reportes en el
    // sidebar; si quedan en 'dashboard'/'reports' (estado inicial o sesión
    // recién cargada) los mandamos a Tickets, su única sección disponible.
    useEffect(() => {
        if (user && isDeskRequesterOnly(user) && (currentPage === 'dashboard' || currentPage === 'reports')) {
            setCurrentPage('tickets');
        }
    }, [user, currentPage]);

    useEffect(() => {
        document.documentElement.classList.remove('theme-dark', 'theme-oceano', 'theme-gradiente', 'theme-tierra');
        if (theme !== 'light') {
            document.documentElement.classList.add(`theme-${theme}`);
        }
        localStorage.setItem('theme', theme);
    }, [theme]);

    const handleLogin = (email, password) => {
        const loggedInUser = login(email, password);
        if (loggedInUser) {
            setUser(loggedInUser);
            return true;
        }
        return false;
    };

    const handleLogout = () => {
        logout();
        setUser(null);
        setCurrentPage('dashboard');
    };

    const handleNavigateToTicket = (ticketId) => {
        setCurrentPage('tickets');
        if (ticketId) {
            sessionStorage.setItem('openTicketId', ticketId);
        } else {
            setCreateTicketTrigger(prev => prev + 1);
        }
    };

    const handleSelectTheme = (newTheme) => {
        setTheme(newTheme);
    };

    if (loading) {
        return (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', background: '#0f172a', color: '#fff', flexDirection: 'column', gap: '1rem', fontFamily: 'Inter, sans-serif' }}>
                <div style={{ width: '40px', height: '40px', border: '4px solid #38bdf8', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                <span style={{ fontSize: '1.1rem', fontWeight: 500 }}>Cargando...</span>
                <style>{`
                    @keyframes spin {
                        to { transform: rotate(360deg); }
                    }
                `}</style>
            </div>
        );
    }

    if (!user) {
        return <Login onLogin={handleLogin} />;
    }

    const renderPage = () => {
        switch (currentPage) {
            case 'dashboard':
                return <Dashboard />;
            case 'tickets':
                return <Tickets key={ticketsViewKey} createTicketTrigger={createTicketTrigger} />;
            case 'kanban':
                return <Kanban />;
            case 'reports':
                return <Reports />;
            case 'users':
                return <Users />;
            case 'settings':
                return <Settings />;
            default:
                return <Dashboard />;
        }
    };

    return (
        <WorkspaceProvider>
            <div className="app">
                <Sidebar 
                    currentPage={currentPage} 
                    onNavigate={(page) => {
                        if (page === 'tickets') {
                            setTicketsViewKey(prev => prev + 1);
                            sessionStorage.removeItem('openTicketId');
                        }
                        setCurrentPage(page);
                    }} 
                    currentTheme={theme} 
                />
                <div className="main-layout">
                    <Header user={user} onLogout={handleLogout} onNavigateToTicket={handleNavigateToTicket} onSelectTheme={handleSelectTheme} currentTheme={theme} currentPage={currentPage} />
                    <main className="main-content">
                        {renderPage()}
                    </main>
                </div>
            </div>
        </WorkspaceProvider>
    );
}
