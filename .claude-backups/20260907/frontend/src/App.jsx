import './App.css';
import { useState, useEffect } from 'react';
import { login, logout, getCurrentUser, isAuthenticated } from './services/authService';
import Sidebar from './components/Sidebar';
import Header from './components/Header';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Tickets from './pages/Tickets';
import Reports from './pages/Reports';
import Users from './pages/Users';
import Settings from './pages/Settings';
import { loadConfigFromServer } from './services/configService';
import { loadCompaniesFromServer } from './services/companyService';
import { loadUsersFromServer } from './services/userService';
import { loadTicketsFromServer } from './services/ticketService';
import { loadGroupsFromServer, isDeskRequesterOnly } from './services/groupService';
import { WorkspaceProvider } from './context/WorkspaceContext';

// Sin router: currentPage vive en sessionStorage (sobrevive a F5) y también
// se refleja en el historial del navegador (window.history) para que
// "atrás"/"adelante" naveguen dentro de la app en vez de sacar al usuario
// del sitio — antes F5 siempre volvía a "Inicio" y "atrás" salía del todo.
const PAGE_STORAGE_KEY = 'tms_current_page';

export default function App() {
    const [currentPage, setCurrentPageRaw] = useState(() => {
        try {
            // Un link compartido a un ticket (/tickets/VD-... — el formato que usa
            // emailService.js en los correos, o el ?ticket=VD-... más viejo) siempre
            // debe caer en Tickets, sin importar qué página quedó guardada de una
            // sesión previa.
            const hasSharedTicketLink = /^\/tickets\//.test(window.location.pathname)
                || new URLSearchParams(window.location.search).get('ticket');
            if (hasSharedTicketLink) return 'tickets';
            return sessionStorage.getItem(PAGE_STORAGE_KEY) || 'dashboard';
        } catch (e) { return 'dashboard'; }
    });
    // Navegación real de usuario: agrega una entrada nueva al historial.
    const navigateToPage = (page) => {
        setCurrentPageRaw(page);
        try { sessionStorage.setItem(PAGE_STORAGE_KEY, page); } catch (e) {}
        window.history.pushState({ ...(window.history.state || {}), page, ticketId: null }, '');
    };
    const [user, setUser] = useState(null);
    const [theme, setTheme] = useState(localStorage.getItem('theme') || 'light');
    const [loading, setLoading] = useState(true);
    const [createTicketTrigger, setCreateTicketTrigger] = useState(0);
    const [ticketsViewKey, setTicketsViewKey] = useState(0);

    useEffect(() => {
        const initData = async () => {
            try {
                // Sincronizar configuración global y catálogos públicos (no requieren sesión)
                await loadConfigFromServer();
                await loadCompaniesFromServer();
                await loadGroupsFromServer();

                // Usuarios y tickets ahora exigen autenticación en el backend
                // (GET /api/users y GET /api/tickets con requireAuthenticated) —
                // antes se sincronizaban aquí siempre, incluso en la pantalla de
                // login, que es justo lo que permitía descargar la lista completa
                // de usuarios (con password) sin haber iniciado sesión.
                if (isAuthenticated()) {
                    setUser(getCurrentUser());
                    await loadUsersFromServer();
                    await loadTicketsFromServer();
                }
            } catch (err) {
                console.error("Error al inicializar datos:", err);
            } finally {
                setLoading(false);
            }
        };
        initData();

        // Ancla el estado en la entrada de historial ya existente (la del propio
        // carga de página) — se mezcla con lo que ya tenga (p. ej. un ticketId que
        // Tickets.jsx haya puesto en el mismo ciclo de montaje) en vez de pisarlo.
        window.history.replaceState({ ...(window.history.state || {}), page: currentPage }, '');
        const handlePopState = (e) => {
            const page = e.state?.page || 'dashboard';
            setCurrentPageRaw(page);
            try { sessionStorage.setItem(PAGE_STORAGE_KEY, page); } catch (err) {}
        };
        window.addEventListener('popstate', handlePopState);
        return () => window.removeEventListener('popstate', handlePopState);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Los solicitantes puros de Volcán Desk no tienen Inicio/Reportes en el
    // sidebar; si quedan en 'dashboard'/'reports' (estado inicial o sesión
    // recién cargada) los mandamos a Tickets, su única sección disponible.
    useEffect(() => {
        if (user && isDeskRequesterOnly(user) && (currentPage === 'dashboard' || currentPage === 'reports')) {
            // Corrección automática, no una navegación real del usuario — no
            // empuja historial nuevo, solo corrige el estado actual.
            setCurrentPageRaw('tickets');
            try { sessionStorage.setItem(PAGE_STORAGE_KEY, 'tickets'); } catch (e) {}
        }
    }, [user, currentPage]);

    useEffect(() => {
        document.documentElement.classList.remove('theme-dark', 'theme-oceano', 'theme-gradiente', 'theme-tierra');
        if (theme !== 'light') {
            document.documentElement.classList.add(`theme-${theme}`);
        }
        localStorage.setItem('theme', theme);
    }, [theme]);

    const handleLogin = async (email, password) => {
        const loggedInUser = await login(email, password);
        if (loggedInUser) {
            // Recién ahora hay sesión -> ya se puede sincronizar lo que requiere auth.
            await Promise.all([loadUsersFromServer(), loadTicketsFromServer()]);
            setUser(loggedInUser);
            return true;
        }
        return false;
    };

    const handleLogout = () => {
        logout();
        setUser(null);
        setCurrentPageRaw('dashboard');
        try { sessionStorage.setItem(PAGE_STORAGE_KEY, 'dashboard'); sessionStorage.removeItem('openTicketId'); } catch (e) {}
        window.history.replaceState({ page: 'dashboard', ticketId: null }, '');
    };

    const handleNavigateToTicket = (ticketId) => {
        navigateToPage('tickets');
        if (ticketId) {
            sessionStorage.setItem('openTicketId', ticketId);
        } else {
            setCreateTicketTrigger(prev => prev + 1);
        }
    };

    const handleSelectTheme = (newTheme) => {
        setTheme(newTheme);
    };

    // El link público de solo lectura (/tickets/<token>/<ticketId>) se agregó aquí
    // el 2026-08-27 y se REVIRTIÓ el mismo día junto con el backend — dependía de
    // Ticket.public_share_token, que nunca se creó en la BD real y tumbó las
    // consultas de tickets. PublicTicketView.jsx sigue en el repo (sin usar) para
    // cuando se reintente. Ver el comentario largo en db.js/server.js.

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
                        navigateToPage(page);
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
