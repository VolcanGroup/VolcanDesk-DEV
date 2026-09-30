import React, { createContext, useState } from 'react';

export const WorkspaceContext = createContext();

export const WorkspaceProvider = ({ children }) => {
    // Leído sincrónicamente en el initializer (no en un useEffect aparte) — React
    // corre los efectos de los componentes hijos ANTES que los del padre, así que
    // un useEffect aquí corría después del mount effect de Tickets.jsx que decide
    // si hay que cambiar de workspace al abrir un link compartido a un ticket
    // (/tickets/<id>). Ese cambio se pisaba con el valor por defecto 'voltik' en
    // cuanto este efecto corría, dejando la UI en el workspace equivocado
    // (auditoría 2026-08-27). Leer localStorage aquí, en el estado inicial,
    // elimina esa ventana de carrera por completo.
    const [activeWorkspace, setActiveWorkspace] = useState(() => {
        try {
            const stored = localStorage.getItem('tms_workspace');
            return (stored === 'voltik' || stored === 'volcan_desk') ? stored : 'voltik';
        } catch (e) { return 'voltik'; }
    });

    const changeWorkspace = (workspace) => {
        if (workspace === 'voltik' || workspace === 'volcan_desk') {
            setActiveWorkspace(workspace);
            localStorage.setItem('tms_workspace', workspace);
        }
    };

    return (
        <WorkspaceContext.Provider value={{ activeWorkspace, changeWorkspace }}>
            {children}
        </WorkspaceContext.Provider>
    );
};
