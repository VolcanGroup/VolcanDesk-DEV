import './App.css';
import { useState, useEffect } from 'react';
import { login, logout, getCurrentUser, isAuthenticated } from './services/authService';
import Sidebar from './components/Sidebar';
import Header from './components/Header';
import Login from './pages/Login';
import ResetPassword from './pages/ResetPassword';
import Dashboard from './pages/Dashboard';
import Tickets from './pages/Tickets';
import Users from './pages/Users';
import Settings from './pages/Settings';
import { loadConfigFromServer } from './services/configService';
import { loadCompaniesFromServer } from './services/companyService';
import { loadUsersFromServer } from './services/userService';
import { loadTicketsFromServer } from './services/ticketService';
import { loadGroupsFromServer, isDeskRequesterOnly, loadAreaAccesoExtra } from './services/groupService';
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
            // debe caer en la página de Tickets, sin importar qué página quedó
            // guardada de una sesión previa. "Solicitudes" se separó en dos páginas
            // solo en Volcán Desk (Recibidas/Enviadas, 2026-09-07) — Voltik sigue
            // teniendo una sola 'tickets'. No hay forma de saber desde la URL si el
            // ticket es uno que se pidió o uno que hay que atender, así que
            // Recibidas es el default razonable dentro de Volcán Desk.
            const hasSharedTicketLink = /^\/tickets\//.test(window.location.pathname)
                || new URLSearchParams(window.location.search).get('ticket');
            if (hasSharedTicketLink) {
                let storedWorkspace = 'voltik';
                try { storedWorkspace = localStorage.getItem('tms_workspace') || 'voltik'; } catch (e) {}
                return storedWorkspace === 'volcan_desk' ? 'tickets-recibidas' : 'tickets';
            }
            return sessionStorage.getItem(PAGE_STORAGE_KEY) || 'dashboard';
        } catch (e) { return 'dashboard'; }
    });
    // Navegación real de usuario: agrega una entrada nueva al historial.
    const navigateToPage = (page) => {
        setCurrentPageRaw(page);
        try { sessionStorage.setItem(PAGE_STORAGE_KEY, page); } catch (e) {}
        // El 3er argumento de pushState (la URL) se omitía — pushState sin URL
        // NO cambia la barra de direcciones, así que si venías de un ticket
        // (/tickets/<id>) se quedaba ahí aunque currentPage sí cambiara. El
        // efecto de montaje de Tickets.jsx lee esa URL con más prioridad que
        // sessionStorage['openTicketId'] (que este mismo click sí limpia), así
        // que terminaba reabriendo el mismo ticket en vez de ir a la lista —
        // reportado en vivo 2026-09-17: click en "Solicitudes Enviadas" desde
        // dentro de un ticket no llevaba al home de esa vista. Forzar '/' aquí
        // limpia esa URL vieja; si el destino sí es un ticket específico
        // (notificación → handleNavigateToTicket), Tickets.jsx reescribe la URL
        // a la correcta una vez que lo abre, como ya hacía antes.
        window.history.pushState({ ...(window.history.state || {}), page, ticketId: null }, '', '/');
    };
    const [user, setUser] = useState(null);
    const [theme, setTheme] = useState(localStorage.getItem('theme') || 'light');
    const [loading, setLoading] = useState(true);
    const [createTicketTrigger, setCreateTicketTrigger] = useState(0);
    // Fuerza un remount de la página activa cada vez que se hace click en el
    // sidebar (2026-09-17, a pedido del usuario: entrar a algo dentro de un
    // menú y volver a darle click a ESE MISMO menú debe llevar a su "home",
    // no dejarte donde estabas — ej. Usuarios con la pestaña "Accesos
    // Especiales" abierta, o Configuración dentro de un catálogo). Sin esto,
    // como currentPage no cambia de valor, React nunca vuelve a montar el
    // componente y su estado interno (pestaña activa, sección abierta) se
    // queda igual. Antes se llamaba ticketsViewKey y solo aplicaba a Tickets;
    // ahora es genérico para toda página con esta necesidad.
    const [pageResetKey, setPageResetKey] = useState(0);

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
                    // Accesos Especiales del usuario actual (2026-09-16) — necesario
                    // antes de que Tickets.jsx/Dashboard.jsx calculen "mis grupos"
                    // (getUserGroupsForScoping ya los suma), si no la primera carga
                    // de la página los vería como si no tuviera ningún acceso extra.
                    await loadAreaAccesoExtra();
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

    // Los solicitantes puros de Volcán Desk no tienen Inicio en el sidebar
    // ("Reportes" ya no existe como página propia, se fusionó en Inicio,
    // 2026-09-07); si quedan en 'dashboard' (estado inicial o sesión recién
    // cargada) los mandamos a "Solicitudes Enviadas" — no tienen grupo
    // resolutor, así que "Recibidas" siempre estaría vacía para ellos.
    useEffect(() => {
        if (user && isDeskRequesterOnly(user) && currentPage === 'dashboard') {
            // Corrección automática, no una navegación real del usuario — no
            // empuja historial nuevo, solo corrige el estado actual.
            setCurrentPageRaw('tickets-enviadas');
            try { sessionStorage.setItem(PAGE_STORAGE_KEY, 'tickets-enviadas'); } catch (e) {}
        }
    }, [user, currentPage]);

    // Auto-actualización cuando hay un build nuevo en el servidor (2026-09-17,
    // a pedido del usuario: "cualquier cambio en la página debe de
    // autorefrescarse sola" — antes había que avisarle a cada usuario que
    // hiciera F5 manualmente después de cada deploy). El nombre del JS
    // principal lleva el hash del contenido (Vite) — se guarda el que está
    // cargado ahora mismo, y cada hora se vuelve a pedir "/" (sin caché) para
    // ver si el servidor ya está sirviendo un hash distinto (antes cada
    // minuto — bajado a pedido del usuario 2026-09-17, un deploy no es tan
    // frecuente como para justificar revisar cada 60s). No recarga a la
    // fuerza mientras el usuario está escribiendo en un campo (perdería lo que
    // llevaba) — solo posterga el reload al siguiente ciclo hasta que ya no
    // haya un input/textarea/editor enfocado.
    useEffect(() => {
        const currentScript = document.querySelector('script[type="module"][src*="/assets/"]');
        const initialSrc = currentScript?.getAttribute('src');
        if (!initialSrc) return; // no es el build servido por serve-static.cjs (ej. vite dev) — no aplica

        let newVersionDetected = false;
        const checkForNewBuild = async () => {
            try {
                const res = await fetch('/', { cache: 'no-store' });
                const html = await res.text();
                const match = html.match(/<script[^>]+src="(\/assets\/index-[^"]+\.js)"/);
                if (match && match[1] !== initialSrc) newVersionDetected = true;
            } catch (err) {
                // Red intermitente — se reintenta solo en el siguiente ciclo.
            }
            if (newVersionDetected) {
                const active = document.activeElement;
                const isTyping = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
                if (!isTyping) window.location.reload();
            }
        };
        const interval = setInterval(checkForNewBuild, 60 * 60 * 1000);
        return () => clearInterval(interval);
    }, []);

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
            await Promise.all([loadUsersFromServer(), loadTicketsFromServer(), loadAreaAccesoExtra()]);
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
        let storedWorkspace = 'voltik';
        try { storedWorkspace = localStorage.getItem('tms_workspace') || 'voltik'; } catch (e) {}
        const targetPage = storedWorkspace === 'volcan_desk' ? 'tickets-recibidas' : 'tickets';
        if (ticketId) {
            sessionStorage.setItem('openTicketId', ticketId);
        } else {
            setCreateTicketTrigger(prev => prev + 1);
        }
        // Igual que el onNavigate del Sidebar: sin esto, si ya estabas en una
        // página de Tickets (Recibidas/Enviadas/Tickets), <Tickets key={pageResetKey}>
        // no remonta al hacer clic en una notificación — ni su efecto de montaje
        // (el que lee sessionStorage.openTicketId y abre el panel del ticket) vuelve
        // a correr, ni su estado interno deskRoleView (useState con inicializador
        // perezoso basado en deskFixedAxis, solo se evalúa una vez al montar) se
        // recalcula para el nuevo eje. Reportado en vivo 2026-09-17: 1) clic en
        // cualquier notificación nunca abría el ticket, 2) desde "Solicitudes
        // Enviadas" te mandaba a "Recibidas" pero la tabla se veía vacía — porque
        // deskRoleView se quedaba pegado en 'groupRequests' (el de Enviadas) en vez
        // de recalcularse a 'groupAttention' (el de Recibidas).
        setPageResetKey(prev => prev + 1);
        navigateToPage(targetPage);
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

    // Link de recuperación de contraseña (/reset-password?token=...), mandado
    // por POST /api/auth/forgot-password. Se revisa antes que la sesión: si
    // alguien ya está logueado en este navegador y abre el link desde otra
    // pestaña/dispositivo, igual debe poder fijar la contraseña nueva.
    const resetPasswordToken = window.location.pathname === '/reset-password'
        ? new URLSearchParams(window.location.search).get('token')
        : null;
    if (resetPasswordToken) {
        return <ResetPassword token={resetPasswordToken} />;
    }

    if (!user) {
        return <Login onLogin={handleLogin} />;
    }

    const renderPage = () => {
        switch (currentPage) {
            case 'dashboard':
                return <Dashboard key={pageResetKey} />;
            case 'tickets':
                return <Tickets key={pageResetKey} createTicketTrigger={createTicketTrigger} />;
            // "Solicitudes" (Volcán Desk) se separó en dos páginas (2026-09-07) para
            // que quede claro qué se pide vs. qué hay que atender — ambas son el
            // mismo componente <Tickets>, solo con el eje fijo por prop en vez de
            // dejar que el usuario elija entre Solicitudes/Atención/Todos.
            case 'tickets-recibidas':
                return <Tickets key={pageResetKey} createTicketTrigger={createTicketTrigger} deskFixedAxis="atencion" />;
            case 'tickets-enviadas':
                return <Tickets key={pageResetKey} createTicketTrigger={createTicketTrigger} deskFixedAxis="solicitudes" />;
            case 'users':
                return <Users key={pageResetKey} />;
            case 'settings':
                return <Settings key={pageResetKey} />;
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
                        // sessionStorage['openTicketId'] solo se limpia para destinos de
                        // tickets — así un F5 (o pasar por Usuarios/Configuración y volver)
                        // sigue reabriendo el mismo ticket, comportamiento ya existente que
                        // no cambia. pageResetKey en cambio sube siempre, para cualquier
                        // destino: es lo que garantiza el "home" de cada menú al clickearlo.
                        if (page === 'tickets' || page === 'tickets-recibidas' || page === 'tickets-enviadas') {
                            sessionStorage.removeItem('openTicketId');
                        }
                        setPageResetKey(prev => prev + 1);
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
